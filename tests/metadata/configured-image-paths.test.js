import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { readdir } from 'node:fs/promises';
import { LibraryService } from '../../src/library/library-service.js';
import { createVirtualPathExpander } from '../../src/library/options.js';
import { ServerConfigurationStore } from '../../src/core/server-configuration-store.js';
import { readConfigurationDocument } from '../../src/core/configuration-xml.js';
import { persistImageMetadata } from '../../src/metadata/persistence.js';
import { postgresTestRow } from '../database/postgres-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { setupChildrenFixture } from './children-fixture.js';
import { currentConfiguredImagePathsNative, recordConfiguredImagePathsCandidate, input, picture, previousPicture,
  hash, failureValue } from './fixtures/configured-image-paths/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const current = await currentConfiguredImagePathsNative();
const id = 'd9430000-0000-0000-0000-000000000041';
const nativeType = 'MediaBrowser.Controller.Entities.Movies.Movie';
const project = (root, value) => value?.replace(root, '$STATE').replaceAll(path.sep, '/');

async function filesUnder(root) {
  const output = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(png|jpg)$/u.test(entry.name)) continue;
    const filename = path.join(entry.parentPath, entry.name), bytes = await testFileSystem.readFile(filename);
    output.push({ path: project(root, filename), bytes: bytes.length, sha256: hash(bytes) });
  }
  return output.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

for (const sample of input) test('postgres: current metadata path boundary ' + sample.name,
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 30000 }, async t => {
    const fixture = await setupChildrenFixture(t), root = fixture.stateRoot;
    const first = path.join(root, 'first-metadata'), second = path.join(root, 'second-metadata');
    const applicationPaths = { programDataPath: root, defaultMetadataPath: first, metadataPath: first,
      cachePath: path.join(root, 'cache') };
    const configuration = new ServerConfigurationStore({ configuration: { ...fixture.configuration, MetadataPath: first,
      ImageSavingConvention: 'Compatible', IsStartupWizardCompleted: true }, applicationPaths,
      metadataFileSystem: testFileSystem, configurationDirectoryPath: path.join(root, 'config') });
    Object.defineProperty(fixture.configurationSource, 'configuration', { get: () => configuration.configuration });
    Object.defineProperty(fixture.library.options, 'metadataPath', { configurable: true, get: () => applicationPaths.metadataPath });
    fixture.library.options.expandPath = createVirtualPathExpander(fixture.library.options);
    const report = { name: sample.name, failures: [], cleanup: {} }, errors = [];
    fixture.host.logger = fixture.host.updates.logger = fixture.host.images.logger = { error: (error, message) => errors.push({ error, message }) };
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let loaded, work, server, coldLibrary, targetOpened = false, openedBytes = null, workObserved = false;
    const failures = [];
    try {
      await testFileSystem.mkdir(second, { recursive: true });
      await configuration.initialize();
      const mediaRoot = sample.boundary === 'repository' ? first : root;
      const itemPath = path.join(mediaRoot, 'media', 'movie.mkv');
      await testFileSystem.mkdir(path.dirname(itemPath), { recursive: true });
      await testFileSystem.writeFile(itemPath, 'Controlled media identity; no probe or encoder is installed.');
      fixture.vfs.mount({ path: '/configured-path-media', instanceId: 'fixture', capabilities: { create: true, replace: true, delete: true } });
      fixture.identityMap.addPrefix({ identityRoot: path.dirname(itemPath), accessRoot: '/configured-path-media/current',
        style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32', returnAccess: 'Controlled physical movie identity.' });
      await fixture.adapter.mkdir('/current'); await fixture.adapter.write('/current/movie.mkv', Buffer.from('Controlled media identity; no probe or encoder is installed.'));
      await fixture.database.insert('BaseItems', postgresTestRow('BaseItems', { Id: id, Type: nativeType,
        Name: 'Original movie', SortName: 'original movie', CleanName: 'original movie', IsInMixedFolder: true,
        Path: sample.boundary === 'repository' ? path.join('%MetadataPath%', 'media', 'movie.mkv') : itemPath,
        ProductionYear: 2026, Data: '{}', MediaType: 'Video', UnratedType: 'Movie',
        DateLastRefreshed: '2026-10-04T12:00:00.0000000Z' }));
      const oldFile = path.join(first, 'library', 'd9', id.replaceAll('-', ''), 'poster.jpg');
      if (sample.boundary === 'copy') {
        await testFileSystem.mkdir(path.dirname(oldFile), { recursive: true }); await testFileSystem.writeFile(oldFile, previousPicture);
        await fixture.database.insert('BaseItemImageInfos', { Id: 'd9430000-0000-0000-0000-000000000042', ItemId: id,
          ImageType: 0, Path: oldFile, DateModified: '2026-10-01T00:00:00.0000000Z', Width: 0, Height: 0, Blurhash: null });
      }
      loaded = await fixture.loadContext(id);
      assert.equal(loaded.item.Path, itemPath);
      loaded.saveLocalMetadataEnabled = false;
      if (sample.boundary === 'download') {
        server = createServer((_request, response) => {
          response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': picture.length }); response.flushHeaders();
          entered.resolve(); void release.promise.then(() => { if (!response.destroyed) response.end(picture); });
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
        work = fixture.host.images.saveRemote(loaded, loaded.context.images,
          { Type: 'Primary', Url: `http://127.0.0.1:${server.address().port}/poster.png` }, { signal: t.signal });
      } else if (sample.boundary === 'copy') {
        const target = path.join(path.dirname(oldFile), 'poster.png');
        loaded.imageAssets.fileSystem = new Proxy(testFileSystem, { get(source, key) {
          if (key === 'writeFile') return async (filename, bytes, options) => {
            await source.writeFile(filename, bytes, options);
            if (filename === target && bytes.byteLength === 0) { entered.resolve(); await release.promise; }
          };
          const value = Reflect.get(source, key, source); return typeof value === 'function' ? value.bind(source) : value;
        } });
        work = fixture.host.images.saveImage(loaded, loaded.context.images,
          { Type: 'Primary', bytes: picture, mimeType: 'image/png' }, { signal: t.signal });
      } else {
        fixture.registry.register({ id: 'configured-path-boundary', name: 'Configured path boundary', providers: [{
          id: 'configured-path-movie', name: 'Configured path boundary', kind: 'remote', itemTypes: ['Movie'],
          async getMetadata() { entered.resolve(); await release.promise;
            return { HasMetadata: true, Item: { Type: 'Movie', Name: 'Original movie', Overview: 'After provider' } }; },
        }] });
        work = fixture.host.refresh(id, { MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'None' });
      }
      void work.catch(() => {});
      const boundary = await Promise.race([entered.promise.then(() => ({ entered: true })),
        work.then(() => ({ completed: true }), error => ({ failed: true, error }))]);
      if (!boundary.entered) { workObserved = true;
        if (boundary.failed) throw boundary.error;
        throw new Error('The selected real I/O boundary was not reached.');
      }
      if (sample.boundary === 'copy') {
        const target = path.join(path.dirname(oldFile), 'poster.png');
        openedBytes = (await testFileSystem.stat(target)).size; assert.equal(openedBytes, 0); targetOpened = true;
      }
      await configuration.replaceConfiguration({ ...configuration.configuration, MetadataPath: second });
      const configurationBytes = await testFileSystem.readFile(configuration.filename);
      assert.equal(readConfigurationDocument(configurationBytes, 'server').value.MetadataPath, second);
      assert.equal(loaded.item.Path, itemPath);
      release.resolve(); try { await work; } finally { workObserved = true; }
      if (sample.boundary !== 'repository') await persistImageMetadata(fixture.store, loaded, loaded.context.images);
      const [stored] = await fixture.database.rows('BaseItems', { where: { Id: id } });
      const rows = await fixture.database.rows('BaseItemImageInfos', { where: { ItemId: id } });
      // A fresh LibraryService owns a new SQL hydration/cache scope. Its
      // current read must preserve an absolute path saved after the switch.
      coldLibrary = new LibraryService({ ...fixture.library.options, store: fixture.store, linkedChildren: fixture.linkedChildren,
        get configuration() { return configuration.configuration; }, metadataPath: applicationPaths.metadataPath });
      const cold = await coldLibrary.getItemRecord(id);
      const coldHandle = await testFileSystem.openRead(cold.Path);
      try { const chunks = []; for await (const chunk of coldHandle.stream) chunks.push(Buffer.from(chunk));
        assert.match(Buffer.concat(chunks).toString(), /Controlled media identity/u); }
      finally { await coldHandle.close(); }
      report.raw = { stored, images: rows, coldPath: cold.Path,
        configurationXml: { base64: configurationBytes.toString('base64'), sha256: hash(configurationBytes) } };
      report.business = { itemPath: project(root, loaded.item.Path), storedPath: project(root, stored.Path), coldPath: project(root, cold.Path),
        Overview: stored.Overview, metadataPath: project(root, applicationPaths.metadataPath),
        images: rows.map(value => ({ path: project(root, value.Path), Width: value.Width, Height: value.Height, type: value.ImageType })),
        files: await filesUnder(root), targetOpened, openedBytes, failure: null };
      assert.deepEqual(report.business, current.native.results.find(value => value.name === sample.name).business);
      assert.deepEqual(errors, []);
    } catch (error) { failures.push(error); }
    finally {
      release.resolve();
      if (work && !workObserved) try { await work; } catch (error) { failures.push(error); }
      for (const [name, close] of [['coldLibrary', () => coldLibrary?.close()], ['context', () => loaded?.dispose()], ['images', () => fixture.host.images.close()],
        ['processor', () => fixture.host.images.processor.close()], ['configuration', () => configuration.close()],
        ['http', () => server && new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); })]]) {
        try { await close(); report.cleanup[name] = true; } catch (error) { failures.push(error); }
      }
      report.failures = failures.map(error => failureValue(error)); report.background = errors.map(value => ({ ...value, error: failureValue(value.error) }));
      try { await recordConfiguredImagePathsCandidate(sample.name, report); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Configured image path operation and cleanup failed.', { cause: failures[0] });
  });
