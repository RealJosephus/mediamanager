import { testFileSystem } from '../storage/plugin-files.js';
import {nativeTextBytes,decodeNativeTextBytes} from '../../src/database/native-text.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, readdir, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { UnsafeItemDeletionService } from '../../src/library/unsafe-item-deletion-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ExternalDataManager } from '../../src/library/external-data.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { dateText, dateTicks, guid, idKey } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { expandStatePath } from './fixture-state-path.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const fixture = new URL('./fixtures/unsafe-fast-deletion/', import.meta.url);
const bytes = await readFile(new URL('native.json', fixture));
const native = parseLosslessJson(bytes.toString('utf8'));
const provenance = JSON.parse(await readFile(new URL('provenance.json', fixture), 'utf8'));
const inputFile = new URL('./fixtures/unsafe-fast-deletion-runtime/input.json', import.meta.url);
const inputBytes = await readFile(inputFile), sampleNames = JSON.parse(inputBytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry);
const tables = { rows: 'BaseItems', users: 'Users', userData: 'UserData', links: 'LinkedChildren' };
const stamp = '2026-10-12T00:00:00.1234567Z';
function normalize(table, row) {
  return Object.fromEntries(tableDefinition(table).columns.map(column => {
    let value = row[column.name];
    if (value != null && column.clrType.includes('Guid')) value = guid(value);
    if (value != null && column.clrType.includes('DateTime')) value = dateText(value);
    if (typeof value === 'bigint' && Number.isSafeInteger(Number(value))) value = Number(value);
    return [column.name, value];
  }));
}
const order = (table, rows) => rows.sort((left, right) => {
  for (const key of tableDefinition(table).primaryKey) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
});
// Only the declared isolated state-root prefix relocates. Virtual metadata
// suffixes now come from this platform's fresh native persistence, not Windows.
const rebase = (value, from, to) => expandStatePath(value, from, to);
let recording;
function currentNative() {
  return recording ??= (async () => {
    const output = path.join(validationOutputRoot(), 'unsafe-fast-deletion-runtime-' + randomUUID());
    const receipt = await recordOracle({ project: 'tests/library/fixtures/unsafe-fast-deletion-runtime/Oracle.csproj', output,
      args: [fileURLToPath(inputFile), '{output}/native.json', '{output}/cases'] });
    const recordedBytes = await readFile(path.join(output, 'native.json'));
    const reference = parseLosslessJson(recordedBytes.toString('utf8'));
    assert.equal(receipt.passed, true);
    assert.equal(reference.inputSha256, hash(inputBytes)); assert.equal(reference.platform, process.platform);
    assert.equal(receipt.outputs.find(file => path.basename(file.filename) === 'native.json').sha256, hash(recordedBytes));
    assert.ok(reference.assemblies.some(assembly => assembly.name === 'jellyfin' && assembly.sha256 === receipt.jellyfinDll.sha256));
    assert.deepEqual(reference.observations.map(sample => sample.sample), sampleNames);
    for (const flag of ['actualLibraryManagerUnsafeFast', 'actualSqlitePersistence', 'actualPathManager', 'actualExternalDataFiles']) assert.equal(reference[flag], true);
    assert.equal(reference.mediaOpened, false); assert.equal(reference.portOpened, false);
    for (const sample of reference.observations) {
      assert.deepEqual(sample.release, { readonlyAttributesReset: true, databaseExclusiveOpen: true });
      assert.equal(Boolean(sample.readonlyControl), ['later-internal-readonly', 'later-source-readonly'].includes(sample.sample));
      for (const side of ['before', 'after']) for (const [field, table] of Object.entries(tables)) {
        for (const row of sample[side][field]) assert.deepEqual(Object.keys(row).sort(), tableDefinition(table).columns.map(column => column.name).sort());
      }
    }
    return { output, reference, nativeSha256: hash(recordedBytes) };
  })();
}
async function tree(root) {
  const entries = [];
  async function visit(folder) {
    for (const name of await readdir(folder)) {
      const filename = path.join(folder, name), info = await stat(filename), directory = info.isDirectory();
      entries.push({ path: path.relative(root, filename).replaceAll('\\', '/'), directory,
        sha256: directory ? null : hash(await readFile(filename)) });
      if (directory) await visit(filename);
    }
  }
  for (const folder of ['metadata', 'data']) {
    const filename = path.join(root, folder);
    try { await stat(filename); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await visit(filename);
  }
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
const normalizeCalls = calls => calls.map(call => ({ ...call,
  ...(call.id ? { id: guid(call.id) } : {}), ...(call.ids ? { ids: call.ids.map(guid) } : {}),
  ...(call.parent ? { parent: guid(call.parent) } : {}) }));

test('UnsafeFast seals actual batch preparation, filesystem, SQLite closure, cache and Removed observations', async () => {
  assert.equal(hash(bytes), provenance.nativeSha256); assert.equal(native.observations.length, 13);
  assert.deepEqual(sampleNames, native.observations.map(sample => sample.sample), 'The live recorder retains all thirteen historical controls in their original order.');
  for (const flag of ['actualLibraryManagerUnsafeFast', 'actualSqlitePersistence', 'actualPathManager', 'actualExternalDataFiles']) assert.equal(native[flag], true);
  assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false);
  for (const source of provenance.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixture))), source.sha256, source.name);
  for (const sample of native.observations) for (const side of ['before', 'after']) for (const [field, table] of Object.entries(tables)) {
    for (const row of sample[side][field]) assert.deepEqual(Object.keys(row).sort(), tableDefinition(table).columns.map(column => column.name).sort());
  }
});

for (const sampleName of sampleNames) test('postgres: UnsafeFast matches native ' + sampleName, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 180000,
}, async t => {
  const recorded = await currentNative(), sample = recorded.reference.observations.find(entry => entry.sample === sampleName);
  const value = await setupChildrenFixture(t), { database, library, store, stateRoot, configuration } = value;
  configuration.CacheSize = 64;
  const creator = new ItemCreationService({ store, library, linkedChildren:value.linkedChildren,loadContext:value.loadContext });
  library.itemCreation = creator; t.after(() => creator.close());
  const external = new ExternalDataManager({fileSystem: testFileSystem,  store, metadataPath: path.join(stateRoot, 'metadata'), dataPath: path.join(stateRoot, 'data') });
  const service = new UnsafeItemDeletionService({ store, library, itemCreation: creator, externalData: external, now: () => stamp });
  library.unsafeItemDeletion = service;
  await store.transaction(async db => {
    await db.client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const field of ['rows', 'users', 'links', 'userData']) {
    const table = tables[field];
    // Entire pre-action rows are independent constructor/persistence inputs.
    for (const row of sample.before[field]) await db.insert(table, Object.fromEntries(tableDefinition(table).columns.map(column => {
      let entry = rebase(row[column.name], sample.root, stateRoot);
      if (entry != null && column.clrType.includes('Guid')) entry = nativeGuid(entry);
      return [column.name, entry];
    })));
    }
  });
  if (sample.sample === 'relational-closure') {
    // Ancestor input is independently declared in the recorder, not inferred
    // from the post-deletion rows being compared.
    for (const [item, parent] of [[34, 10], [35, 34], [36, 35]]) await database.insert('AncestorIds', {
      ItemId: nativeGuid('ba360000-0000-0000-0000-' + String(item).padStart(12, '0')),
      ParentItemId: nativeGuid('ba360000-0000-0000-0000-' + String(parent).padStart(12, '0')),
    });
  }
  for (const entry of sample.before.tree) {
    const filename = path.join(stateRoot, entry.path);
    if (entry.directory) await mkdir(filename, { recursive: true });
    else {
      await mkdir(path.dirname(filename), { recursive: true });
      const content = path.basename(filename) === 'data.bin' ? 'external' : path.basename(filename) === 'internal.jpg' ? 'internal' : 'source';
      assert.equal(hash(content), entry.sha256); await writeFile(filename, content);
    }
  }
  for (const id of sample.warmed) assert.ok(await creator.getItemById(id));
  if (sample.sample === 'later-internal-readonly') await chmod(path.join(stateRoot, 'metadata/library/ba/ba360000000000000000000000000020/internal.jpg'), 0o444);
  if (sample.sample === 'later-source-readonly') await chmod(path.join(stateRoot, 'metadata/Studio/Second/poster.jpg'), 0o444);
  if (sample.readonlyControl) {
    assert.equal(sample.readonlyControl.isReadOnly, true);
    assert.equal((await stat(path.join(stateRoot, sample.readonlyControl.path))).mode & 0o222, 0,
      'Both sides apply the actual OS read-only mechanism; its deletion outcome is recorded on this platform.');
  }
  t.after(async () => { for (const entry of await tree(stateRoot)) if (!entry.directory) await chmod(path.join(stateRoot, entry.path), 0o666); });
  assert.deepEqual(await tree(stateRoot), sample.before.tree);
  const calls = [], deleteFiles = external.deleteItemFiles.bind(external);
  external.deleteItemFiles = async item => {
    calls.push({ action: 'external', id: guid(item.Id), name: item.Name });
    if (sample.sample === 'later-external-failure' && item.Name === 'Second') throw new Error('Controlled external failure');
    return deleteFiles(item);
  };
  library.on('ItemRemoved', ({ Item, Parent }) => calls.push({ action: 'removed', id: guid(Item.Id), name: Item.Name, parent: Parent ? guid(Parent.Id) : null }));
  const transaction = store.transaction.bind(store);
  let failure;
  await store.serializeWrites(async db => {
    const query = db.client.query.bind(db.client); let rootRelation;
    db.client.query = async (...args) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0].text;
      const match = /^CREATE TEMP TABLE ("mm_unsafe_[a-z0-9]+_roots")/u.exec(text);
      const result = await query(...args); if (match) rootRelation = match[1]; return result;
    };
    store.transaction = async (...args) => {
      const selected = (await query(`SELECT "Id" FROM ${rootRelation} ORDER BY "__ordinal" LIMIT 129`)).rows;
      assert.ok(selected.length < 129, 'Small oracle recording observer stays bounded.');
      calls.push({ action: 'persist', ids: selected.map(row => guid(decodeNativeTextBytes(row.Id,'runtime'))) });
      if (sample.sample === 'persistence-failure') throw new Error('Controlled persistence failure');
      return transaction(...args);
    };
    try {
      if (sample.sample === 'sqlite-trigger-failure') await query(`CREATE FUNCTION controlled_unsafe_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Controlled database failure'; END; $$;
        CREATE TRIGGER controlled_unsafe_failure BEFORE DELETE ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION controlled_unsafe_failure()`);
      try { await library.deleteQueryItemsUnsafeFast({ ids: sample.rootIds, ...(sample.rootIds.length ? {} : { includeitemtypes: ['Genre'] }) }, { deleteSourceFiles: sample.deleteSourceFiles }); }
      catch (error) { failure = error; }
      assert.deepEqual((await query("SELECT relname FROM pg_class WHERE relnamespace = pg_my_temp_schema() AND relname LIKE 'mm_%'")).rows, []);
    } finally { store.transaction = transaction; db.client.query = query; }
  });
  const actual = { tree: await tree(stateRoot) }, expected = { tree: sample.after.tree };
  for (const [field, table] of Object.entries(tables)) {
    actual[field] = order(table, (await database.rows(table)).map(row => normalize(table, row)));
    expected[field] = order(table, sample.after[field].map(row => normalize(table, Object.fromEntries(Object.entries(row).map(([key, entry]) => [key, rebase(entry, sample.root, stateRoot)])))));
  }
  for (const row of actual.userData) if (row.RetentionDate) {
    assert.equal(row.RetentionDate, stamp); row.RetentionDate = '$DELETION_NOW';
  }
  for (const row of expected.userData) if (row.RetentionDate) {
    assert.ok(dateTicks(row.RetentionDate) >= dateTicks(sample.started) && dateTicks(row.RetentionDate) <= dateTicks(sample.ended));
    row.RetentionDate = '$DELETION_NOW';
  }
  const warmedAfter = [];
  for (const id of sample.warmed) warmedAfter.push({ id: guid(id), exists: await creator.getItemById(id) !== null });
  const evidence = { actual, calls, warmedAfter, nativeSha256: recorded.nativeSha256,
    failure: failure ? { name: failure.name, code: failure.code, message: failure.message } : null };
  await writeFile(path.join(recorded.output, sampleName + '.candidate.json'), encode(evidence) + '\n', { flag: 'wx' });
  assert.equal(Boolean(failure), Boolean(sample.failure), failure?.stack ?? 'Native failure boundary');
  if (sample.sample === 'sqlite-trigger-failure') assert.equal(failure?.code, 'P0001');
  t.diagnostic(encode({ failure: evidence.failure, nativeFailure: sample.failure }));
  assert.deepEqual(actual, expected);
  assert.deepEqual(calls, normalizeCalls(sample.calls));
  assert.deepEqual(warmedAfter, sample.warmedAfter.map(row => ({ ...row, id: guid(row.id) })));
  await writeFile(path.join(recorded.output, sampleName + '.comparison.json'), encode({ passed: true,
    nativeSha256: recorded.nativeSha256, tables: Object.values(tables), calls: calls.length }) + '\n', { flag: 'wx' });
  if (process.env.MEDIAMANAGER_UNSAFE_FAST_EVIDENCE) {
    await mkdir(process.env.MEDIAMANAGER_UNSAFE_FAST_EVIDENCE, { recursive: true });
    await writeFile(path.join(process.env.MEDIAMANAGER_UNSAFE_FAST_EVIDENCE, sample.sample + '.json'), encode(evidence) + '\n', { flag: 'wx' });
  }
});

for (const mode of ['complete', 'late-preparation-failure']) test('postgres: UnsafeFast keeps a multi-page batch relational: ' + mode, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const value = await setupChildrenFixture(t), { database, store, library, stateRoot, configuration } = value;
  const creator = new ItemCreationService({ store, library, linkedChildren:value.linkedChildren,loadContext:value.loadContext });
  t.after(() => creator.close());
  const external = new ExternalDataManager({fileSystem: testFileSystem,  store, dataPath: path.join(stateRoot, 'data'), metadataPath: path.join(stateRoot, 'metadata') });
  const service = new UnsafeItemDeletionService({ store, library, itemCreation: creator, externalData: external });
  const source = native.observations.find(sample => sample.sample === 'sources-kept').before.rows.find(row => row.Name === 'First');
  const count = mode === 'complete' ? 1000 : 257;
  await database.client.query({ text: `INSERT INTO "BaseItems" SELECT (jsonb_populate_record(NULL::"BaseItems", $1::jsonb
    || jsonb_build_object('Id', chr(92)||'x'||encode(convert_to('ba370000-0000-0000-0000-'||lpad(position::text,12,'0'),'UTF8'),'hex'),
      'Name', chr(92)||'x'||encode(convert_to('Batch'||lpad(position::text,4,'0'),'UTF8'),'hex'), 'SortName', chr(92)||'x'||encode(convert_to(lpad(position::text,4,'0'),'UTF8'),'hex'),
      'Path', CASE WHEN $3::boolean AND position = $2 THEN NULL ELSE chr(92)||'x'||encode(convert_to($4::text||'/'||position::text,'UTF8'),'hex') END))).*
    FROM generate_series(1, $2) position`, values: [encode(Object.fromEntries(tableDefinition('BaseItems').columns.map(column=>[column.name,column.type==='TEXT'&&source[column.name]!=null?'\\x'+nativeTextBytes(source[column.name]).toString('hex'):source[column.name]]))), count, mode !== 'complete', path.join(stateRoot, 'metadata', 'Genre')] });
  const marker = path.join(stateRoot, 'metadata/Genre/1/marker.txt');
  await mkdir(path.dirname(marker), { recursive: true }); await writeFile(marker, 'prepared root');
  let maxReturned = 0, maxHydrated = 0, hydrationPages = 0, externalCalls = 0, transactions = 0, events = 0;
  const load = library.load.bind(library), transaction = store.transaction.bind(store), deleteFiles = external.deleteItemFiles.bind(external);
  library.load = (db, user, options) => { maxHydrated = Math.max(maxHydrated, options.baseRows.length); hydrationPages++; return load(db, user, options); };
  store.transaction = (...args) => { transactions++; return transaction(...args); };
  external.deleteItemFiles = (...args) => { externalCalls++; return deleteFiles(...args); };
  library.on('ItemRemoved', ({ Item }) => { assert.equal(Item.Name, 'Batch' + String(++events).padStart(4, '0')); });
  await store.serializeWrites(async db => {
    const query = db.client.query.bind(db.client);
    db.client.query = async (...args) => { const result = await query(...args); maxReturned = Math.max(maxReturned, result.rows?.length ?? 0); return result; };
    try {
      const action = () => service.deleteQueryItems({ includeitemtypes: ['Genre'], sortby: ['SortName'] }, { deleteSourceFiles: mode !== 'complete' });
      if (mode === 'complete') await action(); else await assert.rejects(action, error => {
        t.diagnostic(encode({ failure: { name: error?.name, message: error?.message, code: error?.code, status: error?.status } }));
        return true;
      });
    } finally { db.client.query = query; }
    assert.deepEqual((await query("SELECT relname FROM pg_class WHERE relnamespace = pg_my_temp_schema() AND relname LIKE 'mm_%'")).rows, []);
  });
  assert.ok(maxReturned <= 128, `Maximum PostgreSQL result size: ${maxReturned}`);
  assert.ok(maxHydrated <= 128); assert.equal(hydrationPages, Math.ceil(count / 128));
  assert.equal(transactions, mode === 'complete' ? 1 : 0); assert.equal(externalCalls, mode === 'complete' ? count : 0);
  assert.equal(events, mode === 'complete' ? count : 0);
  assert.equal(Number((await database.client.query('SELECT count(*) FROM "BaseItems"')).rows[0].count), mode === 'complete' ? 0 : count);
  assert.equal(await readFile(marker, 'utf8'), 'prepared root', 'Kept sources and a failed whole-batch preparation preserve the marker.');
});
