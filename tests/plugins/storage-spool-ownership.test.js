import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { networkXmlSpool } from '../../src/metadata/local-xml-sinks.js';
import { preparePlaylistFile, serializePlaylistFile } from '../../src/library/playlist-file.js';
import { parsePlaylistMemberRelation } from '../../src/metadata/playlist-member-source.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { createNativeItemCohort } from '../../src/library/native-item-cohort.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';
import { openConfiguredPluginHost } from './configuration-host.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['webdav'];
const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
const parentId = '48300000-0000-0000-0000-000000000001';
async function pending(operation) {
  let settled = false;
  void operation.then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, 'Storage replacement must join the admitted spool consumer.');
}

test('independent XML and SQL playlist spools retain their original installed storage through replacement and Local stop', {
  skip: !process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE || !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 180000,
}, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'storage-spool-ownership-'));
  const service = await startActualWebDav({ evidenceDirectory: path.join(root, 'service') });
  t.after(() => service.stop());
  const database = await createPostgresTestDatabase(t, 'spool_owner');
  const links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
  t.after(() => links.close());
  for (const mode of ['replace', 'stop']) for (const kind of ['xml', 'xml-upload', 'export', 'import', 'xml-cleanup', 'export-cleanup', 'import-cleanup']) {
    await t.test(`${mode}/${kind}`, async t => {
      const name = `${mode}-${kind}`, work = path.join(root, name), oldRoot = path.join(work, 'old'), newRoot = path.join(work, 'new');
      for (const directory of [oldRoot, newRoot, path.join(service.media, name)]) await fs.mkdir(directory, { recursive: true });
      const spoolRoot = path.join(work, 'identity'), remote = path.join(service.media, name, 'data.bin');
      const entered = Promise.withResolvers(), release = Promise.withResolvers(), changing = Promise.withResolvers();
      const report = { kind, mode, errors: [], cleanupErrors: [] }, files = [];
      const family = kind.replace('-cleanup', ''), faulty = kind.endsWith('-cleanup');
      let injected = false, failureObserved = false, cleanupFailure;
      const observeCleanup = async operation => {
        try { await operation; } catch (error) { failureObserved = true; cleanupFailure = error; }
        assert.equal(failureObserved, true);
        if (family === 'xml') assert.deepEqual(cleanupFailure.errors, [false]);
        else assert.equal(cleanupFailure, false);
        report.cleanupFailure = errorObservation(cleanupFailure);
      };
      const repeatedCleanup = async operation => {
        try { return await operation; } catch (error) { if (!failureObserved || error !== cleanupFailure) throw error; }
      };
      let host, storage, prepared, xml, importing, uploading, transition, cohort, relation, source;
      t.after(async () => {
        release.resolve();
        const attempt = async operation => { try { await operation(); } catch (error) { report.cleanupErrors.push(errorObservation(error)); } };
        await attempt(async () => { relation ??= await repeatedCleanup(importing); }); await attempt(() => uploading);
        await attempt(() => repeatedCleanup(prepared?.close())); await attempt(() => repeatedCleanup(xml?.dispose()));
        await attempt(() => transition); await attempt(() => source?.close());
        if (relation) await attempt(() => links.release(relation));
        await attempt(() => cohort?.release()); await attempt(() => storage?.close()); await attempt(() => host?.close());
        await fs.writeFile(path.join(root, name + '.json'), JSON.stringify(report, null, 2) + '\n');
        assert.equal(path.dirname(work), root); await fs.rm(work, { recursive: true });
        assert.deepEqual(report.cleanupErrors, []);
      });
      host = await openConfiguredPluginHost({ directory: path.join(work, 'host'), onError: error => report.errors.push(errorObservation(error)),
        options: { webdav: { async fetch(url, options) {
          const response = await fetch(url, options);
          if (kind === 'xml-upload' && options.method === 'PUT') { entered.resolve(); await release.promise; }
          return response;
        } } } });
      storage = await createConfiguredStorage(undefined, { plugins: host, environment: { SPOOL_OWNER: service.authorization } });
      const definition = storage.configuration();
      definition.instances.push({ id: 'remote', type: 'webdav', config: { baseUrl: service.baseUrl, credentialRef: 'SPOOL_OWNER', capabilities } },
        { id: 'spool', type: 'local', config: { root: oldRoot, writable: true } });
      definition.mounts.push({ path: '/remote', instanceId: 'remote', root: '/' + name, capabilities },
        { path: '/spool', instanceId: 'spool', capabilities });
      definition.prefixes.push({ identityRoot: spoolRoot, accessRoot: '/spool', style: process.platform === 'win32' ? 'windows' : 'posix',
        purpose: 'application', returnAccess: 'The original spool identity is retained.' });
      await storage.configure(definition);
      const oldAdapter = storage.vfs.resolve('/spool').adapter;
      // Observe native handles without replacing storage resolution, leases,
      // plugin admission, I/O or cleanup with an in-memory implementation.
      const retain = storage.fileSystem.retainDirectory;
      storage.fileSystem.retainDirectory = (...args) => {
        const owner = retain(...args), open = owner.fileSystem.open.bind(owner.fileSystem);
        owner.fileSystem.open = async (...values) => { const file = await open(...values); files.push(file); return file; };
        const method = family === 'xml' ? 'unlink' : 'rm', remove = owner.fileSystem[method].bind(owner.fileSystem);
        owner.fileSystem[method] = async (...values) => {
          await remove(...values);
          if (faulty && !injected) { injected = true; throw false; }
        };
        return owner;
      };
      let expected;
      if (kind.startsWith('xml')) {
        expected = Buffer.from('<Collection><Name>Original spool &amp; complete payload</Name></Collection>');
        xml = await networkXmlSpool(spoolRoot, storage.fileSystem); await xml.sink.write(expected);
        if (kind === 'xml-upload') { uploading = xml.upload(storage.vfs, '/remote/data.bin', { overwrite: true }); void uploading.catch(() => {}); await entered.promise; }
        else prepared = await xml.prepare();
      } else if (family === 'export') {
        const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Audio.Audio');
        Object.assign(item, { Id: parentId, Name: 'Original SQL item', Path: path.join(work, 'song.mp3'), RunTimeTicks: 30000000n });
        cohort = await createNativeItemCohort({ linkedChildren: links }); await cohort.capture(item, { ordinal: 1n });
        const playlist = path.join(work, 'mix.m3u');
        expected = serializePlaylistFile(playlist, [item]);
        prepared = await preparePlaylistFile(playlist, cohort, { fileSystem: storage.fileSystem, spoolRoot });
      } else {
        expected = Buffer.from('#EXTM3U\n#EXTINF:3,First\nsong.mp3\n#EXTINF:3,Duplicate\nsong.mp3\n');
        await fs.writeFile(remote, expected); source = await storage.vfs.openRead('/remote/data.bin');
        const held = (async function* () { yield* source.stream; entered.resolve(); await release.promise; })();
        importing = links.withSession(session => parsePlaylistMemberRelation(held, {
          extension: '.m3u', linkedChildren: links, session, parentId, spoolRoot, fileSystem: storage.fileSystem,
        }));
        void importing.catch(() => {}); await entered.promise;
      }
      const [temporary] = await fs.readdir(oldRoot); assert.ok(temporary);
      const relative = kind.startsWith('xml') ? path.join(temporary, 'frame.xml') : temporary;
      assert.deepEqual(await fs.readFile(path.join(oldRoot, relative)), expected);
      const sentinel = Buffer.from('A new backend owns this same filename.');
      if (mode === 'replace') {
        await fs.mkdir(path.dirname(path.join(newRoot, relative)), { recursive: true }); await fs.writeFile(path.join(newRoot, relative), sentinel);
      }
      const unsubscribe = storage.subscribeBeforeChange(() => changing.resolve());
      if (mode === 'stop') transition = host.setEnabled('local', false);
      else {
        const next = structuredClone(definition); next.instances.find(instance => instance.id === 'spool').config.root = newRoot;
        transition = storage.configure(next);
      }
      void transition.catch(() => {}); await changing.promise; await pending(transition); unsubscribe();
      if (mode === 'stop') await assert.rejects(async () => oldAdapter.stat('/'), { status: 503 });
      else assert.equal(storage.configuration().instances.find(instance => instance.id === 'spool').config.root, newRoot);
      if (family === 'import') {
        release.resolve();
        if (faulty) {
          await observeCleanup(importing);
          const rows = await links.withSession(async session => (await session.client.query(`SELECT count(*) AS count FROM ${links.sets}`)).rows);
          assert.equal(BigInt(rows[0].count), 0n); report.undeliveredRelations = 0;
        } else {
          relation = await importing;
          const rows = await links.page(relation);
          assert.deepEqual(rows.map(row => ({ type: row.Type, path: row.Path })), [{ type: 0, path: 'song.mp3' }, { type: 0, path: 'song.mp3' }]);
          report.importedPaths = rows.map(row => row.Path);
        }
      } else {
        if (kind === 'xml-upload') { release.resolve(); await uploading; await xml.dispose(); }
        else {
          // The reader opens only after ordinary admission was revoked or the
          // dynamic facade already points at the replacement backend.
          await storage.vfs.write('/remote/data.bin', prepared.stream(), { overwrite: true, size: prepared.size });
          const closing = prepared.close(); assert.equal(prepared.close(), closing);
          if (faulty) await observeCleanup(closing); else await closing;
        }
        assert.deepEqual(await fs.readFile(remote), expected);
      }
      await transition;
      assert.deepEqual(await fs.readdir(oldRoot), []);
      assert.ok(files.length > 0); assert.ok(files.every(file => file.fd === -1));
      if (mode === 'replace') assert.deepEqual(await fs.readFile(path.join(newRoot, relative)), sentinel);
      else { assert.equal(host.get('local').status, 'disabled'); await host.setEnabled('local', true); }
      const recovery = await networkXmlSpool(spoolRoot, storage.fileSystem);
      try { await recovery.sink.write(Buffer.from('<Collection><Name>Recovered</Name></Collection>')); await recovery.upload(storage.vfs, '/remote/data.bin', { overwrite: true }); }
      finally { await recovery.dispose(); }
      assert.equal((await fs.readFile(remote)).toString(), '<Collection><Name>Recovered</Name></Collection>');
      assert.deepEqual(await fs.readdir(oldRoot), []);
      if (mode === 'replace') { assert.deepEqual(await fs.readdir(newRoot), [temporary]); assert.deepEqual(await fs.readFile(path.join(newRoot, relative)), sentinel); }
      assert.deepEqual(report.errors, []);
      report.observations = { originalSpoolEmpty: true, nativeHandlesClosed: files.length, preservedNewBackend: mode === 'replace',
        originalBytes: expected.toString('base64'), recoveryBytes: (await fs.readFile(remote)).toString('base64') };
    });
  }
});
