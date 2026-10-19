import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { OwnedItemMetadataLifecycleHost } from '../../src/metadata/owned-item-lifecycle.js';
import { prepareOwnedItemRefresh } from '../../src/metadata/owned-item-refresh.js';
import { projectItem, setup, project } from './owned-extra-fixture.js';

const root = new URL('./fixtures/owned-extra-discovery/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async name => parseLosslessJson(await readFile(new URL(name, root), 'utf8'))));

test('owned extra recording binds actual discovery/delete and controlled provider scope', async () => {
  for (const file of provenance.fixtureFiles) {
    const source = file.path === 'tests/Directory.Build.props' ? new URL('../../../Directory.Build.props', root)
      : new URL(file.path.split('/').at(-1), root);
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), file.sha256, file.path);
  }
  assert.equal(native.actualFrozenOwnedExtraDiscovery, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope); assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(sample => sample.name), input.map(sample => sample.name));
  assert.deepEqual(native.results.map(sample => sample.exception), input.map(sample => sample.expectException ?? null));
  assert.equal(native.results.length, 17);
});

for (const dialect of ['postgres']) for (const sample of input) test(`${dialect}: native owned extra ${sample.name}`, async t => {
  const value = await setup(t, dialect, sample), { fixture, loaded, calls } = value;
  const signal = sample.cancelled ? AbortSignal.abort(Object.assign(new Error('Controlled cancellation'), { nativeException: 'OperationCanceledException' })) : new AbortController().signal;
  const options = { ForceSave: false, MetadataRefreshMode: sample.fullRefresh ? 'FullRefresh' : 'None', ImageRefreshMode: 'None', SearchResult: { Name: 'Owner search' }, signal };
  const recordRefresh = (item, options) => {
    calls.push({ action: 'refresh', item: projectItem(item, fixture.stateRoot), forceSave: options.ForceSave === true,
      hasSearchResult: options.SearchResult != null, cancellationRequested: options.signal.aborted });
    options.signal.throwIfAborted();
  };
  const lifecycle = new OwnedItemMetadataLifecycleHost({ store: fixture.store, updates: fixture.host.updates, registry: fixture.registry, loadContext: fixture.loadContext,
    async refreshOwnedItem(_, child, options, inheritance) {
      // The controlled native provider receives the same cached entity. Its
      // inherited fields survive a repeated dispatch without a provider save.
      const item = typeof child === 'string' ? await loaded.videoVersionDiscovery.lookup(loaded, child) : child;
      recordRefresh(item, prepareOwnedItemRefresh(loaded.item, item, options, inheritance));
    } });
  let requiresSave = false, exception = null;
  try {
    requiresSave = await lifecycle.beforeRefresh(loaded, options);
  }
  catch (error) {
    if (!signal.aborted && !sample.newFailure) assert.ok(error.code === 'metadata-conflict', error.stack);
  }
  // The native wrapper logs owned failure and still dispatches its owner.
  // The single-item provider in this oracle intentionally performs no save.
  try { recordRefresh(loaded.item, { ...options, ForceSave: requiresSave }); }
  catch (error) { exception = error.nativeException; }
  assert.deepEqual(await project(value, sample, exception), native.results.find(result => result.name === sample.name));
});
