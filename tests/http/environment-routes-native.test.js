import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createTestApplication } from '../helpers/application.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE);
const nativeCase = declareNativeHttpTestFile({ enabled });
const authorization = token => 'MediaBrowser Client="Environment contract",Device="Isolated",DeviceId="fixture-oracle",Version="1",Token="' + token + '"';

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('directory browser validation and navigation match the designated Native HTTP contract', {
  skip: !enabled, timeout: 120000,
}, nativeCase(async (t, port) => {
  await mkdir(validationOutputRoot(), { recursive: true });
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'environment-oracle-' + randomUUID()));
  const nativeOrigin = `http://127.0.0.1:${port}`;
  const registry = new StorageRegistry();
  let current, root, token, native, application;
  const report = { checked: [] };
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    await attempt(async () => {
      application?.beginClose();
      await application?.drainRequests();
      if (application?.server.listening) await close(application.server);
    });
    await attempt(async () => {
      if (!native) return;
      report.shutdown = await native.stop(async () => {
        const response = await fetch(nativeOrigin + '/System/Shutdown', {
          method: 'POST', headers: { Authorization: authorization(token), Connection: 'close' }, signal: AbortSignal.timeout(10000),
        });
        await response.arrayBuffer();
        return response.status;
      }, async () => {
        const server = createServer();
        try { await listen(server, port); } catch { return false; }
        await close(server); return true;
      });
      assert.equal(report.shutdown.cleanShutdown, true);
      assert.equal(report.shutdown.code, 0);
      assert.equal(report.shutdown.pidGone, true);
      assert.equal(report.shutdown.portAvailable, true);
    });
    await attempt(() => registry.close());
    await attempt(() => current?.finish());
    await attempt(() => root && writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }));
    await attempt(() => output.publishAndClose());
    if (failures.length) throw new AggregateError(failures.map(output.publicError), 'Environment oracle cleanup failed.');
  });
  await mkdir(output.root);
  root = await realpath(output.root);
  const directory = path.join(root, 'browser'), visible = path.join(directory, 'visible'), filename = path.join(visible, 'file.txt');
  await mkdir(visible, { recursive: true });
  await writeFile(filename, 'isolated file', { flag: 'wx' });
  registry.registerType('local', configuration => LocalAdapter.open(configuration));
  await registry.createInstance('browser', 'local', { root: directory, writable: true });
  const vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  vfs.mount({ path: '/browser', instanceId: 'browser', capabilities: { create: true, replace: true, delete: true, atomicReplace: true } });
  identityMap.addPrefix({ identityRoot: directory, accessRoot: '/browser', style: process.platform === 'win32' ? 'windows' : 'posix',
    returnAccess: 'Isolated contract directory.' });
  current = await currentNativeReference();
  token = current.accessToken;
  output.addSecret(token);
  report.input = current.preparation;
  report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/EnvironmentController.cs',
    'Jellyfin.Api/Models/EnvironmentDtos/ValidatePathDto.cs', 'Emby.Server.Implementations/IO/ManagedFileSystem.cs']);
  const referenceRoot = path.join(root, 'reference');
  await cp(current.sourceRoot, referenceRoot, { recursive: true });
  await current.prepareClone(referenceRoot, port);
  native = current.start({ referenceRoot, outputRoot: root, label: 'reference', origin: nativeOrigin });
  await native.ready();

  const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'environment-oracle', isLocalNetwork: () => true });
  authentication.authenticate = async request => {
    const administrator = request.headers.authorization === authorization(token);
    return { IsAuthenticated: administrator, IsAdministrator: administrator,
      User: { Policy: { IsAdministrator: administrator, EnableRemoteAccess: true }, AccessSchedules: [] } };
  };
  application = await createTestApplication({ configuration: { IsStartupWizardCompleted: true }, authentication,
    fileSystem: new StorageFileSystem({ vfs, identityMap }) });
  await listen(application.server, 0);
  const nodeOrigin = `http://127.0.0.1:${application.server.address().port}`;

  const wire = async (origin, route, { body, accept = 'application/json', authenticated = true } = {}) => {
    const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(15000)]), headers: { Accept: accept,
        ...(authenticated ? { Authorization: authorization(token) } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const contentType = response.headers.get('content-type'), raw = await response.text();
    const value = raw && contentType?.includes('json') ? projectProblemTrace(JSON.parse(raw), response.status) : raw;
    return { status: response.status, contentType, body: value };
  };
  const compare = async (route, options) => {
    const expected = await wire(nativeOrigin, route, options), actual = await wire(nodeOrigin, route, options);
    report.checked.push({ route, options, expected, actual });
  };
  for (const accept of ['*/*', 'text/plain', 'application/json', 'text/plain, application/json;q=0.1', 'text/plain, application/json;q=0']) {
    const observe = async origin => {
      const response = await fetch(origin + '/System/Ping', { headers: { Accept: accept }, signal: t.signal });
      const raw = await response.text();
      let jsonString = false;
      try { jsonString = typeof JSON.parse(raw) === 'string'; } catch { /* Record raw text as received. */ }
      return { status: response.status, contentType: response.headers.get('content-type'), jsonString, raw };
    };
    const expected = await observe(nativeOrigin), actual = await observe(nodeOrigin);
    assert.equal(expected.status, 200); assert.equal(actual.status, 200);
    t.diagnostic('AUDIT_NEGOTIATION ' + JSON.stringify({ accept, native: expected, candidate: actual }));
  }
  await compare('/Environment/DefaultDirectoryBrowser');
  for (const accept of ['application/json', 'text/plain']) {
    await compare('/Environment/ParentPath?' + new URLSearchParams({ path: filename }), { accept });
  }
  for (const body of [{}, { Path: visible }, { Path: visible, ValidateWritable: true }, { Path: filename, IsFile: true },
    { Path: filename, IsFile: false }, { Path: visible, IsFile: true }, { Path: visible, ValidateWriteable: true },
    { Path: filename, ValidateWritable: true }, { Path: path.join(visible, 'missing'), IsFile: null }]) {
    await compare('/Environment/ValidatePath', { body });
  }
  assert.deepEqual(await readdir(visible), ['file.txt']);

  const nativeDrives = await wire(nativeOrigin, '/Environment/Drives'), nodeDrives = await wire(nodeOrigin, '/Environment/Drives');
  assert.equal(nativeDrives.status, 200); assert.equal(nativeDrives.contentType, nodeDrives.contentType);
  assert.ok(Array.isArray(nativeDrives.body) && nativeDrives.body.every(value => typeof value.Name === 'string'
    && typeof value.Path === 'string' && value.Type === 'Directory'));
  assert.deepEqual(nodeDrives.body, [{ Name: directory, Path: directory, Type: 'Directory' }]);
  report.driveScopes = { nativeReadyDrives: nativeDrives.body.length, nodeDeclaredRoots: nodeDrives.body };
  for (const { route, actual, expected } of report.checked) assert.deepEqual(actual, expected, route);
}));
