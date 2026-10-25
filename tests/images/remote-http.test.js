import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createTestRuntime } from '../helpers/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { rawHttp as performHttp } from './http-client.js';
import { imageHttpObservations } from './http-observations.js';
const fixture = new URL('./fixtures/http/', import.meta.url);
const native = JSON.parse(await readFile(new URL('native-remote.json', fixture)));
const input = parseLosslessJson(await readFile(new URL('input.json', fixture), 'utf8'));

test('PostgreSQL remote image GET matches native retry, failure cleanup and immediate persisted metadata', async t => {
  const observations = imageHttpObservations(t, 'remote-image-http');
  const rawHttp = (url, options) => observations.request(url, options, performHttp);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remote-image-http-')), metadataPath = path.join(directory, 'metadata');
  const schema = `remote_images_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const registry = new StorageRegistry(); registry.registerType('memory', () => new MemoryStorageAdapter());
  await registry.createInstance('images', 'memory', {});
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/images', instanceId: 'images', capabilities: { create: true, replace: true, delete: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: path.win32.join(input.reference, 'media'), accessRoot: '/images', style: 'windows', returnAccess: 'isolated remote-image fixture' });
  const runtime = await createTestRuntime({ database, vfs, identityMap, metadataPath, onError: error => observations.onError(error),
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: 'remote-images', imageOptions: { cachePath: directory } });
  const requested = [], originalBytes = await readFile(new URL('poster.png', fixture));
  const upstream = createServer((req, res) => {
    requested.push(req.url);
    if (req.url === '/poster.png') { res.setHeader('Content-Type', 'image/png'); res.end(originalBytes); }
    else { res.statusCode = req.url === '/error' ? 500 : req.url === '/forbidden' ? 403 : 404; res.end(); }
  });
  t.after(async () => {
    await new Promise(resolve => upstream.close(resolve)); await registry.close();
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`); await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await runtime.close(); await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const remoteOrigin = `http://127.0.0.1:${upstream.address().port}`, origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port}`;
  const records = [], events = [];
  runtime.metadataUpdates.on('ItemUpdated', event => events.push(event));
  for (const [index, entry] of native.record.entries()) {
    await database.insert('BaseItems', { ...input.items[0], Id: entry.id, ParentId: null, Name: `Remote image ${index}` });
    await database.insert('BaseItemImageInfos', { Id: entry.id, ItemId: entry.id, Path: entry.urls.replaceAll('http://127.0.0.1:18370', remoteOrigin), ImageType: 0, Width: 0, Height: 0, Blurhash: null, DateModified: '0001-01-01 00:00:00' });
    for (const expected of entry.calls) {
      const before = (await database.rows('BaseItems', { where: { Id: entry.id } }))[0].DateLastSaved;
      const previousEvents = events.length;
      const start = requested.length, response = await rawHttp(origin + `/Items/${entry.id}/Images/Primary`);
      const after = (await database.rows('BaseItems', { where: { Id: entry.id } }))[0].DateLastSaved;
      const images = await database.rows('BaseItemImageInfos', { where: { ItemId: entry.id } });
      const normalizeImage = (image, root, remoteBase) => ({
        ImageType: image.ImageType, ItemId: image.ItemId, Width: image.Width, Height: image.Height,
        Blurhash: image.Blurhash == null ? null : Buffer.from(image.Blurhash).toString('utf8'),
        Path: image.Path.startsWith('http') ? image.Path.replaceAll(remoteBase, '<upstream>')
          : (/^[A-Za-z]:[\\/]/u.test(root) ? path.win32 : path).relative(root, image.Path).replaceAll('\\', '/'),
      });
      const actual = { status: response.status, savedChanged: before !== after, contentType: response.headers['content-type'], length: response.bytes.length,
        sha256: createHash('sha256').update(response.bytes).digest('hex'), requests: requested.slice(start), images: images.map(image => normalizeImage(image, metadataPath, remoteOrigin)) };
      const projected = { status: expected.status, savedChanged: expected.savedChanged, contentType: expected.contentType, length: expected.length, sha256: expected.sha256,
        requests: expected.requests, images: expected.images.map(image => normalizeImage(image, path.win32.join(native.reference, 'data/metadata'), 'http://127.0.0.1:18370')) };
      assert.deepEqual(actual, projected, `${entry.id}:${expected.iteration}`);
      assert.equal(events.length - previousEvents, Number(expected.savedChanged));
      if (images[0] && !images[0].Path.startsWith('http')) {
        assert.ok(Date.now() - Date.parse(images[0].DateModified.replace(' ', 'T') + 'Z') < 10000);
        assert.deepEqual(await readFile(images[0].Path), originalBytes);
      }
      records.push({ id: entry.id, iteration: expected.iteration, compatible: true, actual, expected: projected });
    }
  }
  if (process.env.MEDIAMANAGER_IMAGE_HTTP_EVIDENCE) await writeFile(path.join(process.env.MEDIAMANAGER_IMAGE_HTTP_EVIDENCE, 'postgres-remote-report.json'), JSON.stringify({ compatible: true, matched: records.length, total: records.length,
    normalization: ['Remote fixture origin', 'Instance metadata root', 'Generated image row ID and file modification time', 'DateLastSaved literal times; change/no-change remains compared'], compared: ['Status', 'MIME', 'Length', 'SHA-256', 'Upstream request order and retries', 'Persisted image relation, dimensions and BlurHash', 'DateLastSaved updates and committed ItemUpdated events'], records }, null, 2));
});
