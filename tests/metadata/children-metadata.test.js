import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { requiresMetadataChildren, updateMetadataFromChildren } from '../../src/metadata/children-metadata.js';
import { newNativeItemEntity, applyNativeItemValues } from '../../src/library/native-item-entity.js';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { metadataChildSequence } from '../../src/library/metadata-child-sequence.js';
import { dateText } from '../../src/library/records.js';
import { setupChildrenFixture } from './children-fixture.js';

const root = new URL('./fixtures/children-metadata/', import.meta.url);
const input = parseLosslessJson(await readFile(new URL('input.json', root), 'utf8'));
const native = parseLosslessJson(await readFile(new URL('native.json', root), 'utf8'));
const entity = ({ type, ...item }) => ({ Name: type, Type: type, Genres: [], Studios: [], LockedFields: [], ProviderIds: {}, RemoteTrailers: [],
  ...item, IsFolder: ['Folder', 'Series', 'Season', 'MusicAlbum', 'BoxSet'].includes(type) || type === 'MusicArtist' && Boolean(item.ParentId),
  IsVirtualItem: item.IsVirtualItem ?? false, LocationType: item.Path ? item.Path.includes('://') ? 'Remote' : 'FileSystem' : 'Virtual' });
const project = item => ({ Name: item.Name, PremiereDate: item.PremiereDate == null ? null : dateText(item.PremiereDate),
  ProductionYear: item.ProductionYear ?? null, Genres: item.Genres, Studios: item.Studios, OfficialRating: item.OfficialRating ?? null,
  RunTimeTicks: item.RunTimeTicks ?? null, IsVirtualItem: item.IsVirtualItem,
  DateLastMediaAdded: item.DateLastMediaAdded == null ? null : dateText(item.DateLastMediaAdded),
  Artists: item.Type === 'MusicAlbum' ? item.Artists ?? [] : null, AlbumArtists: item.Type === 'MusicAlbum' ? item.AlbumArtists ?? [] : null,
  ProviderIds: item.ProviderIds, RemoteTrailers: item.RemoteTrailers });

test('child aggregation recording seals native services, input, source and ordered child boundary', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  for (const [key, filename] of Object.entries({ input: 'input.json', native: 'native.json', oracle: 'Program.cs', project: 'Oracle.csproj' })) {
    assert.equal(createHash('sha256').update(await readFile(new URL(filename, root))).digest('hex'), provenance.files[key].sha256);
  }
  assert.equal(createHash('sha256').update(await readFile(new URL('../Directory.Build.props', import.meta.url))).digest('hex'), provenance.files.buildProperties.sha256);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 59); assert.equal(native.results.length, input.length);
});

test('native ordered child aggregation controls execute bounded SQL consumers', async t => {
 const fixture = await setupChildrenFixture(t);
 for (const scenario of input) await t.test(`native metadata from children: ${scenario.name}`, async () => {
  const item = entity(scenario.item);
  item.MetadataCountryCode = scenario.country ?? 'US';
  const enabled = requiresMetadataChildren(item, scenario.full, scenario.currentUpdateType);
  let updateType = scenario.currentUpdateType, exception = null;
  try {
    if (enabled) {
      const cohort=await createNativeItemCohort({linkedChildren:fixture.linkedChildren});
      const sequence=metadataChildSequence(cohort,fixture.linkedChildren,fixture.store);
      try {
        for (const [index,control] of scenario.children.entries()) {
          const neutral=entity(control), type='MediaBrowser.Controller.Entities.'+(['Season','Series','Episode'].includes(control.type)?'TV.':['Audio','MusicAlbum','MusicArtist'].includes(control.type)?'Audio.':['Movie','BoxSet'].includes(control.type)?'Movies.':'')+control.type;
          const child=newNativeItemEntity(type);
          const {Type,IsFolder,IsVirtualItem,...values}=neutral;
          applyNativeItemValues(child,values); child.IsVirtualItem=IsVirtualItem;
          await cohort.capture(child,{ordinal:BigInt(index+1)});
        }
        updateType = await updateMetadataFromChildren(item, sequence, scenario.full, scenario.currentUpdateType);
      } finally { await sequence.close(); }
    }
    assert.equal(scenario.expectException, undefined, 'an expected failure must be raised');
  } catch (error) {
    if (!scenario.expectException) throw error;
    exception = error.nativeException; assert.equal(exception, scenario.expectException);
  }
  const expected = native.results.find(result => result.name === scenario.name);
  assert.equal(enabled, expected.enabled); assert.equal(updateType, expected.updateType);
  assert.equal(exception, expected.exception);
  const normalize = value => JSON.parse(JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry));
  const expectedProjection = { ...expected.result, RunTimeTicks: expected.result.RunTimeTicks == null ? null : String(expected.result.RunTimeTicks) };
  for (const field of ['PremiereDate', 'DateLastMediaAdded']) if (expectedProjection[field] != null) expectedProjection[field] = dateText(expectedProjection[field]);
  const actual = project(item); actual.RunTimeTicks = actual.RunTimeTicks == null ? null : String(actual.RunTimeTicks);
  assert.deepEqual(normalize(actual), normalize(expectedProjection));
 });
});

const persistedFields = ['Name', 'PremiereDate', 'ProductionYear', 'Genres', 'Studios', 'OfficialRating', 'RunTimeTicks', 'IsVirtualItem', 'Artists', 'AlbumArtists', 'ProviderIds', 'RemoteTrailers'];
const persistenceProjection = item => Object.fromEntries(persistedFields.map(field => {
  let value = item[field] ?? null;
  if (field === 'RunTimeTicks' && value != null) value = String(value);
  if (field === 'PremiereDate' && value != null) value = dateText(value);
  return [field, value];
}));
function storedScenario(scenario, { first = false } = {}) {
  const target = { ...scenario.item, key: 'target', PresentationUniqueKey: scenario.item.Id.replaceAll('-', ''), DateLastRefreshed: first ? '0001-01-01T00:00:00.0000000Z' : undefined };
  const children = scenario.children.map((item, index) => ({ ...item, key: `child${index}`, ...(target.type === 'BoxSet' ? {} : { parent: 'target' }) }));
  if (target.type === 'BoxSet') target.links = children.map(item => item.key);
  const parent = target.type === 'MusicArtist' && target.ParentId ? [{ key: 'root', type: 'Folder', Id: target.ParentId, Name: 'root' }] : [];
  return { name: scenario.name, items: [...parent, target, ...children], target: 'target' };
}

for (const dialect of ['postgres']) {
  const options = {};
  test(`${dialect}: production refresh persists album/collection fields and relations from native aggregation controls`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const names = ['album takes first nonempty name rather than most frequent', 'all three valid album provider IDs are taken from songs',
      'premiere takes minimum real date and its year', 'genres and studios use first ordinal-ignorecase distinct spelling',
      'artists equal counts preserve encounter order', 'locked album still updates runtime without user metadata',
      'physical artist full aggregates runtime and genres', 'boxset selects lowest rating score', 'album runtime wraps native unchecked Int64'];
    for (const name of names) await t.test(name, async () => {
      const scenario = input.find(entry => entry.name === name), expected = native.results.find(entry => entry.name === name).result;
      const Id = await fixture.seed(storedScenario(scenario));
      const result = await fixture.host.refresh(Id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
      assert.equal(result.Failures, 0); assert.equal(result.changed, true);
      const loaded = await fixture.loadContext(Id);
      const fields = persistenceProjection(loaded.item), expectedFields = persistenceProjection(expected);
      // BaseItemMapper joins an empty Studio array to "", which hydrates as
      // one empty segment; the aggregation oracle records pre-save entities.
      if (!expectedFields.Studios.length) expectedFields.Studios = [''];
      if (scenario.item.type !== 'MusicAlbum') { delete fields.Artists; delete fields.AlbumArtists; delete expectedFields.Artists; delete expectedFields.AlbumArtists; }
      assert.deepEqual(fields, expectedFields);
      assert.equal(loaded.snapshot.SortName, loaded.sortName(loaded.item));
      const state = await fixture.state();
      for (const [type, field] of ['Artists', 'AlbumArtists', 'Genres', 'Studios'].entries()) {
        if (!loaded.item[field]?.length) continue;
        assert.equal(state.valuesFor(loaded.item, type).length, loaded.item[field].filter(value => value?.trim()).length, `${field} relationships persist with the item`);
      }
    });
  });
  test(`${dialect}: aggregated album name reaches remote lookup and the first save survives provider cancellation`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const scenario = input.find(entry => entry.name === 'album takes first nonempty name rather than most frequent');
    const Id = await fixture.seed(storedScenario(scenario, { first: true }));
    let seen;
    fixture.registry.register({ id: 'child-result', name: 'Child result', providers: [{ id: 'remote', name: 'Child result', kind: 'remote', itemTypes: ['MusicAlbum'],
      async getMetadata(lookup) { seen = lookup; throw new DOMException('Injected cancellation after the first save', 'AbortError'); }
    }] });
    await assert.rejects(fixture.host.refresh(Id, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' }), error => error.name === 'AbortError');
    assert.equal(seen.Name, 'First');
    const loaded = await fixture.loadContext(Id);
    assert.equal(loaded.item.Name, 'First'); assert.equal(loaded.item.RunTimeTicks, 0n);
    assert.equal(loaded.snapshot.SortName, loaded.sortName(loaded.item)); assert.ok(loaded.item.DateLastSaved);
    assert.equal(loaded.snapshot.DateLastRefreshed, null);
  });
  test(`${dialect}: aggregation failure precedes the first repository save and preserves original fields`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const scenario = input.find(entry => entry.expectException);
    const Id = await fixture.seed(storedScenario(scenario, { first: true }));
    const before = await fixture.database.rows('BaseItems');
    await assert.rejects(fixture.host.refresh(Id, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' }), error => error.nativeException === scenario.expectException);
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
    assert.equal((await fixture.database.rows('PeopleBaseItemMap')).length, 0);
  });
  test(`${dialect}: a pre-refresh provider alone cannot trigger empty local/remote metadata merging`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const Id = await fixture.seed({ target: 'movie', items: [{ key: 'movie', type: 'Movie',
      Id: '89000000-0000-0000-0000-000000000008', Name: 'Keep', ProviderIds: { MusicBrainzAlbum: 'native stored legacy value' },
      PresentationUniqueKey: '89000000000000000000000000000008' }] });
    fixture.host.probe = { supportsMetadata: () => true, hasChanged: async () => true,
      refreshMetadata: async () => ({ changed: false, UpdateType: 3 }) };
    await fixture.host.refresh(Id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    assert.equal((await fixture.loadContext(Id)).item.ProviderIds.MusicBrainzAlbum, 'native stored legacy value');
  });
  test(`${dialect}: None refresh updates Series added date from physical children and top-level links only`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const scenario = {
      target: 'series', items: [
        { key: 'series', type: 'Series', Id: '89000000-0000-0000-0000-000000000001', Name: 'series', Path: 'Z:\\ChildrenMetadata\\Series', links: ['linked'], PresentationUniqueKey: '89000000000000000000000000000001' },
        { key: 'season', type: 'Season', Id: '89000000-0000-0000-0000-000000000002', parent: 'series', Path: 'Z:\\ChildrenMetadata\\Series\\Season 1', IndexNumber: 1, links: ['ignored'] },
        { key: 'episode', type: 'Episode', Id: '89000000-0000-0000-0000-000000000003', parent: 'season', Path: 'Z:\\ChildrenMetadata\\Series\\Season 1\\S01E01.mkv', ParentIndexNumber: 1, IndexNumber: 1, DateCreated: '2026-02-01T00:00:00.1234567Z' },
        { key: 'virtual', type: 'Episode', Id: '89000000-0000-0000-0000-000000000004', parent: 'season', ParentIndexNumber: 1, IndexNumber: 2, DateCreated: '2026-09-01T00:00:00Z', IsVirtualItem: true },
        { key: 'queryOnly', type: 'Episode', Id: '89000000-0000-0000-0000-000000000005', ancestors: ['series'], DateCreated: '2026-09-01T00:00:00Z' },
        { key: 'linked', type: 'Episode', Id: '89000000-0000-0000-0000-000000000006', Path: 'Z:\\ChildrenMetadata\\Series\\S01E03.mkv', SeriesId: '89000000-0000-0000-0000-000000000001', ParentIndexNumber: 1, IndexNumber: 3, DateCreated: '2026-03-01T00:00:00.0000001Z' },
        { key: 'ignored', type: 'Episode', Id: '89000000-0000-0000-0000-000000000007', DateCreated: '2026-09-01T00:00:00Z' }
      ]
    };
    const Id = await fixture.seed(scenario);
    await fixture.host.refresh(Id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
    const loaded = await fixture.loadContext(Id);
    assert.equal(dateText(loaded.item.DateLastMediaAdded), '2026-03-01T00:00:00.0000001Z');
    await fixture.database.delete('LinkedChildren', { ParentId: Id, SortOrder: 0 });
    await fixture.host.refresh(Id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
    assert.equal(dateText((await fixture.loadContext(Id)).item.DateLastMediaAdded), '2026-02-01T00:00:00.1234567Z');
  });
}
