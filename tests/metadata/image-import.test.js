import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { imageSavePaths } from '../../src/metadata/image-paths.js';
import { MetadataImages } from '../../src/metadata/images.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { scanLocalImages } from '../../src/metadata/local-images.js';
import { parseNfo } from '../../plugins/nfo/parser.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const native = JSON.parse(readFileSync(new URL('./fixtures/image-import/native.json', import.meta.url), 'utf8'));
const root = path.win32.dirname(native.ImageImports[0].Url);
const id = '22222222-2222-2222-2222-222222222222';
async function fixture(t) {
  const registry = new StorageRegistry(); registry.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await registry.createInstance('images', 'memory', {});
  const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/images', instanceId: 'images', capabilities: { create: true, replace: true, delete: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: root, accessRoot: '/images', style: 'windows', returnAccess: 'isolated image fixture' });
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  vfs, identityMap, metadataPath: path.win32.join(root, 'metadata') });
  t.after(() => registry.close()); return { adapter, assets, vfs };
}
test('all 120 native ImageSaver path samples match without decoding or generating images', () => {
  for (const sample of native.ImagePaths) {
    const item = { Id: id, Type: sample.Type, Path: path.win32.join(root, ['Movie', 'Episode'].includes(sample.Type) ? 'movie.mkv' : sample.Type), IsFolder: !['Movie', 'Episode'].includes(sample.Type), IsInMixedFolder: sample.Type === 'Movie', IndexNumber: sample.Type === 'Season' ? 0 : undefined };
    assert.deepEqual(imageSavePaths(item, sample.ImageType, sample.Index, 'image/jpeg', { saveLocally: sample.Local, metadataPath: path.win32.join(root, 'metadata'), series: { Path: path.win32.join(root, 'Series') }, configuration: { ImageSavingConvention: sample.Convention }, extraImagePaths:({folder,index,extension})=>[path.win32.join(folder,'extrathumbs',`thumb${index}${extension}`)] }), sample.Paths, JSON.stringify(sample));
  }
});
test('NFO local paths, missing paths and file URI rejection match native parser side effects', async t => {
  const { adapter, assets } = await fixture(t); await adapter.write('/poster.png', Buffer.from([1, 2, 3]), { modified: '2024-01-02T00:00:00Z' });
  const service = new MetadataImages();
  for (const sample of native.ImageImports) {
    const result = parseNfo(`<movie><thumb>${sample.Url}</thumb></movie>`);
    assert.deepEqual(result.RemoteImages, sample.Remote);
    result.RemoteImages = [];
    const images = []; await service.importLocalResult({ imageAssets: assets }, result, images);
    assert.deepEqual(images.map(image => ({ FullName: image.Path, Type: image.Type })), sample.Local);
  }
});
test('native image merge drops missing assets, resets changed dimensions and preserves BlurHash', async t => {
  const { adapter, assets } = await fixture(t); await adapter.write('/poster.png', Buffer.from([1, 2, 3]), { modified: '2024-01-02T00:00:00Z' });
  const images = [{ Type: 'Primary', Path: path.win32.join(root, 'poster.png'), DateModified: '2020-01-01 00:00:00', Width: 200, Height: 300, Blurhash: 'retained' }, { Type: 'Logo', Path: path.win32.join(root, 'missing.png') }];
  const changed = await new MetadataImages().merge(images, [{ ...await assets.stat(images[0].Path), Type: 'Primary' }], { imageAssets: assets });
  assert.equal(changed, native.Merge.Changed);
  assert.deepEqual(images.map(image => ({ Type: image.Type, Path: image.Path, DateModified: image.DateModified.replace(' ', 'T') + 'Z', Width: image.Width, Height: image.Height, BlurHash: image.Blurhash })), native.Merge.Images.map(image => ({ ...image, DateModified: image.DateModified.replace('.0000000Z', 'Z') })));
});
test('local validation discovers media images and keeps native primary precedence and backdrop gap limit', async t => {
  const { adapter, assets } = await fixture(t);
  for (const name of ['movie-poster.jpg', 'movie-poster.png', 'movie-fanart.jpg', 'movie-fanart-1.jpg', 'movie-fanart-5.jpg', 'poster.jpg']) await adapter.write('/' + name, Buffer.from(name));
  const images = await scanLocalImages({ item: { Id: id, Type: 'Movie', Path: path.win32.join(root, 'movie.mkv'), IsFileProtocol: true, SupportsLocalMetadata: true, IsInMixedFolder: true }, imageAssets: assets, saveLocalMetadataEnabled: true });
  assert.deepEqual(images.map(image => path.win32.basename(image.Path)), ['movie-poster.png', 'movie-fanart.jpg', 'movie-fanart-1.jpg']);
});

test('internal original image storage reads bytes, replaces old assets and denies paths outside state', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'metadata-images-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const metadataPath = path.join(temporary, 'metadata');
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  identityMap: new IdentityAccessMap(), metadataPath });
  const oldPath = path.join(metadataPath, 'library', '22', id.replaceAll('-', ''), 'old.png');
  await assets.write(oldPath, Buffer.from('old image'));
  let requests = 0;
  const bytes = Buffer.from('source bytes without decoding');
  const service = new MetadataImages({ fetch: async () => { requests++; return new Response(bytes, { headers: { 'content-type': 'image/png' } }); } });
  const images = [{ Type: 'Primary', Path: oldPath, Width: 200, Height: 300, Blurhash: 'preserved' }];
  const loaded = { item: { Id: id, Type: 'Movie', Path: 'https://fixture/movie.mkv', IsFileProtocol: false, SupportsLocalMetadata: false }, imageAssets: assets, metadataPath, saveLocalMetadataEnabled: false, globalOptions: {}, nfoConfiguration: {},
    capturePathScope() { return { metadataPath, imageAssets: assets }; } };
  await service.saveRemote(loaded, images, { Url: 'https://fixture/poster.png', Type: 'Primary' });
  assert.deepEqual(await assets.read(images[0].Path), bytes); assert.equal(images[0].Width, 0); assert.equal(images[0].Blurhash, 'preserved');
  await assert.rejects(assets.stat(oldPath), error => error.code === 'not-found');
  await service.saveRemote(loaded, images, { Url: 'https://fixture/poster.png', Type: 'Primary' }); assert.equal(requests, 1);
  await assert.rejects(assets.write(path.join(temporary, 'outside.png'), bytes), error => error.code === 'unmapped-path');
});

test('UserView instance roots permit definition assets while media assets still require VFS', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'user-view-assets-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const metadataPath = path.join(temporary, 'metadata');
  const definitionRoot = path.join(temporary, 'root');
  const poster = path.join(definitionRoot, 'default', 'Movies', 'poster.png');
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  metadataPath, stateRoots: [definitionRoot] });
  await assets.write(poster, Buffer.from('view poster'));
  assert.equal((await assets.stat(poster)).kind, 'file');
  assert.deepEqual(await assets.read(poster), Buffer.from('view poster'));
  await assert.rejects(assets.read(path.join(temporary, 'root-other', 'poster.png')), error => error.code === 'unmapped-path');
  await assert.rejects(assets.read(path.join(definitionRoot, '..', 'media', 'movie.mkv')), error => error.code === 'unmapped-path');
  await assert.rejects(new MetadataImageAssets({fileSystem: testFileSystem,  metadataPath }).read(poster), error => error.code === 'unmapped-path');
});

test('NFO artwork import continues after HTTP failures and accepts the first existing local candidate', async t => {
  const { adapter, assets } = await fixture(t); await adapter.write('/poster.png', Buffer.from([1]));
  const errors = [], requests = [];
  const service = new MetadataImages({ fetch: async url => {
    requests.push(String(url)); return new Response('not an image', { headers: { 'content-type': 'text/html' } });
  }, logger: { error: error => errors.push(error) } });
  t.after(async () => { await service.close(); await service.processor.close(); });
  const result = parseNfo(`<movie><thumb>https://fixture/error</thumb><thumb aspect="clearlogo">${root}\\missing.png</thumb><thumb aspect="clearlogo">${root}\\poster.png</thumb></movie>`);
  const images = [];
  assert.equal(await service.importLocalResult({ imageAssets: assets }, result, images), true);
  assert.deepEqual(requests, ['https://fixture/error']);
  for (const error of errors) assert.deepEqual({ code: error.code, status: error.status }, { code: 'http-error', status: 404 });
  assert.equal(images.length, 1); assert.equal(images[0].Type, 'Logo');
  assert.deepEqual(await assets.read(images[0].Path), Buffer.from([1]));
  t.diagnostic(JSON.stringify({ requests, images, errors: errors.map(error => ({ name: error.name,
    code: error.code, status: error.status, message: error.message, stack: error.stack })) }));
});

test('original image downloads honor cancellation without writing an asset', async () => {
  const controller = new AbortController(); let writes = 0;
  const service = new MetadataImages({ fetch: async (_, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  const pending = service.saveRemote({ item: {}, imageAssets: { write: () => { writes++; } } }, [], { Url: 'https://fixture/slow', Type: 'Primary' }, { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(writes, 0);
});

test('unmapped image identities keep their associations and item bindings resolve sibling assets', async t => {
  const { adapter, vfs } = await fixture(t); await adapter.write('/poster.png', Buffer.from([1]));
  const mapping = new IdentityAccessMap(); mapping.bind(id, '/images/movie.mkv');
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  vfs, identityMap: mapping }).forItem({ Path: 'Z:\\Binding\\movie.mkv' }, '/images/movie.mkv');
  assert.equal((await assets.stat('Z:\\Binding\\poster.png')).kind, 'file');
  const images = [{ Type: 'Primary', Path: 'Y:\\Unmapped\\poster.png', Width: 100, Height: 200 }];
  await assert.rejects(new MetadataImages().validate(images, assets), error => error.code === 'unmapped-path');
  assert.equal(images.length, 1); assert.equal(images[0].Width, 100);
});
