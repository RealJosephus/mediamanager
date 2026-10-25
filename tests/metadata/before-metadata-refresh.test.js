import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { beforeMetadataRefresh, afterMetadataRefresh } from '../../src/metadata/before-refresh.js';
import { attachMetadataSortCache } from '../../src/metadata/sort-cache.js';
import { parseSeasonPath } from '../../src/metadata/season-path.js';
import { setupChildrenFixture } from './children-fixture.js';
import { observeComparison } from '../comparison-observations.js';

const root = new URL('./fixtures/before-metadata-refresh/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));
const expectedFor = scenario => native.results.find(entry => entry.name === scenario.name);
const fields = ['Name', 'Path', 'ProductionYear', 'IndexNumber', 'ParentIndexNumber', 'ForcedSortName', 'SortName'];
const capture = item => Object.fromEntries(fields.map(field => [field, item[field] ?? null]));
const cacheCapture = item => Object.fromEntries(['Name', 'ForcedSortName', 'SortName', 'IndexNumber', 'ParentIndexNumber'].map(field => [field, item[field] ?? null]));
const shortType = item => item.Type.split('.').at(-1);
const definition = item => { const { Type, ...fields } = item; return { type: shortType(item), ...fields }; };
const runtimeItem = definition => ({ ...structuredClone(definition), Type: shortType(definition),
  IsFolder: ['Folder', 'Series', 'Season', 'MusicAlbum', 'BoxSet', 'UserView'].includes(shortType(definition)) });

test('refresh hook recording seals native methods, naming options and warmed mapper projections', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  for (const [key, filename] of Object.entries({ input: 'input.json', native: 'native.json', oracle: 'Program.cs', project: 'Oracle.csproj' })) {
    assert.equal(createHash('sha256').update(await readFile(new URL(filename, root))).digest('hex'), provenance.files[key].sha256);
  }
  assert.equal(createHash('sha256').update(await readFile(new URL('../Directory.Build.props', import.meta.url))).digest('hex'), provenance.files.buildProperties.sha256);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 182); assert.equal(native.results.length, input.length);
  assert.ok(native.results.filter(entry => input.find(scenario => scenario.name === entry.name).mode === 'before').every(entry => entry.result.clearedCache === null));
});

for (const scenario of input.filter(entry => entry.mode === 'seasonPath')) test(`native ${scenario.name}`, t => {
  const expected = expectedFor(scenario);
  if (expected.exception) return assert.throws(() => parseSeasonPath(scenario.path, scenario.parentPath, {
    supportSpecialAliases: scenario.aliases ?? true, supportNumericSeasonFolders: scenario.numeric ?? true
  }), error => {
    observeComparison(t, scenario.name + ' path failure', { name: error.name, message: error.message, stack: error.stack }, expected.exception);
    return true;
  });
  assert.deepEqual(parseSeasonPath(scenario.path, scenario.parentPath, {
    supportSpecialAliases: scenario.aliases ?? true, supportNumericSeasonFolders: scenario.numeric ?? true
  }), expected.result);
});

for (const scenario of input.filter(entry => entry.mode === 'before')) test(`native before refresh: ${scenario.name}`, () => {
  const item = attachMetadataSortCache(runtimeItem(scenario.item));
  if (scenario.warm) void item.SortName;
  assert.equal(beforeMetadataRefresh(item, { parent: scenario.parent && runtimeItem(scenario.parent) }), expectedFor(scenario).result.changed);
  assert.deepEqual(capture(item), expectedFor(scenario).result.item);
});

for (const scenario of input.filter(entry => entry.mode === 'cache')) test(`native ${scenario.name}`, () => {
  const item = attachMetadataSortCache(runtimeItem(scenario.item));
  for (const [index, action] of scenario.actions.entries()) {
    let value = null;
    if (action.op === 'read') value = item.SortName;
    if (action.op === 'change') Object.assign(item, action.fields);
    if (action.op === 'map') value = cacheCapture(item);
    if (action.op === 'before') value = beforeMetadataRefresh(item);
    if (action.op === 'after') afterMetadataRefresh(item);
    assert.deepEqual(value, expectedFor(scenario).result.steps[index].value);
  }
});

for (const dialect of ['postgres']) {
  const options = {};
  test(`${dialect}: hook names, years and season numbers persist against native projections`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    for (const scenario of input.filter(entry => entry.mode === 'before' && shortType(entry.item) !== 'UserView' && (!entry.item.Path || entry.item.Path.startsWith('Z:\\ChildrenMetadata')))) await t.test(scenario.name, async () => {
      const items = [...scenario.parent ? [{ key: 'parent', ...definition(scenario.parent) }] : [],
        { key: 'target', ...definition(scenario.item), ...scenario.parent ? { parent: 'parent' } : {} }];
      const Id = await fixture.seed({ target: 'target', items }), loaded = await fixture.loadContext(Id), expected = expectedFor(scenario).result;
      if (scenario.warm) void loaded.item.SortName;
      assert.equal(beforeMetadataRefresh(loaded.item, loaded), expected.changed);
      await fixture.host.updates.update(loaded, { Item: loaded.item }, 2);
      assert.deepEqual(capture((await fixture.database.rows('BaseItems', { where: { Id } }))[0]), expected.item);
    });
  });
  test(`${dialect}: saves honor warmed sort caches and both clearing hooks`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    for (const scenario of input.filter(entry => entry.mode === 'cache')) await t.test(scenario.name, async () => {
      const Id = await fixture.seed({ target: 'target', items: [
        ...scenario.item.ParentId ? [{ key: 'parent', type: 'Folder', Id: scenario.item.ParentId, Name: 'Controlled physical parent' }] : [],
        { key: 'target', ...definition(scenario.item) }
      ] }), loaded = await fixture.loadContext(Id);
      for (const [index, action] of scenario.actions.entries()) {
        if (action.op === 'read') assert.equal(loaded.item.SortName, expectedFor(scenario).result.steps[index].value);
        if (action.op === 'change') Object.assign(loaded.item, action.fields);
        if (action.op === 'before') assert.equal(beforeMetadataRefresh(loaded.item, loaded), expectedFor(scenario).result.steps[index].value);
        if (action.op === 'after') afterMetadataRefresh(loaded.item);
        if (action.op === 'map') {
          await fixture.host.updates.update(loaded, { Item: loaded.item }, 16);
          assert.deepEqual(cacheCapture((await fixture.database.rows('BaseItems', { where: { Id } }))[0]), expectedFor(scenario).result.steps[index].value);
        }
      }
    });
  });
  test(`${dialect}: native refresh gates preserve first saves, warmed provider reads and cancellation`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    let activeItem;
    fixture.host.loadContext = async reference => { const loaded = await fixture.loadContext(reference); activeItem = loaded.item; return loaded; };
    for (const scenario of input.filter(entry => ['refresh', 'episodeRefresh'].includes(entry.mode))) await t.test(scenario.name, async () => {
      const Id = await fixture.seed({ target: 'target', items: [{ key: 'target', ...definition(scenario.item) }] });
      const original = (await fixture.database.rows('BaseItems', { where: { Id } }))[0];
      const expected = expectedFor(scenario), calls = [], lookups = [], providerSortReads = [];
      let reattachments = 0;
      const reportReattachment = () => reattachments++;
      const registry = fixture.registry;
      // One registry per control keeps native provider absence distinct from
      // a provider whose change monitor returned false.
      const plugin = registry.register({ id: scenario.name, name: scenario.name, providers: scenario.noProvider ? [] : scenario.mode === 'episodeRefresh' ? [{
        id: 'warm-index', name: 'Controlled warm index', kind: 'custom', itemTypes: ['Episode'], hasChanged: async () => true,
        fetch: async item => {
          providerSortReads.push(item.SortName); item.IndexNumber = 9;
          if (scenario.sameName) item.Name = item.Name;
          if (scenario.cancel) throw new DOMException('Injected cancellation after a warmed index mutation', 'AbortError');
          return scenario.providerUpdate ?? 1;
        }
      }] : [{
        id: 'empty-lookup', name: 'Controlled empty lookup', kind: 'remote', itemTypes: ['Movie'],
        hasChanged: async () => scenario.providerChanged ?? true,
        getMetadata: async info => { lookups.push({ Name: info.Name ?? null, Year: info.Year ?? null });
          if (scenario.cancel) throw new DOMException('Injected cancellation after BeforeMetadataRefresh', 'AbortError');
          return { HasMetadata: false };
        }
      }] });
      const report = ({ Item, UpdateReason }) => calls.push({ item: capture(Item), updateReason: UpdateReason });
      fixture.host.updates.on('ItemUpdated', report);
      fixture.host.updates.on('UserDataReattached', reportReattachment);
      let result;
      try {
        const promise = fixture.host.refresh(Id, { MetadataRefreshMode: scenario.metadataMode, ImageRefreshMode: 'None',
          ForceSave: scenario.force ?? false, ReplaceAllMetadata: scenario.replace ?? false });
        if (scenario.cancel) await assert.rejects(promise, error => error.name === 'AbortError');
        else { result = await promise; assert.equal(result.UpdateType, expected.result.updateType); }
      } finally {
        fixture.host.updates.off('ItemUpdated', report); fixture.host.updates.off('UserDataReattached', reportReattachment); plugin.enabled = false;
      }
      assert.deepEqual(calls, expected.result.calls); assert.deepEqual(lookups, expected.result.lookups);
      assert.deepEqual(providerSortReads, expected.result.providerSortReads);
      assert.equal(reattachments, expected.result.reattachments);
      const saved = await fixture.loadContext(Id);
      if (expected.result.calls.length) assert.deepEqual(capture(saved.snapshot), expected.result.calls.at(-1).item);
      else assert.deepEqual(saved.snapshot, original);
      if (result?.Item) assert.deepEqual(capture(result.Item), expected.result.item);
      assert.deepEqual(capture(activeItem), expected.result.item);
      assert.equal(Boolean(activeItem.DateLastRefreshed && activeItem.DateLastRefreshed !== scenario.item.DateLastRefreshed), expected.result.stampChanged);
    });
  });
  test(`${dialect}: native file refresh thresholds and cumulative runtime gates use authoritative state`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    fixture.identityMap.bind(input.find(entry => entry.mode === 'requires').item.Id, '/fixture/file.mkv');
    for (const scenario of input.filter(entry => entry.mode === 'requires')) await t.test(scenario.name, async () => {
      if (scenario.file.Exists) await fixture.adapter.write('/file.mkv', Buffer.from('controlled file metadata'), { modified: scenario.file.LastWriteTimeUtc });
      else try { await fixture.adapter.delete('/file.mkv'); } catch (error) { if (error.code !== 'not-found') throw error; }
      const Id = await fixture.seed({ target: 'target', items: [
        ...scenario.item.ParentId ? [{ key: 'parent', type: 'Folder', Id: scenario.item.ParentId, Name: 'Controlled physical parent' }] : [],
        { key: 'target', ...definition(scenario.item) }
      ] }), loaded = await fixture.loadContext(Id);
      const stat = fixture.vfs.stat.bind(fixture.vfs);
      let calls = 0;
      fixture.vfs.stat = async (...args) => { calls++; return stat(...args); };
      try { assert.equal(await loaded.requiresRefresh(), expectedFor(scenario).result.requiresRefresh); }
      finally { fixture.vfs.stat = stat; }
      assert.equal(calls, expectedFor(scenario).result.fileCalls);
    });
  });
  for (const probeReplacesFields of [false, true]) test(`${dialect}: probe reload ${probeReplacesFields ? 'uses newly committed name and year' : 'retains unsaved hook name and year'}`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const scenario = input.find(entry => entry.name === 'refresh: FullRefresh selected provider');
    const Id = await fixture.seed({ target: 'target', items: [{ key: 'target', ...definition(scenario.item) }] });
    fixture.host.probe = { supportsMetadata: () => true, refreshMetadata: async loaded => {
      assert.equal(loaded.item.ProductionYear, 2022);
      assert.equal(loaded.snapshot.ProductionYear, null);
      await fixture.database.update('BaseItems', { Id }, { Size: 42n, ...probeReplacesFields ? { Name: 'Probe title', ProductionYear: 2024 } : {} });
      return { changed: true, UpdateType: 2 };
    } };
    const lookups = [];
    fixture.registry.register({ id: 'after-probe-lookup', name: 'After probe lookup', providers: [{ id: 'empty', name: 'After probe lookup', kind: 'remote', itemTypes: ['Movie'],
      getMetadata: async info => { lookups.push({ Name: info.Name, Year: info.Year }); return { HasMetadata: false }; }
    }] });
    const result = await fixture.host.refresh(Id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    const expected = { Name: probeReplacesFields ? 'Probe title' : scenario.item.Name, Year: probeReplacesFields ? 2024 : 2022 };
    assert.deepEqual(lookups, [expected]); assert.equal(result.UpdateType, 3);
    const saved = (await fixture.database.rows('BaseItems', { where: { Id } }))[0];
    assert.equal(saved.Name, expected.Name); assert.equal(saved.ProductionYear, expected.Year); assert.equal(saved.Size, 42n);
  });
}
