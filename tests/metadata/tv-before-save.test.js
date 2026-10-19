import { testFileSystem } from '../storage/plugin-files.js';
import { openMetadataRelations, trackMetadataContexts, attachMetadataItemCreation, closeMetadataFixture, removeMetadataTestRoot } from './relations-fixture.js';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { createPresentationUniqueKey } from '../../src/library/presentation-key.js';
import { beforeSaveTvMetadata } from '../../src/metadata/tv-before-save.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { idKey, nonemptyId } from '../../src/library/records.js';

const root = new URL('./fixtures/tv-before-save/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));
const now = '2026-10-04T12:00:00.0000000Z';
const empty = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
const project = item => {
  const values = { Name: item.Name, PresentationUniqueKey: item.PresentationUniqueKey, IndexNumber: item.IndexNumber,
    IndexNumberEnd: item.Type === 'Episode' ? item.IndexNumberEnd : null, SeriesId: idKey(item.SeriesId), SeriesName: item.SeriesName,
    SeriesPresentationUniqueKey: item.SeriesPresentationUniqueKey, SeasonId: item.Type === 'Episode' && nonemptyId(item.SeasonId) ? idKey(item.SeasonId) : null,
    SeasonName: item.Type === 'Episode' ? item.SeasonName : null };
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => key === 'SeasonId' && item.Type === 'Episode' || value != null));
};

test('TV BeforeSave native recording seals the actual service sources and controlled lookup input', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  for (const [key, filename] of Object.entries({ input: 'input.json', native: 'native.json', oracle: 'Program.cs', project: 'Oracle.csproj' })) {
    assert.equal(createHash('sha256').update(await readFile(new URL(filename, root))).digest('hex'), provenance.files[key].sha256);
  }
  assert.equal(createHash('sha256').update(await readFile(new URL('../Directory.Build.props', import.meta.url))).digest('hex'), provenance.files.buildProperties.sha256);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 26); assert.equal(native.results.length, input.length);
});

async function setup(t) {
  const schema = 'tv_before_save_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const store = new DomainStore(database), stateRoot = await mkdtemp(path.join(os.tmpdir(), 'metadata-tv-before-save-'));
  const spoolRoot = path.join(stateRoot, 'metadata-spool'), contextLoaders = [];
  const linkedChildren = await openMetadataRelations(database, spoolRoot);
  const library = new LibraryService({fileSystem: testFileSystem,  store, linkedChildren, spoolRoot, programDataPath: stateRoot, serverId: 'tv-before-save' });
  const storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await storage.createInstance('fixture', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\TvBeforeSave', accessRoot: '/fixture', style: 'windows', returnAccess: 'isolated TV metadata controls' });
  const options = { SeasonZeroDisplayName: 'Specials' };
  const authoritative = createMetadataContextLoader({fileSystem: testFileSystem,  store, library, linkedChildren, spoolRoot, vfs, identityMap });
  const controlled = Object.assign(async (...args) => {
    const loaded = await authoritative(...args); loaded.libraryOptions = { ...options }; return loaded;
  }, authoritative);
  const loadContext = trackMetadataContexts(controlled, contextLoaders);
  const itemCreation = attachMetadataItemCreation({ store, library, linkedChildren, loadContext });
  const registry = new MetadataRegistry(), host = new MetadataRefreshHost({ registry, store, linkedChildren, vfs, loadContext, now: () => now });
  t.after(async () => {
    await closeMetadataFixture({ library, itemCreation, linkedChildren, contexts: contextLoaders, before: [() => host.close()],
      after: [() => storage.close(), () => database.client.query(`DROP SCHEMA "${schema}" CASCADE`),
        () => database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`), () => store.close(),
        () => removeMetadataTestRoot(stateRoot, 'metadata-tv-before-save-')] });
  });
  const seed = async scenario => {
    // The recorder constructs fresh targets and parent entities per case.
    // Reused SQL IDs must not retain the preceding case's live cache.
    await loadContext.close(); await itemCreation.close();
    for (const table of ['BaseItemMetadataFields', 'BaseItemProviders', 'BaseItems']) {
      const primaryKey = tableDefinition(table).primaryKey;
      for (const row of await database.rows(table)) await database.delete(table, Object.fromEntries(primaryKey.map(key => [key, row[key]])));
    }
    options.SeasonZeroDisplayName = Object.hasOwn(scenario, 'specialName') ? scenario.specialName : 'Specials';
    for (const definition of scenario.items) {
      const { key, type, parent, LockedFields, ...fields } = definition;
      const row = { ...empty, ...fields, Id: definition.Id, Name: definition.Name ?? key, Path: definition.Path ?? null,
        ParentId: parent ? scenario.items.find(item => item.key === parent).Id : null,
        Type: `MediaBrowser.Controller.Entities.${['Episode', 'Season', 'Series'].includes(type) ? 'TV.' : ''}${type}`,
        IsFolder: type !== 'Episode', DateLastRefreshed: now, SortName: 'stored sort name', Data: '{}'
      };
      if (definition.Name === null) row.Name = null;
      const data = {};
      for (const [key, value] of Object.entries(row)) if (!Object.hasOwn(empty, key)) { data[key] = value; delete row[key]; }
      row.Data = JSON.stringify(data);
      await database.insert('BaseItems', row);
      for (const field of LockedFields ?? []) await database.insert('BaseItemMetadataFields', { ItemId: definition.Id,
        Id: ['Cast', 'Genres', 'ProductionLocations', 'Studios', 'Tags', 'Name', 'Overview', 'Runtime', 'OfficialRating'].indexOf(field) });
    }
    return scenario.items.find(item => item.key === scenario.target).Id;
  };
  return { database, library, loadContext, registry, host, seed, adapter };
}

for (const dialect of ['postgres']) {
  const options = {};
  test(`${dialect}: TV parent getters, correction order, special locks and native None persistence match 26 service controls`, options, async t => {
    const fixture = await setup(t, dialect);
    for (const scenario of input) await t.test(scenario.name, async () => {
      const Id = await fixture.seed(scenario), loaded = await fixture.loadContext(Id);
      let updateType = ItemUpdateType.None;
      const key = createPresentationUniqueKey(loaded.item, loaded);
      if (loaded.item.PresentationUniqueKey !== key) { loaded.item.PresentationUniqueKey = key; updateType |= ItemUpdateType.MetadataImport; }
      updateType |= beforeSaveTvMetadata(loaded.item, loaded);
      const expected = native.results.find(result => result.name === scenario.name);
      assert.deepEqual(project(loaded.item), expected.result); assert.equal(updateType, expected.updateType);
      const result = await fixture.host.refresh(Id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
      assert.equal(result.UpdateType, expected.updateType);
      const persisted = await fixture.loadContext(Id);
      assert.deepEqual(project(persisted.item), expected.result);
      if (expected.result.Name !== scenario.items.find(item => item.Id === Id).Name) {
        assert.equal(persisted.snapshot.SortName, fixture.library.options.sortName?.(persisted.item) ?? loaded.sortName(persisted.item));
      }
      const physicalParents = [], definitions = new Map(scenario.items.map(item => [item.key, item]));
      let definition = scenario.items.find(item => item.Id === Id);
      while (definition.parent) { definition = definitions.get(definition.parent); physicalParents.push(idKey(definition.Id)); }
      assert.deepEqual(loaded.parents.map(item => idKey(item.Id)), physicalParents, 'physical parents come from ParentId');
      const desired = [...physicalParents, ...expected.result.SeasonId ? [expected.result.SeasonId] : []];
      const persistedIds = new Set(scenario.items.map(item => idKey(item.Id)));
      const savedAncestors = expected.updateType > ItemUpdateType.None ? [...new Set(desired.filter(id => persistedIds.has(id)))].sort() : [];
      assert.deepEqual((await fixture.database.rows('AncestorIds', { where: { ItemId: Id } })).map(row => idKey(row.ParentItemId)).sort(), savedAncestors);
    });
  });
  test(`${dialect}: remote lookup observes corrected TV IDs and respects the native existing parent-number merge`, options, async t => {
    const fixture = await setup(t, dialect), scenario = input[4], Id = await fixture.seed(scenario);
    const seriesId = scenario.items.find(item => item.key === 'series').Id, seasonId = scenario.items.find(item => item.key === 'season').Id;
    await fixture.database.insert('BaseItemProviders', { ItemId: seriesId, ProviderId: 'Tmdb', ProviderValue: 'physical-series' });
    await fixture.database.insert('BaseItemProviders', { ItemId: seasonId, ProviderId: 'Tmdb', ProviderValue: 'physical-season' });
    let lookup;
    fixture.registry.register({ id: 'tv-test', name: 'TV test', providers: [{ id: 'remote', name: 'TV test', kind: 'remote', itemTypes: ['Episode'],
      async getMetadata(value) { lookup = value; return { HasMetadata: true, Item: { Type: 'Episode', ParentIndexNumber: 2 } }; }
    }] });
    const refreshed = await fixture.host.refresh(Id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    assert.equal(refreshed.Failures, 0); assert.equal(lookup.SeriesProviderIds.Tmdb, 'physical-series');
    assert.equal(lookup.SeasonProviderIds.Tmdb, 'physical-season');
    const item = (await fixture.loadContext(Id)).item;
    assert.equal(item.ParentIndexNumber, 1); assert.equal(item.SeasonId.toLowerCase(), seasonId);
    assert.equal(item.SeasonName, 'Other season', 'the native BeforeSave getter ran before ID correction and the provider merge');
  });
  test(`${dialect}: first TV save remains committed after provider cancellation and ignores stale query ancestors`, options, async t => {
    const fixture = await setup(t, dialect), scenario = input[4], Id = await fixture.seed(scenario);
    await fixture.database.update('BaseItems', { Id }, { DateLastRefreshed: null });
    await fixture.database.insert('AncestorIds', { ItemId: Id, ParentItemId: scenario.items.find(item => item.key === 'otherSeries').Id });
    const cancellation = new DOMException('Injected provider cancellation', 'AbortError');
    fixture.registry.register({ id: 'tv-cancellation', name: 'TV cancellation', providers: [{ id: 'remote', name: 'TV cancellation', kind: 'remote', itemTypes: ['Episode'],
      async getMetadata() { throw cancellation; }
    }] });
    await assert.rejects(fixture.host.refresh(Id, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' }), error => error === cancellation);
    const loaded = await fixture.loadContext(Id);
    assert.deepEqual(project(loaded.item), native.results.find(result => result.name === scenario.name).result);
    assert.equal(loaded.item.DateLastRefreshed, '0001-01-01T00:00:00.0000000Z'); assert.ok(loaded.item.DateLastSaved);
    assert.equal(loaded.snapshot.DateLastRefreshed, null);
    const ancestors = await fixture.database.rows('AncestorIds', { where: { ItemId: Id } });
    assert.deepEqual(ancestors.map(row => idKey(row.ParentItemId)).sort(),
      scenario.items.filter(item => ['series', 'season'].includes(item.key)).map(item => idKey(item.Id)).sort());
  });
  test(`${dialect}: corrected Season context reads the physical series sidecar path`, options, async t => {
    const fixture = await setup(t, dialect), scenario = structuredClone(input[16]), Id = await fixture.seed(scenario);
    const series = scenario.items.find(item => item.key === 'series'), other = scenario.items.find(item => item.key === 'otherSeries');
    await fixture.database.update('BaseItems', { Id: series.Id }, { Path: 'Z:\\TvBeforeSave\\Physical' });
    await fixture.database.update('BaseItems', { Id: other.Id }, { Path: 'Z:\\TvBeforeSave\\Other' });
    await fixture.database.update('BaseItems', { Id }, { Path: 'Z:\\TvBeforeSave\\Physical\\Season 1' });
    await fixture.adapter.mkdir('/Physical'); await fixture.adapter.mkdir('/Physical/Season 1'); await fixture.adapter.mkdir('/Other');
    let observed;
    fixture.registry.register({ id: 'season-context', name: 'Season context', providers: [{ id: 'local', name: 'Season context', kind: 'local', itemTypes: ['Season'],
      async getMetadata(_item, context) { observed = context.seriesPath; return { HasMetadata: false }; }
    }] });
    await fixture.host.refresh(Id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    assert.equal(observed, '/fixture/Physical');
    assert.equal((await fixture.loadContext(Id)).item.SeriesId.toLowerCase(), series.Id);
  });
}
