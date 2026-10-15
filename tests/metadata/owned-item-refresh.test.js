import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseLosslessJson } from '../../src/core/json.js';
import { dateText, dateTicks } from '../../src/library/records.js';
import { inheritOwnedItemDates, prepareOwnedItemRefresh } from '../../src/metadata/owned-item-refresh.js';
import { setupChildrenFixture } from './children-fixture.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';

const root = new URL('./fixtures/owned-item-refresh/', import.meta.url);
const read = async name => parseLosslessJson(await readFile(new URL(name, root), 'utf8'));
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(read));
const defaults = () => ({ Name: null, Path: null, Genres: [], Studios: [], ProductionLocations: [],
  CommunityRating: null, CriticRating: null, Overview: null, OfficialRating: null, CustomRating: null,
  ProductionYear: null, PremiereDate: null, IsLocked: false, LockedFields: [], ProviderIds: {}, Tags: [],
  OriginalTitle: null, RunTimeTicks: null });
const dateContract = value => value == null ? null : dateText(value);
const project = item => ({ ...item, PremiereDate: dateContract(item.PremiereDate) });

test('owned-item metadata oracle seals actual native field, option and dispatch evidence', async () => {
  for (const file of provenance.fixtureFiles) {
    const fileUrl = file.path === 'tests/Directory.Build.props' ? new URL('../../../Directory.Build.props', root)
      : new URL(file.path.split('/').at(-1), root);
    assert.equal(createHash('sha256').update(await readFile(fileUrl)).digest('hex'), file.sha256, file.path);
  }
  assert.equal(native.actualFrozenOwnedItemRefresh, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles.find(file => file.path.endsWith('/input.json')).sha256);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.ok(native.results.every(result => result.exception == null));
  assert.equal(native.results.length, 22);
});

for (const sample of input) test(`native owned-item inheritance: ${sample.name}`, () => {
  const expected = native.results.find(result => result.name === sample.name);
  const owner = { ...defaults(), ...structuredClone(sample.owner) }, owned = { ...defaults(), ...structuredClone(sample.owned) };
  const options = { MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', ForceSave: false,
    ReplaceAllMetadata: false, IsAutomated: true, RefreshPaths: null, ...sample.options,
    SearchResult: { Name: 'Owner-specific search', SearchProviderName: 'Frozen' } };
  const original = structuredClone(options);
  if (sample.datesOnly) assert.equal(inheritOwnedItemDates(owner, owned), expected.datesChanged);
  else {
    const childOptions = prepareOwnedItemRefresh(owner, owned, options, { copyTitleMetadata: sample.copyTitleMetadata });
    assert.deepEqual(childOptions, expected.calls[0].options);
    assert.notEqual(childOptions, options);
    assert.equal(childOptions.RefreshPaths === options.RefreshPaths, expected.calls[0].sameRefreshPaths);
  }
  assert.deepEqual(project(owned), project(expected.owned));
  assert.deepEqual(project(owner), project(expected.owner));
  assert.deepEqual(options, original);
});

for (const dialect of ['postgres']) test(`${dialect}: owned refresh persists inherited metadata through the real independent save chain`, async t => {
  const fixture = await setupChildrenFixture(t, dialect);
  const ownerId = '97a70000-0000-0000-0000-000000000011', childId = '97a70000-0000-0000-0000-000000000012';
  await fixture.seed({ target: 'child', items: [
    { key: 'owner', type: 'Movie', Id: ownerId, Path: 'Z:\\ChildrenMetadata\\Film.mkv', Name: 'Owner',
      Genres: ['Drama'], Studios: ['Studio'], ProductionLocations: ['Taiwan'], CommunityRating: 7.5, CriticRating: 81,
      Overview: 'Owner overview', OfficialRating: 'PG', CustomRating: 'TV-14', ProductionYear: 2025,
      PremiereDate: '2025-01-01T00:00:00.0000001Z', ProviderIds: { Tmdb: '101' } },
    { key: 'child', type: 'Video', Id: childId, OwnerId: ownerId, Path: 'Z:\\ChildrenMetadata\\Film cd2.mkv', Name: 'Locked part',
      IsLocked: true, LockedFields: ['Genres', 'Overview'], Genres: ['Comedy'], Overview: 'Old child overview',
      ProductionYear: 1990, Tags: ['Keep'], OriginalTitle: 'Original child', RunTimeTicks: 9007199254740995n,
      ProviderIds: { Imdb: 'tt202' } }
  ] });
  const beforeOwner = (await fixture.database.rows('BaseItems', { where: { Id: ownerId } }))[0];
  const saves = [];
  fixture.host.updates.on('ItemUpdated', event => saves.push(event));
  const options = { MetadataRefreshMode: 'None', ImageRefreshMode: 'None', SearchResult: { Name: 'Owner search' } };
  const result = await fixture.host.refreshOwnedItem(ownerId, childId, options);
  assert.equal(result.changed, true);
  const loaded = await fixture.loadContext(childId);
  assert.deepEqual(loaded.item.Genres, ['Drama']);
  assert.deepEqual(loaded.item.Studios, ['Studio']);
  assert.deepEqual(loaded.item.ProductionLocations, ['Taiwan']);
  assert.equal(loaded.item.Overview, 'Owner overview');
  assert.equal(loaded.item.CommunityRating, 7.5);
  assert.equal(loaded.item.CriticRating, 81);
  assert.equal(loaded.item.ProductionYear, 2025);
  assert.equal(dateTicks(loaded.item.PremiereDate), dateTicks('2025-01-01T00:00:00.0000001Z'));
  assert.equal(loaded.item.Name, 'Locked part');
  assert.equal(loaded.item.OriginalTitle, 'Original child');
  assert.equal(loaded.item.RunTimeTicks, 9007199254740995n);
  assert.deepEqual(loaded.item.Tags, ['Keep']);
  assert.deepEqual(loaded.item.ProviderIds, { Imdb: 'tt202' });
  assert.deepEqual(loaded.item.LockedFields, ['Genres', 'Overview']);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].UpdateReason, ItemUpdateType.None | ItemUpdateType.MetadataImport | ItemUpdateType.MetadataDownload);
  assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: ownerId } }))[0], beforeOwner);
  assert.deepEqual(options.SearchResult, { Name: 'Owner search' });
  const stable = (await fixture.database.rows('BaseItems', { where: { Id: childId } }))[0];
  const unchanged = await fixture.host.refreshOwnedItem(ownerId, childId, options);
  assert.equal(unchanged.changed, false);
  assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id: childId } }))[0], stable);
  assert.equal(saves.length, 1);
});

for (const dialect of ['postgres']) test(`${dialect}: owned refresh rejects stale ownership before any saver or repository side effect`, async t => {
  const fixture = await setupChildrenFixture(t, dialect);
  const ownerId = '97a70000-0000-0000-0000-000000000021', childId = '97a70000-0000-0000-0000-000000000022';
  await fixture.seed({ target: 'child', items: [
    { key: 'owner', type: 'Movie', Id: ownerId, Overview: 'Owner' },
    { key: 'other', type: 'Movie', Id: '97a70000-0000-0000-0000-000000000023', Overview: 'Other owner' },
    { key: 'child', type: 'Video', Id: childId, OwnerId: '97a70000-0000-0000-0000-000000000023', Overview: 'Child' }
  ] });
  const before = await fixture.database.rows('BaseItems');
  await assert.rejects(fixture.host.refreshOwnedItem(ownerId, ownerId), { status: 409, message: 'An owned metadata refresh requires distinct owner and child identities.' });
  await assert.rejects(fixture.host.refreshOwnedItem(ownerId, childId), { code: 'metadata-conflict', status: 409 });
  assert.deepEqual(await fixture.database.rows('BaseItems'), before);
});
