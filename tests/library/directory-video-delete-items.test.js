import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { tableDefinition } from '../../src/database/model.js';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { resolveOrdinaryVideoFile } from '../../src/library/video-file-resolver.js';
import path from 'node:path';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { setFolderChildren } from '../../src/library/folder-cache.js';
import { persistMetadata } from '../../src/metadata/persistence.js';
import { EMPTY_ID, guid, idKey } from '../../src/library/records.js';
import { discoveryFixture, ordinal } from './video-discovery-fixture.js';
import { resolveDirectoryVideo, projectDirectoryItem, projectDirectoryResolution } from './directory-video-fixture.js';
import { fixturePathStyle, projectStatePath } from './fixture-state-path.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { mediaSources } from '../../src/library/dto.js';
import { mediaVersions, sortMediaSources } from '../../src/library/media-versions.js';

import { seedNativeConstructorControl, completeColumns } from './directory-persistence-fixture.js';

const root = new URL('./fixtures/directory-video-delete-items/', import.meta.url), repository = new URL('../../', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async file => parseLosslessJson(await readFile(new URL(file, root), 'utf8'))));
const fixtureHashes = Object.fromEntries(provenance.fixtureFiles.map(file => [file.path, file.sha256]));
const sourceHashes = Object.fromEntries(provenance.sourceFiles.map(file => [file.path, file.sha256]));
const runtimeHashes = Object.fromEntries(Object.entries(provenance.runtime.assemblies)
  .map(([name, value]) => [name, value.sha256]));
const safetyDivergence = input.filter(sample => sample.safetyDivergence);

test('live video source protocols depend on the actual path without a repository LocationType projection', async () => {
  const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Movies.Movie');
  item.Id = '98c00000-0000-0000-0000-000000000010'; item.Name = 'Live movie';
  assert.equal(item.LocationType, undefined);
  const project = () => mediaSources(item, { byId: new Map([[idKey(item.Id), item]]), links: [],
    db: { rows: async () => [] } }, null, {});
  for (const Path of ['D:\\Media\\Film.mkv', '\\\\server\\share\\Film.mkv', '/media/Film.mkv', null]) {
    item.Path = Path;
    const [source] = await project();
    assert.equal(source.Protocol, 'File'); assert.equal(source.Path, Path); assert.equal(source.Id, idKey(item.Id));
    assert.equal(source.Type, Path ? 'Default' : 'Placeholder');
  }
  item.Path = 'https://media.example.test/Film.mkv';
  assert.equal((await project())[0].Protocol, 'Http');
  item.Path = 'unknown://media.example.test/Film.mkv';
  await assert.rejects(project(), error => error.status === 501 && /media source protocol/u.test(error.message));
  item.Path = '/media/Film.strm'; item.IsShortcut = true;
  for (const [target, protocol] of [['https://media.example.test/Film.mkv', 'Http'],
    ['rtsp://media.example.test/Film', 'Rtsp'], ['rtp://media.example.test/Film', 'Rtp']]) {
    item.ShortcutPath = target;
    const [source] = await project();
    assert.equal(source.Path, target); assert.equal(source.Protocol, protocol); assert.equal(source.IsRemote, true);
  }
  item.ShortcutPath = '/private/Film.mkv';
  assert.equal((await project())[0].Path, item.Path, 'a local shortcut target does not replace its source file');
  item.ShortcutPath = 'unknown://media.example.test/Film';
  await assert.rejects(project(), error => error.status === 501 && /shortcut media source protocol/u.test(error.message));
});

test('directory DeleteItem seals all native columns, complete families and real batch faults', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  assert.deepEqual(fixtureHashes, {
    'tests/library/fixtures/directory-video-delete-items/input.json': '4120308d153a5838257604ea4c852bbcbe141a58566cbe7acc1bd7dfc0c97d3e',
    'tests/library/fixtures/directory-video-delete-items/Program.cs': '218611ac7b190186311f2705a843d6c199388c1c82ab7e861b1ac3022d82def0',
    'tests/library/fixtures/directory-video-delete-items/Oracle.csproj': 'cbe1a514da582cbf55a443ee14c93f731f84816d10e7672fb713045ac5d78efe',
    'tests/library/fixtures/directory-video-delete-items/native.json': '33a774b4cfcee027894f9b5735ed89a53451a51d66225309f3b978da5705de7f',
    'tests/Directory.Build.props': 'd13564ee3d33568e7f897c6fe74ea5e71cc5ef9539e16854e628c5295c2319bd'
  });
  const portableNative = await readFile(new URL('native.json', root));
  assert.equal(portableNative.includes(13), false);
  assert.equal(portableNative.at(-1), 10);
  assert.equal(createHash('sha256').update(portableNative).digest('hex'), provenance.record.portableNativeSha256);
  assert.equal(createHash('sha256').update(Buffer.concat([
    Buffer.from(portableNative.subarray(0, -1).toString('utf8').replaceAll('\n', '\r\n')),
    Buffer.from('\n')
  ])).digest('hex'), provenance.record.rawNativeSha256);
  assert.equal(native.actualFrozenDirectoryItemDeletion, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope); assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(native.results.length, 41);
  assert.equal(createHash('sha256').update(stringifyNativeJson(native.results.slice(0, 23))).digest('hex'),
    provenance.record.previous23ResultsSha256);
  const v6Scenes = new Set(['delete-folder-source-io-failure', 'delete-folder-readonly-source']);
  assert.equal(createHash('sha256').update(stringifyNativeJson(native.results.slice(0, 35).filter(result => !v6Scenes.has(result.name)))).digest('hex'),
    provenance.record.previous33ResultsSha256);
  assert.equal(createHash('sha256').update(stringifyNativeJson(native.results.slice(0, 35))).digest('hex'),
    provenance.record.previous35ResultsSha256);
  const drift = native.results.filter(result => safetyDivergence.some(sample => sample.name === result.name));
  assert.deepEqual(drift.map(result => {
    const types = result.calls.find(call => call.action === 'video-type-drift');
    const deletion = result.calls.find(call => call.action === 'delete-paths');
    return {
      name: result.name,
      persisted: types.persisted,
      live: types.live,
      target: deletion.paths[0].path,
      remainingMedia: result.files.map(file => file.path).filter(file => file.startsWith('$STATE\\media'))
    };
  }), [
    { name: 'delete-direct-dvd-persisted-disc-live-file-drift', persisted: 'Dvd', live: 'VideoFile',
      target: '$STATE\\media', remainingMedia: [] },
    { name: 'delete-multidisc-dvd-persisted-disc-live-file-drift', persisted: 'Dvd', live: 'VideoFile',
      target: '$STATE\\media\\Film', remainingMedia: ['$STATE\\media\\Keep\\sentinel.txt', '$STATE\\media\\primary.mkv'] },
    { name: 'delete-direct-dvd-persisted-file-live-disc-drift', persisted: 'VideoFile', live: 'Dvd',
      target: '$STATE\\media\\Film', remainingMedia: ['$STATE\\media\\Keep\\sentinel.txt', '$STATE\\media\\primary.mkv'] },
    { name: 'delete-multidisc-dvd-persisted-file-live-disc-drift', persisted: 'VideoFile', live: 'Dvd',
      target: '$STATE\\media\\Film', remainingMedia: ['$STATE\\media\\Keep\\sentinel.txt', '$STATE\\media\\primary.mkv'] },
    { name: 'delete-direct-dvd-live-bluray-drift', persisted: 'Dvd', live: 'BluRay',
      target: '$STATE\\media\\Film', remainingMedia: ['$STATE\\media\\Keep\\sentinel.txt', '$STATE\\media\\primary.mkv'] },
    { name: 'delete-multidisc-dvd-live-bluray-drift', persisted: 'Dvd', live: 'BluRay',
      target: '$STATE\\media\\Film', remainingMedia: ['$STATE\\media\\Keep\\sentinel.txt', '$STATE\\media\\primary.mkv'] }
  ]);
  assert.deepEqual(sourceHashes, {
    'Emby.Server.Implementations/Library/LibraryManager.cs': '4729de97560262702a44c5829bf93bbc5deec379e9b3018b231aaa6d65643c44',
    'MediaBrowser.Controller/Entities/Video.cs': '03df015992ee4e95e175c499b36a7b21d9facc4f391cfd89235ad652d2eb0b11',
    'MediaBrowser.Controller/Entities/BaseItem.cs': '9dc7b96a93c9fbe874cdcededdca395b5aa2df6070f5cfc9c8959539dcd76469',
    'Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs': 'df64ede4e72fca107cb86127e44b4c81321b3cf560ea3b7f0eccf4462f148d14',
    'Emby.Server.Implementations/Library/ExternalDataManager.cs': '9645e24af7dab72bced234455ed708e347853c8c4f692ee728a01d9f9554c478',
    'Emby.Server.Implementations/Library/PathManager.cs': '35db88229462c4531839f6bb19ed3cdd00a354eaf96eeac8422307bca5e9e98b'
  });
  assert.deepEqual(provenance.sourceAnchors, [
    { path: 'Emby.Server.Implementations/Library/LibraryManager.cs', lines: '558-624',
      contract: 'internal metadata precedes required source deletion; Parent detach, external cleanup, persistence, cache and Removed follow' },
    { path: 'Emby.Server.Implementations/Library/LibraryManager.cs', lines: '667-679',
      contract: 'required source IOException and UnauthorizedAccessException propagate' },
    { path: 'Emby.Server.Implementations/Library/LibraryManager.cs', lines: '725-754',
      contract: 'every item contributes internal metadata while only Video contributes trickplay, chapter, subtitle and attachment paths' }
  ]);
  assert.equal(provenance.capturedAt, '2026-10-08T00:39:31.537Z');
  assert.equal(provenance.reference.head, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
  assert.equal(provenance.reference.contentDigest, 'e28a983db179b720c3b16d7416ee4112894a3115c4be6fe43c61c52e0d9a8313');
  assert.equal(provenance.runtime.dotnet.sha256, '21a46f1e5235cf4e844b9de5429f0e198b9c97a41f0503a66442f1d639ca3ee6');
  assert.equal(provenance.runtime.jellyfinDll.sha256, 'a43fa24c44677e579fcec79d637789b9f36633d02e5434e76a0e03fa13027767');
  assert.deepEqual(runtimeHashes, {
    'MediaBrowser.Controller.dll': '051c588a8e85a3a7cdde8dc3d9a1112217fd7e973a86fe2ff90cf765bedb75a8',
    'Emby.Server.Implementations.dll': '8d369435646570958505c58b9cb17da169855dabc105d0e933524361e9b7b1c8',
    'Jellyfin.Server.Implementations.dll': '4da187af02503e82135eb192351d01490484e8ebc8c653d849f7e2900a177672',
    'Emby.Naming.dll': '55085cf14d1e58a7a1e99e0ffc37bde0545bbe85f7f09995388a6e465cca3a45'
  });
  assert.deepEqual(provenance.record, {
    path: 'D:/mediamanager-validation/20261005/results/directory-disc-source-delete-oracle-20261008-v8-drift-actual/record.json',
    sha256: '05c16f8af93dc3abbe5e02837ef28d4fcfe3de9fbb438ae46f98c56024b482e6',
    sourceFilesSha256: 'dc017434f0f86a8e0b20fb1d292878b00cb6e4090d11d2aa74e1164b55c0daa1',
    oracleAssemblySha256: '0c4fa6cfcb8a5987a1fb45336a114cba1b796b04bf15a3ea613235a8bae7439a',
    rawNativeSha256: '95285eb391e6c3ff71ac56f67c87258f1f7b97f43298fad04e36f757e07f3347',
    portableNativeSha256: '33a774b4cfcee027894f9b5735ed89a53451a51d66225309f3b978da5705de7f',
    previous23ResultsSha256: '4d7a9ec180ad8d948eede8b015766d15c29a8251be07233c0ada0d465640992e',
    previous33ResultsSha256: '4586e8586dc9fb89ceb25bdafcbeeca351c5dd3f1d1129060e59e9f263b77f15',
    previous35ResultsSha256: '55c897a7d8513f61ab964d51509b5413cf23116a6e1a4c838e8c1d5751b490d8',
    portableNormalization: 'CRLF to LF with the original final LF retained',
    buildStatus: 0,
    processStatus: 0
  });
  assert.equal(provenance.command,
    'node tools/validation/oracle.js tests/library/fixtures/directory-video-delete-items/Oracle.csproj D:/mediamanager-validation/20261005/results/directory-disc-source-delete-oracle-20261008-v8-drift-actual tests/library/fixtures/directory-video-delete-items/input.json {output}/native.json {output}/state');
  assert.equal(provenance.candidateVerified, true);
  const columns = tableDefinition('BaseItems').columns.map(column => column.name).sort();
  assert.equal(columns.length, 72);
  for (const result of native.results) for (const row of result.columns) assert.deepEqual(Object.keys(row).sort(), columns);
});

for (const dialect of ['postgres']) for (const sample of input.filter(value => !value.safetyDivergence)) test(`${dialect}: actual directory DeleteItem ${sample.name}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const value = await discoveryFixture(t, dialect, sample, { resolveFile: resolveOrdinaryVideoFile, captureDatabaseDeletes: false, captureMetadataEvents: false }), { fixture, loaded, calls } = value;
  await seedNativeConstructorControl(fixture, loaded, sample);
  const resolved = await resolveDirectoryVideo(value, sample);
  const allResolved = [...resolved];
  const resolvedProjection = resolved.map(item => projectDirectoryItem(item, fixture, sample));
  const lookupIds = new Map();
  for (const item of resolved) {
    lookupIds.set(idKey(item.Id), item.Id);
    for (const path of item.LocalAlternateVersions ?? []) if (path) {
      const id = loaded.getNewItemId(path, item.NativeType); lookupIds.set(idKey(id), id);
    }
    if (sample.nullAlternates) item.LocalAlternateVersions = null;
    if (sample.channelOriginal) item.ChannelId = '98C00000-0000-0000-0000-000000000009';
  }

  const registered = new Map(), creator = new ItemCreationService({ ...fixture,
    registerItem: item => registered.set(idKey(item.Id), item) });
  fixture.library.itemCreation = creator;
  creator.registerItem(loaded.parent);
  if (sample.channelOriginal) {
    const getLiveMediaSources = fixture.library.getLiveMediaSources.bind(fixture.library);
    fixture.library.getLiveMediaSources = item => item.SourceType !== 'Channel' ? getLiveMediaSources(item)
      : fixture.store.run(async database => {
        // The sealed oracle supplies no static channel sources or streams.
        // BaseItem then enumerates the actual Video version family; internal
        // cleanup consumes their IDs, including any alternate sources.
        const state = await fixture.library.load(database, null, { baseRows: await database.rows('BaseItems'), includeUserData: false });
        try {
          state.byId.set(idKey(item.Id), item);
          return sortMediaSources(mediaVersions(item, state).map(({ item }) => ({ Id: idKey(item.Id),
            VideoType: item.VideoType, Video3DFormat: item.Video3DFormat, MediaStreams: [] })), item.Id);
        } finally { await state.dispose(); }
      });
  }
  fixture.library.itemDeletion = new ItemDeletionService({ ...fixture, itemCreation: creator,
    updates: fixture.host.updates, externalData: loaded.videoVersionDiscovery.externalData,
    linkedChildReferences: { reroute: async () => [] }, now: () => fixture.now });
  const deleteItems = fixture.library.itemDeletion.deleteItems.bind(fixture.library.itemDeletion);
  fixture.library.itemDeletion.deleteItems = async (idsPlan, scope, publishDeletedPage) => {
    const ids = [];
    let previous = -1n;
    for (;;) {
      const rows = (await scope.database.client.query({ text: `SELECT requested.* FROM (${idsPlan.text}) requested
        WHERE requested."Ordinal" > $${idsPlan.values.length + 1} ORDER BY requested."Ordinal" LIMIT 128`,
        values: [...idsPlan.values, previous] })).rows;
      for (const row of rows) ids.push(guid(row.Key));
      if (rows.length < 128) break;
      previous = BigInt(rows.at(-1).Ordinal);
    }
    const state = sample.recordDeletePhases ? await fixture.deletionPhaseState?.() : null;
    calls.push({ action: 'delete', ids, ...(state ? { state } : {}) });
    return deleteItems(idsPlan, scope, publishDeletedPage);
  };
  t.after(() => creator.close());
  const updates = fixture.host.updates, repositoryUpdate = updates.updateRepository.bind(updates);
  updates.updateRepository = (context, result, reason, options = {}) => repositoryUpdate(context, result, reason, { ...options,
    saverOperation: async () => { calls.push({ action: 'saver', id: guid(result.Item.Id), reason }); return []; },
    persist: async (updated, result, options) => {
      calls.push({ action: 'save', items: [result.Item, ...options.newVersions].map(item => projectDirectoryItem(item, fixture, sample)), cancellable: Boolean(options.signal) });
      return persistMetadata(fixture.store, context, result, options);
    }
  });
  const saveItems = creator.saveItems.bind(creator);
  creator.saveItems = async (items, options) => {
    calls.push({ action: 'save', items: items.map(item => projectDirectoryItem(item, fixture, sample)), cancellable: Boolean(options.signal) });
    return saveItems(items, options);
  };
  fixture.library.on('ItemAdded', event => calls.push({ action: 'event', kind: 'added', id: guid(event.Item.Id) }));
  fixture.library.on('ItemUpdated', event => calls.push({ action: 'event', kind: 'updated', id: guid(event.Item.Id), reason: event.UpdateReason }));
  fixture.library.on('ItemRemoved', event => calls.push({ action: 'event', kind: 'removed', id: guid(event.Item.Id) }));
  let exception = null;
  value.activate();
  try {
    await fixture.library.createItems(resolved, loaded.parent);
    let deleted = resolved[0];
    if (sample.deleteAlternate) {
      const [link] = await fixture.database.rows('LinkedChildren', { where: { ParentId: deleted.Id, ChildType: 2 }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
      deleted = await creator.getItemById(link.ChildId);
    }
    const createDescendants = async folder => {
      const accessPath = fixture.identityMap.resolve({ identityPath: folder.Path, style: fixturePathStyle });
      // This control models ManagedFileSystem directory enumeration on the
      // frozen Windows fixture. Explicit ResolvePaths inputs keep their order.
      const entries = (await fixture.vfs.list(accessPath)).entries.map(entry => path.relative(path.join(fixture.stateRoot, 'media'), path.join(folder.Path, entry.name)).replaceAll('\\', '/'))
        .sort(ordinal);
      const children = await resolveDirectoryVideo({ ...value, loaded: { ...loaded, parent: folder } }, { ...sample, entries });
      for (const child of children) { lookupIds.set(idKey(child.Id), child.Id); allResolved.push(child); }
      await fixture.library.createItems(children, folder); setFolderChildren(folder, children);
      for (const child of children) if (child.IsFolder) await createDescendants(child);
      return children;
    };
    if (sample.createDescendants) await createDescendants(deleted);
    if (sample.removeAlternatesBeforeDelete) {
      let links = await fixture.database.rows('LinkedChildren', { where: { ParentId: deleted.Id, ChildType: 2 }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
      if (sample.removeAlternatesBeforeDelete === 'first') links = links.slice(0, 1);
      for (const link of links) {
        const child = await creator.getItemById(link.ChildId);
        const accessPath = fixture.identityMap.resolve({ identityPath: child.Path, style: fixturePathStyle });
        await fixture.vfs.delete(accessPath);
      }
    }
    const external = loaded.videoVersionDiscovery.externalData;
    const assets = new MetadataImageAssets({fileSystem: testFileSystem,  ...fixture, metadataPath: loaded.metadataPath, stateRoots: [loaded.dataPath] });
    for (const markerItem of sample.createDescendants ? allResolved : [deleted]) for (const directory of new Set([internalImagePath(markerItem, loaded.metadataPath), ...external.paths(markerItem, loaded)])) {
      const absolute = path.resolve(directory), relative = path.relative(fixture.stateRoot, absolute);
      assert.ok(relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
      await assets.write(path.join(absolute, 'marker.txt'), Buffer.from('delete marker'));
    }
    const directoryDisc = ['Dvd', 'BluRay'].includes(deleted.VideoType);
    const primaryAccess = fixture.identityMap.resolve({ itemId: deleted.Id, identityPath: deleted.Path, style: fixturePathStyle });
    const sourceAccess = deleted.IsFolder || directoryDisc && deleted.AdditionalParts.length === 0
      ? primaryAccess : path.posix.dirname(primaryAccess);
    const sourceIdentity = deleted.IsFolder || directoryDisc && deleted.AdditionalParts.length === 0
      ? deleted.Path : path.dirname(deleted.Path);
    const internalMarker = path.join(internalImagePath(deleted, loaded.metadataPath), 'marker.txt');
    const externalMarkers = external.paths(deleted, loaded).map(directory => path.join(directory, 'marker.txt'));
    const exists = async (target, reader) => { try { await reader(target); return true; } catch { return false; } };
    fixture.deletionPhaseState = async () => ({
      sourceExists: await exists(sourceAccess, target => fixture.vfs.stat(target)),
      internalExists: await exists(internalMarker, target => assets.stat(target)),
      externalExists: (await Promise.all(externalMarkers.map(target => exists(target, value => assets.stat(value))))).some(Boolean),
      databaseExists: (await fixture.database.rows('BaseItems', { where: { Id: deleted.Id } })).length !== 0,
      cacheExists: await creator.getItemById(deleted.Id) != null,
      parentId: guid(deleted.ParentId ?? EMPTY_ID)
    });
    if (sample.removeSourceBeforeDelete) await fixture.vfs.delete(sourceAccess, { recursive: true });
    if (sample.recordDeletePhases) calls.push({
      action: 'delete-paths',
      paths: [{ path: projectStatePath(sourceIdentity, fixture.stateRoot), directory: true }],
      state: await fixture.deletionPhaseState()
    });
    const externalFiles = external.deleteItemFiles.bind(external);
    external.deleteItemFiles = async (...args) => {
      const state = sample.recordDeletePhases ? await fixture.deletionPhaseState() : null;
      const index = calls.length, result = await externalFiles(...args);
      if (state) {
        assert.equal(calls[index]?.action, 'external-files');
        calls[index] = { ...calls[index], state };
      }
      return result;
    };
    if (sample.lockSource || sample.readOnlySource) {
      const deleteSource = fixture.vfs.resolve(sourceAccess), adapterDelete = fixture.adapter.delete.bind(fixture.adapter);
      fixture.adapter.delete = async (location, options) => {
        if (location === deleteSource.path) {
          const partiallyDeleted = deleted.Type === 'Folder' ? ['Unrelated'] : ['VIDEO_TS', 'Film.trickplay'];
          for (const child of partiallyDeleted) try {
            await adapterDelete(path.posix.join(deleteSource.path, child), { recursive: true });
          } catch (error) { if (error.code !== 'not-found') throw error; }
          throw Object.assign(new Error('Controlled source deletion failure'), {
            code: sample.readOnlySource ? 'permission-denied' : 'io'
          });
        }
        return adapterDelete(location, options);
      };
    }
    setFolderChildren(loaded.parent, resolved); loaded.parent.UserData = [];
    if (sample.failDelete) {
      await fixture.database.client.query("CREATE FUNCTION delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled deletion failure'; END $$");
      await fixture.database.client.query('CREATE TRIGGER delete_failure BEFORE DELETE ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION delete_failure()');
    }
    await fixture.library.deleteItem(deleted, { DeleteFileLocation: Boolean(sample.deleteSource), DeleteFromExternalProvider: false },
      sample.nullDeleteParent ? null : loaded.parent, !sample.noNotify);
    if (sample.recordDeletePhases) {
      const removed = calls.findLastIndex(call => call.action === 'event' && call.kind === 'removed' && idKey(call.id) === idKey(deleted.Id));
      assert.notEqual(removed, -1);
      calls[removed] = { ...calls[removed], state: await fixture.deletionPhaseState() };
    }
  } catch (error) {
    if (sample.failDelete && databaseFault(error, dialect)) {
      assert.match(error.message, /Controlled deletion failure/u); exception = 'SqliteException';
    } else if (sample.expectException && (sample.lockSource || sample.readOnlySource)) {
      assert.match(error.message, /Controlled source deletion failure/u); exception = sample.expectException;
    } else throw error;
  }
  // The recorder snapshots the complete resolved projection before mutation.
  // Its null-array scenarios fail before SaveItems can project that array.
  const actual = await projectDirectoryResolution(value, sample, [], exception);
  actual.resolved = resolvedProjection;
  const primaryIds = new Set(allResolved.map(item => idKey(item.Id)));
  for (const row of actual.rows) if (primaryIds.has(idKey(row.id)) && (row.type.endsWith('.Folder') || sample.useResolveTime)) {
    assert.equal(row.dateCreated, fixture.now); row.dateCreated = '$UTC_RESOLVE';
  }
  actual.ancestors = (await fixture.database.rows('AncestorIds')).map(row => ({ itemId: guid(row.ItemId), parentItemId: guid(row.ParentItemId) }))
    .sort((left, right) => ordinal(left.itemId, right.itemId) || ordinal(left.parentItemId, right.parentItemId));
  actual.providers = (await fixture.database.rows('BaseItemProviders')).map(row => ({ itemId: guid(row.ItemId), providerId: row.ProviderId, providerValue: row.ProviderValue }))
    .sort((left, right) => ordinal(left.itemId, right.itemId) || ordinal(left.providerId, right.providerId));
  actual.columns = await completeColumns(fixture, allResolved, sample);
  actual.createdLookup = [];
  for (const id of [...lookupIds.values()].sort((left, right) => ordinal(guid(left), guid(right)))) {
    const item = await creator.getItemById(id);
    actual.createdLookup.push({ id: guid(id), item: item && projectDirectoryItem(item, fixture, sample) });
  }
  if (sample.wrongType || sample.existingType || sample.dropExisting) actual.oldLookupName = (await creator.getItemById(value.oldId))?.Name ?? null;
  const expected = native.results.find(result => result.name === sample.name);
  assert.deepEqual(actual, expected);
  assert.deepEqual([...registered.keys()], [...new Set([idKey(loaded.parent.Id), ...expected.calls.filter(call => call.action === 'save').flatMap(call => call.items.map(item => idKey(item.id)))])]);
  for (const item of resolved) assert.equal(registered.get(idKey(item.Id)), item, 'Registration preserves the live entity.');
});

const databaseFault = error => error.code === 'P0001';
