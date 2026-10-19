import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { access, link, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { inspectSqliteSchema, SqliteDatabase } from '../../src/database/sqlite.js';
import { canonicalNativeSqliteSchema, preflightSqlite } from '../../src/database/sqlite-schema.js';
import { canonicalInstanceBinding, canonicalTransferReceipt, PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { nativeModel, quoteIdentifier as q } from '../../src/database/model.js';
import { nativeInsertionOrderedTables } from '../../src/database/native-relation-order.js';
import {
  assertPinnedJellyfinEnvelope,
  createSqliteTarget,
  databaseDigest,
  exportCurrentSqlite,
  getNativeEnvelope,
  pinnedNativeSqliteMigrationHistory,
  pinnedNativeSqliteSchemaFingerprint,
  transferDatabase,
} from '../../src/migration/database-transfer.js';
import { seedAllTables, fixtureIds, fixtureRow } from '../database/fixtures.js';

const instanceBinding = {
  serverId: '0123456789abcdef0123456789abcdef',
  originIdentityDigest: '0123456789abcdef'.repeat(4)
};
const portableMountContract = {
  mounts: [{
    mountId: 'media', identityRoot: 'Z:\\', accessRoot: '/media',
    pathStyle: 'windows', caseSensitive: false, returnPolicy: 'required'
  }]
};
const nativeChannelId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const nativeRemoteImageId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const nativeAllowedPaths = Object.freeze({
  item: 'https://channels.example.invalid/live/channel.m3u8',
  internalImage: '%MetadataPath%\\library\\aa\\poster.jpg',
  remoteImage: 'https://image.tmdb.org/t/p/original/poster.jpg',
  internalStream: '%MetadataPath%\\subtitles\\channel.en.srt',
});
const exportSynthetic = (source, filename, options = {}) => exportCurrentSqlite(source, filename, {
  ...options,
  testOnlyAllowSyntheticEnvelope: true,
});

async function seedPortableTables(database) {
  seedAllTables(database);
  const pathColumns = new Map([
    ['BaseItemImageInfos', ['Path']],
    ['BaseItems', ['Path']],
    ['Chapters', ['ImagePath']],
    ['ImageInfos', ['Path']],
    ['MediaStreamInfos', ['Path']],
  ]);
  for (const [tableName, columns] of pathColumns) {
    const table = nativeModel.tables.find(candidate => candidate.name === tableName);
    const rows = await database.rows(tableName);
    for (const [index, row] of rows.entries()) {
      const key = Object.fromEntries(table.primaryKey.map(column => [column, row[column]]));
      const changes = Object.fromEntries(columns.map(column => [column, `Z:\\Media\\${tableName}-${index}.bin`]));
      await database.update(tableName, key, changes);
    }
  }
}

async function seedNativeAllowedPaths(database) {
  await database.update('BaseItems', { Id: fixtureIds.BaseItems }, {
    ChannelId: nativeChannelId,
    Path: nativeAllowedPaths.item,
  });
  const itemImage = (await database.rows('BaseItemImageInfos'))[0];
  await database.update('BaseItemImageInfos', { Id: itemImage.Id }, { Path: nativeAllowedPaths.internalImage });
  await database.insert('BaseItemImageInfos', {
    ...itemImage,
    Id: nativeRemoteImageId,
    Path: nativeAllowedPaths.remoteImage,
  });
  const stream = (await database.rows('MediaStreamInfos'))[0];
  await database.update('MediaStreamInfos', { ItemId: stream.ItemId, StreamIndex: stream.StreamIndex }, {
    Path: nativeAllowedPaths.internalStream,
  });
  return { itemImageId: itemImage.Id, streamKey: { ItemId: stream.ItemId, StreamIndex: stream.StreamIndex } };
}

class MockPostgresTarget {
  constructor(store, { loseCommitAcknowledgement = false } = {}) {
    this.store = store;
    this.schemaName = 'mock_target';
    this.controlSchema = 'mock_target__mm';
    this.dialect = 'postgres';
    this.inTransaction = false;
    this.loseCommitAcknowledgement = loseCommitAcknowledgement;
    this.pendingControl = null;
    this.writeLockHeld = false;
    this.writeLockEvents = [];
    this.client = { query: (sql) => this.query(sql) };
  }
  async query(sql) {
    if (sql.startsWith('SELECT pg_try_advisory_lock')) {
      this.writeLockHeld = true;
      this.writeLockEvents.push('acquire');
      return { rows: [{ locked: true }] };
    } else if (sql.startsWith('SELECT pg_advisory_unlock')) {
      const unlocked = this.writeLockHeld;
      this.writeLockHeld = false;
      this.writeLockEvents.push('release');
      return { rows: [{ unlocked }] };
    } else if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ') {
      this.store.database.database.exec('BEGIN IMMEDIATE');
      this.store.database.database.exec('PRAGMA defer_foreign_keys = ON');
      this.pendingControl = structuredClone(this.store.control);
    } else if (sql === 'COMMIT') {
      this.store.database.database.exec('COMMIT');
      this.store.control = this.pendingControl;
      this.pendingControl = null;
      if (this.loseCommitAcknowledgement) {
        this.loseCommitAcknowledgement = false;
        throw new Error('injected lost PostgreSQL COMMIT acknowledgement');
      }
    } else if (sql === 'ROLLBACK') {
      if (this.store.database.database.isTransaction) this.store.database.database.exec('ROLLBACK');
      this.pendingControl = null;
    }
    return { rows: [] };
  }
  async preflight() { return true; }
  async databaseIdentity() { return { database: 'mock', databaseOid: '1', serverAddress: 'mock', serverPort: 5432 }; }
  async rows(...args) { return this.store.database.rows(...args); }
  relationRowsInInsertionOrder(name, options) { return this.store.database.relationRowsInInsertionOrder(name, options); }
  async insert(...args) { this.store.insertions += 1; return this.store.database.insert(...args); }
  async insertBatch(name, rows) {
    this.store.batchInsertions ??= [];
    this.store.batchInsertions.push({ name, rows: rows.length });
    for (const row of rows) await this.insert(name, row);
    return BigInt(rows.length);
  }
  async readInstanceBinding() { return structuredClone((this.pendingControl ?? this.store.control).instanceBinding); }
  async writeInstanceBinding(value) {
    const binding = canonicalInstanceBinding(value);
    const control = this.pendingControl ?? this.store.control;
    if (control.instanceBinding && JSON.stringify(control.instanceBinding) !== JSON.stringify(binding)) throw new Error('PostgreSQL instance binding differs');
    control.instanceBinding = binding;
    return structuredClone(binding);
  }
  async readNativeEnvelope() { return structuredClone((this.pendingControl ?? this.store.control).nativeEnvelope); }
  async writeNativeEnvelope(value) {
    const control = this.pendingControl ?? this.store.control;
    if (control.nativeEnvelope) throw new Error('PostgreSQL native envelope differs');
    control.nativeEnvelope = structuredClone(value);
    return structuredClone(value);
  }
  async readTransferReceipt() { return structuredClone((this.pendingControl ?? this.store.control).transferReceipt); }
  async writeTransferReceipt(value) {
    const receipt = canonicalTransferReceipt(value);
    const control = this.pendingControl ?? this.store.control;
    if (control.transferReceipt && JSON.stringify(control.transferReceipt) !== JSON.stringify(receipt)) throw new Error('PostgreSQL transfer receipt differs');
    control.transferReceipt = receipt;
    return structuredClone(receipt);
  }
  async getState(key) { return structuredClone((this.pendingControl ?? this.store.control)[key]); }
  async setState(key, value) { (this.pendingControl ?? this.store.control)[key] = structuredClone(value); }
  async resetSequences(sequence) {
    this.store.database.database.exec('DELETE FROM sqlite_sequence');
    const insert = this.store.database.database.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
    for (const entry of sequence) insert.run(entry.name, entry.seq);
  }
  async sequenceState() {
    return this.store.database.database.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name COLLATE BINARY').all();
  }
}

test('instance bindings reject non-canonical values and non-PostgreSQL targets without mutating either database', async () => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const target = new SqliteDatabase(':memory:', { create: true });
  try {
    seedAllTables(source);
    const before = await databaseDigest(source);
    for (const [binding, message] of [
      [null, /plain object/],
      [{ ...instanceBinding, serverId: 'not-a-guid' }, /serverId must be a valid native/],
      [{ ...instanceBinding, originIdentityDigest: '0'.repeat(63) }, /originIdentityDigest must be 64 lowercase/],
      [{ ...instanceBinding, unexpected: true }, /must contain exactly/]
    ]) await assert.rejects(transferDatabase(source, target, { instanceBinding: binding }), message);
    await assert.rejects(transferDatabase(source, target, { instanceBinding }), /only be written to a PostgreSQL target/);
    assert.deepEqual(await databaseDigest(source), before);
    assert.ok((await databaseDigest(target)).every((table) => table.rows === 0));
    assert.deepEqual(canonicalInstanceBinding(instanceBinding), instanceBinding);
  } finally { source.close(); target.close(); }
});

test('SQLite migration exports current mutations and preserves deleted high-water IDs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-transfer-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  let result;
  try {
    seedAllTables(source);
    source.update('UserData', { ItemId: fixtureIds.BaseItems, UserId: fixtureIds.Users, CustomDataKey: '' }, { PlaybackPositionTicks: 9007199254740993n, IsFavorite: false });
    await exportSynthetic(source, path.join(directory, 'current.db'));
    result = new SqliteDatabase(path.join(directory, 'current.db'));
    assert.deepEqual(await databaseDigest(result), await databaseDigest(source));
    const log = fixtureRow(nativeModel.tables.find((table) => table.name === 'ActivityLogs'));
    delete log.Id;
    assert.equal(result.insert('ActivityLogs', log).Id, 201);
  } finally { result?.close(); source.close(); await rm(directory, { recursive: true }); }
});

test('large SQLite to PostgreSQL transfer uses keyset reads and one set-based insert per batch', async () => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const backing = new SqliteDatabase(':memory:', { create: true });
  const store = {
    database: backing,
    insertions: 0,
    batchInsertions: [],
    control: { instanceBinding: null, nativeEnvelope: null, transferReceipt: null },
  };
  try {
    seedAllTables(source);
    const log = fixtureRow(nativeModel.tables.find(table => table.name === 'ActivityLogs'));
    delete log.Id;
    for (let index = 0; index < 1_204; index += 1) {
      source.insert('ActivityLogs', { ...log, Name: `bulk-${index}` });
    }
    const sourceRows = source.rows.bind(source);
    const activityReads = [];
    source.rows = async (name, options) => {
      if (name === 'ActivityLogs') activityReads.push(structuredClone(options));
      return sourceRows(name, options);
    };

    await transferDatabase(source, new MockPostgresTarget(store), {
      batchSize: 200,
      instanceBinding,
    });

    assert.equal(activityReads.length, 20,
      'the digest and copy each need ten bounded keyset queries for 1,205 rows');
    assert.ok(activityReads.every(options => options.limit === 128 && !Object.hasOwn(options, 'offset')));
    assert.deepEqual(activityReads.map(options => Object.hasOwn(options, 'after')),
      [...Array.from({ length: 10 }, (_, index) => index !== 0), ...Array.from({ length: 10 }, (_, index) => index !== 0)]);
    assert.deepEqual(store.batchInsertions.filter(entry => entry.name === 'ActivityLogs').map(entry => entry.rows),
      [...Array(9).fill(128), 53]);
    assert.equal((await backing.rows('ActivityLogs')).length, 1_205);
  } finally {
    source.close();
    backing.close();
  }
});

test('SQLite export publishes atomically, removes failed staging files and can retry the same path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-resume-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'current.db');
  const staging = path.join(directory, '.current.db.mediamanager-export-staging');
  let result;
  try {
    seedAllTables(source);
    const controller = new AbortController();
    const rows = source.rows.bind(source);
    let calls = 0;
    source.rows = (...args) => {
      calls += 1;
      const value = rows(...args);
      if (calls === nativeModel.tables.length + 1) controller.abort();
      return value;
    };
    await assert.rejects(exportSynthetic(source, filename, { signal: controller.signal }), /abort/iu);
    await assert.rejects(access(filename), { code: 'ENOENT' });
    assert.deepEqual(await readdir(directory), []);

    source.rows = rows;
    await writeFile(staging, 'hard-killed partial SQLite bytes', { flag: 'wx', mode: 0o600 });
    await writeFile(`${staging}-journal`, 'hard-killed rollback journal', { flag: 'wx', mode: 0o600 });
    await exportSynthetic(source, filename);
    result = new SqliteDatabase(filename);
    assert.deepEqual(await databaseDigest(result), await databaseDigest(source));
    result.close();
    result = undefined;
    assert.deepEqual(await readdir(directory), ['current.db']);

    const finalOnlyResume = await exportSynthetic(source, filename);
    assert.equal(finalOnlyResume.verified, true);
    await link(filename, staging);
    await writeFile(`${staging}-shm`, 'hard-killed shared memory', { flag: 'wx', mode: 0o600 });
    const linkedResume = await exportSynthetic(source, filename);
    assert.equal(linkedResume.verified, true);
    assert.deepEqual(await readdir(directory), ['current.db']);

    await writeFile(path.join(directory, 'occupied.db'), 'keep-me', { flag: 'wx' });
    await assert.rejects(exportSynthetic(source, path.join(directory, 'occupied.db')), /target already exists/iu);
    assert.equal(await readFile(path.join(directory, 'occupied.db'), 'utf8'), 'keep-me');
    assert.deepEqual((await readdir(directory)).sort(), ['current.db', 'occupied.db']);
  } finally { result?.close(); source.close(); await rm(directory, { recursive: true }); }
});

test('fresh SQLite export reopens closed staging and never publishes a same-inode post-close rewrite', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-fresh-staging-race-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'current.db');
  const originalClose = SqliteDatabase.prototype.close;
  let injected = false;
  try {
    SqliteDatabase.prototype.close = function closeWithPostVerificationRewrite() {
      const targetFilename = this.filename;
      originalClose.call(this);
      if (!injected && targetFilename.endsWith('.mediamanager-export-staging')) {
        injected = true;
        writeFileSync(targetFilename, 'same inode rewrite after the verified target was closed');
      }
    };
    await assert.rejects(exportSynthetic(source, filename), error => {
      assert.equal(error instanceof AggregateError, false);
      return true;
    });
    assert.equal(injected, true);
    await assert.rejects(access(filename), { code: 'ENOENT' });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    SqliteDatabase.prototype.close = originalClose;
    source.close();
    await rm(directory, { recursive: true });
  }
});

test('fresh SQLite export verifies the final named path before returning success', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-fresh-final-race-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'current.db');
  const lastTable = nativeModel.tables.at(-1).name;
  const readMethod = nativeInsertionOrderedTables.includes(lastTable) ? 'relationRowsInInsertionOrder' : 'rows';
  const originalRead = SqliteDatabase.prototype[readMethod];
  let injected = false;
  try {
    SqliteDatabase.prototype[readMethod] = async function rowsWithFinalNamedPathRewrite(table, options) {
      const result = await originalRead.call(this, table, options), rows = Array.isArray(result) ? result : result.rows;
      if (!injected && path.resolve(this.filename) === path.resolve(filename)
        && table === lastTable && rows.length < options.limit) {
        injected = true;
        await writeFile(filename, 'same inode rewrite during final named path verification');
      }
      return result;
    };
    await assert.rejects(exportSynthetic(source, filename), error => {
      assert.equal(error instanceof AggregateError, false);
      return true;
    });
    assert.equal(injected, true);
    await assert.rejects(access(filename), { code: 'ENOENT' });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    SqliteDatabase.prototype[readMethod] = originalRead;
    source.close();
    await rm(directory, { recursive: true });
  }
});

test('existing SQLite export verification rejects same-inode writes during either digest pass without deleting the target', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-existing-race-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const lastTable = nativeModel.tables.at(-1).name;
  const readMethod = nativeInsertionOrderedTables.includes(lastTable) ? 'relationRowsInInsertionOrder' : 'rows';
  const originalRead = SqliteDatabase.prototype[readMethod];
  try {
    seedAllTables(source);
    for (const mutationPass of [1, 2]) {
      const filename = path.join(directory, `current-${mutationPass}.db`);
      await exportSynthetic(source, filename);
      const replacement = `NOT A SQLITE DATABASE ${mutationPass}`;
      let completedTargetDigests = 0;
      SqliteDatabase.prototype[readMethod] = async function rowsWithSameInodeWrite(table, options) {
        const result = await originalRead.call(this, table, options), rows = Array.isArray(result) ? result : result.rows;
        if (path.resolve(this.filename) === path.resolve(filename)
          && table === lastTable && rows.length < options.limit) {
          completedTargetDigests += 1;
          if (completedTargetDigests === mutationPass) await writeFile(filename, replacement);
        }
        return result;
      };
      await assert.rejects(exportSynthetic(source, filename), /cannot be resumed/u);
      assert.equal(await readFile(filename, 'utf8'), replacement);
      SqliteDatabase.prototype[readMethod] = originalRead;
    }
  } finally {
    SqliteDatabase.prototype[readMethod] = originalRead;
    source.close();
    await rm(directory, { recursive: true });
  }
});

test('SQLite export preserves its original failure when staging cleanup also fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-cleanup-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'current.db');
  const rows = source.rows.bind(source);
  const close = SqliteDatabase.prototype.close;
  try {
    source.rows = () => { throw new Error('injected export failure'); };
    SqliteDatabase.prototype.close = function closeWithFailure() {
      close.call(this);
      if (this.filename.endsWith('.mediamanager-export-staging')) throw new Error('injected staging close cleanup failure');
    };
    await assert.rejects(exportSynthetic(source, filename), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause?.message, 'injected export failure');
      assert.deepEqual(error.errors.map(entry => entry.message), [
        'injected export failure',
        'injected staging close cleanup failure'
      ]);
      return true;
    });
    await assert.rejects(access(filename), { code: 'ENOENT' });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    SqliteDatabase.prototype.close = close;
    source.rows = rows;
    source.close();
    await rm(directory, { recursive: true });
  }
});

test('concurrent SQLite exports hold one OS-owned lease and never remove the active staging file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-lease-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'current.db');
  const staging = path.join(directory, '.current.db.mediamanager-export-staging');
  const rows = source.rows.bind(source);
  let releaseRows;
  const rowGate = new Promise(resolve => { releaseRows = resolve; });
  let enteredRows;
  const rowsEntered = new Promise(resolve => { enteredRows = resolve; });
  let pause = true;
  try {
    seedAllTables(source);
    source.rows = async (...args) => {
      if (pause) {
        pause = false;
        enteredRows();
        await rowGate;
      }
      return rows(...args);
    };
    const first = exportSynthetic(source, filename);
    await rowsEntered;
    await access(staging);
    await assert.rejects(exportSynthetic(source, filename), /SQLite export is already active/u);
    await access(staging);
    releaseRows();
    const result = await first;
    assert.equal(result.verified, true);
    assert.deepEqual(await readdir(directory), ['current.db']);
  } finally {
    releaseRows();
    source.rows = rows;
    source.close();
    await rm(directory, { recursive: true });
  }
});

test('a hard-killed lease owner releases the OS lease and leaves its staging safely resumable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-hard-kill-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const filename = path.join(directory, 'current.db');
  const staging = path.join(directory, '.current.db.mediamanager-export-staging');
  const moduleUrl = new URL('../../src/migration/operation-lease.js', import.meta.url).href;
  const physicalDirectory = await realpath(directory);
  const identityPath = path.join(physicalDirectory, 'current.db');
  const identity = process.platform === 'win32' ? identityPath.toLowerCase() : identityPath;
  let child;
  try {
    seedAllTables(source);
    await writeFile(staging, 'hard-killed owner bytes', { flag: 'wx', mode: 0o600 });
    child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { acquireOperationLease } = await import(process.env.MM_LEASE_MODULE);
      globalThis.lease = await acquireOperationLease(process.env.MM_LEASE_IDENTITY, { label: 'SQLite export' });
      process.stdout.write('READY\\n');
      setInterval(() => {}, 1000);
    `], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MM_LEASE_MODULE: moduleUrl, MM_LEASE_IDENTITY: identity }
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => { if (chunk.toString().includes('READY')) resolve(); });
      child.once('exit', code => reject(new Error(`Lease child exited before readiness (${code}): ${stderr}`)));
    });
    await assert.rejects(exportSynthetic(source, filename), /SQLite export is already active/u);
    await access(staging);
    child.kill();
    await once(child, 'exit');
    child = undefined;

    const result = await exportSynthetic(source, filename);
    assert.equal(result.verified, true);
    assert.deepEqual(await readdir(directory), ['current.db']);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    source.close();
    await rm(directory, { recursive: true });
  }
});

test('SQLite export rejects canonical and hard-link collisions with its source before cleanup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-export-collision-'));
  const sourceFilename = path.join(directory, 'source.db');
  const destination = path.join(directory, 'current.db');
  const staging = path.join(directory, '.current.db.mediamanager-export-staging');
  let source = new SqliteDatabase(sourceFilename, { create: true });
  seedAllTables(source);
  const expected = await databaseDigest(source);
  source.close();
  source = undefined;
  try {
    source = new SqliteDatabase(sourceFilename);
    await assert.rejects(exportSynthetic(source, sourceFilename), /source collides/u);
    assert.deepEqual(await databaseDigest(source), expected);
    source.close();
    source = undefined;

    await link(sourceFilename, staging);
    source = new SqliteDatabase(sourceFilename);
    await assert.rejects(exportSynthetic(source, destination), /source is hard-linked/u);
    assert.deepEqual(await databaseDigest(source), expected);
    await access(staging);
    source.close();
    source = undefined;
    await rm(staging);

    await link(sourceFilename, destination);
    source = new SqliteDatabase(sourceFilename);
    await assert.rejects(exportSynthetic(source, destination), /source is hard-linked/u);
    assert.deepEqual(await databaseDigest(source), expected);
    await access(sourceFilename);
  } finally {
    source?.close();
    await rm(directory, { recursive: true });
  }
});

test('a committed PostgreSQL receipt makes a lost COMMIT acknowledgement idempotently resumable', async () => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const backing = new SqliteDatabase(':memory:', { create: true });
  const store = {
    database: backing,
    insertions: 0,
    control: { instanceBinding: null, nativeEnvelope: null, transferReceipt: null }
  };
  try {
    seedAllTables(source);
    const interrupted = new MockPostgresTarget(store, { loseCommitAcknowledgement: true });
    await assert.rejects(
      transferDatabase(source, interrupted, { instanceBinding }),
      error => error.code === 'POSTGRES_COMMIT_OUTCOME_UNKNOWN'
        && /lost PostgreSQL COMMIT acknowledgement/iu.test(error.message)
    );
    const insertions = store.insertions;
    assert.ok(insertions > 0);
    assert.equal(Object.hasOwn(store.control.transferReceipt, 'formatVersion'), false);
    assert.deepEqual(store.control.transferReceipt.sourceTables, await databaseDigest(source));
    assert.deepEqual(store.control.transferReceipt.instanceBinding, instanceBinding);
    for (const key of ['nativeEnvelopeSha256', 'sourceIdentitySha256', 'targetIdentitySha256']) {
      assert.match(store.control.transferReceipt[key], /^[a-f0-9]{64}$/u);
    }
    assert.equal(store.control.transferReceipt.portableMountContractSha256, null);
    assert.deepEqual(await databaseDigest(backing), await databaseDigest(source));

    const reopened = new MockPostgresTarget(store);
    const result = await transferDatabase(source, reopened, { instanceBinding });
    assert.equal(result.verified, true);
    assert.equal(store.insertions, insertions);
    assert.deepEqual(result.tables, await databaseDigest(source));
  } finally { source.close(); backing.close(); }
});

test('SQLite import preserves native internal and HTTP image/channel paths without changing source hashes', async () => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const backing = new SqliteDatabase(':memory:', { create: true });
  const store = {
    database: backing,
    insertions: 0,
    control: { instanceBinding: null, nativeEnvelope: null, transferReceipt: null }
  };
  try {
    await seedPortableTables(source);
    const { itemImageId, streamKey } = await seedNativeAllowedPaths(source);
    const before = await databaseDigest(source);
    const result = await transferDatabase(source, new MockPostgresTarget(store), {
      instanceBinding, portableMountContract
    });
    assert.deepEqual(result.tables, before);
    assert.deepEqual(store.control.transferReceipt.sourceTables, before);
    assert.deepEqual(await databaseDigest(backing), before);
    assert.equal((await backing.rows('BaseItems', { where: { Id: fixtureIds.BaseItems } }))[0].Path,
      nativeAllowedPaths.item);
    assert.equal((await backing.rows('BaseItemImageInfos', { where: { Id: itemImageId } }))[0].Path,
      nativeAllowedPaths.internalImage);
    assert.equal((await backing.rows('BaseItemImageInfos', { where: { Id: nativeRemoteImageId } }))[0].Path,
      nativeAllowedPaths.remoteImage);
    assert.equal((await backing.rows('MediaStreamInfos', { where: streamKey }))[0].Path,
      nativeAllowedPaths.internalStream);
  } finally { source.close(); backing.close(); }
});

test('a committed PostgreSQL receipt resumes with its unchanged persisted mount contract when the retry omits it', async () => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const backing = new SqliteDatabase(':memory:', { create: true });
  const store = {
    database: backing,
    insertions: 0,
    control: { instanceBinding: null, nativeEnvelope: null, transferReceipt: null }
  };
  try {
    await seedPortableTables(source);
    await assert.rejects(
      transferDatabase(source, new MockPostgresTarget(store, { loseCommitAcknowledgement: true }), {
        instanceBinding, portableMountContract
      }),
      /lost PostgreSQL COMMIT acknowledgement/iu
    );
    assert.match(store.control.transferReceipt.portableMountContractSha256, /^[a-f0-9]{64}$/u);
    const insertions = store.insertions;
    const receipt = structuredClone(store.control.transferReceipt);
    const persistedContract = store.control.portableVfsMountContract;

    const result = await transferDatabase(source, new MockPostgresTarget(store), { instanceBinding });
    assert.equal(result.verified, true);
    assert.equal(store.insertions, insertions);
    assert.deepEqual(store.control.transferReceipt, receipt);
    assert.equal(store.control.portableVfsMountContract, persistedContract);
    assert.deepEqual(result.tables, await databaseDigest(source));
  } finally { source.close(); backing.close(); }
});

test('a committed PostgreSQL receipt rejects a tampered persisted mount contract when the retry omits it', async () => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const backing = new SqliteDatabase(':memory:', { create: true });
  const store = {
    database: backing,
    insertions: 0,
    control: { instanceBinding: null, nativeEnvelope: null, transferReceipt: null }
  };
  try {
    await seedPortableTables(source);
    await assert.rejects(
      transferDatabase(source, new MockPostgresTarget(store, { loseCommitAcknowledgement: true }), {
        instanceBinding, portableMountContract
      }),
      /lost PostgreSQL COMMIT acknowledgement/iu
    );
    const insertions = store.insertions;

    store.control.portableVfsMountContract = JSON.stringify({
      ...portableMountContract,
      mounts: [{ ...portableMountContract.mounts[0], accessRoot: '/different-media' }]
    });
    await assert.rejects(
      transferDatabase(source, new MockPostgresTarget(store), { instanceBinding }),
      /different transfer receipt/iu
    );
    assert.equal(store.insertions, insertions);
  } finally { source.close(); backing.close(); }
});

test('SQLite import audits every path against the portable mount before issuing a receipt', async t => {
  for (const [name, changes, pattern] of [
    ['unmapped absolute path', { Path: 'E:\\Outside\\movie.mkv' }, /outside every portable mount/iu],
    ['relative path', { Path: 'relative\\movie.mkv' }, /outside every portable mount/iu],
    ['storage protocol path', { Path: 'webdav://backend.invalid/movie.mkv', ChannelId: nativeChannelId }, /storage protocol URL/iu],
    ['ordinary item HTTP path', { Path: 'https://alist.invalid/dav/movie.mkv', ChannelId: '00000000-0000-0000-0000-000000000000' }, /storage protocol URL/iu],
    ['channel HTTP path with user information', { Path: 'https://user:secret@channels.invalid/live.m3u8', ChannelId: nativeChannelId }, /storage protocol URL/iu],
    ['VFS access path', { Path: '/media/movie.mkv', ChannelId: nativeChannelId }, /VFS access path/iu],
  ]) await t.test(name, async () => {
    const source = new SqliteDatabase(':memory:', { create: true });
    const backing = new SqliteDatabase(':memory:', { create: true });
    const store = {
      database: backing,
      insertions: 0,
      control: { instanceBinding: null, nativeEnvelope: null, transferReceipt: null }
    };
    try {
      const table = nativeModel.tables.find(candidate => candidate.name === 'BaseItems');
      await source.insert('BaseItems', { ...fixtureRow(table), ...changes });
      await assert.rejects(
        transferDatabase(source, new MockPostgresTarget(store), { instanceBinding, portableMountContract }),
        pattern
      );
      assert.equal(store.insertions, 0);
      assert.equal(store.control.transferReceipt, null);
      for (const nativeTable of nativeModel.tables) {
        assert.equal((await backing.rows(nativeTable.name, { limit: 1 })).length, 0);
      }
    } finally { source.close(); backing.close(); }
  });
});

test('an unrelated nonempty PostgreSQL target without a receipt is never accepted as resumed', async () => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const backing = new SqliteDatabase(':memory:', { create: true });
  const store = {
    database: backing,
    insertions: 0,
    control: { instanceBinding: null, nativeEnvelope: null, transferReceipt: null }
  };
  try {
    seedAllTables(source);
    seedAllTables(backing);
    const before = await databaseDigest(backing);
    await assert.rejects(
      transferDatabase(source, new MockPostgresTarget(store), { instanceBinding }),
      /migration target is not empty/iu
    );
    assert.equal(store.control.transferReceipt, null);
    assert.deepEqual(await databaseDigest(backing), before);
  } finally { source.close(); backing.close(); }
});

test('PostgreSQL sources require an intact completed transfer receipt before transfer or export', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-pg-source-contract-'));
  const nativeSource = new SqliteDatabase(':memory:', { create: true });
  const backing = new SqliteDatabase(':memory:', { create: true });
  const sqliteTarget = new SqliteDatabase(':memory:', { create: true });
  const store = {
    database: backing,
    insertions: 0,
    control: { instanceBinding: null, nativeEnvelope: null, transferReceipt: null },
  };
  try {
    await seedPortableTables(nativeSource);
    await transferDatabase(nativeSource, new MockPostgresTarget(store), {
      instanceBinding,
      portableMountContract,
    });
    const receipt = structuredClone(store.control.transferReceipt);
    const postgresSource = new MockPostgresTarget(store);

    store.control.transferReceipt = null;
    await assert.rejects(transferDatabase(postgresSource, sqliteTarget),
      /no completed database transfer receipt/iu);
    assert.deepEqual(postgresSource.writeLockEvents, ['acquire', 'release'],
      'a failed source verification releases the cross-process writer boundary');
    assert.ok((await databaseDigest(sqliteTarget)).every(table => table.rows === 0));

    store.control.transferReceipt = { ...receipt, targetIdentitySha256: 'f'.repeat(64) };
    const output = path.join(directory, 'tampered.db');
    await assert.rejects(exportSynthetic(postgresSource, output),
      /does not match this database target/iu);
    await assert.rejects(access(output), { code: 'ENOENT' });
  } finally {
    nativeSource.close();
    backing.close();
    sqliteTarget.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('PostgreSQL source transfer captures live sequence high-water inside a short writer boundary', async () => {
  const nativeSource = new SqliteDatabase(':memory:', { create: true });
  const backing = new SqliteDatabase(':memory:', { create: true });
  const sqliteTarget = new SqliteDatabase(':memory:', { create: true });
  const store = {
    database: backing,
    insertions: 0,
    control: { instanceBinding: null, nativeEnvelope: null, transferReceipt: null },
  };
  try {
    seedAllTables(nativeSource);
    await transferDatabase(nativeSource, new MockPostgresTarget(store), { instanceBinding });
    const postgresSource = new MockPostgresTarget(store);
    const log = fixtureRow(nativeModel.tables.find(table => table.name === 'ActivityLogs'));
    delete log.Id;
    const deletedId = (await backing.insert('ActivityLogs', log)).Id;
    assert.equal(deletedId, 201);
    await backing.delete('ActivityLogs', { Id: deletedId });
    // SQLite rolls sequence state back transactionally, so advance the mock
    // explicitly to model PostgreSQL nextval() consumed by an aborted insert.
    backing.database.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?')
      .run(202, 'ActivityLogs');

    const sequenceState = postgresSource.sequenceState.bind(postgresSource);
    postgresSource.sequenceState = async () => {
      assert.equal(postgresSource.inTransaction, true);
      assert.equal(postgresSource.writeLockHeld, true);
      postgresSource.writeLockEvents.push('sequence');
      return sequenceState();
    };
    const rows = postgresSource.rows.bind(postgresSource);
    let firstRead = true;
    postgresSource.rows = async (...args) => {
      if (firstRead) {
        firstRead = false;
        assert.equal(postgresSource.inTransaction, true);
        assert.equal(postgresSource.writeLockHeld, false,
          'the lengthy table copy must not retain the writer boundary');
        postgresSource.writeLockEvents.push('rows');
      }
      return rows(...args);
    };

    const result = await transferDatabase(postgresSource, sqliteTarget);
    assert.deepEqual(postgresSource.writeLockEvents.slice(0, 4),
      ['acquire', 'sequence', 'release', 'rows']);
    assert.equal(BigInt(result.sqliteSequence.find(entry => entry.name === 'ActivityLogs')?.seq), 202n);
    assert.equal(sqliteTarget.insert('ActivityLogs', log).Id, 203);
  } finally {
    nativeSource.close();
    backing.close();
    sqliteTarget.close();
  }
});

test('PostgreSQL native envelopes preserve absent versus explicit zero SQLite sequence state', async () => {
  const baseline = {
    ddl: ['CREATE TABLE "placeholder" ("Id" INTEGER PRIMARY KEY AUTOINCREMENT)'],
    fingerprint: 'a'.repeat(64),
    history: [],
    sqliteSequence: [
      { name: 'ActivityLogs', seq: 0n },
      { name: 'BaseItemImageInfos', seq: 8n },
    ],
  };
  const source = {
    dialect: 'postgres',
    readNativeEnvelope: async () => structuredClone(baseline),
    sequenceState: async () => [
      { name: 'BaseItemImageInfos', seq: 5n },
      { name: 'Chapters', seq: 13n },
    ],
  };

  const envelope = await getNativeEnvelope(source);

  assert.deepEqual(envelope.sqliteSequence, [
    { name: 'ActivityLogs', seq: 0n },
    { name: 'BaseItemImageInfos', seq: 8n },
    { name: 'Chapters', seq: 13n },
  ]);
  assert.equal(envelope.sqliteSequence.some(entry => entry.name === 'ImageInfos'), false,
    'an unused sequence absent from the SQLite baseline must remain absent');
  assert.deepEqual(baseline.sqliteSequence, [
    { name: 'ActivityLogs', seq: 0n },
    { name: 'BaseItemImageInfos', seq: 8n },
  ], 'merging live high-water must not mutate persisted provenance');
});

test('semantically equivalent SQLite DDL is projected to the canonical Jellyfin export envelope', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-canonical-native-envelope-'));
  const sourceFilename = path.join(directory, 'upgraded-source.db');
  const outputFilename = path.join(directory, 'returned.db');
  const canonical = canonicalNativeSqliteSchema();
  const upgradedHistory = pinnedNativeSqliteMigrationHistory.map((row, index) => ({
    ...row,
    ...(index === 0 ? { ProductVersion: '3.1.3' } : {}),
  }));
  const raw = new DatabaseSync(sourceFilename);
  let source;
  let returned;
  try {
    const sourceDdl = canonical.ddl.map(sql => {
      if (sql.startsWith('CREATE TABLE "AccessSchedules" (')) {
        return sql.replace('CREATE TABLE "AccessSchedules" (',
          'CREATE TABLE "AccessSchedules" ( /* semantically equivalent upgraded EF DDL */');
      }
      if (/^CREATE(?: UNIQUE)? INDEX /u.test(sql)) {
        return sql.replace(' INDEX ', ' INDEX IF NOT EXISTS /* equivalent index DDL */ ');
      }
      return sql;
    });
    raw.exec('BEGIN');
    for (const sql of sourceDdl.filter(value => /^CREATE TABLE /u.test(value))) raw.exec(sql);
    for (const sql of sourceDdl.filter(value => !/^CREATE TABLE /u.test(value))) raw.exec(sql);
    const insertHistory = raw.prepare(
      'INSERT INTO "__EFMigrationsHistory" ("MigrationId", "ProductVersion") VALUES (?, ?)');
    for (const row of upgradedHistory) insertHistory.run(row.MigrationId, row.ProductVersion);
    raw.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run('ActivityLogs', 0);
    raw.exec('COMMIT');
    raw.close();

    source = new SqliteDatabase(sourceFilename, { readOnly: true, requireMigrationHistory: true });
    assert.notEqual(source.schema.fingerprint, pinnedNativeSqliteSchemaFingerprint,
      'the source proves compatibility no longer depends on raw sqlite_schema text');
    const envelope = await getNativeEnvelope(source);
    assert.equal(envelope.fingerprint, pinnedNativeSqliteSchemaFingerprint);
    assert.deepEqual(envelope.ddl, canonical.ddl);
    assert.deepEqual(envelope.history.map(row => ({ ...row })), upgradedHistory,
      'historical EF ProductVersion values remain instance data');
    assert.equal(BigInt(envelope.sqliteSequence.find(entry => entry.name === 'ActivityLogs')?.seq), 0n);
    assertPinnedJellyfinEnvelope(envelope);

    await exportCurrentSqlite(source, outputFilename);
    returned = new SqliteDatabase(outputFilename, { readOnly: true, requireMigrationHistory: true });
    assert.equal(returned.schema.fingerprint, pinnedNativeSqliteSchemaFingerprint);
    assert.deepEqual(returned.schema.ddl, canonical.ddl);
    assert.deepEqual(returned.schema.history.map(row => ({ ...row })), upgradedHistory);
    assert.equal(BigInt(returned.schema.sqliteSequence.find(entry => entry.name === 'ActivityLogs')?.seq), 0n);
    assert.equal(returned.schema.sqliteSequence.some(entry => entry.name === 'ApiKeys'), false,
      'an absent unused sequence must not be materialized as seq=0');
    assert.equal(returned.database.prepare('SELECT COUNT(*) AS count FROM "__EFMigrationsLock"').get().count, 0);
    assert.equal(returned.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(returned.database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    returned?.close();
    source?.close();
    try { raw.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite semantic preflight rejects behavior-changing partial-index drift', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const ddl = canonicalNativeSqliteSchema().ddl.map(sql => sql.includes('"IX_BaseItems_PrimaryVersionId"')
      ? sql.replace('"PrimaryVersionId" IS NOT NULL', '"PrimaryVersionId" IS NULL')
      : sql);
    for (const sql of ddl.filter(value => /^CREATE TABLE /u.test(value))) database.exec(sql);
    for (const sql of ddl.filter(value => !/^CREATE TABLE /u.test(value))) database.exec(sql);
    assert.throws(() => preflightSqlite(database), /BaseItems: indices differ from the pinned model/u);
  } finally { database.close(); }
});

test('native envelope validation rejects SQLite side effects before creating any output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-envelope-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const target = path.join(directory, 'target.db');
  const sideEffect = path.join(directory, 'side-effect.db');
  try {
    const envelope = await getNativeEnvelope(source);
    envelope.ddl[0] += `; ATTACH DATABASE '${sideEffect.replaceAll('\\', '/').replaceAll("'", "''")}' AS injected; CREATE TABLE injected.pwn(value)`;
    await assert.rejects(createSqliteTarget(target, envelope), /not authorized/u);
    await assert.rejects(access(target), { code: 'ENOENT' });
    await assert.rejects(access(sideEffect), { code: 'ENOENT' });
  } finally { source.close(); await rm(directory, { recursive: true }); }
});

test('native envelope validation rejects unmodeled SQLite conflict semantics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-envelope-conflict-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const malicious = new DatabaseSync(':memory:');
  const target = path.join(directory, 'target.db');
  try {
    const envelope = await getNativeEnvelope(source);
    const tableIndex = envelope.ddl.findIndex(sql => /^CREATE TABLE /iu.test(sql) && /PRIMARY KEY/iu.test(sql));
    assert.notEqual(tableIndex, -1);
    envelope.ddl[tableIndex] = envelope.ddl[tableIndex].replace(/PRIMARY KEY/iu, 'PRIMARY KEY ON CONFLICT REPLACE');
    for (const sql of envelope.ddl.filter(value => /^CREATE TABLE /iu.test(value))) malicious.exec(sql);
    for (const sql of envelope.ddl.filter(value => !/^CREATE TABLE /iu.test(value))) malicious.exec(sql);
    envelope.fingerprint = inspectSqliteSchema(malicious).fingerprint;

    await assert.rejects(createSqliteTarget(target, envelope), /unsupportedConstraintSemantics differ from the pinned model/u);
    await assert.rejects(access(target), { code: 'ENOENT' });
  } finally {
    malicious.close();
    source.close();
    await rm(directory, { recursive: true });
  }
});

test('native envelope validation cannot hide conflict semantics behind SQLite comments', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-envelope-comment-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const malicious = new DatabaseSync(':memory:');
  const target = path.join(directory, 'target.db');
  try {
    const envelope = await getNativeEnvelope(source);
    const tableIndex = envelope.ddl.findIndex(sql => /^CREATE TABLE /iu.test(sql) && /PRIMARY KEY/iu.test(sql));
    assert.notEqual(tableIndex, -1);
    envelope.ddl[tableIndex] = envelope.ddl[tableIndex].replace(/PRIMARY KEY/iu,
      'PRIMARY/**/KEY ON/**/CONFLICT REPLACE');
    for (const sql of envelope.ddl.filter(value => /^CREATE TABLE /iu.test(value))) malicious.exec(sql);
    for (const sql of envelope.ddl.filter(value => !/^CREATE TABLE /iu.test(value))) malicious.exec(sql);
    envelope.fingerprint = inspectSqliteSchema(malicious).fingerprint;

    await assert.rejects(createSqliteTarget(target, envelope), /unsupportedConstraintSemantics differ from the pinned model/u);
    await assert.rejects(access(target), { code: 'ENOENT' });
  } finally {
    malicious.close();
    source.close();
    await rm(directory, { recursive: true });
  }
});

test('cancellation rolls back target data and leaves source unchanged', async () => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const target = new SqliteDatabase(':memory:', { create: true });
  try {
    seedAllTables(source);
    const before = await databaseDigest(source);
    const controller = new AbortController();
    const originalInsert = target.insert.bind(target);
    target.insert = (...args) => { const result = originalInsert(...args); controller.abort(); return result; };
    await assert.rejects(transferDatabase(source, target, { signal: controller.signal }), /abort/i);
    assert.ok((await databaseDigest(target)).every((table) => table.rows === 0));
    assert.deepEqual(await databaseDigest(source), before);
  } finally { source.close(); target.close(); }
});

test('real PostgreSQL round trip preserves every table, new writes, defaults, sequences and null ordering', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-pg-'));
  const source = new SqliteDatabase(':memory:', { create: true });
  const schema = `test_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let pg;
  let back;
  try {
    seedAllTables(source);
    pg = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    await transferDatabase(source, pg, { instanceBinding });
    assert.deepEqual(await databaseDigest(pg), await databaseDigest(source));
    await pg.update('UserData', { ItemId: fixtureIds.BaseItems, UserId: fixtureIds.Users, CustomDataKey: '' }, { PlaybackPositionTicks: 9007199254740997n, IsFavorite: false });
    await pg.insert('LinkedChildren', { ParentId: fixtureIds.BaseItems, ChildId: fixtureIds.BaseItems, ChildType: 1, SortOrder: 3 });
    const log = fixtureRow(nativeModel.tables.find((table) => table.name === 'ActivityLogs'));
    delete log.Id;
    const deletedId = (await pg.insert('ActivityLogs', log)).Id;
    assert.equal(deletedId, 201);
    await pg.delete('ActivityLogs', { Id: deletedId });
    await assert.rejects(pg.transaction(async transaction => {
      assert.equal((await transaction.insert('ActivityLogs', log)).Id, 202);
      throw new Error('rollback generated identity');
    }), /rollback generated identity/u);
    await pg.update('Users', { Id: fixtureIds.Users }, { Username: 'Chinese 中文 user' }, { rowVersion: 4294967295n });
    assert.equal((await pg.rows('Users'))[0].RowVersion, 0n);
    await exportSynthetic(pg, path.join(directory, 'return.db'));
    back = new SqliteDatabase(path.join(directory, 'return.db'));
    assert.deepEqual(await databaseDigest(back), await databaseDigest(pg));
    assert.equal(back.rows('LinkedChildren').length, 3);
    assert.equal(back.insert('ActivityLogs', log).Id, 203);
    const orderBy = [{ column: 'LastPlayedDate', direction: 'ASC' }, { column: 'CustomDataKey', direction: 'ASC' }];
    assert.deepEqual(await pg.rows('UserData', { orderBy }), back.rows('UserData', { orderBy }));
    await pg.client.query('CREATE TABLE "UnknownShape" (id integer)');
    await assert.rejects(pg.preflight(), /schema differs/);
  } finally {
    back?.close(); source.close();
    if (pg) { await pg.client.query(`DROP SCHEMA ${q(schema)} CASCADE`); await pg.client.query(`DROP SCHEMA ${q(`${schema}__mm`)} CASCADE`); await pg.close(); }
    await rm(directory, { recursive: true });
  }
});

test('real PostgreSQL import issues one set-based INSERT per bounded batch', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const schema = `batch_insert_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let pg;
  try {
    const activityTable = nativeModel.tables.find(table => table.name === 'ActivityLogs');
    const log = fixtureRow(activityTable);
    delete log.Id;
    for (let index = 0; index < 1_001; index += 1) {
      source.insert('ActivityLogs', { ...log, Name: `batch-${index}` });
    }
    pg = await PostgresDatabase.open({
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      schema,
      create: true,
    });
    const inserts = [];
    pg.queryHook = async (...args) => {
      const result = await pg.client.query(...args);
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      if (/^INSERT INTO "ActivityLogs"/u.test(text)) inserts.push({ text, values: args[1] });
      return result;
    };

    await transferDatabase(source, pg, { batchSize: 200, instanceBinding });

    assert.equal(inserts.length, 8);
    assert.deepEqual(inserts.map(entry => entry.values.length / activityTable.columns.length),
      [...Array(7).fill(128), 105]);
    assert.equal((await pg.rows('ActivityLogs')).length, 1_001);
  } finally {
    source.close();
    if (pg) {
      pg.queryHook = null;
      try { await pg.client.query(`DROP SCHEMA ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`); }
      finally { await pg.close(); }
    }
  }
});

test('real PostgreSQL export fences writers through snapshot and sequence capture only', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-pg-export-fence-'));
  const nativeSource = new SqliteDatabase(':memory:', { create: true });
  const schema = `export_fence_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const output = path.join(directory, 'snapshot.db');
  let pg;
  let store;
  let exported;
  let heldWriter;
  let exportOperation;
  let releaseHeldWriter = () => {};
  let releaseSourceScan = () => {};
  let restoreQueryHook;
  const bounded = (operation, label, timeout = 5_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeout);
    Promise.resolve(operation).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
  try {
    seedAllTables(nativeSource);
    pg = await PostgresDatabase.open({
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      schema,
      create: true,
      max: 4,
    });
    await transferDatabase(nativeSource, pg, { instanceBinding });
    store = new DomainStore(pg);
    const baseLog = fixtureRow(nativeModel.tables.find(table => table.name === 'ActivityLogs'));
    delete baseLog.Id;

    let writerReady;
    const writerEntered = new Promise(resolve => { writerReady = resolve; });
    const heldWriterGate = new Promise(resolve => { releaseHeldWriter = resolve; });
    heldWriter = store.serializeWrites(async () => {
      await store.transaction(async database => {
        const inserted = await database.insert('ActivityLogs', { ...baseLog, Name: 'before snapshot' });
        assert.equal(inserted.Id, 201);
      });
      writerReady();
      await heldWriterGate;
    });
    await bounded(writerEntered, 'the pre-snapshot writer');

    let waitingForWriter;
    const exportWaited = new Promise(resolve => { waitingForWriter = resolve; });
    let sourceScanEntered;
    const sourceScan = new Promise(resolve => { sourceScanEntered = resolve; });
    const sourceScanGate = new Promise(resolve => { releaseSourceScan = resolve; });
    const dispatchQuery = pg.client.query;
    restoreQueryHook = () => { pg.client.query = dispatchQuery; };
    let scanPaused = false;
    pg.client.query = async (...args) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      if (!scanPaused && /^SELECT .* FROM "AccessSchedules"/su.test(text)) {
        scanPaused = true;
        sourceScanEntered();
        await sourceScanGate;
      }
      const result = await dispatchQuery(...args);
      if (text.startsWith('SELECT pg_try_advisory_lock') && result.rows[0]?.locked === false) {
        waitingForWriter();
      }
      return result;
    };

    exportOperation = exportSynthetic(pg, output);
    await bounded(exportWaited, 'the export writer fence');
    releaseHeldWriter();
    await bounded(heldWriter, 'the pre-snapshot writer release');
    await bounded(sourceScan, 'the post-boundary source scan');

    const postBoundary = await store.transaction(database => database.insert('ActivityLogs', {
      ...baseLog,
      Name: 'after snapshot',
    }));
    assert.equal(postBoundary.Id, 202,
      'a new runtime writer proceeds after the export captures its sequence boundary');
    releaseSourceScan();
    const result = await bounded(exportOperation, 'the PostgreSQL export', 15_000);
    restoreQueryHook();
    restoreQueryHook = undefined;

    exported = new SqliteDatabase(output);
    const exportedIds = (await exported.rows('ActivityLogs')).map(row => row.Id);
    assert.ok(exportedIds.includes(201));
    assert.ok(!exportedIds.includes(202), 'the later writer is outside the fixed repeatable-read snapshot');
    assert.equal(BigInt(result.sqliteSequence.find(entry => entry.name === 'ActivityLogs')?.seq), 201n);
    assert.equal(exported.insert('ActivityLogs', { ...baseLog, Name: 'continued by Jellyfin' }).Id, 202);
  } finally {
    releaseHeldWriter();
    releaseSourceScan();
    restoreQueryHook?.();
    await Promise.allSettled([heldWriter, exportOperation].filter(Boolean));
    exported?.close();
    nativeSource.close();
    if (pg && !pg.closed) {
      try { await pg.client.query(`DROP SCHEMA ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`); }
      finally { if (store) await store.close(); else await pg.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('real PostgreSQL transfers persist, validate and preserve canonical instance origin binding', { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async () => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const firstSchema = `binding_a_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const secondSchema = `binding_b_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let first;
  let second;
  try {
    await seedPortableTables(source);
    const { itemImageId, streamKey } = await seedNativeAllowedPaths(source);
    const sourceTables = await databaseDigest(source);
    first = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema: firstSchema, create: true });
    second = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema: secondSchema, create: true });
    await transferDatabase(source, first, { instanceBinding, portableMountContract });
    assert.equal(await first.getState('instanceBinding'), JSON.stringify(instanceBinding));
    assert.deepEqual(await first.readInstanceBinding(), instanceBinding);
    assert.deepEqual(await first.validateInstanceBinding(instanceBinding), instanceBinding);
    await assert.rejects(first.validateInstanceBinding({ ...instanceBinding, serverId: 'f'.repeat(32) }), /differs/);
    assert.deepEqual((await first.readTransferReceipt()).sourceTables, sourceTables);
    assert.equal((await first.rows('BaseItems', { where: { Id: fixtureIds.BaseItems } }))[0].Path,
      nativeAllowedPaths.item);
    assert.equal((await first.rows('BaseItemImageInfos', { where: { Id: itemImageId } }))[0].Path,
      nativeAllowedPaths.internalImage);
    assert.equal((await first.rows('BaseItemImageInfos', { where: { Id: nativeRemoteImageId } }))[0].Path,
      nativeAllowedPaths.remoteImage);
    assert.equal((await first.rows('MediaStreamInfos', { where: streamKey }))[0].Path,
      nativeAllowedPaths.internalStream);
    await first.close();
    first = null;
    first = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema: firstSchema });
    assert.deepEqual(await first.readInstanceBinding(), instanceBinding);
    await assert.rejects(transferDatabase(first, second, { instanceBinding }), /cannot be overridden/);
    assert.ok((await databaseDigest(second)).every((table) => table.rows === 0));
    const log = fixtureRow(nativeModel.tables.find(table => table.name === 'ActivityLogs'));
    delete log.Id;
    await assert.rejects(first.transaction(async transaction => {
      assert.equal((await transaction.insert('ActivityLogs', log)).Id, 201);
      throw new Error('rollback generated identity');
    }), /rollback generated identity/u);
    const deletedId = (await first.insert('ActivityLogs', log)).Id;
    assert.equal(deletedId, 202);
    await first.delete('ActivityLogs', { Id: deletedId });
    await transferDatabase(first, second);
    assert.deepEqual(await second.readInstanceBinding(), instanceBinding);
    assert.equal(await second.getState('portableVfsMountContract'), JSON.stringify(portableMountContract));
    assert.deepEqual(await databaseDigest(second), await databaseDigest(first));
    assert.equal((await second.insert('ActivityLogs', log)).Id, 203);
  } finally {
    source.close();
    for (const [database, schema] of [[second, secondSchema], [first, firstSchema]]) if (database) {
      try { await database.client.query(`DROP SCHEMA ${q(schema)}, ${q(`${schema}__mm`)} CASCADE`); }
      finally { await database.close(); }
    }
  }
});

test('runtime Jellyfin SQLite schema and real migration history round trip', { skip: !process.env.MEDIAMANAGER_TEST_NATIVE_SQLITE }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-native-'));
  const source = new SqliteDatabase(process.env.MEDIAMANAGER_TEST_NATIVE_SQLITE, { readOnly: true, requireMigrationHistory: true });
  let target;
  try {
    await exportCurrentSqlite(source, path.join(directory, 'native.db'));
    target = new SqliteDatabase(path.join(directory, 'native.db'), { requireMigrationHistory: true });
    assert.deepEqual(target.schema.history, source.schema.history);
    assert.equal(target.schema.fingerprint, pinnedNativeSqliteSchemaFingerprint);
    assert.deepEqual(target.schema.ddl, canonicalNativeSqliteSchema().ddl);
    assert.deepEqual(await databaseDigest(target), await databaseDigest(source));
  } finally { target?.close(); source.close(); await rm(directory, { recursive: true }); }
});
