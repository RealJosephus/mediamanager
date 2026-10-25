import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getMimeType, mimeToExtension } from '../../src/http/mime-types.js';
import { imageSavePaths } from '../../src/metadata/image-paths.js';
import { imageUploadExtension } from '../../src/images/upload.js';
import { captureCurrentNative, recordCandidate } from './fixtures/mime-types-current/capture.js';

let native;
before(async () => { ({ native } = await captureCurrentNative()); });

test('complete MIME resource matches current designated native maps with original source and license bytes', async () => {
  const resource = JSON.parse(await readFile(new URL('../../src/http/resources/mime-types.json', import.meta.url)));
  await recordCandidate('resource', resource);
  assert.deepEqual(resource, native.resource);
  assert.equal(native.inventory.extensions.length, 1202);
  assert.equal(native.inventory.mimeTypes.length, 963);
});

test('all native filename extension, override, default, path and case observations match JavaScript MIME lookup', async () => {
  assert.equal(native.filenameResults.length, 3706);
  const observations = native.filenameResults.map(({ filename, explicitDefault, defaultValue }) => {
    const input = { filename, explicitDefault, defaultValue };
    try { return { ...input, failed: false, mime: explicitDefault ? getMimeType(filename, defaultValue) : getMimeType(filename) }; }
    catch { return { ...input, failed: true, mime: null }; }
  });
  await recordCandidate('filenames', observations);
  for (const [index, sample] of native.filenameResults.entries()) {
    assert.deepEqual(observations[index], { filename: sample.filename, explicitDefault: sample.explicitDefault,
      defaultValue: sample.defaultValue, failed: Boolean(sample.exception), mime: sample.mime }, JSON.stringify(sample));
  }
});

test('all native first-extension, MIME case and untrimmed semicolon observations match JavaScript reverse lookup', async () => {
  assert.equal(native.extensionResults.length, 4826);
  const observations = native.extensionResults.map(({ mimeType }) => {
    try { return { mimeType, failed: false, extension: mimeToExtension(mimeType) }; }
    catch { return { mimeType, failed: true, extension: null }; }
  });
  await recordCandidate('extensions', observations);
  for (const [index, sample] of native.extensionResults.entries()) {
    assert.deepEqual(observations[index], { mimeType: sample.mimeType, failed: Boolean(sample.exception),
      extension: sample.extension }, sample.mimeType);
  }
});

test('generic metadata image saving uses native known MIME extensions while HTTP uploads retain image validation', async () => {
  const item = { Id: 'c18000000000000000000000000000001', Type: 'PhotoAlbum', Path: 'Z:\\Photos\\Album', IsFolder: true };
  const observations = [];
  for (const mime of ['text/plain', 'application/xml', 'image/heic', 'image/tiff', 'image/jpeg; charset=UTF-8']) {
    const expected = native.extensionResults.find(value => value.mimeType === mime)?.extension
      ?? native.resource.mimeExtensions[mime.split(';')[0]];
    assert.ok(expected);
    const [filename] = imageSavePaths(item, 'Primary', 0, mime, { saveLocally: false, metadataPath: 'D:\\metadata' });
    assert.ok(filename.endsWith('folder' + expected), filename);
    observations.push({ mime, expectedExtension: expected, filename, uploadExtension: imageUploadExtension(mime) });
  }
  for (const mime of ['text/plain', 'application/xml', 'application/octet-stream']) assert.equal(imageUploadExtension(mime), null);
  assert.equal(imageUploadExtension('image/png; charset=UTF-8'), '.png');
  assert.equal(imageUploadExtension('IMAGE/JPEG'), '.jpg');
  assert.throws(() => imageSavePaths(item, 'Primary', 0, 'image/x-unknown', { metadataPath: 'D:\\metadata' }), TypeError);
  await recordCandidate('image-consumers', observations);
});
