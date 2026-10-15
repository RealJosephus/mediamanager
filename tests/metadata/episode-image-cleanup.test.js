import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { MetadataImages } from '../../src/metadata/images.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const root = 'Z:\\EpisodeCleanup';
const state = path.win32.join(root, 'state');
const id = '22222222-2222-2222-2222-222222222222';
const signal = new AbortController().signal;
const image = Path => ({ Type: 'Primary', Path, DateModified: '2024-01-01 00:00:00', Width: 1, Height: 1, Blurhash: null });

async function fixture(t) {
  const storage = new StorageRegistry();
  storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('episodes', 'memory', {});
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/episodes', instanceId: 'episodes', capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: root, accessRoot: '/episodes', style: 'windows', returnAccess: 'isolated episode cleanup fixture' });
  const assets = new MetadataImageAssets({vfs, identityMap, metadataPath: state });
  t.after(() => storage.close());
  return { assets, vfs };
}

async function mkdir(vfs, value) {
  let current = '/episodes';
  for (const name of value.split('/').filter(Boolean)) {
    current += '/' + name;
    try { await vfs.mkdir(current); } catch (error) { if (error.code !== 'already-exists') throw error; }
  }
}

const episode = (name, values = {}) => ({ Id: id, Type: 'Episode', Path: path.win32.join(root, name, 'episode.mkv'),
  IsFileProtocol: true, SupportsLocalMetadata: true, IsVirtualItem: false, ...values });

test('episode image pruning removes only an empty legacy metadata directory for a physical episode', async t => {
  const { assets, vfs } = await fixture(t);
  const service = new MetadataImages();

  const physical = episode('Physical');
  await mkdir(vfs, 'Physical/metadata');
  const physicalImage = path.win32.join(root, 'Physical', 'metadata', 'episode-thumb.jpg');
  await assets.write(physicalImage, Buffer.from('old'));
  const physicalImages = [image(physicalImage)];
  assert.equal(await service.removeForRefresh({ item: physical, imageAssets: assets, saveLocalMetadataEnabled: true }, physicalImages, signal), true);
  assert.deepEqual(physicalImages, []);
  await assert.rejects(assets.stat(path.win32.join(root, 'Physical', 'metadata')), error => error.code === 'not-found');

  const virtual = episode('Virtual', { IsVirtualItem: true });
  await mkdir(vfs, 'Virtual/metadata');
  const virtualImage = path.win32.join(root, 'Virtual', 'metadata', 'episode-thumb.jpg');
  await assets.write(virtualImage, Buffer.from('old'));
  assert.equal(await service.removeForRefresh({ item: virtual, imageAssets: assets, saveLocalMetadataEnabled: true }, [image(virtualImage)], signal), true);
  assert.equal((await assets.stat(path.win32.join(root, 'Virtual', 'metadata'))).kind, 'directory');

  const occupied = episode('Occupied');
  await mkdir(vfs, 'Occupied/metadata');
  const occupiedImage = path.win32.join(root, 'Occupied', 'metadata', 'episode-thumb.jpg');
  const retained = path.win32.join(root, 'Occupied', 'metadata', 'keep.nfo');
  await assets.write(occupiedImage, Buffer.from('old'));
  await assets.write(retained, Buffer.from('keep'));
  assert.equal(await service.removeForRefresh({ item: occupied, imageAssets: assets, saveLocalMetadataEnabled: true }, [image(occupiedImage)], signal), true);
  assert.equal((await assets.stat(path.win32.join(root, 'Occupied', 'metadata'))).kind, 'directory');
  assert.deepEqual(await assets.read(retained), Buffer.from('keep'));

  const alreadyEmpty = episode('AlreadyEmpty');
  await mkdir(vfs, 'AlreadyEmpty/metadata');
  assert.equal(await service.removeForRefresh({ item: alreadyEmpty, imageAssets: assets, saveLocalMetadataEnabled: true }, [], signal), false);
  await assert.rejects(assets.stat(path.win32.join(root, 'AlreadyEmpty', 'metadata')), error => error.code === 'not-found');
});

test('lazy backdrop replacement prunes the old file and its empty episode metadata directory', async t => {
  const { assets, vfs } = await fixture(t);
  await mkdir(vfs, 'Lazy/metadata');
  await mkdir(vfs, 'state/library/22');
  const item = episode('Lazy');
  const oldPath = path.win32.join(root, 'Lazy', 'metadata', 'old-backdrop.jpg');
  await assets.write(oldPath, Buffer.from('old'));
  const images = [{ ...image(oldPath), Type: 'Backdrop' }];
  const bytes = Buffer.from('new backdrop');
  const provider = {
    imageSource: 'remote', name: 'Fixture', imageTypes: ['Backdrop'],
    getImages: async () => [{ Type: 'Backdrop', Url: 'https://provider.invalid/backdrop.png', Width: 1920 }],
    getImageResponse: async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }),
  };
  const loaded = { item, imageAssets: assets, metadataPath: state, saveLocalMetadataEnabled: true, globalOptions: {}, nfoConfiguration: {},
    libraryOptions: { TypeOptions: [{ Type: 'Episode', ImageOptions: [{ Type: 'Backdrop', Limit: 1 }] }] } };
  const result = await new MetadataImages().refreshProviders(loaded, images, [provider], { ImageRefreshMode: 'FullRefresh', ReplaceAllImages: true, signal });
  assert.deepEqual(result, { changed: true, failures: 0, errorMessage: undefined });
  assert.equal(images.length, 1);
  assert.equal(images[0].Type, 'Backdrop');
  assert.notEqual(images[0].Path, oldPath);
  assert.deepEqual(await assets.read(images[0].Path), bytes);
  await assert.rejects(assets.stat(path.win32.join(root, 'Lazy', 'metadata')), error => error.code === 'not-found');
});
