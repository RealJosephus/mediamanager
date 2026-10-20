import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createRuntime } from '../../src/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeGuid, wireGuid } from '../../src/users/native.js';
import { searchHistoryClient, searchHistoryKey } from '../../src/sessions/search-history.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';

const bytes = await readFile(new URL('./fixtures/emby-search-history/reference.json', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), 'c0be200ceac8b5d0ed85d22a2d31af8e777cfeb50533c31ed28613e988b62d5a');
const reference = JSON.parse(bytes), native = label => reference.records.find(record => record.label === label);
const mediaNames = ['Controlled audio A', 'Controlled audio B', 'Controlled audio C'];
const item = (Id, type, Name, extra = {}) => postgresTestRow('BaseItems', {
  Id, Type: `MediaBrowser.Controller.Entities.${type === 'Audio' ? 'Audio.Audio' : type}`,
  Name, SortName: Name.toLowerCase(), CleanName: Name.toLowerCase(), PresentationUniqueKey: Id,
  IsFolder: type !== 'Audio', MediaType: type === 'Audio' ? 'Audio' : 'Unknown', Data: '{}', ...extra,
});

test('Emby search history uses the current user and SQL filters, survives copying and restart, and leaves playback state intact', {
  skip: !postgresTestConnectionString, timeout: 90000,
}, async t => {
  for (const source of reference.sources) for (const key of ['referenceUnchanged', 'runtimeUnchanged', 'processesStopped', 'instanceRemoved']) assert.equal(source[key], true);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mediamanager-search-history-')));
  const options = { serverId: randomUUID().replaceAll('-', ''), configuration: { BaseUrl: '/media', IsStartupWizardCompleted: true },
    programDataPath: path.join(root, 'program'), configurationDirectoryPath: path.join(root, 'config') };
  const ids = Object.fromEntries(['root', 'collection', 'folder', 'a', 'b', 'c', 'targetOnly'].map(name => [name, nativeGuid(randomUUID())]));
  const namesById = new Map(['a', 'b', 'c'].map((key, index) => [wireGuid(ids[key]), mediaNames[index]]));
  let database, runtime, socket;
  const open = async () => {
    runtime = await createRuntime({ database, ...options });
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  };
  const closeSocket = async () => {
    if (socket && socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, 'close'); socket.terminate(); await closed; }
  };
  t.after(async () => {
    const failures = [];
    for (const operation of [closeSocket, () => runtime?.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(root), await realpath(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('mediamanager-search-history-'));
      await rm(root, { recursive: true, force: true });
    }]) try { await operation(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Search history cleanup failed.');
  });
  database = await createPostgresTestDatabase(null, 'emby_search');
  await open();
  const sourcePassword = randomUUID();
  const source = await runtime.users.createUser({ Name: 'Controlled reader', Password: sourcePassword });
  const target = await runtime.users.createUser({ Name: 'Controlled target', Password: randomUUID() });
  const sourceId = nativeGuid(source.Id), targetId = nativeGuid(target.Id);
  const adminToken = (await runtime.apiKeys.create('Controlled history')).AccessToken;
  const sourceToken = (await runtime.authentication.login({ Username: source.Name, Pw: sourcePassword }, {
    Client: 'Emby Web', Device: 'Controlled browser', DeviceId: 'history-reader', Version: '1.0',
  })).AccessToken;
  const request = async (route, { method = 'GET', body, token = sourceToken, jellyfin = false } = {}) => {
    const url = new URL(`http://127.0.0.1:${runtime.server.address().port}/media/emby${route}`);
    if (body !== undefined) url.searchParams.set('reqformat', 'json');
    const response = await fetch(url, {
      method, headers: { Accept: 'application/json', 'Content-Type': 'text/plain',
        Authorization: `${jellyfin ? 'MediaBrowser Client="Jellyfin Web"' : 'Emby Client="Emby Web"'}, Token="${token ?? ''}"` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text(), type = response.headers.get('content-type');
    return { status: response.status, type, text, body: type?.includes('json') && text ? JSON.parse(text) : undefined };
  };
  const query = (userId = source.Id, suffix = '&WasSearched=true&SortBy=DateLastSearched&SortOrder=Descending', token = sourceToken) =>
    request(`/Users/${userId}/Items?Recursive=true&IncludeItemTypes=Audio${suffix}`, { token });
  const compare = (actual, label) => {
    const expected = native(label);
    assert.equal(actual.status, expected.status, label);
    assert.equal(actual.body.TotalRecordCount, expected.bodyJson.TotalRecordCount, label);
    assert.deepEqual(Object.keys(actual.body).sort(), Object.keys(expected.bodyJson).sort(), label);
    assert.deepEqual(actual.body.Items.map(value => ({ Id: value.Id, Name: value.Name })),
      expected.bodyJson.Items.map(value => ({ Id: [...namesById].find(([, name]) => name === value.Name)?.[0], Name: value.Name })), label);
  };
  const mark = (Ids, WasSearched = true, { userId = source.Id, token = sourceToken } = {}) =>
    request(`/Users/${userId}/SearchedItems`, { method: 'POST', body: { Ids, WasSearched }, token });
  const clear = (userId = source.Id, token = sourceToken) => request(`/Users/${userId}/RecentlySearched/Delete`, { method: 'POST', token });
  const historyRows = userId => database.rows('CustomItemDisplayPreferences', {
    where: { UserId: nativeGuid(userId), Client: searchHistoryClient, Key: searchHistoryKey }, orderBy: [{ column: 'Id', direction: 'ASC' }],
  });

  await database.insertBatch('BaseItems', [item(ids.root, 'UserRootFolder', 'Media Folders'),
    item(ids.collection, 'CollectionFolder', 'Audio', { ParentId: ids.root, Path: path.join(options.programDataPath, 'root', 'default', 'Audio'),
      Data: JSON.stringify({ CollectionType: 'music', PhysicalFolderIds: [ids.folder] }) }),
    item(ids.folder, 'Folder', 'Audio files', { TopParentId: ids.folder }),
    ...['a', 'b', 'c'].map((key, index) => item(ids[key], 'Audio', mediaNames[index], {
      ParentId: ids.folder, TopParentId: ids.folder, Path: `Z:\\Controlled\\${mediaNames[index]}.wav`, RunTimeTicks: 10000000n,
    })), item(ids.targetOnly, 'Folder', 'Target only history', { ParentId: ids.folder, TopParentId: ids.folder })]);
  await database.insertBatch('AncestorIds', ['a', 'b', 'c'].map(key => postgresTestRow('AncestorIds', { ItemId: ids[key], ParentItemId: ids.folder })));
  const policy = (await runtime.users.getUser(source.Id)).Policy;
  await runtime.users.updatePolicy(source.Id, { ...policy, EnableAllFolders: false, EnabledFolders: [ids.collection] });
  await runtime.userData.update(source.Id, ids.a, { IsFavorite: true, Played: true, PlayCount: 1, LastPlayedDate: '2026-10-20T17:44:37.0000000Z' });
  const playback = await runtime.userData.get(source.Id, ids.a);
  const messages = [];
  socket = new WebSocket(`ws://127.0.0.1:${runtime.server.address().port}/media/emby?api_key=${sourceToken}&deviceId=history-reader`);
  socket.on('message', data => messages.push(JSON.parse(String(data))));
  await once(socket, 'open');
  const waitFor = async predicate => {
    const deadline = Date.now() + 10000;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'The actual client must receive the history user-data change.'); await delay(20); }
  };
  await waitFor(() => messages.some(message => message.MessageType === 'ForceKeepAlive'));
  assert.equal((await clear()).status, native('clear-source-initial').status);
  compare(await query(), 'initial-history');
  assert.equal((await mark([ids.a])).status, native('mark-first').status);
  compare(await query(), 'after-first');
  await delay(1200);
  assert.equal((await mark([ids.b])).status, native('mark-second').status);
  compare(await query(), 'after-second');
  compare(await query(source.Id, '&WasSearched=false&SortBy=SortName'), 'history-negative-filter');
  compare(await query(source.Id, '&WasSearched=true'), 'history-default-order');
  const unknownBoolean = await query(source.Id, '&WasSearched=invalid');
  assert.equal(unknownBoolean.status, native('history-unknown-bool').status);
  assert.equal(unknownBoolean.text, native('history-unknown-bool').bodyText);
  assert.match(unknownBoolean.type, /^text\/plain/u);
  assert.deepEqual(await runtime.userData.get(source.Id, ids.a), playback);
  await waitFor(() => messages.some(message => message.MessageType === 'UserDataChanged'
    && message.Data.UserId === source.Id && message.Data.UserDataList.some(value => value.ItemId === wireGuid(ids.b))));

  await delay(1200);
  assert.equal((await mark([ids.a], false)).status, native('mark-false').status);
  compare(await query(), 'after-false');
  await delay(1200);
  assert.equal((await mark([ids.b], 'invalid')).status, native('mark-invalid-flag').status);
  compare(await query(), 'after-invalid-flag');
  for (const [values, label] of [[[], 'mark-empty-list'], [null, 'mark-null-list'], [[randomUUID()], 'mark-missing-id'], [['invalid'], 'mark-invalid-id']]) {
    const result = await mark(values), expected = native(label);
    assert.equal(result.status, expected.status, label);
    assert.equal(result.text, expected.bodyText, label);
  }
  await delay(1200);
  assert.equal((await mark([ids.c, randomUUID()])).status, native('mark-mixed-ids').status);
  compare(await query(), 'after-mixed-ids');
  assert.equal((await mark([ids.c], true, { userId: target.Id })).status, native('mark-other-user').status);
  compare(await query(target.Id, undefined, adminToken), 'other-history-after-cross-write');
  compare(await query(target.Id), 'other-history-as-reader');
  assert.equal((await mark([ids.a], true, { token: null })).status, native('anonymous-mark').status);
  assert.equal((await clear(source.Id, null)).status, native('anonymous-clear').status);
  const crossClear = await clear(target.Id);
  assert.equal(crossClear.status, native('clear-other-as-reader').status);
  assert.equal(crossClear.text, native('clear-other-as-reader').bodyText);
  // The explicitly declared Jellyfin client retains its own scope and binding.
  const jellyfinCross = await request(`/Users/${target.Id}/Items?Recursive=true`, { jellyfin: true });
  assert.equal(jellyfinCross.status, 403);
  const jellyfin = await request(`/Users/${source.Id}/Items?Recursive=true&IncludeItemTypes=Audio&WasSearched=invalid`, { jellyfin: true });
  assert.equal(jellyfin.status, 200); assert.ok(Object.hasOwn(jellyfin.body, 'StartIndex'));

  const original = await historyRows(source.Id);
  assert.equal(original.length, 3);
  for (const row of original) assert.match(row.Value, /^\d{10}$/u);
  await database.insertBatch('CustomItemDisplayPreferences', [
    { UserId: targetId, ItemId: ids.a, Client: searchHistoryClient, Key: searchHistoryKey, Value: '1' },
    { UserId: targetId, ItemId: ids.targetOnly, Client: searchHistoryClient, Key: searchHistoryKey, Value: '2' },
    { UserId: sourceId, ItemId: ids.a, Client: 'another-client', Key: searchHistoryKey, Value: 'untouched' },
  ]);
  const queries = [], originalQuery = database.client.query.bind(database.client);
  database.client.query = async (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0].text, result = await originalQuery(...args);
    if (/"CustomItemDisplayPreferences"/u.test(sql)) queries.push({ sql, returned: result.rows.length, changed: result.rowCount });
    return result;
  };
  try {
    assert.equal((await request(`/Users/${source.Id}/CopyData`, { method: 'POST', token: adminToken,
      body: { ToUserIds: [target.Id], CopyOptions: ['userdata'] } })).status, native('copy-search-history').status);
  } finally { database.client.query = originalQuery; }
  assert.equal(queries.length, 1); assert.ok(queries[0].sql.startsWith('INSERT INTO ') && queries[0].sql.includes('SELECT '));
  assert.equal(queries[0].returned, 0); assert.equal(queries[0].changed, 3);
  const targetRows = await historyRows(target.Id);
  assert.equal(targetRows.length, 4);
  for (const row of original) assert.equal(targetRows.find(value => value.ItemId === row.ItemId).Value, row.Value);
  assert.equal(targetRows.find(value => value.ItemId === ids.targetOnly).Value, '2');
  assert.deepEqual(await historyRows(source.Id), original);
  // The explicit Audio query covers the three captured media; the target-only
  // folder row independently proves that copy does not delete other history.
  compare(await query(target.Id, undefined, adminToken), 'other-history-after-copy');
  await runtime.users.updatePolicy(source.Id, { ...(await runtime.users.getUser(source.Id)).Policy, EnableAllFolders: false, EnabledFolders: [] });
  compare(await query(), 'history-without-library-access');
  assert.equal((await mark([ids.b])).status, native('mark-without-library-access').status);
  await runtime.users.updatePolicy(source.Id, { ...(await runtime.users.getUser(source.Id)).Policy, EnableAllFolders: false, EnabledFolders: [ids.collection] });
  assert.equal((await query()).body.TotalRecordCount, 3);
  const beforeRestart = await query();
  await closeSocket();
  const schema = database.schemaName;
  await runtime.close(); runtime = null;
  database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema });
  await open();
  assert.deepEqual((await query()).body, beforeRestart.body);
  assert.equal((await clear()).status, native('clear-source').status);
  compare(await query(), 'history-after-clear');
  assert.deepEqual(await runtime.userData.get(source.Id, ids.a), playback);
  assert.equal((await historyRows(target.Id)).length, 4);
  assert.equal((await database.rows('CustomItemDisplayPreferences', { where: { UserId: sourceId, Client: 'another-client' } }))[0].Value, 'untouched');

  // A single submitted batch retains its ordering for ties; distinct seconds
  // separately test direction and paging without relying on a query-plan tie.
  assert.equal((await mark([ids.c, ids.b, ids.a])).status, 204);
  compare(await query(source.Id, '&WasSearched=true&SortBy=DateLastSearched&SortOrder=Descending'), 'tie-descending');
  compare(await query(source.Id, '&WasSearched=true&SortBy=DateLastSearched&SortOrder=Ascending'), 'tie-ascending');
  compare(await query(source.Id, '&WasSearched=true&SortBy=DateLastSearched&SortOrder=Descending&EnableTotalRecordCount=false&StartIndex=1&Limit=1'), 'tie-count-off');
  assert.equal((await clear()).status, 204);
  for (const id of [ids.a, ids.b, ids.c]) { assert.equal((await mark([id])).status, 204); await delay(1200); }
  const capturedSql = [], queryMethod = database.client.query.bind(database.client);
  database.client.query = async (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
    const result = await queryMethod(...args);
    if (/SELECT[\s\S]+FROM[\s\S]+"BaseItems" i/u.test(sql) && sql.includes('history.')) capturedSql.push({ sql, rows: result.rows.length });
    return result;
  };
  try {
    for (const direction of ['Ascending', 'Descending']) for (const count of [true, false]) for (const limited of [true, false]) {
      compare(await query(source.Id, `&WasSearched=true&SortBy=DateLastSearched&SortOrder=${direction}&EnableTotalRecordCount=${count}${limited ? '&Limit=2&StartIndex=1' : ''}`),
        `spaced-${direction}-count-${count}-limited-${limited}`);
    }
  } finally { database.client.query = queryMethod; }
  assert.ok(capturedSql.some(({ sql, rows }) => /LIMIT \$\d+ OFFSET \$\d+/u.test(sql) && rows === 2));
  assert.ok(capturedSql.some(({ sql }) => /count\(\*\)/iu.test(sql)));
  for (const { sql } of capturedSql) assert.ok(sql.includes('history."UserId"') && sql.includes('history."Client"') && sql.includes('history."Key"'));
});
