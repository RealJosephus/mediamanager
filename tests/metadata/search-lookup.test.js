import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setupChildrenFixture } from './children-fixture.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { recordCurrentOracleOnce } from '../helpers/current-oracle.js';

export const requiredValidationServices = ['postgres', 'dotnet', 'jellyfinDll'];
const current = () => recordCurrentOracleOnce({ owner: import.meta.url, label: 'metadata-search-lookup',
  project: 'tests/metadata/fixtures/metadata-search-lookup/Oracle.csproj',
  input: 'tests/metadata/fixtures/metadata-search-lookup/input.json' });
const nativeType = type => `MediaBrowser.Controller.Entities.${type === 'Movie' ? 'Movies' : 'TV'}.${type}`;
const targetId = 'E1000000-0000-0000-0000-000000000001';
const overviewFor = info => {
  const ids = info.SeriesProviderIds ?? info.ProviderIds;
  const key = Object.keys(ids ?? {}).find(name => name.toLowerCase() === 'tmdb');
  return `${info.Name ?? '<null>'}|${info.Year ?? '<null>'}|${info.IsAutomated}|${ids?.[key] ?? '<none>'}`;
};

test('metadata lookup oracle records current native provider consumer projections', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 180000,
}, async () => {
  const { inputBytes, input, native } = await current();
  assert.equal(native.inputSha256, createHash('sha256').update(inputBytes).digest('hex'));
  assert.equal(input.length, 15);
  assert.deepEqual(native.results.map(entry => entry.name), input.map(entry => entry.name));
  assert.ok(native.results.every(entry => entry.lookups.length === 1 && entry.Overview === overviewFor(entry.lookups[0])));
});

test('PostgreSQL metadata refresh sends current native identify and automated lookup inputs and persists provider results', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000,
}, async t => {
  const { input, native } = await current();
  const fixture = await setupChildrenFixture(t);
  for (const scenario of input) await t.test(scenario.name, async () => {
    const Id = await fixture.seed({ target: 'target', items: [{ key: 'target', Id: targetId, type: scenario.type,
      Name: 'Stored title', ProductionYear: 2001, IsInMixedFolder: true,
      IndexNumber: scenario.type === 'Season' ? 2 : scenario.type === 'Episode' ? 3 : null,
      ParentIndexNumber: scenario.type === 'Episode' ? 2 : null,
      ProviderIds: { Tmdb: '11', Custom: 'old' } }] });
    const lookups = [];
    const plugin = fixture.registry.register({ id: scenario.name, name: scenario.name, providers: [{
      id: 'controlled-lookup', name: 'Controlled lookup', kind: 'remote', itemTypes: [scenario.type],
      getMetadata: async info => {
        const capture = { Name: info.Name ?? null, Year: info.Year ?? null, ProviderIds: structuredClone(info.ProviderIds),
          SeriesProviderIds: ['Season', 'Episode'].includes(scenario.type) ? structuredClone(info.SeriesProviderIds ?? {}) : null,
          IsAutomated: info.IsAutomated };
        lookups.push(capture);
        const item = newNativeItemEntity(nativeType(scenario.type));
        item.Overview = overviewFor(capture);
        return { HasMetadata: true, Item: item };
      }
    }] });
    const options = { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', ForceSave: true,
      ...Object.hasOwn(scenario, 'automated') ? { IsAutomated: scenario.automated } : {},
      ...Object.hasOwn(scenario, 'search') ? { SearchResult: structuredClone(scenario.search) } : {} };
    const initialOptions = structuredClone(options);
    let result;
    try { result = await fixture.host.refresh(Id, options); }
    finally { fixture.registry.unregister(plugin.id); }
    const expected = native.results.find(entry => entry.name === scenario.name);
    assert.deepEqual(lookups, expected.lookups);
    assert.equal(result.Failures, 0);
    assert.equal(result.Item.Overview, expected.Overview);
    const saved = (await fixture.database.rows('BaseItems', { where: { Id } }))[0];
    assert.equal(saved.Overview, expected.Overview);
    assert.equal(saved.Name, 'Stored title');
    assert.equal(saved.ProductionYear, 2001);
    assert.deepEqual(Object.fromEntries((await fixture.database.rows('BaseItemProviders', { where: { ItemId: Id } }))
      .map(entry => [entry.ProviderId, entry.ProviderValue])), { Tmdb: '11', Custom: 'old' });
    assert.deepEqual(options, initialOptions);
  });
});
