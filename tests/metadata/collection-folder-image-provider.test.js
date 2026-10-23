import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { createRuntime } from '../../src/runtime.js';
import { withCollectionFolderImageCandidates } from '../../src/library/collection-folder-image-query.js';
import { createCollectionFolderImagePlugin } from '../../src/metadata/collection-folder-image-provider.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';

const id = value => `98400000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const source = new URL('../images/fixtures/user-view-collage/assets/same.png', import.meta.url);
const identityRoot = 'Z:\\CollectionPoster';
const itemRow = (number, type, values = {}) => postgresTestRow('BaseItems', {
  Id: id(number), Type: 'MediaBrowser.Controller.Entities.' + type, Name: 'Poster ' + number,
  SortName: 'poster ' + number, CleanName: 'poster ' + number, Data: '{}', Tags: '', Studios: '', Genres: '',
  ProductionLocations: '', MediaType: 'Unknown', UnratedType: 'Other', IsFolder: type === 'Folder' || type === 'CollectionFolder', ...values
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'collection-poster-'));
  const storage = new StorageRegistry();
  let database, runtime;
  t.after(async () => {
    const failures = [];
    for (const cleanup of [() => runtime?.close(), () => dropPostgresTestDatabase(database), () => storage.close(), async () => {
      assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('collection-poster-'));
      await rm(root, { recursive: true, force: true });
    }]) try { await cleanup(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Collection poster fixture cleanup failed.');
  });
  database = await createPostgresTestDatabase(null, 'collection_img', { max: 1 });
  storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('media', 'memory', {});
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/media', instanceId: 'media', capabilities: { create: true, replace: true } });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot, accessRoot: '/media', style: 'windows',
    returnAccess: 'Collection poster sources are isolated mapped media.' });
  const errors = [];
  runtime = await createRuntime({ database, programDataPath: root, vfs, identityMap, serverId: 'collection-poster',
    configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, onError: error => errors.push(error) });
  const userRoot = await runtime.libraryScanHost.getUserRootFolder();
  const aggregate = await runtime.libraryScanHost.getAggregateFolder();
  // Root reads can return fresh live entities. Persist these real parents
  // before the fixture's direct SQL inserts establish child foreign keys.
  await runtime.itemCreation.saveItems([aggregate, userRoot]);
  const createCollection = async (number, CollectionType) => {
    const physicalId = id(number + 1), folderPath = path.join(root, 'root', 'default', 'Library ' + number);
    await mkdir(folderPath, { recursive: true });
    await database.insert('BaseItems', itemRow(number + 1, 'Folder', {
      ParentId: aggregate.Id, TopParentId: physicalId, Path: identityRoot + '\\' + number
    }));
    await database.insert('BaseItems', itemRow(number, 'CollectionFolder', { ParentId: userRoot.Id, Path: folderPath,
      Data: JSON.stringify({ CollectionType, PhysicalFolderIds: [physicalId] }) }));
    // Fixture inserts bypass ItemCreation and its live-root child invalidation.
    runtime.libraryScanHost.invalidateChildren(userRoot);
    return { Id: id(number), Type: 'CollectionFolder', Name: 'Library ' + number, CollectionType, physicalId };
  };
  const addItem = async (folder, number, type, { parentId = folder.physicalId, data = '{}' } = {}) => {
    await database.insert('BaseItems', itemRow(number, type, {
      ParentId: parentId, TopParentId: folder.physicalId, Data: data,
      Path: `${identityRoot}\\${number}.mkv`, PresentationUniqueKey: id(number).replaceAll('-', '')
    }));
    await database.insert('AncestorIds', { ItemId: id(number), ParentItemId: folder.physicalId });
  };
  let imageNumber = 10000;
  const addImage = (number, ImageType, Path) => database.insert('BaseItemImageInfos', {
    Id: id(imageNumber++), ItemId: id(number), ImageType, Path,
    DateModified: '2026-10-01T00:00:00.0000000Z', Width: 960, Height: 540, Blurhash: null
  });
  const selected = folder => withCollectionFolderImageCandidates(runtime.library, folder, async candidates => {
    const hasItems = await candidates.hasItems(), paths = [];
    for await (const filename of candidates.paths()) paths.push(filename);
    return { hasItems, paths };
  });
  return { root, runtime, database, vfs, errors, createCollection, addItem, addImage, selected };
}

test('collection poster selection is bounded, filters primary images, uses artists and respects nonrecursive playlists', async t => {
  const f = await fixture(t), movies = await f.createCollection(1, 'movies');
  const eligible = new Set();
  for (let number = 100; number < 112; number++) {
    await f.addItem(movies, number, 'Movies.Movie');
    const filename = `${identityRoot}\\${number}.png`; eligible.add(filename);
    await f.addImage(number, 0, filename);
  }
  await f.addItem(movies, 120, 'TV.Series'); await f.addImage(120, 0, identityRoot + '\\wrong-type.png');
  await f.addItem(movies, 121, 'Movies.Movie'); await f.addImage(121, 5, identityRoot + '\\thumb-only.png');
  const choice = await f.selected(movies);
  assert.equal(choice.hasItems, true); assert.equal(choice.paths.length, 8);
  assert.equal(new Set(choice.paths).size, 8); assert.ok(choice.paths.every(filename => eligible.has(filename)));

  const music = await f.createCollection(10, 'music');
  await f.addItem(music, 200, 'Audio.MusicArtist'); await f.addImage(200, 0, identityRoot + '\\artist.png');
  await f.addItem(music, 201, 'Audio.MusicAlbum'); await f.addImage(201, 0, identityRoot + '\\album.png');
  assert.deepEqual((await f.selected(music)).paths, [identityRoot + '\\artist.png']);

  const playlists = await f.createCollection(20, 'playlists');
  await f.addItem(playlists, 300, 'Video'); await f.addImage(300, 0, identityRoot + '\\direct.png');
  await f.addItem(playlists, 301, 'Folder');
  await f.addItem(playlists, 302, 'Video', { parentId: id(301) }); await f.addImage(302, 0, identityRoot + '\\nested.png');
  assert.deepEqual((await f.selected(playlists)).paths, [identityRoot + '\\direct.png']);
});

test('collection poster selection retains remote membership and uses only the first image of each preferred type', async t => {
  const f = await fixture(t), folder = await f.createCollection(1, 'movies');
  for (let number = 100; number < 108; number++) {
    await f.addItem(folder, number, 'Movies.Movie');
    await f.addImage(number, 0, 'https://fixture.invalid/primary.png');
    await f.addImage(number, 0, identityRoot + '\\ignored-second-primary.png');
  }
  assert.deepEqual(await f.selected(folder), { hasItems: true, paths: [] });
  await f.addImage(100, 5, identityRoot + '\\thumb.png');
  await f.addImage(101, 2, identityRoot + '\\backdrop.png');
  await f.addImage(101, 5, identityRoot + '\\ignored-thumb.png');
  assert.deepEqual(new Set((await f.selected(folder)).paths), new Set([identityRoot + '\\thumb.png', identityRoot + '\\backdrop.png']));
});

test('the registered CollectionPoster task generates and persists a real mapped source collage once', async t => {
  const f = await fixture(t), folder = await f.createCollection(1, 'movies');
  await f.addItem(folder, 100, 'Movies.Movie');
  await f.vfs.write('/media/source.png', await readFile(source));
  await f.addImage(100, 0, identityRoot + '\\source.png');
  const open = f.vfs.openRead.bind(f.vfs); let opened = 0, closed = 0;
  f.vfs.openRead = async (filename, options) => {
    const handle = await open(filename, options);
    if (filename !== '/media/source.png') return handle;
    opened++;
    return { ...handle, async close() { closed++; return handle.close(); } };
  };
  const refresh = f.runtime.metadataScanner.refreshLiveItem.bind(f.runtime.metadataScanner), refreshed = [];
  f.runtime.metadataScanner.refreshLiveItem = async (item, options) => {
    const result = await refresh(item, options);
    refreshed.push(item.Id);
    assert.equal(result.Failures, 0, result.ErrorMessage);
    return result;
  };
  await f.runtime.collectionPosterVerifyPostScanTask.run();
  assert.deepEqual(refreshed, [folder.Id]);
  const saved = await f.database.rows('BaseItemImageInfos', { where: { ItemId: folder.Id, ImageType: 0 } });
  assert.equal(saved.length, 1);
  const filename = f.runtime.library.options.expandPath(saved[0].Path), bytes = await readFile(filename);
  assert.ok(filename.startsWith(internalImagePath(folder, path.join(f.root, 'metadata')) + path.sep));
  const metadata = await sharp(bytes).metadata();
  assert.deepEqual([metadata.format, metadata.width, metadata.height], ['png', 960, 540]);
  assert.ok(opened > 0); assert.equal(closed, opened);
  assert.deepEqual(await readdir(path.join(f.root, 'cache', 'temp')), []);
  const previousOpens = opened;
  await f.runtime.collectionPosterVerifyPostScanTask.run();
  assert.deepEqual(refreshed, [folder.Id]);
  assert.equal(opened, previousOpens); assert.deepEqual(await readFile(filename), bytes);
  assert.deepEqual(f.errors, []);
});

test('collection image aging is strictly over seven days and protects remote and user-provided artwork', async () => {
  const metadataPath = path.join(os.tmpdir(), 'collection-image-age'), now = new Date('2026-10-19T00:00:00.000Z');
  const library = { options: { metadataPath }, clock: () => now,
    withItemQueryPlan() { assert.fail('Existing artwork must not run the item query.'); } };
  const provider = createCollectionFolderImagePlugin({ library, images: { saveImage() { assert.fail('Protected artwork must not be saved.'); } } }).providers[0];
  const folder = { Id: id(1), Type: 'CollectionFolder' };
  const internal = path.join(internalImagePath(folder, metadataPath), 'poster.png');
  const images = [{ Type: 'Primary', Path: internal, DateModified: '2026-10-12T00:00:00.0000000Z' }];
  assert.equal(await provider.hasChanged(folder, { images }), false);
  images[0].DateModified = '2026-10-11T23:59:59.9999999Z';
  assert.equal(await provider.hasChanged(folder, { images }), true);
  for (const Path of ['https://fixture.invalid/poster.png', 'Z:\\CollectionPoster\\poster.png']) {
    const protectedImages = [{ Type: 'Primary', Path, DateModified: images[0].DateModified }];
    assert.equal(await provider.hasChanged(folder, { images: protectedImages }), false);
    assert.equal(await provider.fetch(folder, { images: protectedImages }), ItemUpdateType.None);
  }
});
