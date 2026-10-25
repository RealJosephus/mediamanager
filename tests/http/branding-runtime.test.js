import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createRuntime } from '../../src/runtime.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { BrandingService } from '../../src/branding/service.js';
import { BrandingConfigurationStore } from '../../src/branding/configuration.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const source = new URL('../images/fixtures/splashscreen/assets/portrait.png', import.meta.url);
async function setup(t, { network = false, configurationXml = '<BrandingOptions><SplashscreenEnabled>true</SplashscreenEnabled><CustomCss>body { color: red; }</CustomCss></BrandingOptions>' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branding-runtime-')), programDataPath = path.join(root, 'program'), dataPath = path.join(programDataPath, 'data'), configurationDirectoryPath = path.join(root, 'config');
  await mkdir(dataPath, { recursive: true }); await mkdir(configurationDirectoryPath);
  await writeFile(path.join(configurationDirectoryPath, 'branding.xml'), configurationXml);
  let database = await createPostgresTestDatabase(null, 'branding_runtime'), runtime, registry;
  let vfs, identityMap;
  if (network) {
    registry = new StorageRegistry(); registry.registerType('memory', () => new MemoryStorageAdapter());
    await registry.createInstance('branding', 'memory', {});
    vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/branding', instanceId: 'branding', capabilities: { create: true, replace: true, delete: true } });
    identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\Branding', accessRoot: '/branding', style: 'windows', returnAccess: 'Isolated branding image assets.' });
  }
  const create = () => createTestRuntime({ database, programDataPath, dataPath, configurationDirectoryPath, vfs, identityMap,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: 'branding-runtime' });
  t.after(async () => {
    try { await runtime?.close(); } finally {
      try { await dropPostgresTestDatabase(database); } finally {
        await registry?.close(); assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('branding-runtime-'));
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  runtime = await create();
  const getOrigin = () => `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
  const admin = await runtime.users.createUser({ Name: 'Branding admin', Password: 'Isolated password' });
  await runtime.users.updatePolicy(admin.Id, { ...(await runtime.users.getUser(admin.Id)).Policy, IsAdministrator: true });
  const login = await runtime.authentication.login({ Username: 'Branding admin', Pw: 'Isolated password' },
    { Client: 'Branding tests', DeviceId: 'branding-tests', Device: 'Isolated', Version: '1' }, { remoteEndPoint: '127.0.0.1' });
  return { root, programDataPath, dataPath, configurationDirectoryPath, vfs, getOrigin,
    get runtime() { return runtime; }, headers: { Authorization: `MediaBrowser Token="${login.AccessToken}"` },
    async reopen() {
      const schema = database.schemaName; await runtime.close();
      database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); runtime = await create();
      return getOrigin();
    } };
}

test('postgres: branding uses real admin authentication, instance images, configuration saves and restart recovery', { skip: !postgresTestConnectionString }, async t => {
  const state = await setup(t), origin = state.getOrigin(), bytes = await readFile(source);
  await writeFile(path.join(state.dataPath, 'splashscreen.png'), bytes);
  assert.equal(await (await fetch(origin + '/Branding/Css')).text(), 'body { color: red; }');
  assert.deepEqual(Buffer.from(await (await fetch(origin + '/Branding/Splashscreen')).arrayBuffer()), bytes);
  const anonymous = await fetch(origin + '/Branding/Splashscreen', { method: 'POST', body: bytes.toString('base64'), headers: { 'Content-Type': 'image/png' } });
  assert.equal(anonymous.status, 401);
  const upload = await fetch(origin + '/Branding/Splashscreen', { method: 'POST', body: bytes.toString('base64'), headers: { ...state.headers, 'Content-Type': 'image/png' } });
  assert.equal(upload.status, 204); assert.deepEqual(await readFile(path.join(state.dataPath, 'splashscreen-upload.png')), bytes);
  const custom = state.runtime.branding.getOptions({ includeLocation: true }).SplashscreenLocation;
  const update = await fetch(origin + '/System/Configuration/Branding', { method: 'POST', headers: { ...state.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ LoginDisclaimer: 'A <b>café 中文</b>', CustomCss: '', SplashscreenEnabled: false, SplashscreenLocation: 'Ignored host path' }) });
  assert.equal(update.status, 204); assert.equal(state.runtime.branding.getOptions({ includeLocation: true }).SplashscreenLocation, custom);
  assert.equal((await fetch(origin + '/Branding/Splashscreen')).status, 404);
  const preview = await fetch(origin + '/Branding/Splashscreen', { headers: state.headers }); assert.equal(preview.status, 200);
  const previewBytes = Buffer.from(await preview.arrayBuffer()); assert.deepEqual(previewBytes, bytes);
  assert.equal((await sharp(previewBytes).metadata()).width, 240);
  const restartOrigin = await state.reopen();
  assert.equal(state.runtime.branding.getOptions({ includeLocation: true }).SplashscreenLocation, custom);
  assert.deepEqual(await (await fetch(restartOrigin + '/Branding/Configuration')).json(), { LoginDisclaimer: 'A <b>café 中文</b>', CustomCss: '', SplashscreenEnabled: false });
  const deleted = await fetch(restartOrigin + '/Branding/Splashscreen', { method: 'DELETE', headers: state.headers });
  assert.equal(deleted.status, 204); assert.equal(state.runtime.branding.getOptions({ includeLocation: true }).SplashscreenLocation, null);
  await assert.rejects(readFile(custom), { code: 'ENOENT' }); assert.deepEqual(await readFile(path.join(state.dataPath, 'splashscreen.png')), bytes);
});

test('postgres: branding reads configured network images through VFS and rejects an unmapped host image', { skip: !postgresTestConnectionString }, async t => {
  const state = await setup(t, { network: true }), origin = state.getOrigin(), bytes = await readFile(source);
  await state.vfs.write('/branding/custom.png', bytes);
  await state.runtime.branding.configurationStore.save({ SplashscreenLocation: 'Z:\\Branding\\custom.png' });
  assert.deepEqual(Buffer.from(await (await fetch(origin + '/Branding/Splashscreen')).arrayBuffer()), bytes);
  const host = path.join(state.root, 'unmapped.png'); await writeFile(host, bytes);
  await state.runtime.branding.configurationStore.save({ SplashscreenLocation: host });
  await assert.rejects(state.runtime.branding.splashscreen({}, { auth: {} }), { code: 'unmapped-path' });
  assert.deepEqual(await readFile(host), bytes);
});

test('postgres: runtime close cancels an active image upload and every queued request without waiting for another body chunk', { skip: !postgresTestConnectionString }, async t => {
  const state = await setup(t), origin = state.getOrigin();
  const uploaded = once(state.runtime.branding.configurationStore, 'updated', { signal: AbortSignal.timeout(5000) });
  const requests = [];
  t.after(() => { for (const req of requests) req.destroy(); });
  const secondAdmitted = Promise.withResolvers(), original = state.runtime.branding.upload.bind(state.runtime.branding);
  let admissions = 0;
  state.runtime.branding.upload = req => { if (++admissions === 2) secondAdmitted.resolve(); return original(req); };
  const upload = type => {
    const req = request(origin + '/Branding/Splashscreen', { method: 'POST', headers: { ...state.headers, 'Content-Type': type } }, response => {
      response.on('error', () => {}); response.resume();
    }); req.on('error', () => {}); req.flushHeaders(); req.write('YWJj'); requests.push(req); return req;
  };
  upload('image/png'); await uploaded;
  const png = path.join(state.dataPath, 'splashscreen-upload.png'), deadline = performance.now() + 5000;
  while (await stat(png).then(info => info.size, () => 0) !== 3) {
    assert.ok(performance.now() < deadline, 'The admitted upload did not save its first decoded block.'); await new Promise(resolve => setTimeout(resolve, 10));
  }
  upload('image/jpeg');
  await Promise.race([secondAdmitted.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('The second upload was not admitted.')), 3000); timer.unref(); })]);
  await Promise.race([state.runtime.close(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Runtime shutdown left a branding upload active.')), 5000); timer.unref(); })]);
  for (const req of requests) req.destroy();
  assert.deepEqual(await readFile(png), Buffer.from('abc'));
  await assert.rejects(readFile(path.join(state.dataPath, 'splashscreen-upload.jpg')), { code: 'ENOENT' });
  assert.equal(state.runtime.networkHost.listeners.some(listener => listener.server.listening), false);
});

test('postgres: a late construction failure closes the branding service and leaves its saved assets untouched', { skip: !postgresTestConnectionString }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branding-rollback-')), database = await createPostgresTestDatabase(null, 'branding_rollback');
  const bytes = await readFile(source); await mkdir(path.join(root, 'data')); await writeFile(path.join(root, 'data', 'splashscreen.png'), bytes);
  let closed = 0; const close = BrandingService.prototype.close;
  BrandingService.prototype.close = async function () { closed++; return close.call(this); };
  t.after(async () => {
    BrandingService.prototype.close = close; await dropPostgresTestDatabase(database);
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('branding-rollback-')); await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(createRuntime({ database, programDataPath: root, configurationDirectoryPath: path.join(root, 'config'),
    configuration: { UICulture: 'en-US' }, serverId: 'branding-rollback', autoDiscoveryOptions: false }), /autoDiscoveryOptions/);
  assert.equal(closed, 1); assert.equal(database.closed, true); assert.deepEqual(await readFile(path.join(root, 'data', 'splashscreen.png')), bytes);
});

test('branding configuration rejects linked directories before reading or overwriting external state', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branding-config-path-')), config = path.join(root, 'config'), externalDirectory = path.join(root, 'external');
  await mkdir(externalDirectory); const external = path.join(externalDirectory, 'branding.xml'), bytes = Buffer.from('<BrandingOptions><CustomCss>Preserved</CustomCss></BrandingOptions>'); await writeFile(external, bytes);
  const store = new BrandingConfigurationStore({ configurationDirectoryPath: config });
  t.after(async () => { await store.close(); assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('branding-config-path-')); await rm(root, { recursive: true, force: true }); });
  await symlink(externalDirectory, config, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.initialize(), { code: 'unsafe-configuration-path' });
  await assert.rejects(store.save({ CustomCss: 'Rejected write' }), { code: 'unsafe-configuration-path' });
  assert.deepEqual(await readFile(external), bytes);
});
