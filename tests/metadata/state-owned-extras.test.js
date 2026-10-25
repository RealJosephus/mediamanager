import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { OwnedItemMetadataLifecycleHost } from '../../src/metadata/owned-item-lifecycle.js';
import { prepareOwnedItemRefresh } from '../../src/metadata/owned-item-refresh.js';
import { setupStateOwned, projectStateOwned, projectStateItem } from './state-owned-fixture.js';
import { assertOwnedParentConsumers } from './owned-extra-fixture.js';

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
  assert.deepEqual(native.results.map(value => value.exception != null), input.map(value => value.cancelled === true));
  for (const value of native.results) {
    assert.ok(value.initialRows.every(row => Object.keys(row).length === 72));
    assert.ok(value.initialRows.some(row => row.Type === 'MediaBrowser.Controller.Entities.Folder'));
    assert.ok(value.initialRows.some(row => row.Name === 'Stored owner'));
  }
});

for (const sample of input) test('postgres: native state owned ' + sample.name, async t => {
  const expected = native.results.find(result => result.name === sample.name);
  const value = await setupStateOwned(t, sample, expected), { fixture, loaded, calls } = value;
  const cancellationReason = Object.assign(new Error('Controlled cancellation'), { code: 'controlled-owned-cancellation' });
  const signal = sample.cancelled ? AbortSignal.abort(cancellationReason) : new AbortController().signal;
  const options = { ForceSave: false, MetadataRefreshMode: sample.fullRefresh ? 'FullRefresh' : 'None',
    ImageRefreshMode: 'None', SearchResult: { Name: 'Owner search' }, signal };
  const recordRefresh = async (item, options) => {
    // Native records entry synchronously. Filesystem timestamp verification is
    // asynchronous here and must not reorder concurrent provider invocations.
    const call = { action: 'refresh', item: null, forceSave: options.ForceSave === true,
      hasSearchResult: options.SearchResult != null, cancellationRequested: options.signal.aborted };
    calls.push(call);
    call.item = await projectStateItem(item, value);
    options.signal.throwIfAborted();
  };
  const lifecycle = new OwnedItemMetadataLifecycleHost({ store: fixture.store, updates: fixture.host.updates,
    registry: fixture.registry, loadContext: fixture.loadContext,
    async refreshOwnedItem(_, child, options, inheritance) {
      const item = typeof child === 'string' ? await loaded.videoVersionDiscovery.lookup(loaded, child) : child;
      await recordRefresh(item, prepareOwnedItemRefresh(loaded.item, item, options, inheritance));
    } });
  let requiresSave = false, failed = false, ownedError = null, ownerError = null;
  try { requiresSave = await lifecycle.beforeRefresh(loaded, options); }
  catch (error) { ownedError = error.stack ?? String(error); assert.ok(signal.aborted, error.stack); }
  // Match the real native wrapper's owned-error boundary and controlled
  // single-item provider, without claiming a full native provider chain.
  try { await recordRefresh(loaded.item, { ...options, ForceSave: requiresSave }); }
  catch (error) {
    failed = true; ownerError = error.stack ?? String(error);
    assert.equal(signal.aborted, true); assert.equal(error.code, cancellationReason.code);
    assert.equal(error.message, cancellationReason.message);
  }
  assert.equal(signal.aborted, sample.cancelled === true);
  const { exception: nativeFailureDiagnostic, parentChildrenCleared, parentUserDataCleared, ...expectedState } = expected;
  t.diagnostic(JSON.stringify({ nativeFailureDiagnostic, nativeParentCacheDiagnostic: { parentChildrenCleared, parentUserDataCleared }, ownedError, ownerError,
    cancellation: { aborted: signal.aborted, reason: signal.reason?.stack ?? null, code: signal.reason?.code ?? null } }));
  await assertOwnedParentConsumers(t, value, expectedState, item => projectStateItem(item, value));
  assert.deepEqual(await projectStateOwned(value, failed), { ...expectedState, failed: nativeFailureDiagnostic != null });
});
