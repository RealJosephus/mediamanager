import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getMimeType, mimeToExtension } from '../../src/http/mime-types.js';
import { imageSavePaths } from '../../src/metadata/image-paths.js';
import { imageUploadExtension } from '../../src/images/upload.js';

const provenanceUrl = new URL('./fixtures/mime-types/provenance.json', import.meta.url);
const resourceProvenanceUrl = new URL('../../src/http/resources/mime-types-provenance.json', import.meta.url);
const root = new URL('.', provenanceUrl);
const resourceRoot = new URL('.', resourceProvenanceUrl);
const native = JSON.parse(await readFile(new URL('native.json', root), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');

test('complete MIME resource binds actual native maps, source-only package, designated build and raw execution', async () => {
  const provenance = JSON.parse(await readFile(provenanceUrl, 'utf8'));
  const resources = JSON.parse(await readFile(resourceProvenanceUrl, 'utf8'));
  for (const file of provenance.files) assert.equal(hash(await readFile(new URL(file.filename, root))), file.sha256, file.filename);
  for (const file of resources.files) assert.equal(hash(await readFile(new URL(file.filename, resourceRoot))), file.sha256, file.filename);
  const bound = async entry => {
    const bytes = await readFile(entry.filename); assert.equal(hash(bytes), entry.sha256, entry.filename); return bytes;
  };
  assert.deepEqual(provenance.externalInputs, [...resources.sources, ...resources.assemblies,
    ...Object.values(resources.package.inputs), resources.sourceBuild, resources.record]);
  for (const file of [...resources.sources, ...resources.assemblies, ...Object.values(resources.package.inputs)]) await bound(file);
  const record = JSON.parse(await bound(resources.record));
  const build = JSON.parse(await bound(resources.sourceBuild));
  assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0); assert.equal(build.passed, true);
  assert.equal(record.jellyfinDll.sha256, build.buildIdentity.nativeDll.sha256);
  assert.equal(record.sourceFilesSha256, resources.sourceFilesSha256);
  assert.deepEqual(native.assemblies.map(value => [value.name, value.sha256]), resources.assemblies.filter(value => value.observed).map(value => [value.name, value.sha256]));
  for (const entry of record.sourceFiles) {
    const name = entry.filename.replaceAll(String.fromCharCode(92), '/').split('/').at(-1);
    assert.equal(entry.sha256, provenance.files.find(file => file.filename === (name === 'Directory.Build.props' ? '../../../Directory.Build.props' : name))?.sha256);
  }
  assert.equal(record.outputs.find(entry => entry.filename.replaceAll(String.fromCharCode(92), '/').endsWith('/native.json'))?.sha256,
    provenance.files.find(entry => entry.filename === 'native.json').sha256);
  assert.deepEqual(JSON.parse(await readFile(new URL('mime-types.json', resourceRoot), 'utf8')), native.resource);
  assert.deepEqual([native.inventory.packageEntries, native.inventory.mimeOverrides, native.inventory.extensionOverrides,
    native.inventory.extensionCount, native.inventory.mimeCount], [1180, 25, 31, 1202, 963]);
});

test('all native filename extension, override, default, path and case observations match JavaScript MIME lookup', () => {
  assert.equal(native.filenameResults.length, 3706);
  for (const sample of native.filenameResults) {
    const call = () => sample.explicitDefault ? getMimeType(sample.filename, sample.defaultValue) : getMimeType(sample.filename);
    if (sample.exception) assert.throws(call, TypeError);
    else assert.equal(call(), sample.mime, JSON.stringify(sample));
  }
});

test('all native first-extension, MIME case and untrimmed semicolon observations match JavaScript reverse lookup', () => {
  assert.equal(native.extensionResults.length, 4826);
  for (const sample of native.extensionResults) {
    if (sample.exception) assert.throws(() => mimeToExtension(sample.mimeType), TypeError);
    else assert.equal(mimeToExtension(sample.mimeType), sample.extension, sample.mimeType);
  }
});

test('generic metadata image saving uses native known MIME extensions while HTTP uploads retain image validation', () => {
  const item = { Id: 'c18000000000000000000000000000001', Type: 'PhotoAlbum', Path: 'Z:\\Photos\\Album', IsFolder: true };
  for (const mime of ['text/plain', 'application/xml', 'image/heic', 'image/tiff', 'image/jpeg; charset=UTF-8']) {
    const expected = native.extensionResults.find(value => value.mimeType === mime)?.extension
      ?? native.resource.mimeExtensions[mime.split(';')[0]];
    assert.ok(expected);
    const [filename] = imageSavePaths(item, 'Primary', 0, mime, { saveLocally: false, metadataPath: 'D:\\metadata' });
    assert.ok(filename.endsWith('folder' + expected), filename);
  }
  for (const mime of ['text/plain', 'application/xml', 'application/octet-stream']) assert.equal(imageUploadExtension(mime), null);
  assert.equal(imageUploadExtension('image/png; charset=UTF-8'), '.png');
  assert.equal(imageUploadExtension('IMAGE/JPEG'), '.jpg');
  assert.throws(() => imageSavePaths(item, 'Primary', 0, 'image/x-unknown', { metadataPath: 'D:\\metadata' }), TypeError);
});
