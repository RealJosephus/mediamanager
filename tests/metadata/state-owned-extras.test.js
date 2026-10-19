import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { OwnedItemMetadataLifecycleHost } from '../../src/metadata/owned-item-lifecycle.js';
import { prepareOwnedItemRefresh } from '../../src/metadata/owned-item-refresh.js';
import { setupStateOwned, projectStateOwned, projectStateItem } from './state-owned-fixture.js';

const root = new URL('./fixtures/state-owned-extras/', import.meta.url);
const input = parseLosslessJson(await readFile(new URL('input.json', root), 'utf8'));
const native = parseLosslessJson(await readFile(new URL('native.json', root), 'utf8'));
const provenance = parseLosslessJson(await readFile(new URL('provenance.json', root), 'utf8'));

test('state owned recording seals actual initial state, provider controls and independent native repeats', async () => {
  for (const key of ['input', 'native', 'oracle', 'project']) {
    const descriptor = provenance.files[key];
    assert.equal(createHash('sha256').update(await readFile(new URL(descriptor.filename, root))).digest('hex'), descriptor.sha256);
  }
  assert.equal(native.actualStateOwnedExtras, true); assert.equal(native.candidateVerified, false);
  assert.equal(native.inputSha256, provenance.files.input.sha256); assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.equal(provenance.repeat.rawSha256, provenance.files.rawRecording.sha256);
  assert.equal(provenance.repeat.byteEqual, true); assert.equal(native.results.length, 28);
  assert.deepEqual(native.results.map(value => value.name), input.map(value => value.name));
  assert.deepEqual(native.results.map(value => value.exception), input.map(value => value.expectException ?? null));
  for (const value of native.results) {
    assert.ok(value.initialRows.every(row => Object.keys(row).length === 72));
    assert.ok(value.initialRows.some(row => row.Type === 'MediaBrowser.Controller.Entities.Folder'));
    assert.ok(value.initialRows.some(row => row.Name === 'Stored owner'));
  }
});

for (const sample of input) test('postgres: native state owned ' + sample.name, async t => {
  const expected = native.results.find(result => result.name === sample.name);
  const value = await setupStateOwned(t, sample, expected), { fixture, loaded, calls } = value;
  const signal = sample.cancelled ? AbortSignal.abort(Object.assign(new Error('Controlled cancellation'),
    { nativeException: 'OperationCanceledException' })) : new AbortController().signal;
  const options = { ForceSave: false, MetadataRefreshMode: sample.fullRefresh ? 'FullRefresh' : 'None',
    ImageRefreshMode: 'None', SearchResult: { Name: 'Owner search' }, signal };
  const recordRefresh = async (item, options) => {
    calls.push({ action: 'refresh', item: await projectStateItem(item, value), forceSave: options.ForceSave === true,
      hasSearchResult: options.SearchResult != null, cancellationRequested: options.signal.aborted });
    options.signal.throwIfAborted();
  };
  const lifecycle = new OwnedItemMetadataLifecycleHost({ store: fixture.store, updates: fixture.host.updates,
    registry: fixture.registry, loadContext: fixture.loadContext,
    async refreshOwnedItem(_, child, options, inheritance) {
      const item = typeof child === 'string' ? await loaded.videoVersionDiscovery.lookup(loaded, child) : child;
      await recordRefresh(item, prepareOwnedItemRefresh(loaded.item, item, options, inheritance));
    } });
  let requiresSave = false, exception = null;
  try { requiresSave = await lifecycle.beforeRefresh(loaded, options); }
  catch (error) { assert.ok(signal.aborted, error.stack); }
  // Match the real native wrapper's owned-error boundary and controlled
  // single-item provider, without claiming a full native provider chain.
  try { await recordRefresh(loaded.item, { ...options, ForceSave: requiresSave }); }
  catch (error) { exception = error.nativeException; }
  assert.deepEqual(await projectStateOwned(value, exception), expected);
});
