import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createTestRuntime } from '../helpers/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { idKey } from '../../src/library/records.js';
import { readTestLinkIds, captureTestEvent } from '../library/collection-test-consumers.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';

const enabled = { skip: !postgresTestConnectionString };
const movieIds = ['cb100000-0000-0000-0000-000000000001', 'cb100000-0000-0000-0000-000000000002'];
const missingId = 'cb100000-0000-0000-0000-000000000099';

async function setup(t, { baseUrl = '' } = {}) {
  const output = validationOutputRoot(); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'collections-http-'));
  const programDataPath = path.join(root, 'program'), dataPath = path.join(programDataPath, 'data'), metadataPath = path.join(programDataPath, 'metadata'), configurationDirectoryPath = path.join(root, 'config');
  let database, runtime;
  t.after(async () => {
    const failures = [];
    for (const cleanup of [() => runtime?.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('collections-http-'));
      await fs.rm(root, { recursive: true, force: true });
    }]) try { await cleanup(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Collection HTTP cleanup failed.');
  });
  await fs.mkdir(configurationDirectoryPath, { recursive: true });
  await fs.writeFile(path.join(configurationDirectoryPath, 'system.xml'), '<ServerConfiguration><ContentTypes/></ServerConfiguration>');
  database = await createPostgresTestDatabase(null, 'collections_http');
  for (const [index, Id] of movieIds.entries()) await database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: `Movie ${index + 1}`, SortName: `movie ${index + 1}`,
    Path: `Z:\\CollectionHttp\\Movie${index + 1}.mkv`, MediaType: 'Video', IsMovie: true, Data: '{}', OfficialRating: index ? 'R' : 'PG',
    DateCreated: '2026-10-13 00:00:00.0000000', DateModified: '2026-10-13 00:00:00.0000000',
  }));
  const configuration = { UICulture: 'en-US', IsStartupWizardCompleted: true, EnableCaseSensitiveItemIds: true };
  const errors = [], events = [], queued = [], added = [], pendingEvents = [];
  const create = async () => {
    runtime = await createTestRuntime({ database, configuration, networkConfiguration: { BaseUrl: baseUrl }, programDataPath, dataPath, metadataPath, configurationDirectoryPath,
      serverId: 'collections-http', onError: error => errors.push(error) });
    runtime.libraryConfiguration.sleep = async () => {};
    // Queue execution is covered by its own host tests; record the admission
    // after real Collection manager, XML and repository completion here.
    runtime.metadata.queue = async (id, options, priority) => { queued.push({ id: idKey(id), options, priority }); };
    runtime.library.on('ItemAdded', value => { if (value.Item.Type === 'BoxSet') added.push(idKey(value.Item.Id)); });
    for (const event of ['CollectionCreated', 'ItemsAddedToCollection', 'ItemsRemovedFromCollection']) runtime.collections.on(event,
      value => {
        const entry = { event, id: idKey(value.Collection.Id), ids: undefined }; events.push(entry);
        if (value.Items) pendingEvents.push(captureTestEvent(value.Items).then(ids => { entry.ids = ids; }));
      });
    return `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}${baseUrl}`;
  };
  let origin = await create();
  const apiKey = await runtime.apiKeys.create('Collection HTTP fixture');
  const headers = { Authorization: `MediaBrowser Token="${apiKey.AccessToken}"` };
  const request = async (suffix, { method = 'POST', authHeaders = headers, ...options } = {}) => {
    const response = await fetch(origin + suffix, { method, headers: authHeaders, ...options });
    const text = await response.text(); let body = null; try { body = JSON.parse(text); } catch { }
    await Promise.all(pendingEvents);
    return { status: response.status, body, text };
  };
  const links = async value => (await database.rows('LinkedChildren', { where: { ParentId: value }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] })).map(row => idKey(row.ChildId));
  return { root, programDataPath, dataPath, events, queued, errors, added, request, links, headers,
    get database() { return database; }, get runtime() { return runtime; },
    async reopen() {
      const schema = database.schemaName; await runtime.close();
      database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); origin = await create();
    } };
}

test('postgres: Collection HTTP create/add/remove persists actual rows, XML, events and survives restart under BaseUrl', enabled, async t => {
  const state = await setup(t, { baseUrl: '/media' });
  const created = await state.request('/Collections?name=HTTP%20Collection&isLocked=true&parentId=' + missingId);
  assert.equal(created.status, 200); const collectionId = created.body.Id;
  assert.match(collectionId, /^[0-9a-f]{32}$/);
  const collection = await state.runtime.itemCreation.getItemById(collectionId);
  assert.equal(collection.Name, 'HTTP Collection'); assert.equal(collection.IsLocked, true);
  assert.notEqual(idKey(collection.ParentId), idKey(missingId), 'The native manager ignores ParentId.');
  const add = await state.request(`/Collections/${collectionId}/Items?ids=${movieIds[0]},bad,${movieIds[0]},${movieIds[1]}`);
  assert.equal(add.status, 204); assert.equal(add.text, '');
  assert.deepEqual(await state.links(collection.Id), movieIds.map(idKey));
  assert.deepEqual(await readTestLinkIds(collection), [movieIds[0], movieIds[0], movieIds[1]].map(idKey));
  assert.equal(collection.OfficialRating, 'PG');
  const filename = path.join(collection.Path, 'collection.xml');
  assert.match(await fs.readFile(filename, 'utf8'), /Movie1\.mkv/);
  assert.equal((await state.request(`/Collections/${collectionId}/Items?ids=${movieIds[0]}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(await state.links(collection.Id), movieIds.map(idKey), 'Only the first matching live linked child is removed.');
  assert.deepEqual(state.events.map(value => value.event), ['CollectionCreated', 'ItemsAddedToCollection', 'ItemsRemovedFromCollection']);
  assert.deepEqual(state.events[1].ids, [movieIds[0], movieIds[0], movieIds[1]].map(idKey));
  assert.equal(state.queued.length, 3); assert.equal(state.queued[1].options.ForceSave, true);
  const xml = await fs.readFile(filename, 'utf8');
  await state.reopen();
  const cold = await state.runtime.itemCreation.getItemById(collectionId);
  assert.deepEqual(await readTestLinkIds(cold), movieIds.map(idKey));
  assert.equal(await fs.readFile(filename, 'utf8'), xml);
  assert.equal((await state.request(`/Collections/${collectionId}/Items`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(await state.links(cold.Id), movieIds.map(idKey));
});

test('postgres: Collection HTTP uses real user/device and API-key permissions before model binding and mutation', enabled, async t => {
  const state = await setup(t);
  const tokens = {};
  for (const [name, policy] of [['ordinary', {}], ['manager', { EnableCollectionManagement: true }], ['admin', { IsAdministrator: true }]]) {
    const dto = await state.runtime.users.createUser({ Name: name, Password: 'Isolated password' });
    const user = await state.runtime.users.getUser(dto.Id);
    await state.runtime.users.updatePolicy(dto.Id, { ...user.Policy, ...policy });
    const login = await state.runtime.authentication.login({ Username: name, Pw: 'Isolated password' },
      { Client: 'Collection HTTP', Device: 'Isolated', DeviceId: 'collection-' + name, Version: '1' }, { remoteEndPoint: '127.0.0.1' });
    tokens[name] = { Authorization: `MediaBrowser Token="${login.AccessToken}"` };
  }
  assert.equal((await state.request('/Collections?parentId=bad', { authHeaders: {} })).status, 401);
  assert.equal((await state.request('/Collections?parentId=bad', { authHeaders: tokens.ordinary })).status, 403);
  assert.equal(state.events.length, 0);
  for (const name of ['manager', 'admin']) assert.equal((await state.request('/Collections?name=' + name, { authHeaders: tokens[name] })).status, 200);
  assert.equal((await state.request('/Collections?name=ApiKey')).status, 200);
  assert.equal(state.events.length, 3);
  for (const name of ['manager', 'admin']) assert.equal((await state.request('/Collections?parentId=bad', { authHeaders: tokens[name] })).status, 400);
});

test('postgres: Collection creation retains the persisted prefix when initial members fail after string-array binding', enabled, async t => {
  const state = await setup(t);
  for (const [name, ids, status] of [['MissingMember', movieIds[0] + ',' + missingId, 400], ['MalformedMember', movieIds[0] + ',bad', 500]]) {
    const response = await state.request(`/Collections?name=${name}&ids=${ids}`);
    assert.equal(response.status, status); assert.equal(response.text, 'Error processing request.');
    const [row] = await state.database.rows('BaseItems', { where: { Name: name } }); assert.ok(row);
    assert.equal(state.added.includes(idKey(row.Id)), true);
    assert.deepEqual(await state.links(row.Id), []);
    assert.equal((await fs.stat(path.join(state.dataPath, 'collections', name + ' [boxset]'))).isDirectory(), true);
    assert.equal(state.events.length, 0); assert.equal(state.queued.length, 0);
  }
  assert.equal((await state.request('/Collections?name=%20')).status, 500);
  assert.equal((await state.database.rows('BaseItems', { where: { Type: 'MediaBrowser.Controller.Entities.Movies.BoxSet' } })).length, 2);
});

test('postgres: Collection HTTP missing, wrong-type and empty IDs return native errors without member commits', enabled, async t => {
  const state = await setup(t), created = await state.request('/Collections?name=Errors');
  const collectionId = created.body.Id;
  for (const reference of [missingId, movieIds[0], '00000000000000000000000000000000']) {
    for (const method of ['POST', 'DELETE']) assert.equal((await state.request(`/Collections/${reference}/Items?ids=${movieIds[0]}`, { method })).status, 400);
  }
  assert.equal((await state.request(`/Collections/${collectionId}/Items?ids=${movieIds[0]},${missingId}`)).status, 400);
  assert.deepEqual(await state.links(collectionId), []);
  assert.equal(state.events.length, 1); assert.equal(state.queued.length, 1);
  assert.equal((await state.request(`/Collections/${collectionId}/Items?ids=bad`)).status, 204);
  assert.equal(state.events.length, 1); assert.equal(state.queued.length, 1);
  assert.equal((await state.request(`/Collections/${collectionId}/Items?ids=${missingId}`, { method: 'DELETE' })).status, 204);
  assert.equal(state.events.length, 2); assert.equal(state.queued.length, 2);
  assert.deepEqual(state.events[1].ids, []);
});
