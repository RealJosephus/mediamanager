import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { createTestApplication } from '../helpers/application.js';

async function fixture(t) {
  await mkdir(validationOutputRoot(), { recursive: true });
  const root = await mkdtemp(path.join(validationOutputRoot(), 'environment-http-'));
  const registry = new StorageRegistry(); let application;
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    application?.beginClose(); await attempt(() => application?.drainRequests());
    await attempt(async () => {
      if (application?.server.listening) await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
    });
    await attempt(() => registry.close());
    await attempt(() => rm(assertValidationOutputChild(root), { recursive: true, force: true }));
    if (failures.length) throw new AggregateError(failures, 'Environment HTTP cleanup failed.');
  });
  const disk = path.join(root, 'disk'), unmapped = path.join(root, 'unmapped');
  await mkdir(disk); await mkdir(unmapped);
  const fileNames = ['.hidden', '10-file', '2-file', 'a-file'];
  for (const name of fileNames) await writeFile(path.join(disk, name), name);
  await mkdir(path.join(disk, 'Z-directory')); await writeFile(path.join(unmapped, 'private-file'), 'Private host file');
  registry.registerType('local', configuration => LocalAdapter.open(configuration));
  const adapter = await registry.createInstance('disk', 'local', { root: disk, writable: true });
  const vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  const identities = [
    { name: 'posix', root: '/declared/environment', style: 'posix', api: path.posix },
    { name: 'windows', root: 'Z:\\Environment', style: 'windows', api: path.win32 },
    { name: 'unc', root: '\\\\environment-host\\share', style: 'windows', api: path.win32 },
  ];
  for (const identity of identities) {
    vfs.mount({ path: '/' + identity.name, instanceId: 'disk', capabilities: {} });
    identityMap.addPrefix({ identityRoot: identity.root, accessRoot: '/' + identity.name, style: identity.style,
      returnAccess: 'The declared identity resolves to this isolated local storage only.' });
  }
  const writableRoot = '/declared/writable';
  vfs.mount({ path: '/writable', instanceId: 'disk', capabilities: { create: true, replace: true, delete: true, atomicReplace: true } });
  identityMap.addPrefix({ identityRoot: writableRoot, accessRoot: '/writable', returnAccess: 'Isolated writable storage.' });
  const configuration = { IsStartupWizardCompleted: true };
  const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'environment-http', isLocalNetwork: () => true });
  authentication.authenticate = async request => {
    const identity = request.headers['x-identity'] ?? 'admin', administrator = identity === 'admin';
    return { IsAuthenticated: identity !== 'anonymous', IsApiKey: identity === 'apiKey', IsAdministrator: administrator || identity === 'apiKey',
      User: { Policy: { IsAdministrator: administrator, EnableRemoteAccess: true }, AccessSchedules: [] } };
  };
  application = await createTestApplication({ configuration, authentication, fileSystem: new StorageFileSystem({ vfs, identityMap }) });
  await new Promise((resolve, reject) => {
    application.server.once('error', reject);
    application.server.listen(0, '127.0.0.1', () => { application.server.off('error', reject); resolve(); });
  });
  const origin = 'http://127.0.0.1:' + application.server.address().port;
  const send = async (route, { parameters, identity = 'admin', body, accept = 'application/json' } = {}) => {
    const response = await fetch(origin + '/Environment/' + route + (parameters ? '?' + new URLSearchParams(parameters) : ''), {
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(30000)]), method: body === undefined ? 'GET' : 'POST',
      headers: { Accept: accept, 'X-Identity': identity, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    try { return { status: response.status, contentType: response.headers.get('content-type'), body: JSON.parse(text) }; }
    catch { return { status: response.status, contentType: response.headers.get('content-type'), body: text }; }
  };
  return { request: (parameters, identity) => send('DirectoryContents', { parameters, identity }),
    send, configuration, identities, fileNames, unmapped, writableRoot, adapter, disk };
}

test('environment enumeration retains mapped file identities and never lists an unmapped host directory', async t => {
  const value = await fixture(t);
  for (const identity of value.identities) {
    const expected = value.fileNames.map(name => ({ Name: name, Path: identity.api.join(identity.root, name), Type: 'File' }));
    assert.deepEqual(await value.request({ path: identity.root }), { status: 200, contentType: 'application/json; charset=utf-8', body: [] });
    const files = await value.request({ path: identity.root, includeFiles: 'true' });
    assert.equal(files.status, 200); assert.deepEqual(files.body, expected);
    const directory = { Name: 'Z-directory', Path: identity.api.join(identity.root, 'Z-directory'), Type: 'Directory' };
    const directories = await value.request({ path: identity.root, includeDirectories: 'true' });
    assert.equal(directories.status, 200); assert.deepEqual(directories.body, [directory]);
    const all = await value.request({ path: identity.root, includeFiles: 'true', includeDirectories: 'true' });
    assert.equal(all.status, 200); assert.deepEqual(all.body, [...expected, directory]);
    for (const suffix of ['missing', '10-file']) {
      assert.deepEqual(await value.request({ path: identity.api.join(identity.root, suffix), includeFiles: 'true' }), {
        status: suffix === '10-file' && process.platform === 'win32' ? 500 : 404,
        contentType: 'text/plain', body: 'Error processing request.' });
    }
  }
  assert.deepEqual(await value.request({ path: value.unmapped, includeFiles: 'true' }), {
    status: 404, contentType: 'text/plain', body: 'Error processing request.' });
  assert.deepEqual(await readdir(value.unmapped), ['private-file']);
  assert.equal((await value.request({ path: '/declared/environment\0', includeFiles: 'true' })).status, 400);
  assert.deepEqual((await value.request({ path: '\\\\environment-host', includeFiles: 'true' })).body, []);
});

test('environment authorization precedes scalar binding and first-time setup permits the native policy', async t => {
  const value = await fixture(t), parameters = { path: '', includeFiles: 'invalid', includeDirectories: 'invalid' };
  assert.equal((await value.request(parameters, 'anonymous')).status, 401);
  assert.equal((await value.request(parameters, 'regular')).status, 403);
  for (const identity of ['admin', 'apiKey']) {
    const result = await value.request(parameters, identity);
    assert.equal(result.status, 400); assert.equal(typeof result.body.traceId, 'string');
    assert.deepEqual(result.body.errors, { path: ['The path field is required.'], includeFiles: ["The value 'invalid' is not valid."],
      includeDirectories: ["The value 'invalid' is not valid."] });
  }
  value.configuration.IsStartupWizardCompleted = false;
  assert.equal((await value.request(parameters, 'anonymous')).status, 400);
  const listed = await value.request({ path: value.identities[0].root, includeFiles: 'true' }, 'anonymous');
  assert.equal(listed.status, 200); assert.deepEqual(listed.body.map(entry => entry.Name), value.fileNames);
});

test('environment browser uses declared roots, navigates identity paths and validates writable storage through a temporary object', async t => {
  const value = await fixture(t);
  const { send, writableRoot, adapter, disk, unmapped } = value;
  const roots = [...value.identities.map(entry => entry.root), writableRoot];
  assert.deepEqual((await send('Drives')).body, roots.map(root => ({ Name: root, Path: root, Type: 'Directory' })));
  assert.deepEqual((await send('DefaultDirectoryBrowser')).body, {});
  for (const { root, api } of value.identities) {
    assert.equal((await send('ParentPath', { parameters: { path: root } })).status, 204);
    const child = api.join(root, 'folder', 'file');
    for (const accept of ['application/json', 'text/plain']) {
      const result = await send('ParentPath', { parameters: { path: child }, accept });
      assert.equal(result.status, 200);
      assert.equal(result.contentType, 'application/json; charset=utf-8');
      assert.equal(result.body, api.dirname(child));
    }
  }
  assert.equal((await send('ParentPath', { parameters: { path: '\\\\environment-host' } })).status, 204);

  const writes = [], deletions = [], write = adapter.write.bind(adapter), remove = adapter.delete.bind(adapter);
  adapter.write = async (...args) => { writes.push(args[0]); return write(...args); };
  adapter.delete = async (...args) => { deletions.push(args[0]); return remove(...args); };
  const original = (await readdir(disk)).sort();
  const validate = (body, identity) => send('ValidatePath', { body, identity });
  assert.equal((await validate({ Path: writableRoot, ValidateWritable: true })).status, 204);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /^\/[a-f0-9-]{36}$/u);
  assert.deepEqual(deletions, writes);
  assert.deepEqual((await readdir(disk)).sort(), original);

  const readonly = value.identities[0].root, readonlyFile = readonly + '/10-file';
  assert.equal((await validate({ Path: readonly, ValidateWritable: true })).status, 500);
  assert.equal((await validate({ Path: readonly, IsFile: false, ValidateWritable: true })).status, 204);
  assert.equal((await validate({ Path: readonly, ValidateWriteable: true })).status, 204);
  assert.equal((await validate({ Path: readonlyFile, IsFile: true, ValidateWritable: true })).status, 204);
  assert.equal((await validate({ Path: readonlyFile, IsFile: false })).status, 404);
  assert.equal((await validate({ Path: readonly, IsFile: true })).status, 404);
  assert.equal((await validate({ Path: unmapped })).status, 404);
  assert.equal((await validate({})).status, 404);
  assert.equal((await validate({ Path: readonly, ValidateWritable: 'true' })).status, 400);
  assert.equal((await validate({ Path: writableRoot, ValidateWritable: true }, 'anonymous')).status, 401);
  assert.equal((await validate({ Path: writableRoot, ValidateWritable: true }, 'regular')).status, 403);
  assert.equal((await send('Drives', { identity: 'regular' })).status, 403);
  assert.equal(writes.length, 1);
});
