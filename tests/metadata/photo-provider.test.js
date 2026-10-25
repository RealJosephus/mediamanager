import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createPhotoMetadataPlugin } from '../../src/metadata/photo-provider.js';
import { ImageProcessor } from '../../src/images/processor.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { MetadataRegistry } from '../../src/metadata/registry.js';
import { newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { dateTicks, MIN_DATE } from '../../src/library/records.js';
import { formatUtcTicks } from '../../src/syncplay/time.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

import { currentPhotoNative, photoRoot as root, hash, recordPhotoCandidate } from './fixtures/photo-current/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const read = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const { input, native, report } = await currentPhotoNative('provider');
const modified = '2026-10-01T01:02:03.0000000Z';
const fields = ['Name', 'Overview', 'CameraMake', 'CameraModel', 'Software', 'Width', 'Height', 'ProductionYear', 'Genres', 'Tags',
  'ExposureTime', 'FocalLength', 'Aperture', 'ShutterSpeed', 'Latitude', 'Longitude', 'Altitude', 'IsoSpeedRating'];
function storedPhoto(sample = {}) {
  return Object.assign(newNativeItemEntity('MediaBrowser.Controller.Entities.Photo'), {
    Name: 'Stored title', Path: 'Z:\\Photos\\' + (sample.file ?? 'photo.jpg'), IsFileProtocol: true, Overview: 'Stored overview', CameraMake: 'Stored maker',
    CameraModel: 'Stored model', Software: 'Stored software', DateCreated: '2000-01-02T03:04:05.0000000Z',
    PremiereDate: '2000-01-02T00:00:00.0000000Z', ProductionYear: 2000, Width: sample.width ?? 0, Height: sample.height ?? 0,
    CommunityRating: 9, Genres: ['Stored genre'], Tags: ['Stored tag'], Orientation: 'BottomRight', ExposureTime: 9, FocalLength: 99,
    Aperture: 88, ShutterSpeed: 77, Latitude: 66, Longitude: 55, Altitude: 44, IsoSpeedRating: 123, LockedFields: sample.nameLocked ? ['Name'] : [] });
}
const imageProjection = image => ({ path: path.win32.basename(image.Path), type: image.Type, ticks: dateTicks(image.DateModified).toString(),
  Width: image.Width, Height: image.Height, BlurHash: image.BlurHash ?? null });
const errorFields = error => ({ code: error?.code ?? null, message: error?.message ?? null, status: error?.status ?? null });
const errorDiagnostic = error => ({ ...errorFields(error), name: error?.name, stack: error?.stack });
function assertFailure(actual, expected) {
  assert.ok(actual); assert.deepEqual(errorFields(actual), errorFields(expected)); return true;
}
function assertTagDiagnostics(t, errors, { native: expected, controlledFailure, name } = {}) {
  t.diagnostic(JSON.stringify({ name, nodeTagErrors: errors.map(errorDiagnostic),
    nativeTagErrors: expected?.errors, nativeErrorCount: expected?.errorCount, nativeIsoOverflow: expected?.isoOverflow }));
  for (const error of errors) {
    if (controlledFailure) {
      assert.deepEqual(errorFields(error), errorFields(controlledFailure),
        'Only the actual controlled source failure may be reported for this input.');
    } else {
      assert.ok(expected?.errors?.some(error => error != null),
        'A successful native tag input must not hide candidate parser or background failures.');
      assert.ok(['invalid-photo-tags', 'unsupported-photo-tags', 'photo-iso-overflow'].includes(error?.code),
        'An unknown failure must not be classified as an expected tag diagnostic.');
    }
  }
}

test('photo metadata fixture binds same-workflow Native provider execution, original assets and source attribution', () => {
  assert.equal(report.nativeExecutionRecorded, true); assert.equal(report.independentNativeCapturesAgree, true);
  assert.equal(report.historicalRecordingReused, false);
  assert.equal(native.results.length, 64); assert.equal(native.changes.length, 14);
  assert.equal(native.localUtcOffset, '08:00:00'); assert.equal(new Date('2024-03-02T00:00:00Z').getTimezoneOffset(), -480);
  assert.ok(native.assemblies.some(assembly => assembly.name === 'TagLibSharp'));
});

test('embedded photo metadata matches actual native tags, defaults, partial mutations and fallback boundaries', async t => {
  for (const sample of input.cases) await t.test(sample.name, async () => {
    const expected = native.results.find(entry => entry.name === sample.name), bytes = await readFile(new URL('assets/' + sample.file, root));
    assert.equal(hash(bytes), expected.sourceSha256);
    const item = storedPhoto(sample), images = sample.existingPrimary ? [{ Type: 'Primary', Path: 'old-primary.jpg', Width: 40,
      Height: 30, BlurHash: 'old-blurhash', DateModified: '2000-01-01T00:00:00.0000000Z' }] : [];
    const errors = []; let fallbackCalls = 0, result = null, caughtError = null;
    const fallbackFailure = Object.assign(new Error('Controlled fallback failure.'), { code: sample.fallback === 'ArgumentException' ? 'unsupported-image-format' : 'EIO' });
    const provider = createPhotoMetadataPlugin({ logger: { error: error => errors.push(error) }, imageProcessor: {
      async getImageSize() {
        fallbackCalls++;
        if (['ArgumentException', 'IOException'].includes(sample.fallback)) throw fallbackFailure;
        return sample.fallback === 'zero' ? { Width: 0, Height: 0 } : { Width: 31, Height: 17 };
      }
    } }).providers[0];
    try { result = await provider.fetch(item, { images, imageAssets: { async stat() { return { modified }; }, async read() { return bytes; } },
      signal: sample.cancelled ? AbortSignal.abort() : undefined }); }
    catch (error) { caughtError = error; }
    await recordPhotoCandidate('provider', sample.name, { result, failed: Boolean(caughtError), errorCode: caughtError?.code ?? null,
      fallbackCalls, errorCount: errors.length, diagnostics: errors.map(errorDiagnostic),
      item: Object.fromEntries(fields.map(field => [field, item[field]])),
      orientation: item.Orientation, communityRating: item.CommunityRating,
      dateCreatedTicks: dateTicks(item.DateCreated).toString(), premiereDateTicks: dateTicks(item.PremiereDate).toString(),
      images: images.map(imageProjection) });
    assert.equal(result, expected.update); assert.equal(Boolean(caughtError), expected.errorOccurred);
    if (sample.fallback === 'IOException') assertFailure(caughtError, fallbackFailure);
    assert.equal(fallbackCalls, expected.fallbackCalls);
    assertTagDiagnostics(t, errors, { native: expected, name: sample.name });
    assert.deepEqual(Object.fromEntries(fields.map(field => [field, item[field]])), Object.fromEntries(fields.map(field => [field, expected.item[field]])));
    assert.equal(item.Orientation, expected.item.orientation);
    assert.equal(item.CommunityRating, expected.item.communityRatingDouble);
    assert.equal(dateTicks(item.DateCreated).toString(), expected.item.dateCreatedTicks);
    assert.equal(dateTicks(item.PremiereDate).toString(), expected.item.premiereDateTicks);
    assert.deepEqual(images.map(imageProjection), expected.item.images.map(image => ({ path: image.path, type: image.type,
      ticks: dateTicks(image.dateModified).toString(), Width: image.Width, Height: image.Height, BlurHash: image.BlurHash })));
  });
});

test('photo change monitoring matches native one-second ticks in either direction and absent files', async t => {
  const provider = createPhotoMetadataPlugin({ imageProcessor: { getImageSize() {} } }).providers[0];
  for (const sample of native.changes) await t.test(`${sample.deltaTicks}/${sample.exists}`, async () => {
    const item = storedPhoto(); item.DateModified = formatUtcTicks(dateTicks(modified) + BigInt(sample.deltaTicks));
    const actual = await provider.hasChanged(item, { fileSystemMetadata: async () => sample.exists ? { exists: true, kind: 'file', modified } : null });
    assert.equal(actual, sample.changed);
  });
  assert.equal(await provider.hasChanged({ IsFileProtocol: false }, { fileSystemMetadata() { assert.fail('No remote lookup.'); } }), false);
});

test('corrupt mixed-case Unicode EXIF comments match the separate actual native observation', async t => {
  const { native: edge, input: edgeInput } = await currentPhotoNative('comment');
  const patch = await read('user-comment/asset-patch.json');
  const bytes = await readFile(new URL('user-comment/unicode-comment.jpg', root)), original = await readFile(new URL('assets/exif.jpg', root));
  assert.equal(hash(original), patch.source.sha256); assert.equal(hash(bytes), patch.output.sha256); assert.equal(bytes.length, original.length);
  const replaced = Buffer.from(original); Buffer.from(patch.toHex, 'hex').copy(replaced, patch.headerOffset); assert.deepEqual(bytes, replaced);
  assert.equal(original.subarray(patch.headerOffset, patch.headerOffset + 8).toString('hex'), patch.fromHex);
  const sample = edgeInput.cases[0], expected = edge.results[0], item = storedPhoto(sample), images = [], errors = [];
  assert.equal(hash(bytes), expected.sourceSha256);
  const provider = createPhotoMetadataPlugin({ imageProcessor: { getImageSize() { assert.fail('EXIF dimensions avoid the decoder.'); } },
    logger: { error: error => errors.push(error) } }).providers[0];
  const result = await provider.fetch(item, { images, imageAssets: { async stat() { return { modified }; }, async read() { return bytes; } } });
  assert.equal(result, expected.update); assertTagDiagnostics(t, errors, { native: expected, name: sample.name });
  assert.deepEqual(Object.fromEntries(fields.map(field => [field, item[field]])), Object.fromEntries(fields.map(field => [field, expected.item[field]])));
  assert.equal(item.Orientation, expected.item.orientation); assert.equal(dateTicks(item.DateCreated).toString(), expected.item.dateCreatedTicks);
  assert.equal(dateTicks(item.PremiereDate).toString(), expected.item.premiereDateTicks);
});

test('the Photo provider is an enabled forced custom provider in the real registry', () => {
  const registry = new MetadataRegistry(), plugin = createPhotoMetadataPlugin({ imageProcessor: { getImageSize() {} } });
  registry.register(plugin);
  const providers = registry.discover({ item: storedPhoto(), kind: 'custom' });
  assert.equal(providers.length, 1); assert.equal(providers[0].name, 'Embedded Information'); assert.equal(providers[0].forced, true);
  assert.deepEqual(registry.discover({ item: { Type: 'PhotoAlbum' }, kind: 'custom' }), []);
});

test('original Primary replacement preserves file BlurHash but clears it for native remote paths', async t => {
  const { native: edge } = await currentPhotoNative('edges');
  for (const sample of edge.results) await t.test(sample.source, async () => {
    const item = storedPhoto({ width: 4, height: 3 }); item.Path = sample.source;
    const images = [{ Type: 'Primary', Path: 'old-primary.jpg', Width: 40, Height: 30, BlurHash: 'old-blurhash', DateModified: '2000-01-01T00:00:00Z' }];
    let statCalls = 0;
    const provider = createPhotoMetadataPlugin({ imageProcessor: { getImageSize() { assert.fail('Retained dimensions skip fallback.'); } } }).providers[0];
    const update = await provider.fetch(item, { images, imageAssets: { async stat() { statCalls++; return { modified }; }, async read() { assert.fail('This unsupported extension has no tag reads.'); } } });
    await recordPhotoCandidate('edges', sample.source, { update, statCalls, images: images.map(image => ({ Path: image.Path,
      Width: image.Width, Height: image.Height, BlurHash: image.BlurHash, ticks: dateTicks(image.DateModified).toString() })) });
    assert.equal(update, sample.update); assert.equal(statCalls, sample.statCalls);
    assert.deepEqual(images.map(image => ({ Path: image.Path, Width: image.Width, Height: image.Height, BlurHash: image.BlurHash,
      ticks: dateTicks(image.DateModified).toString() })), sample.images.map(image => ({ Path: image.Path, Width: image.Width,
      Height: image.Height, BlurHash: image.BlurHash, ticks: dateTicks(image.dateModified).toString() })));
  });
});

test('real static decoder recovers original dimensions for native tag-reader fallback formats', async t => {
  const processor = new ImageProcessor(); t.after(() => processor.close());
  for (const filename of ['photo.webp', 'photo.avif', 'photo.gif', 'invalid.jpg']) await t.test(filename, async () => {
    const bytes = await readFile(new URL('assets/' + filename, root)), item = storedPhoto({ file: filename }), images = [], errors = [];
    const provider = createPhotoMetadataPlugin({ imageProcessor: processor, logger: { error: error => errors.push(error) } }).providers[0];
    const update = await provider.fetch(item, { images, imageAssets: { async stat() { return { modified }; }, async read() { return bytes; } } });
    assert.equal(update, 6); assert.equal(item.Width, filename === 'invalid.jpg' ? 0 : 8); assert.equal(item.Height, filename === 'invalid.jpg' ? 0 : 6);
    assert.equal(item.CameraMake, 'Stored maker'); assert.equal(images[0].Path, item.Path);
    const expected = native.results.find(sample => sample.name === {
      'photo.webp': 'webp-format', 'photo.avif': 'avif-format', 'photo.gif': 'gif-format', 'invalid.jpg': 'invalid-jpeg',
    }[filename]);
    assert.ok(expected, filename); assertTagDiagnostics(t, errors, { native: expected, name: filename });
  });
});

test('original photo metadata reads the scoped VFS source while preserving its native Primary identity', async t => {
  const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  registry.registerType('memory', configuration => new MemoryStorageAdapter(configuration));
  await registry.createInstance('media', 'memory', {}); vfs.mount({ path: '/photos', instanceId: 'media', root: '/', capabilities: { create: true, replace: true } });
  identityMap.addPrefix({ identityRoot: 'Z:\\Photos', accessRoot: '/photos', style: 'windows', returnAccess: 'Photo metadata original' });
  t.after(() => registry.close());
  const bytes = await readFile(new URL('assets/combined.jpg', root)); await vfs.write('/photos/combined.jpg', bytes, { modified });
  const item = storedPhoto({ file: 'combined.jpg' }), images = [];
  const assets = new MetadataImageAssets({ vfs, identityMap }).forItem(item, '/photos/combined.jpg');
  const provider = createPhotoMetadataPlugin({ imageProcessor: { getImageSize() { assert.fail('JPEG dimensions come from its actual tags.'); } } }).providers[0];
  await provider.fetch(item, { images, imageAssets: assets });
  assert.equal(item.CameraMake, 'XMP maker'); assert.equal(item.Name, 'XMP title'); assert.equal(item.Width, 8); assert.equal(item.Height, 6);
  assert.equal(images[0].Path, 'Z:\\Photos\\combined.jpg'); assert.equal(dateTicks(images[0].DateModified), dateTicks(modified));
  assert.deepEqual(await assets.read(images[0].Path), bytes);
});

test('tag read failures keep original registration and fallback IO failures reach the caller', async t => {
  const item = storedPhoto(), images = [], failure = new Error('Controlled source IO failure.'), errors = []; let reads = 0;
  const provider = createPhotoMetadataPlugin({ logger: { error: error => errors.push(error) }, imageProcessor: { getImageSize() { assert.fail('The failed original read never reaches a decoder.'); } } }).providers[0];
  await assert.rejects(provider.fetch(item, { images, imageAssets: { async stat() { return { modified }; }, async read() { reads++; throw failure; } } }), error => assertFailure(error, failure));
  assert.equal(reads, 2); assertTagDiagnostics(t, errors, { controlledFailure: failure, name: 'controlled source read' });
  assert.equal(item.CameraMake, 'Stored maker'); assert.equal(images[0].Path, item.Path);
});

test('missing original stat preserves the Primary path before a later read fails; other stat errors propagate', async () => {
  const provider = createPhotoMetadataPlugin({ logger: { error() {} }, imageProcessor: { getImageSize() {} } }).providers[0];
  const item = storedPhoto(), images = [], missing = Object.assign(new Error('Missing original.'), { code: 'not-found' });
  await assert.rejects(provider.fetch(item, { images, imageAssets: { async stat() { throw missing; }, async read() { throw missing; } } }), error => assertFailure(error, missing));
  assert.equal(images[0].DateModified, MIN_DATE); assert.equal(images[0].Path, item.Path);
  const denied = Object.assign(new Error('Original stat denied.'), { code: 'permission-denied' }), untouched = [];
  await assert.rejects(provider.fetch(item, { images: untouched, imageAssets: { async stat() { throw denied; }, async read() { assert.fail('No read after a failed registration.'); } } }), error => assertFailure(error, denied));
  assert.deepEqual(untouched, []);
});
