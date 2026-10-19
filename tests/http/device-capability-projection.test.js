import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { createRuntime } from '../../src/runtime.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';

const defaultDeviceCapabilities = {
  PlayableMediaTypes: [],
  SupportedCommands: [],
  SupportsMediaControl: false,
  SupportsPersistentIdentifier: true
};

async function dropPostgresSchema(connectionString, schema) {
  const cleanup = await PostgresDatabase.open({ connectionString, schema });
  try {
    await cleanup.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await cleanup.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
  } finally {
    await cleanup.close();
  }
}

test('PostgreSQL: reported capability icon is the only capability projected by Devices endpoints', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async () => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `device_cap_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  let runtime;
  try {
    runtime = await createRuntime({
      database,
      configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
      serverId: 'device-capability-projection-test'
    });
    runtime.sessions.automaticProgress = false;
    runtime.authentication.now = () => new Date('2026-09-27T12:00:00.000Z');

    const user = await runtime.users.createUser({ Name: 'CapabilityAdmin', Password: 'admin-password' });
    await runtime.users.updatePolicy(user.Id, { ...(await runtime.users.getUser(user.Id)).Policy, IsAdministrator: true });
    const login = await runtime.authentication.login({ Username: 'CapabilityAdmin', Pw: 'admin-password' }, {
      Client: 'CapabilityProjectionTest', Device: 'Projection Device', DeviceId: 'capability-projection-device', Version: '1'
    }, { remoteEndPoint: '127.0.0.1' });

    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const authorization = `MediaBrowser Client="CapabilityProjectionTest", Device="Projection Device", DeviceId="capability-projection-device", Version="1", Token="${login.AccessToken}"`;
    async function call(route, { method = 'GET', body } = {}) {
      const response = await fetch(origin + route, {
        method,
        headers: { Authorization: authorization, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: stringifyNativeJson(body, { camel: true }) })
      });
      const text = await response.text();
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        body: text && response.headers.get('content-type')?.includes('json') ? parseLosslessJson(text) : text
      };
    }

    const baselineInfo = await call('/Devices/Info?id=capability-projection-device');
    const baselineList = await call('/Devices');
    assert.equal(baselineInfo.status, 200);
    assert.equal(baselineList.status, 200);
    assert.deepEqual(baselineInfo.body.Capabilities, defaultDeviceCapabilities);
    assert.deepEqual(baselineList.body.Items[0].Capabilities, defaultDeviceCapabilities);
    assert.equal(Object.hasOwn(baselineInfo.body, 'IconUrl'), false);
    assert.equal(Object.hasOwn(baselineList.body.Items[0], 'IconUrl'), false);

    const persistedBefore = {
      Devices: structuredClone(await database.rows('Devices')),
      DeviceOptions: structuredClone(await database.rows('DeviceOptions'))
    };
    const iconUrl = 'https://client.invalid/icons/projection-device.png';
    const fullCapabilities = {
      playableMediaTypes: ['Video', 'Audio'],
      supportedCommands: ['SetVolume', 'PlayMediaSource'],
      supportsMediaControl: true,
      supportsPersistentIdentifier: false,
      appStoreUrl: 'https://client.invalid/store',
      iconUrl,
      deviceProfile: {
        name: 'Projection profile',
        maxStreamingBitrate: 1234567,
        directPlayProfiles: [{ container: 'mkv', type: 'Video' }]
      }
    };
    assert.equal((await call('/Sessions/Capabilities/Full', { method: 'POST', body: fullCapabilities })).status, 204);
    const reported = runtime.sessions.getDeviceCapabilities('capability-projection-device');
    assert.equal(reported.IconUrl, iconUrl);
    assert.equal(reported.AppStoreUrl, 'https://client.invalid/store');
    assert.equal(reported.DeviceProfile.Name, 'Projection profile');

    // Pinned native source contract (HTTP recording is intentionally left to the native recorder):
    // SessionManager.ReportCapabilities saves by DeviceId; DeviceManager.ToDeviceInfo copies only
    // ClientCapabilities.IconUrl to DeviceInfo.IconUrl, while DeviceInfo.Capabilities stays at its
    // constructor default. Therefore the full report changes only the top-level Devices IconUrl.
    const projectedInfo = await call('/Devices/Info?id=capability-projection-device');
    const projectedList = await call('/Devices');
    assert.deepEqual(projectedInfo, {
      ...baselineInfo,
      body: { ...baselineInfo.body, IconUrl: iconUrl }
    });
    assert.deepEqual(projectedList, {
      ...baselineList,
      body: { ...baselineList.body, Items: [{ ...baselineList.body.Items[0], IconUrl: iconUrl }] }
    });
    assert.deepEqual(projectedInfo.body.Capabilities, defaultDeviceCapabilities);
    assert.deepEqual(projectedList.body.Items[0].Capabilities, defaultDeviceCapabilities);

    assert.equal((await call('/Sessions/Capabilities?playableMediaTypes=Book&supportedCommands=Play&supportsMediaControl=true&supportsPersistentIdentifier=false', {
      method: 'POST'
    })).status, 204);
    assert.equal(runtime.sessions.getDeviceCapabilities('capability-projection-device').IconUrl, null);
    assert.deepEqual(await call('/Devices/Info?id=capability-projection-device'), baselineInfo);
    assert.deepEqual(await call('/Devices'), baselineList);

    assert.deepEqual({
      Devices: await database.rows('Devices'),
      DeviceOptions: await database.rows('DeviceOptions')
    }, persistedBefore, 'capability reports and device projections must not write Devices or DeviceOptions');
  } finally {
    if (runtime) await runtime.close();
    else await database.close();
    await dropPostgresSchema(connectionString, schema);
  }
});
