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
import { knownAncestorIgnoreIdentityMap } from '../library/ignore-namespace-fixture.js';

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
  const ignoreIdentityMap = await knownAncestorIgnoreIdentityMap({ registry: storage, vfs, identityMap,
    identityRoots: ['Z:\\EditMedia'], adapterType: 'fixture' });
  const libraryOptions = new Map([[ids.collection.replaceAll('-', ''), { SaveLocalMetadata: saveLocal, MetadataSavers: ['Nfo'] }]]);
  const errors = [];
  const runtime = await createRuntime({ database, programDataPath, configurationDirectoryPath, configuration: { UICulture: 'en-US', MetadataCountryCode: 'US', IsStartupWizardCompleted: true, ContentTypes: [] },
    serverId: 'item-edit-test', vfs, identityMap, ignoreIdentityMap, libraryOptions, onError: error => errors.push(error) });
  t.after(async () => {
    const failures = [];
    for (const release of [() => runtime.close(), () => storage.close(), () => database.close(), async () => {
      const cleanup = await PostgresDatabase.open({ connectionString, schema });
      try { await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await cleanup.client.query(`DROP SCHEMA IF EXISTS "${schema}__mm" CASCADE`); }
      finally { await cleanup.close(); }
    }, async () => {
      assert.equal(path.dirname(instanceRoot), os.tmpdir());
      await rm(instanceRoot, { recursive: true, force: true });
    }]) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Metadata edit fixture cleanup failed.');
  });
  const roots = await database.rows('BaseItems');
  const root = roots.find(item => item.Type === 'MediaBrowser.Controller.Entities.AggregateFolder');
  const userRoot = await database.insert('BaseItems', row('userRoot', 'UserRootFolder', { IsFolder: true }));
  runtime.library.options.userRoot = userRoot;
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

{
  const dialect = 'postgres';
  const options = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };
  test(`${dialect}: metadata HTTP edits preserve precision, relations, sidecars and elevation`, options, async t => {
    const { runtime, database, vfs, post, readerLogin, key } = await setup(t);
    const events = []; runtime.metadataUpdates.on('ItemUpdated', event => events.push(event));
    const json = '{"Name":"Edited title","ForcedSortName":"Forced","Genres":["Drama","DRAMA"],"Tags":[" Tag ","tag"],"People":[{"Name":" Actor ","Role":" Lead ","Type":"Actor","SortOrder":4}],"ProviderIds":{"Tmdb":" 42 ","UnknownProvider":" preserved "},"LockedFields":["Name","Tags"],"DateCreated":"2024-01-02T03:04:05.1234567Z","PremiereDate":"2023-03-04T00:00:00Z","AspectRatio":"16:9","RunTimeTicks":10,"LockData":true}';
    assert.equal((await post(ids.movie, json, readerLogin.AccessToken)).status, 403);
    assert.equal((await post(ids.movie, json, null)).status, 401);
    assert.equal((await post(ids.hidden, json)).status, 404);
    assert.equal((await post(ids.movie, '{"IndexNumber":"bad","IndexNumber":1}')).status, 400);
    assert.equal((await post(ids.movie, 'null')).status, 400);
    assert.equal((await post(ids.movie, json)).status, 204);
    const item = (await database.rows('BaseItems', { where: { Id: ids.movie } }))[0];
    assert.equal(item.Name, 'Edited title'); assert.equal(item.SortName, 'forced');
    assert.equal(item.DateCreated, '2024-01-02 03:04:05.1234567');
    assert.equal(item.RunTimeTicks, 9007199254740993n); assert.equal(item.IsLocked, true);
    assert.equal(item.Genres, 'Drama'); assert.equal(item.Tags, 'Tag');
    const itemData = parseLosslessJson(item.Data);
    assert.equal(Object.hasOwn(itemData, 'Extension'), false, 'typed native JSON drops undeclared extension data');
    assert.equal(itemData.AspectRatio, '16:9');
    const people = await database.rows('PeopleBaseItemMap', { where: { ItemId: ids.movie } });
    assert.equal(people.length, 1); assert.equal(people[0].Role, 'Lead'); assert.equal(people[0].SortOrder, null);
    assert.equal((await database.rows('Peoples', { where: { Id: people[0].PeopleId } }))[0].Name, 'Actor');
    assert.deepEqual((await database.rows('BaseItemMetadataFields', { where: { ItemId: ids.movie } })).map(row => row.Id).sort(), [4, 5]);
    assert.deepEqual((await database.rows('BaseItemProviders', { where: { ItemId: ids.movie } })).map(row => [row.ProviderId, row.ProviderValue]).sort(), [['Tmdb', '42'], ['UnknownProvider', 'preserved']]);
    assert.ok((await vfs.list('/media')).entries.some(entry => entry.name === 'movie.nfo'), JSON.stringify((await vfs.list('/media')).entries.map(entry => entry.name)));
    const xml = (await read(vfs, '/media/movie.nfo')).toString();
    assert.match(xml, /<title>Edited title<\/title>/u); assert.match(xml, /<name>Actor<\/name>/u); assert.match(xml, /<role>Lead<\/role>/u);
    assert.equal(events.length, 1); assert.equal(events[0].UpdateReason, 16);
    assert.equal((await post(ids.hidden, '{"Name":"API key edit"}', key.AccessToken)).status, 204);
    assert.equal((await database.rows('BaseItems', { where: { Id: ids.hidden } }))[0].Name, 'API key edit');
  });

  test(`${dialect}: read-only NFO rejects edits before database or event changes`, options, async t => {
    const { runtime, database, post } = await setup(t, { writable: false });
    const before = await database.rows('BaseItems');
    const events = []; runtime.metadataUpdates.on('ItemUpdated', event => events.push(event));
    assert.equal((await post(ids.movie, '{"Name":"Rejected","People":[{"Name":"Rejected actor","Type":"Actor"}]}')).status, 500);
    assert.deepEqual(await database.rows('BaseItems'), before); assert.deepEqual(events, []);
    assert.deepEqual(await database.rows('PeopleBaseItemMap', { where: { ItemId: ids.movie } }), []);
  });

  test(`${dialect}: a repeated edit with an existing read-only NFO rejects people before their independent commit`, options, async t => {
    const { runtime, database, vfs, user } = await setup(t);
    await runtime.itemUpdates.update(ids.movie, body('{"Name":"Saved title"}'), { user });
    const capability = vfs.capabilities.bind(vfs);
    vfs.capabilities = pathname => ({ ...capability(pathname), create: false, replace: false, delete: false });
    const before = await database.rows('BaseItems'), people = await database.rows('Peoples'), nfo = await read(vfs, '/media/movie.nfo');
    await assert.rejects(runtime.itemUpdates.update(ids.movie, body('{"Name":"Saved title","People":[{"Name":"Blocked actor","Type":"Actor"}]}'), { user }));
    assert.deepEqual(await database.rows('BaseItems'), before);
    assert.deepEqual(await database.rows('Peoples'), people);
    assert.deepEqual(await database.rows('PeopleBaseItemMap', { where: { ItemId: ids.movie } }), []);
    assert.deepEqual(await read(vfs, '/media/movie.nfo'), nfo);
  });

  test(`${dialect}: failed item persistence retains the native earlier NFO and people commits`, options, async t => {
    const { runtime, database, adapter, vfs, user } = await setup(t);
    const original = Buffer.from('<movie><title>Original</title><custom>retained</custom></movie>');
    const update = database.update.bind(database);
    for (const existing of [true, false]) {
      if (existing) await adapter.write('/movie.nfo', original);
      else await adapter.delete('/movie.nfo');
      const before = await database.rows('BaseItems');
      let notified = false; const onUpdate = () => { notified = true; }; runtime.metadataUpdates.on('ItemUpdated', onUpdate);
      database.update = async (table, where, changes) => { if (table === 'BaseItems' && where.Id === ids.movie) throw new Error('Injected item persistence failure'); return update(table, where, changes); };
      await assert.rejects(runtime.itemUpdates.update(ids.movie, body('{"Name":"Failed title","People":[{"Name":"New actor","Type":"Actor"}]}'), { user }), /Injected item persistence failure/u);
      database.update = update;
      assert.deepEqual((await database.rows('BaseItems')).filter(item => item.Type !== 'MediaBrowser.Controller.Entities.Person'), before.filter(item => item.Type !== 'MediaBrowser.Controller.Entities.Person')); assert.equal(notified, false);
      assert.equal((await database.rows('PeopleBaseItemMap', { where: { ItemId: ids.movie } })).length, 1);
      const nfo = (await read(vfs, '/media/movie.nfo')).toString();
      assert.match(nfo, /<title>Failed title<\/title>/u);
      assert.match(nfo, /<name>New actor<\/name>/u);
      if (existing) assert.match(nfo, /<custom>retained<\/custom>/u);
      runtime.metadataUpdates.off('ItemUpdated', onUpdate);
    }
  });

  test(`${dialect}: saver acknowledgement failure continues the native item save and preserves later competing writes`, options, async t => {
    const { runtime, database, adapter, vfs, user } = await setup(t);
    const original = Buffer.from('<movie><title>Original</title></movie>');
    await adapter.write('/movie.nfo', original);
    const write = adapter.write.bind(adapter);
    let fail = true;
    adapter.write = async (...args) => { const result = await write(...args); if (fail && args[0] === '/movie.nfo') { fail = false; throw new Error('Injected lost acknowledgement'); } return result; };
    await runtime.itemUpdates.update(ids.movie, body('{"Name":"Attempted"}'), { user });
    assert.match((await read(vfs, '/media/movie.nfo')).toString(), /<title>Attempted<\/title>/u);
    assert.equal((await database.rows('BaseItems', { where: { Id: ids.movie } }))[0].Name, 'Attempted');
    adapter.write = write;
    const before = await database.rows('BaseItems');
    const update = database.update.bind(database); const competing = Buffer.from('<movie><title>Other writer</title></movie>');
    database.update = async (table, where, changes) => {
      if (table === 'BaseItems' && where.Id === ids.movie) { await write('/movie.nfo', competing); throw new Error('Injected database failure after competing write'); }
      return update(table, where, changes);
    };
    await assert.rejects(runtime.itemUpdates.update(ids.movie, body('{"Name":"Attempted again"}'), { user }), /Injected database failure after competing write/u);
    database.update = update;
    assert.deepEqual(await read(vfs, '/media/movie.nfo'), competing); assert.deepEqual(await database.rows('BaseItems'), before);
  });

  test(`${dialect}: series edits persist native child propagation and recursive lock order`, options, async t => {
    const { runtime, database, adapter, vfs, user } = await setup(t);
    await adapter.mkdir('/Show'); await adapter.mkdir('/Show/Season 1');
    await adapter.write('/Show/Season 1/episode.mkv', Buffer.from('episode'));
    await adapter.write('/Show/direct.mkv', Buffer.from('direct'));
    await database.insert('BaseItems', row('series', 'TV.Series', { Path: 'Z:\\EditMedia\\Show', IsFolder: true, ParentId: ids.folder,
      TopParentId: ids.folder, Name: 'Old series', IsLocked: true, Tags: 'Old|keep', Data: '{"DisplayOrder":"Aired"}' }));
    await database.insert('BaseItems', row('season', 'TV.Season', { Path: 'Z:\\EditMedia\\Show\\Season 1', IsFolder: true, ParentId: ids.series,
      TopParentId: ids.folder, SeriesId: ids.series, OfficialRating: 'R', Tags: 'Old|keep|child', IsLocked: true }));
    await database.insert('BaseItems', row('episode', 'TV.Episode', { Path: 'Z:\\EditMedia\\Show\\Season 1\\episode.mkv', ParentId: ids.season,
      TopParentId: ids.folder, SeasonId: ids.season, SeriesId: ids.series, OfficialRating: 'R', Tags: 'Old|keep', IsLocked: true, MediaType: 'Video' }));
    await database.insert('BaseItems', row('direct', 'TV.Episode', { Path: 'Z:\\EditMedia\\Show\\direct.mkv', ParentId: ids.series,
      TopParentId: ids.folder, SeriesId: ids.series, SeriesName: 'Direct stored name', OfficialRating: 'R', Tags: 'Old', IsLocked: true, MediaType: 'Video' }));
    await database.insert('BaseItemMetadataFields', { ItemId: ids.season, Id: 8 });
    await database.insert('BaseItemMetadataFields', { ItemId: ids.episode, Id: 4 });
    const events = []; runtime.metadataUpdates.on('ItemUpdated', event => events.push(event.Item.Id));
    await runtime.itemUpdates.update(ids.series, body('{"Name":"Renamed","OfficialRating":"PG","CustomRating":"G","Tags":["KEEP","new"],"DisplayOrder":"aired"}'), { user });
    assert.deepEqual(events, [ids.season, ids.episode, ids.series, ids.direct, ids.season, ids.episode]);
    const season = (await database.rows('BaseItems', { where: { Id: ids.season } }))[0];
    const episode = (await database.rows('BaseItems', { where: { Id: ids.episode } }))[0];
    const direct = (await database.rows('BaseItems', { where: { Id: ids.direct } }))[0];
    assert.equal(season.SeriesName, 'Renamed'); assert.equal(episode.SeriesName, 'Renamed');
    assert.equal(season.OfficialRating, 'R'); assert.equal(episode.OfficialRating, 'PG');
    assert.equal(season.Tags, 'child|KEEP|new'); assert.equal(episode.Tags, 'Old|keep');
    assert.equal(direct.SeriesName, 'Direct stored name'); assert.equal(direct.OfficialRating, 'R');
    assert.equal(season.IsLocked, false); assert.equal(episode.IsLocked, false); assert.equal(direct.IsLocked, false);
    assert.match((await read(vfs, '/media/Show/Season 1/episode.nfo')).toString(), /<showtitle>Renamed<\/showtitle>/u);
    assert.match((await read(vfs, '/media/Show/tvshow.nfo')).toString(), /<title>Renamed<\/title>/u);
  });

  test(`${dialect}: conflicting external metadata preserves the external database write and earlier NFO save`, options, async t => {
    const { runtime, database, adapter, vfs, user } = await setup(t);
    const original = Buffer.from('<movie><title>Original</title></movie>');
    await adapter.write('/movie.nfo', original);
    const write = adapter.write.bind(adapter); let conflict = true;
    adapter.write = async (...args) => {
      const result = await write(...args);
      if (conflict && args[0] === '/movie.nfo') { conflict = false; await database.update('BaseItems', { Id: ids.movie }, { Overview: 'External overview' }); }
      return result;
    };
    const events = []; runtime.metadataUpdates.on('ItemUpdated', event => events.push(event));
    await assert.rejects(runtime.itemUpdates.update(ids.movie, body('{"Name":"Rejected concurrent edit"}'), { user }), { code: 'metadata-conflict' });
    const after = (await database.rows('BaseItems', { where: { Id: ids.movie } }))[0];
    assert.equal(after.Name, 'movie'); assert.equal(after.Overview, 'External overview'); assert.deepEqual(events, []);
    assert.match((await read(vfs, '/media/movie.nfo')).toString(), /<title>Rejected concurrent edit<\/title>/u);
  });

  test(`${dialect}: content-type HTTP editing saves native XML, survives reload and retains unrelated state`, options, async t => {
    const { runtime, database, origin, login, readerLogin, key, instanceRoot, configurationDirectoryPath, systemXml } = await setup(t);
    const request = (id, query = '', token = login.AccessToken) => fetch(`${origin}/Items/${id}/ContentType${query}`, { method: 'POST', headers: {
      ...(token ? { Authorization: `MediaBrowser Client="ItemEditTest", Device="Test", DeviceId="content-type", Version="1", Token="${token}"` } : {}) } });
    const before = await database.rows('BaseItems');
    assert.equal((await request(ids.movie, '?contentType=tvshows', null)).status, 401);
    assert.equal((await request(ids.movie, '?contentType=tvshows', readerLogin.AccessToken)).status, 403);
    assert.equal((await request(ids.hidden, '?contentType=tvshows')).status, 404);
    assert.equal((await request('not-a-guid', '?contentType=tvshows')).status, 400);
    assert.equal((await request(ids.movie, '?contentType=tvshows&contentType=movies', key.AccessToken)).status, 204);
    const expected = [{ Name: 'Z:\\EditMedia', Value: 'tvshows' }];
    assert.deepEqual(runtime.configuration.ContentTypes, expected);
    const after = await readFile(path.join(configurationDirectoryPath, 'system.xml'), 'utf8');
    assert.equal(after.replace(/<ContentTypes>[\s\S]*?<\/ContentTypes>/u, '<ContentTypes/>'), systemXml);
    assert.deepEqual((await readInstanceConfiguration(instanceRoot)).configuration.ContentTypes, expected);
    assert.deepEqual(await database.rows('BaseItems'), before);
    assert.equal((await runtime.metadataEditor.get(ids.movie)).ContentType, 'tvshows');
    assert.equal((await request(ids.movie, '?contentType=%20%09')).status, 204);
    assert.deepEqual((await readInstanceConfiguration(instanceRoot)).configuration.ContentTypes, []);
    assert.equal((await request(ids.movie, '?contentType=Custom%26Mixed')).status, 204);
    assert.deepEqual((await readInstanceConfiguration(instanceRoot)).configuration.ContentTypes, [{ Name: 'Z:\\EditMedia', Value: 'Custom&Mixed' }]);
  });

  test(`${dialect}: configuration save failure matches native live state while preserving the old XML`, options, async t => {
    const { runtime, configurationDirectoryPath, systemXml, user } = await setup(t);
    runtime.metadataEditor.configurationStore.fileSystem = { ...fileSystem, rename: async () => { throw new Error('Injected configuration save failure'); } };
    await assert.rejects(runtime.metadataEditor.updateContentType(ids.movie, 'tvshows', { user }), /Injected configuration save failure/u);
    assert.deepEqual(runtime.configuration.ContentTypes, lifecycleNative.results.find(entry => entry.name === 'save-configuration-failure').contentTypes);
    assert.equal(await readFile(path.join(configurationDirectoryPath, 'system.xml'), 'utf8'), systemXml);
  });

  test(`${dialect}: a live content-type edit changes the next queued folder refresh resolver output`, options, async t => {
    const { runtime, database, adapter, user, instanceRoot } = await setup(t);
    await database.delete('BaseItems', { Id: ids.movie }); await database.delete('BaseItems', { Id: ids.hidden });
    await adapter.delete('/movie.mkv'); await adapter.delete('/hidden.mkv'); await adapter.write('/fresh.mkv', Buffer.from('fresh media'));
    await runtime.metadataEditor.updateContentType(ids.folder, 'homevideos', { user });
    // ProviderManager refreshes the requested Folder, then validates children
    // using its current content type. There is no separate retrying scan plan.
    await runtime.metadata.queue(ids.folder, { MetadataRefreshMode: 'None', ImageRefreshMode: 'None' });
    await runtime.metadata.drain();
    const saved = (await database.rows('BaseItems')).find(item => item.Path === 'Z:\\EditMedia\\fresh.mkv');
    assert.ok(saved, 'The actual queued Folder validation discovers the new media.');
    assert.equal(saved.Type, 'MediaBrowser.Controller.Entities.Video');
    assert.equal(saved.MediaType, 'Video');
    assert.equal((await readInstanceConfiguration(instanceRoot)).configuration.ContentTypes[0].Value, 'homevideos');
  });

  for (const scenario of lifecycleInput.filter(entry => entry.mode === 'people')) test(`${dialect}: native people lifecycle ${scenario.name}`, options, async t => {
    const { runtime, database, user } = await setup(t, { saveLocal: false });
    const targetId = scenario.type === 'Folder' ? ids.folder : scenario.type === 'Series' ? ids.series : ids.movie;
    if (scenario.type === 'Series') await database.insert('BaseItems', row('series', 'TV.Series', { Name: 'Original', IsFolder: true, IsVirtualItem: true, ParentId: ids.folder }));
    const update = database.update.bind(database); let attempted = false;
    database.update = async (table, where, changes) => {
      if (table === 'BaseItems' && where.Id === targetId) {
        attempted = true;
        if (scenario.failItem) throw new Error('Injected item save failure');
      }
      return update(table, where, changes);
    };
    const expected = lifecycleNative.results.find(entry => entry.name === scenario.name);
    let error;
    try { await runtime.itemUpdates.update(targetId, body(scenario.json), { user }); }
    catch (failure) { error = failure; }
    database.update = update;
    if (expected.error) assert.equal(error?.message, expected.error.Message); else assert.equal(error, undefined);
    assert.equal(attempted, expected.calls.includes('Item'));
    const maps = await database.rows('PeopleBaseItemMap', { where: { ItemId: targetId } });
    const people = await database.rows('Peoples');
    const credits = JSON.parse(stringifyNativeJson(maps.sort((left, right) => left.ListOrder - right.ListOrder).map(map => ({
      Name: people.find(person => person.Id === map.PeopleId).Name, Type: people.find(person => person.Id === map.PeopleId).PersonType,
      Role: map.Role, ListOrder: map.ListOrder, SortOrder: map.SortOrder }))));
    assert.deepEqual(credits, expected.credits);
    const stored = (await database.rows('BaseItems', { where: { Id: targetId } }))[0];
    assert.equal(stored.Name, expected.error ? scenario.type === 'Series' ? 'Original' : 'movie' : 'Attempt');
  });
}
