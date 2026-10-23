import assert from 'node:assert/strict';
import { guid } from '../../src/library/records.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { persistMetadata } from '../../src/metadata/persistence.js';
import { typeName, discoveryFixture, projectItem, projectDiscovery } from './video-discovery-fixture.js';

const ids = { owner: '98C00000-0000-0000-0000-000000000001' };
export async function runVideoIgnoreScenario(t, dialect, sample) {
  const value = await discoveryFixture(t, dialect, sample), { fixture, loaded, calls, target } = value;
  const cancellation = new AbortController();
  if (sample.cancelled) cancellation.abort(Object.assign(new Error('Controlled cancellation'), { nativeException: 'OperationCanceledException' }));
  let resolved = null, exception = null;
  try {
    if (sample.operation === 'resolve') resolved = await loaded.videoVersionDiscovery.resolveAlternateVersion(loaded, target, typeName(sample.expectedType),
      await loaded.getVideoVersionCollectionType(), { reportRemoved: (item, parent) => fixture.host.updates.reportItemRemoved(item, parent) });
    else await fixture.host.updates.updateRepository(loaded, { Item: loaded.item, Images: null }, ItemUpdateType.MetadataImport, {
      signal: cancellation.signal,
      saverOperation: async () => { value.activate(); calls.push({ action: 'saver', id: guid(ids.owner), reason: 2 }); return []; },
      persist: async (updated, result, options) => {
        calls.push({ action: 'save', items: [updated.item, ...options.newVersions].map(item => projectItem(item, fixture.stateRoot)), cancellable: true });
        return persistMetadata(fixture.store, loaded, result, options);
      }
    });
  } catch (error) {
    if (error.nativeException) exception = error.nativeException;
    else {
      assert.ok(sample.expectException, error.stack);
      assert.equal(error.code, 'P0001', error.stack);
      exception = sample.failure === 'delete' ? 'SqliteException' : 'DbUpdateException';
    }
  }
  return projectDiscovery(fixture, loaded, sample, { ...value, resolved, exception });
}
