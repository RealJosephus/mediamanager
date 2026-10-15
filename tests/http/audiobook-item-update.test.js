import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fileSystem from 'node:fs/promises';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition } from '../../src/database/model.js';
import { createRuntime } from '../../src/runtime.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { bindItemUpdate } from '../../src/http/item-update-binding.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { stringifyNativeJson } from '../../src/core/json.js';

const lifecycleNative = JSON.parse(await readFile(new URL('../metadata/fixtures/editor-lifecycle/native.json', import.meta.url), 'utf8'));
const lifecycleInput = JSON.parse(await readFile(new URL('../metadata/fixtures/editor-lifecycle/input.json', import.meta.url), 'utf8'));

const ids = Object.fromEntries(['folder', 'collection', 'movie', 'hidden', 'series', 'season', 'episode', 'direct', 'linked', 'userRoot']
  .map((name, index) => [name, `82000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`]));
const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
const row = (name, Type, values = {}) => ({ ...blank('BaseItems'), Id: ids[name], Type: `MediaBrowser.Controller.Entities.${Type}`,
  Name: name, CleanName: name, SortName: name, Data: '{}', ...values });
const read = async (vfs, pathname) => {
  const handle = await vfs.openRead(pathname);
  try { const chunks = []; for await (const bytes of handle.stream) chunks.push(bytes); return Buffer.concat(chunks); }
  finally { await handle.close(); }
};
const body = text => bindItemUpdate(parseLosslessJson(text), text);

async function setup(t, { writable = true, saveLocal = true } = {}) {
  const schema = `item_edit_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  const instanceRoot = await mkdtemp(path.join(os.tmpdir(), 'item-edit-'));
  const programDataPath = path.join(instanceRoot, 'data'), configurationDirectoryPath = path.join(instanceRoot, 'config');
  await mkdir(path.join(programDataPath, 'data'), { recursive: true }); await mkdir(configurationDirectoryPath);
  await writeFile(path.join(programDataPath, 'data', 'device.txt'), 'a'.repeat(32));
  const systemXml = '<ServerConfiguration><ServerName>ItemEdit</ServerName><ContentTypes/><!-- retained --><Extension key="a&gt;b"><![CDATA[<ContentTypes>leave untouched</ContentTypes>]]></Extension></ServerConfiguration>';
  await writeFile(path.join(configurationDirectoryPath, 'system.xml'), systemXml);
  await writeFile(path.join(configurationDirectoryPath, 'network.xml'), '<NetworkConfiguration/>');
  const storage = new StorageRegistry(); storage.registerType('fixture', () => new MemoryStorageAdapter());
  const adapter = await storage.createInstance('fixture', 'fixture', {});
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/media', instanceId: 'fixture', capabilities: writable ? { create: true, replace: true, delete: true, conditionalWrite: true } : {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\EditMedia', accessRoot: '/media', style: 'windows', returnAccess: 'isolated metadata edit fixture' });
  const libraryOptions = new Map([[ids.collection.replaceAll('-', ''), { SaveLocalMetadata: saveLocal, MetadataSavers: ['Nfo'] }]]);
  const errors = [];
  const runtime = await createRuntime({ database, programDataPath, configurationDirectoryPath, configuration: { UICulture: 'en-US', MetadataCountryCode: 'US', IsStartupWizardCompleted: true, ContentTypes: [] },
    serverId: 'item-edit-test', vfs, identityMap, libraryOptions, onError: error => errors.push(error) });
  t.after(async () => {
    await runtime.close(); await storage.close();
    const cleanup = await PostgresDatabase.open({ connectionString, schema });
    try { await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`); }
    finally { await cleanup.close(); }
    await rm(instanceRoot, { recursive: true, force: true });
  });
  const roots = await database.rows('BaseItems');
  const root = roots.find(item => item.Type === 'MediaBrowser.Controller.Entities.AggregateFolder');
  const userRoot = await database.insert('BaseItems', row('userRoot', 'UserRootFolder', { IsFolder: true }));
  await database.insert('BaseItems', row('folder', 'Folder', { IsFolder: true, Path: 'Z:\\EditMedia', ParentId: root.Id }));
  await database.insert('BaseItems', row('collection', 'CollectionFolder', { IsFolder: true, ParentId: userRoot.Id,
    Data: JSON.stringify({ PhysicalFolderIds: [ids.folder], PhysicalLocationsList: ['Z:\\EditMedia'], CollectionType: 'movies' }) }));
  await database.insert('BaseItems', row('movie', 'Movies.Movie', { Path: 'Z:\\EditMedia\\movie.mkv', ParentId: ids.folder, TopParentId: ids.folder,
    MediaType: 'Video', IsInMixedFolder: true, RunTimeTicks: 9007199254740993n, DateCreated: '2020-01-01 00:00:00',
    Data: '{"VideoType":"VideoFile","Extension":{"precision":9007199254740993}}' }));
  await database.insert('BaseItems', row('hidden', 'Movies.Movie', { Path: 'Z:\\EditMedia\\hidden.mkv', ParentId: ids.folder, TopParentId: ids.folder,
    MediaType: 'Video', Tags: 'secret', IsInMixedFolder: true }));
  await adapter.write('/movie.mkv', Buffer.from('media'));
  await adapter.write('/hidden.mkv', Buffer.from('hidden'));
  const created = await runtime.users.createUser({ Name: 'EditAdmin', Password: 'admin-password' });
  const originalUser = await runtime.users.getUser(created.Id);
  await runtime.users.updatePolicy(created.Id, { ...originalUser.Policy, IsAdministrator: true, EnableAllFolders: true, BlockedTags: ['secret'] });
  const user = await runtime.users.getUser(created.Id);
  const login = await runtime.authentication.login({ Username: 'EditAdmin', Pw: 'admin-password' }, {
    Client: 'ItemEditTest', Device: 'Test', DeviceId: 'item-edit-admin', Version: '1'
  }, { remoteEndPoint: '127.0.0.1' });
  const reader = await runtime.users.createUser({ Name: 'Reader', Password: 'reader-password' });
  const readerLogin = await runtime.authentication.login({ Username: 'Reader', Pw: 'reader-password' }, {
    Client: 'ItemEditTest', Device: 'Test', DeviceId: 'item-edit-reader', Version: '1'
  }, { remoteEndPoint: '127.0.0.1' });
  const key = await runtime.apiKeys.create('Item edit test');
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  const post = (id, json, token = login.AccessToken) => fetch(`${origin}/Items/${id}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `MediaBrowser Client="ItemEditTest", Device="Test", DeviceId="item-edit-device", Version="1", Token="${token}"` } : {}) }, body: json });
  return { runtime, database, adapter, vfs, user, post, login, readerLogin, key, errors, instanceRoot, configurationDirectoryPath, systemXml, origin };
}


const bookInput = JSON.parse(await readFile(new URL('../metadata/fixtures/audiobook-item-update/input.json', import.meta.url), 'utf8'));
const bookNative = parseLosslessJson(await readFile(new URL('../metadata/fixtures/audiobook-item-update/native.json', import.meta.url), 'utf8'));
const bookId = '82000000-0000-0000-0000-000000000099';
for (const sample of bookInput) test('PostgreSQL: actual metadata HTTP persists native ' + sample.name,
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const { runtime, database, post } = await setup(t, { saveLocal: false });
    const expected = bookNative.results.find(value => value.name === sample.name);
    await database.insert('BaseItems', { ...blank('BaseItems'), Id: bookId,
      Type: 'MediaBrowser.Controller.Entities.' + sample.type, Name: 'Stored title', CleanName: 'stored title', SortName: 'stored title',
      Path: 'Z:\\EditMedia\\book', ParentId: ids.folder, TopParentId: ids.folder, IsLocked: true,
      MediaType: sample.type === 'AudioBook' ? 'Audio' : 'Unknown',
      Artists: sample.type === 'AudioBook' ? '' : null, AlbumArtists: sample.type === 'AudioBook' ? '' : null,
      Genres: 'Old genre', Tags: 'Old|keep', Studios: 'Old studio', ProductionLocations: 'Old country', Data: 'bad{' });
    const before = await database.rows('BaseItems', { where: { Id: bookId } });
    const events = []; runtime.metadataUpdates.on('ItemUpdated', value => events.push(value));
    const response = await post(bookId, sample.json);
    assert.equal(response.status, expected.error ? 500 : 204);
    if (expected.error) {
      assert.deepEqual(await database.rows('BaseItems', { where: { Id: bookId } }), before);
      assert.deepEqual(events, []); return;
    }
    const [stored] = await database.rows('BaseItems', { where: { Id: bookId } });
    assert.equal(stored.Data, null);
    for (const field of ['Artists', 'AlbumArtists']) assert.equal(stored[field],
      sample.type === 'AudioBook' ? expected.value[field].join('|') : null, field);
    assert.equal(stored.Album, expected.value.Album ?? null);
    const values = await database.rows('ItemValues');
    const maps = await database.rows('ItemValuesMap', { where: { ItemId: bookId } });
    const artists = maps.map(map => values.find(value => value.ItemValueId === map.ItemValueId)).filter(value => value.Type < 2)
      .map(value => [value.Type, value.Value]).sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1], 'en'));
    const expectedArtists = sample.type === 'AudioBook' ? [...expected.value.Artists.map(value => [0, value]),
      ...expected.value.AlbumArtists.map(value => [1, value])].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1], 'en')) : [];
    assert.deepEqual(artists, expectedArtists);
    assert.equal(events.length, 1); assert.equal(events[0].UpdateReason, 16);
  });
