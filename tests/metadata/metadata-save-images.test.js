import { fixturePathStyle, projectStatePath } from '../library/fixture-state-path.js';
import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, utimes, readdir } from 'node:fs/promises';
import path from 'node:path';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { MetadataUpdateHost } from '../../src/metadata/update-host.js';
import { persistMetadata } from '../../src/metadata/persistence.js';
import { imageTypes } from '../../src/metadata/image-paths.js';
import { dateText, MIN_DATE } from '../../src/library/records.js';
import { setupChildrenFixture, useIdentityPathReversalControl } from './children-fixture.js';
import { assertProjectedEqual } from '../comparison-observations.js';

const root = new URL('./fixtures/metadata-save-images/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async filename => JSON.parse(await readFile(new URL(filename, root), 'utf8'))));
const picture = await readFile(new URL('../images/fixtures/processor/original-http.png', import.meta.url));
const ownerId = '98b90000-0000-0000-0000-000000000001', parentId = '98b90000-0000-0000-0000-000000000002';
const channelId = '98b90000-0000-0000-0000-000000000003';
const stamp = '2025-01-02T03:04:05.0000000Z';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const functional = ({ exception, signalAborted, ...value }) => ({ ...value, failed: exception != null });

test('metadata save image oracle binds frozen saver/image/EF methods and exact image bytes', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(hash(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  assert.equal(native.actualFrozenMetadataSaveImages, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.imageSha256, hash(picture));
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.equal(native.assemblies.find(value => value.name === 'MediaBrowser.Controller').sha256,
    '051c588a8e85a3a7cdde8dc3d9a1112217fd7e973a86fe2ff90cf765bedb75a8');
  assert.equal(native.scope, provenance.scope);
  assert.equal(native.results.length, 24);
  assert.deepEqual(native.results.map(row => row.name), input.map(row => row.name));
  assert.deepEqual(native.results.map(row => row.exception != null), input.map(row => Boolean(row.expectException)));
});

async function fixtureFor(t, dialect, sample) {
  const fixture = await setupChildrenFixture(t, dialect); useIdentityPathReversalControl(fixture);
  const { stateRoot, database, store, registry } = fixture;
  const media = path.join(stateRoot, 'media'), metadataPath = path.join(stateRoot, 'metadata');
  await mkdir(media);
  fixture.identityMap.addPrefix({ identityRoot: media, accessRoot: '/fixture/save-images', style: fixturePathStyle, returnAccess: 'isolated file controls' });
  const items = [];
  if (Object.hasOwn(sample, 'parentSource')) items.push({ key: 'parent', Id: parentId, type: 'Folder', Name: 'Parent', Path: media,
    ChannelId: sample.parentSource === 'Channel' ? channelId : null });
  items.push({ key: 'owner', Id: ownerId, type: 'Movie', Name: 'Stored name', Path: path.join(media, 'movie.mkv'),
    parent: items.length ? 'parent' : undefined, ChannelId: sample.source === 'Channel' ? channelId : null });
  await fixture.seed({ target: 'owner', items });
  await writeFile(path.join(media, 'movie.mkv'), 'media control');
  for (const image of sample.images) {
    const identity = /^http/u.test(image.path) ? image.path : path.join(stateRoot, image.path.replaceAll('\\', path.sep));
    if (!/^http/u.test(identity) && !image.missing) {
      await mkdir(path.dirname(identity), { recursive: true }); await writeFile(identity, picture); await utimes(identity, new Date(stamp), new Date(stamp));
    }
    await database.insert('BaseItemImageInfos', { Id: `98b90100-0000-0000-0000-${String(sample.images.indexOf(image) + 1).padStart(12, '0')}`, ItemId: ownerId, ImageType: imageTypes.indexOf(image.type), Path: identity,
      Width: image.ready ? 1 : 0, Height: image.ready ? 1 : 0, Blurhash: image.ready ? Buffer.from('controlled') : null,
      DateModified: image.date ?? MIN_DATE });
  }
  const assets = new MetadataImageAssets({fileSystem: testFileSystem,  metadataPath, stateRoots: [media] });
  const write = assets.write.bind(assets);
  assets.write = async (identity, bytes, options) => {
    await write(identity, bytes, options); await utimes(identity, new Date(stamp), new Date(stamp)); return assets.stat(identity, options);
  };
  const load = fixture.loadContext;
  const loadContext = async (reference, options) => {
    const loaded = await load(reference, options); loaded.imageAssets = assets; loaded.metadataPath = metadataPath;
    const capturePaths = loaded.capturePathScope;
    loaded.capturePathScope = () => ({ ...capturePaths(), metadataPath, imageAssets: assets });
    loaded.saveLocalMetadataEnabled = false; loaded.libraryOptions = { MetadataSavers: ['Controlled'] };
    loaded.reloadMetadataContext = loadContext; return loaded;
  };
  const loaded = await loadContext(ownerId), calls = [], cancellation = new AbortController();
  const projectPath = identity => identity == null ? null : projectStatePath(identity, stateRoot);
  const projectImages = images => images.map(image => ({ path: projectPath(image.Path), type: image.Type, width: image.Width ?? 0, height: image.Height ?? 0,
    blurhash: image.Blurhash == null ? null : Buffer.from(image.Blurhash).toString('utf8'), date: dateText(image.DateModified ?? MIN_DATE) }));
  registry.register({ id: 'controlled-images', name: 'Controlled', providers: [{ id: 'controlled-saver', name: 'Controlled', kind: 'saver', itemTypes: ['Movie'],
    isEnabledFor: () => true, validateSave: async () => {}, save: async (_item, context) => {
      assert.equal(context.signal, undefined);
      // The injected saver gets the active reason via the entry-point wrapper.
      calls.push({ action: 'saver', reason: activeReason });
      if (sample.cancelInSaver) cancellation.abort();
    } }] });
  let activeReason, metadataDepth = 0;
  class RecordedUpdates extends MetadataUpdateHost {
    async update(context, result, reason, options = {}) {
      activeReason = reason;
      return super.update(context, result, reason, { ...options, persist: async (_updated, actual, { signal }) => {
        calls.push({ action: 'save', cancellable: signal != null });
        metadataDepth++;
        try { return await persistMetadata(store, context, actual, { signal }); }
        finally { metadataDepth--; }
      } });
    }
  }
  const images = fixture.host.images;
  images.processor.getImageSize = async (_bytes, identity) => {
    calls.push({ action: 'dimensions', path: projectPath(identity) });
    if (sample.dimensionFailure) throw Object.assign(new Error('Injected dimensions failure'), { code: 'io' });
    return { Width: 1, Height: 1 };
  };
  images.processor.getImageBlurHash = async (_bytes, identity) => {
    calls.push({ action: 'blurhash', path: projectPath(identity) });
    if (sample.blurFailure) throw Object.assign(new Error('Injected BlurHash failure'), { code: 'io' });
    return 'controlled';
  };
  const saveRemote = images.saveRemote.bind(images);
  images.saveRemote = async (context, images, image, options = {}) => {
    calls.push({ action: 'fetch', url: image.Url, cancellable: options.signal != null });
    return saveRemote(context, images, image, options);
  };
  images.fetch = async url => url.endsWith('404') ? new Response('Missing image', { status: 404 })
    : url.endsWith('500') ? new Response('Retryable image', { status: 500 }) : new Response(picture, { headers: { 'content-type': 'image/png' } });
  const deleteWhere = database.deleteWhere.bind(database);
  database.deleteWhere = async (table, where) => {
    if (table === 'BaseItemImageInfos' && metadataDepth === 0) calls.push({ action: 'images', images: projectImages(currentImages) });
    return deleteWhere(table, where);
  };
  if (sample.failure) {
    const table = sample.failure === 'images' ? 'BaseItemImageInfos' : 'BaseItems', operation = sample.failure === 'images' ? 'INSERT' : 'UPDATE';
    await database.client.query("CREATE FUNCTION injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected write failure' USING ERRCODE='23514'; END $$");
    await database.client.query(`CREATE TRIGGER injected_failure BEFORE ${operation} ON "${table}" FOR EACH ROW EXECUTE FUNCTION injected_failure()`);
  }
  let currentImages = sample.clearImages ? [] : loaded.context.images;
  const originalUpdateImages = images.updateImages.bind(images);
  images.updateImages = async (context, values, options) => {
    currentImages = values; return originalUpdateImages(context, values, options);
  };
  const updates = new RecordedUpdates({ registry, store, images });
  updates.on('ItemUpdated', event => calls.push({ action: 'event', reason: event.UpdateReason }));
  if (sample.cancelled) cancellation.abort();
  loaded.item.Name = 'Updated name';
  const result = { Item: loaded.item, Images: sample.clearImages ? [] : null };
  let exception = null;
  try { await updates.update(loaded, result, sample.reason, { signal: cancellation.signal }); }
  catch (error) {
    exception = { name: error.name, message: error.message, code: error.code, status: error.status,
      nativeException: error.nativeException, stack: error.stack };
    if (sample.failure) assert.equal(error.code, '23514', error.stack);
    if (sample.cancelled || sample.cancelInSaver) assert.ok(cancellation.signal.aborted
      && (error.name === 'AbortError' || error.code === 'ABORT_ERR' || error.code === 'cancelled'), error.stack);
  }
  assert.equal(cancellation.signal.aborted, Boolean(sample.cancelled || sample.cancelInSaver));
  const [row] = await database.rows('BaseItems', { where: { Id: ownerId } });
  const savedImages = (await database.rows('BaseItemImageInfos', { where: { ItemId: ownerId } })).sort((a, b) => a.ImageType - b.ImageType);
  const files = (await readdir(stateRoot, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.png'))
    .map(entry => path.join(entry.parentPath, entry.name)).sort(ordinal);
  return { name: sample.name, exception, signalAborted: cancellation.signal.aborted, calls, storedName: row.Name,
    images: projectImages(savedImages.map(image => ({ ...image, Type: imageTypes[image.ImageType] }))),
    liveImages: projectImages(currentImages), files: await Promise.all(files.map(async file => ({ path: projectPath(file), sha256: hash(await readFile(file)) }))) };
}

for (const dialect of ['postgres']) for (const sample of input) test(`${dialect}: native metadata save image lifecycle ${sample.name}`, async t => {
    assertProjectedEqual(t, sample.name, await fixtureFor(t, dialect, sample), native.results.find(row => row.name === sample.name), functional);
  });
