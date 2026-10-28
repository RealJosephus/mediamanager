import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { tableDefinition } from '../../src/database/model.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { getNewItemId } from '../../src/core/identity.js';
import { record } from '../sessions/control-scenario.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { projectSessionControlRecord } from '../sessions/control-projection.js';

function movie() {
  const defaults = Object.fromEntries(tableDefinition('BaseItems').columns.map(column => [column.name,
    column.clrType.replace('?', '') === 'DateTime' ? '2026-09-26 00:00:00' : column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
  return { ...defaults, Id: '22222222-2222-2222-2222-222222222222', Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Movie', CleanName: 'movie', SortName: 'movie', Data: '{}', MediaType: 'Video', Path: 'Z:\\Isolated\\movie.mkv', IsFolder: false };
}
async function setup(configuration = {}, { metadata = false } = {}) {
  const database = await createPostgresTestDatabase(null, 'session_control');
  let stateRoot, runtime, close, closePromise;
  const dispose = () => closePromise ??= (async () => {
    try { if (close) await close(); else await database.close(); }
    finally {
      try { await dropPostgresTestDatabase(database); }
      finally {
        if (stateRoot) {
          const resolved = path.resolve(stateRoot);
          assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
          assert.ok(path.basename(resolved).startsWith('mediamanager-session-mix-'));
          await rm(resolved, { recursive: true, force: true });
        }
      }
    }
  })();
  try {
  stateRoot = metadata ? await mkdtemp(path.join(tmpdir(), 'mediamanager-session-mix-')) : null;
  runtime = await createTestRuntime({ database, ...(stateRoot ? {
    programDataPath: path.join(stateRoot, 'instance'), configurationDirectoryPath: path.join(stateRoot, 'config'),
  } : {}), configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true, ...configuration }, serverId: 'session-control-test' });
  close = runtime.close.bind(runtime);
  runtime.close = dispose;
  await database.insert('BaseItems', movie());
  const user = await runtime.users.createUser({ Name: 'CoreFlowAdmin', Password: 'isolated-core-flow-password' });
  await runtime.users.updatePolicy(user.Id, { ...(await runtime.users.getUser(user.Id)).Policy, IsAdministrator: true });

  return { runtime, database, origin: `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`, user };
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Session fixture construction and cleanup failed.'); }
    throw error;
  }
}
async function controlledSession(runtime, deviceId) {
  const login = await runtime.authentication.login({ Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' },
    { Client: 'UserViewPlaybackTest', Device: 'Device', DeviceId: deviceId, Version: '1.0' }, { remoteEndPoint: '127.0.0.1' });
  const messages = [];
  runtime.sessions.attachController(login.SessionInfo.Id, {
    isActive: () => true,
    supportsMediaControl: true,
    sendMessage: async (messageType, messageId, data) => messages.push({ messageType, messageId, data })
  });
  return { login, messages };
}
test('remote playback commands and socket lifecycle reproduce the actual native HTTP/WebSocket recording', async () => {
  const { runtime, origin } = await setup();
  try {
    const expected = parseLosslessJson(await readFile(new URL('../sessions/fixtures/remote-control-reference.json', import.meta.url), 'utf8'));
    const actual = await record(origin);
    assert.equal(actual.records.length, expected.records.length);
    for (let index = 0; index < expected.records.length; index++) assert.deepEqual(
      projectSessionControlRecord(actual.records[index], actual.identities),
      projectSessionControlRecord(expected.records[index], expected.identities), expected.records[index].name);
    assert.equal(actual.records.find(entry => entry.name === 'seek-wire').body.Data.SeekPositionTicks, 9007199254740993n);
  } finally { await runtime.close(); }
});

test('remote play and browse query binding matches the recorded native required and comma-collection branches', async () => {
  const { runtime, origin } = await setup();
  try {
    const { login } = await controlledSession(runtime, 'query-binding');
    const headers = { Authorization: `MediaBrowser Client="QueryBinding", Device="Device", DeviceId="query-binding", Version="1", Token="${login.AccessToken}"` };
    const call = async route => {
      const response = await fetch(origin + route, { method: 'POST', headers });
      const text = await response.text();
      return { status: response.status, body: text ? parseLosslessJson(text) : null };
    };
    const id = movie().Id.replaceAll('-', '');
    for (const route of [`/Sessions/${login.SessionInfo.Id}/Playing`, `/Sessions/${login.SessionInfo.Id}/Playing?itemIds=${id}`]) {
      const response = await call(route);
      assert.equal(response.status, 400);
      assert.deepEqual(response.body.errors.playCommand, ['The playCommand field is required.']);
    }
    for (const value of ['', '%20', '5', '-1']) {
      const response = await call(`/Sessions/${login.SessionInfo.Id}/Playing?playCommand=${value}&itemIds=${id}`);
      assert.equal(response.status, 400, value);
      assert.deepEqual(response.body.errors.playCommand, [`The value '${decodeURIComponent(value)}' is invalid.`], value);
    }
    assert.equal((await call(`/Sessions/${login.SessionInfo.Id}/Playing?playCommand=PlayNow&itemIds=invalid`)).status, 204);
    assert.equal((await call(`/Sessions/${login.SessionInfo.Id}/Playing?playCommand=PlayNow&itemIds=${id},invalid`)).status, 204);

    const missing = await call(`/Sessions/${login.SessionInfo.Id}/Viewing`);
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body.errors, {
      itemId: ['The itemId field is required.'], itemName: ['The itemName field is required.'], itemType: ['The itemType field is required.']
    });
    const missingType = await call(`/Sessions/${login.SessionInfo.Id}/Viewing?itemId=${id}&itemName=Movie`);
    assert.deepEqual(missingType.body.errors, { itemType: ['The itemType field is required.'] });
    const emptyType = await call(`/Sessions/${login.SessionInfo.Id}/Viewing?itemType=&itemId=${id}&itemName=Movie`);
    assert.deepEqual(emptyType.body.errors, { itemType: ["The value '' is invalid."] });
  } finally { await runtime.close(); }
});

test('general and message command HTTP binding matches the recorded native validation and wire values', async () => {
  const { runtime, origin } = await setup();
  try {
    const target = await controlledSession(runtime, 'command-target');
    const controller = await runtime.authentication.login({ Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' },
      { Client: 'SessionCommandTest', Device: 'Device', DeviceId: 'command-controller', Version: '1.0' }, { remoteEndPoint: '127.0.0.1' });
    const authorization = `MediaBrowser Client="SessionCommandTest", Device="Device", DeviceId="command-controller", Version="1.0", Token="${controller.AccessToken}"`;
    const call = async (endpoint, source) => {
      const response = await fetch(`${origin}/Sessions/${target.login.SessionInfo.Id}/${endpoint}`, {
        method: 'POST', headers: { Authorization: authorization, ...(source === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: source
      });
      const text = await response.text();
      return { status: response.status, contentType: response.headers.get('content-type'), body: text ? parseLosslessJson(text) : '' };
    };
    const assertProblem = (actual, status, title, errors) => {
      assert.equal(actual.status, status);
      assert.equal(actual.body.type, `https://tools.ietf.org/html/rfc9110#section-15.5.${status === 400 ? 1 : 16}`);
      assert.equal(actual.body.title, title);
      assert.equal(actual.body.status, status);
      if (errors) assert.deepEqual(actual.body.errors, errors);
      else assert.equal(actual.body.errors, undefined);
      assert.equal(typeof actual.body.traceId, 'string'); assert.ok(actual.body.traceId.length > 0);
    };
    const wire = () => {
      assert.equal(target.messages.length, 1);
      const message = target.messages.shift();
      assert.equal(message.messageType, 'GeneralCommand');
      assert.match(message.messageId, /^[0-9a-f]{32}$/);
      return parseLosslessJson(JSON.stringify(message.data, (_key, value) => value instanceof Map ? Object.fromEntries(value) : typeof value === 'bigint' ? value.toString() : value));
    };
    const userId = controller.User.Id.replaceAll('-', '').toLowerCase();

    assert.equal((await call('Command', '{}')).status, 204);
    assert.deepEqual(wire(), { Name: 'MoveUp', ControllingUserId: userId, Arguments: {} });
    assertProblem(await call('Command', 'null'), 400, 'One or more validation errors occurred.', {
      '': ['A non-empty request body is required.'], command: ['The command field is required.']
    });
    assertProblem(await call('Command'), 415, 'Unsupported Media Type');
    assertProblem(await call('Command', '{"name":"invalid"}'), 400, 'One or more validation errors occurred.', {
      command: ['The command field is required.'],
      '$.name': ['The JSON value could not be converted to MediaBrowser.Model.Session.GeneralCommandType. Path: $.name | LineNumber: 0 | BytePositionInLine: 17.']
    });
    assert.equal((await call('Command', '{"name":999}')).status, 204);
    assert.deepEqual(wire(), { Name: 999, ControllingUserId: userId, Arguments: {} });
    assert.equal((await call('Command', '{"name":"SetVolume","arguments":null}')).status, 204);
    assert.deepEqual(wire(), { Name: 'SetVolume', ControllingUserId: userId, Arguments: {} });
    assert.equal((await call('Command', '{"name":"SetVolume","arguments":{"Number":1,"Boolean":true,"Null":null}}')).status, 204);
    assert.deepEqual(wire(), { Name: 'SetVolume', ControllingUserId: userId, Arguments: { Number: '1', Boolean: 'true', Null: null } });
    for (const [source, path] of [['{"arguments":{"Nested":{}}}', '$.arguments.Nested'], ['{"arguments":{"Nested":[]}}', '$.arguments.Nested']]) {
      assertProblem(await call('Command', source), 400, 'One or more validation errors occurred.', {
        command: ['The command field is required.'],
        [path]: [`The converter 'Jellyfin.Extensions.Json.Converters.JsonStringConverter' read too much or not enough. Path: ${path} | LineNumber: 0 | BytePositionInLine: 24.`]
      });
    }
    assertProblem(await call('Command', '{"arguments":[]}'), 400, 'One or more validation errors occurred.', {
      command: ['The command field is required.'],
      '$.arguments': ['The JSON value could not be converted to System.Collections.Generic.Dictionary`2[System.String,System.String]. Path: $.arguments | LineNumber: 0 | BytePositionInLine: 14.']
    });
    assertProblem(await call('Command', '{"controllingUserId":"bad"}'), 400, 'One or more validation errors occurred.', {
      '': ['The supplied value is invalid.'], command: ['The command field is required.']
    });
    assert.equal((await call('Command', '{"name":"SetVolume","controllingUserId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","arguments":{"Volume":"37"}}')).status, 204);
    assert.deepEqual(wire(), { Name: 'SetVolume', ControllingUserId: userId, Arguments: { Volume: '37' } });

    for (const source of ['{}', '{"text":""}', '{"text":" "}', '{"text":null}']) {
      assertProblem(await call('Message', source), 400, 'One or more validation errors occurred.', { Text: ['The Text field is required.'] });
    }
    assertProblem(await call('Message', 'null'), 400, 'One or more validation errors occurred.', {
      '': ['A non-empty request body is required.'], command: ['The command field is required.']
    });
    assertProblem(await call('Message'), 415, 'Unsupported Media Type');
    assertProblem(await call('Message', '{"text":{}}'), 400, 'One or more validation errors occurred.', {
      command: ['The command field is required.'],
      '$.text': ["The converter 'Jellyfin.Extensions.Json.Converters.JsonStringConverter' read too much or not enough. Path: $.text | LineNumber: 0 | BytePositionInLine: 9."]
    });
    assertProblem(await call('Message', '{"text":"ok","timeoutMs":"bad"}'), 400, 'One or more validation errors occurred.', {
      '$': ['The JSON value could not be converted to System.Int64. Path: $ | LineNumber: 0 | BytePositionInLine: 5.'],
      command: ['The command field is required.']
    });
    assertProblem(await call('Message', '{"text":"ok","timeoutMs":9223372036854775808}'), 400, 'One or more validation errors occurred.', {
      '$': ['The JSON value could not be converted to System.Int64. Path: $ | LineNumber: 0 | BytePositionInLine: 19.'],
      command: ['The command field is required.']
    });
    assert.equal((await call('Message', '{"header":true,"text":1,"timeoutMs":"9007199254740993"}')).status, 204);
    assert.deepEqual(wire(), { Name: 'DisplayMessage', ControllingUserId: '00000000000000000000000000000000',
      Arguments: { Header: 'true', Text: '1', TimeoutMs: '9007199254740993' } });
    assert.equal((await call('Message', '{"header":" ","text":"中文 message"}')).status, 204);
    assert.deepEqual(wire(), { Name: 'DisplayMessage', ControllingUserId: '00000000000000000000000000000000',
      Arguments: { Header: 'Message from Server', Text: '中文 message' } });
  } finally { await runtime.close(); }
});

test('legacy playback query binding matches the recorded nullable, aggregate and exact-integer branches', async () => {
  const { runtime, origin } = await setup();
  try {
    const login = await runtime.authentication.login({ Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' },
      { Client: 'LegacyBindingTest', Device: 'Device', DeviceId: 'legacy-binding', Version: '1.0' }, { remoteEndPoint: '127.0.0.1' });
    const authorization = `MediaBrowser Client="LegacyBindingTest", Device="Device", DeviceId="legacy-binding", Version="1.0", Token="${login.AccessToken}"`;
    const id = movie().Id.replaceAll('-', '');
    const call = async (method, route) => {
      const response = await fetch(origin + route, { method, headers: { Authorization: authorization } });
      const text = await response.text();
      let body = text;
      try { body = text ? parseLosslessJson(text) : ''; } catch {}
      return { status: response.status, body };
    };
    const errors = async (method, route, expected) => {
      const response = await call(method, route);
      assert.equal(response.status, 400, route);
      assert.equal(response.body.type, 'https://tools.ietf.org/html/rfc9110#section-15.5.1');
      assert.equal(response.body.title, 'One or more validation errors occurred.');
      assert.equal(response.body.status, 400);
      assert.deepEqual(response.body.errors, expected, route);
      assert.equal(typeof response.body.traceId, 'string'); assert.ok(response.body.traceId.length > 0);
    };
    const state = () => runtime.sessions.getSession(login.SessionInfo.Id).PlayState;

    assert.equal((await call('POST', `/PlayingItems/${id}`)).status, 204);
    assert.equal(state().PlayMethod, 'DirectPlay');
    assert.equal(state().CanSeek, false);
    await errors('POST', '/PlayingItems/bad', { itemId: ["The value 'bad' is not valid."] });
    await errors('POST', `/Users/bad/PlayingItems/${id}`, { userId: ["The value 'bad' is not valid."] });

    for (const value of ['', '%20']) {
      assert.equal((await call('POST', `/PlayingItems/${id}?audioStreamIndex=${value}`)).status, 204);
      assert.equal(state().AudioStreamIndex, null);
    }
    for (const value of ['x', '2147483648', '-2147483649']) {
      const decoded = decodeURIComponent(value);
      await errors('POST', `/PlayingItems/${id}?audioStreamIndex=${value}`, { audioStreamIndex: [`The value '${decoded}' is not valid.`] });
    }
    assert.equal((await call('POST', `/PlayingItems/${id}?audioStreamIndex=1&audioStreamIndex=2`)).status, 204);
    assert.equal(state().AudioStreamIndex, 1);

    for (const value of ['', '%20', 'invalid', '2147483648', '-2147483649', '1.5']) {
      assert.equal((await call('POST', `/PlayingItems/${id}?playMethod=${value}`)).status, 204);
      assert.equal(state().PlayMethod, 'DirectPlay');
    }
    for (const [value, expected] of [['0', 'DirectPlay'], ['1', 'DirectStream'], ['2', 'DirectPlay'], ['3', 3], ['-1', -1], ['dIrEcTpLaY', 'DirectPlay']]) {
      assert.equal((await call('POST', `/PlayingItems/${id}?playMethod=${value}`)).status, 204);
      assert.equal(state().PlayMethod, expected, value);
    }
    assert.equal((await call('POST', `/PlayingItems/${id}?playMethod=DirectStream%2CDirectPlay`)).status, 204);
    assert.equal(state().PlayMethod, 3);
    assert.equal((await call('POST', `/PlayingItems/${id}?playMethod=1&playMethod=2`)).status, 204);
    assert.equal(state().PlayMethod, 'DirectStream');
    for (const [value, message] of [['', "The value '' is invalid."], ['%20', "The value ' ' is invalid."], ['1', "The value '1' is not valid."], ['0', "The value '0' is not valid."], ['yes', "The value 'yes' is not valid."]]) {
      await errors('POST', `/PlayingItems/${id}?canSeek=${value}`, { canSeek: [message] });
    }
    assert.equal((await call('POST', `/PlayingItems/${id}?canSeek=TRUE`)).status, 204);
    assert.equal(state().CanSeek, true);
    assert.equal((await call('POST', `/PlayingItems/${id}?canSeek=true&canSeek=false`)).status, 204);
    assert.equal(state().CanSeek, true);
    assert.equal((await call('POST', `/PlayingItems/${id}?audioStreamIndex=%2B1`)).status, 204);
    assert.equal(state().AudioStreamIndex, 1);
    await errors('POST', '/Users/bad/PlayingItems/worse?audioStreamIndex=x&canSeek=maybe', {
      itemId: ["The value 'worse' is not valid."], userId: ["The value 'bad' is not valid."],
      canSeek: ["The value 'maybe' is not valid."], audioStreamIndex: ["The value 'x' is not valid."]
    });
    await errors('POST', `/PlayingItems/${id}?audioStreamIndex=x&subtitleStreamIndex=y&playMethod=no&canSeek=maybe`, {
      canSeek: ["The value 'maybe' is not valid."], audioStreamIndex: ["The value 'x' is not valid."], subtitleStreamIndex: ["The value 'y' is not valid."]
    });

    for (const value of [undefined, '', '%20']) {
      const suffix = value === undefined ? '' : `?positionTicks=${value}`;
      assert.equal((await call('POST', `/PlayingItems/${id}/Progress${suffix}`)).status, 204);
      assert.equal(state().PositionTicks, null);
    }
    for (const value of ['x', '9223372036854775808', '-9223372036854775809']) {
      await errors('POST', `/PlayingItems/${id}/Progress?positionTicks=${value}`, { positionTicks: [`The value '${value}' is not valid.`] });
    }
    for (const value of ['9223372036854775807', '-9223372036854775808']) {
      assert.equal((await call('POST', `/PlayingItems/${id}/Progress?positionTicks=${value}`)).status, 204);
      assert.equal(state().PositionTicks, BigInt(value));
    }
    assert.equal((await call('POST', `/PlayingItems/${id}/Progress?positionTicks=1&positionTicks=2`)).status, 204);
    assert.equal(state().PositionTicks, 1n);
    for (const value of ['', 'invalid']) {
      assert.equal((await call('POST', `/PlayingItems/${id}/Progress?repeatMode=${value}`)).status, 204);
      assert.equal(state().RepeatMode, 'RepeatNone');
    }
    for (const [value, expected] of [['0', 'RepeatNone'], ['2', 'RepeatOne'], ['3', 3], ['-1', -1]]) {
      assert.equal((await call('POST', `/PlayingItems/${id}/Progress?repeatMode=${value}`)).status, 204);
      assert.equal(state().RepeatMode, expected);
    }
    assert.equal((await call('POST', `/PlayingItems/${id}/Progress?repeatMode=2147483648`)).status, 204);
    assert.equal(state().RepeatMode, 'RepeatNone');
    assert.equal((await call('POST', `/PlayingItems/${id}/Progress?repeatMode=RepeatAll%2CRepeatOne`)).status, 204);
    assert.equal(state().RepeatMode, 3);
    assert.equal((await call('POST', `/PlayingItems/${id}/Progress?positionTicks=%2B1`)).status, 204);
    assert.equal(state().PositionTicks, 1n);
    assert.equal((await call('POST', `/PlayingItems/${id}/Progress?isMuted=true&isPaused=TRUE&volumeLevel=37&positionTicks=9007199254740993`)).status, 204);
    assert.equal(state().PositionTicks, 9007199254740993n);
    assert.equal(state().VolumeLevel, 37);
    assert.equal(state().IsPaused, true);
    assert.equal(state().IsMuted, true);
    await errors('POST', `/PlayingItems/${id}/Progress?isMuted=1&isPaused=0`, {
      isMuted: ["The value '1' is not valid."], isPaused: ["The value '0' is not valid."]
    });
    await errors('POST', `/PlayingItems/${id}/Progress?positionTicks=x&audioStreamIndex=y&subtitleStreamIndex=z&volumeLevel=q&playMethod=no&repeatMode=bad&isPaused=1&isMuted=0`, {
      isMuted: ["The value '0' is not valid."], isPaused: ["The value '1' is not valid."], volumeLevel: ["The value 'q' is not valid."],
      positionTicks: ["The value 'x' is not valid."], audioStreamIndex: ["The value 'y' is not valid."], subtitleStreamIndex: ["The value 'z' is not valid."]
    });

    await errors('DELETE', `/PlayingItems/${id}?positionTicks=x`, { positionTicks: ["The value 'x' is not valid."] });
    await errors('DELETE', `/PlayingItems/${id}?positionTicks=9223372036854775808`, { positionTicks: ["The value '9223372036854775808' is not valid."] });
    const negative = await call('DELETE', `/PlayingItems/${id}?positionTicks=-1`);
    assert.equal(negative.status, 400);
    assert.equal(negative.body, 'Error processing request.');
    await errors('DELETE', `/Users/bad/PlayingItems/${id}`, { userId: ["The value 'bad' is not valid."] });
    assert.equal((await call('DELETE', `/Users/${login.User.Id}/PlayingItems/${id}?positionTicks=9007199254740993&nextMediaType=Video`)).status, 204);
    assert.equal(runtime.sessions.getSession(login.SessionInfo.Id).NowPlayingItem, null);
  } finally { await runtime.close(); }
});

test('remote playback keeps BoxSet repository scope separate from physical cache and playlist links', async () => {
  const { runtime, database } = await setup();
  try {
    const alphaId = '11111111-2222-3333-4444-555555555555';
    const playlistId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const boxSetId = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb';
    await database.insert('BaseItems', { ...movie(), Id: alphaId, Name: 'Alpha', CleanName: 'alpha', SortName: 'alpha', Path: 'Z:\\Isolated\\alpha.mkv' });
    await database.insert('BaseItems', { ...movie(), Id: playlistId, Type: 'MediaBrowser.Controller.Playlists.Playlist', Name: 'Playlist', CleanName: 'playlist', SortName: 'playlist', Data: '{}', MediaType: 'Unknown', Path: null, IsFolder: true });
    await database.insert('BaseItems', { ...movie(), Id: boxSetId, Type: 'MediaBrowser.Controller.Entities.Movies.BoxSet', Name: 'Collection', CleanName: 'collection', SortName: 'collection', Data: '{}', MediaType: 'Unknown', Path: null, IsFolder: true });
    for (const parentId of [playlistId, boxSetId]) {
      await database.insert('LinkedChildren', { ParentId: parentId, SortOrder: 0, ChildId: movie().Id, ChildType: 0 });
      await database.insert('LinkedChildren', { ParentId: parentId, SortOrder: 1, ChildId: alphaId, ChildType: parentId === boxSetId ? 2 : 0 });
    }
    const login = await runtime.authentication.login({ Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' },
      { Client: 'ContainerPlaybackTest', Device: 'Device', DeviceId: 'container-playback', Version: '1.0' }, { remoteEndPoint: '127.0.0.1' });
    const messages = [];
    runtime.sessions.attachController(login.SessionInfo.Id, {
      isActive: () => true,
      supportsMediaControl: true,
      sendMessage: async (messageType, messageId, data) => messages.push({ messageType, messageId, data })
    });
    for (const itemId of [playlistId, boxSetId]) {
      messages.length = 0;
      await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [itemId], PlayCommand: 'PlayNow' }, { controllingSessionId: login.SessionInfo.Id });
      assert.equal(messages.length, 1);
      assert.equal(messages[0].messageType, 'Play');
      assert.match(messages[0].messageId, /^[0-9a-f]{32}$/);
      assert.deepEqual(messages[0].data.ItemIds, itemId === boxSetId ? []
        : [alphaId, movie().Id].map(value => value.replaceAll('-', '')));
      assert.equal(messages[0].data.ControllingUserId, login.User.Id);
    }
    const physicalId = 'ffffffff-0000-0000-0000-000000000001';
    const libraryId = 'ffffffff-0000-0000-0000-000000000002';
    const userRootPath = 'Z:\\Isolated\\root\\default';
    const userRootId = getNewItemId(userRootPath, 'MediaBrowser.Controller.Entities.UserRootFolder', { programDataPath: 'Z:\\Isolated' });
    await database.insert('BaseItems', { ...movie(), Id: userRootId, Type: 'MediaBrowser.Controller.Entities.UserRootFolder',
      Name: 'default', CleanName: 'default', SortName: 'default', IsFolder: true, MediaType: 'Unknown', Path: userRootPath, Data: '{}' });
    await database.insert('BaseItems', { ...movie(), Id: physicalId, Type: 'MediaBrowser.Controller.Entities.Folder',
      IsFolder: true, MediaType: 'Unknown', Path: 'Z:\\Isolated' });
    await database.insert('BaseItems', { ...movie(), Id: libraryId, Type: 'MediaBrowser.Controller.Entities.CollectionFolder',
      IsFolder: true, MediaType: 'Unknown', Path: null, ParentId: userRootId, Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [physicalId] }) });
    for (const id of [alphaId, movie().Id]) await database.update('BaseItems', { Id: id }, { ParentId: physicalId, TopParentId: physicalId });
    messages.length = 0;
    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [boxSetId], PlayCommand: 'PlayNow' }, { controllingSessionId: login.SessionInfo.Id });
    assert.deepEqual(messages[0].data.ItemIds, [alphaId, movie().Id].map(value => value.replaceAll('-', '')));
    const current = await runtime.users.getUser(login.User.Id);
    await runtime.users.updatePolicy(current.Id, { ...current.Policy, EnableAllFolders: false, EnabledFolders: [] });
    messages.length = 0;
    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [boxSetId], PlayCommand: 'PlayNow' }, { controllingSessionId: login.SessionInfo.Id });
    assert.deepEqual(messages[0].data.ItemIds, []);
  } finally { await runtime.close(); }
});

test('remote playback expands grouped and parented user views with native type, visibility and ordering rules', async () => {
  const { runtime, database, user } = await setup();
  try {
    const ids = {
      grouped: '30000000-0000-0000-0000-000000000001', display: '30000000-0000-0000-0000-000000000002', latest: '30000000-0000-0000-0000-000000000003',
      direct: '30000000-0000-0000-0000-000000000004',
      collectionA: '30000000-0000-0000-0000-000000000011', physicalA: '30000000-0000-0000-0000-000000000012',
      collectionB: '30000000-0000-0000-0000-000000000013', physicalB: '30000000-0000-0000-0000-000000000014', nested: '30000000-0000-0000-0000-000000000015',
      alpha: '30000000-0000-0000-0000-000000000021', bravo: '30000000-0000-0000-0000-000000000022', charlie: '30000000-0000-0000-0000-000000000023',
      hidden: '30000000-0000-0000-0000-000000000024', virtual: '30000000-0000-0000-0000-000000000025', episode: '30000000-0000-0000-0000-000000000026',
      topOnly: '30000000-0000-0000-0000-000000000027', linked: '30000000-0000-0000-0000-000000000028',
      userRoot: '30000000-0000-0000-0000-000000000041', aggregate: '30000000-0000-0000-0000-000000000042'
    };
    const collection = (id, physical, name) => ({ ...movie(), Id: id, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: name,
      CleanName: name.toLowerCase(), SortName: name.toLowerCase(), Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [physical] }), ParentId: ids.userRoot,
      MediaType: 'Unknown', Path: null, IsFolder: true });
    const folder = (id, name, parentId = null, topParentId = null) => ({ ...movie(), Id: id, Type: 'MediaBrowser.Controller.Entities.Folder', Name: name,
      CleanName: name.toLowerCase(), SortName: name.toLowerCase(), Data: '{}', MediaType: 'Unknown', Path: `Z:\\Isolated\\${name}`, IsFolder: true, ParentId: parentId, TopParentId: topParentId });
    const leaf = (id, name, parentId, topParentId, options = {}) => ({ ...movie(), Id: id, Name: name, CleanName: name.toLowerCase(), SortName: name.toLowerCase(),
      ParentId: parentId, TopParentId: topParentId, PresentationUniqueKey: id.replaceAll('-', ''), Path: `Z:\\Isolated\\${name}.mkv`, ...options });
    await database.insert('BaseItems', { ...movie(), Id: ids.userRoot, Type: 'MediaBrowser.Controller.Entities.UserRootFolder', IsFolder: true, MediaType: 'Unknown', Path: null });
    await database.insert('BaseItems', { ...movie(), Id: ids.aggregate, Type: 'MediaBrowser.Controller.Entities.AggregateFolder', IsFolder: true, MediaType: 'Unknown', Path: null });
    await database.insert('BaseItems', collection(ids.collectionA, ids.physicalA, 'Movies A'));
    await database.insert('BaseItems', collection(ids.collectionB, ids.physicalB, 'Movies B'));
    await database.insert('BaseItems', folder(ids.physicalA, 'Physical A', ids.aggregate));
    await database.insert('BaseItems', folder(ids.physicalB, 'Physical B', ids.aggregate));
    await database.insert('BaseItems', folder(ids.nested, 'Nested', ids.physicalA, ids.physicalA));
    await database.insert('BaseItems', leaf(ids.alpha, 'Alpha', ids.nested, ids.physicalA, { DateCreated: '2024-01-01 00:00:00' }));
    await database.insert('BaseItems', leaf(ids.bravo, 'Bravo', ids.physicalA, ids.physicalA, { DateCreated: '2025-01-01 00:00:00' }));
    await database.insert('BaseItems', leaf(ids.hidden, 'Hidden', ids.physicalA, ids.physicalA, { Tags: 'hidden', DateCreated: '2026-01-01 00:00:00' }));
    await database.insert('BaseItems', leaf(ids.virtual, 'Virtual', ids.physicalA, ids.physicalA, { Path: null, IsVirtualItem: true, DateCreated: '2027-01-01 00:00:00' }));
    await database.insert('BaseItems', leaf(ids.episode, 'Episode', ids.physicalA, ids.physicalA, { Type: 'MediaBrowser.Controller.Entities.TV.Episode' }));
    await database.insert('BaseItems', leaf(ids.topOnly, 'Delta', null, ids.physicalA, { DateCreated: '2023-01-01 00:00:00' }));
    await database.insert('BaseItems', leaf(ids.linked, 'Linked', null, null));
    await database.insert('LinkedChildren', { ParentId: ids.physicalA, SortOrder: 0, ChildId: ids.linked, ChildType: 1 });
    await database.insert('BaseItems', leaf(ids.charlie, 'Charlie', ids.physicalB, ids.physicalB));
    const view = (id, viewType, data = {}, parentId = null) => ({ ...movie(), Id: id, Type: 'MediaBrowser.Controller.Entities.UserView', Name: viewType,
      CleanName: viewType, SortName: viewType, Data: JSON.stringify({ ViewType: viewType, ...data }), MediaType: 'Unknown', Path: null, IsFolder: true, ParentId: parentId });
    await database.insert('BaseItems', view(ids.grouped, 'movies'));
    await database.insert('BaseItems', view(ids.display, 'movies', { DisplayParentId: ids.collectionB }, ids.collectionA));
    await database.insert('BaseItems', view(ids.latest, 'movielatest', { DisplayParentId: ids.collectionA }));
    await database.insert('BaseItems', view(ids.direct, 'unknown'));
    const blockedTag = '30000000-0000-0000-0000-000000000031';
    await database.insert('ItemValues', { ItemValueId: blockedTag, CleanValue: 'hidden', Type: 4, Value: 'hidden' });
    await database.insert('ItemValuesMap', { ItemValueId: blockedTag, ItemId: ids.hidden });
    await runtime.users.updateConfiguration(user.Id, { GroupedFolders: [ids.collectionA] });
    await runtime.users.updatePolicy(user.Id, { ...(await runtime.users.getUser(user.Id)).Policy, BlockedTags: ['hidden'] });
    const { login, messages } = await controlledSession(runtime, 'user-view-playback');

    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.grouped], PlayCommand: 'PlayNow' }, { controllingSessionId: login.SessionInfo.Id });
    assert.deepEqual(messages.pop().data.ItemIds, [ids.alpha, ids.bravo, ids.topOnly].map(value => value.replaceAll('-', '')));

    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.display], PlayCommand: 'PlayNow' }, { controllingSessionId: login.SessionInfo.Id });
    assert.deepEqual(messages.pop().data.ItemIds, [ids.charlie].map(value => value.replaceAll('-', '')));

    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.latest], PlayCommand: 'PlayNow' }, { controllingSessionId: login.SessionInfo.Id });
    assert.deepEqual(messages.pop().data.ItemIds, [ids.bravo, ids.alpha, ids.topOnly].map(value => value.replaceAll('-', '')));

    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.direct], PlayCommand: 'PlayNow' }, { controllingSessionId: login.SessionInfo.Id });
    assert.deepEqual(messages.pop().data.ItemIds, [ids.bravo, ids.episode, ids.linked].map(value => value.replaceAll('-', '')));
  } finally { await runtime.close(); }
});

test('remote playback expands movie resume views with version winners and complete DatePlayed ordering', async () => {
  const { runtime, database } = await setup();
  try {
    const ids = {
      collection: '35000000-0000-0000-0000-000000000001', physical: '35000000-0000-0000-0000-000000000002', view: '35000000-0000-0000-0000-000000000003',
      aggregate: '35000000-0000-0000-0000-000000000011', primary: '35000000-0000-0000-0000-000000000012', alternate: '35000000-0000-0000-0000-000000000013',
      owned: '35000000-0000-0000-0000-000000000014', virtual: '35000000-0000-0000-0000-000000000015'
    };
    await database.insert('BaseItems', { ...movie(), Id: ids.collection, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Movies', CleanName: 'movies', SortName: 'movies',
      Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [ids.physical] }), MediaType: 'Unknown', Path: null, IsFolder: true });
    await database.insert('BaseItems', { ...movie(), Id: ids.physical, Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Physical', CleanName: 'physical', SortName: 'physical',
      Data: '{}', MediaType: 'Unknown', Path: 'Z:\\Isolated\\Movies', IsFolder: true });
    const addMovie = (id, name, options = {}) => database.insert('BaseItems', {
      ...movie(), Id: id, Name: name, CleanName: name.toLowerCase(), SortName: name.toLowerCase(), ParentId: ids.physical, TopParentId: ids.physical,
      PresentationUniqueKey: options.PresentationUniqueKey ?? id.replaceAll('-', ''), Path: options.IsVirtualItem ? null : `Z:\\Isolated\\Movies\\${name}.mkv`, ...options
    });
    await addMovie(ids.aggregate, 'Aggregated Date');
    await addMovie(ids.primary, 'Primary Version', { PresentationUniqueKey: 'resume-version-family' });
    await addMovie(ids.alternate, 'Alternate Version', { PresentationUniqueKey: 'resume-version-family', PrimaryVersionId: ids.primary });
    await addMovie(ids.owned, 'Owned', { OwnerId: ids.primary });
    await addMovie(ids.virtual, 'Virtual', { IsVirtualItem: true });
    await database.insert('BaseItems', { ...movie(), Id: ids.view, Type: 'MediaBrowser.Controller.Entities.UserView', Name: 'Resume', CleanName: 'resume', SortName: 'resume',
      Data: JSON.stringify({ ViewType: 'movieresume', DisplayParentId: ids.collection }), MediaType: 'Unknown', Path: null, IsFolder: true });

    const userData = Object.fromEntries(tableDefinition('UserData').columns.map(column => [column.name,
      column.clrType.replace('?', '') === 'DateTime' ? '2026-09-26 00:00:00' : column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
    const storedUserId = (await database.rows('Users'))[0].Id;
    const addUserData = (itemId, key, position, date) => database.insert('UserData', {
      ...userData, UserId: storedUserId, ItemId: itemId, CustomDataKey: key, PlaybackPositionTicks: position, LastPlayedDate: date
    });
    await addUserData(ids.aggregate, 'legacy-aggregate', 1000n, '2026-09-20 12:00:00');
    await addUserData(ids.aggregate, ids.aggregate.replaceAll('-', ''), 0n, '2026-09-30 12:00:00');
    await addUserData(ids.primary, ids.primary.replaceAll('-', ''), 1000n, '2026-09-27 12:00:00');
    await addUserData(ids.alternate, ids.alternate.replaceAll('-', ''), 1000n, '2026-09-29 12:00:00');
    await addUserData(ids.owned, ids.owned.replaceAll('-', ''), 1000n, '2026-10-01 12:00:00');
    await addUserData(ids.virtual, ids.virtual.replaceAll('-', ''), 1000n, '2026-10-02 12:00:00');
    const { login, messages } = await controlledSession(runtime, 'movie-resume-playback');

    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.view], PlayCommand: 'PlayNow' }, { controllingSessionId: login.SessionInfo.Id });
    assert.deepEqual(messages[0].data.ItemIds, [ids.aggregate, ids.alternate].map(value => value.replaceAll('-', '')));
  } finally { await runtime.close(); }
});

test('remote playback uses UserView ParentId only when DisplayParentId is absent and preserves native view failures', async () => {
  const { runtime, database } = await setup();
  try {
    const ids = {
      collection: '31000000-0000-0000-0000-000000000001', physical: '31000000-0000-0000-0000-000000000002', parentView: '31000000-0000-0000-0000-000000000003',
      danglingView: '31000000-0000-0000-0000-000000000004', nextUpView: '31000000-0000-0000-0000-000000000005', missing: '31000000-0000-0000-0000-000000000006',
      alpha: '31000000-0000-0000-0000-000000000011', zulu: '31000000-0000-0000-0000-000000000012', movie: '31000000-0000-0000-0000-000000000013'
    };
    await database.insert('BaseItems', { ...movie(), Id: ids.collection, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Books', CleanName: 'books', SortName: 'books',
      Data: JSON.stringify({ CollectionType: 'books', PhysicalFolderIds: [ids.physical] }), MediaType: 'Unknown', Path: null, IsFolder: true });
    await database.insert('BaseItems', { ...movie(), Id: ids.physical, Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Physical', CleanName: 'physical', SortName: 'physical',
      Data: '{}', MediaType: 'Unknown', Path: 'Z:\\Isolated\\Books', IsFolder: true });
    for (const [id, name, type] of [[ids.alpha, 'Alpha', 'MediaBrowser.Controller.Entities.AudioBook'], [ids.zulu, 'Zulu', 'MediaBrowser.Controller.Entities.Book'], [ids.movie, 'Movie', 'MediaBrowser.Controller.Entities.Movies.Movie']]) {
      await database.insert('BaseItems', { ...movie(), Id: id, Type: type, Name: name, CleanName: name.toLowerCase(), SortName: name.toLowerCase(), ParentId: ids.physical,
        TopParentId: ids.physical, PresentationUniqueKey: id.replaceAll('-', ''), Data: '{}', MediaType: type.endsWith('AudioBook') ? 'Audio' : 'Unknown', Path: `Z:\\Isolated\\Books\\${name}` });
    }
    const userView = (id, viewType, data = {}) => ({ ...movie(), Id: id, Type: 'MediaBrowser.Controller.Entities.UserView', Name: viewType, CleanName: viewType, SortName: viewType,
      ParentId: ids.collection, Data: JSON.stringify({ ViewType: viewType, ...data }), MediaType: 'Unknown', Path: null, IsFolder: true });
    await database.insert('BaseItems', userView(ids.parentView, 'books'));
    await database.insert('BaseItems', userView(ids.danglingView, 'books', { DisplayParentId: ids.missing }));
    await database.insert('BaseItems', userView(ids.nextUpView, 'tvnextup'));
    const { login, messages } = await controlledSession(runtime, 'user-view-parent');

    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.parentView], PlayCommand: 'PlayNow' }, { controllingSessionId: login.SessionInfo.Id });
    assert.deepEqual(messages.pop().data.ItemIds, [ids.alpha, ids.zulu].map(value => value.replaceAll('-', '')));

    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.danglingView], PlayCommand: 'PlayNow' }, { controllingSessionId: login.SessionInfo.Id });
    assert.deepEqual(messages.pop().data.ItemIds, []);
    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.nextUpView], PlayCommand: 'PlayNow' }, { controllingSessionId: login.SessionInfo.Id });
    assert.deepEqual(messages.pop().data.ItemIds, []);
    await assert.rejects(runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.parentView], PlayCommand: 'PlayInstantMix' }, { controllingSessionId: login.SessionInfo.Id }),
      { status: 500, message: 'Error processing request.' });
  } finally { await runtime.close(); }
});

test('remote playback expands the proven primary-episode next-up path in last-watched order', async () => {
  const { runtime, database, user } = await setup();
  try {
    const ids = {
      collection: '33000000-0000-0000-0000-000000000001', physical: '33000000-0000-0000-0000-000000000002', view: '33000000-0000-0000-0000-000000000003',
      a1: '33000000-0000-0000-0000-000000000011', a2: '33000000-0000-0000-0000-000000000012',
      b1: '33000000-0000-0000-0000-000000000021', b2: '33000000-0000-0000-0000-000000000022'
    };
    await database.insert('BaseItems', { ...movie(), Id: ids.collection, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Shows', CleanName: 'shows', SortName: 'shows',
      Data: JSON.stringify({ CollectionType: 'tvshows', PhysicalFolderIds: [ids.physical] }), MediaType: 'Unknown', Path: null, IsFolder: true });
    await database.insert('BaseItems', { ...movie(), Id: ids.physical, Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Physical', CleanName: 'physical', SortName: 'physical',
      Data: '{}', MediaType: 'Unknown', Path: 'Z:\\Isolated\\Shows', IsFolder: true });
    const episode = (id, name, key, index) => ({ ...movie(), Id: id, Type: 'MediaBrowser.Controller.Entities.TV.Episode', Name: name, CleanName: name.toLowerCase(),
      SortName: name.toLowerCase(), ParentId: ids.physical, TopParentId: ids.physical, SeriesPresentationUniqueKey: key, ParentIndexNumber: 1, IndexNumber: index,
      PresentationUniqueKey: id.replaceAll('-', ''), Data: '{}', MediaType: 'Video', Path: `Z:\\Isolated\\Shows\\${name}.mkv`, IsFolder: false, IsVirtualItem: false });
    for (const args of [[ids.a1, 'A 1', 'series-a', 1], [ids.a2, 'A 2', 'series-a', 2], [ids.b1, 'B 1', 'series-b', 1], [ids.b2, 'B 2', 'series-b', 2]]) {
      await database.insert('BaseItems', episode(...args));
    }
    await database.insert('BaseItems', { ...movie(), Id: ids.view, Type: 'MediaBrowser.Controller.Entities.UserView', Name: 'Next up', CleanName: 'next up', SortName: 'next up',
      Data: JSON.stringify({ ViewType: 'tvnextup', DisplayParentId: ids.collection }), MediaType: 'Unknown', Path: null, IsFolder: true });
    const userData = Object.fromEntries(tableDefinition('UserData').columns.map(column => [column.name,
      column.clrType.replace('?', '') === 'DateTime' ? '2026-09-26 00:00:00' : column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
    const storedUserId = (await database.rows('Users'))[0].Id;
    for (const [itemId, date] of [[ids.a1, '2026-09-25 12:00:00'], [ids.b1, '2026-09-26 12:00:00']]) await database.insert('UserData', {
      ...userData, UserId: storedUserId, ItemId: itemId, CustomDataKey: itemId.replaceAll('-', ''), Played: true, PlayCount: 1, LastPlayedDate: date
    });
    const { login, messages } = await controlledSession(runtime, 'next-up-playback');

    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.view], PlayCommand: 'PlayNow' }, { controllingSessionId: login.SessionInfo.Id });
    assert.deepEqual(messages[0].data.ItemIds, [ids.b2, ids.a2].map(value => value.replaceAll('-', '')));
  } finally { await runtime.close(); }
});

test('remote playback expands movie-genre views through the view clean-name reference', async () => {
  const { runtime, database } = await setup();
  try {
    const ids = {
      collection: '34000000-0000-0000-0000-000000000001', physical: '34000000-0000-0000-0000-000000000002', view: '34000000-0000-0000-0000-000000000003',
      alpha: '34000000-0000-0000-0000-000000000011', zulu: '34000000-0000-0000-0000-000000000012', jazz: '34000000-0000-0000-0000-000000000013',
      action: '34000000-0000-0000-0000-000000000021', jazzValue: '34000000-0000-0000-0000-000000000022'
    };
    await database.insert('BaseItems', { ...movie(), Id: ids.collection, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Movies', CleanName: 'movies', SortName: 'movies',
      Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [ids.physical] }), MediaType: 'Unknown', Path: null, IsFolder: true });
    await database.insert('BaseItems', { ...movie(), Id: ids.physical, Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Physical', CleanName: 'physical', SortName: 'physical',
      Data: '{}', MediaType: 'Unknown', Path: 'Z:\\Isolated\\Movies', IsFolder: true });
    await database.insert('ItemValues', { ItemValueId: ids.action, CleanValue: 'action', Type: 2, Value: 'Action' });
    await database.insert('ItemValues', { ItemValueId: ids.jazzValue, CleanValue: 'jazz', Type: 2, Value: 'Jazz' });
    for (const [id, name, value] of [[ids.alpha, 'Alpha', ids.action], [ids.zulu, 'Zulu', ids.action], [ids.jazz, 'Jazz', ids.jazzValue]]) {
      await database.insert('BaseItems', { ...movie(), Id: id, Name: name, CleanName: name.toLowerCase(), SortName: name.toLowerCase(), ParentId: ids.physical,
        TopParentId: ids.physical, PresentationUniqueKey: id.replaceAll('-', ''), Path: `Z:\\Isolated\\Movies\\${name}.mkv` });
      await database.insert('ItemValuesMap', { ItemValueId: value, ItemId: id });
    }
    await database.insert('BaseItems', { ...movie(), Id: ids.view, Type: 'MediaBrowser.Controller.Entities.UserView', Name: 'Action', CleanName: 'action', SortName: 'action',
      Data: JSON.stringify({ ViewType: 'moviegenre', DisplayParentId: ids.collection }), MediaType: 'Unknown', Path: null, IsFolder: true });
    const { login, messages } = await controlledSession(runtime, 'movie-genre-playback');

    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.view], PlayCommand: 'PlayNow' }, { controllingSessionId: login.SessionInfo.Id });
    assert.deepEqual(messages[0].data.ItemIds, [ids.alpha, ids.zulu].map(value => value.replaceAll('-', '')));
  } finally { await runtime.close(); }
});

test('remote playback appends the remaining physical episodes in native aired order', async () => {
  const { runtime, database } = await setup({ DisplaySpecialsWithinSeasons: true });
  try {
    const ids = {
      series: '10000000-0000-0000-0000-000000000001', season0: '10000000-0000-0000-0000-000000000002', season1: '10000000-0000-0000-0000-000000000003', season2: '10000000-0000-0000-0000-000000000004',
      first: '10000000-0000-0000-0000-000000000011', special: '10000000-0000-0000-0000-000000000012', second: '10000000-0000-0000-0000-000000000013', third: '10000000-0000-0000-0000-000000000014', virtual: '10000000-0000-0000-0000-000000000015'
    };
    const seriesKey = 'series-playback-key';
    await database.insert('BaseItems', { ...movie(), Id: ids.series, Type: 'MediaBrowser.Controller.Entities.TV.Series', Name: 'Series', CleanName: 'series', SortName: 'series', PresentationUniqueKey: seriesKey, Data: '{}', MediaType: 'Unknown', Path: null, IsFolder: true });
    for (const [id, index] of [[ids.season0, 0], [ids.season1, 1], [ids.season2, 2]]) await database.insert('BaseItems', {
      ...movie(), Id: id, Type: 'MediaBrowser.Controller.Entities.TV.Season', Name: `Season ${index}`, CleanName: `season ${index}`, SortName: String(index).padStart(4, '0'),
      PresentationUniqueKey: `${seriesKey}-${String(index).padStart(3, '0')}`, SeriesPresentationUniqueKey: seriesKey, SeriesId: ids.series, ParentId: ids.series,
      IndexNumber: index, Data: '{}', MediaType: 'Unknown', Path: null, IsFolder: true
    });
    const episodes = [
      [ids.first, ids.season1, 1, 1, 'First', false, {}],
      [ids.special, ids.season0, 0, 1, 'Special', false, { AirsBeforeSeasonNumber: 1, AirsBeforeEpisodeNumber: 2 }],
      [ids.second, ids.season1, 1, 2, 'Second', false, {}],
      [ids.third, ids.season2, 2, 1, 'Third', false, {}],
      [ids.virtual, ids.season2, 2, 2, 'Missing', true, {}]
    ];
    for (const [id, seasonId, season, episode, name, virtual, data] of episodes) await database.insert('BaseItems', {
      ...movie(), Id: id, Type: 'MediaBrowser.Controller.Entities.TV.Episode', Name: name, CleanName: name.toLowerCase(),
      SortName: `${String(season).padStart(3, '0')} - ${String(episode).padStart(4, '0')} - ${name}`, PresentationUniqueKey: id.replaceAll('-', ''),
      SeriesPresentationUniqueKey: seriesKey, SeriesId: ids.series, SeasonId: seasonId, ParentId: seasonId, ParentIndexNumber: season, IndexNumber: episode,
      Data: JSON.stringify(data), Path: virtual ? null : `Z:\\Isolated\\${name}.mkv`, IsVirtualItem: virtual, IsFolder: false
    });
    const login = await runtime.authentication.login({ Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' },
      { Client: 'EpisodePlaybackTest', Device: 'Device', DeviceId: 'episode-playback', Version: '1.0' }, { remoteEndPoint: '127.0.0.1' });
    const messages = [];
    runtime.sessions.attachController(login.SessionInfo.Id, {
      isActive: () => true,
      supportsMediaControl: true,
      sendMessage: async (messageType, messageId, data) => messages.push({ messageType, messageId, data })
    });
    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.first], PlayCommand: 'PlayNow' }, { controllingSessionId: login.SessionInfo.Id });
    assert.deepEqual(messages[0].data.ItemIds, [ids.first, ids.special, ids.second, ids.third].map(value => value.replaceAll('-', '')));
  } finally { await runtime.close(); }
});

test('remote instant mix keeps the source song first and applies native repository exclusions', async () => {
  const { runtime, database } = await setup({}, { metadata: true });
  try {
    const ids = {
      source: '20000000-0000-0000-0000-000000000001', peer: '20000000-0000-0000-0000-000000000002', other: '20000000-0000-0000-0000-000000000003',
      alternate: '20000000-0000-0000-0000-000000000004', owned: '20000000-0000-0000-0000-000000000005', extra: '20000000-0000-0000-0000-000000000006',
      top: '20000000-0000-0000-0000-000000000010'
    };
    for (const [id, name, genre] of [[ids.source, 'Source', 'Rock'], [ids.peer, 'Peer', 'Rock'], [ids.other, 'Other', 'Jazz']]) await database.insert('BaseItems', {
      ...movie(), Id: id, Type: 'MediaBrowser.Controller.Entities.Audio.Audio', Name: name, CleanName: name.toLowerCase(), SortName: name.toLowerCase(),
      Genres: genre, Data: '{}', MediaType: 'Audio', Path: `Z:\\Isolated\\${name}.flac`, IsFolder: false
    });
    const audio = (id, name, options) => ({ ...movie(), Id: id, Type: 'MediaBrowser.Controller.Entities.Audio.Audio', Name: name, CleanName: name.toLowerCase(), SortName: name.toLowerCase(),
      Genres: 'Rock', Data: '{}', MediaType: 'Audio', Path: `Z:\\Isolated\\${name}.flac`, IsFolder: false, TopParentId: ids.top, ...options });
    await database.update('BaseItems', { Id: ids.peer }, { TopParentId: ids.top });
    await database.insert('BaseItems', audio(ids.alternate, 'Alternate', { PrimaryVersionId: ids.peer }));
    await database.insert('BaseItems', audio(ids.owned, 'Owned', { OwnerId: ids.peer, ExtraType: null }));
    await database.insert('BaseItems', audio(ids.extra, 'Extra', { OwnerId: ids.peer, ExtraType: 2 }));
    const values = { Rock: '21000000-0000-0000-0000-000000000001', Jazz: '21000000-0000-0000-0000-000000000002' };
    for (const [genre, itemValueId] of Object.entries(values)) await database.insert('ItemValues', { ItemValueId: itemValueId, CleanValue: genre.toLowerCase(), Type: 2, Value: genre });
    for (const itemId of [ids.source, ids.peer, ids.alternate, ids.owned, ids.extra]) await database.insert('ItemValuesMap', { ItemValueId: values.Rock, ItemId: itemId });
    await database.insert('ItemValuesMap', { ItemValueId: values.Jazz, ItemId: ids.other });
    const login = await runtime.authentication.login({ Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' },
      { Client: 'InstantMixTest', Device: 'Device', DeviceId: 'instant-mix', Version: '1.0' }, { remoteEndPoint: '127.0.0.1' });
    const messages = [];
    runtime.sessions.attachController(login.SessionInfo.Id, {
      isActive: () => true,
      supportsMediaControl: true,
      sendMessage: async (messageType, messageId, data) => messages.push({ messageType, messageId, data })
    });
    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.source], PlayCommand: 'PlayInstantMix' }, { controllingSessionId: login.SessionInfo.Id });
    assert.equal(messages[0].data.PlayCommand, 'PlayNow');
    assert.equal(messages[0].data.ItemIds[0], ids.source.replaceAll('-', ''));
    assert.deepEqual(messages[0].data.ItemIds.slice(1).toSorted(), [ids.peer, ids.extra].map(value => value.replaceAll('-', '')).toSorted());
  } finally { await runtime.close(); }
});

test('remote instant mix resolves MusicGenre by its stored identity and repository genre links', async () => {
  const { runtime, database } = await setup();
  try {
    const ids = {
      genre: '22000000-0000-0000-0000-000000000001', linked: '22000000-0000-0000-0000-000000000002', rawOnly: '22000000-0000-0000-0000-000000000003',
      rock: '22000000-0000-0000-0000-000000000011', jazz: '22000000-0000-0000-0000-000000000012'
    };
    await database.insert('BaseItems', { ...movie(), Id: ids.genre, Type: 'MediaBrowser.Controller.Entities.Audio.MusicGenre', Name: 'Display name', CleanName: 'rock',
      SortName: 'display name', Data: '{}', MediaType: 'Unknown', Path: null, IsFolder: false });
    for (const [id, name, genres] of [[ids.linked, 'Linked', 'Jazz'], [ids.rawOnly, 'Raw only', 'Rock']]) await database.insert('BaseItems', {
      ...movie(), Id: id, Type: 'MediaBrowser.Controller.Entities.Audio.Audio', Name: name, CleanName: name.toLowerCase(), SortName: name.toLowerCase(),
      Genres: genres, Data: '{}', MediaType: 'Audio', Path: `Z:\\Isolated\\${name}.flac`, IsFolder: false
    });
    await database.insert('ItemValues', { ItemValueId: ids.rock, CleanValue: 'rock', Type: 2, Value: 'Rock' });
    await database.insert('ItemValues', { ItemValueId: ids.jazz, CleanValue: 'jazz', Type: 2, Value: 'Jazz' });
    await database.insert('ItemValuesMap', { ItemValueId: ids.rock, ItemId: ids.linked });
    await database.insert('ItemValuesMap', { ItemValueId: ids.jazz, ItemId: ids.rawOnly });
    const { login, messages } = await controlledSession(runtime, 'music-genre-instant-mix');

    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.genre], PlayCommand: 'PlayInstantMix' }, { controllingSessionId: login.SessionInfo.Id });
    assert.equal(messages[0].data.PlayCommand, 'PlayNow');
    assert.deepEqual(messages[0].data.ItemIds, [ids.linked.replaceAll('-', '')]);
  } finally { await runtime.close(); }
});

test('remote instant mix includes linked children while deriving a regular folder genre set', async () => {
  const { runtime, database } = await setup({}, { metadata: true });
  try {
    const ids = {
      folder: '23000000-0000-0000-0000-000000000001', linked: '23000000-0000-0000-0000-000000000002', peer: '23000000-0000-0000-0000-000000000003',
      jazz: '23000000-0000-0000-0000-000000000004', rockValue: '23000000-0000-0000-0000-000000000011', jazzValue: '23000000-0000-0000-0000-000000000012'
    };
    await database.insert('BaseItems', { ...movie(), Id: ids.folder, Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Linked folder', CleanName: 'linked folder',
      SortName: 'linked folder', Data: '{}', MediaType: 'Unknown', Path: 'Z:\\Isolated\\Linked', IsFolder: true });
    for (const [id, name, genre] of [[ids.linked, 'Linked', 'Rock'], [ids.peer, 'Peer', 'Rock'], [ids.jazz, 'Jazz', 'Jazz']]) await database.insert('BaseItems', {
      ...movie(), Id: id, Type: 'MediaBrowser.Controller.Entities.Audio.Audio', Name: name, CleanName: name.toLowerCase(), SortName: name.toLowerCase(), Genres: genre,
      Data: '{}', MediaType: 'Audio', Path: `Z:\\Isolated\\${name}.flac`, IsFolder: false
    });
    await database.insert('LinkedChildren', { ParentId: ids.folder, SortOrder: 0, ChildId: ids.linked, ChildType: 1 });
    await database.insert('ItemValues', { ItemValueId: ids.rockValue, CleanValue: 'rock', Type: 2, Value: 'Rock' });
    await database.insert('ItemValues', { ItemValueId: ids.jazzValue, CleanValue: 'jazz', Type: 2, Value: 'Jazz' });
    for (const itemId of [ids.linked, ids.peer]) await database.insert('ItemValuesMap', { ItemValueId: ids.rockValue, ItemId: itemId });
    await database.insert('ItemValuesMap', { ItemValueId: ids.jazzValue, ItemId: ids.jazz });
    const { login, messages } = await controlledSession(runtime, 'linked-folder-instant-mix');

    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.folder], PlayCommand: 'PlayInstantMix' }, { controllingSessionId: login.SessionInfo.Id });
    assert.deepEqual(messages[0].data.ItemIds.toSorted(), [ids.linked, ids.peer].map(value => value.replaceAll('-', '')).toSorted());
  } finally { await runtime.close(); }
});

test('remote instant mix derives genres from visible audio in a parented music user view', async () => {
  const { runtime, database, user } = await setup({}, { metadata: true });
  try {
    const ids = {
      view: '32000000-0000-0000-0000-000000000001', collectionA: '32000000-0000-0000-0000-000000000002', physicalA: '32000000-0000-0000-0000-000000000003',
      collectionB: '32000000-0000-0000-0000-000000000004', physicalB: '32000000-0000-0000-0000-000000000005', source: '32000000-0000-0000-0000-000000000011',
      peer: '32000000-0000-0000-0000-000000000012', jazz: '32000000-0000-0000-0000-000000000013', hidden: '32000000-0000-0000-0000-000000000014'
    };
    const collection = (id, physical, name) => ({ ...movie(), Id: id, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: name,
      CleanName: name.toLowerCase(), SortName: name.toLowerCase(), Data: JSON.stringify({ CollectionType: 'music', PhysicalFolderIds: [physical] }), MediaType: 'Unknown', Path: null, IsFolder: true });
    const folder = (id, name) => ({ ...movie(), Id: id, Type: 'MediaBrowser.Controller.Entities.Folder', Name: name, CleanName: name.toLowerCase(), SortName: name.toLowerCase(),
      Data: '{}', MediaType: 'Unknown', Path: `Z:\\Isolated\\${name}`, IsFolder: true });
    await database.insert('BaseItems', collection(ids.collectionA, ids.physicalA, 'Music A'));
    await database.insert('BaseItems', collection(ids.collectionB, ids.physicalB, 'Music B'));
    await database.insert('BaseItems', folder(ids.physicalA, 'Music Physical A'));
    await database.insert('BaseItems', folder(ids.physicalB, 'Music Physical B'));
    for (const [id, name, genre, parent, tags] of [
      [ids.source, 'Source', 'Rock', ids.physicalA, ''], [ids.peer, 'Peer', 'Rock', ids.physicalB, ''],
      [ids.jazz, 'Jazz', 'Jazz', ids.physicalB, ''], [ids.hidden, 'Hidden', 'Rock', ids.physicalA, 'hidden']
    ]) await database.insert('BaseItems', {
      ...movie(), Id: id, Type: 'MediaBrowser.Controller.Entities.Audio.Audio', Name: name, CleanName: name.toLowerCase(), SortName: name.toLowerCase(), Genres: genre, Tags: tags,
      ParentId: parent, TopParentId: parent, PresentationUniqueKey: id.replaceAll('-', ''), Data: '{}', MediaType: 'Audio', Path: `Z:\\Isolated\\${name}.flac`, IsFolder: false
    });
    await database.insert('BaseItems', { ...movie(), Id: ids.view, Type: 'MediaBrowser.Controller.Entities.UserView', Name: 'Music', CleanName: 'music', SortName: 'music',
      Data: JSON.stringify({ ViewType: 'music', DisplayParentId: ids.collectionA }), MediaType: 'Unknown', Path: null, IsFolder: true });
    const values = { Rock: '32000000-0000-0000-0000-000000000021', Jazz: '32000000-0000-0000-0000-000000000022', hidden: '32000000-0000-0000-0000-000000000023' };
    for (const [name, itemValueId, type] of [['Rock', values.Rock, 2], ['Jazz', values.Jazz, 2], ['hidden', values.hidden, 4]]) {
      await database.insert('ItemValues', { ItemValueId: itemValueId, CleanValue: name.toLowerCase(), Type: type, Value: name });
    }
    for (const itemId of [ids.source, ids.peer, ids.hidden]) await database.insert('ItemValuesMap', { ItemValueId: values.Rock, ItemId: itemId });
    await database.insert('ItemValuesMap', { ItemValueId: values.Jazz, ItemId: ids.jazz });
    await database.insert('ItemValuesMap', { ItemValueId: values.hidden, ItemId: ids.hidden });
    await runtime.users.updatePolicy(user.Id, { ...(await runtime.users.getUser(user.Id)).Policy, BlockedTags: ['hidden'] });
    const { login, messages } = await controlledSession(runtime, 'user-view-instant-mix');

    await runtime.sessions.sendPlay(login.SessionInfo.Id, { ItemIds: [ids.view], PlayCommand: 'PlayInstantMix' }, { controllingSessionId: login.SessionInfo.Id });
    assert.equal(messages[0].data.PlayCommand, 'PlayNow');
    assert.deepEqual(messages[0].data.ItemIds.toSorted(), [ids.source, ids.peer].map(value => value.replaceAll('-', '')).toSorted());
  } finally { await runtime.close(); }
});

test('HTTP InstantMix sends source-first audio books over WebSocket and keeps failed views out of the command stream', async () => {
  const { runtime, database, origin } = await setup({}, { metadata: true });
  const ids = {
    book: 'ab220000-0000-0000-0000-000000000001',
    first: 'ab220000-0000-0000-0000-000000000002',
    second: 'ab220000-0000-0000-0000-000000000003',
    genre: 'ab220000-0000-0000-0000-000000000004',
    folder: 'ab220000-0000-0000-0000-000000000005',
    paper: 'ab220000-0000-0000-0000-000000000006',
    view: 'ab220000-0000-0000-0000-000000000007',
  };
  let socket;
  const observations = [];
  try {
    for (const [Id, Type] of [[ids.book, 'AudioBook'], [ids.first, 'Audio.Audio'], [ids.second, 'Audio.Audio']]) {
      await database.insert('BaseItems', { ...movie(), Id, Type: `MediaBrowser.Controller.Entities.${Type}`,
        Name: Id, CleanName: Id, SortName: Id, Genres: 'Rock', MediaType: 'Audio',
        Path: `Z:\\Isolated\\${Id}.flac` });
    }
    await database.insert('ItemValues', { ItemValueId: ids.genre, Type: 2, Value: 'Rock', CleanValue: 'rock' });
    for (const ItemId of [ids.book, ids.first, ids.second]) {
      await database.insert('ItemValuesMap', { ItemId, ItemValueId: ids.genre });
    }
    await database.insert('BaseItems', { ...movie(), Id: ids.folder, Type: 'MediaBrowser.Controller.Entities.Folder',
      IsFolder: true, MediaType: 'Unknown', Path: 'Z:\\Isolated\\Books' });
    await database.insert('BaseItems', { ...movie(), Id: ids.paper, Type: 'MediaBrowser.Controller.Entities.Book',
      ParentId: ids.folder, MediaType: 'Book', Path: 'Z:\\Isolated\\Books\\paper.epub' });
    await database.insert('AncestorIds', { ItemId: ids.paper, ParentItemId: ids.folder });
    await database.insert('BaseItems', { ...movie(), Id: ids.view, Type: 'MediaBrowser.Controller.Entities.UserView',
      IsFolder: true, MediaType: 'Unknown', Path: null,
      Data: JSON.stringify({ ViewType: 'books', DisplayParentId: ids.folder }) });
    const login = await runtime.authentication.login({ Username: 'CoreFlowAdmin', Pw: 'isolated-core-flow-password' },
      { Client: 'InstantMixWire', Device: 'Device', DeviceId: 'instant-mix-wire', Version: '1' }, { remoteEndPoint: '127.0.0.1' });
    await runtime.sessions.reportCapabilities(login.SessionInfo.Id, {
      SupportsMediaControl: true, PlayableMediaTypes: ['Audio'], SupportedCommands: [],
    });
    const headers = { Authorization: `MediaBrowser Client="InstantMixWire", Device="Device", DeviceId="instant-mix-wire", Version="1", Token="${login.AccessToken}"` };
    const messages = [];
    socket = new WebSocket(origin.replace('http', 'ws') + `/socket?ApiKey=${login.AccessToken}`);
    socket.on('message', bytes => messages.push(parseLosslessJson(bytes.toString())));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const next = async type => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const index = messages.findIndex(message => message.MessageType === type);
        if (index >= 0) return messages.splice(index, 1)[0];
        await delay(20);
      }
      throw new Error(`Missing ${type} WebSocket message.`);
    };
    await next('ForceKeepAlive');
    socket.send('{"MessageType":"KeepAlive"}');
    await next('KeepAlive');
    const send = async itemIds => {
      const response = await fetch(`${origin}/Sessions/${login.SessionInfo.Id}/Playing?itemIds=${itemIds.join(',')}`
        + '&playCommand=PlayInstantMix&startPositionTicks=9007199254740993&audioStreamIndex=2&startIndex=0',
      { method: 'POST', headers });
      const observation = { itemIds, status: response.status, body: await response.text() };
      observations.push(observation);
      return observation;
    };
    for (const requested of [[ids.book], [ids.book, ids.book]]) {
      assert.equal((await send(requested)).status, 204);
      const message = await next('Play');
      assert.match(message.MessageId, /^[0-9a-f]{32}$/u);
      assert.equal(message.Data.PlayCommand, 'PlayNow');
      assert.equal(message.Data.StartPositionTicks, 9007199254740993n);
      assert.equal(message.Data.AudioStreamIndex, 2);
      assert.equal(message.Data.StartIndex, 0);
      assert.equal(message.Data.ControllingUserId, login.User.Id);
      assert.equal(message.Data.ItemIds.length, requested.length * 3);
      for (let offset = 0; offset < message.Data.ItemIds.length; offset += 3) {
        const mix = message.Data.ItemIds.slice(offset, offset + 3);
        assert.equal(mix[0], ids.book.replaceAll('-', ''));
        assert.deepEqual(mix.slice(1).toSorted(), [ids.first, ids.second].map(value => value.replaceAll('-', '')).toSorted());
      }
      observations.at(-1).message = message;
    }
    assert.deepEqual(await send([ids.view]), { itemIds: [ids.view], status: 500, body: 'Error processing request.' });
    await delay(50);
    assert.ok(!messages.some(message => message.MessageType === 'Play'));
    assert.equal((await send([ids.book])).status, 204);
    observations.at(-1).message = await next('Play');
    assert.equal(observations.at(-1).message.Data.ItemIds[0], ids.book.replaceAll('-', ''));
    if (process.env.MEDIAMANAGER_INSTANT_MIX_EVIDENCE) {
      const output = path.resolve(process.env.MEDIAMANAGER_INSTANT_MIX_EVIDENCE);
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'wire.json'), stringifyNativeJson({ observations,
        candidateHttpWebSocket: true, nativeHttpVerified: false, genreLifecycleVerified: false, phaseAcceptance: false }) + '\n', { flag: 'wx' });
    }
  } finally { socket?.terminate(); await runtime.close(); }
});

test('WebSocket authorization, cross-user control, subscription visibility and handshake cultures remain isolated', async () => {
  const { runtime, origin, user } = await setup();
  const sockets = [];
  try {
    const second = await runtime.users.createUser({ Name: 'Second', Password: 'password' });
    const login = async (name, password, device) => runtime.authentication.login({ Username: name, Pw: password }, { Client: 'SocketTest', Device: 'Device', DeviceId: device, Version: '1.0' }, { remoteEndPoint: '127.0.0.1' });
    const first = await login('CoreFlowAdmin', 'isolated-core-flow-password', 'first');
    const other = await login('Second', 'password', 'second');
    const responseCode = url => new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.on('unexpected-response', (_, response) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
      socket.on('error', () => {});
      socket.on('open', () => { socket.terminate(); reject(new Error('Unauthenticated upgrade succeeded.')); });
    });
    assert.equal(await responseCode(origin.replace('http', 'ws') + '/socket'), 403);
    assert.equal(await responseCode(origin.replace('http', 'ws') + '/socket?ApiKey=invalid'), 403);
    assert.equal(await responseCode(origin.replace('http', 'ws') + '/socket?api_key=invalid'), 403);
    const connected = async (token, language, tokenParameter = 'ApiKey') => {
      const ws = new WebSocket(origin.replace('http', 'ws') + `/socket?${tokenParameter}=${token}`, { headers: { 'Accept-Language': language } });
      sockets.push(ws);
      const messages = [];
      ws.on('message', bytes => messages.push(parseLosslessJson(bytes.toString())));
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      for (let count = 0; count < 50 && !messages.length; count++) await delay(10);
      ws.send('{"MessageType":"SessionsStart","Data":"0,10000"}');
      return { ws, messages };
    };
    const english = await connected(first.AccessToken, 'en-US');
    const chinese = await connected(other.AccessToken, 'zh-CN', 'api_key');
    await delay(30);
    const observed = [];
    const getSessions = runtime.sessions.getSessions.bind(runtime.sessions);
    runtime.sessions.getSessions = async auth => { observed.push([auth.UserId, runtime.localization.context.uiCulture]); return getSessions(auth); };
    await runtime.sessions.reportCapabilities(other.SessionInfo.Id, { SupportsMediaControl: true });
    for (let count = 0; count < 50 && !chinese.messages.some(entry => entry.MessageType === 'Sessions'); count++) await delay(10);
    assert.deepEqual(new Set(observed.map(([id, language]) => `${id}:${language}`)), new Set([`${user.Id}:en-US`, `${second.Id}:zh-CN`]));
    assert.equal(chinese.messages.find(entry => entry.MessageType === 'Sessions').Data.length, 1);
    assert.equal(english.messages.find(entry => entry.MessageType === 'Sessions').Data.length, 2);
    await assert.rejects(runtime.sessions.sendPlaystate(first.SessionInfo.Id, { Command: 'Pause' }, { controllingSessionId: other.SessionInfo.Id }), { status: 403 });
    await runtime.users.updatePolicy(second.Id, { ...(await runtime.users.getUser(second.Id)).Policy, EnableRemoteControlOfOtherUsers: true });
    await runtime.sessions.sendPlaystate(first.SessionInfo.Id, { Command: 'Pause' }, { controllingSessionId: other.SessionInfo.Id });
    for (let count = 0; count < 50 && !english.messages.some(entry => entry.MessageType === 'Playstate'); count++) await delay(10);
    assert.equal(english.messages.find(entry => entry.MessageType === 'Playstate').Data.ControllingUserId, second.Id);
    await runtime.authentication.logout(other.AccessToken);
    for (let count = 0; count < 50 && chinese.ws.readyState !== WebSocket.CLOSED; count++) await delay(10);
    assert.equal(chinese.ws.readyState, WebSocket.CLOSED);
    assert.throws(() => runtime.sessions.getSession(other.SessionInfo.Id), { status: 404 });
  } finally { for (const socket of sockets) socket.terminate(); await runtime.close(); }
});
