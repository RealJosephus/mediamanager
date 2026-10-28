import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { createTestRuntime } from '../helpers/runtime.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

// Transport shapes are taken from the designated Jellyfin client and the
// official Emby Web 26.0.37 ApiClient/ConnectionManager. This is an HTTP consumer,
// not a claim that the complete Emby UI has run.
for (const baseUrl of ['', '/media']) test(`Jellyfin and Emby auth/info coexist with the native legacy switch disabled at ${baseUrl || '/'}`, {
  skip: !postgresTestConnectionString, timeout: 60000,
}, async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mediamanager-client-auth-')));
  const configuration = { IsStartupWizardCompleted: false, EnableLegacyAuthorization: false,
    ServerName: 'Jellyfin and Emby library', UICulture: 'en-US' };
  const errors = [], secrets = new Set([process.env.MEDIAMANAGER_TEST_POSTGRES]);
  let database, runtime, socket;
  t.after(async () => {
    const failures = [];
    for (const action of [async () => {
      if (socket && socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, 'close'); socket.terminate(); await closed; }
    }, () => runtime?.close(), () => dropPostgresTestDatabase(database), async () => {
      assert.equal(path.dirname(directory), await realpath(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('mediamanager-client-auth-'));
      await rm(directory, { recursive: true, force: true });
    }]) try { await action(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Client authentication cleanup failed.');
  });
  try {
    await mkdir(path.join(directory, 'config'));
    await writeFile(path.join(directory, 'config/system.xml'), '<ServerConfiguration><IsStartupWizardCompleted>false</IsStartupWizardCompleted><EnableLegacyAuthorization>false</EnableLegacyAuthorization></ServerConfiguration>');
    database = await createPostgresTestDatabase(null, 'client_auth_info');
    runtime = await createTestRuntime({ database, configuration, networkConfiguration: { BaseUrl: baseUrl, EnablePublishedServerUriByRequest: true }, programDataPath: path.join(directory, 'data'),
      configurationDirectoryPath: path.join(directory, 'config'), serverId: randomUUID().replaceAll('-', ''),
      onError: error => errors.push({ message: error.message, status: error.status }) });
    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
    const request = async (route, { method = 'GET', headers = {}, body } = {}) => {
      const response = await fetch(`${origin}${baseUrl}${route}`, { method, headers, body });
      const text = await response.text();
      return { status: response.status, type: response.headers.get('content-type'), text,
        body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
    };
    const jellyfin = token => ({ Authorization: `MediaBrowser Client="Jellyfin Web", Device="Browser", DeviceId="jellyfin-device", Version="13.0.0"${token ? `, Token="${token}"` : ''}` });
    assert.equal((await request('/Startup/User')).status, 200);
    const password = randomUUID(); secrets.add(password);
    const username = 'Dual client reader';
    const user = await runtime.users.createUser({ Name: username, Password: password });
    const login = await request('/Users/AuthenticateByName', { method: 'POST', headers: {
      ...jellyfin(), 'Content-Type': 'application/json', Accept: 'application/json',
    }, body: JSON.stringify({ Username: username, Pw: password }) });
    assert.equal(login.status, 200);
    assert.equal(login.body.User.Policy.IsAdministrator, false);
    secrets.add(login.body.AccessToken);
    assert.equal((await request('/Startup/Complete', { method: 'POST' })).status, 204);
    assert.equal(configuration.EnableLegacyAuthorization, false);
    const fields = new URLSearchParams({ 'X-Emby-Client': 'Emby Web', 'X-Emby-Device-Name': 'Browser / desktop',
      'X-Emby-Device-Id': 'emby-device', 'X-Emby-Client-Version': '26.0.37', 'X-Emby-Language': 'en-US' });
    const embyLogin = await request(`/emby/Users/authenticatebyname?${fields}`, { method: 'POST', headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json',
    }, body: new URLSearchParams({ Username: username, Pw: password }).toString() });
    assert.equal(embyLogin.status, 200);
    secrets.add(embyLogin.body.AccessToken);
    assert.equal(embyLogin.body.User.Id, login.body.User.Id);
    fields.set('X-Emby-Token', embyLogin.body.AccessToken);
    const nativeInfo = await request('/System/Info', { headers: jellyfin(login.body.AccessToken) });
    const embyInfo = await request(`/emby/System/Info?${fields}`);
    assert.equal(nativeInfo.status, 200); assert.equal(embyInfo.status, 200);
    assert.equal(nativeInfo.body.Version, '13.0.0');
    assert.deepEqual(embyInfo.body, { ...nativeInfo.body, Version: '4.9.5.0' });
    assert.equal(embyInfo.body.ServerName, configuration.ServerName);
    assert.equal(embyInfo.body.ProductName, 'MediaManager');
    assert.equal(embyInfo.body.LocalAddress, `${origin}${baseUrl}`);
    for (const prefix of ['', '/emby', '/mediabrowser', '/EMBY']) {
      const publicInfo = await request(`${prefix}/System/Info/Public`);
      assert.equal(publicInfo.status, 200);
      assert.equal(publicInfo.body.Id, runtime.serverId);
      assert.equal(publicInfo.body.ServerName, configuration.ServerName);
      assert.equal(publicInfo.body.Version, prefix ? '4.9.5.0' : '13.0.0');
      assert.equal((await request(`${prefix}/System/Info/Public`, { headers: jellyfin() })).body.Version, '13.0.0');
      const anonymous = await request(`${prefix}/System/Info`, { headers: { Accept: 'application/json' } });
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.text, prefix ? 'Access token is invalid or expired.' : '');
      if (prefix) assert.match(anonymous.type, /^text\/plain/u);
      assert.equal((await request(`${prefix}/System/Info?api_key=${encodeURIComponent(embyLogin.body.AccessToken)}`)).status, 200);
      assert.equal((await request(`${prefix}/System/Info?X-Emby-Token=invalid-client-token`)).status, 401);
      const header = { 'X-Emby-Authorization': `Emby Client="Emby Web", Device="Browser", DeviceId="emby-device", Version="26.0.37", Token="${embyLogin.body.AccessToken}"` };
      const headerInfo = await request(`${prefix}/System/Info`, { headers: header });
      assert.equal(headerInfo.status, 200);
      assert.equal(headerInfo.body.Version, '4.9.5.0');
      for (const asset of ['manifest.json', 'index.html', 'strings/en-US.json']) {
        const resource = await request(`${prefix}/web/${asset}`);
        assert.equal(resource.status, 200);
        assert.ok(resource.text.includes('MediaManager'));
        assert.equal(resource.text.toLowerCase().includes('jellyfin'), false);
        assert.equal((await request(`${prefix}/web/${asset}`, { method: 'HEAD' })).text, '');
        if (asset === 'manifest.json') assert.equal(new URL(resource.body.start_url,
          `${origin}${baseUrl}${prefix}/web/manifest.json`).pathname, `${baseUrl}${prefix}/web/index.html`);
      }
    }
    assert.equal((await request('/System/Info/Public?X-Emby-Client=Emby%20Web')).body.Version, '4.9.5.0');
    assert.equal((await request('/System/Info/Public', { headers: { 'X-Emby-Client': 'Emby Web' } })).body.Version, '4.9.5.0');
    assert.equal((await request(`/System/Info?api_key=${encodeURIComponent(embyLogin.body.AccessToken)}`)).body.Version, '4.9.5.0');
    assert.equal((await request(`/emby/System/Info?${fields}`, { headers: jellyfin(login.body.AccessToken) })).body.Version, '13.0.0');
    assert.equal((await request('/emby/System/Info?X-Emby-Token=invalid-query-token', {
      headers: jellyfin(login.body.AccessToken),
    })).status, 200, 'An explicit valid Jellyfin token retains precedence.');
    const invalidJellyfin = await request(`/emby/System/Info?${fields}`, { headers: jellyfin('invalid-header-token') });
    assert.equal(invalidJellyfin.status, 401); assert.equal(invalidJellyfin.text, '');
    const capabilitiesUrl = `/emby/Sessions/Capabilities/Full?${fields}`;
    const commands = ['RefreshMediaSource', 'TriggerTranscodingFallback', 'SetSubtitleOffset', 'SetPlaybackRate', 'PluginAction'];
    const capabilities = JSON.stringify({ PlayableMediaTypes: ['Audio', 'Video'], SupportedCommands: commands, SupportsMediaControl: true });
    const plain = { 'Content-Type': 'text/plain; charset=UTF-8' };
    assert.equal((await request(capabilitiesUrl, { method: 'POST', headers: plain, body: capabilities })).status, 415);
    assert.equal((await request(capabilitiesUrl + '&reqformat=json', { method: 'POST', headers: plain, body: capabilities })).status, 204);
    assert.equal((await request(capabilitiesUrl + '&reqformat=xml', { method: 'POST', headers: plain, body: capabilities })).status, 415);
    assert.equal((await request(capabilitiesUrl + '&reqformat=json', { method: 'POST', headers: {
      ...plain, ...jellyfin(login.body.AccessToken),
    }, body: capabilities })).status, 415, 'An explicit Jellyfin client retains its native media type contract.');
    assert.equal((await request(capabilitiesUrl + '&reqformat=json', { method: 'POST', headers: plain, body: '{' })).status, 400);
    assert.equal((await request(capabilitiesUrl + '&reqformat=json', { method: 'POST', headers: plain,
      body: JSON.stringify({ SupportsMediaControl: 'invalid' }) })).status, 400, 'Emby representation selection preserves typed model validation.');
    const sessionList = await request(`/emby/Sessions?${fields}`);
    assert.equal(sessionList.status, 200);
    const session = sessionList.body.find(session => session.Id === embyLogin.body.SessionInfo.Id);
    assert.deepEqual(session.SupportedCommands, commands);
    const rejected = await request('/Sessions/Capabilities/Full', { method: 'POST', headers: {
      ...jellyfin(login.body.AccessToken), 'Content-Type': 'application/json',
    }, body: capabilities });
    assert.equal(rejected.status, 400, 'The native Jellyfin enum contract remains closed.');
    assert.equal((await request(`/Sessions/${login.body.SessionInfo.Id}/Command`, { method: 'POST', headers: {
      ...jellyfin(login.body.AccessToken), 'Content-Type': 'application/json',
    }, body: JSON.stringify({ Name: 'PluginAction', Arguments: {} }) })).status, 400);
    for (const action of ['Items?Recursive=true', 'Items/Resume?MediaTypes=Video',
      ...['true', 'false', 'invalid'].map(value => `Items/Resume?MediaTypes=Video&Recursive=${value}`)]) {
      const response = await request(`/emby/Users/${user.Id}/${action}&${fields}`);
      const nativeResponse = await request(`/Users/${user.Id}/${action}`, { headers: jellyfin(login.body.AccessToken) });
      assert.equal(response.status, 200, 'Client authentication metadata must not become an item filter.');
      assert.equal(nativeResponse.status, 200);
      const expected = { ...nativeResponse.body };
      if (action.startsWith('Items?')) delete expected.StartIndex;
      assert.deepEqual(response.body, expected);
    }
    for (const action of ['Items?Recursive=true', 'Items/Resume?MediaTypes=Video']) {
      const bound = await request(`/Users/${user.Id}/${action}&Fields=Path`, { headers: jellyfin(login.body.AccessToken) });
      assert.equal(bound.status, 200);
      for (const headers of [jellyfin(login.body.AccessToken), { 'X-Emby-Token': embyLogin.body.AccessToken, 'X-Emby-Client': 'Emby Web' }]) {
        const unbound = await request(`/Users/${user.Id}/${action}&Fields=BasicSyncInfo,Path,UnknownClientField`, { headers });
        assert.equal(unbound.status, 200);
        const expected = { ...bound.body };
        if (action.startsWith('Items?') && headers['X-Emby-Client']) delete expected.StartIndex;
        assert.deepEqual(unbound.body, expected, 'Unknown enum fields do not hide a valid requested field.');
      }
    }
    const devices = await runtime.store.run(db => db.rows('Devices', { where: { UserId: nativeGuid(user.Id) } }));
    assert.equal(devices.length, 2);
    const emby = devices.find(device => device.DeviceId === 'emby-device');
    assert.equal(emby.AppName, 'Emby Web'); assert.equal(emby.AppVersion, '26.0.37');
    assert.equal(emby.DeviceName, 'Browser / desktop');
    assert.ok(devices.some(device => device.DeviceId === 'jellyfin-device' && device.AppName === 'Jellyfin Web'));
    const received = [];
    socket = new WebSocket(`${origin.replace(/^http/u, 'ws')}${baseUrl}/emby?api_key=${encodeURIComponent(embyLogin.body.AccessToken)}&deviceId=emby-device`);
    socket.on('message', data => received.push(JSON.parse(String(data))));
    await once(socket, 'open');
    const readyDeadline = Date.now() + 10000;
    while (!received.some(message => message.MessageType === 'ForceKeepAlive')) {
      assert.ok(Date.now() < readyDeadline, 'The socket must finish authenticated session registration.');
      await delay(10);
    }
    for (const name of ['SetSubtitleOffset', 'PluginAction']) {
      const response = await request(`/emby/Sessions/${session.Id}/Command?${fields}&reqformat=json`, {
        method: 'POST', headers: plain, body: JSON.stringify({ Name: name, Arguments: { Offset: '1.25' } }),
      });
      assert.equal(response.status, 204);
      const deadline = Date.now() + 10000;
      let observation;
      while (!(observation = received.find(message => message.MessageType === 'GeneralCommand' && message.Data.Name === name))) {
        assert.ok(Date.now() < deadline, 'The real socket must receive the unchanged Emby command.');
        await delay(10);
      }
      const message = observation.Data;
      assert.equal(message.Name, name); assert.deepEqual(message.Arguments, { Offset: '1.25' });
    }
    assert.ok(received.some(message => message.MessageType === 'ForceKeepAlive'));
  } catch (error) {
    let message = error.message;
    for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[credential redacted]');
    throw new Error(message);
  }
});
