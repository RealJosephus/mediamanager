import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculateSimilarScore, SimilarItemsManager,
  similarCachePath } from '../../src/library/similar-items.js';

import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { observeComparison } from '../comparison-observations.js';

const native = JSON.parse(await readFile(new URL('../http/fixtures/shows-api/native.json', import.meta.url), 'utf8'));
const actual = () => native.similarProviderOrchestration;
const item = (Id, Name, ProviderIds = {}) => ({ Id, Name, ProviderIds, PresentationUniqueKey: `${Id}-key` });
const source = item('source', 'source');

async function references(provider, value) {
  const result = [];
  for await (const reference of provider.getReferences(value, {}, undefined)) result.push(reference);
  return result;
}





const invoke = (manager, overrides = {}) => manager.getSimilarItems({
  item: source,
  itemType: 'Series',
  typeOptions: {},
  limit: 50,
  idKey: value => String(value).toLowerCase(),
  presentationKey: value => value.PresentationUniqueKey,
  presentationKeyKey: value => String(value).toLowerCase(),
  resolveRemote: async () => [],
  ...overrides,
});

function local(name, values, calls, failure) {
  return { name, kind: 'local', itemTypes: ['Series'], async getItems(_source, query) {
    calls.push({ provider: name, limit: query.limit, excludeItemIds: [...query.excludeItemIds] });
    if (failure === 'exception') throw new Error('controlled provider failure');
    if (failure === 'cancellation') throw Object.assign(new Error('controlled cancellation'), { name: 'AbortError' });
    return values.slice(0, Math.max(0, query.limit));
  } };
}

test('SimilarItemsManager matches pinned provider ordering, remaining limits, failures and cancellation', async () => {
  const values = [item('one', 'local-one'), item('two', 'local-two'), item('three', 'local-three')];
  const calls = [];
  const manager = new SimilarItemsManager({fileSystem: testFileSystem,  providers: [
    local('First', [values[0]], calls), local('Second', [values[1]], calls), local('Third', [values[2]], calls),
  ] });
  let result = await invoke(manager, { limit: 3, typeOptions: {
    SimilarItemProviders: [], SimilarItemProviderOrder: ['sEcOnD', 'FIRST', 'third'],
  } });
  assert.deepEqual(result.map(value => value.Name), actual().configuredOrder.items);
  assert.deepEqual(calls.map(call => [call.provider, call.limit]),
    actual().configuredOrder.calls.map(call => [call.provider, call.Limit]));
  assert.deepEqual(calls.map(call => call.excludeItemIds.length), [1, 2, 3]);

  calls.length = 0;
  result = await invoke(manager, { limit: 3, typeOptions: {
    SimilarItemProviders: [], SimilarItemProviderOrder: ['unregistered'],
  } });
  assert.deepEqual(result.map(value => value.Name), actual().stableRegistrationOrder.items);
  assert.deepEqual(calls.map(call => call.provider), ['First', 'Second', 'Third']);

  const failureCalls = [];
  result = await invoke(new SimilarItemsManager({fileSystem: testFileSystem,  providers: [
    local('Failure', [], failureCalls, 'exception'),
    local('After failure', values.slice(0, 2), failureCalls),
  ] }), { limit: 2 });
  assert.deepEqual(result.map(value => value.Name), actual().failureBoundary.items);
  assert.deepEqual(failureCalls.map(call => call.provider), ['Failure', 'After failure']);

  const cancellationCalls = [];
  const cancellationManager = new SimilarItemsManager({fileSystem: testFileSystem,  providers: [
    local('Before cancellation', values.slice(0, 1), cancellationCalls),
    local('Cancellation', [], cancellationCalls, 'cancellation'),
    local('After cancellation', values.slice(1, 2), cancellationCalls),
  ] });
  result = await invoke(cancellationManager, { limit: 3 });
  assert.deepEqual(result.map(value => value.Name), actual().cancellationBoundary.items);
  assert.deepEqual(cancellationCalls.map(call => call.provider), ['Before cancellation', 'Cancellation']);
  cancellationCalls.length = 0;
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await invoke(cancellationManager, { limit: 3, signal: controller.signal }), []);
  assert.deepEqual(cancellationCalls, []);
});

async function batch(count, resolve) {
  let yielded = 0;
  const querySizes = [];
  const remote = { name: 'Batch Remote', kind: 'remote', itemTypes: ['Series'],
    async *getReferences() {
      for (let index = 0; index < count; index++) {
        yielded++;
        yield { ProviderName: 'BatchKey', ProviderId: String(index).padStart(3, '0') };
      }
    } };
  const candidates = [item('batch-zero', 'batch-zero', { BatchKey: '000' }),
    item('batch-one', 'batch-one', { BatchKey: '001' })];
  const result = await invoke(new SimilarItemsManager({fileSystem: testFileSystem,  providers: [remote] }), {
    limit: 2,
    typeOptions: { SimilarItemProviders: ['bAtCh ReMoTe'], SimilarItemProviderOrder: [] },
    resolveRemote: async references => {
      querySizes.push(references.length);
      return resolve ? candidates : [];
    },
  });
  return { yielded, querySizes, items: result.map(value => value.Name) };
}

test('SimilarItemsManager matches pinned 20-reference batches and 500-reference cap', async () => {
  const expected = actual().batches;
  for (const [index, input] of [[0, [21, false]], [1, [501, false]], [2, [501, true]]]) {
    const result = await batch(...input);
    assert.equal(result.yielded, expected[index].Yielded);
    assert.deepEqual(result.querySizes, expected[index].querySizes);
    assert.deepEqual(result.items, expected[index].items);
  }
});

test('SimilarItemsManager uses native ordinal-ignore-case provider identity without lowercase overreach', async () => {
  const candidates = [
    item('unicode-greek', 'unicode-greek', { '\u03c2': 'value\u03c2' }),
    item('unicode-dotted', 'unicode-dotted', { 'i\u0307': 'i\u0307' }),
    item('unicode-kelvin', 'unicode-kelvin', { K: 'K' }),
    item('unicode-sharp', 'unicode-sharp', { '\u00df': '\u00df' }),
  ];
  const remote = {
    name: 'Unicode Remote', kind: 'remote', itemTypes: ['series'],
    async *getReferences() {
      yield { ProviderName: '\u03a3', ProviderId: 'VALUE\u03a3' };
      yield { ProviderName: '\u0130', ProviderId: '\u0130' };
      yield { ProviderName: '\u212a', ProviderId: '\u212a' };
      yield { ProviderName: '\u1e9e', ProviderId: '\u1e9e' };
    },
  };
  const manager = new SimilarItemsManager({fileSystem: testFileSystem,  providers: [remote] });
  const result = await invoke(manager, {
    limit: 10,
    typeOptions: { SimilarItemProviders: ['unicode remote'], SimilarItemProviderOrder: [] },
    resolveRemote: async () => candidates,
  });
  assert.deepEqual(result.map(value => value.Id), ['unicode-greek'],
    'sigma variants match, while dotted-I, Kelvin-sign and sharp-S pairs remain distinct');

  const configured = new SimilarItemsManager({fileSystem: testFileSystem,  providers: [
    { ...remote, name: '\u03a3' },
    { ...remote, name: '\u0130' },
    { ...remote, name: '\u212a' },
    { ...remote, name: '\u1e9e' },
  ] }).matchingProviders('Series', {
    SimilarItemProviders: ['\u03c2', 'i\u0307', 'K', '\u00df'],
    SimilarItemProviderOrder: ['\u03c3'],
  });
  assert.deepEqual(configured.map(provider => provider.name), ['\u03a3']);

  assert.match(similarCachePath('cache', '\u039f\u03a3', 'Series', 'AA-BB'),
    /\u03bf\u03c3-similar-series[\\/]aabb\.json$/u,
    'cache paths retain native invariant-lower casing rather than provider comparison keys');
});

test('SimilarItemsManager takes the requested limit before access filtering without refill', async () => {
  const calls = [];
  const denied = item('denied', 'denied'), allowed = item('allowed', 'allowed'), refill = item('refill', 'refill');
  const result = await invoke(new SimilarItemsManager({fileSystem: testFileSystem,  providers: [
    local('Local', [denied, allowed, refill], calls),
  ] }), { limit: 1, filterAccess: async values => values.filter(value => value !== denied) });
  assert.deepEqual(result, []);
  assert.deepEqual(calls.map(call => call.limit), [1]);
  assert.deepEqual(actual().preCancellationBoundary, { items: [], calls: [] });
  assert.deepEqual(native.similarItemsManager.limitedBeforeAccessFilter.items, []);
});

test('SimilarItemsManager preserves score comparisons and stable equal-score order', async t => {
  const bits = value => {
    const bytes = new ArrayBuffer(4);
    new DataView(bytes).setFloat32(0, value, true);
    return new DataView(bytes).getInt32(0, true);
  };
  const scores = [];
  for (const entry of actual().scoreMath.cases) {
    const value = calculateSimilarScore(entry.matchScore, entry.providerOrder, entry.position);
    const bytes = new ArrayBuffer(4), view = new DataView(bytes);
    view.setInt32(0, entry.bits, true);
    scores.push({ name: entry.name, value, native: view.getFloat32(0, true) });
    observeComparison(t, entry.name + ' hidden score bits', bits(value), entry.bits);
  }
  for (const left of scores) for (const right of scores) assert.equal(Math.sign(left.value - right.value),
    Math.sign(left.native - right.native), `${left.name}/${right.name}`);
  t.diagnostic('native score controls ' + JSON.stringify({ equalInputs: actual().scoreMath.equalInputs,
    roundingTie: actual().scoreMath.cases.filter(entry => entry.name.startsWith('rounding tie')) }));

  const first = item('float-first', 'float-first', { Tmdb: '101' });
  const second = item('float-second', 'float-second', { Tmdb: '102' });
  const remote = { name: 'Float Scores', kind: 'remote', itemTypes: ['Series'],
    async *getReferences() {
      yield { ProviderName: 'Tmdb', ProviderId: '101', Score: 0.1 };
      yield { ProviderName: 'Tmdb', ProviderId: '102', Score: 0.100000001 };
    } };
  const result = await invoke(new SimilarItemsManager({fileSystem: testFileSystem,  providers: [remote] }), {
    limit: 2,
    typeOptions: { SimilarItemProviders: ['fLoAt ScOrEs'], SimilarItemProviderOrder: [] },
    resolveRemote: async () => [first, second],
  });
  assert.deepEqual(result.map(value => value.Name), actual().stableFloatScoreOrder.items
    .map(name => name === 'remote-one' ? 'float-first' : 'float-second'));
});
