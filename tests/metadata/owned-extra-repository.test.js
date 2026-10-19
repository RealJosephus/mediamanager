import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { guid } from '../../src/library/records.js';
import { OwnedItemMetadataLifecycleHost } from '../../src/metadata/owned-item-lifecycle.js';
import { prepareOwnedItemRefresh } from '../../src/metadata/owned-item-refresh.js';
import { persistMetadata } from '../../src/metadata/persistence.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { setup, project } from './owned-extra-fixture.js';
import { fixturePathStyle } from '../library/fixture-state-path.js';

const root = new URL('./fixtures/owned-extra-repository/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async name => parseLosslessJson(await readFile(new URL(name, root), 'utf8'))));

test('owned extra repository recording seals independent files, real first inserts and controlled provider scope', async () => {
  for (const file of provenance.fixtureFiles) {
    const source = file.path === 'tests/Directory.Build.props' ? new URL('../../../Directory.Build.props', root)
      : new URL(file.path.split('/').at(-1), root);
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), file.sha256, file.path);
  }
  assert.equal(native.actualFrozenOwnedExtraRepository, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope); assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(sample => sample.name), input.map(sample => sample.name));
  assert.deepEqual(native.results.map(sample => sample.exception), input.map(sample => sample.expectException ?? null));
  assert.equal(native.results.length, 15);
});

for (const dialect of ['postgres']) for (const sample of input) test(`${dialect}: native extra repository ${sample.name}`, async t => {
  const value = await setup(t, dialect, sample, { recordInserts: false }), { fixture, loaded, calls } = value;
  const cancellation = new AbortController();
  const abort = () => cancellation.abort(Object.assign(new Error('Controlled cancellation'), { nativeException: 'OperationCanceledException' }));
  if (sample.cancelled) abort();
  const options = { ForceSave: false, MetadataRefreshMode: sample.fullRefresh ? 'FullRefresh' : 'None', ImageRefreshMode: 'None',
    SearchResult: { Name: 'Owner search' }, signal: cancellation.signal };
  const recordRefresh = (item, options) => {
    calls.push({ action: 'refresh', item: value.projectItem(item), forceSave: options.ForceSave === true,
      hasSearchResult: options.SearchResult != null, cancellationRequested: options.signal.aborted });
    options.signal.throwIfAborted();
  };
  fixture.host.updates.on('ItemUpdated', event => calls.push({ action: 'event', kind: 'updated', id: guid(event.Item.Id), reason: event.UpdateReason }));
  let providerQueue = Promise.resolve();
  const lifecycle = new OwnedItemMetadataLifecycleHost({ store: fixture.store, updates: fixture.host.updates, registry: fixture.registry,
    loadContext: fixture.loadContext,
    refreshOwnedItem(_, child, options, inheritance) {
      // This recording's provider and EF calls complete synchronously. Model
      // that controlled scheduling here; the production wrapper stays parallel.
      const task = providerQueue.then(async () => {
      recordRefresh(child, prepareOwnedItemRefresh(loaded.item, child, options, inheritance));
      // The native controlled single-item provider calls only the actual
      // repository lifecycle. BeforeSave/probe/provider selection is separate.
      const context = await loaded.loadDraftContext(child);
      if (!context.snapshot) context.creationIntent = 'owned-extra';
      await fixture.host.updates.updateRepository(context, { Item: child, Images: null }, ItemUpdateType.MetadataImport, {
        signal: options.signal,
        async saverOperation(item, reason) {
          calls.push({ action: 'saver', id: guid(item.Id), reason });
          if (sample.saverFile) await fixture.vfs.write(fixture.identityMap.resolve({ identityPath: item.Path + '.saved', style: fixturePathStyle }), Buffer.from('saver control'));
          if (sample.cancelDuringSaver) abort();
          return [];
        },
        async persist(_, result, saveOptions) {
          calls.push({ action: 'save', items: [value.projectItem(result.Item)], cancellable: true });
          return persistMetadata(fixture.store, context, result, saveOptions);
        }
      });
      });
      providerQueue = task.catch(() => {});
      return task;
    } });
  let requiresSave = false, exception = null;
  try { requiresSave = await lifecycle.beforeRefresh(loaded, options); }
  catch (error) { if (!cancellation.signal.aborted && !sample.newFailure && !sample.failure) throw error; }
  try { recordRefresh(loaded.item, { ...options, ForceSave: requiresSave }); }
  catch (error) { exception = error.nativeException; }
  assert.deepEqual(await project(value, sample, exception, { repository: true }), native.results.find(result => result.name === sample.name));
});
