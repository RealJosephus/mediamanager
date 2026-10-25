import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { createPhotoAlbumImagePlugin } from '../../src/metadata/photo-album-provider.js';
import { createCollectionFolderImagePlugin } from '../../src/metadata/collection-folder-image-provider.js';
import { createUserViewDynamicImagePlugin } from '../../src/metadata/user-view-dynamic-image-provider.js';
import { MetadataImages } from '../../src/metadata/images.js';
import { ImageProcessor } from '../../src/images/processor.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { MIN_DATE } from '../../src/library/records.js';
import { postgresTestRow } from '../database/postgres-fixture.js';
import { setupChildrenFixture } from './children-fixture.js';
import { testFileSystem } from '../storage/plugin-files.js';

export const requiredValidationServices = ['postgres'];
const id = number => `d9420000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const save = async (filename, bytes) => { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes); };
const item = type => ({ Id: id(5), Type: type, Name: 'Configured images', ViewType: 'movies', CollectionType: 'movies' });
const managed = (root, value) => path.join(root, 'library', value.Id.replaceAll('-', '').slice(0, 2), value.Id.replaceAll('-', ''), 'old.png');
const factories = {
  PhotoAlbum: ({ library, images, store, metadataPath, tempPath }) => createPhotoAlbumImagePlugin({ store, images,
    fileSystem: testFileSystem, vfs: testFileSystem.vfs, identityMap: testFileSystem.identityMap,
    get metadataPath() { return metadataPath(); }, tempPath }).providers[0],
  CollectionFolder: ({ library, images }) => createCollectionFolderImagePlugin({ library, images }).providers[0],
  UserView: ({ library, images, users }) => createUserViewDynamicImagePlugin({ library, images, users }).providers[0],
};

for (const type of Object.keys(factories)) test(`${type} image change detection uses the active root and an explicit loaded context`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'configured-provider-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'first'), second = path.join(root, 'second'), explicit = path.join(root, 'context');
  let metadataPath = first;
  const library = { options: { fileSystem: testFileSystem, programDataPath: root, get metadataPath() { return metadataPath; } },
    clock: () => new Date('2026-10-25T00:00:00Z') };
  const value = item(type), provider = factories[type]({ library, images: {}, store: {}, users: {}, metadataPath: () => metadataPath, tempPath: path.join(root, 'temp') });
  metadataPath = second;
  const current = { Type: 'Primary', Path: managed(second, value), DateModified: MIN_DATE };
  await save(current.Path, Buffer.from('current metadata image'));
  assert.equal(await provider.hasChanged(value, { images: [current] }), true);
  const loaded = { Type: 'Primary', Path: managed(explicit, value), DateModified: MIN_DATE };
  await save(loaded.Path, Buffer.from('loaded context image'));
  assert.equal(await provider.hasChanged(value, { metadataPath: explicit, images: [loaded] }), true);
  assert.equal(await provider.hasChanged(value, { metadataPath: first, images: [current] }), false);
  assert.deepEqual(await readFile(current.Path), Buffer.from('current metadata image'));
  assert.deepEqual(await readFile(loaded.Path), Buffer.from('loaded context image'));
});

const row = (number, type, values = {}) => postgresTestRow('BaseItems', {
  Id: id(number), Type: 'MediaBrowser.Controller.Entities.' + type, Name: 'Configured ' + number,
  SortName: 'configured ' + number, CleanName: 'configured ' + number, Data: '{}', MediaType: 'Unknown', UnratedType: 'Other',
  Tags: '', Studios: '', Genres: '', ProductionLocations: '', IsFolder: ['AggregateFolder', 'UserRootFolder', 'CollectionFolder', 'Folder', 'PhotoAlbum', 'UserView'].includes(type), ...values,
});

for (const type of Object.keys(factories)) test(`postgres: ${type} images save under the current root and the loaded context destination`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 60000,
}, async t => {
  const fixture = await setupChildrenFixture(t), { database, store, library, stateRoot } = fixture;
  const first = path.join(stateRoot, 'first-metadata'), second = path.join(stateRoot, 'second-metadata'), explicit = path.join(stateRoot, 'context-metadata');
  let metadataPath = first;
  Object.defineProperty(library.options, 'metadataPath', { configurable: true, get: () => metadataPath });
  const processor = new ImageProcessor({ fileSystem: testFileSystem }), images = new MetadataImages({ processor });
  t.after(async () => { await images.close(); await processor.close(); });
  const user = { Id: id(100), Configuration: {}, Policy: { EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [], BlockedTags: [], AllowedTags: [], BlockUnratedItems: [] } };
  const users = { async getUser() { return user; } };
  const tempPath = type === 'PhotoAlbum' ? path.join(stateRoot, 'photo-temp') : path.join(stateRoot, 'cache', 'temp');
  const provider = factories[type]({ library, store, images, users, metadataPath: () => metadataPath, tempPath });
  await save(path.join(first, 'sentinel.txt'), 'old metadata remains');
  const source = path.join(stateRoot, 'source.png');
  const sourceBytes = await readFile(new URL('../images/fixtures/user-view-collage/assets/same.png', import.meta.url));
  await save(source, sourceBytes);
  await database.insert('BaseItems', row(1, 'AggregateFolder'));
  await database.insert('BaseItems', row(2, 'UserRootFolder'));
  await database.insert('BaseItems', row(3, 'CollectionFolder', { ParentId: id(2),
    Data: JSON.stringify({ CollectionType: 'movies', PhysicalFolderIds: [id(4)] }) }));
  await database.insert('BaseItems', row(4, 'Folder', { ParentId: id(1), TopParentId: id(4) }));
  const value = type === 'PhotoAlbum' ? { ...item(type), IsFolder: true, Path: path.join(stateRoot, 'album') }
    : type === 'CollectionFolder' ? { ...item(type), Id: id(3) }
      : { ...item(type), UserId: user.Id, DisplayParentId: id(3) };
  if (type === 'PhotoAlbum') await database.insert('BaseItems', row(5, 'PhotoAlbum', { Path: value.Path }));
  if (type === 'UserView') await database.insert('BaseItems', row(5, 'UserView', {
    Data: JSON.stringify({ ViewType: 'movies', DisplayParentId: id(3).replaceAll('-', '') }) }));
  const candidateType = type === 'PhotoAlbum' ? 'Photo' : 'Movies.Movie';
  await database.insert('BaseItems', row(6, candidateType, { ParentId: type === 'PhotoAlbum' ? id(5) : id(4),
    TopParentId: id(4), Path: source, IsFolder: false, PresentationUniqueKey: id(6).replaceAll('-', '') }));
  await database.insert('AncestorIds', { ItemId: id(6), ParentItemId: type === 'PhotoAlbum' ? id(5) : id(4) });
  await database.insert('BaseItemImageInfos', { Id: id(7), ItemId: id(6), ImageType: 0, Path: source,
    DateModified: '2026-10-01T00:00:00.0000000Z', Width: 960, Height: 540, Blurhash: null });
  library.options.userRoot = { Id: id(2) };
  metadataPath = second;
  const expectedUpdate = type === 'PhotoAlbum' ? ItemUpdateType.None | ItemUpdateType.ImageUpdate : ItemUpdateType.ImageUpdate;
  const current = [];
  assert.equal(await provider.fetch(value, { images: current }), expectedUpdate);
  assert.equal(current.length, 1);
  assert.equal(path.relative(second, current[0].Path).split(path.sep)[0], 'library');
  const currentBytes = await readFile(current[0].Path);
  const fromContext = [];
  assert.equal(await provider.fetch(value, { metadataPath: explicit, images: fromContext }), expectedUpdate);
  assert.equal(fromContext.length, 1);
  assert.equal(path.relative(explicit, fromContext[0].Path).split(path.sep)[0], 'library');
  const contextBytes = await readFile(fromContext[0].Path);
  assert.deepEqual(await sharp(currentBytes).raw().toBuffer(), await sharp(contextBytes).raw().toBuffer());
  if (type === 'PhotoAlbum') assert.deepEqual(currentBytes, sourceBytes);
  assert.deepEqual(await readdir(tempPath), []);
  assert.deepEqual(await readdir(first), ['sentinel.txt']);
  assert.deepEqual(await readFile(path.join(first, 'sentinel.txt')), Buffer.from('old metadata remains'));
});
