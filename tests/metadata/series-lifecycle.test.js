import { failBaseItemDelete } from '../database/postgres-faults.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setupChildrenFixture } from './children-fixture.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { afterSeriesMetadataRefresh } from '../../src/metadata/series-lifecycle.js';
import { EMPTY_ID, dateText, idKey } from '../../src/library/records.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { LinkedChildReferenceService } from '../../src/library/linked-child-reference-service.js';
import { observeComparison } from '../comparison-observations.js';

const root = new URL('./fixtures/series-lifecycle/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));
const expectedFor = sample => native.results.find(result => result.name === sample.name);
const capture = item => {
  const tv = ['Season', 'Episode'].includes(item.Type), episode = item.Type === 'Episode';
  return { id: item.Id.toLowerCase(), type: item.Type, Name: item.Name ?? null, Path: item.Path ?? null, ParentId: item.ParentId ?? EMPTY_ID,
    IndexNumber: item.IndexNumber ?? null, ParentIndexNumber: item.ParentIndexNumber ?? null, IsVirtualItem: item.IsVirtualItem ?? false,
    PresentationUniqueKey: item.PresentationUniqueKey ?? null, SeriesId: tv ? item.SeriesId ?? EMPTY_ID : null,
    SeriesName: tv ? item.SeriesName ?? null : null, SeriesPresentationUniqueKey: tv ? item.SeriesPresentationUniqueKey ?? null : null,
    SeasonId: episode ? item.SeasonId ?? EMPTY_ID : null, SeasonName: episode ? item.SeasonName ?? null : null,
    IndexNumberEnd: episode ? item.IndexNumberEnd ?? null : null, ProductionYear: item.ProductionYear ?? null,
    PremiereDate: item.PremiereDate == null ? null : dateText(item.PremiereDate).replace(/\.0+Z$/, 'Z') };
};
const captureMapped = row => Object.fromEntries([...['Id', 'Type', 'Name', 'IndexNumber', 'ParentId', 'SeriesId', 'SeriesName', 'SeriesPresentationUniqueKey',
  'PresentationUniqueKey', 'IsFolder', 'IsVirtualItem', 'MediaType', 'UnratedType', 'ChannelId', 'Data', 'SortName', 'CleanName', 'Genres', 'Studios', 'Tags', 'ProductionLocations']
  .map(key => [key, row[key]]), ...[['created', 'DateCreated'], ['modified', 'DateModified'], ['saved', 'DateLastSaved'], ['refreshed', 'DateLastRefreshed']]
  .map(([key, field]) => [key, row[field] != null])]);
const compare = (actual, expected) => {
  assert.deepEqual(actual.calls, expected.calls);
  assert.deepEqual(actual.persisted, expected.persisted);
};

test('Series lifecycle recording binds the actual native service, entities, naming, id and mapper', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  for (const [key, file] of Object.entries({ input: 'input.json', native: 'native.json', oracle: 'Program.cs', project: 'Oracle.csproj' })) {
    assert.equal(createHash('sha256').update(await readFile(new URL(file, root))).digest('hex'), provenance.files[key].sha256);
  }
  assert.equal(createHash('sha256').update(await readFile(new URL('../Directory.Build.props', import.meta.url))).digest('hex'), provenance.files.buildProperties.sha256);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 92); assert.equal(native.results.length, input.length);
  assert.equal(new Set(native.results.map(result => result.name)).size, input.length);
  assert.deepEqual(native.results.map(result => Boolean(result.exception)), input.map(sample => Boolean(sample.expectException)));
});

test('Series comparison detects omitted deletion, stale key and lost partial creation', () => {
  for (const name of ['duplicate virtual episode is deleted', 'grouping uses physical season over stale season id', 'new-season refresh failure retains created season']) {
    const expected = expectedFor({ name }), changed = structuredClone(expected);
    if (name.startsWith('duplicate')) changed.calls = [];
    else if (name.startsWith('grouping')) changed.persisted.find(item => item.type === 'Episode').SeriesPresentationUniqueKey = 'stale';
    else changed.persisted = changed.persisted.filter(item => item.type !== 'Season' || item.Path);
    assert.throws(() => compare(changed, expected), { code: 'ERR_ASSERTION' });
  }
});

async function fixtureFor(t, dialect, sample, { controlledRefresh = true } = {}) {
  let host;
  t.after(() => host?.close());
  const fixture = await setupChildrenFixture(t, dialect);
  fixture.library.options.programDataPath = 'Z:\\SeriesOracleState';
  fixture.configuration.PreferredMetadataLanguage = 'en';
  fixture.configuration.EnableCaseSensitiveItemIds = sample.caseSensitive ?? false;
  for (const item of sample.items.filter(item => item.Path?.startsWith('Z:\\CHILDRENMETADATA\\'))) {
    fixture.identityMap.bind(item.Id, '/fixture/aggregate/' + item.Path.slice('Z:\\ChildrenMetadata\\'.length).replaceAll('\\', '/'));
  }
  const loadContext = Object.assign(async (reference, options) => {
    const loaded = await fixture.loadContext(reference, options);
    loaded.libraryOptions = { ...loaded.libraryOptions, ...sample.libraryOptions }; return loaded;
  }, fixture.loadContext);
  loadContext.withContext = async (reference, options, operation) => {
    const loaded = await loadContext(reference, options);
    try { return await operation(loaded); } finally { await loaded.dispose(); }
  };
  host = new MetadataRefreshHost({ registry: fixture.registry, store: fixture.store, linkedChildren: fixture.linkedChildren, vfs: fixture.vfs, loadContext, now: () => fixture.now });
  const deletionServices = { ...fixture, loadContext, itemCreation: fixture.library.itemCreation,
    updates: host.updates, externalData: host.externalData, now: () => fixture.now };
  fixture.library.itemDeletion = new ItemDeletionService({ ...deletionServices,
    linkedChildReferences: new LinkedChildReferenceService(deletionServices) });

  const calls = [], attempts = new Map();
  const relations = async id => {
    const ancestors = await fixture.database.rows('AncestorIds', { where: { ItemId: id } }), values = await fixture.database.rows('ItemValues');
    const maps = await fixture.database.rows('ItemValuesMap', { where: { ItemId: id } });
    return { ancestorIds: ancestors.map(row => row.ParentItemId).sort(),
      inheritedTags: maps.map(row => values.find(value => idKey(value.ItemValueId) === idKey(row.ItemValueId))).filter(value => value.Type === 6).map(value => value.Value).sort() };
  };
  const fail = action => {
    attempts.set(action, (attempts.get(action) ?? 0) + 1);
    if (sample.failure === action && attempts.get(action) === (sample.failureAt ?? 1)) throw Object.assign(new Error('Injected ' + action + ' failure'), { code: 'io' });
  };
  const update = host.updates.update.bind(host.updates);
  host.updates.update = async (...args) => {
    fail('update'); const result = await update(...args);
    calls.findLast(call => call.action === 'update').relations = await relations(args[1].Item.Id);
    return result;
  };
  host.updates.on('ItemUpdated', event => calls.push({ action: 'update', item: capture(event.Item), reason: event.UpdateReason }));
  const remove = host.seriesLifecycle.remove.bind(host.seriesLifecycle);
  host.seriesLifecycle.remove = async item => {
    fail('delete'); const snapshot = capture(item);
    await remove(item); calls.push({ action: 'delete', item: snapshot, DeleteFileLocation: false, notify: false });
  };
  const create = host.seriesLifecycle.createSeason.bind(host.seriesLifecycle);
  host.seriesLifecycle.createSeason = (...args) => { fail('create'); return create(...args); };
  host.updates.on('ItemAdded', event => calls.push({ action: 'create', item: capture(event.Item) }));
  if (controlledRefresh) host.seriesLifecycle.refresh = async (id, options) => {
    const call = calls.findLast(call => call.action === 'create');
    call.mapped = captureMapped((await fixture.database.rows('BaseItems', { where: { Id: id } }))[0]);
    call.relations = await relations(id);
    fail('refresh'); options.signal?.throwIfAborted();
    calls.push({ action: 'refresh', id, MetadataRefreshMode: options.MetadataRefreshMode, ImageRefreshMode: options.ImageRefreshMode,
      IsAutomated: options.IsAutomated, ForceSave: options.ForceSave ?? false, ReplaceAllMetadata: options.ReplaceAllMetadata ?? false });
  };
  const target = await fixture.seed(sample);
  return { ...fixture, host, target, calls };
}

for (const dialect of ['postgres']) test(`${dialect}: Series lifecycle matches actual native controls and partial commits`, async t => {
  for (const sample of input) await t.test(sample.name, async t => {
    const fixture = await fixtureFor(t, dialect, sample), expected = expectedFor(sample);
    const cancellation = new AbortController(); if (sample.cancelled) cancellation.abort(Object.assign(new Error('Injected cancellation'), { code: 'cancelled' }));
    const options = { MetadataRefreshMode: 'None', ImageRefreshMode: 'None', ReplaceAllMetadata: sample.replace ?? false, signal: cancellation.signal };
    const operation = sample.mode === 'refresh' ? () => fixture.host.refresh(fixture.target, options)
      : async () => afterSeriesMetadataRefresh((await fixture.loadContext(fixture.target)).item, options, fixture.host.seriesLifecycle);
    if (expected.exception) await assert.rejects(operation, error => {
      observeComparison(t, sample.name + ' failure', { name: error.name, message: error.message, code: error.code,
        status: error.status, stack: error.stack }, expected.exception);
      if (sample.cancelled) { assert.equal(cancellation.signal.aborted, true); assert.equal(error.code, 'cancelled'); }
      else if (sample.failure) assert.equal(error.code, 'io');
      return true;
    });
    else {
      const result = await operation();
      if (sample.mode === 'refresh') assert.equal(result.UpdateType, expected.updateType);
    }
    const persisted = (await fixture.state()).items.filter(item => item.Type !== 'UserRootFolder').map(capture).sort((a, b) => a.id.localeCompare(b.id));
    compare({ calls: fixture.calls, persisted }, expected);
    for (const episode of persisted.filter(item => item.type === 'Episode' && item.SeasonId !== EMPTY_ID)) {
      if (!fixture.calls.some(call => call.action === 'update' && idKey(call.item.id) === idKey(episode.id))) continue;
      const relations = await fixture.database.rows('AncestorIds', { where: { ItemId: episode.id } });
      const exists = (await fixture.database.rows('BaseItems', { where: { Id: episode.SeasonId } })).length;
      if (exists) assert.ok(relations.some(row => idKey(row.ParentItemId) === idKey(episode.SeasonId)));
    }
  });
});

for (const dialect of ['postgres']) test(`${dialect}: created season runs real metadata host and keeps flat episode physical parent`, async t => {
  const sample = input.find(sample => sample.name === 'flat unrefreshed path resolves season first');
  const fixture = await fixtureFor(t, dialect, sample, { controlledRefresh: false });
  const events = []; for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) fixture.library.on(name, event => events.push({ name, id: event.Item.Id }));
  await fixture.host.refresh(fixture.target, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
  const state = await fixture.state(), created = state.items.find(item => item.Type === 'Season' && item.IndexNumber === 2), episode = state.byId.get(idKey(sample.items.find(item => item.key === 'unrefreshed').Id));
  assert.ok(created); assert.equal(created.Path, null); assert.equal(created.PresentationUniqueKey, sample.items[0].PresentationUniqueKey + '-002');
  assert.equal(episode.SeasonId, created.Id); assert.equal(episode.ParentIndexNumber, 2); assert.equal(episode.IndexNumber, 5);
  assert.equal(episode.ParentId, fixture.target); assert.equal(episode.SeasonName, 'Season 2');
  assert.equal(events[0].name, 'ItemAdded'); assert.equal(events[0].id, created.Id);
  assert.ok(events.some(event => event.name === 'ItemUpdated' && event.id === created.Id));
  assert.equal(events.at(-1).id, episode.Id);
  const row = (await fixture.database.rows('BaseItems', { where: { Id: created.Id } }))[0];
  assert.ok(row.DateLastSaved); assert.equal(row.Data, null);
  const relations = await fixture.database.rows('AncestorIds', { where: { ItemId: episode.Id } });
  assert.ok(relations.some(row => row.ParentItemId === created.Id));
});

for (const dialect of ['postgres']) test(`${dialect}: obsolete cleanup retains linked targets and rolls back failed SQL deletion`, async t => {
  const sample = structuredClone(input.find(sample => sample.name === 'duplicate virtual episode is deleted'));
  const virtual = sample.items.find(item => item.key === 'duplicate'), physical = sample.items.find(item => item.key === 'episode');
  const fixture = await fixtureFor(t, dialect, sample), db = fixture.database;
  await db.insert('LinkedChildren', { ParentId: virtual.Id, ChildId: physical.Id, ChildType: 0, SortOrder: 0 });
  const before = await db.rows('BaseItems'), links = await db.rows('LinkedChildren'), removed = [];
  fixture.library.on('ItemRemoved', event => removed.push(event.Item.Id));
  const restoreDelete = await failBaseItemDelete(db, virtual.Id, 'Injected SQL delete failure');
  try {
    await assert.rejects(fixture.host.refresh(fixture.target, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' }), /Injected SQL delete failure/);
    assert.deepEqual(await db.rows('BaseItems'), before); assert.deepEqual(await db.rows('LinkedChildren'), links); assert.deepEqual(removed, []);
  } finally { await restoreDelete(); }
  await fixture.host.refresh(fixture.target, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
  assert.deepEqual(removed, [virtual.Id]); assert.equal((await db.rows('BaseItems', { where: { Id: physical.Id } })).length, 1);
  assert.equal((await db.rows('BaseItems', { where: { Id: virtual.Id } })).length, 0);
  assert.deepEqual(await db.rows('LinkedChildren'), []);
  // Deletion has no source-file write; unrelated technical relations remain.
  for (const table of ['BaseItemProviders', 'MediaStreamInfos', 'KeyframeData', 'MediaSegments', 'TrickplayInfos']) assert.deepEqual(await db.rows(table), []);
});
