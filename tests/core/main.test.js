import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  pinnedNativeSqliteMigrationHistory,
  pinnedNativeSqliteSchemaFingerprint,
  serializeNativeEnvelope,
} from '../../src/database/native-envelope.js';
import { nativeModel } from '../../src/database/model.js';
import {
  readPostgresPoolOptions,
  prepareProductionDatabase,
  startProductionInstance,
  verifyProductionDatabaseContract,
} from '../../src/main.js';
import { serializePortableMountContract } from '../../src/storage/portable-mount-contract.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');

const baseEnvironment = {
  MEDIAMANAGER_INSTANCE: 'Z:\\isolated-instance-that-must-not-be-read',
  MEDIAMANAGER_POSTGRES: 'postgresql://isolated.invalid/mediamanager',
  MEDIAMANAGER_POSTGRES_SCHEMA: 'mediamanager_runtime'
};

test('production startup requires explicit PostgreSQL connection and schema before reading instance state', async () => {
  await assert.rejects(startProductionInstance({ environment: {
    MEDIAMANAGER_INSTANCE: baseEnvironment.MEDIAMANAGER_INSTANCE,
    MEDIAMANAGER_POSTGRES_SCHEMA: baseEnvironment.MEDIAMANAGER_POSTGRES_SCHEMA
  } }), /MEDIAMANAGER_POSTGRES is required/u);
  await assert.rejects(startProductionInstance({ environment: {
    MEDIAMANAGER_INSTANCE: baseEnvironment.MEDIAMANAGER_INSTANCE,
    MEDIAMANAGER_POSTGRES: baseEnvironment.MEDIAMANAGER_POSTGRES
  } }), /MEDIAMANAGER_POSTGRES_SCHEMA is required/u);
  await assert.rejects(startProductionInstance({
    environment: { ...baseEnvironment, MEDIAMANAGER_POSTGRES: '' }
  }), /MEDIAMANAGER_POSTGRES is required/u);
  await assert.rejects(startProductionInstance({
    environment: { ...baseEnvironment, MEDIAMANAGER_POSTGRES_SCHEMA: '' }
  }), /MEDIAMANAGER_POSTGRES_SCHEMA is required/u);
});

test('production startup rejects the retired database selector before instance I/O', async () => {
  await assert.rejects(startProductionInstance({ environment: {
    ...baseEnvironment,
    MEDIAMANAGER_DATABASE: 'postgres',
  } }), /MEDIAMANAGER_DATABASE is no longer supported/u);
});

test('production startup parses PostgreSQL pool settings strictly before instance I/O', async () => {
  assert.deepEqual(readPostgresPoolOptions({}), {});
  assert.deepEqual(readPostgresPoolOptions({
    MEDIAMANAGER_POSTGRES_POOL_MAX: '3',
    MEDIAMANAGER_POSTGRES_CONNECT_TIMEOUT_MS: '0',
    MEDIAMANAGER_POSTGRES_IDLE_TIMEOUT_MS: '45000'
  }), { max: 3, connectionTimeoutMillis: 0, idleTimeoutMillis: 45000 });

  for (const [name, value] of [
    ['MEDIAMANAGER_POSTGRES_POOL_MAX', '0'],
    ['MEDIAMANAGER_POSTGRES_POOL_MAX', '01'],
    ['MEDIAMANAGER_POSTGRES_CONNECT_TIMEOUT_MS', '-1'],
    ['MEDIAMANAGER_POSTGRES_CONNECT_TIMEOUT_MS', '1.5'],
    ['MEDIAMANAGER_POSTGRES_IDLE_TIMEOUT_MS', '9007199254740992']
  ]) {
    await assert.rejects(startProductionInstance({
      environment: { ...baseEnvironment, [name]: value }
    }), new RegExp(name, 'u'));
  }
});

test('loading the production entry does not load the built-in SQLite runtime', () => {
  const loaded = process.moduleLoadList.filter(entry => /(?:binding|module).*sqlite/iu.test(entry));
  assert.deepEqual(loaded, []);
});

test('production requires a completed transfer receipt bound to a pinned native envelope and target', async () => {
  const binding = { serverId: '1'.repeat(32), originIdentityDigest: '2'.repeat(64) };
  const envelope = {
    ddl: ['CREATE TABLE "PinnedOrigin" ("Id" INTEGER)'],
    fingerprint: pinnedNativeSqliteSchemaFingerprint,
    history: pinnedNativeSqliteMigrationHistory,
    sqliteSequence: [],
  };
  const portableMountContract = { mounts: [] };
  const identity = { database: 'runtime', databaseOid: '42', serverAddress: '127.0.0.1', serverPort: 5432 };
  const state = new Map([['portableVfsMountContract', serializePortableMountContract(portableMountContract)]]);
  let receipt = null;
  const database = {
    dialect: 'postgres', schemaName: 'runtime_schema',
    async getState(key) { return state.get(key); },
    async readInstanceBinding() { return binding; },
    async readNativeEnvelope() { return envelope; },
    async readTransferReceipt() { return receipt; },
    async databaseIdentity() { return identity; },
  };
  await assert.rejects(verifyProductionDatabaseContract(database, binding.serverId), /no completed database transfer receipt/u);
  receipt = {
    sourceTables: nativeModel.tables.map(table => ({ name: table.name, rows: 0, sha256: '3'.repeat(64) })),
    nativeEnvelopeSha256: sha256(serializeNativeEnvelope(envelope)),
    portableMountContractSha256: sha256(serializePortableMountContract(portableMountContract)),
    instanceBinding: binding,
    sourceIdentitySha256: '4'.repeat(64),
    targetIdentitySha256: sha256(JSON.stringify({ dialect: 'postgres', database: identity, schema: database.schemaName })),
  };
  assert.deepEqual(await verifyProductionDatabaseContract(database, binding.serverId), portableMountContract);
  state.delete('portableVfsMountContract');
  await assert.rejects(verifyProductionDatabaseContract(database, binding.serverId),
    /no portable VFS mount contract/u);
  state.set('portableVfsMountContract', serializePortableMountContract(portableMountContract));
  receipt = { ...receipt, portableMountContractSha256: '8'.repeat(64) };
  await assert.rejects(verifyProductionDatabaseContract(database, binding.serverId),
    /does not match its portable VFS mount contract/u);
  receipt = {
    ...receipt,
    portableMountContractSha256: sha256(serializePortableMountContract(portableMountContract)),
    instanceBinding: { ...binding, originIdentityDigest: '9'.repeat(64) },
  };
  await assert.rejects(verifyProductionDatabaseContract(database, binding.serverId),
    /does not match its instance binding/u);
  receipt = { ...receipt, instanceBinding: binding };
  receipt = { ...receipt, nativeEnvelopeSha256: '5'.repeat(64) };
  await assert.rejects(verifyProductionDatabaseContract(database, binding.serverId), /does not match its pinned Jellyfin SQLite envelope/u);
  receipt = { ...receipt, nativeEnvelopeSha256: sha256(serializeNativeEnvelope(envelope)), targetIdentitySha256: '6'.repeat(64) };
  await assert.rejects(verifyProductionDatabaseContract(database, binding.serverId), /does not match this database target/u);
  envelope.fingerprint = '7'.repeat(64);
  await assert.rejects(verifyProductionDatabaseContract(database, binding.serverId), /requires pinned Jellyfin schema fingerprint/u);
});

test('production verifies the immutable transfer contract before initializing its runtime schema', async () => {
  const binding = { serverId: '1'.repeat(32), originIdentityDigest: '2'.repeat(64) };
  const envelope = {
    ddl: ['CREATE TABLE "PinnedOrigin" ("Id" INTEGER)'],
    fingerprint: pinnedNativeSqliteSchemaFingerprint,
    history: pinnedNativeSqliteMigrationHistory,
    sqliteSequence: [],
  };
  const portableMountContract = { mounts: [] };
  const identity = { database: 'runtime', databaseOid: '42', serverAddress: '127.0.0.1', serverPort: 5432 };
  const events = [];
  let receipt = null;
  const database = {
    dialect: 'postgres', schemaName: 'runtime_schema',
    async getState() { events.push('mount'); return serializePortableMountContract(portableMountContract); },
    async readInstanceBinding() { events.push('binding'); return binding; },
    async readNativeEnvelope() { events.push('envelope'); return envelope; },
    async readTransferReceipt() { events.push('receipt'); return receipt; },
    async databaseIdentity() { events.push('identity'); return identity; },
    async initializeRuntimeSchema() { events.push('initialize'); },
  };
  await assert.rejects(prepareProductionDatabase(database, binding.serverId), /no completed database transfer receipt/u);
  assert.equal(events.includes('initialize'), false);

  receipt = {
    sourceTables: nativeModel.tables.map(table => ({ name: table.name, rows: 0, sha256: '3'.repeat(64) })),
    nativeEnvelopeSha256: sha256(serializeNativeEnvelope(envelope)),
    portableMountContractSha256: sha256(serializePortableMountContract(portableMountContract)),
    instanceBinding: binding,
    sourceIdentitySha256: '4'.repeat(64),
    targetIdentitySha256: sha256(JSON.stringify({ dialect: 'postgres', database: identity, schema: database.schemaName })),
  };
  events.length = 0;
  assert.deepEqual(await prepareProductionDatabase(database, binding.serverId), portableMountContract);
  assert.equal(events.at(-1), 'initialize');
  assert.ok(events.indexOf('identity') < events.indexOf('initialize'));
});
