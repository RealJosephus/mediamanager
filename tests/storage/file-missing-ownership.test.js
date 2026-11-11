import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { StorageFileSystem } from '../../src/storage/files.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { startActualWebDav } from './helpers/actual-webdav.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['webdav'];
const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
const reasons = [['false', false], ['zero', 0], ['empty', ''], ['null', null], ['undefined', undefined]];
const outcome = work => Promise.resolve(work).then(value => ({ value }), error => ({ error }));

test('file missing-path recovery preserves failed real WebDAV response cleanup before mkdir or forced removal', {
  skip: !process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE, timeout: 120000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'file-missing-ownership-'));
  const service = await startActualWebDav({ evidenceDirectory: path.join(root, 'service') });
  t.after(() => service.stop());
  for (const operation of ['mkdir', 'forced-remove']) for (const [label, reason] of reasons) await t.test(`${operation}/${label}`, async t => {
    const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
    const identityRoot = path.join(root, 'identities'), filename = `${operation}-${label}`;
    const target = path.join(identityRoot, filename), actual = path.join(service.media, filename);
    const fileSystem = new StorageFileSystem({ vfs, identityMap });
    const requests = [];
    let selected = true, cancelled = 0, drained = 0, statFailure, work, failed, recovered = false;
    const adapter = new WebDavAdapter({ baseUrl: service.baseUrl, credentialRef: 'MISSING_WEBDAV', capabilities }, {
      resolveCredential: () => service.authorization,
      async fetch(url, options) {
        const response = await fetch(url, options);
        requests.push({ method: options.method, path: new URL(url).pathname, status: response.status });
        if (!selected || options.method !== 'PROPFIND' || response.status !== 404) return response;
        const body = response.body, cancel = body.cancel.bind(body);
        const ownedBody = new Proxy(body, { get(target, key) {
          if (key === 'cancel') return async (...args) => {
            await cancel(...args); cancelled++;
            const reader = body.getReader();
            try { assert.equal((await reader.read()).done, true); drained++; }
            finally { reader.releaseLock(); }
            throw reason;
          };
          const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
        } });
        return new Proxy(response, { get(target, key) {
          if (key === 'body') return ownedBody;
          const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
        } });
      },
    });
    const stat = adapter.stat.bind(adapter);
    adapter.stat = async (...args) => {
      try { return await stat(...args); }
      catch (error) { if (selected) statFailure = error; throw error; }
    };
    t.after(async () => {
      selected = false; await work;
      const fileClose = await outcome(fileSystem.close()), registryClose = await outcome(registry.close());
      await fs.writeFile(path.join(root, `${operation}-${label}.json`), JSON.stringify({ operation, label, requests, cancelled, drained,
        failed: errorObservation(failed?.error), statFailure: errorObservation(statFailure), recovered,
        fileClose: errorObservation(fileClose.error), registryClose: errorObservation(registryClose.error) }, null, 2) + '\n');
      if (Object.hasOwn(fileClose, 'error')) throw fileClose.error;
      if (statFailure?.errors) {
        assert.equal(registryClose.error.errors.length, 1);
        assert.equal(registryClose.error.errors[0], statFailure.errors[1]);
      } else if (Object.hasOwn(registryClose, 'error')) throw registryClose.error;
    });
    registry.registerType('actual-webdav', async () => adapter); await registry.createInstance('remote', 'actual-webdav', {});
    vfs.mount({ path: '/remote', instanceId: 'remote', capabilities });
    identityMap.addPrefix({ identityRoot, accessRoot: '/remote', style: process.platform === 'win32' ? 'windows' : 'posix',
      returnAccess: 'Only the isolated actual WebDAV fixture is addressable.' });
    work = outcome(operation === 'mkdir' ? fileSystem.mkdir(target, { recursive: true }) : fileSystem.rm(target, { force: true }));
    failed = await work; selected = false;
    assert.equal(Object.hasOwn(failed, 'error'), true);
    assert.equal(failed.error.code, 'ENOENT'); assert.equal(failed.error.storageCode, 'not-found');
    assert.equal(failed.error.cause, statFailure); assert.deepEqual(failed.error.errors, statFailure.errors);
    assert.equal(statFailure.errors.length, 2); assert.equal(statFailure.errors[0].details.status, 404);
    assert.equal(statFailure.errors[1].cause, reason); assert.equal(cancelled, 1); assert.equal(drained, 1);
    assert.deepEqual(requests.map(request => [request.method, request.status]), [['PROPFIND', 404]],
      'A failed missing-path response must not authorize a later MKCOL.');
    await assert.rejects(fs.stat(actual), { code: 'ENOENT' });
    if (operation === 'mkdir') {
      await fileSystem.mkdir(target, { recursive: true });
      await fileSystem.mkdir(target, { recursive: true });
      assert.equal((await fs.stat(actual)).isDirectory(), true);
      const bytes = Buffer.from('The actual directory recovered after its rejected response cleanup.');
      await fileSystem.writeFile(path.join(target, 'recovered.txt'), bytes);
      assert.deepEqual(await fs.readFile(path.join(actual, 'recovered.txt')), bytes);
      await fileSystem.rm(target, { recursive: true, force: true });
    } else {
      await fileSystem.rm(target, { force: true });
      const bytes = Buffer.from('The actual file remains removable after the failed response.');
      await fileSystem.writeFile(target, bytes); assert.deepEqual(await fs.readFile(actual), bytes);
      await fileSystem.rm(target, { force: true }); await fileSystem.rm(target, { force: true });
    }
    await assert.rejects(fs.stat(actual), { code: 'ENOENT' }); recovered = true;
  });
});
