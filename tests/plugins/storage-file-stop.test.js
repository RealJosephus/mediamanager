import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { storageOwnership } from '../../src/storage/ownership.js';
import { LibraryOptionsStore, serializeLibraryOptions } from '../../src/library/library-options-store.js';
import { defaultLibraryOptions, parseLibraryOptions } from '../../src/library/options.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';
import { openConfiguredPluginHost } from './configuration-host.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['webdav'];
const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
const outcome = operation => Promise.resolve(operation).then(value => ({ value }), error => ({ error }));
async function pending(operation) {
  let settled = false;
  void operation.then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, 'Plugin stop must join the owned spool transfer.');
}

test('stopping installed spool or target plugins drains actual remote files and recovers after failure', {
  skip: !process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'storage-file-stop-'));
  const service = await startActualWebDav({ evidenceDirectory: path.join(root, 'service') });
  t.after(() => service.stop());
  // Real rejection endpoint: the upload receives an actual HTTP failure while
  // the rclone target keeps its previous bytes. No in-memory storage is used.
  const rejection = http.createServer((request, response) => { request.resume(); response.writeHead(403); response.end('Forbidden'); });
  rejection.listen(0, '127.0.0.1'); await once(rejection, 'listening');
  t.after(() => new Promise(resolve => { rejection.closeAllConnections(); rejection.close(resolve); }));
  for (const plugin of ['local', 'webdav']) for (const phase of ['after-write', 'upload-response', 'failed-cleanup']) {
    await t.test(plugin + '/' + phase, async t => {
      const name = plugin + '-' + phase, work = path.join(root, name), spoolRoot = path.join(work, 'spool');
      const targetRoot = path.join(service.media, name), target = path.join(targetRoot, 'options.xml');
      for (const directory of [spoolRoot, targetRoot]) await fs.mkdir(directory, { recursive: true });
      const before = Buffer.from('<LibraryOptions><PreferredMetadataLanguage>old</PreferredMetadataLanguage></LibraryOptions>');
      await fs.writeFile(target, before);
      const bytes = serializeLibraryOptions({ ...defaultLibraryOptions(), PreferredMetadataLanguage: 'fr' }).bytes;
      const failing = phase === 'failed-cleanup', cleanupReason = plugin === 'local' ? false : undefined;
      const entered = Promise.withResolvers(), release = Promise.withResolvers(), revoking = Promise.withResolvers();
      const report = { plugin, phase, requests: [], errors: [] };
      let selected = true, host, storage, file, rawFile, closing, stopping, options, deleted = 0;
      t.after(async () => {
        release.resolve(); await Promise.all([closing, stopping]);
        await options?.close(); await storage?.close(); await host?.close();
        await fs.writeFile(path.join(root, name + '.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        assert.equal(path.dirname(work), root); await fs.rm(work, { recursive: true });
      });
      host = await openConfiguredPluginHost({ directory: path.join(work, 'host'), onError: error => report.errors.push(errorObservation(error)),
        options: { webdav: { fetch: async (url, request) => {
          const held = selected && request.method === 'PUT';
          const destination = held && failing ? `http://127.0.0.1:${rejection.address().port}/rejected` : url;
          const response = await fetch(destination, request);
          report.requests.push({ method: request.method, path: new URL(url).pathname, status: response.status });
          if (held) { entered.resolve(); await release.promise; }
          return response;
        } } } });
      storage = await createConfiguredStorage(undefined, { plugins: host, environment: { WEBDAV_STOP: service.authorization } });
      const definition = storage.configuration();
      definition.instances.push({ id: 'remote', type: 'webdav', config: { baseUrl: service.baseUrl, credentialRef: 'WEBDAV_STOP', capabilities } },
        { id: 'spool', type: 'local', config: { root: spoolRoot, writable: true } });
      definition.mounts.push({ path: '/remote', instanceId: 'remote', root: '/' + name, capabilities },
        { path: '/spool', instanceId: 'spool', capabilities });
      definition.prefixes.push({ identityRoot: 'Z:\\Library', accessRoot: '/remote', style: 'windows', purpose: 'metadata', returnAccess: 'Retain the library identity.' },
        { identityRoot: 'Z:\\Spool', accessRoot: '/spool', style: 'windows', purpose: 'application', returnAccess: 'Retain the spool identity.' });
      await storage.configure(definition); storage.fileSystem.spoolRoot = 'Z:\\Spool';
      const oldSpool = storage.vfs.resolve('/spool').adapter, oldTarget = storage.vfs.resolve('/remote').adapter;
      // Observe the real handle and optionally reject only AFTER actual unlink.
      // Calls still pass through the installed plugin's admission and adapter.
      const observe = adapter => new Proxy(adapter, { get(target, key) {
        if (key === storageOwnership) return () => {
          const lease = target[storageOwnership](); return { ...lease, adapter: observe(lease.adapter) };
        };
        if (key === 'openFile') return async (...args) => { rawFile = await target.openFile(...args); return rawFile; };
        if (key === 'delete') return async (...args) => { await target.delete(...args); deleted++; if (failing && selected) throw cleanupReason; };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const resolve = storage.vfs.resolveFileHandle;
      storage.vfs.resolveFileHandle = (...args) => {
        const resolved = resolve(...args);
        return resolved.adapter === oldSpool ? { ...resolved, adapter: observe(resolved.adapter) } : resolved;
      };
      file = await storage.fileSystem.open('Z:\\Library\\options.xml', 'w'); await file.writeFile(bytes);
      assert.equal((await rawFile.stat()).size, bytes.length);
      assert.equal((await fs.readdir(spoolRoot)).length, 1);
      const unsubscribe = storage.subscribeBeforeChange(() => revoking.resolve());
      if (phase === 'upload-response') { closing = outcome(file.close()); await entered.promise; }
      stopping = outcome(host.setEnabled(plugin, false));
      await revoking.promise;
      await assert.rejects(async () => (plugin === 'local' ? oldSpool : oldTarget).stat('/'), { status: 503 });
      await Promise.race([entered.promise, stopping.then(() => { throw new Error('Plugin stop returned before the owned upload.'); })]);
      closing ??= outcome(file.close());
      const shared = file.close(); assert.equal(file.close(), shared); void shared.catch(() => {});
      await pending(stopping); await pending(closing);
      assert.equal(rawFile.fd, -1, 'The actual spool FileHandle must be closed before upload.');
      release.resolve(); const [stopResult, closeResult] = await Promise.all([stopping, closing]); unsubscribe();
      assert.deepEqual(await fs.readdir(spoolRoot), []); assert.equal(deleted, 1);
      assert.deepEqual(await fs.readFile(target), failing ? before : bytes);
      if (failing) {
        assert.equal(closeResult.error.errors.length, 2);
        assert.equal(closeResult.error.errors[0].code, 'permission-denied');
        assert.equal(closeResult.error.errors[1], cleanupReason);
        assert.equal(stopResult.error.errors[0], closeResult.error);
        assert.equal(host.get(plugin).status, 'active');
        assert.equal(host.get(plugin).enabled, true);
        report.failures = { file: errorObservation(closeResult.error), stop: errorObservation(stopResult.error) };
      } else {
        assert.equal(closeResult.error, undefined); assert.equal(stopResult.error, undefined);
        assert.equal(host.get(plugin).status, 'disabled');
        assert.equal(storage.status().find(instance => instance.id === (plugin === 'local' ? 'spool' : 'remote')).available, false);
      }
      selected = false;
      if (!failing) await host.setEnabled(plugin, true);
      assert.equal(host.get(plugin).status, 'active');
      options = new LibraryOptionsStore({ fileSystem: storage.fileSystem, programDataPath: work });
      await options.save('Z:\\Library', { ...defaultLibraryOptions(), PreferredMetadataLanguage: 'de' });
      assert.equal(parseLibraryOptions((await fs.readFile(target)).toString('utf8')).PreferredMetadataLanguage, 'de');
      assert.deepEqual(await fs.readdir(spoolRoot), []); assert.deepEqual(report.errors, []);
      report.observations = { originalFdClosed: true, spoolEmpty: true, originalTarget: (failing ? before : bytes).toString('base64'),
        subsequentSave: (await fs.readFile(target)).toString('base64'), restoredStatus: host.get(plugin).status };
    });
  }
});
