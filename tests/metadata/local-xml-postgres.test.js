import { fixturePathStyle } from '../library/fixture-state-path.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspect } from 'node:util';
import { createTestRuntime } from '../helpers/runtime.js';
import { idKey } from '../../src/library/records.js';
import { releaseNativeItemLinks } from '../../src/library/native-item-entity.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';

const id = value => `19000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const owner = { Id: id(100), Policy: { EnableAllFolders: true, BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] } };

async function read(vfs, filename) {
  const handle = await vfs.openRead(filename);
  try { const parts = []; for await (const part of handle.stream) parts.push(part); return Buffer.concat(parts); }
  finally { await handle.close(); }
}

async function setup(t, { actual = false, stateIgnoreAncestors = false } = {}) {
  const database = await createPostgresTestDatabase(t, 'local_xml_stage');
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'local-xml-stage-state-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const storage = new StorageRegistry();
  t.after(() => storage.close());
  storage.registerType('memory', () => new MemoryStorageAdapter());
  let service;
  if (actual) {
    service = await startActualWebDav({ evidenceDirectory: process.env.MEDIAMANAGER_LOCAL_XML_WEBDAV_EVIDENCE });
    t.after(() => service.stop());
    storage.registerType('webdav', options => new WebDavAdapter(options, { resolveCredential: async () => service.authorization }));
    await storage.createInstance('fixture', 'webdav', { baseUrl: service.baseUrl, credentialRef: 'isolated',
      capabilities: { create: true, replace: true, mkdir: true } });
  } else await storage.createInstance('fixture', 'memory', {});
  await storage.createInstance('ancestors', 'memory', {});
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: { create: true, replace: true, mkdir: true } });
  vfs.mount({ path: '/readonly', instanceId: 'fixture', capabilities: {} });
  vfs.mount({ path: '/ancestors', instanceId: 'ancestors', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\XmlFixture', accessRoot: '/fixture', style: 'windows', returnAccess: 'isolated local XML stage' });
  identityMap.addPrefix({ identityRoot: 'Z:\\', accessRoot: '/ancestors', style: 'windows', returnAccess: 'known empty metadata ancestors' });
  let ignoreIdentityMap = identityMap;
  if (stateIgnoreAncestors) {
    vfs.mount({ path: '/state-ignore-ancestors', instanceId: 'ancestors', capabilities: {} });
    ignoreIdentityMap = new IdentityAccessMap();
    for (const prefix of identityMap.exportState().prefixes) ignoreIdentityMap.addPrefix(prefix);
    ignoreIdentityMap.addPrefix({ identityRoot: path.parse(stateRoot).root, accessRoot: '/state-ignore-ancestors', style: fixturePathStyle,
      returnAccess: 'explicit complete ignore-only ancestor namespace; no media mapping' });
  }
  const nativeType = Type => Type === 'Playlist' ? 'MediaBrowser.Controller.Playlists.Playlist'
    : `MediaBrowser.Controller.Entities.${Type === 'BoxSet' ? 'Movies.' : Type === 'Audio' ? 'Audio.' : ''}${Type}`;
  const insert = (Id, Type, values) => database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id, Type: nativeType(Type), Name: Type, IsFolder: Type !== 'Audio',
    DateLastRefreshed: '2026-10-09 00:00:00', DateLastSaved: '2026-10-09 00:00:00', Data: '{}', ...values
  }));
  await insert(id(1), 'AggregateFolder', {});
  await insert(id(2), 'UserRootFolder', {});
  await insert(id(3), 'Folder', { Path: 'Z:\\XmlFixture', ParentId: id(1) });
  await insert(id(4), 'CollectionFolder', { ParentId: id(2), Data: JSON.stringify({ CollectionType: 'music',
    PhysicalLocationsList: ['Z:\\XmlFixture'], PhysicalFolderIds: [id(3)] }) });
  for (const [Id, Type, folder] of [[id(5), 'Playlist', 'Road.m3u'], [id(6), 'BoxSet', 'Set']]) {
    await insert(Id, Type, { Path: `Z:\\XmlFixture\\${folder}`, ParentId: id(3), TopParentId: id(3),
      MediaType: Type === 'Playlist' ? 'Audio' : 'Unknown',
      Data: Type === 'Playlist' ? JSON.stringify({ OwnerUserId: owner.Id, OpenAccess: false, Shares: [], PlaylistMediaType: 'Audio' }) : '{}' });
    await vfs.mkdir(`/fixture/${folder}`);
  }
  for (const [number, name] of [[7, 'A'], [8, 'B'], [9, 'New']]) {
    await insert(id(number), 'Audio', { Name: name, Path: `Z:\\XmlFixture\\${name}.mp3`, ParentId: id(3), TopParentId: id(3), MediaType: 'Audio' });
    await vfs.write(`/fixture/${name}.mp3`, Buffer.from('neutral audio'));
  }
  const errors = [];
  const runtime = await createTestRuntime({ database, vfs, identityMap, ignoreIdentityMap, programDataPath: stateRoot,
    configurationDirectoryPath: path.join(stateRoot, 'config'), serverId: 'local-xml-stage',
    libraryOptions: new Map([[idKey(id(4)), { SaveLocalMetadata: true, MetadataSavers: ['Emby Xml'] }]]),
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, onError: error => errors.push(error) });
  const contexts = new Set();
  const loadContext = runtime.metadata.loadContext;
  runtime.metadata.loadContext = async (...args) => {
    const loaded = await loadContext(...args); contexts.add(loaded); return loaded;
  };
  t.after(async () => {
    for (const loaded of contexts) await loaded.dispose();
    await runtime.linkedChildren.flushReleases();
    await runtime.close();
  });
  t.after(() => t.diagnostic(inspect({ background: errors }, { depth: null })));
  const links = parent => database.rows('LinkedChildren', { where: { ParentId: parent }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
  return { database, runtime, vfs, identityMap, stateRoot, errors, links };
}

test('runtime local XML imports external directory links, owner/share rules and typed PostgreSQL metadata', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const h = await setup(t);
  for (const [target, folder, plural, singular, xmlFile] of [
    [id(5), 'Road.m3u', 'PlaylistItems', 'PlaylistItem', 'playlist.xml'],
    [id(6), 'Set', 'CollectionItems', 'CollectionItem', 'collection.xml']
  ]) await t.test(folder, async () => {
    const xml = `<Item><LocalTitle>From XML</LocalTitle><Overview>Imported overview</Overview><Tags><Tag>T</Tag></Tags>`
      + `<OwnerUserId>${id(999)}</OwnerUserId><Shares><Share><UserId>${id(101)}</UserId><CanEdit>true</CanEdit></Share></Shares>`
      + `<PlaylistMediaType>Audio</PlaylistMediaType><${plural}><${singular}><Path>Z:\\XmlFixture\\A.mp3</Path></${singular}>`
      + `<${singular}><Path>Z:\\XmlFixture\\A.mp3</Path></${singular}><${singular}><ItemId>${id(8)}</ItemId></${singular}></${plural}></Item>`;
    await h.vfs.write(`/fixture/${folder}/${xmlFile}`, Buffer.from(xml), { modified: '2026-10-10T00:00:00.0000000Z' });
    const loaded = await h.runtime.metadata.loadContext(target);
    assert.equal(loaded.context.accessPath, `/fixture/${folder}`);
    const provider = h.runtime.metadata.registry.discover({ ...loaded, kind: 'local' }).find(value => value.id.endsWith('XmlProvider'));
    assert.ok(provider);
    const parsed = await provider.getMetadata(loaded.item, loaded.context);
    try { assert.equal(parsed.Item.Overview, 'Imported overview'); }
    finally { releaseNativeItemLinks(parsed.Item); await h.runtime.linkedChildren.flushReleases(); }
    const refreshed = await h.runtime.metadata.refresh(target, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
    assert.equal(refreshed.Failures, 0); assert.equal(refreshed.changed, true);
    const row = (await h.database.rows('BaseItems', { where: { Id: target } }))[0];
    assert.equal(row.Name, 'From XML');
    assert.equal(row.Overview, 'Imported overview');
    assert.equal(row.Path, `Z:\\XmlFixture\\${folder}`);
    const ids = (await h.links(target)).map(link => link.ChildId);
    assert.deepEqual(ids, folder === 'Road.m3u' ? [id(7), id(7), id(8)] : [id(7), id(8)]);
    assert.equal(row.Tags, 'T');
    if (folder === 'Road.m3u') {
      const data = JSON.parse(row.Data);
      assert.equal(idKey(data.OwnerUserId), idKey(owner.Id), 'XML owner is parsed but the native merger does not transfer ownership');
      assert.equal(data.OpenAccess, false);
      assert.deepEqual(data.Shares, [{ UserId: idKey(id(101)), CanEdit: true }]);
      const saved = (await read(h.vfs, '/fixture/Road.m3u/playlist.xml')).toString();
      assert.match(saved, /<PlaylistItems \/>/u, 'native saver uses cached ItemIds only; raw XML paths resolve later in the repository');
    }
    const reloaded = await h.runtime.metadata.loadContext(target);
    const reloadedIds = [];
    for await (const page of reloaded.item.LinkedChildren.pages({ batchSize: 128 })) {
      assert.ok(page.length <= 128); reloadedIds.push(...page.map(link => link.ItemId));
    }
    assert.deepEqual(reloadedIds, ids);
  });
});

for (const type of ['Playlist', 'BoxSet']) test(`runtime managed ${type} with a physical parent completes owned discovery through instance state`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const h = await setup(t, { stateIgnoreAncestors: true });
  const parentPath = path.join(h.stateRoot, 'data', type === 'Playlist' ? 'playlists' : 'collections'), directory = path.join(parentPath, 'Managed');
  await mkdir(directory, { recursive: true });
  await h.database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: id(11), Type: 'MediaBrowser.Controller.Entities.Folder', Name: 'Playlist parent', IsFolder: true,
    Path: parentPath, ParentId: id(1), Data: '{}',
  }));
  await h.database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: id(10), Type: type === 'Playlist' ? 'MediaBrowser.Controller.Playlists.Playlist' : 'MediaBrowser.Controller.Entities.Movies.BoxSet', Name: 'Managed', IsFolder: true,
    Path: directory, MediaType: 'Audio', ParentId: id(11),
    DateLastRefreshed: '2026-10-09 00:00:00', DateLastSaved: '2026-10-09 00:00:00',
    Data: type === 'Playlist' ? JSON.stringify({ OwnerUserId: owner.Id, OpenAccess: false, Shares: [], PlaylistMediaType: 'Audio' }) : '{}',
  }));
  await writeFile(path.join(directory, type === 'Playlist' ? 'playlist.xml' : 'collection.xml'), '<Item><Overview>Managed parent lifecycle</Overview></Item>');
  const loaded = await h.runtime.metadata.loadContext(id(10));
  assert.equal(loaded.supportsOwnedItems(), true);
  assert.equal(loaded.context.localPath, directory);
  const refreshed = await h.runtime.metadata.refresh(id(10), { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
  assert.equal(refreshed.Failures, 0);
  assert.equal((await h.database.rows('BaseItems', { where: { Id: id(10) } }))[0].Overview, 'Managed parent lifecycle');
});

test('runtime external logical Playlist edits use XML only, batch newly added IDs and reject read-only preflight', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const h = await setup(t);
  const writes = [], events = [], savedWrites = [];
  const originalWrite = h.vfs.write.bind(h.vfs);
  h.vfs.write = async (filename, bytes, options) => {
    writes.push(filename);
    const chunks = [];
    if (Buffer.isBuffer(bytes)) chunks.push(bytes);
    else for await (const chunk of bytes) { assert.ok(chunk.length <= 8192); chunks.push(chunk); }
    const recorded = Buffer.concat(chunks);
    savedWrites.push(recorded.toString());
    return originalWrite(filename, recorded, options);
  };
  h.runtime.library.on('ItemUpdated', event => { if (idKey(event.Item.Id) === idKey(id(5))) events.push(event.UpdateReason); });
  await h.runtime.playlists.update(id(5), { user: owner, name: 'Directory name' });
  assert.deepEqual(writes, ['/fixture/Road.m3u/playlist.xml']);
  assert.deepEqual(events, [16]);
  await h.runtime.playlists.add(id(5), [id(9), id(7), id(9)], { user: owner });
  await h.runtime.store.run(() => {});
  await h.runtime.metadata.drain();
  assert.ok(writes.every(filename => filename === '/fixture/Road.m3u/playlist.xml'));
  assert.equal((savedWrites[1].match(/New\.mp3/gu) ?? []).length, 2, 'the synchronous edit resolves newly added IDs in one fresh SQL batch');
  assert.equal((savedWrites[1].match(/A\.mp3/gu) ?? []).length, 1);
  const saved = (await read(h.vfs, '/fixture/Road.m3u/playlist.xml')).toString();
  assert.equal((saved.match(/New\.mp3/gu) ?? []).length, 2, 'Default refresh replaces links from the committed XML and preserves duplicate paths');
  assert.equal((saved.match(/A\.mp3/gu) ?? []).length, 1);
  assert.deepEqual((await h.links(id(5))).map(link => link.ChildId), [id(9), id(7), id(9)]);
  const count = writes.length;
  h.identityMap.bind(id(5), '/readonly/Road.m3u');
  await assert.rejects(h.runtime.playlists.update(id(5), { user: owner, name: 'Read only', ids: [id(8)] }), { code: 'not-supported' });
  assert.equal(writes.length, count);
  assert.equal((await h.database.rows('BaseItems', { where: { Id: id(5) } }))[0].Name, 'Directory name');
  assert.deepEqual((await h.links(id(5))).map(link => link.ChildId), [id(9), id(7), id(9)]);
});

test('actual WebDAV runtime reads and writes a logical Playlist directory without PUT to the directory', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE,
}, async t => {
  const h = await setup(t, { actual: true });
  await h.vfs.write('/fixture/Road.m3u/playlist.xml', Buffer.from('<Item><Overview>Actual WebDAV XML</Overview><PlaylistMediaType>Audio</PlaylistMediaType></Item>'));
  const imported = await h.runtime.metadata.refresh(id(5), { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
  assert.equal(imported.Failures, 0);
  assert.equal((await h.database.rows('BaseItems', { where: { Id: id(5) } }))[0].Overview, 'Actual WebDAV XML');
  await h.runtime.playlists.add(id(5), [id(9)], { user: owner });
  await h.runtime.store.run(() => {});
  await h.runtime.metadata.drain();
  assert.equal((await h.vfs.stat('/fixture/Road.m3u')).kind, 'directory');
  assert.match((await read(h.vfs, '/fixture/Road.m3u/playlist.xml')).toString(), /<Path>Z:\\XmlFixture\\New\.mp3<\/Path>/u);
  assert.deepEqual((await h.links(id(5))).map(link => link.ChildId), [id(9)]);
});

test('runtime state-local Playlist XML preserves repository-owned links and ownership', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const h = await setup(t);
  const directory = path.join(h.stateRoot, 'data', 'playlists', 'Managed');
  await mkdir(directory, { recursive: true });
  await h.database.insert('BaseItems', postgresTestRow('BaseItems', {
    Id: id(10), Type: 'MediaBrowser.Controller.Playlists.Playlist', Name: 'Managed', IsFolder: true,
    Path: directory, MediaType: 'Audio', ParentId: null,
    DateLastRefreshed: '2026-10-09 00:00:00', DateLastSaved: '2026-10-09 00:00:00',
    Data: JSON.stringify({ OwnerUserId: owner.Id, OpenAccess: false, Shares: [], PlaylistMediaType: 'Audio' }),
  }));
  await h.database.insert('LinkedChildren', postgresTestRow('LinkedChildren', {
    ParentId: id(10), ChildId: id(7), ChildType: 0, SortOrder: 0,
  }));
  await writeFile(path.join(directory, 'playlist.xml'), `<Item><Overview>State-local XML</Overview>`
    + `<OwnerUserId>${id(999)}</OwnerUserId><PlaylistMediaType>Video</PlaylistMediaType>`
    + `<Shares><Share><UserId>${id(101)}</UserId><CanEdit>true</CanEdit></Share></Shares>`
    + `<PlaylistItems><PlaylistItem><Path>Z:\\XmlFixture\\B.mp3</Path></PlaylistItem></PlaylistItems></Item>`);
  const loaded = await h.runtime.metadata.loadContext(id(10));
  assert.equal(loaded.context.localPath, directory);
  assert.equal(loaded.context.accessPath, undefined);
  const refreshed = await h.runtime.metadata.refresh(id(10), { MetadataRefreshMode: 'Default', ImageRefreshMode: 'None' });
  assert.equal(refreshed.Failures, 0);
  const row = (await h.database.rows('BaseItems', { where: { Id: id(10) } }))[0];
  const data = JSON.parse(row.Data);
  assert.equal(row.Overview, 'State-local XML');
  assert.equal(idKey(data.OwnerUserId), idKey(owner.Id));
  assert.equal(data.OpenAccess, false);
  assert.equal(data.PlaylistMediaType, 'Video');
  assert.deepEqual(data.Shares, [{ UserId: idKey(id(101)), CanEdit: true }]);
  assert.deepEqual((await h.links(id(10))).map(link => link.ChildId), [id(7)]);
  const saved = await readFile(path.join(directory, 'playlist.xml'), 'utf8');
  assert.match(saved, /<Path>Z:\\XmlFixture\\A\.mp3<\/Path>/u);
  assert.doesNotMatch(saved, /B\.mp3/u);
});
