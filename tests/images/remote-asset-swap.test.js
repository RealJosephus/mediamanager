import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { AListAdapter } from '../../plugins/alist/adapter.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { idKey } from '../../src/library/records.js';
import { readItemImageRows } from '../../src/library/image-order.js';
import { nativeDate } from '../../src/sessions/user-data.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { normalizeProbeFileDate } from '../../src/storage/probe-lifecycle.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { startActualAList } from '../storage/helpers/actual-alist.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';

export const requiredValidationServices = ['postgres', 'webdav', 'alist'];

for (const type of ['webdav', 'alist']) test('image reorder recovers a failed publication and commits a retry on actual ' + type, async t => {
  const webdav = type === 'webdav';
  const service = webdav ? await startActualWebDav() : await startActualAList({ connectionString: postgresTestConnectionString });
  const registry = new StorageRegistry();
  let database, runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    finally {
      try { await dropPostgresTestDatabase(database); }
      finally { try { await registry.close(); } finally { await service.stop(); } }
    }
  });
  const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
  const Adapter = webdav ? WebDavAdapter : AListAdapter;
  registry.registerType(type, config => new Adapter(config, {
    resolveCredential: async () => webdav ? service.authorization : service.token,
  }));
  const adapter = await registry.createInstance('images', type, { baseUrl: service.baseUrl, credentialRef: 'fixture', capabilities });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/images', instanceId: 'images', root: webdav ? '/' : '/Synthetic', capabilities });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: service.media, accessRoot: '/images',
    style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Owned image storage' });
  const directory = path.join(service.media, 'backdrops'), state = path.join(service.root, 'candidate-state');
  await mkdir(directory);
  const names = ['backdrop.png', 'backdrop1.png'], files = names.map(name => path.join(directory, name));
  const bytes = await Promise.all([[16, 12, 'red'], [24, 18, 'blue']].map(([width, height, background]) =>
    sharp({ create: { width, height, background, channels: 3 } }).png().toBuffer()));
  for (const [index, filename] of files.entries()) {
    await writeFile(filename, bytes[index]);
    await utimes(filename, 1735689600 + index, 1735689600 + index);
  }
  const itemId = randomUUID(), token = idKey(randomUUID());
  database = await createPostgresTestDatabase(null, 'remote_image_swap');
  await database.insert('ApiKeys', { Name: 'Image swap', AccessToken: token,
    DateCreated: '2026-11-20 00:00:00', DateLastActivity: '2026-11-20 00:00:00' });
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: itemId, Name: 'Remote image swap',
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Path: path.join(directory, 'movie.mkv'), MediaType: 'Video', Data: '{}' }));
  for (const [index, filename] of files.entries()) await database.insert('BaseItemImageInfos', postgresTestRow('BaseItemImageInfos', {
    Id: randomUUID(), ItemId: itemId, ImageType: 2, Path: filename, Width: [16, 24][index], Height: [12, 18][index],
    DateModified: `2025-01-01 00:00:0${index}`,
  }));
  const errors = [];
  runtime = await createTestRuntime({ database, vfs, identityMap, metadataPath: state,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: idKey(randomUUID()), onError: error => errors.push(error) });
  const port = runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port;
  const request = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/Items/${itemId}/Images/Backdrop/0/Index?newIndex=1`, {
      method: 'POST', headers: { 'X-Emby-Token': token }, signal: t.signal,
    });
    return { status: response.status, body: await response.text() };
  };
  const images = () => database.withConnection(db => readItemImageRows(db, itemId));
  const before = await images();
  const updates = [];
  runtime.metadataUpdates.on('ItemUpdated', event => updates.push(event));
  const rename = adapter.rename.bind(adapter), rejection = Object.assign(new Error('Lost image move response.'), { code: 'unavailable' });
  let moves = 0;
  adapter.rename = async (...args) => {
    await rename(...args);
    if (++moves === 3) throw rejection;
  };
  const failed = await request();
  assert.equal(failed.status, 500, JSON.stringify({ failed, errors: errors.map(error => error.message) }));
  assert.equal(moves, 6);
  assert.deepEqual(await Promise.all(files.map(filename => readFile(filename))), bytes);
  assert.deepEqual((await readdir(directory)).sort(), names);
  assert.deepEqual(await images(), before);
  assert.deepEqual(updates, []);
  adapter.rename = rename;

  const result = await request();
  assert.equal(result.status, 204, JSON.stringify({ result, errors: errors.map(error => error.message) }));
  assert.deepEqual(await Promise.all(files.map(filename => readFile(filename))), [bytes[1], bytes[0]]);
  assert.deepEqual((await readdir(directory)).sort(), names);
  const after = await images();
  assert.deepEqual(after.map(row => [row.Id, row.Path]), before.map(row => [row.Id, row.Path]));
  assert.deepEqual(after.map(row => [row.Width, row.Height]), [[24, 18], [16, 12]]);
  const times = await Promise.all(names.map(async name => nativeDate(normalizeProbeFileDate((await vfs.stat('/images/backdrops/' + name)).modified))));
  assert.deepEqual(after.map(row => row.DateModified), times);
  assert.deepEqual(updates.map(event => [idKey(event.Item.Id), event.UpdateReason]), [[idKey(itemId), 4]]);
});
