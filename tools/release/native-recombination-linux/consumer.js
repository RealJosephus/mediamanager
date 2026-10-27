import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { ImageProcessor } from '../../../src/images/processor.js';
import { MetadataImageAssets } from '../../../src/metadata/image-assets.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../../src/storage/index.js';
import { StorageFileSystem } from '../../../src/storage/files.js';
import { LocalAdapter } from '../../../plugins/local/adapter.js';
import { fileIdentity, inside, json, writeJson } from '../materials.js';
import { imageCases } from './verify.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
async function decodeIndependent(bytes) {
  const image = await loadImage(bytes), canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
  return { size: { width: image.width, height: image.height }, pixels: [...context.getImageData(0, 0, image.width, image.height).data] };
}

async function consume(mode, inputRoot, dataRoot, expectedLibrary) {
  assert.ok(['stock', 'modified'].includes(mode));
  inputRoot = await realpath(inputRoot); dataRoot = path.resolve(dataRoot);
  await mkdir(dataRoot, { recursive: false });
  assert.equal(await realpath(dataRoot), dataRoot);
  const manifest = await json(path.join(root, 'release.json'));
  const inputFiles = [], results = [];
  if (mode === 'stock') {
    for (const fixture of imageCases) {
      const pixels = Buffer.from(Array.from({ length: 20 }, () => fixture.rgba.slice(0, fixture.channels)).flat());
      let pipeline = sharp(pixels, { raw: { width: 5, height: 4, channels: fixture.channels } });
      if (fixture.format === 'png') pipeline = pipeline.png({ progressive: false, palette: false });
      else if (fixture.format === 'jpeg') pipeline = pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4' });
      else pipeline = pipeline.webp({ lossless: true });
      await writeFile(path.join(inputRoot, fixture.name + '.' + fixture.format), await pipeline.toBuffer(), { flag: 'wx' });
    }
  }
  const registry = new StorageRegistry(), vfs = new VirtualFileSystem(registry), identityMap = new IdentityAccessMap();
  registry.registerType('private-local', configuration => LocalAdapter.open(configuration));
  const processorErrors = [], processor = new ImageProcessor({ fileSystem: new StorageFileSystem({ vfs, identityMap }), cachePath: path.join(dataRoot, 'cache'),
    logger: { error(error) { processorErrors.push({ message: error.message, code: error.code }); } } });
  let receipt;
  try {
    await registry.createInstance('private-image-assets', 'private-local', { root: dataRoot, writable: true });
    vfs.mount({ path: '/private-images', instanceId: 'private-image-assets', root: '/', capabilities: { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } });
    identityMap.addPrefix({ identityRoot: dataRoot, accessRoot: '/private-images', style: 'posix', caseSensitive: true, returnAccess: 'Private native recombination assets' });
    const assets = new MetadataImageAssets({ fileSystem: processor.fileSystem, vfs, identityMap, metadataPath: dataRoot });
    for (const fixture of imageCases) {
      const name = fixture.name + '.' + fixture.format, bytes = await readFile(path.join(inputRoot, name));
      if (fixture.format === 'png') {
        assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
        assert.equal(bytes[24], 8, 'The actual PNG fixture must be eight bit.');
        assert.equal(bytes[28], 0, 'The actual PNG fixture must be non-interlaced.');
        assert.equal(bytes[25], fixture.channels === 3 ? 2 : 6, 'The PNG must retain its selected RGB/RGBA channel layout.');
      }
      inputFiles.push({ name, ...await fileIdentity(path.join(inputRoot, name)) });
      const filename = path.join(dataRoot, name);
      await assets.write(filename, bytes);
      const info = await assets.stat(filename);
      const size = await processor.getImageSize(bytes, filename);
      const decoded = await sharp(bytes, { failOn: 'warning' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const image = { Path: filename, DateModified: info.modified, ...size };
      const options = { item: { Type: 'Movie' }, image, assets, Width: 3, Height: 2, SupportedOutputFormats: ['Png'] };
      const result = await processor.process(options);
      assert.equal(result.original, false, 'The real application resize must execute.');
      assert.equal(result.mimeType, 'image/png');
      assert.ok(Buffer.isBuffer(result.bytes) && result.bytes.length > 0);
      inside(dataRoot, result.path);
      assert.deepEqual(await processor.fileSystem.readFile(result.path), result.bytes);
      const cached = await processor.process(options);
      assert.deepEqual(cached.bytes, result.bytes);
      results.push({ name: fixture.name, size, sharp: { info: { width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels }, pixels: [...decoded.data] },
        application: { original: result.original, mimeType: result.mimeType, path: result.path, ...await decodeIndependent(result.bytes),
          cacheReadEqual: cached.path === result.path && cached.bytes.equals(result.bytes), ...await fileIdentity(result.path) } });
    }
    assert.deepEqual(processorErrors, [], 'The application cannot downgrade encoding failures into an original-image success.');
    const sharedObjects = process.report.getReport().sharedObjects;
    const libraries = await Promise.all(sharedObjects.filter(value => /(?:^|\/)libvips[^/]*\.so(?:\.|$)/u.test(value)).map(value => realpath(value)));
    const actualLibrary = await realpath(expectedLibrary);
    assert.deepEqual(libraries, [actualLibrary], 'The OS must load exactly the selected private aggregate.');
    inside(root, actualLibrary);
    const bindings = [];
    for (const filename of sharedObjects.filter(value => /sharp[^/]*\.node$/u.test(value))) {
      const actual = await realpath(filename); inside(root, actual); bindings.push({ path: actual, ...await fileIdentity(actual) });
    }
    assert.equal(bindings.length, 1, 'The actual private Sharp native binding must be loaded.');
    const sourceFiles = [];
    for (const filename of ['tools/release/native-recombination-linux/consumer.js', 'src/images/processor.js', 'src/images/renderer.js', 'src/metadata/image-assets.js', 'plugins/local/adapter.js']) {
      sourceFiles.push({ path: filename, ...await fileIdentity(path.join(root, filename)) });
    }
    receipt = { mode, pid: process.pid, ppid: process.ppid, candidate: manifest.candidate, dataRoot, node: process.version,
      sharpVersions: sharp.versions, loadedLibrary: { path: actualLibrary, ...await fileIdentity(actualLibrary) },
      bindings, sharedObjects, sourceFiles, inputs: inputFiles, cases: results };
  } finally {
    try { await processor.close(); } finally { await registry.close(); }
  }
  await assert.rejects(processor.fileSystem.stat(dataRoot), error => error.code === 'closed');
  return { ...receipt, closed: true };
}

if (process.argv.length !== 7) throw new Error('Usage: node consumer.js stock|modified INPUT_DIRECTORY NEW_DATA_DIRECTORY RECEIPT EXPECTED_PRIVATE_LIBRARY');
try {
  const value = await consume(process.argv[2], process.argv[3], process.argv[4], process.argv[6]);
  await writeJson(path.resolve(process.argv[5]), value);
} catch (error) {
  await writeJson(path.resolve(process.argv[5]) + '.failure.json', { mode: process.argv[2], name: error.name, message: error.message, stack: error.stack });
  throw error;
}
