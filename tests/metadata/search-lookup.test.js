import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setupChildrenFixture } from './children-fixture.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';

const root = new URL('./fixtures/metadata-search-lookup/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));
const nativeType = type => `MediaBrowser.Controller.Entities.${type === 'Movie' ? 'Movies' : 'TV'}.${type}`;
const targetId = 'E1000000-0000-0000-0000-000000000001';
const overviewFor = info => {
  const ids = info.SeriesProviderIds ?? info.ProviderIds;
  const key = Object.keys(ids ?? {}).find(name => name.toLowerCase() === 'tmdb');
  return `${info.Name ?? '<null>'}|${info.Year ?? '<null>'}|${info.IsAutomated}|${ids?.[key] ?? '<none>'}`;
};

test('metadata lookup oracle binds actual native services, source and provider consumer projections', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  for (const [name, entry] of Object.entries(provenance.files)) {
    const file = name === 'buildProperties' ? new URL('../Directory.Build.props', import.meta.url) : new URL(entry.filename, root);
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), entry.sha256);
  }
  assert.equal(provenance.oracle.passed, true);
  assert.equal(provenance.oracle.jellyfinDll.sha256, 'a43fa24c44677e579fcec79d637789b9f36633d02e5434e76a0e03fa13027767');
  for (const source of provenance.sources) {
    const filename = path.resolve(process.env.MEDIAMANAGER_JELLYFIN_SOURCE ?? 'D:/jellyfin',
      source.filename.slice('D:/jellyfin/'.length));
    assert.equal(createHash('sha256').update(await readFile(filename)).digest('hex'), source.sha256);
  }
  const recordBytes = await readFile(provenance.oracle.record.filename);
  assert.equal(createHash('sha256').update(recordBytes).digest('hex'), provenance.oracle.record.sha256);
  const record = JSON.parse(recordBytes);
  assert.equal(record.passed, true);
  assert.equal(record.sourceFilesSha256, provenance.oracle.sourceFilesSha256);
  if (native.sourceFilesSha256 !== undefined) assert.equal(native.sourceFilesSha256, record.sourceFilesSha256);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(input.length, 15);
  assert.deepEqual(native.results.map(entry => entry.name), input.map(entry => entry.name));
  assert.ok(native.results.every(entry => entry.lookups.length === 1 && entry.Overview === overviewFor(entry.lookups[0])));
});

test('PostgreSQL metadata refresh sends native identify and automated lookup inputs and persists provider results', async t => {
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
