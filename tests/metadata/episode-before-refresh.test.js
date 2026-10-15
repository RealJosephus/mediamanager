import test from 'node:test';
import { observeComparison } from '../comparison-observations.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveEpisodePath, fillMissingEpisodeNumbersFromPath } from '../../src/metadata/episode-naming.js';
import { beforeMetadataRefresh } from '../../src/metadata/before-refresh.js';
import { beforeEpisodeMetadataRefresh } from '../../src/metadata/episode-before-refresh.js';
import { attachMetadataSortCache } from '../../src/metadata/sort-cache.js';
import { ProbeService } from '../../src/library/probe-service.js';
import { setupChildrenFixture } from './children-fixture.js';
import { dateTicks } from '../../src/library/records.js';
import { persistMetadata } from '../../src/metadata/persistence.js';

const root = new URL('./fixtures/episode-before-refresh/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));
const expectedFor = scenario => native.results.find(entry => entry.name === scenario.name);
const fields = ['Name', 'SeriesName', 'IndexNumber', 'IndexNumberEnd', 'ParentIndexNumber', 'PremiereDate', 'ProductionYear', 'SortName'];
const nullableDate = value => value == null ? null : dateTicks(value);
const capture = item => Object.fromEntries(fields.map(field => [field, field === 'PremiereDate' ? nullableDate(item[field]) : item[field] ?? null]));
const canonical = expected => capture(expected);
const definition = entry => ({ ...structuredClone(entry), Type: entry.type, IsFileProtocol: Boolean(entry.Path) && !/^https?:/u.test(entry.Path) });

test('episode comparison rejects changed numbering and range projections', () => {
  const scenario = input.find(entry => entry.name.startsWith('resolve 7:') && entry.absolute == null);
  const result = resolveEpisodePath(scenario.path, scenario), expected = expectedFor(scenario).result;
  assert.deepEqual(result, expected);
  for (const field of ['EpisodeNumber', 'EndingEpisodeNumber', 'SeasonNumber']) assert.throws(() => {
    assert.deepEqual(result, { ...expected, [field]: expected[field] + 1 });
  }, assert.AssertionError);
  assert.notDeepEqual(capture({ PremiereDate: null }), capture({ PremiereDate: '0001-01-01T00:00:00Z' }));
});

test('episode recording binds the real parser, native patterns and hook source', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  for (const [key, filename] of Object.entries({ input: 'input.json', native: 'native.json', oracle: 'Program.cs', project: 'Oracle.csproj' })) {
    assert.equal(createHash('sha256').update(await readFile(new URL(filename, root))).digest('hex'), provenance.files[key].sha256);
  }
  const patterns = await readFile(new URL('../../src/metadata/episode-patterns.json', import.meta.url));
  assert.equal(createHash('sha256').update(patterns).digest('hex'), provenance.files.patterns.sha256);
  const zones = await readFile(new URL('../../src/metadata/calendar-timezones.json', import.meta.url));
  assert.equal(createHash('sha256').update(zones).digest('hex'), provenance.files.calendarTimeZones.sha256);
  const fixed = JSON.parse(zones).timeZones;
  assert.ok(fixed.some(zone => zone.ianaId === native.timezone.ianaId && zone.offsetMinutes === native.timezone.offsetMinutes));
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, native.timezone.ianaId);
  assert.equal(native.timezone.adjustmentRules, 0);
  assert.equal(createHash('sha256').update(await readFile(new URL('../Directory.Build.props', import.meta.url))).digest('hex'), provenance.files.buildProperties.sha256);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(native.results.length, input.length); assert.equal(input.length, 490);
  assert.equal(new Set(native.results.map(entry => entry.name)).size, input.length);
  assert.deepEqual(native.results.filter(entry => entry.exception).map(entry => ({ name: entry.name, exception: entry.exception })), [
    { name: 'missing generic parent throws in fill', exception: 'NullReferenceException' },
    { name: 'refresh cancellation after first save', exception: 'OperationCanceledException' },
    { name: 'refresh cancellation leaves existing record', exception: 'OperationCanceledException' }
  ]);
  assert.ok(native.results.filter(entry => entry.name.startsWith('embedded Library')).every(entry => entry.result.probeCalls === 1));
});

for (const scenario of input.filter(entry => entry.mode === 'resolve')) test(`native episode parser: ${scenario.name}`, () => {
  const expected = expectedFor(scenario);
  if (expected.exception) return assert.throws(() => resolveEpisodePath(scenario.path, scenario), error => error.nativeException === expected.exception);
  assert.deepEqual(resolveEpisodePath(scenario.path, scenario), expected.result);
});

async function hook(item, loaded, scenario, counters) {
  const errors = [], requests = [];
  const changed = beforeMetadataRefresh(item, loaded);
  const update = await beforeEpisodeMetadataRefresh(item, loaded, {
    replaceAllMetadata: scenario.replace,
    logger: { error: error => {
      assert.ok(error instanceof Error); assert.ok(error.message);
      errors.push({ name: error.name, message: error.message, nativeException: error.nativeException });
    } },
    probe: { readMediaInfo: async () => {
      counters.probeCalls++;
      requests.push({ MediaType: 'Video', ExtractChapters: false, Path: item.Path, canBeCanceled: false });
      if (scenario.probeFailure) throw Object.assign(new Error('Injected embedded information failure'), { nativeException: 'IOException' });
      return structuredClone(scenario.mediaInfo ?? {});
    } }
  });
  return { changed: changed || update, errors, requests };
}

for (const scenario of input.filter(entry => ['hook', 'fill'].includes(entry.mode))) test(`native episode ${scenario.mode}: ${scenario.name}`, async t => {
  const items = scenario.items.map(definition), item = attachMetadataSortCache(items.find(entry => entry.Id === scenario.target));
  const parent = items.find(entry => entry.Id === item.parent), series = items.find(entry => entry.type === 'Series'), season = parent?.type === 'Season' ? parent : undefined;
  const loaded = { parent, series, season, libraryOptions: { EnableEmbeddedEpisodeInfos: scenario.embedded } };
  const expected = expectedFor(scenario); void item.SortName;
  if (expected.exception) {
    const before = capture(item);
    assert.throws(() => fillMissingEpisodeNumbersFromPath(item, loaded, scenario.replace), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /parent.*absent/iu);
      observeComparison(t, scenario.name + ' fill error', { name: error.name, message: error.message }, expected.exception);
      return true;
    });
    assert.deepEqual(capture(item), before);
    return;
  }
  const counters = { probeCalls: 0 };
  const result = scenario.mode === 'fill' ? { changed: fillMissingEpisodeNumbersFromPath(item, loaded, scenario.replace), errors: [], requests: [] }
    : await hook(item, loaded, scenario, counters);
  assert.deepEqual(capture(item), canonical(expected.result.item));
  assert.equal(result.changed, expected.result.changed);
  observeComparison(t, scenario.name + ' logged errors', result.errors, expected.result.errors);
  assert.equal(result.errors.length, expected.result.errors.length);
  for (const error of result.errors) assert.match(error.message,
    scenario.probeFailure ? /Injected embedded information failure/u : /parent.*absent/iu);
  assert.deepEqual(result.requests, expected.result.requests);
  assert.equal(counters.probeCalls, expected.result.probeCalls);
});

for (const dialect of ['postgres']) {
  const options = {};
  test(`${dialect}: episode hooks persist native numbered and date projections`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    for (const scenario of input.filter(entry => ['hook', 'fill'].includes(entry.mode) && !expectedFor(entry).exception
      && !entry.name.includes('Channel') && !entry.name.includes('remote protocol'))) await t.test(scenario.name, async () => {
      const items = scenario.items.map(entry => ({ ...entry, key: entry.Id,
        ...entry.parent ? { parent: entry.parent } : {}, ...entry.Id === scenario.target ? { MediaType: 'Video' } : {} }));
      const Id = await fixture.seed({ target: scenario.target, items }), loaded = await fixture.loadContext(Id);
      loaded.libraryOptions.EnableEmbeddedEpisodeInfos = scenario.embedded;
      const expected = expectedFor(scenario).result, counters = { probeCalls: 0 };
      void loaded.item.SortName;
      const changed = scenario.mode === 'fill' ? fillMissingEpisodeNumbersFromPath(loaded.item, loaded, scenario.replace)
        : (await hook(loaded.item, loaded, scenario, counters)).changed;
      assert.equal(changed, expected.changed); assert.deepEqual(capture(loaded.item), canonical(expected.item));
      await fixture.host.updates.update(loaded, { Item: loaded.item }, 2);
      const saved = await fixture.loadContext(Id);
      assert.deepEqual(capture({ ...saved.item, SortName: saved.snapshot.SortName }), canonical(expected.item));
      assert.equal(nullableDate(saved.snapshot.PremiereDate), nullableDate(expected.mappedDates.PremiereDate));
    });
  });

  test(`${dialect}: native mapper preserves nullable minimum and exact nonminimum dates`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    for (const scenario of input.filter(entry => entry.mode === 'map')) await t.test(scenario.name, async () => {
      const Id = await fixture.seed({ target: scenario.target, items: scenario.items.map(entry => ({ ...entry, key: entry.Id })) });
      const loaded = await fixture.loadContext(Id);
      await persistMetadata(fixture.store, loaded, { Item: loaded.item });
      const row = (await fixture.database.rows('BaseItems', { where: { Id } }))[0], expected = expectedFor(scenario);
      assert.equal(expected.exception, null);
      for (const [field, value] of Object.entries(expected.result)) assert.equal(nullableDate(row[field]), nullableDate(value), field);
    });
  });

  test(`${dialect}: actual native EpisodeMetadataService gates, saves and cancellation match`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const originalLoader = fixture.loadContext;
    let active, currentScenario, probeCalls;
    fixture.host.loadContext = async ref => { const loaded = await originalLoader(ref); active = loaded.item;
      loaded.libraryOptions.EnableEmbeddedEpisodeInfos = currentScenario.embedded; return loaded; };
    fixture.host.probe = { supportsMetadata: () => false, readMediaInfo: async () => { probeCalls++; return structuredClone(currentScenario.mediaInfo); } };
    for (const scenario of input.filter(entry => entry.mode === 'refresh')) await t.test(scenario.name, async () => {
      currentScenario = scenario; probeCalls = 0;
      const Id = await fixture.seed({ target: scenario.target, items: scenario.items.map(entry => ({ ...entry, key: entry.Id,
        ...entry.Id === scenario.target ? { MediaType: 'Video' } : {} })) });
      const original = (await fixture.database.rows('BaseItems', { where: { Id } }))[0];
      const calls = [], lookups = []; let reattachments = 0;
      const report = ({ Item, UpdateReason }) => calls.push({ item: capture(Item), updateReason: UpdateReason });
      const reattach = () => reattachments++;
      fixture.host.updates.on('ItemUpdated', report); fixture.host.updates.on('UserDataReattached', reattach);
      const plugin = fixture.registry.register({ id: scenario.name, name: scenario.name, providers: scenario.noProvider ? [] : [{
        id: 'empty', name: 'Controlled empty episode lookup', kind: 'remote', itemTypes: ['Episode'], hasChanged: async () => scenario.providerChanged ?? true,
        getMetadata: async info => {
          lookups.push({ IndexNumber: info.IndexNumber ?? null, IndexNumberEnd: info.IndexNumberEnd ?? null,
            ParentIndexNumber: info.ParentIndexNumber ?? null, PremiereDate: nullableDate(info.PremiereDate), Year: info.Year ?? null });
          if (scenario.cancel) throw new DOMException('Injected cancellation after episode hooks', 'AbortError');
          return { HasMetadata: false };
        }
      }] });
      let result;
      try {
        const promise = fixture.host.refresh(Id, { MetadataRefreshMode: scenario.metadataMode, ImageRefreshMode: 'None',
          ForceSave: scenario.force ?? false, ReplaceAllMetadata: scenario.replace ?? false });
        if (scenario.cancel) await assert.rejects(promise, error => error.name === 'AbortError');
        else result = await promise;
      } finally { plugin.enabled = false; fixture.host.updates.off('ItemUpdated', report); fixture.host.updates.off('UserDataReattached', reattach); }
      const expected = expectedFor(scenario).result;
      assert.deepEqual(calls, expected.calls.map(call => ({ ...call, item: canonical(call.item) })));
      assert.deepEqual(lookups, expected.lookups.map(info => ({ ...info, PremiereDate: nullableDate(info.PremiereDate) })));
      assert.equal(reattachments, expected.reattachments); assert.equal(probeCalls, expected.probeCalls);
      if (result) assert.equal(result.UpdateType, expected.updateType);
      assert.deepEqual(capture(active), canonical(expected.item));
      assert.equal(dateTicks(active.DateLastRefreshed) !== dateTicks(scenario.items.find(entry => entry.Id === scenario.target).DateLastRefreshed), expected.stampChanged);
      const saved = await originalLoader(Id);
      if (expected.calls.length) assert.deepEqual(capture({ ...saved.item, SortName: saved.snapshot.SortName }), canonical(expected.calls.at(-1).item));
      else assert.deepEqual(saved.snapshot, original);
    });
  });

  for (const replace of [false, true]) test(`${dialect}: provider lookups observe episode hooks after the first save, replace=${replace}`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const scenario = input.find(entry => entry.name === 'embedded Library force=' + replace);
    const items = scenario.items.map(entry => ({ ...entry, key: entry.Id, ...entry.Id === scenario.target ? { MediaType: 'Video', DateLastRefreshed: '0001-01-01T00:00:00.0000000Z' } : {} }));
    const Id = await fixture.seed({ target: scenario.target, items });
    const calls = [], lookups = []; fixture.host.updates.on('ItemUpdated', ({ Item }) => calls.push(capture(Item)));
    const load = fixture.loadContext;
    fixture.host.loadContext = async ref => { const loaded = await load(ref); loaded.libraryOptions.EnableEmbeddedEpisodeInfos = true; return loaded; };
    fixture.host.probe = { supportsMetadata: () => false, readMediaInfo: async () => structuredClone(scenario.mediaInfo) };
    fixture.registry.register({ id: 'episode-empty-lookup', name: 'Episode empty lookup', providers: [{ id: 'empty', name: 'Empty episode lookup', kind: 'remote', itemTypes: ['Episode'],
      getMetadata: async info => { lookups.push({ IndexNumber: info.IndexNumber, ParentIndexNumber: info.ParentIndexNumber }); return { HasMetadata: false }; }
    }] });
    await fixture.host.refresh(Id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', ReplaceAllMetadata: replace });
    assert.equal(calls.length, 2); assert.equal(calls[0].IndexNumber, 9); assert.equal(calls[0].ParentIndexNumber, 9);
    assert.deepEqual(lookups, [{ IndexNumber: replace ? 2 : 5, ParentIndexNumber: replace ? 1 : 4 }]);
    const saved = await load(Id);
    assert.equal(saved.item.IndexNumber, lookups[0].IndexNumber); assert.equal(saved.item.ParentIndexNumber, lookups[0].ParentIndexNumber);
    assert.equal(saved.item.SeriesName, 'Embedded series');
  });

  for (const probeReplacesFields of [false, true]) test(`${dialect}: probe reload ${probeReplacesFields ? 'keeps committed' : 'retains unsaved'} episode end, date and embedded series changes`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const scenario = input.find(entry => entry.name === 'embedded date clears numbers');
    const Id = await fixture.seed({ target: scenario.target, items: scenario.items.map(entry => ({ ...entry, key: entry.Id,
      ...entry.Id === scenario.target ? { MediaType: 'Video', IndexNumberEnd: 3 } : {} })) });
    const load = fixture.loadContext;
    fixture.host.loadContext = async ref => { const loaded = await load(ref); loaded.libraryOptions.EnableEmbeddedEpisodeInfos = true; return loaded; };
    fixture.host.probe = { supportsMetadata: () => true, readMediaInfo: async () => structuredClone(scenario.mediaInfo),
      refreshMetadata: async loaded => {
        const row = (await fixture.database.rows('BaseItems', { where: { Id } }))[0];
        await fixture.database.update('BaseItems', { Id }, { Size: 42n, ...probeReplacesFields ? {
          PremiereDate: '2025-02-03 00:00:00', SeriesName: 'New committed series',
          Data: JSON.stringify({ ...JSON.parse(row.Data), IndexNumberEnd: 8 })
        } : {} }); return { changed: true, UpdateType: 2 };
      } };
    const lookups = [];
    fixture.registry.register({ id: 'episode-probe-lookup', name: 'Episode probe lookup', providers: [{ id: 'empty', name: 'Empty episode lookup', kind: 'remote', itemTypes: ['Episode'],
      getMetadata: async info => { lookups.push(info); return { HasMetadata: false }; }
    }] });
    await fixture.host.refresh(Id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    const saved = await load(Id), expected = { ...expectedFor(scenario).result.item, ...probeReplacesFields ? {
      PremiereDate: '2025-02-03 00:00:00', SeriesName: 'New committed series', IndexNumberEnd: 8
    } : {} };
    for (const field of ['IndexNumber', 'IndexNumberEnd', 'ParentIndexNumber', 'SeriesName', 'PremiereDate', 'ProductionYear']) {
      if (field === 'PremiereDate') assert.equal(dateTicks(saved.item[field]), dateTicks(expected[field]));
      else assert.equal(saved.item[field] ?? null, expected[field]);
    }
    assert.equal(lookups[0].IndexNumber, null); assert.equal(lookups[0].IndexNumberEnd, expected.IndexNumberEnd);
    assert.equal(dateTicks(lookups[0].PremiereDate), dateTicks(expected.PremiereDate)); assert.equal(saved.snapshot.Size, 42n);
  });

  test(`${dialect}: embedded info reads leave the native database untouched and drain on close`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const scenario = input.find(entry => entry.name === 'embedded Library force=false');
    const Id = await fixture.seed({ target: scenario.target, items: scenario.items.map(entry => ({ ...entry, key: entry.Id, ...entry.Id === scenario.target ? { MediaType: 'Video' } : {} })) });
    let block = false, started, captured;
    const began = new Promise(resolve => { started = resolve; });
    const service = new ProbeService({ store: fixture.store, vfs: fixture.vfs, identityMap: fixture.identityMap,
      probe: async (bridge, virtualPath, settings) => {
        captured = { virtualPath, extractChapters: settings.extractChapters, signal: settings.signal };
        if (block) { started(); await new Promise((resolve, reject) => settings.signal.addEventListener('abort', () => reject(settings.signal.reason), { once: true })); }
        return { raw: { streams: [], format: { tags: { season_number: '4', episode_sort: '5', show_name: 'Embedded series' } } } };
      } });
    t.after(() => service.close());
    const loaded = await fixture.loadContext(Id), before = await fixture.database.rows('BaseItems');
    const info = await service.readMediaInfo(loaded);
    assert.equal(info.ParentIndexNumber, 4); assert.equal(info.IndexNumber, 5); assert.equal(info.ShowName, 'Embedded series');
    assert.equal(captured.extractChapters, false); assert.equal(captured.virtualPath, '/fixture/aggregate/Series/Season 7/Show S01E02.mkv');
    assert.deepEqual(await fixture.database.rows('BaseItems'), before); assert.deepEqual(await fixture.database.rows('MediaStreamInfos'), []);
    block = true;
    const pending = service.readMediaInfo(loaded); const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    await began; await service.close(); await rejected;
    await assert.rejects(service.readMediaInfo(loaded), error => error.name === 'AbortError');
    assert.deepEqual(await fixture.database.rows('BaseItems'), before);
  });

  for (const first of [false, true]) test(`${dialect}: request cancellation waits for embedded reads and retains ${first ? 'the first save' : 'the old record'}`, { ...options, timeout: 10000 }, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const scenario = input.find(entry => entry.name === 'embedded Library force=false');
    const Id = await fixture.seed({ target: scenario.target, items: scenario.items.map(entry => ({ ...entry, key: entry.Id,
      ...entry.Id === scenario.target ? { MediaType: 'Video', DateLastRefreshed: first ? '0001-01-01T00:00:00Z' : '2025-01-01T00:00:00Z' } : {} })) });
    const before = (await fixture.database.rows('BaseItems', { where: { Id } }))[0];
    let release, started; const began = new Promise(resolve => { started = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    fixture.host.loadContext = async ref => { const loaded = await fixture.loadContext(ref); loaded.libraryOptions.EnableEmbeddedEpisodeInfos = true; return loaded; };
    fixture.host.probe = { supportsMetadata: () => false, readMediaInfo: async () => { started(); await blocked; return scenario.mediaInfo; } };
    fixture.registry.register({ id: 'cancellation-hook', name: 'Cancellation hook', providers: [{
      id: 'empty', name: 'Empty episode lookup', kind: 'remote', itemTypes: ['Episode'], getMetadata: async () => ({ HasMetadata: false })
    }] });
    const controller = new AbortController(); let settled = false; const calls = [];
    fixture.host.updates.on('ItemUpdated', ({ Item }) => calls.push(capture(Item)));
    const pending = fixture.host.refresh(Id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None', signal: controller.signal });
    pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    await began; controller.abort(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); release(); await rejected;
    const saved = await fixture.loadContext(Id);
    assert.equal(calls.length, first ? 1 : 0);
    if (first) { assert.equal(saved.item.IndexNumber, 9); assert.equal(saved.item.ParentIndexNumber, 9); assert.equal(saved.item.SeriesName, 'Physical series'); }
    else assert.deepEqual(saved.snapshot, before);
  });
}
