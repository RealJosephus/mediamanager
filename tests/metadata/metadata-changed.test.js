import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { onMetadataChanged } from '../../src/metadata/metadata-changed.js';
import { itemParentalRating } from '../../src/library/parental-rating.js';
import { idKey, dateText } from '../../src/library/records.js';
import { MetadataEditService } from '../../src/metadata/edit-service.js';
import { setupChildrenFixture } from './children-fixture.js';

const root = new URL('./fixtures/metadata-changed/', import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', root), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));
const fields = ['Name', 'OfficialRating', 'CustomRating', 'PreferredMetadataCountryCode', 'IsLocked', 'InheritedParentalRatingValue', 'InheritedParentalRatingSubValue'];
const capture = (item, updateType = null) => ({ ...Object.fromEntries(fields.map(field => [field, item[field] ?? null])), updateType });
const expectedFor = scenario => native.results.find(entry => entry.name === scenario.name);
const scenarioFor = name => input.find(entry => entry.name === name);

test('metadata change recording seals native inheritance, controller order and explicit callbacks', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  for (const [key, filename] of Object.entries({ input: 'input.json', native: 'native.json', oracle: 'Program.cs', project: 'Oracle.csproj' })) {
    assert.equal(createHash('sha256').update(await readFile(new URL(filename, root))).digest('hex'), provenance.files[key].sha256);
  }
  assert.equal(createHash('sha256').update(await readFile(new URL('../Directory.Build.props', import.meta.url))).digest('hex'), provenance.files.buildProperties.sha256);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 40); assert.equal(native.results.length, input.length);
});

for (const scenario of input.filter(entry => entry.mode === 'change')) test(`native OnMetadataChanged: ${scenario.name}`, () => {
  const items = structuredClone(scenario.items).map(item => ({ ...item, Type: item.type,
    ParentId: scenario.items.find(parent => parent.key === item.parent)?.Id }));
  const state = { items, byId: new Map(items.map(item => [idKey(item.Id), item])), parents: [], links: [] };
  const item = items.find(item => item.key === scenario.target), steps = [];
  const configuration = { MetadataCountryCode: Object.hasOwn(scenario, 'globalCountry') ? scenario.globalCountry : 'US' };
  let exception = null;
  try {
    steps.push(capture(item, onMetadataChanged(item, itemParentalRating(item, state, { configuration }))));
    for (const change of scenario.changes ?? []) Object.assign(items.find(item => item.key === change.key), change.fields);
    steps.push(capture(item, onMetadataChanged(item, itemParentalRating(item, state, { configuration }))));
    assert.equal(scenario.expectException, undefined, 'an expected native failure must occur');
  } catch (error) {
    if (!scenario.expectException) throw error;
    exception = error.nativeException; assert.equal(exception, scenario.expectException);
  }
  const expected = expectedFor(scenario);
  assert.deepEqual(steps, expected.steps); assert.equal(exception, expected.exception);
  assert.deepEqual(items.map(item => ({ key: item.key, result: capture(item) })), expected.items);
});

for (const dialect of ['postgres']) {
  const options = {};
  test(`${dialect}: None refresh commits native rating changes and preserves lone stale subscores`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    for (const name of ['empty rating retains a stale subscore when the main score is null',
      'empty rating clears both scores when the main score exists', 'changed PG subscore alone produces Import', 'US PG initializes both scores']) {
      await t.test(name, async () => {
        const scenario = scenarioFor(name), expected = expectedFor(scenario).steps[0];
        const Id = await fixture.seed(scenario);
        const original = (await fixture.database.rows('BaseItems', { where: { Id } }))[0];
        const result = await fixture.host.refresh(Id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
        assert.equal(result.UpdateType, expected.updateType);
        assert.equal(result.changed, expected.updateType > 1);
        assert.deepEqual(capture((await fixture.loadContext(Id)).item), { ...expected, updateType: null });
        if (expected.updateType === 1) assert.deepEqual((await fixture.database.rows('BaseItems', { where: { Id } }))[0], original);
      });
    }
  });
  test(`${dialect}: field edits match native child rating and lock propagation save order`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect);
    const serializeWrites = fixture.store.serializeWrites.bind(fixture.store);
    let writerBoundaries = 0;
    fixture.store.serializeWrites = (operation, writerOptions) => serializeWrites(async database => {
      writerBoundaries += 1;
      return operation(database);
    }, writerOptions);
    const edits = new MetadataEditService({ library: fixture.library, loadContext: fixture.loadContext, updates: fixture.host.updates });
    t.after(() => edits.close());
    for (const scenario of input.filter(entry => entry.mode === 'edit')) await t.test(scenario.name, async () => {
      const Id = await fixture.seed(scenario), calls = [];
      const report = ({ Item, UpdateReason }) => {
        const { updateType, ...result } = capture(Item);
        calls.push({ Id: idKey(Item.Id), ...result, updateReason: UpdateReason });
      };
      fixture.host.updates.on('ItemUpdated', report);
      const previousBoundaries = writerBoundaries;
      try { await edits.update(Id, scenario.request); } finally { fixture.host.updates.off('ItemUpdated', report); }
      assert.equal(writerBoundaries, previousBoundaries + 1, 'the complete multi-save edit shares one writer boundary');
      const expected = expectedFor(scenario);
      assert.deepEqual(calls, expected.calls.map(call => ({ ...call, Id: idKey(call.Id) })));
      for (const definition of scenario.items) {
        const loaded = await fixture.loadContext(definition.Id);
        assert.deepEqual(capture(loaded.item), expected.items.find(entry => entry.key === definition.key).result);
      }
    });
  });
  test(`${dialect}: full stamp save retains a native lone subscore`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect), scenario = scenarioFor('empty rating retains a stale subscore when the main score is null');
    const Id = await fixture.seed(scenario);
    const result = await fixture.host.refresh(Id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
    assert.equal(result.changed, true); assert.equal(result.UpdateType, 1);
    assert.equal((await fixture.loadContext(Id)).item.InheritedParentalRatingSubValue, 9);
  });
  test(`${dialect}: first save includes inherited ratings before provider cancellation`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect), scenario = structuredClone(scenarioFor('US PG initializes both scores'));
    scenario.items[0].DateLastRefreshed = '0001-01-01T00:00:00.0000000Z';
    const Id = await fixture.seed(scenario);
    let saved;
    fixture.registry.register({ id: 'cancel-rating', name: 'Cancel rating', providers: [{ id: 'remote', name: 'Cancel rating', kind: 'remote', itemTypes: ['Movie'],
      async getMetadata() { saved = capture((await fixture.loadContext(Id)).item); throw new DOMException('Injected cancellation after rating first save', 'AbortError'); }
    }] });
    await assert.rejects(fixture.host.refresh(Id, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' }), error => error.name === 'AbortError');
    assert.deepEqual(saved, { ...expectedFor(scenario).steps[0], updateType: null });
    const after = await fixture.loadContext(Id);
    assert.deepEqual(capture(after.item), saved); assert.equal(after.snapshot.DateLastRefreshed, null);
    assert.ok(after.item.DateLastSaved);
    const expected = expectedFor(scenarioFor('first save includes inherited ratings before provider cancellation'));
    assert.equal(expected.exception, 'OperationCanceledException'); assert.equal(expected.refresh.saved, true);
    assert.equal(expected.refresh.stampChanged, false); assert.deepEqual(saved, expected.items[0].result);
  });
  test(`${dialect}: invalid country fails before the first item save`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect), scenario = structuredClone(scenarioFor('null global country fails before mutating scores'));
    fixture.configuration.MetadataCountryCode = null;
    scenario.items[0].DateLastRefreshed = '0001-01-01T00:00:00.0000000Z';
    const Id = await fixture.seed(scenario), original = await fixture.database.rows('BaseItems');
    await assert.rejects(fixture.host.refresh(Id, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' }), error => error.nativeException === scenario.expectException);
    assert.deepEqual(await fixture.database.rows('BaseItems'), original);
  });
  for (const control of [
    { name: 'successful Default runs the second rating call and saves an unreported provider rating', mode: 'Default', force: false, expectedScore: 17, expectedSubScore: 0, expectedUpdate: 3, expectedFailures: 0, stamp: true },
    { name: 'ValidationOnly force save retains scores from the first rating call', mode: 'ValidationOnly', force: true, expectedScore: 10, expectedSubScore: 0, expectedUpdate: 9, expectedFailures: 0, stamp: false },
    { name: 'provider failure suppresses the second rating call even with force save', mode: 'FullRefresh', force: true, fail: true, expectedScore: 10, expectedSubScore: 0, expectedUpdate: 9, expectedFailures: 1, stamp: false },
    { name: 'local image failure suppresses the second rating call', mode: 'FullRefresh', force: false, imageFail: true, update: 2, expectedScore: 10, expectedSubScore: 0, expectedUpdate: 3, expectedFailures: 0, stamp: false }
  ]) test(`${dialect}: ${control.name}`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect), scenario = scenarioFor(control.name), expected = expectedFor(scenario);
    const Id = await fixture.seed(scenario);
    const calls = [];
    fixture.host.updates.on('ItemUpdated', ({ Item, UpdateReason }) => {
      const { updateType, ...result } = capture(Item); calls.push({ Id: idKey(Item.Id), ...result, updateReason: UpdateReason });
    });
    fixture.registry.register({ id: 'rating-change', name: 'Rating change', providers: [{ id: 'custom', name: 'Rating change', kind: 'custom', itemTypes: ['Movie'],
      hasChanged: async () => true, async fetch(item) { item.OfficialRating = 'R'; if (control.fail) throw new Error('Injected provider failure after rating mutation'); return control.update ?? 1; }
    }] });
    if (control.imageFail) fixture.host.images.merge = async () => { throw new Error('Injected local image validation failure'); };
    const result = await fixture.host.refresh(Id, { MetadataRefreshMode: control.mode, ImageRefreshMode: 'None', ForceSave: control.force });
    assert.equal(result.changed, true); assert.equal(result.UpdateType, control.expectedUpdate); assert.equal(result.Failures, control.expectedFailures);
    assert.equal(result.changed, expected.refresh.saved); assert.equal(result.UpdateType, expected.refresh.updateType);
    assert.deepEqual(calls, expected.calls.map(call => ({ ...call, Id: idKey(call.Id) })));
    const loaded = await fixture.loadContext(Id);
    assert.deepEqual(capture(loaded.item), expected.items[0].result);
    assert.equal(loaded.item.OfficialRating, 'R'); assert.equal(loaded.item.InheritedParentalRatingValue, control.expectedScore);
    assert.equal(loaded.item.InheritedParentalRatingSubValue, control.expectedSubScore);
    assert.equal(dateText(loaded.item.DateLastRefreshed), control.stamp ? fixture.now : scenario.items[0].DateLastRefreshed);
    assert.equal(control.stamp, expected.refresh.stampChanged);
  });
  test(`${dialect}: probe reload retains the first rating result before a ValidationOnly final save`, options, async t => {
    const fixture = await setupChildrenFixture(t, dialect), scenario = scenarioFor('US PG initializes both scores');
    const Id = await fixture.seed(scenario);
    fixture.host.probe = { supportsMetadata: () => true, hasChanged: async () => true,
      refreshMetadata: async () => { await fixture.database.update('BaseItems', { Id }, { Size: 42n }); return { changed: true, UpdateType: 2 }; } };
    const result = await fixture.host.refresh(Id, { MetadataRefreshMode: 'ValidationOnly', ImageRefreshMode: 'None' });
    assert.equal(result.UpdateType, 3); assert.equal(result.changed, true);
    const loaded = await fixture.loadContext(Id);
    assert.deepEqual(capture(loaded.item), { ...expectedFor(scenario).steps[0], updateType: null });
    assert.equal(loaded.item.Size, 42n);
  });
}
