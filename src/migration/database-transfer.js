import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { link, lstat, open, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { nativeModel, quoteIdentifier as q } from '../database/model.js';
import { nativeInsertionOrderedTables } from '../database/native-relation-order.js';
import {
  assertPinnedNativeEnvelope,
  pinnedNativeDataMigrationProductVersion,
  pinnedNativeSqliteMigrationHistory,
  pinnedNativeSqliteSchemaFingerprint,
  serializeNativeEnvelope,
} from '../database/native-envelope.js';
import { installNativeEnvelopeSchema, validateNativeEnvelope } from '../database/native-envelope-sqlite.js';
import { canonicalInstanceBinding, canonicalTransferReceipt } from '../database/postgres.js';
import { verifyPostgresTransferContract } from '../database/postgres-transfer-contract.js';
import { acquirePostgresWriteLock, releasePostgresWriteLock } from '../database/postgres-write-lock.js';
import { SqliteDatabase } from '../database/sqlite.js';
import { canonicalNativeSqliteSchema } from '../database/sqlite-schema.js';
import { canonicalCell, encodeValue } from '../database/values.js';
import { assertPortableMountRetarget, canonicalPortableMountContract, readPortableMountContract,
  serializePortableMountContract, writePortableMountContract } from '../storage/portable-mount-contract.js';
import { acquireOperationLease } from './operation-lease.js';
import { createSqliteExportPathProjector, rewriteSqliteExportPaths } from './sqlite-export-paths.js';

export const postgresCommitOutcomeUnknownCode = 'POSTGRES_COMMIT_OUTCOME_UNKNOWN';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function failureAggregate(reason, cleanupErrors, message) {
  try { const value = reason?.message; if (typeof value === 'string') message = value; }
  catch { /* A diagnostic getter must not replace an operation or cleanup failure. */ }
  const aggregate = new AggregateError([reason, ...cleanupErrors], message, { cause: reason });
  for (const name of ['code', 'status', 'statusCode']) {
    try { const value = reason?.[name]; if (value !== undefined) aggregate[name] = value; }
    catch { /* The original reason remains in cause and errors. */ }
  }
  return aggregate;
}
const nullCell = Object.freeze(['null']);
const trueCell = Object.freeze(['boolean', true]);
const falseCell = Object.freeze(['boolean', false]);
const canonicalRow = (table, row) => JSON.stringify(table.columns.map(column => {
  const value = row[column.name];
  return value === null ? nullCell : value === true ? trueCell : value === false ? falseCell : canonicalCell(value);
}));
const sqliteCompanionSuffixes = ['', '-journal', '-wal', '-shm'];
export {
  pinnedNativeDataMigrationProductVersion,
  pinnedNativeSqliteMigrationHistory,
  pinnedNativeSqliteSchemaFingerprint,
};
const pathIdentity = value => process.platform === 'win32' ? value.toLowerCase() : value;
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameFileGeneration = (left, right) => sameFile(left, right)
  && left.size === right.size
  && left.mtimeNs === right.mtimeNs
  && left.ctimeNs === right.ctimeNs;

async function releasePostgresSourceSnapshotLock(database) {
  try { await releasePostgresWriteLock(database); }
  catch (error) {
    if (typeof database.discardConnection === 'function') database.discardConnection(error);
    throw error;
  }
}

async function prospectivePhysicalPath(filename) {
  const resolved = path.resolve(filename);
  try { return pathIdentity(await realpath(resolved)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return pathIdentity(path.join(await realpath(path.dirname(resolved)), path.basename(resolved)));
  }
}

async function assertNamedFileIdentity(filename, expected, label) {
  const actual = await optionalRegularFile(filename, label);
  if (!actual || !sameFile(actual, expected)) throw new Error(`${label} changed identity`);
  return actual;
}

async function assertNamedFileGeneration(filename, expected, label) {
  const actual = await optionalRegularFile(filename, label);
  if (!actual || !sameFileGeneration(actual, expected)) throw new Error(`${label} changed while it was being verified`);
  return actual;
}

async function removeOwnedFile(filename, expected, label) {
  let actual;
  try { actual = await optionalRegularFile(filename, label); }
  catch (error) { throw error; }
  if (!actual) return;
  if (!sameFile(actual, expected)) throw new Error(`${label} changed identity before cleanup`);
  await unlink(filename);
}

async function assertSqliteSourceIsolation(source, destination, staging) {
  if (source.dialect !== 'sqlite' || source.filename === ':memory:') return;
  const sourcePath = path.resolve(source.filename);
  const [physicalSource, sourceMetadata] = await Promise.all([
    realpath(sourcePath).then(pathIdentity),
    stat(sourcePath, { bigint: true })
  ]);
  const candidates = [destination, ...sqliteCompanionSuffixes.map(suffix => `${staging}${suffix}`)];
  for (const candidate of candidates) {
    const physicalCandidate = await prospectivePhysicalPath(candidate);
    if (physicalCandidate === physicalSource) {
      throw new Error('SQLite migration source collides with its export target or private staging');
    }
    let candidateMetadata;
    try { candidateMetadata = await stat(candidate, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (candidateMetadata && sameFile(candidateMetadata, sourceMetadata)) {
      throw new Error('SQLite migration source is hard-linked to its export target or private staging');
    }
  }
}

async function optionalRegularFile(filename, label) {
  let metadata;
  try { metadata = await lstat(filename, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  return metadata;
}

async function removePrivateSqliteStaging(staging, expectedMainIdentity) {
  const failures = [];
  if (expectedMainIdentity) {
    try { await assertNamedFileIdentity(staging, expectedMainIdentity, 'Migration staging file'); }
    catch (error) { throw new Error('Migration staging identity changed before cleanup', { cause: error }); }
  }
  for (const suffix of sqliteCompanionSuffixes) {
    const filename = `${staging}${suffix}`;
    try {
      if (await optionalRegularFile(filename, `Migration staging entry ${path.basename(filename)}`)) await unlink(filename);
    } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Migration staging cleanup failed');
}

async function recoverPrivateSqliteStaging(staging, destination) {
  const [stagingMetadata, destinationMetadata] = await Promise.all([
    optionalRegularFile(staging, 'Migration staging file'),
    optionalRegularFile(destination, 'Migration target')
  ]);
  if (stagingMetadata && destinationMetadata
    && !sameFile(stagingMetadata, destinationMetadata)) {
    throw new Error('Migration staging file conflicts with the existing target');
  }
  if (!destinationMetadata || stagingMetadata) await removePrivateSqliteStaging(staging);
  else {
    // The main staging link was already removed; clean only exact SQLite
    // companions left by the same deterministic private staging name.
    for (const suffix of sqliteCompanionSuffixes.slice(1)) {
      const filename = `${staging}${suffix}`;
      if (await optionalRegularFile(filename, `Migration staging entry ${path.basename(filename)}`)) await unlink(filename);
    }
  }
  return destinationMetadata;
}

export async function databaseDigest(database, { batchSize = 128, signal, rowTransform } = {}) {
  if (rowTransform !== undefined && typeof rowTransform !== 'function') throw new TypeError('rowTransform must be a function');
  const tables = [];
  for (const table of nativeModel.tables) {
    signal?.throwIfAborted();
    const hash = createHash('sha256');
    let count = 0;
    let after;
    for (;;) {
      signal?.throwIfAborted();
      const page = await transferBatch(database, table, batchSize, after);
      const batch = page.rows;
      for (const original of batch) {
        const row = rowTransform ? rowTransform(table.name, original) : original;
        hash.update(`${canonicalRow(table, row)}\n`);
      }
      count += batch.length;
      if (!page.more) break;
      after = page.after;
    }
    tables.push({ name: table.name, rows: count, sha256: hash.digest('hex') });
  }
  return tables;
}

async function transferBatch(database, table, batchSize, after) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new TypeError('Invalid migration batch size');
  batchSize = Math.min(batchSize, 128);
  if (nativeInsertionOrderedTables.includes(table.name)) {
    const page = await database.relationRowsInInsertionOrder(table.name, { limit: batchSize, after, consumer: 'exchange' });
    return { ...page, more: page.rows.length === batchSize };
  }
  const rows = await database.rows(table.name, {
    limit: batchSize, consumer: 'exchange', ...(after === undefined ? {} : { after }),
  });
  return { rows, more: rows.length === batchSize,
    after: rows.length ? Object.fromEntries(table.primaryKey.map(key => [key, rows.at(-1)[key]])) : undefined };
}

function portablePathAuditTransform(contract) {
  const projector = createSqliteExportPathProjector({ sourceContract: contract, targetContract: contract });
  return (tableName, row) => {
    projector.projectRow(tableName, row);
    return row;
  };
}

export function assertPinnedJellyfinEnvelope(value) {
  return assertPinnedNativeEnvelope(validateNativeEnvelope(value));
}

async function transferIdentity(database) {
  if (database.dialect === 'postgres') {
    return { dialect: 'postgres', database: await database.databaseIdentity(), schema: database.schemaName };
  }
  const filename = database.filename === ':memory:' ? ':memory:' : path.resolve(database.filename);
  return { dialect: 'sqlite', filename };
}

function transferReceipt({ tables, envelope, instanceBinding, portableMountContract, sourceIdentity, targetIdentity }) {
  return canonicalTransferReceipt({
    sourceTables: tables,
    nativeEnvelopeSha256: sha256(serializeNativeEnvelope(envelope)),
    portableMountContractSha256: portableMountContract === null
      ? null : sha256(serializePortableMountContract(portableMountContract)),
    instanceBinding,
    sourceIdentitySha256: sha256(JSON.stringify(sourceIdentity)),
    targetIdentitySha256: sha256(JSON.stringify(targetIdentity))
  });
}

function transferResult(tables, envelope) {
  return {
    tables,
    nativeSchemaFingerprint: envelope.fingerprint,
    migrationHistory: envelope.history,
    sqliteSequence: envelope.sqliteSequence,
    verified: true
  };
}

export async function getNativeEnvelope(database) {
  if (database.dialect === 'sqlite') {
    const schema = database.preflight();
    const canonical = canonicalNativeSqliteSchema();
    return { ...canonical, history: schema.history, sqliteSequence: schema.sqliteSequence };
  }
  const value = await database.readNativeEnvelope();
  if (!value) throw new Error('PostgreSQL migration source native SQLite envelope is missing');
  // An uncalled PostgreSQL sequence has no live SQLite high-water equivalent,
  // but the imported SQLite envelope can still distinguish an absent
  // sqlite_sequence row from an explicitly persisted seq=0 row. Retain that
  // immutable baseline, overlay every consumed PostgreSQL high-water, and take
  // the maximum defensively so an externally reset sequence cannot regress an
  // export that Jellyfin may later continue.
  const byName = new Map(value.sqliteSequence.map(entry => [entry.name, { ...entry }]));
  for (const entry of await database.sequenceState()) {
    const baseline = byName.get(entry.name);
    if (!baseline || BigInt(entry.seq) > BigInt(baseline.seq)) byName.set(entry.name, { ...entry });
  }
  const sqliteSequence = [...byName.values()].sort((left, right) => left.name < right.name ? -1
    : left.name > right.name ? 1 : 0);
  return { ...value, sqliteSequence };
}

export async function createSqliteTarget(filename, envelope) {
  envelope = validateNativeEnvelope(envelope);
  let reserved;
  try { reserved = await open(filename, 'wx+', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Migration target already exists'); throw error; }
  let database, target, identity;
  try {
    identity = await reserved.stat({ bigint: true });
    await assertNamedFileIdentity(filename, identity, 'Reserved migration target');
    database = new DatabaseSync(filename);
    await assertNamedFileIdentity(filename, identity, 'Opened migration target');
    try {
      database.exec('BEGIN');
      installNativeEnvelopeSchema(database, envelope.ddl);
      database.exec('COMMIT');
    } catch (failure) { database.exec('ROLLBACK'); throw failure; }
    await assertNamedFileIdentity(filename, identity, 'Initialized migration target');
    database.close();
    database = undefined;
    target = new SqliteDatabase(filename);
    await assertNamedFileIdentity(filename, identity, 'Reopened migration target');
    await reserved.close();
    reserved = undefined;
    target.migrationFileIdentity = Object.freeze({ dev: identity.dev, ino: identity.ino });
    return target;
  } catch (error) {
    const cleanupErrors = [];
    if (target) { try { target.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); } }
    if (reserved) { try { await reserved.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); } }
    if (database) { try { database.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); } }
    if (identity) {
      try { await removeOwnedFile(filename, identity, 'Migration target'); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) throw failureAggregate(error, cleanupErrors, 'SQLite target creation and cleanup failed');
    throw error;
  }
}

async function writeEnvelope(target, envelope) {
  if (target.dialect === 'postgres') {
    await target.writeNativeEnvelope(envelope);
    await target.resetSequences(envelope.sqliteSequence);
    return;
  }
  const hasHistory = target.database.prepare("SELECT name FROM sqlite_schema WHERE name = '__EFMigrationsHistory'").get();
  if (envelope.history.length && !hasHistory) throw new Error('Target lacks the original EF migration history table');
  if (hasHistory) for (const row of envelope.history) target.database.prepare('INSERT INTO "__EFMigrationsHistory" ("MigrationId", "ProductVersion") VALUES (?, ?)').run(row.MigrationId, row.ProductVersion);
  target.database.exec('DELETE FROM sqlite_sequence');
  for (const sequence of envelope.sqliteSequence) target.database.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(sequence.name, BigInt(sequence.seq));
}

/** Copy a stopped, isolated source into an empty target; never mutate the source. */
export async function transferDatabase(source, target, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['batchSize', 'signal', 'instanceBinding', 'portableMountContract'].includes(key))) {
    throw new TypeError('Invalid database transfer options');
  }
  const { batchSize = 128, signal, instanceBinding, portableMountContract } = options;
  if (source === target) throw new Error('Source and target must differ');
  // Transaction control below is intentionally manual so the source snapshot
  // can end before the target commits. Pin every PostgreSQL root first; a
  // PostgreSQL-to-PostgreSQL transfer therefore holds two independent sessions.
  if (source.dialect === 'postgres' && !source.connectionSession
    && typeof source.withConnection === 'function') {
    return source.withConnection(session => transferDatabase(session, target, options));
  }
  if (target.dialect === 'postgres' && !target.connectionSession
    && typeof target.withConnection === 'function') {
    return target.withConnection(session => transferDatabase(source, session, options));
  }
  if ((source.dialect === 'sqlite' ? source.database.isTransaction : source.inTransaction) || (target.dialect === 'sqlite' ? target.database.isTransaction : target.inTransaction)) throw new Error('Migration requires exclusive connections outside transactions');
  if (target.dialect === 'sqlite' && target.migrationFileIdentity) {
    await assertNamedFileIdentity(target.filename, target.migrationFileIdentity, 'Migration target');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('Invalid migration batch size');
  if (source.dialect === 'postgres' && instanceBinding !== undefined) throw new Error('A PostgreSQL source instance binding cannot be overridden');
  const requestedBinding = instanceBinding === undefined ? null : canonicalInstanceBinding(instanceBinding);
  if (requestedBinding && target.dialect !== 'postgres') throw new Error('An instance binding can only be written to a PostgreSQL target');
  const requestedMountContract = portableMountContract === undefined ? null : canonicalPortableMountContract(portableMountContract);
  if (requestedMountContract && target.dialect !== 'postgres') {
    throw new Error('A portable VFS mount contract can only be written to a PostgreSQL target');
  }
  await source.preflight();
  await target.preflight();
  if (source.dialect === 'postgres' && target.dialect === 'postgres') {
    const sourceDatabase = await source.databaseIdentity();
    const targetDatabase = await target.databaseIdentity();
    if (source.schemaName === target.schemaName && JSON.stringify(sourceDatabase) === JSON.stringify(targetDatabase)) {
      throw new Error('Source and target PostgreSQL connections must not address the same database schema');
    }
  }
  let sourceBinding = requestedBinding;
  let transferMountContract = requestedMountContract;
  let postgresSourceContract = null;
  let sourceTransaction = false;
  let sourceSnapshotLock = false;
  let targetTransaction = false;
  try {
    if (source.dialect === 'postgres') {
      await acquirePostgresWriteLock(source, { signal });
      sourceSnapshotLock = true;
    }
    sourceTransaction = true;
    if (source.dialect === 'sqlite') source.database.exec('BEGIN');
    else {
      source.inTransaction = true;
      await source.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    }
    if (source.dialect === 'postgres') {
      postgresSourceContract = await verifyPostgresTransferContract(source, {
        requirePinnedEnvelope: false,
        requirePortableMountContract: false,
      });
      sourceBinding = postgresSourceContract.instanceBinding;
      const sourceMountContract = postgresSourceContract.portableMountContract;
      if (sourceMountContract && requestedMountContract
        && serializePortableMountContract(sourceMountContract) !== serializePortableMountContract(requestedMountContract)) {
        throw new Error('Explicit portable VFS mount contract differs from persisted PostgreSQL source state');
      }
      transferMountContract = sourceMountContract ?? requestedMountContract;
    }
    // The contract envelope is immutable provenance, while sequence high-water
    // is live PostgreSQL state. Capture it only after the repeatable-read
    // snapshot exists and while the runtime writer boundary is still held.
    const envelope = await getNativeEnvelope(source);
    if (sourceSnapshotLock) {
      sourceSnapshotLock = false;
      await releasePostgresSourceSnapshotLock(source);
    }
    let auditedMountContract = target.dialect === 'postgres' ? transferMountContract : null;
    const sourceTables = await databaseDigest(source, {
      batchSize,
      signal,
      rowTransform: auditedMountContract ? portablePathAuditTransform(auditedMountContract) : undefined,
    });
    const sourceIdentity = await transferIdentity(source);
    if (target.dialect === 'sqlite') {
      targetTransaction = true;
      target.database.exec('BEGIN IMMEDIATE');
      target.database.exec('PRAGMA defer_foreign_keys = ON');
    }
    else {
      targetTransaction = true;
      target.inTransaction = true;
      await target.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await target.client.query("SET LOCAL lock_timeout = '5000ms'");
      await target.client.query('SET CONSTRAINTS ALL DEFERRED');
    }
    let receipt;
    if (target.dialect === 'postgres') {
      await target.client.query(`LOCK TABLE ${nativeModel.tables.map((table) => q(table.name)).join(', ')} IN ACCESS EXCLUSIVE MODE`);
      await target.client.query(`LOCK TABLE ${q(target.controlSchema)}.state IN EXCLUSIVE MODE`);
      const targetBinding = await target.readInstanceBinding();
      if (targetBinding && !same(targetBinding, sourceBinding)) {
        throw new Error('PostgreSQL migration target has a different instance binding');
      }
      const storedMountContract = await readPortableMountContract(target);
      if (transferMountContract && storedMountContract
        && serializePortableMountContract(storedMountContract) !== serializePortableMountContract(transferMountContract)) {
        throw new Error('PostgreSQL migration target has a different portable VFS mount contract');
      }
      const receiptMountContract = transferMountContract ?? storedMountContract;
      if (receiptMountContract && (!auditedMountContract
        || serializePortableMountContract(auditedMountContract) !== serializePortableMountContract(receiptMountContract))) {
        const auditedTables = await databaseDigest(source, {
          batchSize,
          signal,
          rowTransform: portablePathAuditTransform(receiptMountContract),
        });
        if (!same(auditedTables, sourceTables)) {
          throw new Error('Migration source changed while auditing its portable media paths');
        }
        auditedMountContract = receiptMountContract;
      }
      receipt = transferReceipt({
        tables: sourceTables,
        envelope,
        instanceBinding: sourceBinding,
        portableMountContract: receiptMountContract,
        sourceIdentity,
        targetIdentity: await transferIdentity(target)
      });
      const committed = await target.readTransferReceipt();
      if (committed) {
        if (!same(committed, receipt)) throw new Error('PostgreSQL migration target has a different transfer receipt');
        const actualBinding = await target.readInstanceBinding();
        const actualEnvelope = await getNativeEnvelope(target);
        const actualMountContract = await readPortableMountContract(target);
        const actualTables = await databaseDigest(target, { batchSize, signal });
        if (!same(actualBinding, sourceBinding)
          || serializeNativeEnvelope(actualEnvelope) !== serializeNativeEnvelope(envelope)
          || (actualMountContract === null) !== (receiptMountContract === null)
          || actualMountContract && serializePortableMountContract(actualMountContract)
            !== serializePortableMountContract(receiptMountContract)
          || !same(actualTables, sourceTables)) {
          throw new Error('PostgreSQL migration target no longer matches its committed transfer receipt');
        }
        if (source.dialect === 'sqlite') source.database.exec('ROLLBACK');
        else await source.client.query('ROLLBACK');
        sourceTransaction = false;
        if (source.dialect === 'postgres') source.inTransaction = false;
        await target.client.query('ROLLBACK');
        targetTransaction = false;
        target.inTransaction = false;
        return transferResult(sourceTables, envelope);
      }
    }
    for (const table of nativeModel.tables) if ((await target.rows(table.name, { limit: 1 })).length) throw new Error(`Migration target is not empty: ${table.name}`);
    const tables = [];
    for (const table of nativeModel.tables) {
      signal?.throwIfAborted();
      let count = 0;
      let after;
      const hash = createHash('sha256');
      for (;;) {
        signal?.throwIfAborted();
        const page = await transferBatch(source, table, batchSize, after);
        const batch = page.rows;
        for (const row of batch) {
          for (const column of table.columns) encodeValue(column, row[column.name], target.dialect);
          hash.update(`${canonicalRow(table, row)}\n`);
        }
        if (batch.length) await target.insertBatch(table.name, batch);
        count += batch.length;
        if (!page.more) break;
        after = page.after;
      }
      tables.push({ name: table.name, rows: count, sha256: hash.digest('hex') });
    }
    if (!same(tables, sourceTables)) throw new Error('Migration source changed within its repeatable-read snapshot');
    await writeEnvelope(target, envelope);
    if (target.dialect === 'postgres' && sourceBinding) await target.writeInstanceBinding(sourceBinding);
    if (target.dialect === 'postgres' && transferMountContract) {
      await writePortableMountContract(target, transferMountContract);
    }
    const actual = await databaseDigest(target, { batchSize, signal });
    if (!same(actual, sourceTables)) throw new Error('Full field-by-field migration digest mismatch');
    if (target.dialect === 'sqlite' && target.database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Target foreign key violations');
    if (target.dialect === 'sqlite' && target.migrationFileIdentity) {
      await assertNamedFileIdentity(target.filename, target.migrationFileIdentity, 'Migration target');
    }
    if (target.dialect === 'postgres') await target.writeTransferReceipt(receipt);
    if (source.dialect === 'sqlite') source.database.exec('ROLLBACK');
    else await source.client.query('ROLLBACK');
    sourceTransaction = false;
    if (source.dialect === 'postgres') source.inTransaction = false;
    if (target.dialect === 'sqlite') {
      target.database.exec('COMMIT');
      targetTransaction = false;
      if (target.migrationFileIdentity) await assertNamedFileIdentity(target.filename, target.migrationFileIdentity, 'Migration target');
    } else {
      try { await target.client.query('COMMIT'); }
      catch (cause) {
        // A transport failure may arrive after PostgreSQL durably committed the
        // receipt. Do not issue a speculative rollback on this session; force
        // the caller to reconnect and resolve the receipt idempotently.
        targetTransaction = false;
        target.inTransaction = false;
        target.discardConnection?.(cause);
        const error = new Error(`PostgreSQL COMMIT outcome is unknown: ${cause.message}`, { cause });
        error.code = postgresCommitOutcomeUnknownCode;
        throw error;
      }
      targetTransaction = false;
    }
    if (target.dialect === 'postgres') target.inTransaction = false;
    return transferResult(sourceTables, envelope);
  } catch (error) {
    const rollbackErrors = [];
    if (targetTransaction) {
      try { if (target.dialect === 'sqlite') target.database.exec('ROLLBACK'); else await target.client.query('ROLLBACK'); }
      catch (rollbackError) {
        if (target.dialect === 'postgres') target.discardConnection?.(rollbackError);
        rollbackErrors.push(rollbackError);
      }
    }
    if (sourceTransaction) {
      try { if (source.dialect === 'sqlite') source.database.exec('ROLLBACK'); else await source.client.query('ROLLBACK'); }
      catch (rollbackError) {
        if (source.dialect === 'postgres') source.discardConnection?.(rollbackError);
        rollbackErrors.push(rollbackError);
      }
    }
    if (sourceSnapshotLock) {
      sourceSnapshotLock = false;
      try { await releasePostgresSourceSnapshotLock(source); }
      catch (releaseError) { rollbackErrors.push(releaseError); }
    }
    if (rollbackErrors.length) throw failureAggregate(error, rollbackErrors, 'Database transfer and rollback failed');
    throw error;
  } finally {
    if (source.dialect === 'postgres') source.inTransaction = false;
    if (target.dialect === 'postgres') target.inTransaction = false;
  }
}

const sqliteExportOptionNames = new Set([
  'batchSize', 'signal', 'instanceBinding', 'testOnlyAllowSyntheticEnvelope',
  'portableMountContract', 'targetPortableMountContract', 'instanceStatePaths'
]);

function normalizeSqliteExportOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !sqliteExportOptionNames.has(key))) {
    throw new TypeError('Invalid SQLite export options');
  }
  const normalized = { ...options };
  normalized.testOnlyAllowSyntheticEnvelope ??= false;
  if (typeof normalized.testOnlyAllowSyntheticEnvelope !== 'boolean') {
    throw new TypeError('testOnlyAllowSyntheticEnvelope must be a boolean');
  }
  if (normalized.portableMountContract !== undefined) {
    normalized.portableMountContract = canonicalPortableMountContract(normalized.portableMountContract);
  }
  if (normalized.targetPortableMountContract !== undefined) {
    normalized.targetPortableMountContract = canonicalPortableMountContract(normalized.targetPortableMountContract);
  }
  if (normalized.instanceStatePaths !== undefined) {
    const value = normalized.instanceStatePaths;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'metadata,programData') {
      throw new TypeError('instanceStatePaths must contain exactly programData and metadata');
    }
    for (const key of ['programData', 'metadata']) if (typeof value[key] !== 'string'
      || value[key].includes('\0') || !path.isAbsolute(value[key])) {
      throw new TypeError(`instanceStatePaths.${key} must be an absolute path`);
    }
    normalized.instanceStatePaths = Object.freeze({
      programData: path.resolve(value.programData),
      metadata: path.resolve(value.metadata),
    });
  }
  return normalized;
}

function transferOptionsForExport(options) {
  return Object.fromEntries(['batchSize', 'signal', 'instanceBinding']
    .filter(key => options[key] !== undefined).map(key => [key, options[key]]));
}

async function exportMountContracts(source, options) {
  let persisted = null;
  if (source.dialect === 'postgres') persisted = await readPortableMountContract(source);
  if (persisted && options.portableMountContract
    && serializePortableMountContract(persisted) !== serializePortableMountContract(options.portableMountContract)) {
    throw new Error('Explicit portable VFS mount contract differs from persisted PostgreSQL state');
  }
  if (source.dialect === 'postgres' && !persisted && !options.testOnlyAllowSyntheticEnvelope) {
    throw new Error('PostgreSQL SQLite export requires a persisted portable VFS mount contract');
  }
  const sourceContract = persisted ?? options.portableMountContract ?? null;
  if (options.targetPortableMountContract && !sourceContract) {
    throw new Error('A target portable VFS mount contract requires a source contract');
  }
  const targetContract = sourceContract
    ? options.targetPortableMountContract ? assertPortableMountRetarget(sourceContract, options.targetPortableMountContract) : sourceContract
    : null;
  return { sourceContract, targetContract };
}

async function readStableSqliteFile(filename, options, expectedGeneration, lease, label) {
  lease.assertHeld();
  const generation = expectedGeneration
    ? await assertNamedFileGeneration(filename, expectedGeneration, label)
    : await optionalRegularFile(filename, label);
  if (!generation) throw new Error(`${label} disappeared while it was being verified`);
  let target;
  let transaction = false;
  try {
    target = new SqliteDatabase(filename, { readOnly: true });
    await assertNamedFileGeneration(filename, generation, label);
    target.database.exec('BEGIN');
    transaction = true;
    const envelope = await getNativeEnvelope(target);
    const tables = await databaseDigest(target, { batchSize: options.batchSize, signal: options.signal });
    await assertNamedFileGeneration(filename, generation, label);
    target.database.exec('ROLLBACK');
    transaction = false;
    target.close();
    target = undefined;
    lease.assertHeld();
    await assertNamedFileGeneration(filename, generation, label);
    return { envelope, tables, generation };
  } catch (error) {
    const cleanupErrors = [];
    if (transaction) {
      try { target.database.exec('ROLLBACK'); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (target) {
      try { target.close(); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) throw failureAggregate(error, cleanupErrors, 'SQLite export verification and cleanup failed');
    throw error;
  }
}

function assertSqliteExportSnapshot(snapshot, expectedEnvelope, expectedTables, label) {
  if (serializeNativeEnvelope(snapshot.envelope) !== serializeNativeEnvelope(expectedEnvelope)
    || !same(snapshot.tables, expectedTables)) {
    throw new Error(`${label} differs from the completed migration snapshot`);
  }
}

async function verifyPublishedSqliteExport(source, filename, options, lease) {
  if (source.dialect === 'postgres' && !source.connectionSession
    && typeof source.withConnection === 'function') {
    return source.withConnection(session => verifyPublishedSqliteExport(session, filename, options, lease));
  }
  const { batchSize = 128, signal, instanceBinding } = options;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('Invalid migration batch size');
  if (source.dialect === 'postgres' && instanceBinding !== undefined) throw new Error('A PostgreSQL source instance binding cannot be overridden');
  if (instanceBinding !== undefined) {
    canonicalInstanceBinding(instanceBinding);
    throw new Error('An instance binding can only be written to a PostgreSQL target');
  }
  if (source.dialect === 'sqlite' ? source.database.isTransaction : source.inTransaction) {
    throw new Error('Migration requires exclusive connections outside transactions');
  }
  await source.preflight();
  let sourceTransaction = false;
  let sourceSnapshotLock = false;
  let generation;
  try {
    if (source.dialect === 'postgres') {
      await acquirePostgresWriteLock(source, { signal });
      sourceSnapshotLock = true;
    }
    sourceTransaction = true;
    if (source.dialect === 'sqlite') source.database.exec('BEGIN');
    else {
      source.inTransaction = true;
      await source.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await verifyPostgresTransferContract(source, {
        requirePinnedEnvelope: !options.testOnlyAllowSyntheticEnvelope,
        requirePortableMountContract: !options.testOnlyAllowSyntheticEnvelope,
      });
    }
    const envelope = await getNativeEnvelope(source);
    if (sourceSnapshotLock) {
      sourceSnapshotLock = false;
      await releasePostgresSourceSnapshotLock(source);
    }
    if (!options.testOnlyAllowSyntheticEnvelope) assertPinnedJellyfinEnvelope(envelope);
    const { sourceContract, targetContract } = await exportMountContracts(source, options);
    const projector = createSqliteExportPathProjector({ sourceContract, targetContract,
      instanceStatePaths: options.instanceStatePaths });
    const tables = await databaseDigest(source, { batchSize, signal, rowTransform: projector.projectRow });
    const firstRead = await readStableSqliteFile(filename, { batchSize, signal }, undefined, lease,
      'Published migration target');
    generation = firstRead.generation;
    if (serializeNativeEnvelope(firstRead.envelope) !== serializeNativeEnvelope(envelope)
      || !same(firstRead.tables, tables)) {
      throw new Error('Existing migration target differs from the current source snapshot');
    }
    // Reopen the final named path rather than trusting the first connection's
    // snapshot. This catches same-inode replacement/truncation during the first
    // digest; generation metadata catches writes after either digest completes.
    const finalRead = await readStableSqliteFile(filename, { batchSize, signal }, generation, lease,
      'Published migration target');
    if (serializeNativeEnvelope(finalRead.envelope) !== serializeNativeEnvelope(envelope)
      || !same(finalRead.tables, tables)) {
      throw new Error('Existing migration target differs from the current source snapshot');
    }
    if (source.dialect === 'sqlite') source.database.exec('ROLLBACK');
    else await source.client.query('ROLLBACK');
    sourceTransaction = false;
    if (source.dialect === 'postgres') source.inTransaction = false;
    lease.assertHeld();
    await assertNamedFileGeneration(filename, generation, 'Published migration target');
    return { ...transferResult(tables, envelope), pathProjection: projector.statistics(),
      portableMountContract: targetContract };
  } catch (error) {
    const cleanupErrors = [];
    if (sourceTransaction) {
      try { if (source.dialect === 'sqlite') source.database.exec('ROLLBACK'); else await source.client.query('ROLLBACK'); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (sourceSnapshotLock) {
      sourceSnapshotLock = false;
      try { await releasePostgresSourceSnapshotLock(source); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) throw failureAggregate(error, cleanupErrors, 'Published SQLite verification and cleanup failed');
    throw error;
  } finally {
    if (source.dialect === 'postgres') source.inTransaction = false;
  }
}

async function exportCurrentSqliteOwned(source, filename, staging, options, lease) {
  // Keep contract, envelope and transfer reads on one explicit operation
  // session for the lifetime of a PostgreSQL export.
  if (source.dialect === 'postgres' && !source.connectionSession
    && typeof source.withConnection === 'function') {
    return source.withConnection(session => exportCurrentSqliteOwned(session, filename, staging, options, lease));
  }
  const postgresSourceContract = source.dialect === 'postgres'
    ? await verifyPostgresTransferContract(source, {
      requirePinnedEnvelope: !options.testOnlyAllowSyntheticEnvelope,
      requirePortableMountContract: !options.testOnlyAllowSyntheticEnvelope,
    })
    : null;
  const envelope = postgresSourceContract?.nativeEnvelope ?? await getNativeEnvelope(source);
  if (!options.testOnlyAllowSyntheticEnvelope) assertPinnedJellyfinEnvelope(envelope);
  const { sourceContract, targetContract } = await exportMountContracts(source, options);
  await assertSqliteSourceIsolation(source, filename, staging);
  lease.assertHeld();
  const existing = await recoverPrivateSqliteStaging(staging, filename);
  if (existing) {
    try { return await verifyPublishedSqliteExport(source, filename, options, lease); }
    catch (error) { throw new Error('Migration target already exists and cannot be resumed', { cause: error }); }
  }
  let target;
  let published = false;
  let stagingCleanupAttempted = false;
  let stagingIdentity;
  try {
    lease.assertHeld();
    target = await createSqliteTarget(staging, envelope);
    stagingIdentity = target.migrationFileIdentity;
    const transferred = await transferDatabase(source, target, transferOptionsForExport(options));
    const pathProjection = await rewriteSqliteExportPaths(target, {
      sourceContract, targetContract, instanceStatePaths: options.instanceStatePaths,
      batchSize: options.batchSize, signal: options.signal
    });
    const result = { ...transferred, tables: await databaseDigest(target, {
      batchSize: options.batchSize, signal: options.signal
    }), pathProjection, portableMountContract: targetContract };
    target.close();
    target = undefined;
    await assertNamedFileIdentity(staging, stagingIdentity, 'Completed migration staging file');
    const completedEnvelope = {
      ddl: envelope.ddl,
      fingerprint: result.nativeSchemaFingerprint,
      history: result.migrationHistory,
      sqliteSequence: result.sqliteSequence,
    };
    const stagedRead = await readStableSqliteFile(staging, options, undefined, lease,
      'Completed migration staging file');
    assertSqliteExportSnapshot(stagedRead, completedEnvelope, result.tables, 'Completed migration staging file');
    lease.assertHeld();
    await assertNamedFileGeneration(staging, stagedRead.generation, 'Completed migration staging file');
    lease.assertHeld();
    try { await link(staging, filename); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Migration target already exists', { cause: error });
      throw error;
    }
    published = true;
    await assertNamedFileIdentity(filename, stagingIdentity, 'Published migration target');
    stagingCleanupAttempted = true;
    await removePrivateSqliteStaging(staging, stagingIdentity);
    const publishedRead = await readStableSqliteFile(filename, options, undefined, lease,
      'Published migration target');
    assertSqliteExportSnapshot(publishedRead, completedEnvelope, result.tables, 'Published migration target');
    options.signal?.throwIfAborted();
    lease.assertHeld();
    await assertNamedFileGeneration(filename, publishedRead.generation, 'Published migration target');
    return result;
  } catch (error) {
    const cleanupErrors = [];
    if (target) {
      try { target.close(); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    let held = true;
    try { lease.assertHeld(); }
    catch (leaseError) { held = false; cleanupErrors.push(leaseError); }
    if (held) {
      if (published) {
        try { await removeOwnedFile(filename, stagingIdentity, 'Published migration target'); }
        catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      if (!stagingCleanupAttempted) {
        try { await removePrivateSqliteStaging(staging, stagingIdentity); }
        catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
    }
    if (cleanupErrors.length) throw failureAggregate(error, cleanupErrors, 'SQLite export and cleanup failed');
    throw error;
  }
}

export async function exportCurrentSqlite(source, filename, options = {}) {
  options = normalizeSqliteExportOptions(options);
  filename = path.resolve(filename);
  const staging = path.join(path.dirname(filename), `.${path.basename(filename)}.mediamanager-export-staging`);
  const lease = await acquireOperationLease(await prospectivePhysicalPath(filename), { label: 'SQLite export' });
  let result, operationError, operationFailed = false;
  try {
    await assertSqliteSourceIsolation(source, filename, staging);
    lease.assertHeld();
    result = await exportCurrentSqliteOwned(source, filename, staging, options, lease);
  } catch (error) { operationFailed = true; operationError = error; }
  try { await lease.release(); }
  catch (releaseError) {
    if (operationFailed) throw failureAggregate(operationError, [releaseError], 'SQLite export and lease release failed');
    throw releaseError;
  }
  if (operationFailed) throw operationError;
  return result;
}
