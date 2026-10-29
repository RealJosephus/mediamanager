import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { PostgresLinkedChildrenStore } from '../../src/library/postgres-linked-children.js';
import { loadLibrary, idKey, VIDEO_TYPES, MIN_DATE } from '../../src/library/records.js';
import { mediaSources } from '../../src/library/dto.js';
import { mediaSourceCount, commonVersionPrefix } from '../../src/library/media-versions.js';
import { nativePersonIdentity } from '../../src/library/identity.js';
import { projectExternalUrls } from '../../src/library/external-urls.js';
import { createExternalUrlRegistry } from '../../src/metadata/external-url-providers.js';
import { createTmdbPlugin } from '../../plugins/tmdb/plugin.js';
import { stringifyNativeJson, withNativeFloats, cloneNativeValue } from '../../src/core/json.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { HttpAdapter } from '../../plugins/http/adapter.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

const input = JSON.parse(readFileSync(new URL('./fixtures/media-versions/input.json', import.meta.url)));
const native = JSON.parse(readFileSync(new URL('./fixtures/media-versions/native.json', import.meta.url)));
const shortcutInput = JSON.parse(readFileSync(new URL('./fixtures/media-versions/shortcut-input.json', import.meta.url)));
const shortcutNative = JSON.parse(readFileSync(new URL('./fixtures/media-versions/shortcut-native.json', import.meta.url)));
const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : ['uint','long'].includes(column.clrType) ? 0n : 0]));
const nativeType = type => `MediaBrowser.Controller.Entities.${['Movie','BoxSet'].includes(type) ? 'Movies.' : ['Series','Season','Episode'].includes(type) ? 'TV.' : ['Audio','MusicAlbum','MusicArtist'].includes(type) ? 'Audio.' : ''}${type}`;
async function seed(db, entry) {
  for (const table of ['LinkedChildren','MediaStreamInfos','BaseItemProviders','BaseItems']) {
    for (const row of await db.rows(table)) await db.delete(table, Object.fromEntries(tableDefinition(table).primaryKey.map(key => [key,row[key]])));
  }
  for (const row of entry.items) {
    const { MediaStreams = [], ProviderIds = {}, ...item } = row;
    const columns = new Set(tableDefinition('BaseItems').columns.map(column => column.name));
    const direct = Object.fromEntries(Object.entries(item).filter(([key]) => columns.has(key)));
    const data = Object.fromEntries(Object.entries(item).filter(([key]) => !columns.has(key)));
    const isVideo = VIDEO_TYPES.has(item.Type), isAudio = ['Audio','AudioBook'].includes(item.Type);
    await db.insert('BaseItems', { ...empty('BaseItems'), ...direct, Type: nativeType(item.Type), Path: item.Path ?? null,
      MediaType: isVideo ? 'Video' : isAudio ? 'Audio' : 'Unknown', Data: JSON.stringify(data), DateModified: MIN_DATE,
      SortName: item.ForcedSortName ?? item.Name, IsFolder: ['Series','Season','BoxSet','MusicAlbum','MusicArtist'].includes(item.Type) });
    for (const [ProviderId, ProviderValue] of Object.entries(ProviderIds)) await db.insert('BaseItemProviders', { ItemId: item.Id, ProviderId, ProviderValue });
    for (const stream of MediaStreams) await db.insert('MediaStreamInfos', { ...empty('MediaStreamInfos'), ItemId: item.Id,
      StreamIndex: stream.Index, StreamType: ['Audio','Video','Subtitle'].indexOf(stream.Type), Width: stream.Width ?? null });
  }
  for (const [index,link] of (entry.links ?? []).entries()) {
    if (!(await db.rows('BaseItems',{where:{Id:link.ChildId}})).length) await db.insert('BaseItems',{...empty('BaseItems'),Id:link.ChildId,Type:'PLACEHOLDER'});
    await db.insert('LinkedChildren', { ...empty('LinkedChildren'), ...link, SortOrder: index });
  }
}
async function compare(db) {
  const externalUrlRegistry=createExternalUrlRegistry();externalUrlRegistry.register(createTmdbPlugin({client:{}}));
  for (const entry of [...input.cases, ...shortcutInput.cases]) {
    await seed(db,entry);
    const state = await loadLibrary(db, {}, { baseRows: await db.rows('BaseItems') });
    const item = state.byId.get(idKey(entry.query));
    const expected = [...native.results, ...shortcutNative.results].find(result => result.name === entry.name);
    assert.deepEqual(projectExternalUrls(item,state,{ externalUrlRegistry, musicBrainzServer: entry.musicBrainzServer?.replace(/\/+$/,'') }),expected.urls,entry.name+' URLs');
    if (expected.sources) {
      const actual = JSON.parse(stringifyNativeJson(await mediaSources(item,state,null,{})));
      assert.deepEqual(actual, expected.sources, entry.name+' native static source DTOs');
    }
    if (expected.count != null) assert.equal(mediaSourceCount(item,state),expected.count,entry.name+' count');
  }
}
test('actual DLL source grouping and external URLs match on real PostgreSQL', {skip:!process.env.MEDIAMANAGER_TEST_POSTGRES}, async () => {
  const schema=`versions_${Date.now()}_${Math.floor(Math.random()*10000)}`;
  const db=await PostgresDatabase.open({connectionString:process.env.MEDIAMANAGER_TEST_POSTGRES,schema,create:true});
  try { await compare(db); } finally { await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`); await db.client.query(`DROP SCHEMA ${quoteIdentifier(schema+'__mm')} CASCADE`); await db.close(); }
});
test('actual DLL UTF-8 folder limits and invariant version-prefix boundaries match', () => {
  for(const row of native.prefixes) assert.equal(commonVersionPrefix(row.names),row.value,JSON.stringify(row.names));
  for(const row of native.folders) assert.equal(path.win32.basename(nativePersonIdentity(row.name,{programDataPath:'D:\\isolated-state'}).Path),row.value,row.name);
});
test('binary32 JSON values match 4092 actual DLL samples including ties and subnormals', () => {
  const view = new DataView(new ArrayBuffer(4));
  for (const row of native.floats) {
    view.setInt32(0,row.bits,true);
    const dto=withNativeFloats({value:view.getFloat32(0,true)},['value']);
    assert.equal(JSON.parse(stringifyNativeJson(cloneNativeValue(dto))).value,row.value,String(row.bits));
  }
});
test('version resume ordering preserves queried streams and excludes inaccessible sources',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'media_version_resume');
  const entry=structuredClone(input.cases.find(entry=>entry.name==='local-primary'));
  entry.items[1].MediaStreams=[{Type:'Video',Index:0,Width:3840}];
  entry.items[2].MediaStreams=[{Type:'Video',Index:0,Width:1280}];
  const user={Id:'B0000000-0000-0000-0000-000000000001',Username:'Reader',Policy:{EnableAllFolders:true,EnablePlaybackRemuxing:true},Configuration:{}};
  const store = new DomainStore(db);
  let library, itemCreation, linkedChildren, primaryError;
  try {
    await seed(db,entry);
    await db.insert('Users',{...empty('Users'),Id:user.Id,Username:'Reader',NormalizedUsername:'READER',InternalId:1});
    for(const [index,item] of entry.items.entries()) await db.insert('UserData',{...empty('UserData'),UserId:user.Id,ItemId:item.Id,
      CustomDataKey:idKey(item.Id),PlaybackPositionTicks:BigInt(index*100),LastPlayedDate:`2026-09-2${index} 12:00:00.0000000`});
    linkedChildren = new PostgresLinkedChildrenStore({ database: db }); await linkedChildren.initialize();
    library=new LibraryService({fileSystem: testFileSystem, store, linkedChildren,serverId:'versions',programDataPath:'D:\\isolated-state'});
    itemCreation = new ItemCreationService({ store, library, linkedChildren, loadContext: async () => {
      throw new Error('Metadata mutation is outside the version resume read scenario.');
    } });
    library.itemCreation = itemCreation;
    const primary=await library.getItem(entry.query,{user});
    assert.deepEqual(primary.MediaSources.map(source=>source.Id),[entry.items[2].Id,entry.items[0].Id,entry.items[1].Id].map(idKey));
    assert.deepEqual(primary.MediaStreams,[]);
    assert.equal(primary.MediaSourceCount,3);
    assert.equal((await library.getMediaSources(entry.items[1].Id,{user}))[0].Id,idKey(entry.items[1].Id));
    await db.update('BaseItems',{Id:entry.items[2].Id},{Tags:'hidden'});
    const restricted={...user,Policy:{...user.Policy,BlockedTags:['hidden']}};
    assert.equal((await library.getItem(entry.query,{user:restricted})).MediaSourceCount,2);
    assert.deepEqual((await library.getMediaSources(entry.query,{user:restricted})).map(source=>source.Id),[entry.items[1].Id,entry.items[0].Id].map(idKey));
  } catch (error) { primaryError = error; throw error; }
  finally {
    const failures = [];
    for (const close of [() => itemCreation?.close(), () => library?.close(), () => linkedChildren?.close(), () => store.close()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(primaryError ? [primaryError, ...failures] : failures,
      primaryError?.message ?? 'Version resume read cleanup failed.', primaryError ? { cause: primaryError } : undefined);
  }
});

test('retained channel content without a saved cache preserves the static shortcut source',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'media_version_channel');
  const metadataPath = await mkdtemp(path.join(os.tmpdir(), 'media-version-channel-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(metadataPath)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(metadataPath).startsWith('media-version-channel-'));
    await rm(metadataPath, { recursive: true, force: true });
  });
  const entry = structuredClone(shortcutInput.cases[0]);
  entry.items[0].ChannelId = '97840000-0000-0000-0000-000000000099';
  await seed(db, entry);
  const state = await loadLibrary(db, {}, { baseRows: await db.rows('BaseItems') });
  try {
    const item = state.byId.get(idKey(entry.query));
    const expected = shortcutNative.results.find(result => result.name === entry.name).sources;
    assert.ok(expected.length > 0);
    assert.deepEqual(JSON.parse(stringifyNativeJson(await mediaSources(item, state, null, { metadataPath, fileSystem: testFileSystem }))), expected);
  } finally { await state.dispose(); }
});

test('RTSP and RTP video shortcuts expose remote DTOs without static direct streaming',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'media_version_remote');
  for (const [scheme, protocol] of [['rtsp', 'Rtsp'], ['rtp', 'Rtp']]) {
    const entry = structuredClone(shortcutInput.cases[0]);
    const target = `${scheme}://127.0.0.1:1/video`;
    entry.items[0].ShortcutPath = target;
    await seed(db, entry);
    const state = await loadLibrary(db, {}, { baseRows: await db.rows('BaseItems') });
    try {
      const item = state.byId.get(idKey(entry.query));
      const [source] = await mediaSources(item, state, null, {});
      assert.equal(source.Protocol, protocol);
      assert.equal(source.Path, target);
      assert.equal(source.IsRemote, true);
      assert.equal(source.SupportsDirectStream, false);
      assert.equal(source.Id, idKey(entry.query));
      assert.equal(source.MediaStreams[0].Width, 1920);
    } finally { await state.dispose(); }
  }
});

test('HTTP PlaybackInfo reads real video shortcut files and persists refreshed remote streams', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  let db, runtime, directory;
  const storage = new StorageRegistry();
  t.after(async () => {
    const failures = [];
    const attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    await attempt(() => runtime?.close());
    await attempt(() => storage.close());
    await attempt(() => dropPostgresTestDatabase(db));
    await attempt(async () => {
      if (!directory) return;
      assert.equal(path.dirname(directory), os.tmpdir());
      assert.ok(path.basename(directory).startsWith('shortcut-http-'));
      await rm(directory, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Shortcut PlaybackInfo cleanup failed.');
  });
  directory = await mkdtemp(path.join(os.tmpdir(), 'shortcut-http-'));
  const programDataPath = path.join(directory, 'data');
  await mkdir(programDataPath, { recursive: true });
  db = await createPostgresTestDatabase(undefined, 'shortcut_http');
  const entry = structuredClone(shortcutInput.cases[0]);
  entry.items[0].ShortcutPath = null;
  entry.items[0].IsInMixedFolder = true;
  await seed(db, entry);
  storage.registerType('fixture', () => new MemoryStorageAdapter());
  const adapter = await storage.createInstance('fixture', 'fixture', {});
  storage.registerType('state-local', configuration => LocalAdapter.open(configuration));
  await storage.createInstance('state-local', 'state-local', { root: programDataPath, writable: true });
  storage.registerType('http-source', () => new HttpAdapter());
  await storage.createInstance('http-source', 'http-source', {});
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/media', instanceId: 'fixture', capabilities: { create: true, replace: true, delete: true } });
  vfs.mount({ path: '/state', instanceId: 'state-local', capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } });
  vfs.mount({ path: '/http-source', instanceId: 'http-source', capabilities: {} });
  vfs.mount({ path: '/https-source', instanceId: 'http-source', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\Library\\Shortcuts', accessRoot: '/media', style: 'windows', returnAccess: 'Isolated shortcut bytes.' });
  identityMap.addPrefix({ identityRoot: programDataPath, accessRoot: '/state', style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Isolated application state.' });
  identityMap.addPrefix({ identityRoot: 'http:', accessRoot: '/http-source', style: 'uri', returnAccess: 'Isolated shortcut source retains its HTTP identity.' });
  identityMap.addPrefix({ identityRoot: 'https:', accessRoot: '/https-source', style: 'uri', returnAccess: 'Isolated shortcut source retains its HTTPS identity.' });
  const errors = [], observedTargets = [];
  runtime = await createTestRuntime({ database: db, vfs, identityMap, programDataPath,
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
    serverId: 'shortcut-http-test', onError: error => errors.push(error) });
  runtime.sessions.automaticProgress = false;
  runtime.probe.probe = async () => { throw new Error('The shortcut text must never reach the local media prober.'); };
  // The HTTP endpoint exercises the real file read, normalization and PG save.
  // The existing probe lifecycle suite covers actual remote ffprobe execution.
  let expectedTarget, width, seconds;
  runtime.probe.probeRemote = async target => {
    assert.equal(target, expectedTarget);
    observedTargets.push(target);
    return { raw: {
      streams: [{ index: 0, codec_type: 'video', codec_name: 'ffv1', width, height: 24, pix_fmt: 'yuv420p', avg_frame_rate: '10/1' }],
      format: { format_name: 'matroska', duration: String(seconds), bit_rate: '32000' }
    }, sourceConsistency: 'unversioned' };
  };
  await runtime.users.createUser({ Name: 'ShortcutAdmin', Password: 'shortcut-password' });
  const login = await runtime.authentication.login({ Username: 'ShortcutAdmin', Pw: 'shortcut-password' },
    { Client: 'ShortcutTest', Device: 'Shortcut Device', DeviceId: 'shortcut-postgres', Version: '1' }, { remoteEndPoint: '127.0.0.1' });
  const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http' && entry.bound).port}`;
  const authorization = `MediaBrowser Client="ShortcutTest", Device="Shortcut Device", DeviceId="shortcut-postgres", Version="1", Token="${login.AccessToken}"`;
  for (const [index, scheme] of ['http', 'https'].entries()) {
    expectedTarget = `${scheme}://127.0.0.1:1/controlled-${index}.mkv`;
    width = 32 + index * 16; seconds = index + 1;
    await adapter.write('/Remote Shortcut.strm', Buffer.from(`\uFEFF# current remote target\r\n\t${expectedTarget}\t\r\n`));
    const response = await fetch(`${origin}/Items/${entry.query}/PlaybackInfo`, {
      method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: '{}'
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const source = JSON.parse(text).MediaSources[0];
    assert.equal(source.Protocol, 'Http'); assert.equal(source.Path, expectedTarget); assert.equal(source.IsRemote, true);
    assert.equal(source.Id, idKey(entry.query)); assert.equal(source.Container, 'mkv');
    assert.equal(source.RunTimeTicks, seconds * 10000000);
    assert.deepEqual(source.MediaStreams.map(stream => [stream.Type, stream.Codec, stream.Width, stream.Height]), [['Video', 'ffv1', width, 24]]);
    const stored = (await db.rows('BaseItems', { where: { Id: entry.query } }))[0];
    assert.equal(stored.Path, entry.items[0].Path);
    assert.equal(JSON.parse(stored.Data).ShortcutPath, expectedTarget);
    assert.equal(stored.RunTimeTicks, BigInt(seconds) * 10000000n);
    assert.deepEqual((await db.rows('MediaStreamInfos', { where: { ItemId: entry.query } }))
      .map(stream => [stream.StreamIndex, stream.StreamType, stream.Codec, stream.Width, stream.Height]), [[0, 1, 'ffv1', width, 24]]);
  }
  assert.equal(observedTargets.length, 2, 'both requests refresh an existing saved video stream');
  assert.deepEqual(errors, []);
});
