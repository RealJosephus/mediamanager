import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { LibraryOptionsStore } from '../../src/library/library-options-store.js';
import { defaultLibraryOptions, parseLibraryOptions } from '../../src/library/options.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';
import { openConfiguredPluginHost } from './configuration-host.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['webdav'];
const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
async function remainsPending(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, 'The configuration transfer must retain its original unfinished upload.');
}

test('configured remote library saves retain their original target and spool across storage replacement', {
  skip: !process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE, timeout: 120000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'storage-file-configuration-'));
  const service = await startActualWebDav({ evidenceDirectory: path.join(root, 'service') });
  t.after(() => service.stop());
  for (const phase of ['after-write', 'upload-response']) for (const moveSpool of [false, true]) {
    await t.test(phase + (moveSpool ? '/new-spool' : '/same-spool'), async t => {
      const name = phase + (moveSpool ? '-new' : '-same'), work = path.join(root, name);
      const oldRoot = path.join(service.media, name, 'a'), newRoot = path.join(service.media, name, 'b');
      const spoolRoot = path.join(work, 'spool-a'), newSpoolRoot = path.join(work, 'spool-b');
      for (const directory of [oldRoot, newRoot, spoolRoot, newSpoolRoot]) await fs.mkdir(directory, { recursive: true });
      const report = { phase, moveSpool, requests: [], errors: [], observations: {} };
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      let host, storage, options, saving, configuring, selected = true;
      t.after(async () => {
        release.resolve();
        const errors = [];
        const attempt = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
        await attempt(() => Promise.all([saving, configuring]));
        await attempt(() => options?.close()); await attempt(() => storage?.close()); await attempt(() => host?.close());
        report.cleanupErrors = errors.map(errorObservation);
        await fs.writeFile(path.join(root, name + '.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        assert.equal(path.dirname(work), root); await fs.rm(work, { recursive: true });
        if (errors.length) throw new AggregateError(errors, 'Remote file configuration fixture cleanup failed.');
      });
      host = await openConfiguredPluginHost({ directory: path.join(work, 'host'), onError: error => report.errors.push(errorObservation(error)),
        options: { webdav: { fetch: async (url, request) => {
          const response = await fetch(url, request), pathname = new URL(url).pathname;
          report.requests.push({ method: request.method, pathname, status: response.status });
          if (selected && phase === 'upload-response' && request.method === 'PUT' && pathname.endsWith('/a/options.xml')) {
            entered.resolve(); await release.promise;
          }
          return response;
        } } } });
      storage = await createConfiguredStorage(undefined, { plugins: host, environment: { WEBDAV_REGRESSION: service.authorization } });
      const definition = storage.configuration();
      definition.instances.push({ id: 'remote', type: 'webdav', config: { baseUrl: service.baseUrl, credentialRef: 'WEBDAV_REGRESSION', capabilities } },
        { id: 'spool', type: 'local', config: { root: spoolRoot, writable: true } });
      definition.mounts.push({ path: '/remote', instanceId: 'remote', root: '/' + name + '/a', capabilities },
        { path: '/spool', instanceId: 'spool', capabilities });
      definition.prefixes.push({ identityRoot: 'Z:\\Library', accessRoot: '/remote', style: 'windows', purpose: 'metadata', returnAccess: 'The library identity is retained.' },
        { identityRoot: 'Z:\\Spool', accessRoot: '/spool', style: 'windows', purpose: 'application', returnAccess: 'The owned spool identity is retained.' });
      await storage.configure(definition);
      storage.fileSystem.spoolRoot = 'Z:\\Spool';
      options = new LibraryOptionsStore({ fileSystem: storage.fileSystem, programDataPath: work });
      const beforeA = Buffer.from('<LibraryOptions><PreferredMetadataLanguage>old-a</PreferredMetadataLanguage></LibraryOptions>');
      const beforeB = Buffer.from('<LibraryOptions><PreferredMetadataLanguage>old-b</PreferredMetadataLanguage></LibraryOptions>');
      await fs.writeFile(path.join(oldRoot, 'options.xml'), beforeA); await fs.writeFile(path.join(newRoot, 'options.xml'), beforeB);
      // This barrier delays the real consumer after its actual spool write;
      // the production handle, Local adapter and WebDAV requests stay intact.
      const open = storage.fileSystem.open;
      storage.fileSystem.open = async (...args) => {
        const handle = await open(...args);
        return { ...handle, async writeFile(...values) {
          await handle.writeFile(...values);
          if (selected && phase === 'after-write') { entered.resolve(); await release.promise; }
        } };
      };
      saving = options.save('Z:\\Library', { ...defaultLibraryOptions(), PreferredMetadataLanguage: 'fr' });
      void saving.catch(() => {});
      await Promise.race([entered.promise, saving.then(() => { throw new Error('The save did not enter the selected actual I/O boundary.'); })]);
      const [temporary] = await fs.readdir(spoolRoot); assert.match(temporary, /^file-.*\.tmp$/u);
      const expected = await fs.readFile(path.join(spoolRoot, temporary));
      assert.equal(parseLibraryOptions(expected.toString('utf8')).PreferredMetadataLanguage, 'fr');
      const sentinel = Buffer.from('A different spool backend owns this same logical filename.');
      if (moveSpool) await fs.writeFile(path.join(newSpoolRoot, temporary), sentinel);
      const next = structuredClone(definition);
      next.mounts.find(mount => mount.path === '/remote').root = '/' + name + '/b';
      if (moveSpool) next.instances.find(instance => instance.id === 'spool').config.root = newSpoolRoot;
      const switching = Promise.withResolvers();
      const stopBefore = storage.subscribeBeforeChange(() => switching.resolve());
      configuring = storage.configure(next); void configuring.catch(() => {});
      if (phase === 'upload-response') {
        await switching.promise;
        await remainsPending(configuring);
        assert.equal(storage.configuration().mounts.find(mount => mount.path === '/remote').root, '/' + name + '/b');
        assert.deepEqual(await fs.readFile(path.join(oldRoot, 'options.xml')), expected);
        assert.deepEqual(await fs.readFile(path.join(newRoot, 'options.xml')), beforeB);
        release.resolve();
      }
      await configuring;
      stopBefore();
      assert.deepEqual(await fs.readFile(path.join(oldRoot, 'options.xml')), expected);
      assert.deepEqual(await fs.readFile(path.join(newRoot, 'options.xml')), beforeB);
      assert.deepEqual(await fs.readdir(spoolRoot), []);
      if (moveSpool) assert.deepEqual(await fs.readFile(path.join(newSpoolRoot, temporary)), sentinel);
      release.resolve(); await saving; selected = false;
      report.observations.afterTransfer = { oldTarget: expected.toString('base64'), newTarget: beforeB.toString('base64'),
        originalSpoolEmpty: true, unrelatedSpoolPreserved: moveSpool };
      await options.save('Z:\\Library', { ...defaultLibraryOptions(), PreferredMetadataLanguage: 'de' });
      const subsequent = await fs.readFile(path.join(newRoot, 'options.xml'));
      assert.equal(parseLibraryOptions(subsequent.toString('utf8')).PreferredMetadataLanguage, 'de');
      assert.deepEqual(await fs.readFile(path.join(oldRoot, 'options.xml')), expected);
      assert.deepEqual(await fs.readdir(moveSpool ? newSpoolRoot : spoolRoot), moveSpool ? [temporary] : []);
      report.observations.subsequentSave = { oldTarget: expected.toString('base64'), newTarget: subsequent.toString('base64') };
      assert.deepEqual(report.errors, []);
    });
  }
});
