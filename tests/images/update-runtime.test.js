import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createTestRuntime } from '../helpers/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { nativeDate } from '../../src/sessions/user-data.js';
import { rawHttp } from './http-client.js';
const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));

test('PostgreSQL remote image update saves NFO through VFS and notifies after commit', async t => {
  const schema = `image_update_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'image-update-'));
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('fixture', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: { create: true, replace: true, delete: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\Update', accessRoot: '/fixture', style: 'windows', returnAccess: 'isolated metadata update' });
  const [itemId, folderId, collectionId] = [1, 2, 3].map(value => `AAAABBBB-0000-0000-0000-${String(value).padStart(12, '0')}`);
  const [rootId, userRootId] = [4, 5].map(value => `AAAABBBB-0000-0000-0000-${String(value).padStart(12, '0')}`);
  for (const [Id, Type] of [[rootId, 'AggregateFolder'], [userRootId, 'UserRootFolder']]) await database.insert('BaseItems', {
    ...blank('BaseItems'), Id, Type: `MediaBrowser.Controller.Entities.${Type}`, Name: Type, IsFolder: true, Data: '{}' });
  await database.insert('BaseItems', { ...blank('BaseItems'), Id: folderId, Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Fixture', Path: 'Z:\\Update', ParentId: rootId, IsFolder: true, Data: '{}' });
  await database.insert('BaseItems', { ...blank('BaseItems'), Id: collectionId, Type: 'MediaBrowser.Controller.Entities.CollectionFolder', Name: 'Movies', ParentId: userRootId, IsFolder: true,
    Data: JSON.stringify({ PhysicalFolderIds: [folderId], PhysicalLocationsList: ['Z:\\Update'] }) });
  await database.insert('BaseItems', { ...blank('BaseItems'), Id: itemId, Type: 'MediaBrowser.Controller.Entities.Movies.Movie', Name: 'Image update', Path: 'Z:\\Update\\movie.mkv', ParentId: folderId, TopParentId: folderId, IsInMixedFolder: true, MediaType: 'Video', Data: '{}', DateLastSaved: '2000-01-01 00:00:00' });
  const errors = [], events = [], persisted = [];
  const runtime = await createTestRuntime({ database, vfs, identityMap, metadataPath: path.join(directory, 'metadata'), configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: 'image-update',
    libraryOptions: new Map([[collectionId.replaceAll('-', '').toLowerCase(), { SaveLocalMetadata: true, MetadataSavers: ['Nfo'] }]]), onError: error => errors.push(error.message) });
  const context = await runtime.metadata.loadContext(itemId);
  try {
  assert.equal(context.context.spoolRoot, await realpath(path.join(directory, 'metadata', 'metadata-spool')),
    'the VFS-only runtime uses its declared metadata state root');
  assert.deepEqual(context.collectionFolders.map(item => item.Id), [collectionId]); assert.equal(context.saveLocalMetadataEnabled, true);
  } finally { await context.dispose(); }
  const png = await readFile(new URL('./fixtures/http/poster.png', import.meta.url));
  let hits = 0;
  const upstream = createServer((_request, response) => { hits++; response.setHeader('Content-Type', 'image/png'); response.end(png); });
  t.after(async () => {
    await new Promise(resolve => upstream.close(resolve));
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`); await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await runtime.close(); await storage.close(); await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  await database.insert('BaseItemImageInfos', { Id: itemId, ItemId: itemId, ImageType: 0, Path: `http://127.0.0.1:${upstream.address().port}/poster.png`, Width: 0, Height: 0, Blurhash: null, DateModified: '0001-01-01 00:00:00' });
  runtime.metadataUpdates.on('ItemUpdated', event => { events.push(event); persisted.push(runtime.store.run(db => db.rows('BaseItems', { where: { Id: itemId } }))); });
  const response = await rawHttp(`http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port}/Items/${itemId}/Images/Primary`);
  assert.equal(response.status, 200, errors.join('\n')); assert.deepEqual(response.bytes, png);
  assert.equal(events.length, 1); assert.equal(events[0].UpdateReason, 4); assert.equal(events[0].Parent.Id, folderId);
  const committed = (await persisted[0])[0]; assert.equal(committed.DateLastSaved, nativeDate(events[0].Item.DateLastSaved));
  assert.notEqual(committed.DateLastSaved, '2000-01-01 00:00:00');
  const handle = await vfs.openRead('/fixture/movie.nfo');
  try { const chunks = []; for await (const chunk of handle.stream) chunks.push(chunk); const text = Buffer.concat(chunks).toString(); assert.match(text, /<title>Image update<\/title>/); assert.match(text, /movie-poster\.png/); }
  finally { await handle.close(); }
  assert.equal((await rawHttp(`http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port}/Items/${itemId}/Images/Primary`)).status, 200);
  assert.equal(events.length, 1); assert.equal(hits, 1); assert.deepEqual(errors, []);
  assert.deepEqual(await readdir(path.join(directory, 'metadata', 'metadata-spool')), [], 'the single NFO save releases its prepared stream');
});
