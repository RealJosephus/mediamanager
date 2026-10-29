import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTestApplication } from '../helpers/application.js';
import { canDeleteItem } from '../../src/library/delete-permission.js';
import { visibleItem } from '../../src/library/permissions.js';
import { parentChainForItem } from '../../src/library/collection-membership.js';
import { idKey, nonemptyId } from '../../src/library/records.js';
import { normalizeDeletionRecording } from './deletion-response-projection.js';
import { assertProjectedEqual, publicJsonBody } from '../comparison-observations.js';
import { input, recordCurrentItemDeletionOnce } from './item-deletion-fixture.js';
import { fixtureId, entities, userFor, permissionOptions, stateFor, visibilityOptions } from './item-deletion-state.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const currentOptions = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 240000 };

test('Item DELETE records the current designated Native HTTP and permission observation', currentOptions, async () => {
  const { inputBytes, input: currentInput, native } = await recordCurrentItemDeletionOnce();
  assert.equal(native.inputSha256, createHash('sha256').update(inputBytes).digest('hex'));
  assert.deepEqual(currentInput, input);
  assert.equal(native.results.length, input.cases.length);
  assert.deepEqual(native.results.map(row => row.name), input.cases.map(row => row.name));
  assert.deepEqual(native.permissionMatrix.map(row => row.policy), input.permissionPolicies);
  const expectedIds = entities().map(item => idKey(item.Id)).sort();
  for (const matrix of native.permissionMatrix) {
    assert.deepEqual(matrix.items.map(item => item.id).sort(), expectedIds);
  }
});

for (const policy of input.permissionPolicies) {
  test('typed deletion permission matches current Native with and without user: ' + policy, currentOptions, async () => {
    const { native } = await recordCurrentItemDeletionOnce();
    const matrix = native.permissionMatrix.find(row => row.policy === policy);
    assert.ok(matrix, policy);
    const items = entities(), state = stateFor(items), user = userFor({ policy });
    for (const expected of matrix.items) {
      const item = state.byId.get(expected.id);
      assert.ok(item);
      assert.equal(await canDeleteItem(item, null, permissionOptions(item, state)), expected.noUser, item.Name + ' no user');
      assert.equal(await canDeleteItem(item, user, permissionOptions(item, state)), expected.user, item.Name + ' user');
    }
  });
}
for (const sample of input.cases) {
  test('Item DELETE actual controller/binding differential: ' + sample.name, currentOptions, async t => {
    const { native } = await recordCurrentItemDeletionOnce();
    const expected = native.results.find(row => row.name === sample.name);
    assert.ok(expected, sample.name);
    const items = new Map(entities().map(item => [idKey(item.Id), item]));
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
    const application = await createTestApplication({
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
    const actual = { name: sample.name, requestPath: expected.requestPath,
      status: response.status, contentType: response.headers.get('content-type'), body, jsonBody,
      calls, committed, remaining: [...items.keys()].sort() };
    const { errors, ...projection } = expected;
    assertProjectedEqual(t, sample.name + ' public deletion response', actual, projection,
      response => publicJsonBody(normalizeDeletionRecording({ results: [response] }).results[0]));
  });
}
