import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ItemCreationService } from '../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../src/library/item-deletion-service.js';
import { LinkedChildReferenceService } from '../../src/library/linked-child-reference-service.js';
import { resolveOrdinaryVideoFile } from '../../src/library/video-file-resolver.js';
import { setPrimaryVersion, updateLiveItemRepository } from '../../src/library/live-item-repository.js';
import { EMPTY_ID, idKey, sameId } from '../../src/library/records.js';
import { readCachedFolderChildren, setFolderChildren } from '../../src/library/folder-cache.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { discoveryFixture } from './video-discovery-fixture.js';
import { resolveDirectoryVideo } from './directory-video-fixture.js';
import { seedNativeConstructorControl } from './directory-persistence-fixture.js';

const input = JSON.parse(await readFile(new URL('./fixtures/directory-video-delete-items/input.json', import.meta.url), 'utf8'));

async function setup(t, dialect, name = 'delete-movie-source-directory', nfo = false) {
  const sample = input.find(sample => sample.name === name);
  const value = await discoveryFixture(t, dialect, sample, { resolveFile: resolveOrdinaryVideoFile });
  const { fixture, loaded } = value;
  await seedNativeConstructorControl(fixture, loaded, sample);
  if (nfo) {
    fixture.registry.register(createNfoPlugin({fileSystem: testFileSystem,  vfs: fixture.vfs }));
    const load = fixture.loadContext;
    fixture.loadContext = fixture.host.loadContext = async (...args) => {
      const context = await load(...args); context.libraryOptions.MetadataSavers = ['Nfo']; return context;
    };
  }
  const creator = new ItemCreationService(fixture);
  fixture.library.itemCreation = creator; creator.registerItem(loaded.parent);
  fixture.library.itemDeletion = new ItemDeletionService({ ...fixture, itemCreation: creator,
    updates: fixture.host.updates, externalData: loaded.videoVersionDiscovery.externalData,
    linkedChildReferences: { reroute: async () => [] }, now: () => fixture.now });
  t.after(() => creator.close());
  const resolved = await resolveDirectoryVideo(value, sample);
  await fixture.library.createItems(resolved, loaded.parent);
  setFolderChildren(loaded.parent, resolved);
  const item = resolved[0], events = [];
  fixture.library.on('ItemRemoved', event => events.push(['removed', idKey(event.Item.Id)]));
  fixture.host.updates.on('ItemUpdated', event => events.push(['updated', idKey(event.Item.Id)]));
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  ...fixture, metadataPath: loaded.metadataPath, stateRoots: [loaded.dataPath] });
  const marker = path.join(internalImagePath(item, loaded.metadataPath), 'delete-control.txt');
  await assets.write(marker, Buffer.from('internal deletion control'));
  return { ...value, creator, item, resolved, events, assets, marker };
}

const rows = fixture => Promise.all(['BaseItems', 'LinkedChildren', 'AncestorIds', 'BaseItemProviders']
  .map(table => fixture.database.rows(table)));

async function unchanged(value, before, parentId) {
  const { fixture, item, resolved, loaded, creator, events, assets, marker } = value;
  assert.deepEqual(await rows(fixture), before);
  assert.equal(item.ParentId, parentId);
  assert.equal(await creator.getItemById(item.Id), item);
  assert.equal(readCachedFolderChildren(loaded.parent, {}, () => { throw new Error('Parent cache was invalidated.'); }), resolved);
  assert.deepEqual(events, []);
  assert.equal((await assets.stat(marker)).kind, 'file');
  assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Film/Film (2025).mkv')).kind, 'file');
}

const transactionActive = database => database.inTransaction;
const databaseFault = error => error.code === 'P0001';

async function addManualReference(value, child) {
  const { fixture, loaded } = value;
  await fixture.database.insert('LinkedChildren', {
    ParentId: loaded.parent.Id,
    ChildId: child.Id,
    ChildType: 0,
    SortOrder: 99
  });
  loaded.parent.LinkedChildren = await fixture.store.run(db=>fixture.linkedChildren.load(db,loaded.parent.Id));
}

const directDiscScenes = [
  ['delete-direct-dvd-preserve-source', 'Movie', 'Dvd'],
  ['delete-direct-bluray-preserve-source', 'MusicVideo', 'BluRay'],
  ['delete-direct-dvd-ifo-preserve-source', 'Video', 'Dvd']
];

const discSourceScenes = [
  ['delete-direct-bluray-source-directory', false, 'BluRay'],
  ['delete-multidisc-dvd-source-directory', true, 'Dvd'],
  ['delete-multidisc-bluray-source-directory', true, 'BluRay']
];

const discAuthorizationFields = [
  ['IsInMixedFolder', 'mixed-folder', true],
  ['OwnerId', 'owner', ({ loaded }) => loaded.parent.Id],
  ['PrimaryVersionId', 'primary-version', ({ loaded }) => loaded.parent.Id],
  ['ChannelId', 'channel', ({ loaded }) => loaded.parent.Id]
];

async function setPersistedVideoType(fixture, item, videoType) {
  const [row] = await fixture.database.rows('BaseItems', { where: { Id: item.Id } });
  const data = JSON.parse(row.Data);
  data.VideoType = videoType;
  await fixture.database.update('BaseItems', { Id: item.Id }, { Data: JSON.stringify(data) });
}

async function addIndependentFileVersion(value) {
  const { fixture, item, loaded, creator } = value;
  const [row] = await fixture.database.rows('BaseItems', { where: { Id: item.Id } });
  const Id = 'DA666666-6666-6666-6666-666666666666';
  await fixture.adapter.mkdir('/discovery/Other');
  await fixture.adapter.write('/discovery/Other/Other.mkv', Buffer.from('independent file version'));
  await fixture.database.insert('BaseItems', { ...row, Id, Name: 'Other version',
    Path: path.join(loaded.parent.Path, 'Other', 'Other.mkv'), ParentId: loaded.parent.Id,
    OwnerId: null, PrimaryVersionId: null, PresentationUniqueKey: idKey(Id),
    Data: JSON.stringify({ ...JSON.parse(row.Data), VideoType: 'VideoFile', AdditionalParts: [],
      LocalAlternateVersions: [], LinkedAlternateVersions: [] }) });
  for (const ancestor of await fixture.database.rows('AncestorIds', { where: { ItemId: item.Id } })) {
    await fixture.database.insert('AncestorIds', { ...ancestor, ItemId: Id });
  }
  return creator.getItemById(Id);
}

async function linkIndependentVersion(value, primary, alternate) {
  const { fixture, creator } = value;
  const update = item => updateLiveItemRepository(item, { ...fixture, itemCreation: creator,
    updates: fixture.host.updates, updateReason: 16 });
  primary.LinkedAlternateVersions = [{ ItemId: alternate.Id, Type: 3 }];
  await update(primary);
  creator.unregisterItem(alternate.Id);
  alternate = await creator.getItemById(alternate.Id);
  assert.equal(idKey(alternate.PrimaryVersionId), idKey(primary.Id));
  setPrimaryVersion(alternate, primary.Id);
  alternate.OwnerId = EMPTY_ID;
  await update(alternate);
  assert.deepEqual((await fixture.database.rows('LinkedChildren', {
    where: { ParentId: primary.Id, ChildType: 3 }
  })).map(row => idKey(row.ChildId)), [idKey(alternate.Id)]);
  return alternate;
}

function installLinkedReferences(value, controls = {}) {
  const { fixture, creator } = value, phases = [], updated = [];
  const authoritativeLoad = fixture.loadContext;
  const loadContext = async (...args) => {
    const loaded = await authoritativeLoad(...args);
    loaded.libraryOptions = { ...loaded.libraryOptions, MetadataSavers: ['Linked caller'] };
    return loaded;
  };
  fixture.registry.register({ id: 'linked-caller', name: 'Linked caller', providers: [{
    id: 'linked-caller-saver', name: 'Linked caller', kind: 'saver', itemTypes: ['Folder'],
    isEnabledFor: (_item, reason) => reason === 16,
    validateSave: async current => {
      assert.equal(transactionActive(fixture.database), false);
      phases.push(['validate', idKey(current.Id)]);
      await controls.validateSave?.(current);
    },
    save: async current => {
      assert.equal(transactionActive(fixture.database), false);
      phases.push(['saver', idKey(current.Id)]);
      await controls.save?.(current);
    }
  }] });
  const updateImages = fixture.host.images.updateImages.bind(fixture.host.images);
  fixture.host.images.updateImages = async (loaded, values, options) => {
    assert.equal(transactionActive(fixture.database), false);
    phases.push(['images', idKey(loaded.item.Id)]);
    await controls.updateImages?.(loaded);
    return updateImages(loaded, values, options);
  };
  const updateRepository = fixture.host.updates.updateRepository.bind(fixture.host.updates);
  fixture.host.updates.updateRepository = async (context, result, reason, options) => {
    phases.push(['update', idKey(result.Item.Id), idKey(result.Item.PrimaryVersionId)]);
    return updateRepository(context, result, reason, options);
  };
  fixture.host.updates.on('ItemUpdated', event => updated.push(idKey(event.Item.Id)));
  const service = new LinkedChildReferenceService({
    store: fixture.store,
    itemCreation: creator,
    loadContext,
    updates: fixture.host.updates
  });
  value.fixture.library.itemDeletion.linkedChildReferences = { reroute: async (...ids) => {
    assert.equal(ids.length, 2);
    assert.equal(transactionActive(fixture.database), false);
    phases.push(['reroute', ...ids.map(idKey)]);
    return service.reroute(...ids);
  } };
  const deleteItems = value.fixture.library.itemDeletion.deleteItems.bind(value.fixture.library.itemDeletion);
  value.fixture.library.itemDeletion.deleteItems = async (idsPlan, ...args) => {
    const ids=await fixture.store.run(async db=>(await db.client.query(idsPlan)).rows.map(row=>row.Key));
    phases.push(['delete', ...ids.map(idKey)]);
    return deleteItems(idsPlan, ...args);
  };
  return { phases, updated, service };
}

for (const dialect of ['postgres']) {
  const databaseTest = (name, fn) => test(`${dialect}: DeleteItem ${name}`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
  }, fn);

  for (const failSave of [false, true]) databaseTest(`promotes through the real NFO saver${failSave ? ' before a failed promotion SQL update' : ''}`, async t => {
    const { fixture, item, creator, loaded, events } = await setup(t, dialect, 'delete-primary-promotes-alternate', true);
    const [link] = await fixture.database.rows('LinkedChildren', { where: { ParentId: item.Id, ChildType: 2 } });
    const alternate = await creator.getItemById(link.ChildId), before = await rows(fixture);
    assert.equal(alternate.Name, 'Film - 1080p');
    const update = fixture.database.update.bind(fixture.database), saved = [];
    fixture.database.update = async (table, where, changes) => {
      if (table === 'BaseItems' && sameId(where.Id, alternate.Id)) {
        const handle = await fixture.vfs.openRead('/discovery-write/discovery/Film/movie.nfo');
        try { const chunks = []; for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk)); saved.push(Buffer.concat(chunks).toString('utf8')); }
        finally { await handle.close(); }
        if (failSave) return update(table, where, { ...changes, Type: null });
      }
      return update(table, where, changes);
    };
    const operation = fixture.library.deleteItem(item, { DeleteFileLocation: false }, loaded.parent);
    if (failSave) await assert.rejects(operation, /null|constraint|not-null/iu); else await operation;
    assert.equal(saved.length, 1); assert.match(saved[0], /<title>Film - 1080p<\/title>/u);
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Film/movie.nfo')).kind, 'file');
    if (failSave) { assert.deepEqual(await rows(fixture), before); assert.deepEqual(events, []); }
    else {
      assert.equal(await creator.getItemById(item.Id), null);
      assert.equal(await creator.getItemById(alternate.Id), alternate);
      const [row] = await fixture.database.rows('BaseItems', { where: { Id: alternate.Id } });
      assert.equal(alternate.PrimaryVersionId, null); assert.equal(row.PresentationUniqueKey, idKey(alternate.Id));
      assert.ok(!row.OwnerId || sameId(row.OwnerId, EMPTY_ID));
      assert.deepEqual(events.at(-1), ['removed', idKey(item.Id)]);
    }
  });

  for (const [name, type, videoType] of directDiscScenes) databaseTest(`runs the DB-only ${videoType} ${type} lifecycle from the production resolver`, async t => {
    const value = await setup(t, dialect, name), { fixture, item, creator, loaded, resolved, events, assets, marker } = value;
    const sample = input.find(entry => entry.name === name);
    const source = `/discovery-write/discovery/${sample.files[0]}`;
    const externalMarkers = [];
    for (const directory of loaded.videoVersionDiscovery.externalData.paths(item, loaded)) {
      const externalMarker = path.join(directory, 'disc-delete-control.txt');
      await assets.write(externalMarker, Buffer.from('external disc deletion control'));
      externalMarkers.push(externalMarker);
    }
    assert.equal(item.Type, type);
    assert.equal(item.VideoType, videoType);
    assert.equal(item.IsFolder, false);
    assert.equal(item.Path, path.join(fixture.stateRoot, 'media', 'Film'));
    assert.deepEqual(item.AdditionalParts, []);

    const deleted = await fixture.library.deleteItem(item, { DeleteFileLocation: false }, loaded.parent, false);

    assert.equal(deleted, undefined);
    assert.equal(await creator.getItemById(item.Id), null);
    assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: item.Id } }), []);
    assert.equal((await fixture.vfs.stat(source)).kind, 'file', 'DB-only deletion preserves the disc source tree');
    await assert.rejects(assets.stat(marker), { code: 'not-found' });
    for (const externalMarker of externalMarkers) await assert.rejects(assets.stat(externalMarker), { code: 'not-found' });
    assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), null);
    assert.equal(loaded.parent.UserData, null);
    assert.deepEqual(events, [['removed', idKey(item.Id)]]);
    assert.equal(resolved.length, 1);
  });

  databaseTest('deletes a resolved DVD source directory through the native disc lifecycle', async t => {
    const value = await setup(t, dialect, 'delete-direct-dvd-preserve-source');
    const { fixture, item, loaded, creator, events, assets, marker } = value;

    const deleted = await fixture.library.deleteItem(item, { DeleteFileLocation: true }, loaded.parent);

    assert.equal(deleted, undefined);
    assert.equal(await creator.getItemById(item.Id), null);
    assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: item.Id } }), []);
    await assert.rejects(fixture.vfs.stat('/discovery-write/discovery/Film'), { code: 'not-found' });
    await assert.rejects(assets.stat(marker), { code: 'not-found' });
    assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), null);
    assert.equal(loaded.parent.UserData, null);
    assert.deepEqual(events, [['removed', idKey(item.Id)]]);
  });

  for (const [name, stacked, videoType] of discSourceScenes) databaseTest(`deletes the isolated ${stacked ? 'multi-disc' : 'direct'} ${videoType} outer source directory`, async t => {
    const { fixture, item, loaded, creator, events, assets, marker } = await setup(t, dialect, name);
    assert.equal(item.VideoType, videoType);
    assert.equal(item.AdditionalParts.length > 0, stacked);
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Keep/sentinel.txt')).kind, 'file');

    const deleted = await fixture.library.deleteItem(item, { DeleteFileLocation: true }, loaded.parent);

    assert.equal(deleted, undefined);
    assert.equal(await creator.getItemById(item.Id), null);
    assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: item.Id } }), []);
    await assert.rejects(fixture.vfs.stat('/discovery-write/discovery/Film'), { code: 'not-found' });
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Keep/sentinel.txt')).kind, 'file');
    await assert.rejects(assets.stat(marker), { code: 'not-found' });
    assert.deepEqual(events, [['removed', idKey(item.Id)]]);
  });

  databaseTest('runs the DB-only multi-disc lifecycle without deleting either disc or outer sidecars', async t => {
    const { fixture, item, loaded, creator, events } = await setup(t, dialect, 'delete-multidisc-dvd-preserve-source');
    assert.equal(item.VideoType, 'Dvd');
    assert.equal(item.AdditionalParts.length, 1);

    await fixture.library.deleteItem(item, { DeleteFileLocation: false }, loaded.parent);

    assert.equal(await creator.getItemById(item.Id), null);
    for (const source of [
      '/discovery-write/discovery/Film/Film Disc 1/video_ts.ifo',
      '/discovery-write/discovery/Film/Film Disc 2/video_ts.ifo',
      '/discovery-write/discovery/Film/notes.txt'
    ]) assert.equal((await fixture.vfs.stat(source)).kind, 'file');
    assert.deepEqual(events, [['removed', idKey(item.Id)]]);
  });

  for (const [label, malformed] of [['explicit null', null], ['a non-array object', {}]]) databaseTest(
    `rejects a three-disc persisted LinkedAlternateVersions ${label} before side effects`, async t => {
      const value = await setup(t, dialect, 'delete-multidisc-dvd-source-directory');
      const { fixture, item, loaded, resolved, events, assets, marker, creator } = value;
      const [row] = await fixture.database.rows('BaseItems', { where: { Id: item.Id } });
      const data = JSON.parse(row.Data);
      await fixture.adapter.mkdir('/discovery/Film/Film Disc 3');
      await fixture.adapter.write('/discovery/Film/Film Disc 3/video_ts.ifo', Buffer.from('third disc control'));
      const thirdPath = path.join(path.dirname(item.Path), 'Film Disc 3');
      item.AdditionalParts = [...item.AdditionalParts, thirdPath];
      data.AdditionalParts = [...item.AdditionalParts];
      data.LinkedAlternateVersions = malformed;
      await fixture.database.update('BaseItems', { Id: item.Id }, { Data: JSON.stringify(data) });
      const before = await rows(fixture), parentId = item.ParentId;

      await assert.rejects(
        fixture.library.deleteItem(item, { DeleteFileLocation: true }, loaded.parent),
        { status: 501 }
      );

      assert.deepEqual(await rows(fixture), before);
      assert.equal(item.ParentId, parentId);
      assert.equal(await creator.getItemById(item.Id), item);
      assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), resolved);
      assert.deepEqual(events, []);
      assert.equal((await assets.stat(marker)).kind, 'file');
      assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Film/Film Disc 1/video_ts.ifo')).kind, 'file');
      assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Film/Film Disc 2/video_ts.ifo')).kind, 'file');
      assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Film/Film Disc 3/video_ts.ifo')).kind, 'file');
    });

  for (const [scene, layout, source] of [
    ['delete-direct-dvd-preserve-source', 'direct disc', '/discovery-write/discovery/Film/VIDEO_TS/VTS_01_1.VOB'],
    ['delete-multidisc-dvd-source-directory', 'multi-disc', '/discovery-write/discovery/Film/Film Disc 1/video_ts.ifo']
  ]) for (const [field, label, maliciousValue] of discAuthorizationFields) {
    for (const side of ['persisted', 'live']) databaseTest(`rejects ${layout} ${side} ${label} authorization drift before side effects`, async t => {
      const value = await setup(t, dialect, scene);
      const { fixture, item, loaded, resolved, events, assets, marker, creator } = value;
      const changed = typeof maliciousValue === 'function' ? maliciousValue(value) : maliciousValue;
      if (side === 'persisted') await fixture.database.update('BaseItems', { Id: item.Id }, { [field]: changed });
      else item[field] = changed;
      const before = await rows(fixture), parentId = item.ParentId;

      await assert.rejects(fixture.library.deleteItem(item, { DeleteFileLocation: true }, loaded.parent), { status: 501 });

      assert.deepEqual(await rows(fixture), before);
      assert.equal(item.ParentId, parentId);
      assert.equal(await creator.getItemById(item.Id), item);
      assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), resolved);
      assert.deepEqual(events, []);
      assert.equal((await assets.stat(marker)).kind, 'file');
      assert.equal((await fixture.vfs.stat(source)).kind, 'file');
    });
  }

  for (const [scene, layout, source] of [
    ['delete-direct-dvd-source-directory', 'direct disc', '/discovery-write/discovery/Film/VIDEO_TS/VTS_01_1.VOB'],
    ['delete-multidisc-dvd-source-directory', 'multi-disc', '/discovery-write/discovery/Film/Film Disc 1/video_ts.ifo']
  ]) for (const [persistedVideoType, liveVideoType] of [
    ['Dvd', 'VideoFile'],
    ['VideoFile', 'Dvd'],
    ['Dvd', 'BluRay']
  ]) databaseTest(`rejects ${layout} persisted ${persistedVideoType} and live ${liveVideoType} drift before side effects`, async t => {
    const value = await setup(t, dialect, scene);
    const { fixture, item, loaded, resolved, events, assets, marker, creator } = value;
    await setPersistedVideoType(fixture, item, persistedVideoType);
    item.VideoType = liveVideoType;
    const externalMarkers = [];
    for (const directory of loaded.videoVersionDiscovery.externalData.paths(item, loaded)) {
      const externalMarker = path.join(directory, 'video-type-drift.txt');
      await assets.write(externalMarker, Buffer.from('external deletion control'));
      externalMarkers.push(externalMarker);
    }
    assert.ok(externalMarkers.length > 0);
    const before = await rows(fixture), parentId = item.ParentId;

    await assert.rejects(fixture.library.deleteItem(item, { DeleteFileLocation: true }, loaded.parent), { status: 501 });

    assert.deepEqual(await rows(fixture), before);
    assert.equal(item.ParentId, parentId);
    assert.equal(await creator.getItemById(item.Id), item);
    assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), resolved);
    assert.deepEqual(events, []);
    assert.equal((await assets.stat(marker)).kind, 'file');
    for (const externalMarker of externalMarkers) assert.equal((await assets.stat(externalMarker)).kind, 'file');
    assert.equal((await fixture.vfs.stat(source)).kind, 'file');
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Keep/sentinel.txt')).kind, 'file');
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/primary.mkv')).kind, 'file');
  });

  for (const name of ['delete-direct-dvd-missing-source', 'delete-multidisc-dvd-missing-source']) {
    databaseTest(`deletes ${name.includes('multidisc') ? 'multi-disc' : 'direct-disc'} state when the outer source is already missing`, async t => {
      const { fixture, item, loaded, creator, events } = await setup(t, dialect, name);
      await fixture.vfs.delete('/discovery-write/discovery/Film', { recursive: true });

      await fixture.library.deleteItem(item, { DeleteFileLocation: true }, loaded.parent);

      assert.equal(await creator.getItemById(item.Id), null);
      assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: item.Id } }), []);
      assert.deepEqual(events, [['removed', idKey(item.Id)]]);
    });
  }

  databaseTest('rejects a multi-disc source on an ID-bound read-only mount before cleanup', async t => {
    const value = await setup(t, dialect, 'delete-multidisc-dvd-source-directory'), { fixture, item, loaded, resolved, events, assets, marker } = value;
    fixture.vfs.mount({ path: '/readonly-disc', instanceId: 'fixture', root: '/discovery', capabilities: {} });
    fixture.identityMap.bind(item.Id, '/readonly-disc/Film/Film Disc 1');
    const before = await rows(fixture), parentId = item.ParentId;

    await assert.rejects(fixture.library.deleteItem(item, { DeleteFileLocation: true }), { code: 'not-supported' });

    assert.deepEqual(await rows(fixture), before);
    assert.equal(item.ParentId, parentId);
    assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), resolved);
    assert.deepEqual(events, []);
    assert.equal((await assets.stat(marker)).kind, 'file');
  });

  databaseTest('rejects deleting a multi-disc outer directory when it is the VFS mount root', async t => {
    const value = await setup(t, dialect, 'delete-multidisc-dvd-source-directory'), { fixture, item, loaded, resolved, events, assets, marker } = value;
    fixture.vfs.mount({ path: '/disc-root', instanceId: 'fixture', root: '/discovery/Film', capabilities: { delete: true } });
    fixture.identityMap.bind(item.Id, '/disc-root/Film Disc 1');
    const before = await rows(fixture), parentId = item.ParentId;

    await assert.rejects(fixture.library.deleteItem(item, { DeleteFileLocation: true }), { code: 'permission-denied' });

    assert.deepEqual(await rows(fixture), before);
    assert.equal(item.ParentId, parentId);
    assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), resolved);
    assert.deepEqual(events, []);
    assert.equal((await assets.stat(marker)).kind, 'file');
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Film/Film Disc 1/video_ts.ifo')).kind, 'file');
  });

  for (const deleteSource of [false, true]) databaseTest(`deletes Folder disc descendants${deleteSource ? ' and the parent source' : ' while preserving media'}`, async t => {
    const value = await setup(t, dialect, 'delete-direct-dvd-preserve-source');
    const { fixture, item, loaded, events, assets, marker, creator } = value;
    const parent = loaded.parent;
    // An imported Episode disc is a logical child, even though deleting that
    // Episode directly uses file-style GetDeletePaths rather than recursion.
    const [row] = await fixture.database.rows('BaseItems', { where: { Id: item.Id } });
    const episodeId = 'DA555555-5555-5555-5555-555555555555';
    await fixture.database.insert('BaseItems', { ...row, Id: episodeId,
      Type: 'MediaBrowser.Controller.Entities.TV.Episode', Name: 'Disc Episode',
      Path: path.join(parent.Path, 'Disc Episode'), ParentId: parent.Id,
      Data: JSON.stringify({ ...JSON.parse(row.Data), VideoType: 'BluRay' }) });
    await fixture.database.insert('AncestorIds', { ItemId: episodeId, ParentItemId: parent.Id });
    await fixture.adapter.mkdir('/discovery/Disc Episode');
    await fixture.adapter.mkdir('/discovery/Disc Episode/BDMV');
    await fixture.adapter.write('/discovery/Disc Episode/BDMV/index.bdmv', Buffer.from('imported disc control'));
    await fixture.adapter.write('/outside-folder.txt', Buffer.from('outside parent control'));
    const episode = await creator.getItemById(episodeId);
    assert.equal(episode.Type, 'Episode'); assert.equal(episode.VideoType, 'BluRay');
    setFolderChildren(parent, [item, episode]);
    const metadataMarkers = new Set([marker]);
    for (const target of [parent, item, episode]) {
      for (const directory of new Set([internalImagePath(target, loaded.metadataPath),
        ...loaded.videoVersionDiscovery.externalData.paths(target, loaded)])) {
        const filename = path.join(directory, 'folder-disc-delete-control.txt');
        await assets.write(filename, Buffer.from('folder descendant metadata control'));
        metadataMarkers.add(filename);
      }
    }
    const sourceDeletes = [], remove = fixture.adapter.delete.bind(fixture.adapter);
    fixture.adapter.delete = async (location, options) => {
      if (['/discovery', '/discovery/Film', '/discovery/Disc Episode'].includes(location)) {
        sourceDeletes.push({ location, recursive: options?.recursive });
      }
      return remove(location, options);
    };

    await fixture.library.deleteItem(parent, { DeleteFileLocation: deleteSource }, null);

    for (const target of [parent, item, episode]) {
      assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: target.Id } }), []);
      assert.deepEqual(await fixture.database.rows('AncestorIds', { where: { ItemId: target.Id } }), []);
      assert.equal(await creator.getItemById(target.Id), null);
    }
    assert.deepEqual(events, [['removed', idKey(item.Id)], ['removed', idKey(episode.Id)], ['removed', idKey(parent.Id)]]);
    for (const filename of metadataMarkers) await assert.rejects(assets.stat(filename), { code: 'not-found' });
    assert.deepEqual(sourceDeletes, deleteSource ? [{ location: '/discovery', recursive: true }] : [],
      'only the requested Folder removes media; descendants do not run separate source deletion');
    if (deleteSource) await assert.rejects(fixture.vfs.stat('/discovery-write/discovery'), { code: 'not-found' });
    else for (const filename of ['Film/VIDEO_TS/VTS_01_1.VOB', 'Disc Episode/BDMV/index.bdmv']) {
      assert.equal((await fixture.vfs.stat('/discovery-write/discovery/' + filename)).kind, 'file');
    }
    assert.equal((await fixture.vfs.stat('/discovery-write/outside-folder.txt')).kind, 'file');
  });

  for (const [scene, videoType, sourceFile] of [
    ['delete-direct-dvd-preserve-source', 'Dvd', 'Film/VIDEO_TS/VTS_01_1.VOB'],
    ['delete-direct-bluray-preserve-source', 'BluRay', 'Film/BDMV/index.bdmv']
  ]) for (const deleteSource of [false, true]) databaseTest(
    `${videoType} Episode ${deleteSource ? 'fails its required file delete after internal cleanup' : 'supports DB-only deletion while preserving its directory'}`,
    async t => {
      const { fixture, item, loaded, creator, assets, marker, events } = await setup(t, dialect, scene);
      // Imported directory episodes retain their persisted identity and source
      // type; only the native entity type differs from the resolver control.
      await fixture.database.update('BaseItems', { Id: item.Id }, { Type: 'MediaBrowser.Controller.Entities.TV.Episode' });
      creator.unregisterItem(item.Id);
      const episode = await creator.getItemById(item.Id);
      assert.equal(episode.Type, 'Episode'); assert.equal(episode.VideoType, videoType);
      assert.equal(episode.IsFolder, false);
      const children = [episode];
      setFolderChildren(loaded.parent, children);
      const externalDirectory = path.join(episode.Path, 'Film.trickplay');
      assert.ok(loaded.videoVersionDiscovery.externalData.paths(episode, loaded).includes(externalDirectory));
      const externalMarker = path.join(externalDirectory, 'episode-delete-control.txt');
      await assets.write(externalMarker, Buffer.from('external episode data'));
      await fixture.adapter.write('/discovery/Film.nfo', Buffer.from('episode sidecar'));
      const before = await rows(fixture), parentId = episode.ParentId;

      if (deleteSource) {
        await assert.rejects(fixture.library.deleteItem(episode, { DeleteFileLocation: true }, loaded.parent), {
          name: 'StorageError', code: 'is-directory'
        });
        assert.deepEqual(await rows(fixture), before);
        assert.equal(episode.ParentId, parentId);
        assert.equal(await creator.getItemById(episode.Id), episode);
        assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), children);
        assert.deepEqual(events, []);
        assert.equal((await assets.stat(externalMarker)).kind, 'file');
      } else {
        await fixture.library.deleteItem(episode, { DeleteFileLocation: false }, loaded.parent);
        assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: episode.Id } }), []);
        assert.deepEqual(await fixture.database.rows('AncestorIds', { where: { ItemId: episode.Id } }), []);
        assert.equal(await creator.getItemById(episode.Id), null);
        assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), null);
        assert.deepEqual(events, [['removed', idKey(episode.Id)]]);
        await assert.rejects(assets.stat(externalMarker), { code: 'not-found' });
      }
      await assert.rejects(assets.stat(marker), { code: 'not-found' });
      assert.equal((await fixture.vfs.stat('/discovery-write/discovery/' + sourceFile)).kind, 'file');
      assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Film.nfo')).kind, 'file');
      assert.equal((await fixture.vfs.stat('/discovery-write/discovery/primary.mkv')).kind, 'file');
    });

  databaseTest('does not extend direct-disc authorization to a multi-disc representation', async t => {
    const value = await setup(t, dialect, 'delete-direct-dvd-preserve-source');
    const { fixture, item, loaded, resolved, events, assets, marker, creator } = value;
    item.AdditionalParts = [path.join(item.Path, 'Disc 2')];
    const before = await rows(fixture), parentId = item.ParentId;

    await assert.rejects(
      fixture.library.deleteItem(item, { DeleteFileLocation: false }, loaded.parent),
      { status: 501 }
    );

    assert.deepEqual(await rows(fixture), before);
    assert.equal(item.ParentId, parentId);
    assert.equal(await creator.getItemById(item.Id), item);
    assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), resolved);
    assert.deepEqual(events, []);
    assert.equal((await assets.stat(marker)).kind, 'file');
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Film/VIDEO_TS/VTS_01_1.VOB')).kind, 'file');
  });

  databaseTest('does not extend direct-disc authorization to an outgoing version relation', async t => {
    const value = await setup(t, dialect, 'delete-direct-dvd-preserve-source');
    const { fixture, item, loaded, resolved, events, assets, marker, creator } = value;
    const alternate = (await fixture.database.rows('BaseItems')).find(row =>
      !sameId(row.Id, item.Id) && !sameId(row.Id, loaded.parent.Id) && row.IsFolder === false);
    assert.ok(alternate);
    await fixture.database.insert('LinkedChildren', {
      ParentId: item.Id, SortOrder: 0, ChildId: alternate.Id, ChildType: 2
    });
    const before = await rows(fixture), parentId = item.ParentId;

    await assert.rejects(
      fixture.library.deleteItem(item, { DeleteFileLocation: false }, loaded.parent),
      { status: 501 }
    );

    assert.deepEqual(await rows(fixture), before);
    assert.equal(item.ParentId, parentId);
    assert.equal(await creator.getItemById(item.Id), item);
    assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), resolved);
    assert.deepEqual(events, []);
    assert.equal((await assets.stat(marker)).kind, 'file');
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Film/VIDEO_TS/VTS_01_1.VOB')).kind, 'file');
  });

  databaseTest('deletes a multi-disc source and its owned persistence closure without extra logical events', async t => {
    const value = await setup(t, dialect, 'delete-multidisc-dvd-source-directory');
    const { fixture, item, loaded, events, assets, marker, creator } = value;
    const [row] = await fixture.database.rows('BaseItems', { where: { Id: item.Id } });
    const ownedId = 'DA444444-4444-4444-4444-444444444444';
    await fixture.database.insert('BaseItems', { ...row, Id: ownedId, OwnerId: item.Id, ParentId: null,
      Type: 'MediaBrowser.Controller.Entities.Video', Path: path.join(item.Path, 'bonus.mkv'), ExtraType: 1,
      PrimaryVersionId: null, Data: JSON.stringify({ VideoType: 'VideoFile', AdditionalParts: [], LocalAlternateVersions: [] }) });

    await fixture.library.deleteItem(item, { DeleteFileLocation: true }, loaded.parent);

    for (const Id of [item.Id, ownedId]) assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id } }), []);
    assert.equal(await creator.getItemById(item.Id), null);
    assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), null);
    assert.deepEqual(events, [['removed', idKey(item.Id)]]);
    await assert.rejects(assets.stat(marker), { code: 'not-found' });
    await assert.rejects(fixture.vfs.stat('/discovery-write/discovery/Film'), { code: 'not-found' });
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Keep/sentinel.txt')).kind, 'file');
  });

  for (const direction of ['outgoing', 'incoming']) databaseTest(`rejects a persisted multi-disc ${direction} version relation before side effects`, async t => {
    const value = await setup(t, dialect, 'delete-multidisc-dvd-source-directory');
    const { fixture, item, loaded, resolved, events, assets, marker, creator } = value;
    const other = (await fixture.database.rows('BaseItems')).find(row =>
      !sameId(row.Id, item.Id) && !sameId(row.Id, loaded.parent.Id) && row.IsFolder === false);
    assert.ok(other);
    await fixture.database.insert('LinkedChildren', direction === 'outgoing'
      ? { ParentId: item.Id, SortOrder: 0, ChildId: other.Id, ChildType: 2 }
      : { ParentId: other.Id, SortOrder: 0, ChildId: item.Id, ChildType: 3 });
    const before = await rows(fixture), parentId = item.ParentId;

    await assert.rejects(fixture.library.deleteItem(item, { DeleteFileLocation: true }, loaded.parent), { status: 501 });

    assert.deepEqual(await rows(fixture), before);
    assert.equal(item.ParentId, parentId);
    assert.equal(await creator.getItemById(item.Id), item);
    assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), resolved);
    assert.deepEqual(events, []);
    assert.equal((await assets.stat(marker)).kind, 'file');
  });

  databaseTest('does not extend direct-disc authorization to a linked version member', async t => {
    const value = await setup(t, dialect, 'delete-primary-promotes-alternate');
    const { fixture, item, loaded, resolved, events, assets, marker, creator } = value;
    const sample = input.find(entry => entry.name === 'delete-primary-promotes-alternate');
    const [link] = await fixture.database.rows('LinkedChildren', {
      where: { ParentId: item.Id, ChildType: 2 }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }], limit: 1
    });
    const alternate = await creator.getItemById(link.ChildId);
    await fixture.database.update('LinkedChildren', { ParentId: item.Id, SortOrder: link.SortOrder }, { ChildType: 3 });
    await fixture.database.update('BaseItems', { Id: alternate.Id }, { OwnerId: null });
    alternate.OwnerId = EMPTY_ID;
    alternate.VideoType = 'Dvd';
    const before = await rows(fixture), parentId = item.ParentId;

    await assert.rejects(
      fixture.library.deleteItem(item, { DeleteFileLocation: false }, loaded.parent),
      { status: 501 }
    );

    assert.deepEqual(await rows(fixture), before);
    assert.equal(item.ParentId, parentId);
    assert.equal(await creator.getItemById(item.Id), item);
    assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), resolved);
    assert.deepEqual(events, []);
    assert.equal((await assets.stat(marker)).kind, 'file');
    assert.equal((await fixture.vfs.stat(`/discovery-write/discovery/${sample.files[0]}`)).kind, 'file');
  });

  databaseTest('promotes an independent file version when deleting its linked disc primary', async t => {
    const value = await setup(t, dialect, 'delete-direct-dvd-source-directory');
    const { fixture, item, loaded, creator, assets, marker } = value;
    const alternate = await linkIndependentVersion(value, item, await addIndependentFileVersion(value));
    await addManualReference(value, item);
    const { phases } = installLinkedReferences(value);

    await fixture.library.deleteItem(item, { DeleteFileLocation: true }, loaded.parent);

    assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: item.Id } }), []);
    assert.equal(await creator.getItemById(item.Id), null);
    const [saved] = await fixture.database.rows('BaseItems', { where: { Id: alternate.Id } });
    assert.equal(saved.PrimaryVersionId, null); assert.ok(!saved.OwnerId || sameId(saved.OwnerId, EMPTY_ID));
    assert.equal(saved.PresentationUniqueKey, idKey(alternate.Id));
    const cold = await fixture.loadContext(alternate.Id);
    try {
      assert.equal(cold.item.PrimaryVersionId, null);
      assert.deepEqual(cold.item.LinkedAlternateVersions, []);
    } finally { await cold.dispose(); }
    const [reference] = await fixture.database.rows('LinkedChildren', { where: { ParentId: loaded.parent.Id, ChildType: 0 } });
    assert.equal(idKey(reference.ChildId), idKey(alternate.Id));
    assert.equal(idKey((await fixture.linkedChildren.page(loaded.parent.LinkedChildren, { limit: 1 }))[0].ItemId), idKey(alternate.Id));
    const promotion = phases.findIndex(phase => phase[0] === 'update' && phase[1] === idKey(alternate.Id));
    const reroute = phases.findIndex(phase => phase[0] === 'reroute');
    assert.ok(promotion >= 0 && promotion < reroute);
    assert.ok(phases.some(phase => phase[0] === 'saver' && phase[1] === idKey(loaded.parent.Id)));
    await assert.rejects(assets.stat(marker), { code: 'not-found' });
    await assert.rejects(fixture.vfs.stat('/discovery-write/discovery/Film'), { code: 'not-found' });
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Other/Other.mkv')).kind, 'file');
  });

  databaseTest('removes a linked disc alternate as a missing file while preserving its directory source', async t => {
    const value = await setup(t, dialect, 'delete-direct-dvd-source-directory');
    const { fixture, loaded, creator, assets, marker, events } = value;
    const primary = await addIndependentFileVersion(value);
    const disc = await linkIndependentVersion(value, primary, value.item);
    events.length = 0;
    const { phases } = installLinkedReferences(value);

    await fixture.library.deleteItem(primary, { DeleteFileLocation: true }, loaded.parent);

    for (const item of [disc, primary]) {
      assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: item.Id } }), []);
      assert.equal(await creator.getItemById(item.Id), null);
    }
    assert.deepEqual(events.filter(event => event[0] === 'removed'), [
      ['removed', idKey(disc.Id)], ['removed', idKey(primary.Id)]
    ]);
    assert.deepEqual(phases.filter(phase => phase[0] === 'delete').map(phase => phase[1]), [idKey(disc.Id), idKey(primary.Id)]);
    assert.equal(phases.some(phase => phase[0] === 'reroute'), false);
    assert.deepEqual(await fixture.database.rows('LinkedChildren', { where: { ParentId: primary.Id } }), []);
    await assert.rejects(assets.stat(marker), { code: 'not-found' });
    await assert.rejects(fixture.vfs.stat('/discovery-write/discovery/Other'), { code: 'not-found' });
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Film/VIDEO_TS/VTS_01_1.VOB')).kind, 'file');
  });

  databaseTest('deletes an independent linked disc alternate and reroutes its manual references to the primary', async t => {
    const value = await setup(t, dialect, 'delete-direct-dvd-source-directory');
    const { fixture, loaded, creator, assets, marker } = value;
    const primary = await addIndependentFileVersion(value);
    const disc = await linkIndependentVersion(value, primary, value.item);
    await addManualReference(value, disc);
    const { phases } = installLinkedReferences(value);

    await fixture.library.deleteItem(disc, { DeleteFileLocation: true }, loaded.parent);

    assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: disc.Id } }), []);
    assert.equal(await creator.getItemById(disc.Id), null);
    assert.deepEqual(await fixture.database.rows('LinkedChildren', { where: { ParentId: primary.Id, ChildType: 3 } }), []);
    const cold = await fixture.loadContext(primary.Id);
    try { assert.deepEqual(cold.item.LinkedAlternateVersions, []); }
    finally { await cold.dispose(); }
    const [reference] = await fixture.database.rows('LinkedChildren', { where: { ParentId: loaded.parent.Id, ChildType: 0 } });
    assert.equal(idKey(reference.ChildId), idKey(primary.Id));
    assert.equal(idKey((await fixture.linkedChildren.page(loaded.parent.LinkedChildren, { limit: 1 }))[0].ItemId), idKey(primary.Id));
    const reroute = phases.findIndex(phase => phase[0] === 'reroute');
    const primaryUpdate = phases.findIndex(phase => phase[0] === 'update' && phase[1] === idKey(primary.Id));
    assert.ok(reroute >= 0 && reroute < primaryUpdate);
    await assert.rejects(assets.stat(marker), { code: 'not-found' });
    await assert.rejects(fixture.vfs.stat('/discovery-write/discovery/Film'), { code: 'not-found' });
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Other/Other.mkv')).kind, 'file');
  });

  databaseTest('rejects an ID-bound read-only source before cleanup or SQL despite a writable identity prefix', async t => {
    const value = await setup(t, dialect), { fixture, item } = value;
    fixture.vfs.mount({ path: '/readonly', instanceId: 'fixture', root: '/discovery', capabilities: {} });
    fixture.identityMap.bind(item.Id, '/readonly/Film/Film (2025).mkv');
    const before = await rows(fixture), parentId = item.ParentId;
    await assert.rejects(fixture.library.deleteItem(item, { DeleteFileLocation: true }), { code: 'not-supported' });
    await unchanged(value, before, parentId);
  });

  databaseTest('deletes only the ID-bound source directory', async t => {
    const { fixture, item, creator } = await setup(t, dialect);
    await fixture.adapter.mkdir('/bound'); await fixture.adapter.write('/bound/source.mkv', Buffer.from('ID-bound source'));
    fixture.identityMap.bind(item.Id, '/discovery-write/bound/source.mkv');
    await fixture.library.deleteItem(item, { DeleteFileLocation: true });
    await assert.rejects(fixture.vfs.stat('/discovery-write/bound'), { code: 'not-found' });
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Film/Film (2025).mkv')).kind, 'file');
    assert.equal(await creator.getItemById(item.Id), null);
  });

  for (const mode of ['mixed source', 'disc source']) {
    databaseTest(`rejects ${mode} before files, saves, cache invalidation or deletion`, async t => {
      const value = await setup(t, dialect), { fixture, item } = value;
      if (mode === 'mixed source') item.IsInMixedFolder = true;
      if (mode === 'disc source') item.VideoType = 'Dvd';
      const before = await rows(fixture), parentId = item.ParentId;
      await assert.rejects(fixture.library.deleteItem(item, { DeleteFileLocation: true }), { status: 501 });
      await unchanged(value, before, parentId);
    });
  }

  databaseTest('removes an internal owned row through persistence without running its lifecycle', async t => {
    const value = await setup(t, dialect), { fixture, item, creator, loaded, events, assets } = value;
    const ownedId = 'DA333333-3333-3333-3333-333333333333';
    const [row] = await fixture.database.rows('BaseItems', { where: { Id: item.Id } });
    await fixture.database.insert('BaseItems', { ...row, Id: ownedId, OwnerId: item.Id,
      Type: 'MediaBrowser.Controller.Entities.Person' });
    const owned = await creator.getItemById(ownedId);
    creator.registerItem(owned);
    const ownedMarker = path.join(internalImagePath(owned, loaded.metadataPath), 'owned-delete-control.txt');
    await assets.write(ownedMarker, Buffer.from('owned persistence-only deletion control'));

    await fixture.library.deleteItem(item, { DeleteFileLocation: false }, loaded.parent);

    assert.equal(await creator.getItemById(item.Id), null);
    assert.equal(await creator.getItemById(ownedId), null);
    assert.deepEqual(events, [['removed', idKey(item.Id)]]);
    assert.equal((await assets.stat(ownedMarker)).kind, 'file');
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Film/Film (2025).mkv')).kind, 'file');
  });

  databaseTest('clears a manual reference without replacement and does not invoke linked savers', async t => {
    const value = await setup(t, dialect), { fixture, item, creator, loaded } = value;
    await addManualReference(value, item);
    const { phases, updated } = installLinkedReferences(value);

    await fixture.library.deleteItem(item, { DeleteFileLocation: false }, loaded.parent);

    assert.equal(await creator.getItemById(item.Id), null);
    assert.deepEqual(await fixture.database.rows('LinkedChildren', { where: { ChildId: item.Id, ChildType: 0 } }), []);
    assert.equal(idKey((await fixture.linkedChildren.page(loaded.parent.LinkedChildren,{limit:1}))[0].ItemId), idKey(item.Id));
    assert.deepEqual(phases, [['delete', idKey(item.Id)]]);
    assert.equal(updated.includes(idKey(loaded.parent.Id)), false);
  });

  databaseTest('deletes a supported owned descendant with a manual reference instead of rejecting the whole scope', async t => {
    const value = await setup(t, dialect), { fixture, item, creator, loaded } = value;
    const ownedId = 'DA333333-3333-3333-3333-333333333333';
    const [row] = await fixture.database.rows('BaseItems', { where: { Id: item.Id } });
    await fixture.database.insert('BaseItems', { ...row, Id: ownedId, OwnerId: item.Id });
    await fixture.database.insert('LinkedChildren', {
      ParentId: loaded.parent.Id, ChildId: ownedId, ChildType: 0, SortOrder: 99
    });
    const { phases } = installLinkedReferences(value);

    await fixture.library.deleteItem(item, { DeleteFileLocation: false }, loaded.parent);

    assert.equal(await creator.getItemById(item.Id), null);
    assert.deepEqual(await fixture.database.rows('BaseItems', { where: { Id: ownedId } }), []);
    assert.deepEqual(await fixture.database.rows('LinkedChildren', { where: { ChildId: ownedId, ChildType: 0 } }), []);
    assert.deepEqual(phases, [['delete', idKey(item.Id)]]);
  });

  for (const failSaver of [false, true]) databaseTest(`reroutes a promoted primary before remaining alternate updates${failSaver ? ' and swallows linked saver failure' : ''}`, async t => {
    const value = await setup(t, dialect, 'delete-primary-promotes-three-versions');
    const { fixture, item, creator, loaded } = value;
    const versionLinks = await fixture.database.rows('LinkedChildren', {
      where: { ParentId: item.Id, ChildType: 2 }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }]
    });
    const alternates = await Promise.all(versionLinks.map(link => creator.getItemById(link.ChildId)));
    const [promoted, remaining] = alternates;
    await addManualReference(value, item);
    const saverFailure = new Error('Controlled linked saver failure');
    const { phases, updated } = installLinkedReferences(value, {
      save: async () => { if (failSaver) throw saverFailure; }
    });

    await fixture.library.deleteItem(item, { DeleteFileLocation: false }, loaded.parent);

    const rerouteIndex = phases.findIndex(phase => phase[0] === 'reroute');
    const promotedUpdate = phases.findIndex(phase => phase[0] === 'update' && phase[1] === idKey(promoted.Id));
    const remainingTransfer = phases.findIndex((phase, index) => index > rerouteIndex && phase[0] === 'update'
      && phase[1] === idKey(remaining.Id) && phase[2] === idKey(promoted.Id));
    const parentSaver = phases.findIndex(phase => phase[0] === 'saver' && phase[1] === idKey(loaded.parent.Id));
    const parentImages = phases.findIndex(phase => phase[0] === 'images' && phase[1] === idKey(loaded.parent.Id));
    const deleteIndex = phases.findIndex(phase => phase[0] === 'delete');
    assert.ok(promotedUpdate >= 0 && promotedUpdate < rerouteIndex);
    assert.ok(rerouteIndex < parentSaver && parentSaver < parentImages);
    assert.ok(parentImages < remainingTransfer && remainingTransfer < deleteIndex);
    assert.deepEqual(phases[rerouteIndex], ['reroute', idKey(item.Id), idKey(promoted.Id)]);
    const [manual] = await fixture.database.rows('LinkedChildren', {
      where: { ParentId: loaded.parent.Id, ChildType: 0 }
    });
    assert.equal(idKey(manual.ChildId), idKey(promoted.Id));
    assert.equal(idKey((await fixture.linkedChildren.page(loaded.parent.LinkedChildren,{limit:1}))[0].ItemId), idKey(promoted.Id));
    assert.equal(await creator.getItemById(item.Id), null);
    const savedRemaining = await creator.getItemById(remaining.Id);
    assert.equal(idKey(savedRemaining.PrimaryVersionId), idKey(promoted.Id));
    assert.equal(updated.includes(idKey(loaded.parent.Id)), false);
  });

  databaseTest('linked preflight failure leaves references untouched but does not compensate primary promotion', async t => {
    const value = await setup(t, dialect, 'delete-primary-promotes-three-versions');
    const { fixture, item, creator, loaded, events, assets, marker } = value;
    const versionLinks = await fixture.database.rows('LinkedChildren', {
      where: { ParentId: item.Id, ChildType: 2 }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }]
    });
    const [promoted, remaining] = await Promise.all(versionLinks.map(link => creator.getItemById(link.ChildId)));
    await addManualReference(value, item);
    const failure = new Error('Controlled linked preflight failure');
    const { phases } = installLinkedReferences(value, { validateSave: async () => { throw failure; } });

    await assert.rejects(fixture.library.deleteItem(item, { DeleteFileLocation: false }, loaded.parent), error => error === failure);

    const [manual] = await fixture.database.rows('LinkedChildren', {
      where: { ParentId: loaded.parent.Id, ChildType: 0 }
    });
    assert.equal(idKey(manual.ChildId), idKey(item.Id));
    assert.equal(idKey((await fixture.linkedChildren.page(loaded.parent.LinkedChildren,{limit:1}))[0].ItemId), idKey(item.Id));
    const savedPromoted = await creator.getItemById(promoted.Id);
    const savedRemaining = await creator.getItemById(remaining.Id);
    assert.equal(savedPromoted.PrimaryVersionId, null);
    assert.equal(idKey(savedRemaining.PrimaryVersionId), idKey(item.Id));
    assert.ok(await creator.getItemById(item.Id));
    assert.equal(idKey(item.ParentId), idKey(loaded.parent.Id));
    assert.equal((await assets.stat(marker)).kind, 'file');
    assert.equal(events.some(event => event[0] === 'removed'), false);
    assert.equal(phases.some(phase => phase[0] === 'saver' || phase[0] === 'delete'), false);
    assert.deepEqual(phases.filter(phase => phase[0] === 'reroute'), [
      ['reroute', idKey(item.Id), idKey(promoted.Id)]
    ]);
  });

  databaseTest('linked parent image failure retains committed DB/live reroute and stops transfer and deletion', async t => {
    const value = await setup(t, dialect, 'delete-primary-promotes-three-versions');
    const { fixture, item, creator, loaded, events, assets, marker } = value;
    const versionLinks = await fixture.database.rows('LinkedChildren', {
      where: { ParentId: item.Id, ChildType: 2 }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }]
    });
    const [promoted, remaining] = await Promise.all(versionLinks.map(link => creator.getItemById(link.ChildId)));
    await addManualReference(value, item);
    const failure = new Error('Controlled linked parent image failure');
    const { phases, updated } = installLinkedReferences(value, {
      updateImages: async context => {
        if (sameId(context.item.Id, loaded.parent.Id)) throw failure;
      }
    });

    await assert.rejects(fixture.library.deleteItem(item, { DeleteFileLocation: false }, loaded.parent), error => error === failure);

    const [manual] = await fixture.database.rows('LinkedChildren', {
      where: { ParentId: loaded.parent.Id, ChildType: 0 }
    });
    assert.equal(idKey(manual.ChildId), idKey(promoted.Id));
    assert.equal(idKey((await fixture.linkedChildren.page(loaded.parent.LinkedChildren,{limit:1}))[0].ItemId), idKey(promoted.Id));
    const savedPromoted = await creator.getItemById(promoted.Id);
    const savedRemaining = await creator.getItemById(remaining.Id);
    assert.equal(savedPromoted.PrimaryVersionId, null);
    assert.equal(idKey(savedRemaining.PrimaryVersionId), idKey(item.Id));
    assert.ok(await creator.getItemById(item.Id));
    assert.equal(idKey(item.ParentId), idKey(loaded.parent.Id));
    assert.equal((await assets.stat(marker)).kind, 'file');
    assert.equal(events.some(event => event[0] === 'removed'), false);
    assert.equal(phases.some(phase => phase[0] === 'delete'), false);
    assert.equal(phases.some(phase => phase[0] === 'update' && phase[1] === idKey(remaining.Id)
      && phase[2] === idKey(promoted.Id)), false);
    assert.equal(updated.includes(idKey(loaded.parent.Id)), false);
  });

  databaseTest('reroutes an alternate even when its live primary is missing', async t => {
    const value = await setup(t, dialect, 'delete-alternate-three-versions');
    const { fixture, item: primary, creator, loaded } = value;
    const [versionLink] = await fixture.database.rows('LinkedChildren', {
      where: { ParentId: primary.Id, ChildType: 2 }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }], limit: 1
    });
    const alternate = await creator.getItemById(versionLink.ChildId);
    await addManualReference(value, alternate);
    const { phases, updated } = installLinkedReferences(value);
    fixture.library.itemDeletion.itemCreation = {
      linkedChildren:creator.linkedChildren, retainItem:item=>creator.retainItem(item), withItem:(id,operation)=>sameId(id,primary.Id)?operation(null):creator.withItem(id,operation),
      getItemById: id => sameId(id, primary.Id) ? Promise.resolve(null) : creator.getItemById(id),
      registerItem: item => creator.registerItem(item),
      recordRepositorySnapshot: (item, snapshot) => creator.recordRepositorySnapshot(item, snapshot),
      retainedRepositorySnapshot: item => creator.retainedRepositorySnapshot(item),
      unregisterItem: id => creator.unregisterItem(id)
    };

    await fixture.library.deleteItem(alternate, { DeleteFileLocation: false }, loaded.parent);

    const [manual] = await fixture.database.rows('LinkedChildren', {
      where: { ParentId: loaded.parent.Id, ChildType: 0 }
    });
    assert.equal(idKey(manual.ChildId), idKey(primary.Id));
    assert.equal(idKey((await fixture.linkedChildren.page(loaded.parent.LinkedChildren,{limit:1}))[0].ItemId), idKey(primary.Id));
    assert.deepEqual(phases.filter(phase => phase[0] === 'reroute'), [
      ['reroute', idKey(alternate.Id), idKey(primary.Id)]
    ]);
    assert.equal(phases.some(phase => phase[0] === 'update' && phase[1] === idKey(primary.Id)), false);
    assert.equal(await creator.getItemById(alternate.Id), null);
    assert.equal(updated.includes(idKey(loaded.parent.Id)), false);
  });

  databaseTest('keeps rows and live parent/cache when the required source-directory delete fails after internal cleanup', async t => {
    const { fixture, item, creator, loaded, resolved, assets, marker, events } = await setup(t, dialect);
    const before = await rows(fixture), parentId = item.ParentId, original = fixture.adapter.delete.bind(fixture.adapter);
    fixture.adapter.delete = (location, options) => location === '/discovery/Film'
      ? Promise.reject(Object.assign(new Error('Controlled source delete failure'), { code: 'permission-denied' })) : original(location, options);
    await assert.rejects(fixture.library.deleteItem(item, { DeleteFileLocation: true }), { code: 'permission-denied' });
    assert.deepEqual(await rows(fixture), before); assert.equal(item.ParentId, parentId);
    assert.equal(await creator.getItemById(item.Id), item);
    assert.equal(readCachedFolderChildren(loaded.parent, {}, () => []), resolved); assert.deepEqual(events, []);
    await assert.rejects(assets.stat(marker), { code: 'not-found' });
    assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Film/Film (2025).mkv')).kind, 'file');
  });

  for (const [label, code] of [['IOException', 'io'], ['UnauthorizedAccessException', 'permission-denied']]) {
    databaseTest(`keeps Folder extracted data when source deletion raises ${label} after internal metadata cleanup`, async t => {
      const value = await setup(t, dialect, 'delete-folder-source-directory');
      const { fixture, item, loaded, resolved, creator, events, assets, marker } = value;
      assert.equal(item.Type, 'Folder');
      const externalMarkers = [];
      const internalDirectory = internalImagePath(item, loaded.metadataPath);
      for (const directory of loaded.videoVersionDiscovery.externalData.paths(item, loaded)) {
        const relative = path.relative(internalDirectory, directory);
        if (relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative)) continue;
        const externalMarker = path.join(directory, 'folder-source-failure.txt');
        await assets.write(externalMarker, Buffer.from('folder external deletion control'));
        externalMarkers.push(externalMarker);
      }
      const source = fixture.vfs.resolve('/discovery-write/discovery/Film');
      const remove = fixture.adapter.delete.bind(fixture.adapter);
      fixture.adapter.delete = (location, options) => location === source.path
        ? Promise.reject(Object.assign(new Error('Controlled Folder source delete failure'), { code }))
        : remove(location, options);
      const before = await rows(fixture), parentId = item.ParentId;

      await assert.rejects(fixture.library.deleteItem(item, { DeleteFileLocation: true }, loaded.parent), { code });

      assert.deepEqual(await rows(fixture), before);
      assert.equal(item.ParentId, parentId);
      assert.equal(await creator.getItemById(item.Id), item);
      assert.equal(readCachedFolderChildren(loaded.parent, {}, () => null), resolved);
      assert.deepEqual(events, []);
      await assert.rejects(assets.stat(marker), { code: 'not-found' });
      for (const externalMarker of externalMarkers) assert.equal((await assets.stat(externalMarker)).kind, 'file');
      assert.equal((await fixture.vfs.stat('/discovery-write/discovery/Film/Film.mkv')).kind, 'file');
    });
  }

  databaseTest('keeps a committed disc source cleanup when the later database delete fails', async t => {
    const { fixture, item, creator, loaded, assets, marker, events } = await setup(t, dialect, 'delete-direct-dvd-source-before-sql-failure');
    await fixture.database.client.query("CREATE FUNCTION delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled deletion failure'; END $$");
    await fixture.database.client.query('CREATE TRIGGER delete_failure BEFORE DELETE ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION delete_failure()');

    await assert.rejects(fixture.library.deleteItem(item, { DeleteFileLocation: true }, loaded.parent), error => databaseFault(error, dialect));

    await assert.rejects(fixture.vfs.stat('/discovery-write/discovery/Film'), { code: 'not-found' });
    await assert.rejects(assets.stat(marker), { code: 'not-found' });
    assert.equal((await fixture.database.rows('BaseItems', { where: { Id: item.Id } })).length, 1);
    assert.equal(await creator.getItemById(item.Id), item);
    assert.equal(idKey(item.ParentId), idKey(EMPTY_ID));
    assert.deepEqual(events, []);
  });
}
