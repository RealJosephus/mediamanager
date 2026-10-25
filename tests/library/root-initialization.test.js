import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { initializeLibraryRoot } from '../../src/library/root-initialization.js';
import { idKey, dateText } from '../../src/library/records.js';
import { nativeDateFromUnixNanoseconds } from '../../src/users/native.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { expandStatePath } from './fixture-state-path.js';

const bytes = await readFile(new URL('./fixtures/root-initialization/native.json', import.meta.url));
const provenance = JSON.parse(await readFile(new URL('./fixtures/root-initialization/provenance.json', import.meta.url)));
assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.nativeSha256);
assert.equal(bytes.length, provenance.nativeBytes);
const fixture = JSON.parse(bytes);
assert.deepEqual(fixture.scenarios.map(row => row.mode), ['existing', 'missing', 'wrongParent', 'missingAggregate']);
for (const scenario of fixture.scenarios) {
  assert.equal(scenario.summary.passed, true); assert.equal(scenario.summary.cases, 24);
  assert.equal(scenario.summary.dllSha256, '31236d2a520e52ab2130742515a552980b0edbde4cfe8da124c0a0cd87c9046c');
  assert.deepEqual(scenario.summary.processResult, { code: 0, signal: null });
  assert.equal(scenario.summary.portAvailable, true);
  assert.equal(Object.keys(scenario.before.database.tables).length, 13);
}
const rootId = 'F27CAA37-E514-2225-CCED-ED48F6553502', playlistId = '1071671E-7BFF-A053-2E93-0DEBEE501D2E';
const columns = table => tableDefinition(table).columns.filter(column => !column.generated);
const adapt = (table, row) => Object.fromEntries(columns(table).map(column => {
  const value = row[column.name], type = column.clrType.replace('?', '');
  return [column.name, value == null ? column.nullable ? null : type === 'bool' ? false : column.type === 'TEXT' ? '' : 0
    : type === 'bool' ? Boolean(value) : ['long', 'uint'].includes(type) ? BigInt(value) : value];
}));
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry);
const sortedObject = value => Array.isArray(value) ? value.map(sortedObject) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sortedObject(entry)])) : value;
const canonical = (table, rows) => rows.map(row => sortedObject(Object.fromEntries(columns(table).map(column => {
  const type = column.clrType.replace('?', ''), value = row[column.name];
  return [column.name, value == null ? null : type === 'Guid' ? idKey(value) : type === 'bool' ? Boolean(value)
    : ['long', 'uint'].includes(type) ? String(value) : column.name === 'Data' ? sortedObject(JSON.parse(value)) : value];
})))).sort((a, b) => json(a).localeCompare(json(b)));
const readTables = async (db, names) => {
  const result = {};
  for (const name of names) result[name] = await db.rows(name);
  return result;
};
async function seed(db, tables) {
  await db.transaction(async transaction => {
    await transaction.client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const [table, rows] of Object.entries(tables)) for (const row of rows) await transaction.insert(table, adapt(table, row));
  });
}
function relocation(referenceRoot, runtimeRoot) {
  const relocatePath = value => {
    let result = expandStatePath(value, referenceRoot, runtimeRoot);
    for (const token of ['%AppDataPath%', '%MetadataPath%']) result = expandStatePath(result, token, token);
    return result;
  };
  const rewrite = (value, field) => typeof value === 'string'
    ? field === 'Data' ? value.replace(/"(?:\\.|[^"\\])*"/gu, token => {
      const original = JSON.parse(token), relocated = relocatePath(original);
      return original === relocated ? token : JSON.stringify(relocated);
    }) : relocatePath(value)
    : Array.isArray(value) ? value.map(entry => rewrite(entry))
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry, key)])) : value;
  return rewrite;
}
async function cleanupSchemas(names) {
  const client = new pg.Client({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES }); await client.connect();
  try {
    for (const name of names) await client.query('DROP SCHEMA ' + quoteIdentifier(name) + ' CASCADE');
    assert.equal((await client.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])', [names])).rows.length, 0);
  } finally { await client.end(); }
}
async function removeTemporary(directory) {
  assert.equal(path.dirname(directory), tmpdir());
  await rm(directory, { recursive: true, force: true });
}

for (const dialect of ['postgres']) test(`${dialect}: actual runtime initializes four native root controls before first query across 13 tables`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const records = [];
  for (const scenario of fixture.scenarios) {
    const schema = `root_start_${process.pid}_${randomBytes(4).toString('hex')}`;
    const db = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'mm-root-start-')), programDataPath = path.join(runtimeRoot, 'data');
    const rewrite = relocation(scenario.referenceRoot, runtimeRoot), names = Object.keys(scenario.before.database.tables);
    let runtime, closed = false;
    const record = { mode: scenario.mode, schema, before: null, afterRuntime: null, afterRepeatedInitialization: null,
      afterShutdown: null, cleanup: { databaseClosed: false, schemasRemoved: false, temporaryRemoved: false } };
    const closeDatabase = db.close.bind(db);
    db.close = async () => { await closeDatabase(); closed = true; record.cleanup.databaseClosed = true; };
    try {
      const domains = { userViews: 'data/root/default', metadata: 'data/metadata', libraries: 'library-content',
        collections: 'data/data/collections', playlists: 'data/data/playlists' };
      for (const [name, relative] of Object.entries(domains)) {
        const domain = scenario.before.filesystem[name];
        if (domain.exists) await mkdir(path.join(runtimeRoot, relative), { recursive: true });
        for (const entry of domain.entries) {
          assert.equal(entry.type, 'directory', 'Any recorded input file requires its real payload.');
          await mkdir(path.join(runtimeRoot, relative, entry.path), { recursive: true });
        }
      }
      await seed(db, rewrite(scenario.before.database.tables));
      record.before = await readTables(db, names);
      const start = Date.now();
      runtime = await createTestRuntime({ database: db, configuration: { UICulture: 'en-US' }, serverId: 'native-root-start', programDataPath });
      const end = Date.now(); record.afterRuntime = await readTables(db, names);
      record.runtimeCreatedBeforeFirstQuery = true; record.libraryOptionsOverrideProvided = false;
      const root = record.afterRuntime.BaseItems.find(row => row.Id === rootId);
      const playlists = record.afterRuntime.BaseItems.find(row => row.Id === playlistId);
      assert.ok(root); assert.ok(playlists); assert.equal(playlists.ParentId, rootId);
      const expected = rewrite(scenario.ready.database.tables), actual = structuredClone(record.afterRuntime);
      if (scenario.mode === 'existing') assert.deepEqual(record.afterRuntime, record.before, 'Correct existing native rows must not be rewritten.');
      else {
        const expectedRoot = expected.BaseItems.find(row => row.Id === rootId), expectedPlaylist = expected.BaseItems.find(row => row.Id === playlistId);
        for (const [row, reference] of [[root, expectedRoot], [playlists, expectedPlaylist]]) {
          const timestamp = Date.parse(dateText(row.DateLastSaved)); assert.ok(timestamp >= start && timestamp <= end);
          reference.DateLastSaved = row.DateLastSaved;
        }
        assert.ok(Date.parse(dateText(root.DateLastSaved)) <= Date.parse(dateText(playlists.DateLastSaved)));
        const rootData = JSON.parse(root.Data), expectedData = JSON.parse(expectedRoot.Data);
        assert.equal(rootData.DateLastSaved, dateText(root.DateLastSaved)); expectedData.DateLastSaved = rootData.DateLastSaved;
        expectedRoot.Data = JSON.stringify(expectedData);
        if (scenario.mode === 'missingAggregate') {
          const created = Date.parse(dateText(root.DateCreated)); assert.ok(created >= start && created <= end);
          expectedRoot.DateCreated = root.DateCreated;
        }
        if (scenario.mode !== 'wrongParent') {
          const directory = await stat(path.join(programDataPath, 'data', 'playlists'), { bigint: true });
          assert.equal(playlists.DateCreated, nativeDateFromUnixNanoseconds(directory.birthtimeNs));
          assert.equal(playlists.DateModified, nativeDateFromUnixNanoseconds(directory.mtimeNs));
          expectedPlaylist.DateCreated = playlists.DateCreated; expectedPlaylist.DateModified = playlists.DateModified;
        }
      }
      for (const table of names) assert.deepEqual(canonical(table, actual[table]), canonical(table, expected[table]), `${scenario.mode}: complete ${table} non-generated fields match native.`);
      const writes = [], original = db.upsert.bind(db); db.upsert = async (table, row, ...args) => { writes.push({ table, id: row.Id }); return original(table, row, ...args); };
      await initializeLibraryRoot({fileSystem: testFileSystem,  store: runtime.store, programDataPath, configuration: runtime.configuration });
      record.afterRepeatedInitialization = await readTables(db, names);
      assert.deepEqual(writes, [], 'A second initialization does not save correct existing folders.');
      assert.deepEqual(record.afterRepeatedInitialization, record.afterRuntime);
      const closeStore = runtime.store.close.bind(runtime.store);
      runtime.store.close = async () => { record.afterShutdown = await readTables(db, names); return closeStore(); };
      await runtime.close(); closed = true; record.cleanup.databaseClosed = true;
      assert.deepEqual(record.afterShutdown, record.afterRuntime);
      await assert.rejects(db.client.query('SELECT 1'), /closed/i);
      record.targetTables = 13; record.tableDifferences = []; records.push(record);
    } finally {
      if (!closed) { if (runtime) await runtime.close(); else await db.close(); }
      await cleanupSchemas([db.schemaName, db.controlSchema]); record.cleanup.schemasRemoved = true;
      await removeTemporary(runtimeRoot); record.cleanup.temporaryRemoved = true;
      if (process.env.MEDIAMANAGER_ROOT_START_ARTIFACT_DIR) {
        const directory = path.resolve(process.env.MEDIAMANAGER_ROOT_START_ARTIFACT_DIR); await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, dialect + '-' + scenario.mode + '.json'), JSON.stringify({ phaseAcceptance: false, dialect, record,
          boundary: 'Actual createRuntime before first public query. All non-generated fields in 13 target tables; generated surrogate identities are excluded because native sequence state is not recorded. Paths are relocated, filesystem timestamps are checked against real candidate stat, saves against runtime bounds/order, and Data.DateLastSaved against its column. The raw native timestamps/identity columns remain in fixture. HTTP binding/authentication are not invoked.' }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
      }
    }
  }
  assert.equal(records.length, 4);
});

test('root initialization keeps the first native save committed if the second save fails',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'root_save_failure'), store = new DomainStore(db);
  const directory = await mkdtemp(path.join(tmpdir(), 'mm-root-failure-'));
  try {
    const original = db.upsert.bind(db), calls = [], committed = [];
    db.upsert = async (table, row, ...args) => { calls.push(row.Id); if (row.Id === playlistId) throw new Error('second repository save failed'); return original(table, row, ...args); };
    await assert.rejects(initializeLibraryRoot({fileSystem: testFileSystem, store, programDataPath: directory,
      onCommitted: value => committed.push(value) }), /second repository save failed/);
    assert.deepEqual(calls, [rootId, playlistId]);
    assert.equal((await db.rows('BaseItems', { where: { Id: rootId } })).length, 1);
    assert.equal((await db.rows('BaseItems', { where: { Id: playlistId } })).length, 0);
    assert.equal(committed.length, 1);
    assert.deepEqual(committed[0].aggregateFolder.Studios, [],
      'The first independently committed fresh identity is published before the second save starts.');
    assert.equal(committed[0].playlistsFolder, null);

    db.upsert = original;
    const retry = await initializeLibraryRoot({ fileSystem: testFileSystem, store, programDataPath: directory,
      onCommitted: value => committed.push(value) });
    assert.deepEqual(retry.aggregateFolder.Studios, [''],
      'The retry publishes the committed cold frame without relabeling it as freshly constructed.');
    assert.equal(retry.freshAggregateFolder, false);
    assert.deepEqual(retry.playlistsFolder.Studios, []);
    assert.equal(committed.length, 3, 'The retry publishes its root repair and new playlists commits independently.');
    assert.equal(committed[1].freshAggregateFolder, false);
    assert.equal(committed[2].freshPlaylistsFolder, true);
  } finally { await store.close(); await removeTemporary(directory); }
});

for (const obstruction of ['data junction', 'root junction', 'playlist file']) test(`runtime rejects ${obstruction} before repository writes and closes its database`,
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'root_obstruction');
  const directory = await mkdtemp(path.join(tmpdir(), 'mm-root-obstruction-')), outside = await mkdtemp(path.join(tmpdir(), 'mm-root-outside-'));
  let saved = 0, closeCalls = 0; const upsert = db.upsert.bind(db), close = db.close.bind(db);
  db.upsert = (...args) => { saved++; return upsert(...args); }; db.close = (...args) => { closeCalls++; return close(...args); };
  try {
    if (obstruction.endsWith('junction')) await symlink(outside, path.join(directory, obstruction.split(' ')[0]), process.platform === 'win32' ? 'junction' : 'dir');
    else { await mkdir(path.join(directory, 'data')); await writeFile(path.join(directory, 'data', 'playlists'), 'existing file'); }
    await assert.rejects(createTestRuntime({ database: db, configuration: { UICulture: 'en-US' }, serverId: 'blocked-root', programDataPath: directory }), { code: 'UNSAFE_LIBRARY_ROOT_PATH' });
    assert.equal(saved, 0); assert.equal(closeCalls, 1);
    await assert.rejects(db.client.query('SELECT 1'), /closed|ended/iu);
    await assert.rejects(stat(path.join(outside, 'playlists')), { code: 'ENOENT' });
  } finally { if (!closeCalls) await db.close(); await removeTemporary(directory); await removeTemporary(outside); }
});

test('runtime without ApplicationPaths retains an empty PostgreSQL schema',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'root_no_paths');
  const runtime = await createTestRuntime({ database: db, configuration: { UICulture: 'en-US' }, serverId: 'memory-context' });
  try { assert.deepEqual(await db.rows('BaseItems'), []); }
  finally { await runtime.close(); }
});

// Register one real control for each mechanism on every supported OS. TAP names
// declare the actual platform mechanism; no platform branch silently skips work.
const platformControls = process.platform === 'win32' ? {
  longPath: 'runtime initializes a real Windows namespace path beyond MAX_PATH and reuses its canonical folders',
  link: 'runtime rejects a junction escape through a Windows namespace root before any repository save',
  unavailable: 'runtime reports an unavailable Windows drive and closes the database without repository writes',
} : {
  longPath: 'runtime initializes a real POSIX nested path longer than 260 characters and reuses its canonical folders',
  link: 'runtime rejects a POSIX directory symlink escape before any repository save',
  unavailable: 'runtime reports a POSIX non-directory state ancestor and closes the database without repository writes',
};

test(platformControls.longPath,
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mm-root-namespace-'));
    const nested = path.join(directory, ...Array(3).fill('component'.repeat(11)), 'state');
    const programDataPath = process.platform === 'win32' ? path.toNamespacedPath(nested) : nested;
    assert.ok(programDataPath.length > 260);
    if (process.platform === 'win32') assert.ok(programDataPath.startsWith('\\\\?\\'));
    else assert.ok(programDataPath.startsWith('/'));
    t.diagnostic(JSON.stringify({ platform: process.platform, mechanism: process.platform === 'win32' ? 'namespace-path' : 'nested-posix-path' }));
    const db = await createPostgresTestDatabase(t, 'root_namespace');
    let runtime, closed = false;
    const close = db.close.bind(db);
    db.close = async () => { await close(); closed = true; };
    try {
      runtime = await createTestRuntime({ database: db, configuration: { UICulture: 'en-US' }, serverId: 'namespace-root', programDataPath });
      const records = await db.rows('BaseItems');
      assert.deepEqual(records.map(row => row.Id).sort(), [rootId, playlistId].sort());
      const actualRoot = await realpath(programDataPath);
      for (const relative of ['root', 'data/playlists']) {
        const actual = await realpath(path.join(programDataPath, relative));
        assert.ok(path.relative(actualRoot, actual).length > 0);
        assert.ok(!path.relative(actualRoot, actual).startsWith('..'));
        assert.equal((await stat(actual)).isDirectory(), true);
      }
      let writes = 0; const upsert = db.upsert.bind(db);
      db.upsert = (...args) => { writes++; return upsert(...args); };
      await initializeLibraryRoot({fileSystem: testFileSystem,  store: runtime.store, programDataPath });
      assert.equal(writes, 0); assert.deepEqual(await db.rows('BaseItems'), records);
    } finally {
      try { if (runtime) await runtime.close(); else if (!closed) await db.close(); }
      finally { await removeTemporary(directory); }
    }
  });

test(platformControls.link,
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mm-root-namespace-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'mm-root-namespace-outside-'));
    const db = await createPostgresTestDatabase(t, 'root_namespace_escape');
    let writes = 0, closed = false; const upsert = db.upsert.bind(db), close = db.close.bind(db);
    db.upsert = (...args) => { writes++; return upsert(...args); };
    db.close = async () => { await close(); closed = true; };
    try {
      await symlink(outside, path.join(directory, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
      const programDataPath = process.platform === 'win32' ? path.toNamespacedPath(directory) : directory;
      assert.equal(await realpath(path.join(directory, 'data')), await realpath(outside));
      t.diagnostic(JSON.stringify({ platform: process.platform, mechanism: process.platform === 'win32' ? 'namespace-junction' : 'directory-symlink' }));
      await assert.rejects(createTestRuntime({ database: db, configuration: { UICulture: 'en-US' }, serverId: 'namespace-escape',
        programDataPath }), { code: 'UNSAFE_LIBRARY_ROOT_PATH' });
      assert.equal(writes, 0); assert.equal(closed, true);
      await assert.rejects(db.client.query('SELECT 1'), /closed|ended/iu);
      await assert.rejects(stat(path.join(outside, 'playlists')), { code: 'ENOENT' });
    } finally {
      try { if (!closed) await db.close(); }
      finally { await removeTemporary(directory); await removeTemporary(outside); }
    }
  });

test(platformControls.unavailable,
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    let programDataPath, directory;
    const expectedCode = process.platform === 'win32' ? 'ENOENT' : 'ENOTDIR';
    if (process.platform === 'win32') {
      let unavailable;
      for (const letter of 'ZYXWVUTSRQPONMLKJIHGFEDCBA') {
        const drive = `${letter}:\\`;
        try { await stat(drive); }
        catch (error) { if (error.code === 'ENOENT') { unavailable = drive; break; } throw error; }
      }
      assert.ok(unavailable, 'This Windows control requires an unavailable drive.');
      programDataPath = path.join(unavailable, 'UnavailableTestState');
    } else {
      directory = await mkdtemp(path.join(tmpdir(), 'mm-root-not-directory-'));
      t.after(() => removeTemporary(directory));
      const obstruction = path.join(directory, 'file');
      await writeFile(obstruction, 'state ancestor is a regular file');
      assert.equal((await stat(obstruction)).isFile(), true);
      programDataPath = path.join(obstruction, 'state');
    }
    await assert.rejects(stat(programDataPath), { code: expectedCode });
    t.diagnostic(JSON.stringify({ platform: process.platform, mechanism: process.platform === 'win32' ? 'unavailable-drive' : 'non-directory-ancestor', expectedCode }));
    const db = await createPostgresTestDatabase(t, 'root_missing_drive');
    let writes = 0, closed = false; const upsert = db.upsert.bind(db), close = db.close.bind(db);
    db.upsert = (...args) => { writes++; return upsert(...args); };
    db.close = async () => { await close(); closed = true; };
    try {
      await assert.rejects(createTestRuntime({ database: db, configuration: { UICulture: 'en-US' }, serverId: 'missing-drive',
        programDataPath }), { code: expectedCode });
      assert.equal(writes, 0); assert.equal(closed, true);
      await assert.rejects(db.client.query('SELECT 1'), /closed|ended/iu);
      if (directory) assert.equal(await readFile(path.join(directory, 'file'), 'utf8'), 'state ancestor is a regular file');
    } finally { if (!closed) await db.close(); }
  });
