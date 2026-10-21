import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../../src/http/application.js';
import { canDeleteItem } from '../../src/library/delete-permission.js';
import { visibleItem } from '../../src/library/permissions.js';
import { parentChainForItem } from '../../src/library/collection-membership.js';
import { idKey, nonemptyId } from '../../src/library/records.js';
import { normalizeDeletionRecording } from './fixtures/item-deletion/normalize.js';
import { assertProjectedEqual, publicJsonBody } from '../comparison-observations.js';
import { root, input, native, provenance, fixtureId, entities, userFor, permissionOptions, stateFor, visibilityOptions } from './item-deletion-fixture.js';

test('Item DELETE native recording seals request inputs, driver and two independent captures', async () => {
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const file of Object.values(provenance.files)) assert.equal(sha(await readFile(path.resolve(fileURLToPath(root), file.filename))), file.sha256, file.filename);
  assert.equal(provenance.candidateVerified, false);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  const first = JSON.parse(await readFile(provenance.files.rawRecording.filename, 'utf8'));
  const repeat = JSON.parse(await readFile(provenance.repeat.filename, 'utf8'));
  assert.deepEqual(normalizeDeletionRecording(first), native);
  assert.deepEqual(normalizeDeletionRecording(repeat), native);
  assert.equal(sha(await readFile(provenance.repeat.filename)), provenance.repeat.rawSha256);
  assert.equal(native.results.length, input.cases.length);
  assert.deepEqual(native.results.map(row => row.name), input.cases.map(row => row.name));
  for (const assembly of provenance.assemblies)
    assert.equal(sha(await readFile(path.join(provenance.jellyfin.assemblyDirectory, assembly.name + '.dll'))), assembly.sha256, assembly.name);
});
for (const matrix of native.permissionMatrix) {
  test('typed deletion permission matches native with and without user: ' + matrix.policy, async () => {
    const items = entities(), state = stateFor(items), user = userFor({ policy: matrix.policy });
    for (const expected of matrix.items) {
      const item = state.byId.get(expected.id);
      assert.ok(item);
      assert.equal(await canDeleteItem(item, null, permissionOptions(item, state)), expected.noUser, item.Name + ' no user');
      assert.equal(await canDeleteItem(item, user, permissionOptions(item, state)), expected.user, item.Name + ' user');
    }
  });
}
for (const sample of input.cases) {
  test('Item DELETE actual controller/binding differential: ' + sample.name, async t => {
    const expected = native.results.find(row => row.name === sample.name), items = new Map(entities().map(item => [idKey(item.Id), item]));
    const calls = [], committed = [], user = userFor(sample);
    const userId = sample.claim === 'empty' ? fixtureId(0) : sample.claim === 'absent' ? undefined
      : sample.claim === 'missing' ? fixtureId(92) : user.Id;
    const getState = () => {
      const state = stateFor([...items.values()]);
      state.ancestors = item => parentChainForItem(item, state);
      return state;
    };
    const commit = item => {
      calls.push({ phase: 'delete', id: idKey(item.Id), DeleteFileLocation: true, DeleteFromExternalProvider: true, notifyParent: true });
      if (sample.fail === item.Name) throw new Error('Controlled precommit failure.');
      items.delete(idKey(item.Id)); committed.push(idKey(item.Id));
      if (sample.failAfter === item.Name) throw new Error('Controlled postcommit failure.');
    };
    const application = await createApplication({
      configuration: { IsStartupWizardCompleted: true },
      authentication: {
        authenticate: async () => ({ IsAuthenticated: sample.authenticated !== false, IsApiKey: sample.apiKey === true, UserId: userId, User: user }),
        authorize: auth => { if (!auth.IsAuthenticated) throw Object.assign(new Error('Unauthorized'), { status: 401 }); },
      },
      users: { getUser: async reference => { calls.push({ phase: 'user', id: idKey(reference) }); return idKey(reference) === idKey(user.Id) ? user : null; } },
      library: {
        getDeletionItem: async (reference, { user }) => {
          calls.push({ phase: 'item', id: idKey(reference), userId: user ? idKey(user.Id) : null });
          if (!nonemptyId(reference)) throw Object.assign(new Error('Empty GUID'), { status: 400 });
          const item = items.get(idKey(reference)), state = getState();
          if (!item || user && item.Type !== 'UserRootFolder' && !visibleItem(item, user, state, visibilityOptions)) return null;
          return { item, canDelete: !user || await canDeleteItem(item, user, permissionOptions(item, state)) };
        },
        deleteItem: async (item, options, parent, notify) => {
          assert.deepEqual(options, { DeleteFileLocation: true, DeleteFromExternalProvider: true });
          assert.equal(parent, undefined); assert.equal(notify, true); commit(item);
        },
      },
      playlists: { delete: async (reference, { user, isApiKey }) => {
        assert.equal(isApiKey, user === null); commit(items.get(idKey(reference)));
      } },
    });
    await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => application.server.close(resolve)));
    const response = await fetch('http://127.0.0.1:' + application.server.address().port + expected.requestPath, {
      method: 'DELETE', headers: { Accept: sample.accept ?? 'application/json' },
    });
    const body = await response.text(); let jsonBody = null;
    try { jsonBody = JSON.parse(body); } catch { /* The real native middleware uses text for exceptions. */ }
    const actual = normalizeDeletionRecording({ results: [{ name: sample.name, requestPath: expected.requestPath,
      status: response.status, contentType: response.headers.get('content-type'), body, jsonBody,
      calls, committed, remaining: [...items.keys()].sort() }] }).results[0];
    const { errors, ...projection } = expected;
    assertProjectedEqual(t, sample.name + ' public deletion response', actual, projection, publicJsonBody);
  });
}
