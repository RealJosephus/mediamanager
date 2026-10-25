import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { PlaylistService, playlistNativeType } from '../../src/library/playlist-service.js';
import {nativeTextBytes} from '../../src/database/native-text.js';
import {PostgresLinkedChildrenStore} from '../../src/library/postgres-linked-children.js';
import {publishNativeItemLinks,releaseNativeItemLinks} from '../../src/library/native-item-entity.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap, StorageError } from '../../src/storage/index.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { createPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { createTestApplication } from '../helpers/application.js';
import { idKey, mapRecord } from '../../src/library/records.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';
import { createTestRuntime } from '../helpers/runtime.js';

const fixture = new URL('./fixtures/playlist-file/',import.meta.url);
const input = JSON.parse(await readFile(new URL('input.json', fixture)));
const native = JSON.parse(await readFile(new URL('native.json', fixture)));
const id = number => `18000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const playlistId = id(100), ownerId = id(200), editorId = id(201);
const owner = { Id: ownerId, Policy: { EnableAllFolders: true, BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] } };
const editor = { ...owner, Id: editorId };
const originalBytes = Buffer.from('//5vAGwAZAA=', 'base64');
const identityPath = extension => `Z:\\playlist-oracle\\lists\\mix${extension}`;
const accessPath = extension => `/fixture/lists/mix${extension}`;

async function bytes(vfs, filename) {
  try {
    const handle = await vfs.openRead(filename), parts = [];
    try { for await (const part of handle.stream) parts.push(part); }
    finally { await handle.close(); }
    return Buffer.concat(parts).toString('base64');
  } catch (error) { if (error.code === 'not-found') return null; throw error; }
}

async function harness(t) {
  const database = await createPostgresTestDatabase(t, 'playlist_file');
  const store = new DomainStore(database);
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'playlist-file-state-'));
  const linkedChildren=new PostgresLinkedChildrenStore({database});await linkedChildren.initialize();
  const spoolRoot=path.join(stateRoot,'spool');await (await import('node:fs/promises')).mkdir(spoolRoot);
  const library = new LibraryService({fileSystem: testFileSystem,  store,linkedChildren, serverId: 'playlist-file-test', programDataPath: stateRoot,
    dataPath: path.join(stateRoot, 'data') });
  const storage = new StorageRegistry();
  storage.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await storage.createInstance('fixture', 'memory', {});
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/fixture', instanceId: 'fixture', capabilities: { create: true, replace: true } });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\playlist-oracle', accessRoot: '/fixture', style: 'windows',
    returnAccess: 'isolated playlist file oracle' });
  await adapter.mkdir('/lists');
  const calls = [], writes = [], errors = [];
  let lastBytes = originalBytes.toString('base64');
  let failWrite = null, preflightFailure = null;
  let failWriteNumber = null;
  let target = accessPath('.m3u');
  const originalWrite = vfs.write.bind(vfs);
  const snapshot = () => store.run(async db => ({
    Name: (await db.rows('BaseItems', { where: { Id: playlistId }, limit: 1 }))[0].Name,
    links: (await db.rows('LinkedChildren', { where: { ParentId: playlistId },
      orderBy: [{ column: 'SortOrder', direction: 'ASC' }] })).map(link => link.ChildId),
  }), { readOnly: true });
  vfs.write = async (filename, contents, options) => {
    assert.equal(filename, target, 'Only the mapped external file can be written.');
    assert.equal(options.signal, undefined);
    assert.equal(options.atomic, undefined);
    const parts=[];for await(const part of contents)parts.push(part);contents=Buffer.concat(parts);
    const committed = await snapshot();
    const event = calls.findLast(value => value.method === 'repository');
    assert.ok(event, 'The committed event precedes the external write.');
    event.item = committed;
    writes.push({ repository: committed, bytes: Buffer.from(contents).toString('base64') });
    if (failWrite || writes.length === failWriteNumber) {
      if (failWrite === 'partial') await originalWrite(filename, Buffer.from('partial'), { overwrite: true });
      throw new StorageError('unavailable', 'Controlled external write failure');
    }
    await originalWrite(filename, contents, options);
    lastBytes = Buffer.from(contents).toString('base64');
  };
  // Match the oracle's controlled ILibraryManager boundary here. This test
  // callback owns only repository persistence/event; the separate runtime
  // test executes the actual production metadata saver/image lifecycle.
  const updateExternalRepository = async (playlist, changes) => {
    const updated = await store.transaction(async db => {
      if (changes.links !== undefined){publishNativeItemLinks(playlist,linkedChildren.retain(changes.links));await linkedChildren.persist(db,playlist);}
      const data = { ...playlist.Data };
      if (changes.shares !== undefined) data.Shares = changes.shares;
      if (changes.openAccess !== undefined) data.OpenAccess = changes.openAccess;
      if (changes.ownerUserId !== undefined) data.OwnerUserId = changes.ownerUserId;
      await db.update('BaseItems', { Id: playlist.Id }, {
        Data: JSON.stringify(data), ...(changes.name === undefined ? {} : { Name: changes.name }),
      });
      return mapRecord((await db.rows('BaseItems', { where: { Id: playlist.Id }, limit: 1 }))[0]);
    });
    library.reportItemUpdated(updated, null, 16);
    releaseNativeItemLinks(playlist);await linkedChildren.flushReleases();return updated;
  };
  const playlists = new PlaylistService({fileSystem: testFileSystem,  store, library,linkedChildren,spoolRoot, programDataPath: stateRoot,
    dataPath: path.join(stateRoot, 'data'), vfs, identityMap,
    updateExternalRepository,
    preflightExternalSave: async () => { if (preflightFailure) throw preflightFailure; },
    queueExternalRefresh: () => { calls.push({ method: 'queue', bytes: lastBytes, forceSave: true, priority: 0 }); },
    clock: () => new Date('2026-10-10T12:00:00Z'), onError: error => errors.push(error) });
  library.on('ItemUpdated', event => calls.push({ method: 'repository', item: { Name: event.Item.Name },
    bytes: lastBytes, reason: event.UpdateReason, cancelled: false }));
  for (const [index, sample] of input.children.entries()) {
    const Type = sample.type === 'Audio' ? 'MediaBrowser.Controller.Entities.Audio.Audio'
      : sample.type === 'Movie' ? 'MediaBrowser.Controller.Entities.Movies.Movie'
        : `MediaBrowser.Controller.Entities.${sample.type}`;
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: id(index + 1), Type,
      Name: sample.name ?? '', Path: sample.path?.startsWith('$STATE')
        ? sample.path.replace('$STATE', 'Z:\\playlist-oracle').replaceAll('/', '\\') : sample.path,
      Album: sample.album, AlbumArtists: sample.albumArtists?.join('|'), Artists: sample.artists?.join('|'),
      RunTimeTicks: sample.ticks == null ? null : BigInt(sample.ticks),
      IsFolder: false, MediaType: sample.type === 'Movie' || sample.type === 'MusicVideo' ? 'Video' : 'Audio', Data: '{}' }));
  }
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: playlistId, Type: playlistNativeType,
    Path: identityPath('.m3u'), Name: 'Original', IsFolder: true, MediaType: 'Audio',
    Data: JSON.stringify({ OwnerUserId: ownerId, Shares: [], OpenAccess: false }) }));
  async function reset(extension = '.m3u', links = [1, 2, 1]) {
    target = accessPath(extension);
    await adapter.write(target.slice('/fixture'.length), originalBytes);
    await database.update('BaseItems', { Id: playlistId }, { Name: 'Original', Path: identityPath(extension), Tags: null,
      Data: JSON.stringify({ OwnerUserId: ownerId, Shares: [], OpenAccess: false }) });
    await database.client.query(`DELETE FROM "${database.schemaName}"."LinkedChildren" WHERE "ParentId"=$1`,[nativeTextBytes(playlistId)]);
    for(const [index,number]of links.entries())await database.insert('LinkedChildren',{ParentId:playlistId,ChildId:id(number),ChildType:0,SortOrder:index});
    calls.length = 0; writes.length = 0; lastBytes = originalBytes.toString('base64');
    failWrite = null; preflightFailure = null; failWriteNumber = null;
  }
  t.after(async () => {
    await playlists.close(); await library.close(); await storage.close(); await linkedChildren.close();await store.close();
    await rm(stateRoot, { recursive: true, force: true });
  });

  return { database, store, library,linkedChildren,spoolRoot, playlists, adapter, vfs, identityMap, stateRoot, originalWrite, updateExternalRepository, calls, writes, errors, reset, snapshot,
    setFailWrite: value => { failWrite = value; }, setPreflightFailure: value => { preflightFailure = value; },
    setFailWriteNumber: value => { failWriteNumber = value; } };
}

test('external playlist PostgreSQL commits and network writes match actual native operations',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const h = await harness(t);
    for (const [index, sample] of input.operations.entries()) await t.test(sample.name, async () => {
      await h.reset();
      if (sample.missingParent) h.setFailWrite('unavailable');
      if (sample.fileReadOnlyOnRepository) h.setFailWriteNumber(sample.fileReadOnlyOnRepository);
      if (sample.repositoryFailure) {
        h.database.queryHook = async function (...args) {
          const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
          if (/UPDATE\s+(?:"[^"]+"\.)?"BaseItems"/u.test(text)) throw new Error('Controlled repository failure');
          return this.query(...args);
        };
      }
      let error = null;
      try {
        if (sample.operation === 'add') await h.playlists.add(playlistId, sample.ids.map(id), { user: owner, position: sample.position });
        if (sample.operation === 'remove') await h.playlists.remove(playlistId, sample.entryIds.map(number => idKey(id(number))), { user: owner });
        if (sample.operation === 'move') await h.playlists.move(playlistId, idKey(id(sample.entryId)), sample.newIndex, { user: owner });
        if (sample.operation === 'update') await h.playlists.update(playlistId, { user: owner,
          ids: sample.ids?.map(id), name: sample.nameValue });
      } catch (caught) { error = caught; }
      finally { h.database.queryHook = null; }
      const expected = native.operations[index];
      assert.equal(expected.name, sample.name);
      assert.equal(Boolean(error), Boolean(expected.error));
      assert.deepEqual(await h.snapshot(), expected.repository);
      if (sample.repositoryFailure) {
        assert.deepEqual(h.calls, []); assert.deepEqual(h.writes, []);
      } else {
        const expectedCalls = expected.calls.map(call => call.method === 'repository'
          ? { ...call, bytes: call.bytes ?? originalBytes.toString('base64') } : call);
        assert.deepEqual(h.calls, expectedCalls);
      }
      const actualBytes = await bytes(h.vfs, accessPath('.m3u'));
      assert.equal(actualBytes, expected.bytes ?? originalBytes.toString('base64'));
      assert.deepEqual(h.errors, []);
    });
  });

test('playlist manager preserves its committed upload failure while draining failed relation releases',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const h = await harness(t);
    await h.reset();
    h.setFailWrite('partial');
    const write = h.vfs.write, flush = h.linkedChildren.flushReleases.bind(h.linkedChildren);
    const cleanupFailures = [];
    let uploadFailure;
    h.vfs.write = async (...args) => {
      try { return await write(...args); }
      catch (error) { uploadFailure = error; throw error; }
    };
    h.linkedChildren.flushReleases = async (...args) => {
      await flush(...args);
      if (uploadFailure) {
        const error = Object.assign(new Error('Controlled playlist relation release failure'), { code: 'relation-release', status: 503 });
        cleanupFailures.push(error);
        throw error;
      }
    };
    const values = error => ({ message: error.message, code: error.code, status: error.status });
    const failures = error => error.errors ? Array.from(error.errors).flatMap(failures) : [values(error)];
    try {
      await assert.rejects(h.playlists.add(playlistId, [id(2)], { user: owner }), error => {
        assert.equal(uploadFailure?.code, 'unavailable');
        assert.deepEqual(values(error.cause), values(uploadFailure));
        assert.ok(cleanupFailures.length > 0);
        assert.deepEqual(failures(error), [values(uploadFailure), ...cleanupFailures.map(values)]);
        return true;
      });
    } finally {
      h.vfs.write = write;
      h.linkedChildren.flushReleases = flush;
    }
    assert.deepEqual((await h.snapshot()).links, [id(1), id(2), id(1), id(2)]);
    assert.equal(await bytes(h.vfs, accessPath('.m3u')), Buffer.from('partial').toString('base64'));
    assert.deepEqual(h.calls.map(call => call.method), ['repository']);
    assert.deepEqual(await readdir(h.spoolRoot), []);
  });

test('all five playlist formats write through PostgreSQL service with exact native bytes',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const h = await harness(t);
    for (const [index, sample] of input.writes.slice(0, 5).entries()) await t.test(sample.extension, async () => {
      // PostgreSQL's FK cannot contain the oracle's controlled missing lookup.
      // Its resolved order is identical after omitting that unresolved entry.
      await h.reset(sample.extension, sample.links.filter(number => number !== 99));
      await h.playlists.update(playlistId, { user: owner });
      assert.equal(await bytes(h.vfs, accessPath(sample.extension)), native.writes[index].bytes);
      assert.equal(h.calls.length, 1); assert.equal(h.calls[0].reason, 16);
    });
  });

test('external playlist preflight, partial failure, sharing and HTTP preserve their commit boundaries',
  { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES }, async t => {
    const h = await harness(t);
    await h.reset();
    const disconnected = new PlaylistService({fileSystem: testFileSystem,  store: h.store, library: h.library,linkedChildren:h.linkedChildren,spoolRoot:h.spoolRoot,
      programDataPath: h.stateRoot, dataPath: path.join(h.stateRoot, 'data'), vfs: h.vfs, identityMap: h.identityMap });
    try {
      await assert.rejects(disconnected.update(playlistId, { user: owner, ids: [] }), error => error.status === 501);
      assert.deepEqual(await h.snapshot(), { Name: 'Original', links: [id(1), id(2), id(1)] });
      assert.deepEqual(h.calls, []); assert.deepEqual(h.writes, []);
    } finally { await disconnected.close(); }
    h.setPreflightFailure(new StorageError('not-supported', 'Controlled metadata saver preflight failure'));
    await assert.rejects(h.playlists.update(playlistId, { user: owner, ids: [id(2)] }), { code: 'not-supported' });
    assert.deepEqual(await h.snapshot(), { Name: 'Original', links: [id(1), id(2), id(1)] });
    assert.deepEqual(h.calls, []); assert.deepEqual(h.writes, []);
    await h.reset();
    h.setFailWrite('partial');
    await assert.rejects(h.playlists.add(playlistId, [id(2)], { user: owner }), { code: 'unavailable' });
    assert.deepEqual((await h.snapshot()).links, [id(1), id(2), id(1), id(2)]);
    assert.equal(await bytes(h.vfs, accessPath('.m3u')), Buffer.from('partial').toString('base64'));
    assert.deepEqual(h.calls.map(call => call.method), ['repository']);
    await h.reset();
    await h.playlists.updateUser(playlistId, editorId, { user: owner, canEdit: true });
    assert.equal(h.writes.length, 1);
    await h.playlists.add(playlistId, [id(2)], { user: editor });
    await h.playlists.removeUser(playlistId, editorId, { user: owner });
    assert.equal(h.writes.length, 3);
    await assert.rejects(h.playlists.add(playlistId, [id(2)], { user: editor }), error => error.status === 403);
    await h.database.update('BaseItems', { Id: playlistId }, { Tags: 'blocked' });
    const blocked = { ...owner, Policy: { ...owner.Policy, BlockedTags: ['blocked'] } };
    await assert.rejects(h.playlists.get(playlistId, { user: blocked }), error => error.status === 404);
    await h.reset();
    const application = await createTestApplication({ configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
      authentication: { authenticate: async () => ({ IsAuthenticated: true, UserId: idKey(ownerId), User: owner }), authorize() {} },
      users: { getUser: async () => owner }, playlists: h.playlists });
    await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${application.server.address().port}`;
      const result = await fetch(`${origin}/Playlists/${idKey(playlistId)}/Items?ids=${idKey(id(2))}`, { method: 'POST' });
      assert.equal(result.status, 204);
      const read = await fetch(`${origin}/Playlists/${idKey(playlistId)}`);
      assert.equal(read.status, 200);
      assert.deepEqual((await read.json()).ItemIds, [id(1), id(2), id(1), id(2)].map(idKey));
    } finally { await new Promise(resolve => application.server.close(resolve)); }
  });

test('external playlist writes use an actual rclone WebDAV mount and reject a read-only mount before SQL mutation', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE,
}, async t => {
  const h = await harness(t);
  const service = await startActualWebDav({ evidenceDirectory: process.env.MEDIAMANAGER_PLAYLIST_WEBDAV_EVIDENCE });
  const storage = new StorageRegistry(), requests = [];
  let failedPut = false;
  storage.registerType('webdav', config => new WebDavAdapter(config, {
    resolveCredential: async () => service.authorization,
    fetch: async (url, options) => {
      requests.push({ method: options.method, path: new URL(url).pathname });
      if (failedPut && options.method === 'PUT') return new Response('Controlled write failure', { status: 503 });
      return fetch(url, options);
    },
  }));
  await storage.createInstance('actual', 'webdav', { baseUrl: service.baseUrl, credentialRef: 'isolated',
    capabilities: { create: true, replace: true, mkdir: true } });
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/fixture', instanceId: 'actual', capabilities: { create: true, replace: true, mkdir: true } });
  vfs.mount({ path: '/readonly', instanceId: 'actual', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: 'Z:\\playlist-oracle', accessRoot: '/fixture', style: 'windows',
    returnAccess: 'isolated actual rclone playlist source' });
  const queued = [];
  const playlists = new PlaylistService({fileSystem: testFileSystem,  store: h.store, library: h.library,linkedChildren:h.linkedChildren,spoolRoot:h.spoolRoot,
    programDataPath: h.library.options.programDataPath, dataPath: h.library.options.dataPath,
    vfs, identityMap, updateExternalRepository: h.updateExternalRepository,
    queueExternalRefresh: playlist => { queued.push(playlist.Id); } });
  t.after(async () => { await playlists.close(); await storage.close(); await service.stop(); });
  await vfs.mkdir('/fixture/lists');
  for (const [index, sample] of input.writes.slice(0, 5).entries()) await t.test(sample.extension, async () => {
    await h.reset(sample.extension, sample.links.filter(number => number !== 99));
    await vfs.write(accessPath(sample.extension), originalBytes, { overwrite: true });
    await playlists.update(playlistId, { user: owner });
    assert.equal(await bytes(vfs, accessPath(sample.extension)), native.writes[index].bytes);
  });
  await h.reset();
  await vfs.write(accessPath('.m3u'), originalBytes, { overwrite: true });
  identityMap.bind(playlistId, '/readonly/lists/mix.m3u');
  const beforeRequests = requests.length;
  await assert.rejects(playlists.update(playlistId, { user: owner, ids: [id(2)] }), { code: 'not-supported' });
  assert.deepEqual(await h.snapshot(), { Name: 'Original', links: [id(1), id(2), id(1)] });
  assert.ok(requests.slice(beforeRequests).every(request => request.method !== 'PUT'));
  assert.equal(await bytes(vfs, accessPath('.m3u')), originalBytes.toString('base64'));
  identityMap.bind(playlistId, accessPath('.m3u'));
  failedPut = true;
  await assert.rejects(playlists.add(playlistId, [id(2)], { user: owner }), { code: 'unavailable' });
  assert.deepEqual((await h.snapshot()).links, [id(1), id(2), id(1), id(2)]);
  assert.deepEqual(queued, [], 'A synchronous failed network write does not queue ForceSave.');
  assert.equal(await bytes(vfs, accessPath('.m3u')), originalBytes.toString('base64'));
  assert.ok(requests.some(request => request.method === 'PUT'));
});

test('runtime external playlist repository runs XML and images before the committed event and synchronous file', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const h = await harness(t);
  await h.reset();
  h.vfs.write = h.originalWrite;
  const errors = [];
  const runtime = await createTestRuntime({ database: h.database, vfs: h.vfs, identityMap: h.identityMap,
    programDataPath: h.stateRoot, configurationDirectoryPath: path.join(h.stateRoot, 'config'),
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
    serverId: 'playlist-runtime', onError: error => errors.push(error.message) });
  const phases = [];
  let rejectXml = false, rejectFile = false, rejectImages = false;
  h.database.queryHook = async function (...args) {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    if (/DELETE FROM\s+(?:"[^"]+"\.)?"BaseItemImageInfos"/u.test(sql)) {
      phases.push({ images: true });
      if (rejectImages) throw new Error('Controlled image persistence failure');
    }
    return this.query(...args);
  };
  const phaseNames = () => phases.map(phase => phase.filename ?? phase.event ?? 'images');
  h.vfs.write = async (filename, content, options) => {
    assert.equal(options.signal, undefined);
    phases.push({ filename, state: await h.snapshot() });
    if (rejectXml && filename.endsWith('.xml') || rejectFile && filename.endsWith('.m3u')) {
      throw new StorageError('unavailable', `Controlled ${filename} failure`);
    }
    return h.originalWrite(filename, content, options);
  };
  runtime.library.on('ItemUpdated', event => {
    if (idKey(event.Item.Id) === idKey(playlistId)) phases.push({ event: event.UpdateReason, name: event.Item.Name });
  });
  const queuedRefreshReady = Promise.withResolvers(), queuedRefresh = runtime.metadata.queuedRefresh;
  runtime.metadata.queuedRefresh = async (...args) => { await queuedRefreshReady.promise; return queuedRefresh(...args); };
  const refreshModes = [], refreshLiveItem = runtime.metadata.refreshLiveItem.bind(runtime.metadata);
  runtime.metadata.refreshLiveItem = (item, options) => {
    refreshModes.push({ id: item.Id, mode: options.MetadataRefreshMode, forceSave: options.ForceSave });
    return refreshLiveItem(item, options);
  };
  try {
    await runtime.playlists.update(playlistId, { user: owner, name: 'Runtime name' });
    assert.deepEqual(phaseNames(), ['/fixture/lists/mix.xml', 'images', 16, accessPath('.m3u')]);
    assert.equal(phases[0].state.Name, 'Original');
    assert.equal(phases[3].state.Name, 'Runtime name');
    assert.match(Buffer.from(await bytes(h.vfs, '/fixture/lists/mix.xml'), 'base64').toString('utf8'), /<LocalTitle>Runtime name<\/LocalTitle>/u);
    assert.equal((await h.snapshot()).Name, 'Runtime name');
    assert.deepEqual(errors, []);

    // A disabled destination fails every saver preflight before the first
    // clear-list commit, not after the playlist file has already changed.
    const xmlPlugin = runtime.metadata.registry.plugins().find(plugin => plugin.id === 'local-xml');
    const xmlSaver = xmlPlugin.providers.find(provider => provider.id === 'PlaylistXmlSaver');
    const originalValidate = xmlSaver.validateSave;
    xmlSaver.validateSave = () => { throw new StorageError('not-supported', 'Controlled XML preflight failure'); };
    phases.length = 0;
    await assert.rejects(runtime.playlists.update(playlistId, { user: owner, ids: [id(2)] }), { code: 'not-supported' });
    assert.deepEqual(phases, []);
    assert.deepEqual((await h.snapshot()).links, [id(1), id(2), id(1)]);
    xmlSaver.validateSave = originalValidate;

    // Image persistence is an independent phase after XML. Its failure
    // preserves the XML side effect but cannot commit BaseItems or the file.
    rejectImages = true; phases.length = 0;
    await assert.rejects(runtime.playlists.update(playlistId, { user: owner, name: 'After image failure' }), /Controlled image persistence failure/u);
    assert.equal((await h.snapshot()).Name, 'Runtime name');
    assert.deepEqual(phaseNames(), ['/fixture/lists/mix.xml', 'images']);
    assert.match(Buffer.from(await bytes(h.vfs, '/fixture/lists/mix.xml'), 'base64').toString('utf8'), /<LocalTitle>After image failure<\/LocalTitle>/u);
    rejectImages = false;

    // ProviderManager swallows a saver I/O error and continues repository
    // persistence; SavePlaylistFile's later I/O error instead propagates.
    rejectXml = true; phases.length = 0;
    await runtime.playlists.update(playlistId, { user: owner, name: 'After XML failure' });
    assert.equal((await h.snapshot()).Name, 'After XML failure');
    assert.deepEqual(phaseNames(), ['/fixture/lists/mix.xml', 'images', 16, accessPath('.m3u')]);
    assert.deepEqual(errors, ['Controlled /fixture/lists/mix.xml failure']);
    rejectXml = false; rejectFile = true; phases.length = 0;
    await assert.rejects(runtime.playlists.update(playlistId, { user: owner, name: 'After file failure' }), { code: 'unavailable' });
    assert.equal((await h.snapshot()).Name, 'After file failure');
    assert.deepEqual(phaseNames(), ['/fixture/lists/mix.xml', 'images', 16, accessPath('.m3u')]);
    rejectFile = false;

    // The actual host owns the ForceSave lifecycle after add; it is not a
    // no-op callback, and it cannot inherit the preparation transaction.
    phases.length = 0;
    await runtime.playlists.add(playlistId, [id(2)], { user: owner });
    assert.deepEqual((await h.snapshot()).links, [id(1), id(2), id(1), id(2)]);
    const committedFile = await bytes(h.vfs, accessPath('.m3u'));
    queuedRefreshReady.resolve();
    await runtime.store.run(() => {});
    await runtime.metadata.drain();
    assert.deepEqual(refreshModes, [{ id: playlistId, mode: 'Default', forceSave: true }]);
    // Native MetadataRefreshOptions defaults to Default, whose local result
    // replaces links. BaseXmlSaver omits PlaylistItems for an external file;
    // the XML provider therefore replaces the repository relation with empty.
    assert.deepEqual((await h.snapshot()).links, []);
    assert.doesNotMatch(Buffer.from(await bytes(h.vfs, '/fixture/lists/mix.xml'), 'base64').toString('utf8'), /<PlaylistItems/u);
    assert.equal(await bytes(h.vfs, accessPath('.m3u')), committedFile, 'ForceSave does not rewrite the external playlist file.');
    assert.ok(phases.filter(phase => phase.filename === '/fixture/lists/mix.xml').length >= 2);
    assert.equal((await h.database.rows('BaseItems', { where: { Id: playlistId } }))[0].Path, identityPath('.m3u'));
  } finally { queuedRefreshReady.resolve(); h.vfs.write = h.originalWrite; h.database.queryHook = null; await runtime.close(); }
});
