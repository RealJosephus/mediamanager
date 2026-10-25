import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApplication } from '../helpers/application.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { serializeNativeItemData } from '../../src/library/native-item-data.js';
import { idKey, nonemptyId } from '../../src/library/records.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { postgresTestRow } from '../database/postgres-fixture.js';
import { setupChildrenFixture } from '../metadata/children-fixture.js';
import { normalizeDeletionRecording } from './fixtures/item-deletion/normalize.js';
import { assertProjectedEqual, publicJsonBody } from '../comparison-observations.js';
import { input, recordCurrentItemDeletionOnce } from './item-deletion-fixture.js';
import { fixtureId, entities, userFor } from './item-deletion-state.js';

export const requiredValidationServices = ['postgres', 'dotnet', 'jellyfinDll'];
test('postgres: Item DELETE controller matrix uses production bounded lookup and permission with controlled SQL deletion', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000,
}, async t => {
  const { native } = await recordCurrentItemDeletionOnce();
  const fixture = await setupChildrenFixture(t);
  fixture.library.options.userRoot = { Id: fixtureId(1) };
  const creator = new ItemCreationService(fixture); fixture.library.itemCreation = creator;
  t.after(() => creator.close());
  fixture.library.options.isActiveRecording = item => item.Path === 'Z:\\SyntheticMedia\\active.mkv';
  let sample, calls, committed, user, userId;
  const originalLookup = fixture.library.getDeletionItem.bind(fixture.library);
  fixture.library.getDeletionItem = async (reference, options) => {
    calls.push({ phase: 'item', id: idKey(reference), userId: options.user ? idKey(options.user.Id) : null });
    return originalLookup(reference, options);
  };
  const commit = async item => {
    calls.push({ phase: 'delete', id: idKey(item.Id), DeleteFileLocation: true, DeleteFromExternalProvider: true, notifyParent: true });
    if (sample.fail === item.Name) throw new Error('Controlled precommit failure.');
    await fixture.store.transaction(db => db.delete('BaseItems', { Id: item.Id }));
    creator.unregisterItem(item.Id); committed.push(idKey(item.Id));
    if (sample.failAfter === item.Name) throw new Error('Controlled postcommit failure.');
  };
  fixture.library.itemDeletion = { deleteItem: async (item, options, parent, notify) => {
    assert.deepEqual(options, { DeleteFileLocation: true, DeleteFromExternalProvider: true });
    assert.equal(parent, undefined); assert.equal(notify, true); await commit(item);
  } };
  const application = await createTestApplication({
    configuration: { IsStartupWizardCompleted: true }, library: fixture.library,
    authentication: {
      authenticate: async () => ({ IsAuthenticated: sample.authenticated !== false, IsApiKey: sample.apiKey === true, UserId: userId, User: user }),
      authorize: auth => { if (!auth.IsAuthenticated) throw Object.assign(new Error('Unauthorized'), { status: 401 }); },
    },
    users: { getUser: async reference => { calls.push({ phase: 'user', id: idKey(reference) }); return idKey(reference) === idKey(user.Id) ? user : null; } },
    playlists: { delete: async (reference, { user, isApiKey }) => {
      assert.equal(isApiKey, user === null); await commit(await creator.getItemById(reference));
    } },
  });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => application.server.close(resolve)));
  for (const scenario of input.cases) await t.test(scenario.name, async () => {
    sample = scenario; calls = []; committed = []; user = userFor(sample);
    userId = sample.claim === 'empty' ? fixtureId(0) : sample.claim === 'absent' ? undefined
      : sample.claim === 'missing' ? fixtureId(92) : user.Id;
    await creator.close();
    // Only the one newly-created fixture schema is reset between neutral
    // initial frames. This is not a cleanup of any retained historical schema.
    await fixture.database.client.query('TRUNCATE ' + q(fixture.database.schemaName) + '."BaseItems" CASCADE');
    await fixture.store.transaction(async db => {
      for (const item of entities()) {
        if (item.Path?.startsWith('C:\\FixtureState')) item.Path = item.Path.replace('C:\\FixtureState', fixture.stateRoot);
        const row = postgresTestRow('BaseItems', { Id: item.Id, Type: item.NativeType, Name: item.Name, Path: item.Path,
          ParentId: nonemptyId(item.ParentId) ? item.ParentId : null, IsFolder: item.IsFolder,
          Data: serializeNativeItemData(item) });
        await db.insert('BaseItems', row);
      }
    });
    const expected = native.results.find(row => row.name === sample.name);
    assert.ok(expected, sample.name);
    const response = await fetch('http://127.0.0.1:' + application.server.address().port + expected.requestPath, {
      method: 'DELETE', headers: { Accept: sample.accept ?? 'application/json' },
    });
    const body = await response.text(); let jsonBody = null;
    try { jsonBody = JSON.parse(body); } catch { /* Native production exception middleware emits plain text. */ }
    const remaining = (await fixture.database.rows('BaseItems', { columns: ['Id'] })).map(row => idKey(row.Id)).sort();
    const actual = normalizeDeletionRecording({ results: [{ name: sample.name, requestPath: expected.requestPath,
      status: response.status, contentType: response.headers.get('content-type'), body, jsonBody,
      calls, committed, remaining }] }).results[0];
    const { errors, ...projection } = expected;
    assertProjectedEqual(t, sample.name + ' public deletion response', actual, projection, publicJsonBody);
    assert.equal(fixture.database.inTransaction, false);
  });
});
