import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { loadLibrary, idKey, VIDEO_TYPES, MIN_DATE } from '../../src/library/records.js';
import { mediaSources } from '../../src/library/dto.js';
import { mediaSourceCount, commonVersionPrefix } from '../../src/library/media-versions.js';
import { nativePersonIdentity } from '../../src/library/identity.js';
import { projectExternalUrls } from '../../src/library/external-urls.js';
import { createExternalUrlRegistry } from '../../src/metadata/external-url-providers.js';
import { createTmdbPlugin } from '../../plugins/tmdb/plugin.js';
import { stringifyNativeJson, withNativeFloats, cloneNativeValue } from '../../src/core/json.js';
import { createRuntime } from '../../src/runtime.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';

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
  let library;
  try {
    await seed(db,entry);
    await db.insert('Users',{...empty('Users'),Id:user.Id,Username:'Reader',NormalizedUsername:'READER',InternalId:1});
    for(const [index,item] of entry.items.entries()) await db.insert('UserData',{...empty('UserData'),UserId:user.Id,ItemId:item.Id,
      CustomDataKey:idKey(item.Id),PlaybackPositionTicks:BigInt(index*100),LastPlayedDate:`2026-09-2${index} 12:00:00.0000000`});
    library=new LibraryService({fileSystem: testFileSystem, store:new DomainStore(db),serverId:'versions',programDataPath:'D:\\isolated-state'});
    const primary=await library.getItem(entry.query,{user});
    assert.deepEqual(primary.MediaSources.map(source=>source.Id),[entry.items[2].Id,entry.items[0].Id,entry.items[1].Id].map(idKey));
    assert.deepEqual(primary.MediaStreams,[]);
    assert.equal(primary.MediaSourceCount,3);
    assert.equal((await library.getMediaSources(entry.items[1].Id,{user}))[0].Id,idKey(entry.items[1].Id));
    await db.update('BaseItems',{Id:entry.items[2].Id},{Tags:'hidden'});
    const restricted={...user,Policy:{...user.Policy,BlockedTags:['hidden']}};
    assert.equal((await library.getItem(entry.query,{user:restricted})).MediaSourceCount,2);
    assert.deepEqual((await library.getMediaSources(entry.query,{user:restricted})).map(source=>source.Id),[entry.items[1].Id,entry.items[0].Id].map(idKey));
  } finally { await library?.close(); }
});

test('channel and non-HTTP remote shortcut sources remain explicitly unsupported',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
  const db = await createPostgresTestDatabase(t, 'media_version_unsupported');
  try {
    for (const [mutate, message] of [
      [item => { item.ChannelId = '97840000-0000-0000-0000-000000000099'; }, 'Channel media source projection is not implemented.'],
      [item => { item.ShortcutPath = 'rtsp://example.invalid/video'; }, 'This shortcut media source protocol is not implemented.']
    ]) {
      const entry = structuredClone(shortcutInput.cases[0]);
      mutate(entry.items[0]);
      await seed(db, entry);
      const state = await loadLibrary(db, {}, { baseRows: await db.rows('BaseItems') });
      const item = state.byId.get(idKey(entry.query));
      await assert.rejects(mediaSources(item, state, null, {}), error => error.status === 501 && error.message === message);
    }
  } finally { /* PostgreSQL cleanup is registered on the test. */ }
});

for (const dialect of ['postgres']) test(`recorded HTTP(S) shortcut sources reach PlaybackInfo on ${dialect}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async () => {
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const schema = `shortcut_http_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const db = await PostgresDatabase.open({ connectionString, schema, create: true });
  let runtime;
  try {
    runtime = await createRuntime({ database: db, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
      serverId: 'shortcut-http-test', programDataPath: 'D:\\shortcut-http-test-state' });
    runtime.sessions.automaticProgress = false;
    const user = await runtime.users.createUser({ Name: 'ShortcutAdmin', Password: 'shortcut-password' });
    const login = await runtime.authentication.login({ Username: 'ShortcutAdmin', Pw: 'shortcut-password' },
      { Client: 'ShortcutTest', Device: 'Shortcut Device', DeviceId: `shortcut-${dialect}`, Version: '1' }, { remoteEndPoint: '127.0.0.1' });
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const authorization = `MediaBrowser Client="ShortcutTest", Device="Shortcut Device", DeviceId="shortcut-${dialect}", Version="1", Token="${login.AccessToken}"`;
    for (const entry of shortcutInput.cases) {
      await seed(db, entry);
      const response = await fetch(`${origin}/Items/${entry.query}/PlaybackInfo`, {
        method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: '{}'
      });
      const text = await response.text();
      assert.equal(response.status, 200, entry.name + ': ' + text);
      const source = JSON.parse(text).MediaSources[0];
      const expected = shortcutNative.results.find(result => result.name === entry.name).sources[0];
      assert.deepEqual(Object.fromEntries(['Protocol', 'Id', 'Path', 'Type', 'Container', 'Name', 'IsRemote', 'ETag']
        .map(key => [key, source[key]])), Object.fromEntries(['Protocol', 'Id', 'Path', 'Type', 'Container', 'Name', 'IsRemote', 'ETag']
        .map(key => [key, expected[key]])), entry.name);
      assert.deepEqual(source.MediaStreams, expected.MediaStreams, entry.name + ' preloaded streams');
      if (entry.name === 'shortcut-local-target') assert.equal(text.includes('do-not-expose'), false, 'local shortcut target must not leak');
    }
  } finally {
    if (runtime) await runtime.close(); else await db.close();
    const cleanup = await PostgresDatabase.open({ connectionString, schema });
    try {
      await cleanup.client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await cleanup.client.query(`DROP SCHEMA ${quoteIdentifier(schema + '__mm')} CASCADE`);
    } finally { await cleanup.close(); }
  }
});
