import test from 'node:test';
import assert from 'node:assert/strict';
import { setupPlaylistDeletion, playlistDeletionId as id } from '../library/playlist-deletion-fixture.js';
import { createApplication } from '../../src/http/application.js';
import { guid } from '../../src/library/records.js';
import { normalizeDeletionRecording } from './fixtures/warm-item-deletion/normalize.js';
import { currentWarmFixture } from '../library/warm-fixture.js';
const { input, current } = await currentWarmFixture(new URL('./fixtures/warm-item-deletion/', import.meta.url), 'http-warm-item-deletion');
export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000 };

test('current Native warm DELETE records every single/batch MVC and persistence scenario', enabled, async () => {
  const native = await current();
  assert.equal(native.actualPersistenceOnlySecondDeleteHttp, true);
  assert.equal(input.length, 16);
  assert.deepEqual(native.results.map(row => row.name), input.map(row => row.name));
  assert.equal(native.results.filter(row => row.status === 204).length, 6);
  assert.equal(native.results.filter(row => row.status === 404).length, 10);
});
for (const sample of input) test('postgres: HTTP after persistence-only deletion matches current Native ' + sample.name, {
  ...enabled, skip: enabled.skip || !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const native = normalizeDeletionRecording(await current());
  const expected = native.results.find(result => result.name === sample.name);
  const value = await setupPlaylistDeletion(t, sample, expected);
  await value.operation();
  const first = await value.project(null);
  assert.deepEqual(first.rows, value.normalizeRows(expected.firstRows));
  assert.deepEqual(first.links, expected.firstLinks);
  assert.deepEqual(first.files, expected.firstFiles); assert.deepEqual(first.calls, expected.firstCalls);
  assert.equal(await value.creator.getItemById(id(4)) !== null, expected.lookupAfterFirst);
  value.calls.length = 0; value.events.length = 0;
  const lookup = value.fixture.library.getDeletionItem.bind(value.fixture.library);
  value.fixture.library.getDeletionItem = async (reference, context) => {
    value.calls.push({ action: 'request-lookup', id: guid(reference), userId: context.user?.Id ?? null }); return lookup(reference, context);
  };
  const remove = value.fixture.library.deleteItem.bind(value.fixture.library);
  value.fixture.library.deleteItem = async (item, options, parent, notifyParent = true) => {
    value.calls.push({ action: 'request-delete', id: guid(item.Id), DeleteFileLocation: options.DeleteFileLocation,
      DeleteFromExternalProvider: options.DeleteFromExternalProvider, notifyParent });
    return remove(item, options, parent, notifyParent);
  };
  const application = await createApplication({ library: value.fixture.library, users: { getUser: async () => null },
    configuration: { IsStartupWizardCompleted: true }, authentication: {
      authenticate: async () => ({ IsAuthenticated: true, IsApiKey: true, IsAdministrator: true }), authorize: () => {} } });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => application.server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + application.server.address().port + expected.requestPath,
    { method: 'DELETE', headers: { Accept: 'application/json' } });
  const body = await response.text(); let jsonBody = null;
  try { jsonBody = JSON.parse(body); } catch {}
  assert.equal(response.status, expected.status); assert.equal(response.headers.get('content-type'), expected.contentType);
  const actualBody = normalizeDeletionRecording({ results: [{ body, jsonBody }] }).results[0];
  assert.deepEqual(actualBody, { body: expected.body, jsonBody: expected.jsonBody });
  const final = await value.project(null);
  assert.deepEqual(final.rows, value.normalizeRows(expected.rows)); assert.deepEqual(final.files, expected.files);
  assert.deepEqual(final.links, expected.links); assert.deepEqual(final.calls, expected.calls);
  assert.equal(final.closureLookup, expected.closureLookup);
  assert.equal(final.targetParentId, expected.targetParentId); assert.equal(final.targetLookup, expected.targetLookup);
});
