import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import { nativeDate } from '../../src/sessions/user-data.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService, DirectoryItemResolverPipeline } from '../../src/library/index.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreRule } from './ignore-namespace-fixture.js';
import { createResolvedItemLifecycleFixture } from './resolved-item-lifecycle-fixture.js';
import { createFolderValidationScanFixture } from '../helpers/folder-validation-scan-fixture.js';

const input = parseLosslessJson(await readFile(new URL('./fixtures/resolved-item-update/input.json', import.meta.url), 'utf8'));
const native = parseLosslessJson(await readFile(new URL('./fixtures/resolved-item-update/native.json', import.meta.url), 'utf8'));
const rootId = 'a7200000-0000-0000-0000-000000000001';
const aggregateId = 'a7200000-0000-0000-0000-000000000002';
const programDataPath = 'C:\\ProgramData\\MediaManager';
const rootPath = 'Z:\\Library';
const movieType = 'MediaBrowser.Controller.Entities.Movies.Movie';
const date = '2026-10-01 01:02:03.1234567';
const alternatePaths = new Map(['A', 'B', 'b', 'P'].map(value => [value, rootPath + '\\' + value + '.mkv']));
alternatePaths.set('Z:\\alternate.mkv', rootPath + '\\alternate.mkv');
function lifecycleVersionPaths(values) {
  // The sealed UpdateFromResolvedItem controls use in-memory string tokens.
  // Actual saves also discover versions. Supply absent files in this fixture's
  // declared VFS namespace, preserving each token's case, order and null value.
  return values?.map(value => {
    if (value == null || value === '') return value;
    assert.ok(alternatePaths.has(value), 'Undeclared alternate path control: ' + value);
    return alternatePaths.get(value);
  }) ?? values;
}
const encode = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString()) : entry);
const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? ''
    : ['long', 'uint'].includes(column.clrType) ? 0n : 0]));

async function fixture(t, dialect, sample, { wrapResolvedItemLifecycle, configureLifecycle,
  logger = { error() {} } } = {}) {
  const schema = 'resolved_scan_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(database);
  const library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'resolved-item-scan', programDataPath });
  const registry = new StorageRegistry();
  let validationFixture, lifecycleFixture;
  t.after(async () => {
    await validationFixture?.close(); await lifecycleFixture?.close(); await library.close(); await registry.close();
    if (dialect === 'postgres') {
      await database.client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await database.client.query(`DROP SCHEMA ${quoteIdentifier(database.controlSchema)} CASCADE`);
    }
    await store.close();
  });
  registry.registerType('memory', options => new MemoryStorageAdapter(options));
  const adapter = await registry.createInstance('library', 'memory', {});
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/library', instanceId: 'library', capabilities: { create: true, replace: true, delete: true } });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: rootPath, accessRoot: '/library', style: 'windows', returnAccess: 'Isolated resolved-item scan control' });
  const ignoreRule = await knownAncestorIgnoreRule({ registry, vfs, identityMap, identityRoots: [rootPath] });
  lifecycleFixture = await createResolvedItemLifecycleFixture({ store, library, vfs, identityMap, ignoreRule,
    now: () => '2026-10-05T00:00:00.000Z', logger });
  configureLifecycle?.(lifecycleFixture);
  const resolvedItemLifecycle = wrapResolvedItemLifecycle
    ? wrapResolvedItemLifecycle(lifecycleFixture.lifecycle) : lifecycleFixture.lifecycle;
  await adapter.write('/Original.mkv', Buffer.from('changed media file'));
  // Native GetTopParent recognizes a physical Folder below AggregateFolder.
  // A stored TopParentId cannot substitute for that live hierarchy on save.
  await database.insert('BaseItems', { ...blank('BaseItems'), Id: aggregateId, Type: 'MediaBrowser.Controller.Entities.AggregateFolder',
    Name: 'Aggregate', Path: 'Z:\\Root', IsFolder: true, Data: '{}' });
  await database.insert('BaseItems', { ...blank('BaseItems'), Id: rootId, Type: 'MediaBrowser.Controller.Entities.Folder',
    Name: 'Library', Path: rootPath, ParentId: aggregateId, TopParentId: rootId, IsFolder: true, Data: '{}', DateCreated: date, DateModified: date, DateLastSaved: date });
  const itemId = nativeGuid(getNewItemId(sample.current.Path, movieType, { programDataPath }));
  const { Type, Name, Path, IsInMixedFolder, ProductionYear, RunTimeTicks, IndexNumber, Overview, ProviderIds, ...data } = sample.current;
  const originalData = ' { "UnknownPlugin" : { "counter" : 9223372036854775807, "text" : "keep" }, '
    + encode({ SourceType: 'Library', ...data }).slice(1);
  const original = await database.insert('BaseItems', { ...blank('BaseItems'), Id: itemId, Type: movieType, Name, Path,
    CleanName: 'curated title', SortName: 'manual ordering', ForcedSortName: 'manual ordering', IsLocked: true,
    ParentId: rootId, TopParentId: rootId, IsInMixedFolder, ProductionYear, RunTimeTicks, IndexNumber, Overview,
    MediaType: 'Video', Size: 987654321012345n, Data: originalData, Tags: 'Curated', Genres: 'Drama', Studios: 'Studio',
    DateCreated: date, DateModified: date, DateLastSaved: date, DateLastRefreshed: date });
  for (const [ProviderId, ProviderValue] of Object.entries(ProviderIds)) await database.insert('BaseItemProviders', { ItemId: itemId, ProviderId, ProviderValue });
  await database.insert('AncestorIds', { ItemId: itemId, ParentItemId: rootId });
  const resolver = { id: 'controlled-native-resolution', priority: 0, nativeTypes: { [movieType]: { isFolder: false } },
    resolveFile: ({ candidate }) => ({ nativeType: movieType, primary: candidate, consumedPaths: [candidate], traversal: 'none',
      draft: { Name: sample.resolved.Name, IsFolder: false, MediaType: 'Video', SourceType: 'Library',
        columns: { IsInMixedFolder: sample.resolved.IsInMixedFolder }, initialColumns: { ProductionYear: sample.resolved.ProductionYear },
        data: { VideoType: sample.resolved.VideoType, AdditionalParts: sample.resolved.AdditionalParts,
          LocalAlternateVersions: sample.resolved.LocalAlternateVersions, Overview: 'Do not import', Tags: ['Do not import'], UnknownPlugin: 'Do not overwrite' } } }) };
  validationFixture = createFolderValidationScanFixture({ store, library, vfs, identityMap,
    ignoreRule,
    programDataPath, lifecycleFixture,
    resolverPipeline: new DirectoryItemResolverPipeline({ programDataPath, resolvers: [resolver] }),
    resolvedItemLifecycle,
    clock: () => new Date('2026-10-05T00:00:00.000Z') });
  const parent = await validationFixture.itemCreation.getItemById(rootId);
  return { database, store, library, adapter, validation: validationFixture.validation, parent, itemId, original };
}

// Non-empty AdditionalParts are structural ownership claims and are covered
// by owned-part-scan. This controlled lifecycle fixture intentionally has no
// corresponding consumed files or owned Video rows, so it must not fabricate
// those claims through the directory resolver boundary.
const samples = input.filter(sample => ['Movie-unchanged', 'Movie-mixed', 'Movie-parts-clear',
  'Movie-alternates-added', 'Movie-alternates-case', 'Movie-alternates-order', 'Movie-alternates-clear',
  'AdditionalParts-null-empty', 'AdditionalParts-empty-null', 'LocalAlternateVersions-value-null'].includes(sample.name))
  .map(sample => ({ ...sample,
    current: { ...sample.current, LocalAlternateVersions: lifecycleVersionPaths(sample.current.LocalAlternateVersions) },
    resolved: { ...sample.resolved, LocalAlternateVersions: lifecycleVersionPaths(sample.resolved.LocalAlternateVersions) } }));

for (const dialect of ['postgres']) for (const sample of samples) test(`${dialect}: Folder validation preserves metadata through the resolved update ${sample.name}`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const lifecycleBranches = [];
    const { database, library, validation, parent, itemId, original } = await fixture(t, dialect, sample, {
      wrapResolvedItemLifecycle: lifecycle => ({ updateRepository: (...args) => lifecycle.updateRepository(...args), async apply(id, options) {
        const outcome = await lifecycle.apply(id, options);
        lifecycleBranches.push(outcome.branch);
        return outcome;
      } })
    });
    const expected = native.results.find(value => value.name === sample.name);
    const updates = [];
    library.on('ItemUpdated', event => updates.push(event));
    if (sample.resolved.LocalAlternateVersions === null) {
      // The sealed UpdateFromResolvedItem control only mutates a live array.
      // Actual SaveItems rejects a null version array before committing it.
      const tables = ['BaseItems', 'BaseItemProviders', 'AncestorIds', 'ItemValues', 'ItemValuesMap', 'LinkedChildren'];
      const before = await Promise.all(tables.map(table => database.rows(table)));
      await assert.rejects(validation.validateChildren(parent, { refreshChildMetadata: false }),
        /video version array cannot be null/u);
      assert.deepEqual(await Promise.all(tables.map(table => database.rows(table))), before);
      assert.deepEqual(updates, []);
      return;
    }
    await validation.validateChildren(parent, { refreshChildMetadata: false });
    const [stored] = await database.rows('BaseItems', { where: { Id: itemId } });
    const data = parseLosslessJson(stored.Data);
    const changed = expected.first.updateType > 1;
    assert.deepEqual(lifecycleBranches, [changed ? 'save' : 'images']);
    assert.equal(stored.IsInMixedFolder, expected.after.IsInMixedFolder);
    for (const field of ['AdditionalParts', 'LocalAlternateVersions', 'VideoType']) {
      // UpdateFromResolvedItem projects live null arrays, whereas the actual
      // SaveItems serializer omits null object properties. No-ops keep the
      // exact existing bytes rather than resaving a reconstructed entity.
      if (changed && expected.after[field] === null) assert.equal(Object.hasOwn(data, field), false, field);
      else assert.deepEqual(data[field], field === 'LocalAlternateVersions'
        ? lifecycleVersionPaths(expected.after[field]) : expected.after[field]);
    }
    if (changed) assert.equal(Object.hasOwn(data, 'UnknownPlugin'), false, 'typed saves discard undeclared JSON fields');
    else assert.deepEqual(data.UnknownPlugin, { counter: 9223372036854775807n, text: 'keep' }, 'no-op keeps raw bytes');
    const preservedFields = ['Id', 'Type', 'Name', 'Path', 'SortName', 'ForcedSortName', 'IsLocked', 'ParentId',
      'TopParentId', 'ProductionYear', 'RunTimeTicks', 'IndexNumber', 'Overview', 'MediaType', 'Size',
      'DateCreated', 'DateModified', 'DateLastRefreshed', 'Tags', 'Genres', 'Studios'];
    for (const field of preservedFields) {
      assert.deepEqual(stored[field], original[field], field);
    }
    assert.deepEqual(await database.rows('BaseItemProviders', { where: { ItemId: itemId } }),
      Object.entries(sample.current.ProviderIds).map(([ProviderId, ProviderValue]) => ({ ItemId: itemId, ProviderId, ProviderValue }))
        .sort((left, right) => left.ProviderId < right.ProviderId ? -1 : left.ProviderId > right.ProviderId ? 1 : 0));
    assert.equal(updates.length, changed ? 1 : 0);
    if (changed) {
      assert.notEqual(stored.DateLastSaved, original.DateLastSaved);
      assert.equal(updates[0].UpdateReason, 2);
      assert.equal(updates[0].Item.Name, sample.current.Name);
      assert.deepEqual(updates[0].Item.ProviderIds, sample.current.ProviderIds);
    } else assert.deepEqual(stored, original, 'a no-op preserves the exact stored JSON and dates');
    const maps = await database.rows('ItemValuesMap');
    await validation.validateChildren(parent, { refreshChildMetadata: false });
    assert.deepEqual(lifecycleBranches, [changed ? 'save' : 'images', 'images']);
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: itemId } }), [stored]);
    assert.deepEqual(await database.rows('ItemValuesMap'), maps);
    assert.equal(updates.length, changed ? 1 : 0);
  });

for (const dialect of ['postgres']) test(`${dialect}: an existing-child save failure prevents the later new-sibling batch and emits no events`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { database, library, validation, parent, adapter, itemId } = await fixture(t, dialect, input.find(sample => sample.name === 'Movie-mixed'));
    await adapter.write('/Alpha.mkv', Buffer.from('new media'));
    const schema = quoteIdentifier(database.schemaName);
    await database.client.query(`CREATE FUNCTION ${schema}.reject_resolved_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."Id" = '${itemId}' THEN RAISE EXCEPTION 'Controlled resolved update failure'; END IF; RETURN NEW; END; $$`);
    await database.client.query(`CREATE TRIGGER reject_resolved_update BEFORE UPDATE OF "IsInMixedFolder" ON ${schema}."BaseItems"
      FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_resolved_update()`);
    const tables = ['BaseItems', 'BaseItemProviders', 'AncestorIds', 'ItemValues', 'ItemValuesMap'];
    const before = await Promise.all(tables.map(table => database.rows(table)));
    const events = [];
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) library.on(name, event => events.push({ name, id: event.Item.Id }));
    await assert.rejects(validation.validateChildren(parent, { refreshChildMetadata: false }), /Controlled resolved update failure/u);
    assert.deepEqual(await Promise.all(tables.map(table => database.rows(table))), before);
    assert.deepEqual(events, []);
  });

for (const dialect of ['postgres']) test(`${dialect}: resolved saves use the actual clock when the previous save is in the future`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { database, validation, parent, itemId } = await fixture(t, dialect, input.find(sample => sample.name === 'Movie-mixed'));
    await database.update('BaseItems', { Id: itemId }, { DateLastSaved: '2027-01-01 00:00:00.0000001' });
    await validation.validateChildren(parent, { refreshChildMetadata: false });
    const [stored] = await database.rows('BaseItems', { where: { Id: itemId } });
    assert.equal(stored.DateLastSaved, nativeDate('2026-10-05T00:00:00.000Z'));
  });

test('Folder validation dispatches both native existing-item lifecycle branches without duplicate update events', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const calls = [];
  const wrapResolvedItemLifecycle = lifecycle => ({
    updateRepository: (...args) => lifecycle.updateRepository(...args),
    async apply(id, options) {
      const outcome = await lifecycle.apply(id, options);
      calls.push({ id, resolved: options.resolved, ...outcome });
      return outcome;
    }
  });
  const fixtureState = await fixture(t, 'postgres', input.find(sample => sample.name === 'Movie-mixed'),
    { wrapResolvedItemLifecycle });
  const updates = [];
  fixtureState.library.on('ItemUpdated', event => updates.push(event));

  await fixtureState.validation.validateChildren(fixtureState.parent, { refreshChildMetadata: false });
  await fixtureState.validation.validateChildren(fixtureState.parent, { refreshChildMetadata: false });

  assert.deepEqual(calls.map(({ id, branch, changed }) => ({ id, branch, changed })),
    [{ id: fixtureState.itemId, branch: 'save', changed: true },
      { id: fixtureState.itemId, branch: 'images', changed: false }]);
  assert.equal(calls[0].resolved.NativeType, movieType);
  assert.equal(calls[0].resolved.IsInMixedFolder, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].Item.Id, fixtureState.itemId);
  assert.equal(updates[0].UpdateReason, 2);
});

test('remote image localization publishes the nested ImageUpdate before the resolved MetadataImport', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const png = await readFile(new URL('../images/fixtures/processor/original-http.png', import.meta.url));
  const errors = [];
  const fixtureState = await fixture(t, 'postgres', input.find(sample => sample.name === 'Movie-mixed'), {
    logger: { error: error => errors.push(error.message) },
    configureLifecycle(current) {
      current.images.fetch = async () => new Response(png, { headers: { 'content-type': 'image/png' } });
      const load = current.lifecycle.loadContext;
      current.lifecycle.loadContext = async reference => ({ ...await load(reference),
        metadataPath: rootPath, saveLocalMetadataEnabled: true });
    }
  });
  await fixtureState.database.insert('BaseItemImageInfos', {
    ...blank('BaseItemImageInfos'), Id: 'A7200000-0000-0000-0000-000000000099', ItemId: fixtureState.itemId,
    ImageType: 0, Path: 'https://images.invalid/poster.png', DateModified: date, Width: 0, Height: 0
  });
  const updates = [];
  fixtureState.library.on('ItemUpdated', event => updates.push(event.UpdateReason));

  await fixtureState.validation.validateChildren(fixtureState.parent, { refreshChildMetadata: false });
  assert.deepEqual(updates, [4, 2], JSON.stringify(errors));
  const [image] = await fixtureState.database.rows('BaseItemImageInfos', { where: { ItemId: fixtureState.itemId } });
  assert.equal(image.Path.startsWith('Z:\\Library\\'), true);
  assert.doesNotMatch(image.Path, /^https?:/iu);
  assert.equal(image.Width, 1);
  assert.equal(image.Height, 1);
  const accessPath = '/' + image.Path.slice(rootPath.length).replace(/^[/\\]+/u, '').replaceAll('\\', '/');
  assert.equal((await fixtureState.adapter.stat(accessPath)).kind, 'file');
});
