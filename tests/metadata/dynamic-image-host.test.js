import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MetadataImages } from '../../src/metadata/images.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { internalImagePath } from '../../src/metadata/image-paths.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { StorageFileSystem } from '../../src/storage/files.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const provenanceUrl = new URL('./fixtures/dynamic-image-host/provenance.json', import.meta.url);
const folder = new URL('.', provenanceUrl);
const input = JSON.parse(await readFile(new URL('input.json', folder), 'utf8'));
const native = JSON.parse(await readFile(new URL('native.json', folder), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = 'db120000-0000-0000-0000-000000000001';

test('dynamic image host fixture binds actual designated selection, image saver and owned stream execution', async () => {
  const provenance = JSON.parse(await readFile(provenanceUrl, 'utf8'));
  for (const file of provenance.files) assert.equal(hash(await readFile(new URL(file.filename, folder))), file.sha256, file.filename);
  for (const file of provenance.requiredInputs) assert.equal(hash(await readFile(file.filename)), file.sha256, file.filename);
  const record = JSON.parse(await readFile(provenance.record.filename, 'utf8'));
  assert.equal(hash(await readFile(provenance.record.filename)), provenance.record.sha256);
  assert.equal(record.passed, true); assert.equal(record.sourceFilesSha256, provenance.sourceFilesSha256);
  const pinsBytes = await readFile(provenance.inputPins.filename);
  assert.equal(hash(pinsBytes), provenance.inputPins.sha256);
  assert.deepEqual(JSON.parse(pinsBytes).pins, provenance.requiredInputs);
  for (const source of record.sourceFiles) {
    const name = source.filename.replaceAll('\\', '/').split('/').at(-1);
    const target = name === 'Directory.Build.props' ? new URL('../Directory.Build.props', import.meta.url) : new URL(name, folder);
    assert.equal(hash(await readFile(target)), source.sha256);
  }
  for (const assembly of native.assemblies) assert.equal(provenance.requiredInputs.find(file => file.filename.endsWith('/' + assembly.name + '.dll'))?.sha256, assembly.sha256);
  assert.equal(record.jellyfinDll.sha256, provenance.requiredInputs.find(file => file.filename.endsWith('/jellyfin.dll')).sha256);
  assert.equal(native.inputSha256, hash(await readFile(new URL('input.json', folder))));
  assert.deepEqual(native.results.map(value => value.name), input.map(value => value.name));
  assert.ok(native.results.every(value => value.streams.every(Boolean)), 'the actual native ImageSaver disposes every dynamic response stream');
});

for (const sample of input) test(`dynamic image host matches actual native ${sample.name}`, async t => {
  const expected = native.results.find(value => value.name === sample.name);
  const root = path.win32.join('Z:\\DynamicImages', randomUUID()), metadataPath = path.win32.join(root, 'metadata');
  const storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('images', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/images', instanceId: 'images', capabilities: { create: true, replace: true, mkdir: true, delete: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: root, accessRoot: '/images', style: 'windows', returnAccess: 'Isolated dynamic image save differential.' });
  const fileSystem = new StorageFileSystem({ vfs, identityMap });
  const assets = new MetadataImageAssets({ vfs, identityMap, fileSystem, metadataPath });
  const item = { Id: id, Type: 'Book', Path: path.win32.join(root, 'media', 'book.cbz'), IsFileProtocol: true,
    SupportsLocalMetadata: true, IsLocked: sample.locked ?? false, ExtraType: sample.extra ? 'Trailer' : null };
  const images = [], calls = [], saves = [], errors = [];
  if (sample.existing) {
    const old = path.win32.join(internalImagePath(item, metadataPath), 'old.jpg'); await assets.write(old, Buffer.from('OLD'));
    images.push({ Type: 'Primary', Path: old, Width: 4, Height: 3, Blurhash: Buffer.from('old-hash') });
  }
  const controller = new AbortController();
  const failure = message => Object.assign(new Error(message), { code: 'EIO' });
  if (sample.saveFailure) assets.write = async () => { throw failure('Controlled image write failure'); };
  if (sample.deleteFailure) assets.delete = async () => { throw failure('Controlled previous image deletion failure'); };
  const providers = Object.fromEntries(['A', 'B', 'R'].map(name => [name, {
    id: name, name, kind: 'image', imageSource: name === 'R' ? 'remote' : 'dynamic', itemTypes: ['Book'], imageTypes: ['Primary'],
    async getImage(_item, options) {
      assert.equal(options.type, 'Primary'); assert.equal(options.scoped, 'context value');
      calls.push(name + ':Primary'); const action = sample[name.toLowerCase()] ?? 'bytes';
      if (action === 'cancel-empty') { controller.abort(); return null; }
      if (action === 'cancel-throw') { controller.abort(); throw failure('Controlled provider failure'); }
      if (action === 'none') return null;
      if (action === 'throw') throw failure('Controlled provider failure');
      if (action === 'cancel') throw new DOMException('Controlled provider cancellation', 'AbortError');
      if (action === 'cancel-return') controller.abort();
      return { bytes: Buffer.from(name), mimeType: 'image/png' };
    },
    async getImages() { calls.push('R:list'); return [{ Type: 'Primary', Url: 'https://controlled.invalid/remote', Width: 8 }]; },
    getImageResponse: async () => new Response(Buffer.from('R'), { headers: { 'content-type': 'image/png' } }),
  }]));
  const registry = new MetadataRegistry(); registry.register({ id: 'controlled', name: 'Controlled images', providers: (sample.providers ?? ['A', 'B']).map(name => providers[name]) });
  const type = { Type: 'Book', ImageFetchers: sample.enabled ?? ['A', 'B', 'R'], ImageOptions: [{ Type: 'Primary', Limit: sample.limit ?? 1, MinWidth: sample.minWidth ?? 0 }] };
  const libraryOptions = { TypeOptions: sample.noType ? [] : [type] };
  const globalOptions = { ImageFetcherOrder: sample.order ?? [], DisabledImageFetchers: sample.disabled ?? [], ImageSavingConvention: 'Compatible' };
  const mode = sample.mode ?? 'FullRefresh';
  const selected = registry.discover({ item, kind: 'image', libraryOptions, globalOptions, imageRefreshMode: mode });
  assert.deepEqual(selected.map(value => value.name), expected.selected);
  const eligible = mode === 'FullRefresh' || sample.first ? [...selected] : [];
  if (sample.search) eligible.sort((a, b) => Number(b.name === sample.search) - Number(a.name === sample.search));
  assert.deepEqual(eligible.map(value => value.name), expected.eligible);
  const service = new MetadataImages({ logger: { error: error => errors.push(error) } });
  t.after(async () => { await service.close(); await storage.close(); });
  const saveImage = service.saveImage.bind(service), saveRemote = service.saveRemote.bind(service);
  const record = source => saves.push({ mimeType: source.mimeType, type: 'Primary', bytes: Buffer.from(source.bytes).toString('base64') });
  service.saveImage = (loaded, values, source, options) => { record(source); return saveImage(loaded, values, source, options); };
  service.saveRemote = (loaded, values, image, options) => saveRemote(loaded, values, image, { ...options, download: async (...args) => {
    const source = await options.download(...args); record(source); return source;
  } });
  const loaded = { item, imageAssets: assets, metadataPath, libraryOptions, globalOptions, saveLocalMetadataEnabled: sample.local ?? false, context: { scoped: 'context value' } };
  let result = null, exception = null;
  try { result = await service.refreshProviders(loaded, images, eligible, { ImageRefreshMode: mode, ReplaceAllImages: sample.replace ?? false, signal: controller.signal }); }
  catch (error) { exception = controller.signal.aborted || error.name === 'AbortError' ? 'cancelled' : error.name; }
  const project = value => value.replace(root, '$STATE').replaceAll('\\', '/');
  const encode = async filename => { try { return (await assets.read(filename)).toString('base64'); } catch (error) { if (error.code === 'not-found') return null; throw error; } };
  const projected = await Promise.all(images.map(async image => ({ type: image.Type, path: project(image.Path), Width: image.Width, Height: image.Height,
    BlurHash: image.Blurhash?.toString() ?? null, bytes: await encode(image.Path) })));
  let files = [];
  try { files = await Promise.all((await assets.list(internalImagePath(item, metadataPath))).map(async file => ({ path: project(file.Path), bytes: await encode(file.Path) }))); }
  catch (error) { if (error.code !== 'not-found') throw error; }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.deepEqual({ calls, saves, changed: result?.changed ?? false, failures: result?.failures ?? null, errorMessage: result?.errorMessage ?? null,
    exception, images: projected, files }, Object.fromEntries(['calls', 'saves', 'changed', 'failures', 'errorMessage', 'exception', 'images', 'files'].map(key => [key, expected[key]])));
});

test('image registry requires an explicit image source and includes both kinds in one configured order', () => {
  const registry = new MetadataRegistry();
  assert.throws(() => registry.register({ id: 'bad', name: 'Bad', providers: [{ id: 'bad', name: 'Bad', kind: 'image', itemTypes: ['Book'] }] }), /source/);
  assert.deepEqual(registry.plugins(), []);
});
