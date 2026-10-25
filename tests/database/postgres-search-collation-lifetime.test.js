import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { serializeNfo } from '../../plugins/nfo/saver.js';
import { XmlError } from '../../src/core/xml.js';
import { resolvePostgresSearchCollation, releasePostgresSearchCollation } from '../../src/library/postgres-search-provider.js';
import { createPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from './postgres-fixture.js';

const options = { skip: !postgresTestConnectionString };
const collationNames = async (database, names) => (await database.client.query(
  'SELECT collname FROM pg_catalog.pg_collation WHERE collname=ANY($1::text[]) ORDER BY collname', [names])).rows.map(row => row.collname);

async function fixture(t, { max = 1 } = {}) {
  const database = await createPostgresTestDatabase(null, 'coll_scope', { max });
  let runtime;
  const storage = new StorageRegistry();
  storage.registerType('memory', () => new MemoryStorageAdapter());
  const directory = await mkdtemp(path.join(os.tmpdir(), 'search-collation-lifetime-'));
  t.after(async () => {
    const errors = [], attempt = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
    await attempt(() => runtime?.close()); await attempt(() => storage.close()); await attempt(() => database.close());
    const cleanup = new pg.Client({ connectionString: postgresTestConnectionString });
    await attempt(async () => {
      assert.match(database.schemaName, /^coll_scope_[a-f0-9]{20}$/u);
      await cleanup.connect();
      await cleanup.query(`DROP SCHEMA IF EXISTS ${q(database.schemaName)}, ${q(database.controlSchema)} CASCADE`);
    });
    await attempt(() => cleanup.end());
    await attempt(async () => {
      assert.equal(path.dirname(directory), os.tmpdir());
      assert.ok(path.basename(directory).startsWith('search-collation-lifetime-'));
      await rm(directory, { recursive: true, force: true });
    });
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Search collation fixture cleanup failed.');
  });
  await storage.createInstance('collation-media', 'memory', {});
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/media', instanceId: 'collation-media', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\CollationScope', accessRoot: '/media', style: 'windows',
    returnAccess: 'Isolated metadata paths for the collation lifecycle fixture.' });
  return { database, directory, vfs, identityMap, setRuntime: value => { runtime = value; } };
}

test('postgres: public search and real NFO member sorting release temporary collations before runtime close and cold reopen', options, async t => {
  const { database, directory, setRuntime, vfs, identityMap } = await fixture(t);
  const observedErrors = [], names = [];
  const runtime = await createRuntime({ database, vfs, identityMap, programDataPath: directory,
    configuration: { UICulture: 'en-US' }, serverId: 'owned-search-collation', onError: error => observedErrors.push(error) });
  setRuntime(runtime);
  const root = (await database.rows('BaseItems')).find(row => row.Type.endsWith('.AggregateFolder'));
  const album = '92000000-0000-0000-0000-000000000001', track = '92000000-0000-0000-0000-000000000002';
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: album, ParentId: root.Id,
    Type: 'MediaBrowser.Controller.Entities.Audio.MusicAlbum', IsFolder: true,
    Name: 'Needle album', CleanName: 'needle album', SortName: 'needle album', Data: '{}' }));
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: track, ParentId: album,
    Type: 'MediaBrowser.Controller.Entities.Audio.Audio', IsFolder: false,
    Name: 'Needle track', CleanName: 'needle track', SortName: 'needle track', IndexNumber: 1, Data: '{}' }));
  database.queryHook = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    const name = /^CREATE COLLATION "pg_temp"\."(mm_search_[a-f0-9]+)"/u.exec(text)?.[1];
    if (name) names.push(name);
    return database.client.query(...args);
  };
  try {
    const result = await runtime.library.queryItems({ SearchTerm: 'Needle', IncludeItemTypes: 'MusicAlbum', EnableImages: false });
    assert.equal(result.Items.length, 1); assert.equal(result.Items[0].Id, album.replaceAll('-', ''));
    const loaded = await runtime.metadata.loadContext({ Id: album }, { saverContext: true });
    try {
      const prepared = await serializeNfo(loaded.item, {fileSystem:testFileSystem,...loaded.context});
      try {
        const chunks = []; for await (const chunk of prepared.stream()) chunks.push(chunk);
        const xml = Buffer.concat(chunks).toString('utf8');
        assert.match(xml, /<track>/u); assert.match(xml, /Needle track/u);
      } finally { await prepared.close(); }
    } finally { await loaded.dispose(); }
  } finally { database.queryHook = null; }
  assert.ok(names.length >= 2, 'the actual public search and NFO writer both allocated a collation');
  assert.deepEqual(await collationNames(database, names), []);
  assert.deepEqual(observedErrors, []);
  await database.preflight();
  await runtime.close();
  const reopened = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName });
  try { await reopened.preflight(); assert.deepEqual(await collationNames(reopened, names), []); }
  finally { await reopened.close(); }
});

test('postgres: parallel temporary collation owners on one physical session dispose independently', options, async t => {
  const { database } = await fixture(t);
  await assert.rejects(resolvePostgresSearchCollation(database, 'en-US'), /active owned operation session/u);
  await database.withConnection(async session => {
    const scopes = await Promise.all(Array.from({ length: 4 }, () => resolvePostgresSearchCollation(session, 'en-US')));
    const names = scopes.map(scope => scope.name);
    try {
      assert.equal(new Set(names).size, 4);
      await scopes[0].release();
      assert.deepEqual(await collationNames(session, names), names.slice(1).sort());
    } finally { for (const scope of scopes) await scope.release(); }
    assert.deepEqual(await collationNames(session, names), []);
  });
  await database.preflight();
});

test('postgres: an incorrect temporary collation definition is rejected and removed', options, async t => {
  const { database } = await fixture(t);
  const names = [];
  database.queryHook = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    const name = /^CREATE COLLATION "pg_temp"\."(mm_search_[a-f0-9]+)"/u.exec(text)?.[1];
    if (name) {
      names.push(name);
      const rewritten = { ...args[0], text: text.replace('deterministic = false', 'deterministic = true') };
      return database.client.query(rewritten);
    }
    return database.client.query(...args);
  };
  try { await assert.rejects(database.withConnection(session => resolvePostgresSearchCollation(session, 'en-US')),
    /differs from its controlled definition/u); }
  finally { database.queryHook = null; }
  assert.equal(names.length, 1); assert.deepEqual(await collationNames(database, names), []);
  await database.preflight();
});

test('postgres: an aborted query preserves its primary error and transaction rollback removes its temporary collation', options, async t => {
  const { database } = await fixture(t);
  let name;
  await assert.rejects(database.transaction(async session => {
    const scope = await resolvePostgresSearchCollation(session, 'en-US'); name = scope.name;
    let primary;
    try { await session.client.query('SELECT * FROM pg_temp.mm_missing_search_relation'); }
    catch (error) { primary = error; throw error; }
    finally { await releasePostgresSearchCollation(scope, primary); }
  }), error => error.code === '42P01');
  assert.ok(name); assert.deepEqual(await collationNames(database, [name]), []);
  await database.preflight();
});

test('postgres: cleanup failure preserves the query error and discards only its owned pooled backend', options, async t => {
  const { database } = await fixture(t);
  const primary = new Error('Injected final query failure'), cleanup = new Error('Injected collation cleanup failure');
  let name;
  database.queryHook = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    if (text.startsWith('DROP COLLATION IF EXISTS "pg_temp"')) throw cleanup;
    return database.client.query(...args);
  };
  try { await assert.rejects(database.withConnection(async session => {
    const scope = await resolvePostgresSearchCollation(session, 'en-US'); name = scope.name;
    try { throw primary; } finally { await releasePostgresSearchCollation(scope, primary); }
  }), error => error instanceof AggregateError && error.cause === primary
    && error.errors[0] === primary && error.errors[1] === cleanup); }
  finally { database.queryHook = null; }
  assert.ok(name); assert.deepEqual(await collationNames(database, [name]), []);
  await database.preflight();
});

test('postgres: failed collation cleanup disconnects its backend while a sibling temporary collation stays usable', options, async t => {
  const { database } = await fixture(t, { max: 2 });
  const primary = new Error('Injected owned search failure'), cleanup = new Error('Injected owned search cleanup failure');
  await database.withConnection(async sibling => {
    const retained = await resolvePostgresSearchCollation(sibling, 'en-US');
    let discarded;
    try {
      database.queryHook = async (...args) => {
        const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
        if (text.startsWith('DROP COLLATION IF EXISTS "pg_temp"')) throw cleanup;
        return database.client.query(...args);
      };
      try {
        await assert.rejects(database.runDetached(() => database.withConnection(async session => {
          const scope = await resolvePostgresSearchCollation(session, 'en-US'); discarded = scope.name;
          try { throw primary; } finally { await releasePostgresSearchCollation(scope, primary); }
        })), error => error instanceof AggregateError && error.cause === primary
          && error.errors[0] === primary && error.errors[1] === cleanup);
      } finally { database.queryHook = null; }
      assert.ok(discarded); assert.deepEqual(await collationNames(sibling, [discarded]), []);
      assert.deepEqual(await collationNames(sibling, [retained.name]), [retained.name]);
      const result = await sibling.client.query(`SELECT 'a' COLLATE "pg_temp".${q(retained.name)} = 'a' AS usable`);
      assert.equal(result.rows[0].usable, true);
    } finally { database.queryHook = null; await retained.release(); }
  });
  await database.preflight();
});

test('postgres: an unknown base collation still fails preflight and cold open', options, async t => {
  const { database } = await fixture(t), schema = database.schemaName;
  await database.client.query(`CREATE COLLATION ${q(schema)}.${q('mm_search_unregistered')} FROM pg_catalog."en-US-x-icu"`);
  await assert.rejects(database.preflight(), /schema differs from its verified creation state/u);
  await database.close();
  await assert.rejects(PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }),
    /schema differs from its verified creation state/u);
});

async function nfoFailureFixture(t) {
  const value = await fixture(t), { database, directory, setRuntime, vfs, identityMap } = value;
  const runtime = await createRuntime({ database, vfs, identityMap, programDataPath: directory,
    configuration: { UICulture: 'en-US' }, serverId: 'nfo-collation-error-prefix' });
  setRuntime(runtime);
  const root = (await database.rows('BaseItems')).find(row => row.Type.endsWith('.AggregateFolder'));
  const album = '93000000-0000-0000-0000-000000000001', track = '93000000-0000-0000-0000-000000000002';
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: album, ParentId: root.Id,
    Type: 'MediaBrowser.Controller.Entities.Audio.MusicAlbum', IsFolder: true,
    Name: 'NFO error album', CleanName: 'nfo error album', SortName: 'nfo error album', Data: '{}' }));
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: track, ParentId: album,
    Type: 'MediaBrowser.Controller.Entities.Audio.Audio', IsFolder: false,
    Name: 'Invalid\u0000track', CleanName: 'invalid track', SortName: 'invalid track', IndexNumber: 1, Data: '{}' }));
  return { ...value, runtime, album };
}

test('postgres: real NFO callback failure retains its XML primary through collation discard and projection cleanup', options, async t => {
  const { database, runtime, album } = await nfoFailureFixture(t);
  const cleanupError = new Error('Injected NFO collation cleanup failure'), names = [];
  let projectionDropAfterDiscard = false;
  database.queryHook = async (...args) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    const name = /^CREATE COLLATION "pg_temp"\."(mm_search_[a-f0-9]+)"/u.exec(text)?.[1];
    if (name) names.push(name);
    if (text.startsWith('DROP COLLATION IF EXISTS "pg_temp"')) throw cleanupError;
    if (text.startsWith('DROP TABLE') && text.includes('mm_metadata_projection_')) projectionDropAfterDiscard = true;
    return database.client.query(...args);
  };
  const loaded = await runtime.metadata.loadContext({ Id: album }, { saverContext: true });
  try {
    await assert.rejects(serializeNfo(loaded.item, {fileSystem:testFileSystem,...loaded.context}), error =>
      error instanceof AggregateError && error.cause instanceof XmlError
      && error.errors[0] === error.cause && error.errors[1] === cleanupError);
  } finally { database.queryHook = null; await loaded.dispose(); }
  assert.equal(projectionDropAfterDiscard, false);
  assert.equal(names.length, 1); assert.deepEqual(await collationNames(database, names), []);
  await database.preflight();
});

test('postgres: a real metadata projection preserves the original SQL failure through owning transaction rollback', options, async t => {
  const { database, runtime, album } = await nfoFailureFixture(t);
  const loaded = await runtime.metadata.loadContext({ Id: album }, { saverContext: true });
  const sequence = await loaded.context.tracks();
  try {
    await assert.rejects(runtime.store.transaction(() => sequence.aggregationSession(async session => {
      await session.client.query('SELECT * FROM pg_temp.mm_missing_nfo_projection_relation');
    })), error => error.code === '42P01');
  } finally { await sequence.close(); await loaded.dispose(); }
  await database.preflight();
});

test('postgres: real NFO callback failure remains primary when the sequence closes after releasing its actual cohort', options, async t => {
  const { database, runtime, album } = await nfoFailureFixture(t);
  const loaded = await runtime.metadata.loadContext({ Id: album }, { saverContext: true });
  const closeError = new Error('Injected failure after actual NFO cohort release');
  const tracks = loaded.context.tracks;
  const context = { ...loaded.context, tracks: async () => {
    const sequence = await tracks();
    return { ...sequence, close: async () => { await sequence.close(); throw closeError; } };
  } };
  try { await assert.rejects(serializeNfo(loaded.item, {fileSystem:testFileSystem,...context}), error =>
    error instanceof AggregateError && error.cause instanceof XmlError
    && error.errors[0] === error.cause && error.errors[1] === closeError); }
  finally { await loaded.dispose(); }
  await database.preflight();
});
