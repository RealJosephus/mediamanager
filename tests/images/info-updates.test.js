import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, readdir, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../../src/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { nativeDate } from '../../src/sessions/user-data.js';
import { rawHttp } from './http-client.js';

const fixture = new URL('./fixtures/http/', import.meta.url);
const input = parseLosslessJson(await readFile(new URL('input.json', fixture), 'utf8'));
const original = await readFile(new URL('poster.png', fixture));
const folder = 'E2222222-2222-2222-2222-222222222220', collection = 'E2222222-2222-2222-2222-222222222221';
const movie = 'E2222222-2222-2222-2222-222222222222', logo = 'E2222222-2222-2222-2222-222222222223';
const root = 'E2222222-2222-2222-2222-222222222224', userRoot = 'E2222222-2222-2222-2222-222222222225';

test('PostgreSQL image info commits remote localization and removal through NFO, repository update and events', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'image-info-update-'));
  const schema = `info_updates_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await storage.createInstance('fixture', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: { create: true, replace: true, delete: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\Fixture', accessRoot: '/fixture', style: 'windows', returnAccess: 'isolated image-info regression' });
  const errors = [];
  const runtime = await createRuntime({ database, vfs, identityMap, metadataPath: path.join(directory, 'metadata'), onError: error => errors.push(error.stack ?? error.message),
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: 'image-info-update',
    libraryOptions: new Map([[collection.replaceAll('-', '').toLowerCase(), { SaveLocalMetadata: true, MetadataSavers: ['Nfo'] }]]) });
  const requested = [], upstream = createServer((req, res) => {
    requested.push(req.url);
    if (req.url.startsWith('/poster')) {
      const send = () => { res.setHeader('Content-Type', 'image/png'); res.end(original); };
      if (/concurrent|mixed/.test(req.url)) setTimeout(send, 100); else send();
    }
    else { res.statusCode = req.url === '/error' ? 500 : req.url === '/forbidden' ? 403 : 404; res.end(); }
  });
  t.after(async () => {
    await new Promise(resolve => upstream.close(resolve));
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`); await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await runtime.close(); await storage.close(); await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const remoteOrigin = `http://127.0.0.1:${upstream.address().port}`, origin = `http://127.0.0.1:${runtime.server.address().port}`;
  for (const [Id, Type] of [[root, 'AggregateFolder'], [userRoot, 'UserRootFolder']]) await database.insert('BaseItems', {
    ...input.items[0], Id, Type: `MediaBrowser.Controller.Entities.${Type}`, Name: Type, Path: null, ParentId: null, TopParentId: null, IsFolder: true, Data: '{}' });
  await database.insert('BaseItems', { ...input.items[0], Id: folder, Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Fixture', Path: 'Z:\\Fixture', ParentId: root, IsFolder: true, Data: '{}' });
  await database.insert('BaseItems', { ...input.items[0], Id: collection, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Movies', Path: null, ParentId: userRoot, IsFolder: true,
    Data: JSON.stringify({ PhysicalFolderIds: [folder], PhysicalLocationsList: [] }) });
  await database.insert('BaseItems', { ...input.items[0], Id: movie, Name: 'Info update movie', Path: 'Z:\\Fixture\\movie.mkv', ParentId: folder, TopParentId: folder, IsInMixedFolder: true, DateLastSaved: '2020-01-01 00:00:00' });
  // Query-only ancestry and PhysicalFolderIds cannot opt an unrelated actual
  // physical path into a library's NFO savers. Exercise that negative branch
  // before providing the native path membership for the original assertions.
  await database.insert('AncestorIds', { ItemId: movie, ParentItemId: collection });
  await database.update('BaseItems', { Id: movie }, { TopParentId: collection });
  const unrelated = await runtime.metadata.loadContext(movie);
  try {
  const spoolRoot = await realpath(path.join(directory, 'metadata', 'metadata-spool'));
  assert.equal(unrelated.context.spoolRoot, spoolRoot, 'the VFS-only runtime uses its declared metadata state root');
  assert.deepEqual(unrelated.collectionFolders, []); assert.equal(unrelated.saveLocalMetadataEnabled, false);
  assert.deepEqual(await runtime.metadata.saver.save(movie, 'ImageUpdate'), []);
  await assert.rejects(vfs.openRead('/fixture/movie.nfo'), error => error.code === 'not-found');
  assert.equal((await database.rows('BaseItems', { where: { Id: movie } }))[0].DateLastSaved, '2020-01-01 00:00:00');
  } finally { await unrelated.dispose(); }
  await database.update('BaseItems', { Id: movie }, { TopParentId: folder });
  await database.update('BaseItems', { Id: collection }, { Data: JSON.stringify({ PhysicalFolderIds: [folder], PhysicalLocationsList: ['Z:\\Fixture'] }) });
  const related = await runtime.metadata.loadContext(movie);
  try {
  assert.deepEqual(related.collectionFolders.map(item => item.Id), [collection]); assert.equal(related.saveLocalMetadataEnabled, true);
  } finally { await related.dispose(); }
  const user = await runtime.users.createUser({ Name: 'Image info user' });
  const login = await rawHttp(origin + '/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="Image info", Device="Test", DeviceId="info", Version="1"' }, body: JSON.stringify({ Username: user.Name, Pw: '' }) });
  const token = JSON.parse(login.bytes).AccessToken; assert.ok(token);
  const headers = { Authorization: `MediaBrowser Token="${token}"` };
  const info = () => rawHttp(origin + `/Items/${movie}/Images`, { headers });
  const primary = () => rawHttp(origin + `/Items/${movie}/Images/Primary`, { headers });
  const row = async () => (await database.rows('BaseItems', { where: { Id: movie } }))[0];
  const images = () => database.rows('BaseItemImageInfos', { where: { ItemId: movie } });
  const trace = [], committed = [], events = [];
  const write = adapter.write.bind(adapter); adapter.write = async (pathname, bytes, options) => { const result = await write(pathname, bytes, options); if (pathname.endsWith('.nfo')) trace.push('nfo'); return result; };
  const persist = runtime.images.persist.bind(runtime.images);
  runtime.images.persist = async (...args) => { await persist(...args); committed.push({ date: (await row()).DateLastSaved, images: await images() }); trace.push('commit'); };
  runtime.metadataUpdates.on('ItemUpdated', event => {
    assert.equal(trace.at(-1), 'commit'); assert.equal(committed.at(-1).date, nativeDate(event.Item.DateLastSaved));
    events.push({ date: event.Item.DateLastSaved, images: committed.at(-1).images }); trace.push('event');
  });
  let ticks = 0; runtime.metadataUpdates.now = () => `2026-09-27T00:00:${String(ticks++).padStart(2, '0')}.0000000Z`;
  const remoteImage = (Id, ImageType, Path) => ({ Id, ItemId: movie, ImageType, Path, DateModified: '0001-01-01 00:00:00', Width: 0, Height: 0, Blurhash: null });
  await database.insert('BaseItemImageInfos', remoteImage(movie, 0, remoteOrigin + '/poster.png'));
  await database.insert('BaseItemImageInfos', remoteImage(logo, 4, `${remoteOrigin}/missing|${remoteOrigin}/forbidden`));
  assert.equal((await info()).status, 200, errors.join('\n'));
  assert.deepEqual(requested, ['/poster.png', '/missing', '/forbidden']);
  assert.equal(events.length, 2); assert.equal(trace[0], 'nfo');
  assert.equal((await images()).length, 1); assert.equal((await images())[0].Width, 8); assert.equal((await images())[0].Height, 6);
  assert.ok((await images())[0].Blurhash.length > 0); assert.equal((await row()).DateLastSaved, nativeDate(events.at(-1).date));
  const nfoHandle = await vfs.openRead('/fixture/movie.nfo');
  try { const chunks = []; for await (const bytes of nfoHandle.stream) chunks.push(bytes); const xml = Buffer.concat(chunks).toString(); assert.match(xml, /Info update movie/); assert.match(xml, /movie-poster\.png/); assert.doesNotMatch(xml, /\/missing|\/forbidden/); }
  finally { await nfoHandle.close(); }
  const saved = (await row()).DateLastSaved;
  assert.equal((await info()).status, 200); assert.equal(events.length, 2); assert.equal((await row()).DateLastSaved, saved);

  // A retryable HTTP failure keeps the relation and has no item-update side effects.
  await database.insert('BaseItemImageInfos', remoteImage(logo, 4, remoteOrigin + '/error'));
  assert.equal((await info()).status, 200); assert.equal(events.length, 2); assert.equal((await row()).DateLastSaved, saved);
  assert.equal((await images()).find(image => image.ImageType === 4).Path, remoteOrigin + '/error');
  await database.delete('BaseItemImageInfos', { Id: (await images()).find(image => image.ImageType === 4).Id });

  // Parallel reads of one remote image share the committed association instead of
  // letting the second stale snapshot fail its optimistic image-row check.
  await database.update('BaseItemImageInfos', { Id: (await images()).find(image => image.ImageType === 0).Id }, { Path: remoteOrigin + '/poster-concurrent.png', DateModified: '0001-01-01 00:00:00', Width: 0, Height: 0, Blurhash: null });
  let start = requested.length, eventCount = events.length;
  const parallel = await Promise.all([primary(), primary()]);
  assert.deepEqual(parallel.map(response => response.status), [200, 200]);
  assert.deepEqual(parallel.map(response => response.bytes), [original, original]);
  assert.deepEqual(requested.slice(start), ['/poster-concurrent.png']); assert.equal(events.length, eventCount + 1);
  assert.equal((await images()).find(image => image.ImageType === 0).Path.startsWith('http'), false);

  // Image info and image bytes use the same item update queue. Either request may
  // win, while the waiter reloads the local row and both responses still succeed.
  await database.update('BaseItemImageInfos', { Id: (await images()).find(image => image.ImageType === 0).Id }, { Path: remoteOrigin + '/poster-mixed.png', DateModified: '0001-01-01 00:00:00', Width: 0, Height: 0, Blurhash: null });
  start = requested.length; eventCount = events.length;
  const [mixedInfo, mixedImage] = await Promise.all([info(), primary()]);
  assert.equal(mixedInfo.status, 200); assert.equal(mixedImage.status, 200); assert.deepEqual(mixedImage.bytes, original);
  assert.deepEqual(requested.slice(start), ['/poster-mixed.png']); assert.equal(events.length, eventCount + 1);

  // File writes precede repository persistence; a conflict must not publish a commit event.
  await database.insert('BaseItemImageInfos', remoteImage(logo, 4, remoteOrigin + '/poster-conflict.png'));
  runtime.images.persist = async (...args) => { await database.update('BaseItemImageInfos', { Id: (await images()).find(image => image.ImageType === 4).Id }, { Width: 123 }); return persist(...args); };
  const beforeConflict = (await row()).DateLastSaved; eventCount = events.length;
  assert.equal((await info()).status, 409); assert.equal(events.length, eventCount); assert.equal((await row()).DateLastSaved, beforeConflict);
  assert.deepEqual(await readdir(path.join(directory, 'metadata', 'metadata-spool')), [], 'successful and conflicting saves release every prepared NFO spool');
});
