import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getNewItemId } from '../../src/core/identity.js';
import { dateTicks, idKey, MIN_DATE } from '../../src/library/records.js';
import { setupChildrenFixture } from './children-fixture.js';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { dateText, EMPTY_ID } from '../../src/library/records.js';
import { OwnedItemMetadataLifecycleHost } from '../../src/metadata/owned-item-lifecycle.js';
import { prepareOwnedItemRefresh } from '../../src/metadata/owned-item-refresh.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { createMetadataContextLoader } from '../../src/library/metadata-context.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { nativeGuid } from '../../src/users/native.js';
import { DotIgnoreRule } from '../../src/library/dot-ignore-rule.js';
import { applyNativeItemValues, newNativeItemEntity } from '../../src/library/native-item-entity.js';

const oracleRoot = new URL('./fixtures/owned-item-lifecycle/', import.meta.url);
const readOracle = async filename => parseLosslessJson(await readFile(new URL(filename, oracleRoot), 'utf8'));
const [oracleInput, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(readOracle));

test('owned lifecycle oracle seals all native dispatch with controlled extra discovery', async () => {
  for (const file of provenance.fixtureFiles) {
    const fileUrl = file.path === 'tests/Directory.Build.props' ? new URL('../../../Directory.Build.props', oracleRoot)
      : new URL(file.path.split('/').at(-1), oracleRoot);
    assert.equal(createHash('sha256').update(await readFile(fileUrl)).digest('hex'), file.sha256, file.path);
  }
  assert.equal(native.actualFrozenOwnedItemLifecycle, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles.find(file => file.path.endsWith('/input.json')).sha256);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.results.map(sample => sample.name), oracleInput.map(sample => sample.name));
  assert.equal(native.results.length, 17);
});

const nativeTypeName = type => `MediaBrowser.Controller.Entities.${type === 'Movie' ? 'Movies.' : type === 'Audio' ? 'Audio.' : ''}${type}`;
const nativeProject = item => ({ Name: item.Name ?? null, Path: item.Path ?? null, OwnerId: item.OwnerId ?? EMPTY_ID,
  ParentId: item.ParentId ?? EMPTY_ID, IsInMixedFolder: item.IsInMixedFolder ?? false, ExtraType: item.ExtraType ?? null,
  Genres: item.Genres ?? [], Studios: item.Studios ?? [], Overview: item.Overview ?? null,
  ProductionYear: item.ProductionYear ?? null, PremiereDate: item.PremiereDate == null ? null : dateText(item.PremiereDate),
  PrimaryVersionId: item.PrimaryVersionId ?? null, AdditionalParts: item.IsFolder || item.Type === 'Audio' ? null : item.AdditionalParts ?? [],
  LocalAlternateVersions: item.IsFolder || item.Type === 'Audio' ? null : item.LocalAlternateVersions ?? [] });

for (const sample of oracleInput) {
  test(`native persisted owned dispatch: ${sample.name}`, async () => {
    const definitions = structuredClone(sample.items);
    const byKey = new Map(definitions.map(definition => {
      const item = newNativeItemEntity(nativeTypeName(definition.type));
      applyNativeItemValues(item, definition, { IsFileProtocol: Boolean(definition.Path) });
      return [definition.key, item];
    }));
    const items = [...byKey.values()];
    for (const item of items) {
      if (item.parent) item.ParentId = byKey.get(item.parent).Id;
      if (item.owner) item.OwnerId = byKey.get(item.owner).Id;
      if (item.primary) item.PrimaryVersionId = byKey.get(item.primary).Id;
    }
    const owner = byKey.get('owner');
    const links = sample.links.map((key, SortOrder) => ({ ParentId: owner.Id, ChildId: byKey.get(key).Id, ChildType: 2, SortOrder }));
    const state = { items, byId: new Map(items.map(item => [idKey(item.Id), item])), links, async dispose(){} };
    const loadContext = async reference => {
      const item = state.byId.get(idKey(reference));
      return { item, async dispose(){}, parent: state.byId.get(idKey(item.ParentId)), context: { images: [] }, libraryOptions: {},
        getLocalAlternateVersionIds: async () => links.filter(link => idKey(link.ParentId) === idKey(item.Id)
          && link.ChildType === 2).map(link => link.ChildId), reloadMetadataContext: loadContext,
        loadLibraryState: async () => state,
        loadDraftContext: async value => loadContext(value.Id),
        findOwnedExtras: async () => {
          if (sample.rename) byKey.get(sample.rename.key).Name = sample.rename.name;
          return { deletionSafe: true, extras: sample.foundExtras.map(key => {
            const item = byKey.get(key);
            return { item, ownerId: item.OwnerId, context: { item, async dispose(){} } };
          }) };
        },
        ownedFileExists: async identityPath => sample.presentFiles.includes(identityPath),
        videoVersionDiscovery: { lookup: async (_, id) => state.byId.get(idKey(id)), async removeMissingOwnedItem(_, removed) {
          calls.push({ action: 'delete', key: removed.key, deleteFileLocation: false });
          items.splice(items.indexOf(removed), 1); state.byId.delete(idKey(removed.Id));
          const index = links.findIndex(link => link.ChildId === removed.Id);
          if (index >= 0) links.splice(index, 1);
        } },
        getNewItemId: (identityPath, type) => items.find(item => item.Path === identityPath && item.NativeType === type).Id };
    };
    const calls = [];
    const keyFor = item => items.find(value => value.Id === item.Id).key;
    const database = {
      rows: async (table, { where } = {}) => table === 'LinkedChildren' ? links
        : items.filter(item => !where?.Id || item.Id === where.Id).map(item => ({ ...item, Type: item.NativeType })),
      async insert(_, row) { links.push(row); },
      async update(_, key, changes) { Object.assign(links.find(row => row.SortOrder === key.SortOrder), changes); }
    };
    const lifecycle = new OwnedItemMetadataLifecycleHost({ store: { run: run => run(database), transaction: run => run(database), serializeWrites: run => run() }, loadContext,
      registry: { discover: () => [] }, updates: { registry: { discover: () => [] },
        async update(_, result, reason) { calls.push({ action: 'update', key: keyFor(result.Item), item: nativeProject(result.Item), reason }); return []; } },
      async refreshOwnedItem(_, childId, options, inheritance) {
        const child = typeof childId === 'object' ? childId : state.byId.get(idKey(childId));
        const prepared = prepareOwnedItemRefresh(owner, child, options, inheritance);
        calls.push({ action: 'refresh', key: child.key, item: nativeProject(child), options: {
          ForceSave: prepared.ForceSave, MetadataRefreshMode: prepared.MetadataRefreshMode, ImageRefreshMode: prepared.ImageRefreshMode,
          ReplaceAllMetadata: prepared.ReplaceAllMetadata, hasSearchResult: prepared.SearchResult != null }, cancellationRequested: options.signal?.aborted ?? false });
        if (sample.failRefresh === child.key) throw new Error('Injected child provider failure');
        options.signal?.throwIfAborted();
      } });
    // Native UpsertLinkedChild records its invocation even when the row exists.
    const transaction = lifecycle.store.transaction;
    lifecycle.store.transaction = async run => {
      const output = await transaction(run);
      calls.push({ action: 'link', parent: 'owner', child: 'alternate', childType: 2 });
      return output;
    };
    const options = { ForceSave: false, MetadataRefreshMode: 'None', ImageRefreshMode: 'None', ReplaceAllMetadata: false,
      SearchResult: { Name: 'Owner search' }, ...sample.options };
    if (sample.cancelled) options.signal = AbortSignal.abort(new Error('Controlled native cancellation'));
    let requiresSave = false;
    try { requiresSave = await lifecycle.beforeRefresh(await loadContext(owner.Id), options); }
    catch (error) { assert.equal(error.message, sample.cancelled ? 'Controlled native cancellation' : 'Injected child provider failure'); }
    const expected = native.results.find(value => value.name === sample.name);
    const nativeCalls = expected.calls.filter(call => call.action !== 'images' && !(call.action === 'refresh' && call.key === 'owner'));
    const normalizeDates = value => {
      const copy = structuredClone(value);
      for (const call of copy) if (call.item?.PremiereDate != null) call.item.PremiereDate = dateText(call.item.PremiereDate);
      return copy;
    };
    assert.deepEqual(calls, normalizeDates(nativeCalls));
    assert.equal(requiresSave || options.ForceSave, expected.calls.find(call => call.action === 'refresh' && call.key === 'owner').options.ForceSave);
    assert.deepEqual(links.map(link => items.find(item => item.Id === link.ChildId).key), expected.links);
    assert.deepEqual(items.map(item => ({ key: item.key, item: nativeProject(item) })),
      expected.items.map(value => ({ key: value.key, item: { ...value.item,
        PremiereDate: value.item.PremiereDate == null ? null : dateText(value.item.PremiereDate) } })));
  });
}

const ownerId = '97c70000-0000-0000-0000-000000000001';
const folderId = '97c70000-0000-0000-0000-000000000002';
const identityRoot = 'Z:\\ChildrenMetadata\\Film';
const itemPath = name => `${identityRoot}\\${name}`;
const title = { Genres: ['Drama'], Studios: ['Studio'], ProductionLocations: ['Taiwan'], Overview: 'Owner overview',
  CommunityRating: 7.5, CriticRating: 88, OfficialRating: 'PG', CustomRating: 'TV-14', ProductionYear: 2025,
  PremiereDate: '2025-01-01T00:00:00.0000001Z' };
const noMetadata = { MetadataRefreshMode: 'None', ImageRefreshMode: 'None', SearchResult: { Name: 'Only owner search' } };

async function seedFamily(fixture, { parts = false, alternates = false, extras = false, mixed = false,
  alternateMixed = mixed, alternatePrimary = true, links = alternates, newExtra = false } = {}) {
  const identify = (name, type) => getNewItemId(itemPath(name), type, { programDataPath: fixture.stateRoot });
  const partId = identify('Film cd2.mkv', 'MediaBrowser.Controller.Entities.Video');
  const alternateId = identify('Film - 4K.mkv', 'MediaBrowser.Controller.Entities.Movies.Movie');
  const extraId = identify('Film-trailer.mkv', 'MediaBrowser.Controller.Entities.Trailer');
  const alternateExtraId = identify('Film - 4K-trailer.mkv', 'MediaBrowser.Controller.Entities.Trailer');
  const items = [
    { key: 'folder', type: 'Folder', Id: folderId, Path: 'Z:\\ChildrenMetadata', Name: 'Root' },
    { key: 'owner', type: 'Movie', Id: ownerId, parent: 'folder', Path: itemPath('Film.mkv'), Name: 'Film',
      ...title, IsInMixedFolder: mixed, PresentationUniqueKey: idKey(ownerId),
      AdditionalParts: parts ? [itemPath('Film cd2.mkv')] : [], LocalAlternateVersions: alternates ? [itemPath('Film - 4K.mkv')] : [] }
  ];
  if (parts) items.push({ key: 'part', type: 'Video', Id: partId, parent: 'folder', OwnerId: ownerId,
    Path: itemPath('Film cd2.mkv'), Name: 'Part', IsInMixedFolder: mixed, Genres: ['Part genre'],
    Overview: 'Part overview', ProductionYear: 1990, PresentationUniqueKey: partId, Tags: ['Retain part tag'], IsLocked: true });
  if (alternates) items.push({ key: 'alternate', type: 'Movie', Id: alternateId, parent: 'folder', OwnerId: ownerId,
    PrimaryVersionId: alternatePrimary ? ownerId : null, Path: itemPath('Film - 4K.mkv'), Name: 'Alternate',
    IsInMixedFolder: alternateMixed, Genres: ['Alternate genre'], Overview: 'Alternate overview', ProductionYear: 1991,
    PresentationUniqueKey: alternatePrimary ? idKey(ownerId) : alternateId });
  if (extras) {
    items.push({ key: 'extra', type: 'Trailer', Id: extraId, OwnerId: ownerId, Path: itemPath('Film-trailer.mkv'),
      Name: 'Trailer', ExtraType: 2, Genres: ['Extra genre'], Overview: 'Extra overview', ProductionYear: 1992,
      DateLastRefreshed: newExtra ? MIN_DATE : fixture.now, PresentationUniqueKey: extraId });
    if (alternates) items.push({ key: 'alternateExtra', type: 'Trailer', Id: alternateExtraId, OwnerId: alternateId,
      Path: itemPath('Film - 4K-trailer.mkv'), Name: 'Alternate trailer', ExtraType: 2, Genres: ['Alt extra genre'],
      Overview: 'Alt extra overview', ProductionYear: 1993, PresentationUniqueKey: alternateExtraId });
  }
  await fixture.seed({ target: 'owner', items });
  if (links) await fixture.database.insert('LinkedChildren', { ParentId: ownerId, ChildId: alternateId, ChildType: 2, SortOrder: 0 });
  await fixture.adapter.mkdir('/aggregate');
  await fixture.adapter.mkdir('/aggregate/Film');
  for (const item of items.filter(item => item.type !== 'Folder')) {
    await fixture.adapter.write('/aggregate/Film/' + item.Path.split('\\').at(-1), Buffer.from('media'));
  }
  return { partId, alternateId, extraId, alternateExtraId };
}

const dialects = ['postgres'];
for (const dialect of dialects) {
  const databaseTest = (name, run, options = {}) => test(`${dialect}: ${name}`, {
    ...options
  }, run);

  databaseTest('owner pre-refresh dispatch inherits locked parts but does not copy alternate title metadata', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const ids = await seedFamily(fixture, { parts: true, alternates: true, mixed: true });
    const beforeAlternate = (await fixture.loadContext(ids.alternateId)).item;
    let alternateAtDispatch;
    const refreshOwnedItem = fixture.host.refreshOwnedItem.bind(fixture.host);
    fixture.host.refreshOwnedItem = async (...args) => {
      if (idKey(args[1]) === ids.alternateId) alternateAtDispatch = (await fixture.loadContext(ids.alternateId)).item;
      return refreshOwnedItem(...args);
    };
    const events = [];
    fixture.host.updates.on('ItemUpdated', event => events.push(event));
    const result = await fixture.host.refresh(ownerId, noMetadata);
    const part = (await fixture.loadContext(ids.partId)).item;
    for (const field of Object.keys(title)) {
      if (field === 'PremiereDate') assert.equal(dateTicks(part[field]), dateTicks(title[field]));
      else assert.deepEqual(part[field], title[field], field);
    }
    assert.equal(part.Name, 'Part');
    assert.deepEqual(part.Tags, ['Retain part tag']);
    assert.equal(part.IsLocked, true);
    for (const field of ['Genres', 'Overview', 'ProductionYear', 'PremiereDate']) assert.deepEqual(alternateAtDispatch[field], beforeAlternate[field]);
    assert.equal(events.filter(event => idKey(event.Item.Id) === ids.partId).length, 1);
    assert.equal(events.some(event => idKey(event.Item.Id) === idKey(ownerId)), result.changed);
    assert.deepEqual((await fixture.database.rows('LinkedChildren')).map(row => row.ChildType), [2]);
    assert.deepEqual(noMetadata.SearchResult, { Name: 'Only owner search' });
  });

  databaseTest('stable extras only inherit dates and do not invoke their providers', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { extraId } = await seedFamily(fixture, { extras: true });
    let childCalls = 0;
    const refreshOwnedItem = fixture.host.refreshOwnedItem.bind(fixture.host);
    fixture.host.refreshOwnedItem = (...args) => { childCalls++; return refreshOwnedItem(...args); };
    const events = [];
    fixture.host.updates.on('ItemUpdated', event => events.push(event));
    await fixture.host.refresh(ownerId, noMetadata);
    const extra = (await fixture.loadContext(extraId)).item;
    assert.equal(childCalls, 0);
    assert.equal(extra.ProductionYear, 2025);
    assert.equal(dateTicks(extra.PremiereDate), dateTicks(title.PremiereDate));
    assert.deepEqual(extra.Genres, ['Extra genre']);
    assert.equal(extra.Overview, 'Extra overview');
    assert.deepEqual(events.filter(event => idKey(event.Item.Id) === extraId).map(event => event.UpdateReason), [16]);
    const stable = (await fixture.database.rows('BaseItems', { where: { Id: extraId } }))[0];
    events.length = 0;
    await fixture.host.refresh(ownerId, noMetadata);
    assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: extraId } }))[0], stable);
    assert.equal(events.some(event => idKey(event.Item.Id) === extraId), false);
  });

  databaseTest('refresh persists inherited ratings before providers and recalculates a changed rating at the successful stamp', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    await seedFamily(fixture, { mixed: true });
    await fixture.database.update('BaseItems', { Id: ownerId }, {
      OfficialRating: 'PG', CustomRating: null, PreferredMetadataCountryCode: 'US'
    });
    const first = await fixture.host.refresh(ownerId, noMetadata);
    assert.equal(first.changed, true);
    const [beforeProviders] = await fixture.database.rows('BaseItems', { where: { Id: ownerId } });
    assert.deepEqual([beforeProviders.OfficialRating, beforeProviders.InheritedParentalRatingValue,
      beforeProviders.InheritedParentalRatingSubValue], ['PG', 10, 0]);
    fixture.registry.register({ id: 'changed-rating', name: 'Changed rating', providers: [{
      id: 'rating', name: 'Changed rating', kind: 'custom', itemTypes: ['Movie'],
      hasChanged: async () => true,
      async fetch(item) { item.OfficialRating = 'TV-14-D'; return 1; }
    }] });
    const second = await fixture.host.refresh(ownerId, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    assert.equal(second.changed, true); assert.equal(second.Failures, 0);
    const [afterProviders] = await fixture.database.rows('BaseItems', { where: { Id: ownerId } });
    assert.deepEqual([afterProviders.OfficialRating, afterProviders.InheritedParentalRatingValue,
      afterProviders.InheritedParentalRatingSubValue], ['TV-14-D', 14, 1]);
  });

  for (const options of [{ MetadataRefreshMode: 'FullRefresh' }, { MetadataRefreshMode: 'None', ReplaceAllMetadata: true }]) {
    databaseTest(`extras of every linked local version inherit the primary title on ${options.ReplaceAllMetadata ? 'replacement' : 'full refresh'}`, async t => {
      const fixture = await setupChildrenFixture(t, dialect);
      const { extraId, alternateExtraId } = await seedFamily(fixture, { extras: true, alternates: true });
      const refreshed = [];
      const refreshOwnedItem = fixture.host.refreshOwnedItem.bind(fixture.host);
      fixture.host.refreshOwnedItem = (owner, child, values, inheritance) => {
        refreshed.push({ owner, child, inheritance });
        return refreshOwnedItem(owner, child, values, inheritance);
      };
      await fixture.host.refresh(ownerId, { ...noMetadata, ...options });
      for (const reference of [extraId, alternateExtraId]) {
        const extra = (await fixture.loadContext(reference)).item;
        assert.deepEqual(extra.Genres, title.Genres);
        assert.equal(extra.Overview, title.Overview);
        assert.equal(extra.ProductionYear, title.ProductionYear);
        assert.equal(refreshed.some(call => idKey(typeof call.child === 'object' ? call.child.Id : call.child) === reference && call.inheritance.copyTitleMetadata), true);
      }
    });
  }

  databaseTest('mixed alternate import precedes its independent refresh and does not duplicate its link', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { alternateId } = await seedFamily(fixture, { alternates: true, mixed: true, alternateMixed: false });
    const actions = [];
    fixture.host.updates.on('ItemUpdated', event => actions.push({ action: 'save', id: idKey(event.Item.Id), reason: event.UpdateReason }));
    const refreshOwnedItem = fixture.host.refreshOwnedItem.bind(fixture.host);
    fixture.host.refreshOwnedItem = (...args) => { actions.push({ action: 'refresh', id: idKey(args[1]) }); return refreshOwnedItem(...args); };
    await fixture.host.refresh(ownerId, noMetadata);
    assert.deepEqual(actions.filter(action => action.id === alternateId).slice(0, 2), [
      { action: 'save', id: alternateId, reason: 2 }, { action: 'refresh', id: alternateId }
    ]);
    assert.equal((await fixture.loadContext(alternateId)).item.IsInMixedFolder, true);
    assert.equal((await fixture.database.rows('LinkedChildren')).length, 1);
  });

  databaseTest('a missing local-version link is repaired and forces the owner save', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { alternateId } = await seedFamily(fixture, { alternates: true, mixed: true, links: false });
    const result = await fixture.host.refresh(ownerId, noMetadata);
    assert.equal(result.changed, true);
    assert.ok(result.UpdateType & 8);
    const [link] = await fixture.database.rows('LinkedChildren');
    assert.equal(idKey(link.ParentId), idKey(ownerId));
    assert.equal(idKey(link.ChildId), alternateId);
    assert.equal(link.ChildType, 2);
  });

  databaseTest('a missing alternate primary is repaired by MetadataEdit after child refresh and link upsert', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { alternateId } = await seedFamily(fixture, { alternates: true, mixed: true, alternatePrimary: false });
    const actions = [];
    fixture.host.updates.on('ItemUpdated', event => {
      if (idKey(event.Item.Id) === alternateId) actions.push({ action: 'save', reason: event.UpdateReason });
    });
    const refreshOwnedItem = fixture.host.refreshOwnedItem.bind(fixture.host);
    fixture.host.refreshOwnedItem = (...args) => { actions.push({ action: 'refresh' }); return refreshOwnedItem(...args); };
    await fixture.host.refresh(ownerId, noMetadata);
    assert.deepEqual(actions, [{ action: 'refresh' }, { action: 'save', reason: 16 }, { action: 'save', reason: 8 }]);
    const alternate = (await fixture.loadContext(alternateId)).item;
    assert.equal(idKey(alternate.PrimaryVersionId), idKey(ownerId));
    assert.equal(alternate.PresentationUniqueKey, idKey(ownerId));
    assert.equal((await fixture.database.rows('LinkedChildren')).length, 1);
  });

  databaseTest('parallel alternate link repairs advance the shared owner baseline only after their commits', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { alternateId } = await seedFamily(fixture, { alternates: true, mixed: true, links: false });
    const secondPath = itemPath('Film - 1080p.mkv');
    const secondId = getNewItemId(secondPath, 'MediaBrowser.Controller.Entities.Movies.Movie', { programDataPath: fixture.stateRoot });
    const source = (await fixture.database.rows('BaseItems', { where: { Id: alternateId } }))[0];
    await fixture.database.insert('BaseItems', { ...source, Id: secondId, Path: secondPath });
    const ownerRow = (await fixture.database.rows('BaseItems', { where: { Id: ownerId } }))[0];
    const data = parseLosslessJson(ownerRow.Data); data.LocalAlternateVersions.push(secondPath);
    await fixture.database.update('BaseItems', { Id: ownerId }, { Data: JSON.stringify(data) });
    await fixture.adapter.write('/aggregate/Film/Film - 1080p.mkv', Buffer.from('media'));
    const errors = []; fixture.host.logger = { error: error => errors.push(error) };
    const result = await fixture.host.refresh(ownerId, noMetadata);
    assert.equal(result.changed, true); assert.equal(errors.length, 0);
    const current = await fixture.loadContext(ownerId);
    assert.deepEqual(await current.getLocalAlternateVersionIds(), [alternateId, secondId]);
    assert.deepEqual(current.versionLinks.map(row => [row.ChildId, row.ChildType, row.SortOrder]),
      [[alternateId, 2, 0], [secondId, 2, 1]]);
  });
  databaseTest('a primary acquired between missing-primary reads is not overwritten by the repair', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { alternateId } = await seedFamily(fixture, { alternates: true, mixed: true, alternatePrimary: false });
    const original = fixture.loadContext; let childReads = 0;
    const competingPrimary = '97c70000-0000-0000-0000-000000000090';
    fixture.host.ownedLifecycle.loadContext = async reference => {
      if (idKey(reference) === idKey(alternateId) && ++childReads === 2) {
        await fixture.database.update('BaseItems', { Id: alternateId }, { PrimaryVersionId: competingPrimary,
          PresentationUniqueKey: 'Competing primary key' });
      }
      return original(reference);
    };
    // Keep the dispatch controlled so these two reads are precisely the
    // post-link check and the authoritative setter reload, not provider reads.
    fixture.host.ownedLifecycle.refreshOwnedItem = async () => {};
    const loaded = await original(ownerId);
    await assert.rejects(fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), {
      code: 'metadata-conflict', status: 409
    });
    const child = (await original(alternateId)).item;
    assert.equal(idKey(child.PrimaryVersionId), idKey(competingPrimary));
    assert.equal(child.PresentationUniqueKey, 'Competing primary key');
  });
  databaseTest('an existing extra with MinValue refresh date still follows the native stable date-only branch', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { extraId } = await seedFamily(fixture, { extras: true, newExtra: true });
    let refreshes = 0;
    fixture.host.refreshOwnedItem = () => { refreshes++; throw new Error('The native date-only branch must not refresh this extra.'); };
    await fixture.host.refresh(ownerId, noMetadata);
    assert.equal(refreshes, 0);
    const extra = (await fixture.loadContext(extraId)).item;
    assert.equal(extra.Overview, 'Extra overview');
    assert.equal(extra.ProductionYear, title.ProductionYear);
    assert.equal(dateTicks(extra.DateLastRefreshed), 0n);
  });

  databaseTest('probe persistence retains pre-refresh inherited fields unless the probe actually replaces them', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId } = await seedFamily(fixture, { parts: true, mixed: true });
    fixture.host.probe = {
      supportsMetadata: item => idKey(item.Id) === partId,
      hasChanged: async () => true,
      async refreshMetadata(loaded) {
        await fixture.database.update('BaseItems', { Id: loaded.item.Id }, { Size: 501n, RunTimeTicks: 9007199254740999n,
          CommunityRating: 9.5 });
        return { changed: true, UpdateType: 2 };
      }
    };
    await fixture.host.refresh(ownerId, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
    const part = (await fixture.loadContext(partId)).item;
    assert.deepEqual(part.Genres, title.Genres);
    assert.deepEqual(part.Studios, title.Studios);
    assert.equal(part.Overview, title.Overview);
    assert.equal(part.CommunityRating, 9.5);
    assert.equal(part.RunTimeTicks, 9007199254740999n);
  });

  databaseTest('the owned image wrapper runs before providers without the refresh request token', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    await seedFamily(fixture, { mixed: true });
    const actions = [];
    const updateImages = fixture.host.images.updateImages.bind(fixture.host.images);
    fixture.host.images.updateImages = (loaded, images, options) => {
      actions.push('images');
      assert.equal(Object.hasOwn(options, 'signal'), false);
      return updateImages(loaded, images, options);
    };
    fixture.registry.register({ id: 'owned-order', name: 'Owned order', providers: [{ id: 'provider', name: 'Provider',
      kind: 'custom', itemTypes: ['Movie'], hasChanged: async () => true,
      fetch() { actions.push('provider'); return 1; }
    }] });
    const controller = new AbortController();
    await fixture.host.refresh(ownerId, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None', signal: controller.signal });
    assert.deepEqual(actions.slice(0, 2), ['images', 'provider']);
    assert.deepEqual(actions.slice(2), ['images']);
  });

  databaseTest('a failed owned image wrapper retains an already-required owner force-save', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    await seedFamily(fixture, { alternates: true, mixed: true, links: false });
    const logs = [];
    fixture.host.logger = { error(error, message) { logs.push({ error, message }); } };
    const updateImages = fixture.host.images.updateImages.bind(fixture.host.images);
    let ownerImageCalls = 0;
    fixture.host.images.updateImages = (loaded, images, options) => {
      if (idKey(loaded.item.Id) === idKey(ownerId) && ++ownerImageCalls === 1) throw new Error('Injected owned image failure');
      return updateImages(loaded, images, options);
    };
    const result = await fixture.host.refresh(ownerId, noMetadata);
    assert.equal(result.changed, true);
    assert.ok(result.UpdateType & 8);
    assert.equal(ownerImageCalls, 2);
    assert.equal(logs.some(log => log.message === 'Error refreshing owned items' && /Injected owned image/u.test(log.error.message)), true);
  });

  databaseTest('native virtual support gates skip Audio and a single Episode but include a parentless UserRootFolder', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const audioId = '97c70000-0000-0000-0000-000000000071';
    const episodeId = '97c70000-0000-0000-0000-000000000072';
    const userRootId = '97c70000-0000-0000-0000-000000000073';
    await fixture.seed({ target: 'audio', items: [
      { key: 'folder', type: 'Folder', Id: folderId, Path: 'Z:\\ChildrenMetadata' },
      { key: 'audio', type: 'Audio', Id: audioId, parent: 'folder', Path: itemPath('song.mp3'), PresentationUniqueKey: idKey(audioId) },
      { key: 'episode', type: 'Episode', Id: episodeId, parent: 'folder', Path: itemPath('episode.mkv'),
        PresentationUniqueKey: idKey(episodeId), AdditionalParts: [], LocalAlternateVersions: [] },
      { key: 'root', type: 'UserRootFolder', Id: userRootId, PresentationUniqueKey: idKey(userRootId) }
    ] });
    fixture.host.supportedItemTypes = [...fixture.host.supportedItemTypes, 'Audio'];
    const wrappers = [];
    const beforeRefresh = fixture.host.ownedLifecycle.beforeRefresh.bind(fixture.host.ownedLifecycle);
    fixture.host.ownedLifecycle.beforeRefresh = (loaded, options) => {
      wrappers.push(idKey(loaded.item.Id)); return beforeRefresh(loaded, options);
    };
    for (const reference of [audioId, episodeId, userRootId]) await fixture.host.refresh(reference, noMetadata);
    assert.deepEqual(wrappers, [idKey(userRootId)]);
  });

  databaseTest('multiple owned-wrapper remote image saves advance the owner conflict baseline', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    await seedFamily(fixture, { mixed: true });
    const bytes = await readFile(new URL('../images/fixtures/processor/original-http.png', import.meta.url));
    let requests = 0;
    fixture.host.images.fetch = async () => { requests++; return new Response(bytes, { headers: { 'content-type': 'image/png' } }); };
    for (const [index, ImageType] of [0, 2].entries()) await fixture.database.insert('BaseItemImageInfos', {
      Id: `97c70000-0000-0000-0000-00000000008${index}`, ItemId: ownerId, ImageType,
      Path: `https://isolated.invalid/${ImageType}.png`, DateModified: MIN_DATE, Width: 0, Height: 0, Blurhash: null
    });
    const events = [];
    fixture.host.updates.on('ItemUpdated', event => events.push(event));
    const logs = [];
    fixture.host.logger = { error(error, message) { logs.push({ error, message }); } };
    const result = await fixture.host.refresh(ownerId, noMetadata);
    assert.equal(result.Failures, 0);
    assert.equal(requests, 2);
    assert.equal(logs.length, 0);
    assert.deepEqual(events.slice(0, 2).map(event => event.UpdateReason), [4, 4]);
    const images = (await fixture.loadContext(ownerId)).context.images;
    assert.equal(images.length, 2);
    assert.equal(images.every(image => !image.Path.startsWith('http') && image.Width === 1 && image.Height === 1), true);
  });

  databaseTest('an alternate ownership change after child refresh cannot replace a manual link', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { alternateId } = await seedFamily(fixture, { alternates: true, mixed: true, links: false });
    const otherOwnerId = '97c70000-0000-0000-0000-000000000009';
    const ownerRow = (await fixture.database.rows('BaseItems', { where: { Id: ownerId } }))[0];
    await fixture.database.insert('BaseItems', { ...ownerRow, Id: otherOwnerId, ParentId: null, Path: null });
    await fixture.database.insert('LinkedChildren', { ParentId: ownerId, ChildId: alternateId, ChildType: 0, SortOrder: 0 });
    const logs = [];
    fixture.host.logger = { error(error) { logs.push(error); } };
    const refreshOwnedItem = fixture.host.refreshOwnedItem.bind(fixture.host);
    fixture.host.refreshOwnedItem = async (...args) => {
      const result = await refreshOwnedItem(...args);
      await fixture.database.update('BaseItems', { Id: alternateId }, { OwnerId: otherOwnerId });
      return result;
    };
    await assert.rejects(fixture.host.refresh(ownerId, noMetadata), { nativeException: 'InvalidOperationException' });
    assert.equal((await fixture.database.rows('LinkedChildren'))[0].ChildType, 0);
    assert.equal(logs.some(error => error.code === 'metadata-conflict' && /before its link update/u.test(error.message)), true);
    assert.equal(idKey((await fixture.loadContext(alternateId)).item.OwnerId), idKey(otherOwnerId));
  });

  databaseTest('cyclic owned path arrays fail without waiting on an active ancestor', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const identify = name => getNewItemId(itemPath(name), 'MediaBrowser.Controller.Entities.Video', { programDataPath: fixture.stateRoot });
    const firstId = identify('Film.mkv'), secondId = identify('Film cd2.mkv');
    await fixture.seed({ target: 'first', items: [
      { key: 'folder', type: 'Folder', Id: folderId, Path: 'Z:\\ChildrenMetadata' },
      { key: 'first', type: 'Video', Id: firstId, parent: 'folder', Path: itemPath('Film.mkv'),
        IsInMixedFolder: true, AdditionalParts: [itemPath('Film cd2.mkv')], PresentationUniqueKey: firstId },
      { key: 'second', type: 'Video', Id: secondId, parent: 'folder', OwnerId: firstId, Path: itemPath('Film cd2.mkv'),
        IsInMixedFolder: true, AdditionalParts: [itemPath('Film.mkv')], PresentationUniqueKey: secondId }
    ] });
    await fixture.database.update('BaseItems', { Id: firstId }, { OwnerId: secondId });
    await fixture.adapter.mkdir('/aggregate'); await fixture.adapter.mkdir('/aggregate/Film');
    for (const name of ['Film.mkv', 'Film cd2.mkv']) await fixture.adapter.write('/aggregate/Film/' + name, Buffer.from('media'));
    const logs = [];
    fixture.host.logger = { error(error) { logs.push(error); } };
    const result = await fixture.host.refresh(firstId, noMetadata);
    assert.equal(result.changed, false);
    assert.equal(logs.some(error => error.code === 'metadata-conflict' && /active ancestor/u.test(error.message)), true);
  }, { timeout: 5000 });

  databaseTest('owned refresh failure preserves earlier child saves and still refreshes the owner', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId, alternateId } = await seedFamily(fixture, { parts: true, alternates: true, mixed: true });
    const logs = [];
    fixture.host.logger = { error(error, message) { logs.push({ error, message }); } };
    const refreshOwnedItem = fixture.host.refreshOwnedItem.bind(fixture.host);
    fixture.host.refreshOwnedItem = (owner, child, ...values) => idKey(child) === alternateId
      ? Promise.reject(new Error('Injected alternate refresh failure')) : refreshOwnedItem(owner, child, ...values);
    const result = await fixture.host.refresh(ownerId, { ...noMetadata, ForceSave: true });
    assert.equal(result.changed, true);
    assert.equal((await fixture.loadContext(partId)).item.Overview, title.Overview);
    assert.equal(logs.some(log => log.message === 'Error refreshing owned items' && /Injected alternate/u.test(log.error.message)), true);
    assert.equal((await fixture.database.rows('LinkedChildren')).length, 1);
  });

  databaseTest('missing owned parts delete independently without rewriting the owner path array', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId } = await seedFamily(fixture, { parts: true, mixed: true });
    await fixture.adapter.delete('/aggregate/Film/Film cd2.mkv');
    const loaded = await fixture.loadContext(ownerId), part = await loaded.videoVersionDiscovery.lookup(loaded, partId);
    const beforeOwner = (await fixture.database.rows('BaseItems', { where: { Id: ownerId } }))[0];
    const assets = new MetadataImageAssets({fileSystem: testFileSystem,  vfs: fixture.vfs, identityMap: fixture.identityMap,
      metadataPath: loaded.metadataPath, stateRoots: [loaded.dataPath] });
    const marker = path.join(internalImagePath(part, loaded.metadataPath), 'marker.txt');
    await assets.write(marker, Buffer.from('owned metadata'));
    await fixture.database.insert('MediaSegments', { Id: '97c70000-0000-0000-0000-000000000099',
      ItemId: partId, SegmentProviderId: 'owned-test', StartTicks: 9007199254740999n, EndTicks: 9007199254741999n, Type: 0 });
    const events = []; fixture.host.updates.on('ItemRemoved', event => events.push(event));
    const result = await fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata);
    assert.equal(result, false);
    assert.deepEqual(loaded.item.AdditionalParts, [itemPath('Film cd2.mkv')]);
    assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: ownerId } }))[0], beforeOwner);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: partId } })).length, 0);
    assert.equal((await fixture.database.rows('MediaSegments')).length, 0);
    assert.equal(loaded.versionItemCache.has(idKey(partId)), false);
    assert.equal(events.length, 1);
    assert.equal(idKey(events[0].Parent.Id), idKey(ownerId));
    assert.equal(events[0].Item.ParentId, EMPTY_ID);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
    assert.equal((await fixture.adapter.stat('/aggregate/Film/Film.mkv')).kind, 'file');
  });

  databaseTest('missing alternate paths are removed before the later owner SaveItems orphan deletion', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { alternateId } = await seedFamily(fixture, { alternates: true, mixed: true });
    await fixture.adapter.delete('/aggregate/Film/Film - 4K.mkv');
    const loaded = await fixture.loadContext(ownerId);
    const beforeOwner = loaded.snapshot;
    const events = []; fixture.host.updates.on('ItemRemoved', event => events.push(event));
    assert.equal(await fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), true);
    assert.deepEqual(loaded.item.LocalAlternateVersions, []);
    assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: ownerId } }))[0], beforeOwner);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: alternateId } })).length, 1);
    assert.equal((await fixture.database.rows('LinkedChildren')).length, 1);
    const result = await fixture.host.refresh(ownerId, noMetadata);
    assert.equal(result.changed, true);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: alternateId } })).length, 0);
    assert.equal((await fixture.database.rows('LinkedChildren')).length, 0);
    assert.equal(events.length, 0);
  });

  databaseTest('already-cancelled refresh completes missing-part cleanup before rejecting the owner provider', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId, alternateId } = await seedFamily(fixture, { parts: true, alternates: true, mixed: true });
    for (const name of ['Film cd2.mkv', 'Film - 4K.mkv']) await fixture.adapter.delete('/aggregate/Film/' + name);
    const beforeOwner = (await fixture.database.rows('BaseItems', { where: { Id: ownerId } }))[0];
    const events = []; fixture.host.updates.on('ItemRemoved', event => events.push(event));
    const signal = AbortSignal.abort(new Error('Controlled owner cancellation'));
    await assert.rejects(fixture.host.refresh(ownerId, { ...noMetadata, signal }), /Controlled owner cancellation/u);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: partId } })).length, 0);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: alternateId } })).length, 1);
    assert.equal((await fixture.database.rows('LinkedChildren')).length, 1);
    assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: ownerId } }))[0], beforeOwner);
    assert.deepEqual(events.map(event => idKey(event.Item.Id)), [idKey(partId)]);
  });

  databaseTest('missing owned cleanup rolls back SQL while retaining earlier metadata-file deletion', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId } = await seedFamily(fixture, { parts: true, mixed: true });
    await fixture.adapter.delete('/aggregate/Film/Film cd2.mkv');
    const loaded = await fixture.loadContext(ownerId), part = await loaded.videoVersionDiscovery.lookup(loaded, partId);
    const before = await fixture.database.rows('BaseItems');
    const assets = new MetadataImageAssets({fileSystem: testFileSystem,  vfs: fixture.vfs, identityMap: fixture.identityMap,
      metadataPath: loaded.metadataPath, stateRoots: [loaded.dataPath] });
    const marker = path.join(internalImagePath(part, loaded.metadataPath), 'marker.txt');
    await assets.write(marker, Buffer.from('owned metadata'));
    await fixture.database.client.query(`CREATE FUNCTION owned_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Controlled owned delete failure'; END $$`);
    await fixture.database.client.query(`CREATE TRIGGER owned_delete_failure BEFORE DELETE ON "BaseItems"
      FOR EACH ROW EXECUTE FUNCTION owned_delete_failure()`);
    const events = []; fixture.host.updates.on('ItemRemoved', event => events.push(event));
    await assert.rejects(fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), /Controlled owned delete failure/u);
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
    assert.equal(loaded.versionItemCache.has(idKey(partId)), true);
    assert.equal(events.length, 0);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
    await fixture.database.update('BaseItems', { Id: partId }, { Type: 'Removed.Plugin.UnknownItem' });
    loaded.versionItemCache.delete(idKey(partId));
    // A failed native DeleteItem keeps its authoritative warm cache entry.
    // A direct SQL type edit does not change that already captured Video.
    assert.equal((await loaded.videoVersionDiscovery.lookup(loaded, partId))?.NativeType, nativeTypeName('Video'));
    // The original null assertion describes a subsequent actual cold lookup.
    fixture.library.itemCreation.unregisterItem(partId);
    await fixture.linkedChildren.flushReleases();
    loaded.versionItemCache.delete(idKey(partId));
    assert.equal(await loaded.videoVersionDiscovery.lookup(loaded, partId), null);
    await assert.rejects(loaded.videoVersionDiscovery.removeMissingOwnedItem(loaded, part), { code: 'metadata-conflict' });
  });

  databaseTest('missing files never delete an independently owned part', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId } = await seedFamily(fixture, { parts: true, mixed: true });
    await fixture.database.update('BaseItems', { Id: partId }, { OwnerId: folderId });
    await fixture.adapter.delete('/aggregate/Film/Film cd2.mkv');
    const before = (await fixture.database.rows('BaseItems', { where: { Id: partId } }))[0];
    assert.equal(await fixture.host.ownedLifecycle.beforeRefresh(await fixture.loadContext(ownerId), noMetadata), false);
    assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: partId } }))[0], before);
  });

  databaseTest('a storage failure is not interpreted as missing owned media', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId } = await seedFamily(fixture, { parts: true, mixed: true });
    const loaded = await fixture.loadContext(ownerId);
    loaded.ownedFileExists = async () => { throw new Error('Controlled storage unavailable'); };
    await assert.rejects(fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), /Controlled storage unavailable/u);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: partId } })).length, 1);
  });

  for (const missing of [false, true]) databaseTest(`owned existence checks honor item ID bindings with missing=${missing}`, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId, alternateId } = await seedFamily(fixture, { parts: true, alternates: true, mixed: true });
    const identityMap = new IdentityAccessMap();
    for (const [id, accessPath] of [[folderId, '/fixture/aggregate'], [ownerId, '/fixture/aggregate/Film/Film.mkv'],
      [partId, '/fixture/aggregate/Film/Film cd2.mkv'], [alternateId, '/fixture/aggregate/Film/Film - 4K.mkv']]) identityMap.bind(id, accessPath);
    const loadContext = ownedLoader(fixture,{identityMap});
    fixture.host.loadContext = fixture.host.ownedLifecycle.loadContext = loadContext;
    if (missing) for (const name of ['Film cd2.mkv', 'Film - 4K.mkv']) await fixture.adapter.delete('/aggregate/Film/' + name);
    const loaded = await loadContext(ownerId);
    const removed = []; fixture.host.updates.on('ItemRemoved', event => removed.push(idKey(event.Item.Id)));
    assert.equal(await fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), missing);
    assert.deepEqual(loaded.item.LocalAlternateVersions, missing ? [] : [itemPath('Film - 4K.mkv')]);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: partId } })).length, missing ? 0 : 1);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: alternateId } })).length, 1);
    assert.deepEqual(removed, missing ? [idKey(partId)] : []);
  });

  databaseTest('an absent access mapping is not interpreted as a missing owned file', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId } = await seedFamily(fixture, { parts: true, mixed: true });
    const identityMap = new IdentityAccessMap();
    identityMap.bind(folderId, '/fixture/aggregate'); identityMap.bind(ownerId, '/fixture/aggregate/Film/Film.mkv');
    const loaded = await ownedLoader(fixture,{identityMap})(ownerId);
    const before = await fixture.database.rows('BaseItems');
    await assert.rejects(fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), {
      code: 'not-found', message: 'No access mapping resolves the identity path.'
    });
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: partId } })).length, 1);
  });

  databaseTest('duplicate missing-part paths emit a single removal and do not reject the owner', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId } = await seedFamily(fixture, { parts: true, mixed: true });
    await fixture.adapter.delete('/aggregate/Film/Film cd2.mkv');
    const loaded = await fixture.loadContext(ownerId);
    loaded.item.AdditionalParts.push(itemPath('Film cd2.mkv'));
    const events = []; fixture.host.updates.on('ItemRemoved', event => events.push(event));
    assert.equal(await fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), false);
    assert.deepEqual(events.map(event => idKey(event.Item.Id)), [idKey(partId)]);
    assert.equal(loaded.item.AdditionalParts.length, 2);
  });

  databaseTest('missing-part cleanup rejects an ownership cycle before deleting any files', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId } = await seedFamily(fixture, { parts: true, mixed: true });
    await fixture.adapter.delete('/aggregate/Film/Film cd2.mkv');
    await fixture.database.update('BaseItems', { Id: ownerId }, { OwnerId: partId });
    const loaded = await fixture.loadContext(ownerId), part = await loaded.videoVersionDiscovery.lookup(loaded, partId);
    const assets = new MetadataImageAssets({fileSystem: testFileSystem,  vfs: fixture.vfs, identityMap: fixture.identityMap,
      metadataPath: loaded.metadataPath, stateRoots: [loaded.dataPath] });
    const marker = path.join(internalImagePath(part, loaded.metadataPath), 'marker.txt');
    await assets.write(marker, Buffer.from('preserved owned metadata'));
    await assert.rejects(fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), { code: 'metadata-conflict' });
    assert.equal((await fixture.database.rows('BaseItems')).length, 3);
    assert.equal((await stat(marker)).isFile(), true);
  });

  databaseTest('a stale owner baseline rejects missing-part cleanup before touching metadata files', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId } = await seedFamily(fixture, { parts: true, mixed: true });
    await fixture.adapter.delete('/aggregate/Film/Film cd2.mkv');
    const loaded = await fixture.loadContext(ownerId), part = await loaded.videoVersionDiscovery.lookup(loaded, partId);
    const assets = new MetadataImageAssets({fileSystem: testFileSystem,  vfs: fixture.vfs, identityMap: fixture.identityMap,
      metadataPath: loaded.metadataPath, stateRoots: [loaded.dataPath] });
    const marker = path.join(internalImagePath(part, loaded.metadataPath), 'marker.txt');
    await assets.write(marker, Buffer.from('preserved owned metadata'));
    await fixture.database.update('BaseItems', { Id: ownerId }, { Name: 'Concurrent owner' });
    await assert.rejects(fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), { code: 'metadata-conflict' });
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: partId } })).length, 1);
    assert.equal((await stat(marker)).isFile(), true);
  });

  for (const alternate of [false, true]) databaseTest(`production wrapper creates ${alternate ? 'alternate' : 'part'} before an already-cancelled provider`, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const ids = await seedFamily(fixture, { parts: !alternate, alternates: alternate, mixed: true });
    const childId = alternate ? ids.alternateId : ids.partId;
    for (const link of await fixture.database.rows('LinkedChildren')) await fixture.database.delete('LinkedChildren', { ParentId: link.ParentId, SortOrder: link.SortOrder });
    await fixture.database.delete('BaseItems', { Id: childId });
    const beforeOwner = (await fixture.database.rows('BaseItems', { where: { Id: ownerId } }))[0];
    const errors = []; fixture.host.logger = { error(error) { errors.push(error.stack); } };
    const added = []; fixture.host.updates.on('ItemAdded', event => added.push(event));
    const signal = AbortSignal.abort(new Error('Controlled create then cancellation'));
    await assert.rejects(fixture.host.refresh(ownerId, { ...noMetadata, signal }), /Controlled create then cancellation/u);
    const [row] = await fixture.database.rows('BaseItems', { where: { Id: nativeGuid(childId) } });
    assert.ok(row, errors.join('\n')); assert.equal(idKey(row.OwnerId), idKey(ownerId));
    assert.equal(row.PrimaryVersionId && idKey(row.PrimaryVersionId), alternate ? idKey(ownerId) : null);
    assert.equal(row.DateLastRefreshed, null);
    assert.equal(row.DateLastSaved, null);
    assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: ownerId } }))[0], beforeOwner);
    assert.deepEqual(added.map(event => idKey(event.Item.Id)), [idKey(childId)]);
    assert.equal((await fixture.database.rows('LinkedChildren')).length, 0);
  });

  databaseTest('a new owned part inherits its live owner before that owner is persisted', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId } = await seedFamily(fixture, { parts: true, mixed: true });
    await fixture.database.delete('BaseItems', { Id: partId });
    const liveOwner = (await fixture.loadContext(ownerId)).item;
    liveOwner.Genres = ['Live genre']; liveOwner.Overview = 'Live overview'; liveOwner.ProductionYear = 2026;
    const loaded = await fixture.loadContext(ownerId); loaded.item = liveOwner;
    const events = []; fixture.host.updates.on('ItemAdded', event => events.push('added:' + idKey(event.Item.Id)));
    fixture.host.updates.on('ItemUpdated', event => events.push('updated:' + idKey(event.Item.Id)));
    assert.equal(await fixture.host.ownedLifecycle.beforeRefresh(loaded, noMetadata), false);
    const part = (await fixture.loadContext(partId)).item;
    assert.deepEqual(part.Genres, ['Live genre']); assert.equal(part.Overview, 'Live overview'); assert.equal(part.ProductionYear, 2026);
    const storedOwner = (await fixture.loadContext(ownerId)).item;
    assert.deepEqual(storedOwner.Genres, title.Genres); assert.equal(storedOwner.Overview, title.Overview);
    assert.equal(events[0], 'added:' + idKey(partId)); assert.ok(events.includes('updated:' + idKey(partId)));
    assert.equal(events.includes('updated:' + idKey(ownerId)), false);
  });

  for (const alternate of [false, true]) databaseTest(`production duplicate ${alternate ? 'alternate' : 'part'} paths create once and complete both dispatches`, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const ids = await seedFamily(fixture, { parts: !alternate, alternates: alternate, mixed: true, links: false });
    const childId = alternate ? ids.alternateId : ids.partId;
    await fixture.database.delete('BaseItems', { Id: childId });
    const [owner] = await fixture.database.rows('BaseItems', { where: { Id: ownerId } });
    const field = alternate ? 'LocalAlternateVersions' : 'AdditionalParts', data = parseLosslessJson(owner.Data);
    data[field] = [data[field][0], data[field][0]];
    await fixture.database.update('BaseItems', { Id: ownerId }, { Data: JSON.stringify(data) });
    const added = [], errors = []; fixture.host.updates.on('ItemAdded', event => added.push(idKey(event.Item.Id)));
    fixture.host.logger = { error(error) { errors.push(error); } };
    const completed = [], refreshOwnedItem = fixture.host.refreshOwnedItem.bind(fixture.host);
    fixture.host.refreshOwnedItem = async (...args) => {
      const result = await refreshOwnedItem(...args); completed.push(idKey(args[1])); return result;
    };
    await fixture.host.refresh(ownerId, noMetadata);
    assert.deepEqual(errors, []);
    assert.deepEqual(added, [idKey(childId)]);
    const child = (await fixture.loadContext(childId)).item;
    assert.equal(idKey(child.OwnerId), idKey(ownerId));
    assert.deepEqual(completed, [idKey(childId), idKey(childId)]);
    assert.equal((await fixture.loadContext(ownerId)).item[field].length, 2);
    assert.equal((await fixture.database.rows('LinkedChildren')).length, alternate ? 1 : 0);
  });

  for (const alternate of [false, true]) databaseTest(`D3 preview does not retain ignore absence before a new ${alternate ? 'alternate' : 'part'} writer validates`, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const ids = await seedFamily(fixture, { parts: !alternate, alternates: alternate, mixed: true, links: false });
    const childId = alternate ? ids.alternateId : ids.partId;
    await fixture.database.delete('BaseItems', { Id: childId });
    let validations = 0, saves = 0;
    fixture.registry.register({ id: 'version-ignore-preflight', name: 'Version ignore preflight', providers: [{
      id: 'writer', name: 'Controlled version ignore writer', kind: 'saver', itemTypes: ['Movie', 'Video'],
      isEnabledFor: item => idKey(item.Id) === idKey(childId),
      async validateSave() {
        validations++;
        await fixture.adapter.write('/aggregate/Film/.ignore', Buffer.from('*.mkv'), {
          modified: '2025-01-03T04:05:06.0000000Z'
        });
      },
      save() { saves++; return []; }
    }] });
    const original = fixture.host.loadContext;
    const configured = async (...args) => {
      const loaded = await original(...args);
      loaded.libraryOptions = { ...loaded.libraryOptions, MetadataSavers: ['Controlled version ignore writer'] };
      loaded.loadDraftContext = item => configured(item.Id, { draft: item });
      return loaded;
    };
    fixture.host.loadContext = configured;
    const events = [], errors = [];
    fixture.host.updates.on('ItemAdded', event => events.push(idKey(event.Item.Id)));
    fixture.host.logger = { error(error) { errors.push(error); } };
    await fixture.host.refresh(ownerId, noMetadata);
    assert.equal(validations, 1); assert.equal(saves, 0); assert.deepEqual(events, []); assert.deepEqual(errors, []);
    assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: childId } }), []);
    assert.deepEqual(await fixture.database.rows('LinkedChildren'), []);
    const owner = (await fixture.loadContext(ownerId)).item;
    assert.deepEqual(owner[alternate ? 'LocalAlternateVersions' : 'AdditionalParts'], [itemPath(alternate ? 'Film - 4K.mkv' : 'Film cd2.mkv')]);
  });

  for (const alternate of [false, true]) databaseTest(`D3 rejects an unmapped ignore ancestor before new ${alternate ? 'alternate' : 'part'} creation`, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const ids = await seedFamily(fixture, { parts: !alternate, alternates: alternate, mixed: true, links: false });
    const childId = alternate ? ids.alternateId : ids.partId;
    await fixture.database.delete('BaseItems', { Id: childId });
    const partial = new IdentityAccessMap();
    partial.addPrefix({ identityRoot, accessRoot: '/fixture/aggregate/Film', style: 'windows', returnAccess: 'Known media directory only.' });
    const ignoreRule = new DotIgnoreRule({ vfs: fixture.vfs, identityMap: partial });
    fixture.host.loadContext = ownedLoader(fixture,{ignoreRule});
    const rows = await fixture.database.rows('BaseItems'), events = [];
    fixture.host.updates.on('ItemAdded', event => events.push(event));
    await assert.rejects(fixture.host.refresh(ownerId, noMetadata), error => error.code === 'ignore-search-unmapped' && error.status === 501);
    assert.deepEqual(await fixture.database.rows('BaseItems'), rows); assert.deepEqual(events, []);
    assert.deepEqual(await fixture.database.rows('LinkedChildren'), []);
    assert.equal((await fixture.adapter.stat('/aggregate/Film/' + (alternate ? 'Film - 4K.mkv' : 'Film cd2.mkv'))).kind, 'file');
  });

  databaseTest('new owned video resolution honors access mapped only by item ID', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId } = await seedFamily(fixture, { parts: true, mixed: true });
    await fixture.database.delete('BaseItems', { Id: partId });
    await fixture.adapter.write('/aggregate/Film/sample.mkv', Buffer.from('media'));
    await fixture.adapter.delete('/aggregate/Film/Film cd2.mkv');
    const identityMap = new IdentityAccessMap();
    for (const [id, accessPath] of [[folderId, '/fixture/aggregate'], [ownerId, '/fixture/aggregate/Film/Film.mkv'],
      [partId, '/fixture/aggregate/Film/sample.mkv']]) identityMap.bind(id, accessPath);
    fixture.host.loadContext = ownedLoader(fixture,{identityMap,
      ignoreRule: new DotIgnoreRule({ vfs: fixture.vfs, identityMap: fixture.identityMap }) });
    const added = []; fixture.host.updates.on('ItemAdded', event => added.push(idKey(event.Item.Id)));
    await assert.rejects(fixture.host.refresh(ownerId, { ...noMetadata, signal: AbortSignal.abort(new Error('Binding creation cancellation')) }), /Binding creation cancellation/u);
    assert.deepEqual(added, [idKey(partId)]);
    const [row] = await fixture.database.rows('BaseItems', { where: { Id: nativeGuid(partId) } });
    assert.ok(row); assert.equal(row.Path, itemPath('Film cd2.mkv')); assert.equal(row.Name, 'Film cd2');
    assert.equal(row.OwnerId && idKey(row.OwnerId), idKey(ownerId)); assert.equal(row.DateLastRefreshed, null);
  });

  databaseTest('D3 rejects a new part writer before missing-part deletion or any new rows', async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const { partId } = await seedFamily(fixture, { parts: true, mixed: true });
    const secondPath = itemPath('Film cd3.mkv');
    const secondId = getNewItemId(secondPath, 'MediaBrowser.Controller.Entities.Video', { programDataPath: fixture.stateRoot });
    await fixture.adapter.write('/aggregate/Film/Film cd3.mkv', Buffer.from('third part'));
    await fixture.adapter.delete('/aggregate/Film/Film cd2.mkv');
    const beforeOwner = (await fixture.database.rows('BaseItems', { where: { Id: ownerId } }))[0];
    await fixture.database.update('BaseItems', { Id: ownerId }, { Data: JSON.stringify({ ...parseLosslessJson(beforeOwner.Data),
      AdditionalParts: [itemPath('Film cd2.mkv'), secondPath] }) });
    fixture.registry.register({ id: 'owned-writer-preflight', name: 'Owned writer preflight', providers: [{
      id: 'part-writer', name: 'Nfo', kind: 'saver', itemTypes: ['Movie', 'Video'], isEnabledFor: () => true,
      validateSave(item) { if (idKey(item.Id) === idKey(secondId)) throw Object.assign(new Error('Controlled unavailable part writer'), { status: 501 }); },
      save() { throw new Error('D3 must reject before saver dispatch'); }
    }] });
    const before = await fixture.database.rows('BaseItems'), events = [];
    const loadContext = fixture.host.loadContext;
    fixture.host.loadContext = async reference => {
      const loaded = await loadContext(reference);
      loaded.libraryOptions.MetadataSavers = ['Nfo'];
      const preview = loaded.previewOwnedPartContexts;
      loaded.previewOwnedPartContexts = async () => {
        const children = await preview();
        for (const child of children) child.libraryOptions.MetadataSavers = ['Nfo'];
        return children;
      };
      return loaded;
    };
    for (const name of ['ItemAdded', 'ItemRemoved', 'ItemUpdated']) fixture.host.updates.on(name, event => events.push(event));
    await assert.rejects(fixture.host.refresh(ownerId, noMetadata), /Controlled unavailable part writer/u);
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: partId } })).length, 1);
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: secondId } })).length, 0);
    assert.equal(events.length, 0);
    assert.equal((await fixture.adapter.stat('/aggregate/Film/Film cd3.mkv')).kind, 'file');
  });
}

function ownedLoader(fixture,options={}){const base=createMetadataContextLoader({fileSystem: testFileSystem, ...fixture,...options}),contexts=new Set();
  const loader=Object.assign(async(...args)=>{const loaded=await base(...args),dispose=loaded.dispose.bind(loaded);contexts.add(loaded);loaded.dispose=async()=>{try{await dispose();}finally{contexts.delete(loaded);}};return loaded;},base);
  loader.withContext=async(reference,options,operation)=>{const loaded=await loader(reference,options);try{return await operation(loaded);}finally{await loaded.dispose();}};
  const close=fixture.host.close.bind(fixture.host);fixture.host.close=async()=>{await close();for(const loaded of contexts)await loaded.dispose();};return loader;}
