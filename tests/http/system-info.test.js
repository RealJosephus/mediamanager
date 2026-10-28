import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestRuntime } from '../helpers/runtime.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { writeConfigurationFile } from '../../src/core/configuration-file.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

test('System Info supports real client reconnection and native setup/parental-control authorization',
  { skip: !postgresTestConnectionString }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-system-info-'));
    const configuration = { IsStartupWizardCompleted: false, ServerName: 'System information',
      UICulture: 'en-US', CastReceiverApplications: [] };
    const programDataPath = path.join(root, 'program'), metadataPath = path.join(root, 'metadata');
    configuration.MetadataPath = metadataPath;
    const hlsPath = path.join(root, 'hls'), errors = [];
    let database, runtime;
    t.after(async () => {
      const failures = [];
      for (const operation of [() => runtime?.close(), () => dropPostgresTestDatabase(database), async () => {
        assert.equal(path.dirname(root), tmpdir());
        assert.ok(path.basename(root).startsWith('mediamanager-system-info-'));
        await rm(root, { recursive: true, force: true });
      }]) { try { await operation(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, 'System Info cleanup failed.');
    });
    await mkdir(path.join(root, 'config'));
    await writeFile(path.join(root, 'config/system.xml'), '<ServerConfiguration><IsStartupWizardCompleted>false</IsStartupWizardCompleted></ServerConfiguration>');
    await writeConfigurationFile(path.join(root, 'config/encoding.xml'), 'encoding',
      { ...defaultConfiguration('encoding'), TranscodingTempPath: hlsPath });
    database = await createPostgresTestDatabase(null, 'system_info');
    runtime = await createTestRuntime({ database, configuration, networkConfiguration: { BaseUrl: '/media', EnablePublishedServerUriByRequest: true }, programDataPath, metadataPath,
      configurationDirectoryPath: path.join(root, 'config'),
      serverId: 'e5500000000000000000000000000001', onError: error => errors.push(error) });

    const port = runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port, origin = `http://127.0.0.1:${port}`;
    async function request(route, { method = 'GET', token, body } = {}) {
      const response = await fetch(`${origin}/media${route}`, { method, headers: {
        Authorization: `MediaBrowser Client="System Info test", Device="Browser", DeviceId="system-info-device", Version="1.0"${token ? `, Token="${token}"` : ''}`,
        Accept: 'application/json', ...(body !== undefined && { 'Content-Type': 'application/json' })
      }, ...(body !== undefined && { body: JSON.stringify(body) }) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : undefined };
    }

    const initial = await request('/System/Info');
    assert.equal(initial.status, 200, 'Setup permits anonymous system information.');
    const info = initial.body;
    assert.equal(info.Id, runtime.serverId);
    assert.equal(info.ServerName, configuration.ServerName);
    assert.equal(info.ProductName, 'MediaManager');
    assert.equal(info.Version, runtime.serverVersion);
    assert.equal(info.LocalAddress, origin + '/media');
    assert.equal(info.WebSocketPortNumber, 0, 'System Info exposes the captured configured HTTP port.');
    assert.equal(info.StartupWizardCompleted, false);
    assert.equal(info.ProgramDataPath, programDataPath);
    assert.equal(info.ItemsByNamePath, metadataPath);
    assert.equal(info.InternalMetadataPath, metadataPath);
    assert.equal(info.CachePath, path.join(programDataPath, 'cache'));
    assert.equal(info.TranscodingTempPath, hlsPath);
    assert.equal(info.SupportsLibraryMonitor, true);
    assert.equal(info.HasPendingRestart, false);
    assert.equal(info.IsShuttingDown, false);
    assert.deepEqual(info.CompletedInstallations, []);
    assert.deepEqual(info.CastReceiverApplications, []);
    assert.equal(info.WebPath, undefined);
    assert.equal(info.LogPath, path.join(root, 'log'));
    assert.deepEqual((await request('/System/Info/Public')).body, Object.fromEntries(
      ['LocalAddress', 'ServerName', 'Version', 'ProductName', 'Id', 'StartupWizardCompleted'].map(key => [key, info[key]])));

    // Keep a real administrator so disabling the ordinary user remains a valid
    // user-management operation. The browser signs in as the ordinary user.
    assert.equal((await request('/Startup/User')).status, 200);
    const reader = await runtime.users.createUser({ Name: 'Reader', Password: 'Reader password' });
    const login = await request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'Reader', Pw: 'Reader password' } });
    assert.equal(login.status, 200);
    assert.equal(login.body.User.Policy.IsAdministrator, false);
    const token = login.body.AccessToken;
    assert.equal((await request('/Startup/Complete', { method: 'POST' })).status, 204);
    assert.equal((await request('/System/Info')).status, 401);
    assert.equal((await request('/System/Info', { token: 'invalid-token' })).status, 401);
    let user = await runtime.users.getUser(reader.Id);
    await runtime.users.updatePolicy(user.Id, { ...user.Policy,
      AccessSchedules: [{ DayOfWeek: 'Everyday', StartHour: 25, EndHour: 26 }] });
    assert.equal((await request('/UserViews', { token })).status, 403, 'The ordinary user is outside its access schedule.');
    const reconnected = await request('/System/Info', { token });
    assert.equal(reconnected.status, 200, 'The native policy permits validating a session outside its parental-control schedule.');
    assert.equal(reconnected.body.Id, info.Id);
    assert.equal(reconnected.body.StartupWizardCompleted, true);
    configuration.CastReceiverApplications.push({ Id: 'test-receiver', Name: 'Configured receiver' });
    const apiKey = await runtime.apiKeys.create('System Info API');
    assert.deepEqual((await request('/System/Info', { token: apiKey.AccessToken })).body.CastReceiverApplications,
      configuration.CastReceiverApplications);
    user = await runtime.users.getUser(reader.Id);
    await runtime.users.updatePolicy(user.Id, { ...user.Policy, IsDisabled: true }, { currentToken: token });
    assert.equal((await request('/System/Info', { token })).status, 401, 'Ignoring the schedule does not admit a disabled user.');
  });
