import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRuntime } from '../../src/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { LibraryOptionsStore } from '../../src/library/library-options-store.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const ids = ['967c0000-0000-0000-0000-000000000001', '967c0000-0000-0000-0000-000000000002'];
async function setup(t) {
  const parent = validationOutputRoot(); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'library-options-runtime-')), programDataPath = path.join(root, 'program'),
    dataPath = path.join(root, 'instance-data'), metadataPath = path.join(root, 'metadata'), configurationDirectoryPath = path.join(root, 'config'),
    directory = path.join(programDataPath, 'root', 'default', 'Library');
  let database, runtime;
  const options = { programDataPath, dataPath, metadataPath, configurationDirectoryPath,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: 'library-options-runtime' };
  t.after(async () => {
    try { await runtime?.close(); } finally {
      try { await dropPostgresTestDatabase(database); } finally {
        assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('library-options-runtime-')); await rm(root, { recursive: true, force: true });
      }
    }
  });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'options.xml'), '<LibraryOptions><PreferredMetadataLanguage>en</PreferredMetadataLanguage></LibraryOptions>');
  database = await createPostgresTestDatabase(null, 'library_options_runtime');
  for (const [index, id] of ids.entries()) await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: id, Name: `Library ${index}`, IsFolder: true,
    Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Path: directory, Data: '{}' }));
  const open = async () => { runtime = await createRuntime({ database, ...options }); return runtime; };
  return { root, directory, options, open, get runtime() { return runtime; }, get database() { return database; },
    async reopen() {
      const schema = database.schemaName; await runtime.close();
      database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); return open();
    } };
}

test('postgres: runtime library options share live directory state and recover native files after restart', { skip: !postgresTestConnectionString }, async t => {
  const state = await setup(t), runtime = await state.open(), key = value => value.replaceAll('-', '');
  const options = runtime.library.options.libraryOptions;
  assert.deepEqual(options.get(key(ids[0])), options.get(key(ids[1])));
  assert.equal(options.get(key(ids[0])).PreferredMetadataLanguage, 'en');
  const rows = await state.database.rows('BaseItems', { whereIn: { Id: ids } });
  const changed = { ...defaultLibraryOptions(), PreferredMetadataLanguage: 'zh-TW', AutomaticallyAddToCollection: true,
    SaveLocalMetadata: true, DisabledLocalMetadataReaders: null, PathInfos: [{ Path: path.join(state.options.dataPath, 'collections') }] };
  let observed = false;
  runtime.libraryOptionsStore.on('updated', event => {
    assert.deepEqual(event.LibraryOptions, changed); assert.deepEqual(options.get(key(ids[0])), changed); assert.deepEqual(options.get(key(ids[1])), changed); observed = true;
  });
  await runtime.libraryOptionsStore.save(state.directory, changed);
  assert.equal(observed, true);
  assert.match(await readFile(path.join(state.directory, 'options.xml'), 'utf8'), /%AppDataPath%[\\/]collections/);
  assert.deepEqual(await state.database.rows('BaseItems', { whereIn: { Id: ids } }), rows);
  const restarted = await state.reopen(), recovered = restarted.library.options.libraryOptions.get(key(ids[0]));
  assert.deepEqual(recovered, restarted.library.options.libraryOptions.get(key(ids[1])));
  assert.equal(recovered.PreferredMetadataLanguage, 'zh-TW'); assert.equal(recovered.AutomaticallyAddToCollection, true);
  assert.deepEqual(recovered.PathInfos, [{ Path: path.join(state.options.dataPath, 'collections') }]);
  assert.deepEqual(recovered.DisabledLocalMetadataReaders, []);
});

test('postgres: constructor rollback drains the runtime library option store and preserves its files', { skip: !postgresTestConnectionString }, async t => {
  const state = await setup(t), bytes = await readFile(path.join(state.directory, 'options.xml'));
  const close = LibraryOptionsStore.prototype.close; let captured;
  LibraryOptionsStore.prototype.close = async function () { captured = this; return close.call(this); };
  try { await assert.rejects(createRuntime({ database: state.database, ...state.options, autoDiscoveryOptions: false }), /autoDiscoveryOptions/); }
  finally { LibraryOptionsStore.prototype.close = close; }
  assert.ok(captured); await assert.rejects(captured.get(state.directory), { status: 503 });
  assert.equal(state.database.closed, true); assert.deepEqual(await readFile(path.join(state.directory, 'options.xml')), bytes);
});
