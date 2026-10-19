import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { setupChildrenFixture } from './children-fixture.js';
import { applyNativeItemValues } from '../../src/library/native-item-entity.js';
import { MetadataImages } from '../../src/metadata/images.js';
import { MetadataRefreshHost } from '../../src/metadata/refresh-host.js';
import { MetadataUpdateHost } from '../../src/metadata/update-host.js';
import { ItemUpdateType } from '../../src/metadata/save-manager.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const id = '22222222-2222-2222-2222-222222222222';
const root = 'Z:\\ImageRefresh';
const signal = new AbortController().signal;
const row = (Type, Path) => ({ Type, Path, DateModified: '0001-01-01 00:00:00', Width: 0, Height: 0, Blurhash: null });

async function assetsFixture(t) {
  const storage = new StorageRegistry();
  storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('images', 'memory', {});
  const vfs = new VirtualFileSystem(storage);
  vfs.mount({ path: '/images', instanceId: 'images', capabilities: { create: true, replace: true, delete: true } });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({ identityRoot: root, accessRoot: '/images', style: 'windows', returnAccess: 'isolated image refresh fixture' });
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  vfs, identityMap, metadataPath: path.win32.join(root, 'metadata') });
  t.after(() => storage.close());
  return { assets, vfs };
}

test('remote image refresh uses native language order, limits, minimum width and lazy replacement', async () => {
  const service = new MetadataImages();
  const loaded = {
    item: { Id: id, Type: 'Movie', Path: 'https://isolated.invalid/movie', IsFileProtocol: false, SupportsLocalMetadata: false, MetadataLanguage: 'de' },
    libraryOptions: { TypeOptions: [{ Type: 'Movie', ImageOptions: [{ Type: 'Primary', Limit: 1, MinWidth: 10 }, { Type: 'Backdrop', Limit: 2, MinWidth: 100 }] }] },
  };
  const images = [row('Primary', 'https://old.invalid/poster'), row('Backdrop', 'https://old.invalid/backdrop-1'), row('Backdrop', 'https://old.invalid/backdrop-2')];
  const provider = {
    name: 'Fixture', imageTypes: ['Primary', 'Backdrop'],
    async getImages() {
      return [
        { Type: 'Primary', Url: 'https://new.invalid/en-best', Language: 'en', Width: 2000, CommunityRating: 10, VoteCount: 100 },
        { Type: 'Primary', Url: 'https://new.invalid/de-low', Language: 'de', Width: 2000, CommunityRating: 7, VoteCount: 10 },
        { Type: 'Primary', Url: 'https://new.invalid/de-best', Language: 'de', Width: 2000, CommunityRating: 8, VoteCount: 20 },
        { Type: 'Backdrop', Url: 'https://new.invalid/de-backdrop', Language: 'de', Width: 1920, CommunityRating: 8, VoteCount: 5 },
        { Type: 'Backdrop', Url: 'https://new.invalid/no-language', Language: null, Width: 1920, CommunityRating: 1, VoteCount: 1 },
        { Type: 'Backdrop', Url: 'https://new.invalid/en-backdrop', Language: 'en', Width: 1920, CommunityRating: 10, VoteCount: 100 },
        { Type: 'Backdrop', Url: 'https://new.invalid/too-small', Language: null, Width: 99, CommunityRating: 10, VoteCount: 100 },
      ];
    },
  };
  const result = await service.refreshRemoteProviders(loaded, images, [provider], { ImageRefreshMode: 'FullRefresh', ReplaceAllImages: true, signal });
  assert.deepEqual(result, { changed: true, failures: 0, errorMessage: undefined });
  assert.deepEqual(images.map(image => [image.Type, image.Path]), [
    ['Primary', 'https://new.invalid/de-best'],
    ['Backdrop', 'https://new.invalid/no-language'],
    ['Backdrop', 'https://new.invalid/de-backdrop'],
  ]);

  const retained = [row('Primary', 'https://old.invalid/retained')];
  const empty = { name: 'Empty', imageTypes: ['Primary'], getImages: async () => [] };
  assert.deepEqual(await service.refreshRemoteProviders(loaded, retained, [empty], { ImageRefreshMode: 'FullRefresh', ReplaceAllImages: true, signal }), { changed: false, failures: 0, errorMessage: undefined });
  assert.equal(retained[0].Path, 'https://old.invalid/retained');
});

test('Default with ReplaceAllImages queries providers without replacing an existing image', async () => {
  const service = new MetadataImages();
  const loaded = { item: { Id: id, Type: 'Movie', IsFileProtocol: false, MetadataLanguage: 'en' }, libraryOptions: {} };
  const images = [row('Primary', 'https://old.invalid/poster')];
  let calls = 0;
  const provider = { name: 'Fixture', imageTypes: ['Primary'], getImages: async () => { calls++; return [{ Type: 'Primary', Url: 'https://new.invalid/poster' }]; } };
  assert.deepEqual(await service.refreshRemoteProviders(loaded, images, [provider], { ImageRefreshMode: 'Default', ReplaceAllImages: true, signal }), { changed: false, failures: 0, errorMessage: undefined });
  assert.equal(calls, 1);
  assert.equal(images[0].Path, 'https://old.invalid/poster');
});

test('file-backed providers own image responses and stop one type after a non-retryable status', async t => {
  const { assets } = await assetsFixture(t);
  let globalFetches = 0;
  const service = new MetadataImages({ fetch: async () => { globalFetches++; throw new Error('Global image fetch must not run.'); } });
  const bytes = Buffer.from('fixed provider image');
  const calls = []; let closed = 0;
  const response = (status, body) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: name => name.toLowerCase() === 'content-type' ? 'image/png' : name.toLowerCase() === 'content-length' && body ? String(body.length) : null },
    arrayBuffer: async () => Uint8Array.from(body ?? []).buffer,
    body: { cancel: async () => { closed++; } },
  });
  const provider = {
    name: 'Fixture', imageTypes: ['Primary', 'Logo'],
    async getImages() {
      return [
        { Type: 'Primary', Url: 'https://provider.invalid/missing.png' },
        { Type: 'Primary', Url: 'https://provider.invalid/poster.png' },
        { Type: 'Logo', Url: 'https://provider.invalid/broken.png' },
        { Type: 'Logo', Url: 'https://provider.invalid/must-not-run.png' },
      ];
    },
    async getImageResponse(url) {
      calls.push(url);
      if (url.endsWith('missing.png')) return response(403);
      if (url.endsWith('broken.png')) return response(500);
      return response(200, bytes);
    },
  };
  const loaded = {
    item: { Id: id, Type: 'Movie', Path: path.win32.join(root, 'movie.mkv'), IsFileProtocol: true, SupportsLocalMetadata: true, IsInMixedFolder: true },
    imageAssets: assets, metadataPath: path.win32.join(root, 'metadata'), saveLocalMetadataEnabled: true,
    globalOptions: {}, nfoConfiguration: {}, libraryOptions: { TypeOptions: [{ Type: 'Movie', ImageOptions: [{ Type: 'Primary', Limit: 1 }, { Type: 'Logo', Limit: 1 }] }] },
  };
  const images = [];
  const result = await service.refreshRemoteProviders(loaded, images, [provider], { signal });
  assert.deepEqual(result, { changed: true, failures: 0, errorMessage: undefined });
  assert.deepEqual(calls, ['https://provider.invalid/missing.png', 'https://provider.invalid/poster.png', 'https://provider.invalid/broken.png']);
  assert.equal(closed, 3);
  assert.equal(globalFetches, 0);
  assert.deepEqual(images.map(image => image.Type), ['Primary']);
  assert.deepEqual(await assets.read(images[0].Path), bytes);
});

test('NFO saves the remote stub and then rewrites its local path during independent conversion persistence', async t => {
  const { assets, vfs } = await assetsFixture(t);
  const registry = new MetadataRegistry();
  const spoolRoot = await mkdtemp(path.join(os.tmpdir(), 'image-refresh-spool-'));
  t.after(async () => { assert.equal(path.dirname(spoolRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(spoolRoot).startsWith('image-refresh-spool-')); await rm(spoolRoot, { recursive: true, force: true }); });
  registry.register(createNfoPlugin({fileSystem: testFileSystem,  vfs, spoolRoot, configuration: { SaveImagePathsInNfo: true } }));
  const bytes = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
  const images = [row('Primary', 'https://provider.invalid/poster.png')];
  const item = { Id: id, Type: 'Movie', Name: 'Fixture', Path: path.win32.join(root, 'movie.mkv'), IsFileProtocol: true,
    SupportsLocalMetadata: true, IsInMixedFolder: true, ProviderIds: {} };
  const loaded = { item, imageAssets: assets, metadataPath: path.win32.join(root, 'metadata'), saveLocalMetadataEnabled: true,
    getLocalAlternateVersionIds: async () => [],
    globalOptions: {}, nfoConfiguration: {}, libraryOptions: { MetadataSavers: ['Nfo'] },
    context: { accessPath: '/images/movie.mkv', images, people: [], mediaStreams: [] } };
  const manager = new MetadataImages({ fetch: async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }) });
  const saverPaths = [], persistedPaths = [];
  class ControlledUpdates extends MetadataUpdateHost {
    async update(context, result, reason, options = {}) {
      saverPaths.push(result.Images[0].Path);
      return super.update(context, result, reason, { ...options,
        persistImages: async (_updated, current) => { assert.equal(current[0].Path, path.win32.join(root, 'movie-poster.png')); },
        persist: async (_updated, actual) => { persistedPaths.push(actual.Images[0].Path); } });
    }
  }
  const updates = new ControlledUpdates({ registry, store: {}, images: manager, now: () => '2026-09-27T12:00:00Z' });
  await updates.update(loaded, { Item: item, Images: images }, ItemUpdateType.ImageUpdate);
  const handle = await vfs.openRead('/images/movie.nfo');
  let nfo;
  try { const chunks = []; for await (const chunk of handle.stream) chunks.push(chunk); nfo = Buffer.concat(chunks).toString(); } finally { await handle.close(); }
  const localPath = path.win32.join(root, 'movie-poster.png');
  assert.deepEqual(saverPaths, ['https://provider.invalid/poster.png', localPath]);
  assert.deepEqual(persistedPaths, [localPath, localPath]);
  assert.ok(nfo.includes(`<poster>${localPath}</poster>`));
  assert.deepEqual(await assets.read(localPath), bytes);
});

test('media-side local artwork is registered before remote replacement and protects its image type', async t => {
  const { assets } = await assetsFixture(t);
  const poster = path.win32.join(root, 'movie-poster.png');
  await assets.write(poster, Buffer.from('local poster'));
  const candidate = { ...await assets.stat(poster), Type: 'Primary' };
  const options = { ReplaceAllImages: true };
  const images = [];
  const loaded = { item: { Id: id, Type: 'Movie', Path: path.win32.join(root, 'movie.mkv'), IsFileProtocol: true }, imageAssets: assets };
  assert.equal(await new MetadataImages().merge(images, [candidate], loaded, signal, options), true);
  assert.equal(options.ReplaceAllImages, false);
  assert.equal(options.ReplaceImages.includes('Primary'), false);
  assert.equal(images[0].Path, poster);
});

test('provider listing failures become empty results, while provider execution failures are counted', async () => {
  const errors = [];
  const service = new MetadataImages({ logger: { error: error => errors.push(error.message) } });
  const loaded = { item: { Id: id, Type: 'Movie', IsFileProtocol: false }, libraryOptions: {} };
  const unavailable = await service.refreshRemoteProviders(loaded, [], [{ name: 'Unavailable', imageTypes: ['Primary'], getImages: async () => { throw new Error('unreachable'); } }], { signal });
  assert.deepEqual(unavailable, { changed: false, failures: 0, errorMessage: undefined });
  const broken = { name: 'Broken', get imageTypes() { throw new Error('broken supported types'); } };
  assert.deepEqual(await service.refreshRemoteProviders(loaded, [], [broken], { signal }), { changed: false, failures: 1, errorMessage: 'broken supported types' });
  assert.deepEqual(errors, ['unreachable', 'broken supported types']);
  let calls = 0;
  const missing = { item: { Id: id, Type: 'Episode', IsMissingEpisode: true, IsFileProtocol: false }, libraryOptions: {} };
  assert.deepEqual(await service.refreshRemoteProviders(missing, [], [{ name: 'Episode', imageTypes: ['Primary'], getImages: async () => { calls++; return []; } }], { signal }), { changed: false, failures: 0, errorMessage: undefined });
  assert.equal(calls, 0);
});

test('full image refresh runs independently, prioritizes the identified provider and preserves URL stubs', async t => {
  const fixture = await setupChildrenFixture(t, 'postgres');
  const item = { Id: id, Type: 'Movie', Path: 'https://isolated.invalid/movie', IsFileProtocol: false, SupportsLocalMetadata: false, IsLocked: false,
    DateLastRefreshed: '2024-01-01 00:00:00', MetadataLanguage: 'en', ProviderIds: {} };
  const calls = [];
  const providers = [
    { name: 'Other', imageTypes: ['Primary'], getImages: async () => { calls.push('Other'); return [{ Type: 'Primary', Url: 'https://other.invalid/poster' }]; } },
    { name: 'Chosen', imageTypes: ['Primary'], getImages: async () => { calls.push('Chosen'); return [{ Type: 'Primary', Url: 'https://chosen.invalid/poster' }]; } },
  ];
  const registry = { discover({ kind }) { return kind === 'image' ? [...providers] : []; } };
  const loaded = { item, lookup: { ProviderIds: {} }, context: { images: [] }, libraryOptions: {}, globalOptions: {}, saveLocalMetadataEnabled: false,
    getLocalAlternateVersionIds: async () => [] };
  let persisted;
  await fixture.seed({ target: 'target', items: [{ ...item, key: 'target', type: 'Movie' }] });
  const loadContext = Object.assign(async (reference, options) => {
    const actual = await fixture.loadContext(reference, options);
    applyNativeItemValues(actual.item, item);
    const frame = { ...actual, ...loaded, item: actual.item, lookup: { ProviderIds: {} }, context: { ...actual.context, images: [] } };
    frame.loadDraftContext = draft => loadContext(draft.Id, { draft });
    frame.reloadMetadataContext = loadContext;
    return frame;
  }, fixture.loadContext);
  loadContext.withContext = async (reference, options, operation) => {
    const frame = await loadContext(reference, options);
    try { return await operation(frame); } finally { await frame.dispose(); }
  };
  const host = new MetadataRefreshHost({
    registry, store: fixture.store, vfs: fixture.vfs, linkedChildren: fixture.linkedChildren, spoolRoot: fixture.spoolRoot, loadContext, now: () => '2026-09-27T12:00:00Z',
    updates: { async update(_loaded, result, updateType, options) { persisted = { result, updateType, options }; return []; } },
  });
  try {
    const result = await host.refresh(id, { MetadataRefreshMode: 'None', ImageRefreshMode: 'FullRefresh', SearchResult: { SearchProviderName: 'Chosen' } });
    assert.deepEqual(calls, ['Chosen']);
    assert.equal(result.Failures, 0);
    assert.equal(result.Item.DateLastRefreshed, '2026-09-27T12:00:00Z');
    assert.equal(Boolean(result.UpdateType & ItemUpdateType.ImageUpdate), true);
    assert.deepEqual(persisted.result.Images.map(image => [image.Type, image.Path]), [['Primary', 'https://chosen.invalid/poster']]);
    assert.equal(Object.hasOwn(persisted.options, 'localizeRemoteImages'), false);
  } finally { await host.close(); }
});
