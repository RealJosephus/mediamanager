import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { guid } from '../../src/library/records.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { persistMetadata } from '../../src/metadata/persistence.js';

import { typeName, discoveryFixture, projectItem, projectDiscovery } from './video-discovery-fixture.js';

const root = new URL('./fixtures/video-version-ignore/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async name => parseLosslessJson(await readFile(new URL(name, root), 'utf8'))));
const ids = { owner: '98C00000-0000-0000-0000-000000000001', parent: '98C00000-0000-0000-0000-000000000002' };

test('video version discovery ignore recording seals actual rules/resolver/batch/delete and exact Int64', async () => {
  for (const file of provenance.fixtureFiles) {
    const source = file.path === 'tests/Directory.Build.props' ? new URL('../../../Directory.Build.props', root)
      : new URL(file.path.split('/').at(-1), root);
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), file.sha256, file.path);
  }
  assert.equal(native.actualFrozenVideoVersionDiscovery, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope); assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.deepEqual(native.results.map(result => result.exception), input.map(sample => sample.expectException ?? null));
  assert.equal(native.results.length, 26);
  const existing = native.results.find(result => result.name === 'update-existing-bypasses-exclusion');
  assert.equal(existing.rows.find(row => row.name === 'Old version').runTimeTicks, 9007199254740995n);
});

for (const dialect of ['postgres']) for (const sample of input) {
  test(`${dialect}: complete native ignore discovery ${sample.name}`, { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const value = await discoveryFixture(t, dialect, sample), { fixture, loaded, calls, target } = value;
    const cancellation = new AbortController();
    if (sample.cancelled) cancellation.abort(Object.assign(new Error('Controlled cancellation'), { nativeException: 'OperationCanceledException' }));
    let resolved = null, exception = null;
    try {
      if (sample.operation === 'resolve') resolved = await loaded.videoVersionDiscovery.resolveAlternateVersion(loaded, target, typeName(sample.expectedType),
        { reportRemoved: (item, parent) => fixture.host.updates.reportItemRemoved(item, parent) });
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
    assert.deepEqual(await projectDiscovery(fixture, loaded, sample, { ...value, resolved, exception }), native.results.find(result => result.name === sample.name));
  });
}
