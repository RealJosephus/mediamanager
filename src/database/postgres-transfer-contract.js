import { createHash } from 'node:crypto';
import { assertPinnedNativeEnvelope, normalizeNativeEnvelope, serializeNativeEnvelope } from './native-envelope.js';
import { canonicalInstanceBinding, canonicalTransferReceipt } from './postgres.js';
import { readPortableMountContract, serializePortableMountContract } from '../storage/portable-mount-contract.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function verifySnapshot(database, {
  expectedServerId,
  requirePinnedEnvelope,
  requirePortableMountContract,
}) {
  const bindingValue = await database.readInstanceBinding();
  if (!bindingValue) throw new Error('The PostgreSQL schema has no instance binding.');
  const binding = canonicalInstanceBinding(bindingValue);
  if (expectedServerId !== undefined && binding.serverId !== expectedServerId) {
    throw new Error('The PostgreSQL schema is not bound to this Jellyfin instance identity.');
  }

  const envelopeValue = await database.readNativeEnvelope();
  if (!envelopeValue) throw new Error('The PostgreSQL schema has no verified Jellyfin SQLite interchange origin.');
  const nativeEnvelope = requirePinnedEnvelope
    ? assertPinnedNativeEnvelope(envelopeValue)
    : normalizeNativeEnvelope(envelopeValue);

  const receiptValue = await database.readTransferReceipt();
  if (!receiptValue) throw new Error('The PostgreSQL schema has no completed database transfer receipt.');
  const receipt = canonicalTransferReceipt(receiptValue);
  const portableMountContract = await readPortableMountContract(database);
  if (requirePortableMountContract && !portableMountContract) {
    throw new Error('The PostgreSQL schema has no portable VFS mount contract.');
  }

  if (!same(receipt.instanceBinding, binding)) {
    throw new Error('The PostgreSQL transfer receipt does not match its instance binding.');
  }
  if (receipt.nativeEnvelopeSha256 !== sha256(serializeNativeEnvelope(nativeEnvelope))) {
    throw new Error('The PostgreSQL transfer receipt does not match its pinned Jellyfin SQLite envelope.');
  }
  const mountDigest = portableMountContract === null
    ? null
    : sha256(serializePortableMountContract(portableMountContract));
  if (receipt.portableMountContractSha256 !== mountDigest) {
    throw new Error('The PostgreSQL transfer receipt does not match its portable VFS mount contract.');
  }
  const targetIdentity = {
    dialect: 'postgres',
    database: await database.databaseIdentity(),
    schema: database.schemaName,
  };
  if (receipt.targetIdentitySha256 !== sha256(JSON.stringify(targetIdentity))) {
    throw new Error('The PostgreSQL transfer receipt does not match this database target.');
  }
  return Object.freeze({ instanceBinding: binding, nativeEnvelope, portableMountContract, receipt, targetIdentity });
}

/**
 * Verify the immutable PostgreSQL import contract without writing to either
 * the application schema or its control schema. Root database handles use one
 * repeatable-read, read-only snapshot; callers already inside a transaction
 * retain their existing snapshot.
 */
export async function verifyPostgresTransferContract(database, {
  expectedServerId,
  requirePinnedEnvelope = true,
  requirePortableMountContract = false,
} = {}) {
  if (!database || database.dialect !== 'postgres') {
    throw new TypeError('A PostgreSQL database is required to verify the transfer contract');
  }
  if (expectedServerId !== undefined && (typeof expectedServerId !== 'string' || !expectedServerId)) {
    throw new TypeError('expectedServerId must be a nonempty string');
  }
  if (typeof requirePinnedEnvelope !== 'boolean' || typeof requirePortableMountContract !== 'boolean') {
    throw new TypeError('PostgreSQL transfer contract requirements must be boolean');
  }
  const options = { expectedServerId, requirePinnedEnvelope, requirePortableMountContract };
  if (database.inTransaction || typeof database.transaction !== 'function') {
    return verifySnapshot(database, options);
  }
  return database.transaction(current => verifySnapshot(current, options), {
    isolation: 'repeatable-read',
    readOnly: true,
  });
}
