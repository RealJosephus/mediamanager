import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { parseLosslessJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { nativeGenreIdentity, nativeStudioIdentity } from '../../src/library/identity.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { dateText, guid } from '../../src/library/records.js';
import { nativeDateFromUnixNanoseconds, nativeGuid } from '../../src/users/native.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { expandStatePath, projectStatePath, projectStateMacroPath } from './fixture-state-path.js';

const identities = { Genre: nativeGenreIdentity, Studio: nativeStudioIdentity };
const getters = { Genre: 'getGenre', Studio: 'getStudio' };
const fixtureRoot = new URL('./fixtures/by-name-creation/', import.meta.url);
const bytes = await readFile(new URL('native.json', fixtureRoot));
const native = parseLosslessJson(bytes.toString('utf8'));
const provenance = JSON.parse(await readFile(new URL('provenance.json', fixtureRoot), 'utf8'));
const columns = tableDefinition('BaseItems').columns;
const normalize = (row, root) => Object.fromEntries(columns.map(column => {
  let value = row[column.name];
  if (typeof value === 'string') value = projectStatePath(value, root);
  if (column.name === 'Path') value = projectStateMacroPath(value, root);
  if (value != null && column.clrType.includes('Guid')) value = guid(value);
  if (value != null && column.clrType.includes('DateTime')) value = dateText(value);
  if (typeof value === 'bigint' && Number.isSafeInteger(Number(value))) value = Number(value);
  return [column.name, value];
}));
const order = rows => rows.sort((a, b) => a.Id < b.Id ? -1 : a.Id > b.Id ? 1 : 0);
const returnProjection = item => item && ({ Id: guid(item.Id), Name: item.Name, Path: item.Path,
  type: item.Type, SortName: item.SortName, DateCreated: dateText(item.DateCreated), DateModified: dateText(item.DateModified) });
const projectCalls = calls => calls.map(call => ({ ...call,
  ...(call.items ? { items: call.items.map(guid) } : {}), ...(call.id ? { id: guid(call.id) } : {}) }));

test('by-name creation seals actual LibraryManager, filesystem and complete persistence observations', async () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.nativeSha256);
  assert.equal(native.actualLibraryManagerByName, true);
  assert.equal(native.actualPersistenceSqlite, true);
  assert.equal(native.actualDirectoryCreation, true);
  assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false);
  assert.equal(native.observations.length, 30); assert.equal(columns.length, 72);
  for (const source of provenance.oracleSources) {
    const location = source.name === 'Directory.Build.props' ? new URL('../Directory.Build.props', import.meta.url)
      : new URL(source.name, fixtureRoot);
    assert.equal(createHash('sha256').update(await readFile(location)).digest('hex'), source.sha256, source.name);
  }
  for (const observation of native.observations) for (const row of [
    ...observation.initialRows, ...observation.results.flatMap(result => result.rows),
  ]) assert.deepEqual(Object.keys(row).sort(), columns.map(column => column.name).sort());
});

for (const observation of native.observations) test('postgres: native ' + observation.kind + ' creation ' + observation.sample.Key, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const value = await setupChildrenFixture(t), { database, store, library, configuration, stateRoot, linkedChildren, spoolRoot } = value;
  const sample = observation.sample;
  configuration.EnableCaseSensitiveItemIds = sample.Sensitive;
  configuration.EnableNormalizedItemByNameIds = sample.Normalized;
  const identity = identities[observation.kind](sample.Name, library.options);
  assert.equal(guid(identity.Id), observation.genreId);
  assert.equal(projectStatePath(identity.Path, stateRoot), projectStatePath(observation.genrePath, observation.root));
  // The recording includes its pre-action constructor rows as independent inputs.
  // Candidate creation runs against those inputs, never against result rows.
  for (const row of observation.initialRows) await database.insert('BaseItems', Object.fromEntries(columns.map(column => {
    let entry = row[column.name];
    if (typeof entry === 'string') entry = expandStatePath(entry, observation.root, stateRoot);
    if (column.name === 'Path') for (const macro of ['%AppDataPath%', '%MetadataPath%']) entry = expandStatePath(entry, macro, macro);
    if (entry != null && column.clrType.includes('Guid')) entry = nativeGuid(entry);
    return [column.name, entry];
  })));
  if (sample.Existing) {
    await database.insert('BaseItemProviders', { ItemId: identity.Id, ProviderId: 'Custom', ProviderValue: 'curated-provider' });
    const ItemValueId = 'e61b7500-0000-0000-0000-000000000001';
    await database.insert('ItemValues', { ItemValueId, Type: 4, Value: 'curated', CleanValue: 'curated' });
    await database.insert('ItemValuesMap', { ItemValueId, ItemId: identity.Id });
  }
  // By-name entities are instance state and must save without a media mount.
  const loadContext = createMetadataContextLoader({fileSystem: testFileSystem,  store, library, configuration, linkedChildren, spoolRoot });
  const creator = new ItemCreationService({ store, library, loadContext, linkedChildren });
  library.itemCreation = creator; t.after(() => creator.close());
  const calls = [], saveItems = creator.saveItems.bind(creator);
  creator.saveItems = async (items, options) => {
    calls.push({ action: 'save', items: items.map(item => guid(item.Id)), cancellable: Boolean(options.signal) });
    if (sample.FailSave) throw new Error('Controlled save failure');
    return saveItems(items, options);
  };
  library.on('ItemAdded', ({ Item, Parent }) => calls.push({ action: 'added', id: guid(Item.Id), parent: Parent?.Id ?? null }));
  library.on('ItemUpdated', () => assert.fail('By-name lookup does not refresh metadata.'));
  if (sample.BlockDirectory) { await mkdir(path.dirname(identity.Path), { recursive: true }); await writeFile(identity.Path, 'existing file'); }
  const observations = [];
  for (const reference of observation.results) {
    let item = null, error = null;
    try { item = await library[getters[observation.kind]](sample.Name); } catch (failure) { error = failure; }
    assert.equal(Boolean(error), Boolean(reference.failure), reference.failure?.type ?? 'successful lookup');
    if (sample.FailSave) assert.equal(error?.message, 'Controlled save failure');
    if (sample.BlockDirectory) assert.equal(error?.code, 'EEXIST');
    const info = await stat(identity.Path, { bigint: true }).catch(failure => { if (failure.code === 'ENOENT') return null; throw failure; });
    const directoryExists = Boolean(info?.isDirectory()), fileExists = Boolean(info?.isFile());
    assert.equal(directoryExists, reference.directoryExists); assert.equal(fileExists, reference.fileExists);
    const actualReturn = returnProjection(item), expectedReturn = reference.returned && { ...reference.returned,
      Path: projectStatePath(reference.returned.Path, observation.root),
      DateCreated: dateText(reference.returned.DateCreated), DateModified: dateText(reference.returned.DateModified) };
    if (actualReturn) actualReturn.Path = projectStatePath(actualReturn.Path, stateRoot);
    const rows = order((await database.rows('BaseItems')).map(row => normalize(row, stateRoot)));
    const expectedRows = order(reference.rows.map(row => normalize(row, observation.root)));
    if (directoryExists) {
      const created = dateText(nativeDateFromUnixNanoseconds(info.birthtimeNs)), modified = dateText(nativeDateFromUnixNanoseconds(info.mtimeNs));
      if (actualReturn && sample.Existing !== 'Same') {
        assert.equal(actualReturn.DateCreated, created); assert.equal(actualReturn.DateModified, modified);
        assert.equal(expectedReturn.DateCreated, dateText(reference.directoryCreated));
        assert.equal(expectedReturn.DateModified, dateText(reference.directoryModified));
        actualReturn.DateCreated = expectedReturn.DateCreated = '$DIRECTORY_CREATED';
        actualReturn.DateModified = expectedReturn.DateModified = '$DIRECTORY_MODIFIED';
        const row = rows.find(row => row.Id === observation.genreId), expected = expectedRows.find(row => row.Id === observation.genreId);
        assert.equal(row.DateCreated, created); assert.equal(row.DateModified, modified);
        assert.equal(expected.DateCreated, dateText(reference.directoryCreated));
        assert.equal(expected.DateModified, dateText(reference.directoryModified));
        row.DateCreated = expected.DateCreated = '$DIRECTORY_CREATED'; row.DateModified = expected.DateModified = '$DIRECTORY_MODIFIED';
      }
    }
    assert.deepEqual(actualReturn, expectedReturn);
    assert.deepEqual(rows, expectedRows, 'Every native mapped column, including replaced fields and Data, is verified.');
    const providers = (await database.rows('BaseItemProviders')).map(row => ({ ItemId: guid(row.ItemId), ProviderId: row.ProviderId, ProviderValue: row.ProviderValue }));
    assert.deepEqual(providers, reference.providers.map(({ Item, ...row }) => row));
    assert.deepEqual(calls, projectCalls(reference.calls));
    observations.push({ returned: actualReturn, rows, providers, calls: structuredClone(calls),
      directoryExists, fileExists, failure: error && { name: error.name, code: error.code, message: error.message } });
  }
  if (process.env.MEDIAMANAGER_BY_NAME_CREATION_EVIDENCE) {
    await mkdir(process.env.MEDIAMANAGER_BY_NAME_CREATION_EVIDENCE, { recursive: true });
    await writeFile(path.join(process.env.MEDIAMANAGER_BY_NAME_CREATION_EVIDENCE, observation.kind + '-' + sample.Key + '.json'),
      JSON.stringify({ sample, observations }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { flag: 'wx' });
  }
});

for (const kind of Object.keys(getters)) {
  test(`postgres: ${kind} persistence failure retains its directory and publishes Added only after retry`, {
    skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async t => {
    const { database, store, library, configuration, linkedChildren, spoolRoot } = await setupChildrenFixture(t);
    const creator = new ItemCreationService({ store, library, linkedChildren,
      loadContext: createMetadataContextLoader({fileSystem: testFileSystem,  store, library, configuration, linkedChildren, spoolRoot }) });
    library.itemCreation = creator; t.after(() => creator.close());
    const identity = identities[kind]('Blocked', library.options), events = [];
    library.on('ItemAdded', event => events.push(event));
    await database.client.query(`ALTER TABLE "BaseItems" ADD CONSTRAINT controlled_by_name_failure CHECK ("Name" <> 'Blocked')`);
    await assert.rejects(library[getters[kind]]('Blocked'), { code: '23514' });
    assert.equal((await stat(identity.Path)).isDirectory(), true);
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: identity.Id } }), []);
    assert.deepEqual(events, []);
    await database.client.query('ALTER TABLE "BaseItems" DROP CONSTRAINT controlled_by_name_failure');
    const item = await library[getters[kind]]('Blocked');
    assert.equal(item.Name, 'Blocked'); assert.equal(item.Type, kind); assert.equal(events.length, 1);
    await library[getters[kind]]('Blocked'); assert.equal(events.length, 1);
  });

  test(`postgres: ${kind} creation refuses a metadata-root junction before creating its directory`, {
    skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async t => {
    const { store, library, configuration, stateRoot, linkedChildren, spoolRoot } = await setupChildrenFixture(t);
    const outside = path.join(stateRoot, 'outside'), metadata = path.join(stateRoot, 'metadata');
    await mkdir(outside); await mkdir(metadata);
    await symlink(outside, path.join(metadata, kind), process.platform === 'win32' ? 'junction' : 'dir');
    const creator = new ItemCreationService({ store, library, linkedChildren,
      loadContext: createMetadataContextLoader({fileSystem: testFileSystem,  store, library, configuration, linkedChildren, spoolRoot }) });
    library.itemCreation = creator; t.after(() => creator.close());
    await assert.rejects(library[getters[kind]]('Rock'), { code: 'permission-denied' });
    await assert.rejects(stat(path.join(outside, 'Rock')), { code: 'ENOENT' });
  });
}

