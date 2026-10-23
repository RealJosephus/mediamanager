import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readFile, mkdtemp, mkdir, rm, writeFile, stat, chmod } from 'node:fs/promises';
import sharp from 'sharp';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { SplashscreenImageGenerator, composeSplashscreenWall, nextSplashscreenImage, transformSplashscreen } from '../../src/images/splashscreen.js';
import { observeComparison } from '../comparison-observations.js';
import { recordedInputPath } from '../../tools/validation/paths.js';
import { fixture, fixtureRoot, nativeBytes, inputBytes, proofBytes, manifestBytes, native, input, proof, manifest, hash,
  recordedFile, rgba, recordedCoordinates, admissibleCoordinate, candidateCoordinates } from './splashscreen-fixture.js';

const assets = new MetadataImageAssets({fileSystem: testFileSystem,  stateRoots: [path.join(fixtureRoot, 'assets')] });
const imagePaths = values => values.map(filename => path.join(fixtureRoot, 'assets', filename));

async function stateDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'splashscreen-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('splashscreen-'));
    const filename = path.join(root, 'data', 'splashscreen.png');
    if (await stat(filename).then(info => info.isFile(), error => { if (error.code === 'ENOENT') return false; throw error; })) await chmod(filename, 0o666);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('splashscreen raster fixtures bind 23 actual encoder cases, four transforms, ten helper observations and all bytes', async () => {
  assert.equal(hash(nativeBytes), proof.nativeSha256); assert.equal(hash(inputBytes), proof.inputSha256);
  assert.equal(native.inputSha256, proof.inputSha256); assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0);
  for (const flag of ['actualSkiaEncoder', 'actualSplashscreenBuilder', 'actualSkiaHelper', 'actualTransform']) assert.equal(native[flag], true);
  assert.equal(native.mediaOpened, false); assert.equal(native.portOpened, false);
  assert.equal(native.results.length, 23); assert.equal(native.transforms.length, 4); assert.equal(native.helper.length, 10);
  assert.deepEqual(native.results.map(row => row.sample), input.map(row => ({
    Name: '', Posters: [], Backdrops: [], Existing: false, MissingDataDirectory: false, Repeat: false, DirectoryOutput: false, ReadOnlyOutput: false, ...row,
  })));
  for (const source of proof.oracleSources) assert.equal(hash(await readFile(source.name === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.name, fixture))), source.sha256);
  for (const entry of manifest.files) {
    const bytes = await readFile(new URL(entry.local, fixture)); assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256, entry.local);
  }
  for (const source of manifest.consumerSources) assert.equal(hash(await readFile(recordedInputPath(source.filename, [source.sha256]))), source.sha256);
  assert.equal(manifest.generatedRasterPolicy.ordinaryProcessedImagesPolicyUnchanged, true);
  assert.ok(manifestBytes.length && proofBytes.length);
  const repeat = native.results.find(row => row.sample.Repeat);
  assert.notEqual(repeat.after.pixelHash, repeat.repeated.pixelHash, 'Actual mixed composition has no fixed output pixel hash.');
});

test('splashscreen helper cycles, skips invalid bitmaps and preserves decoder, extension and directory boundaries', async t => {
  for (const row of native.helper) await t.test(JSON.stringify(row.definition), async () => {
    if (row.failure) {
      await assert.rejects(nextSplashscreenImage(imagePaths(row.definition.Paths), row.definition.Start, { assets }), /File not found/);
    } else {
      const result = await nextSplashscreenImage(imagePaths(row.definition.Paths), row.definition.Start, { assets });
      assert.equal(result.index, row.index);
      assert.deepEqual(result.image ? { Width: result.image.width, Height: result.image.height, pixelHash: hash(result.image.data()) } : null, row.bitmap);
    }
  });
});

test('splashscreen projection preserves native nearest geometry and exact source colors at every target pixel', async t => {
  const expected = await recordedCoordinates(), actual = await candidateCoordinates(transformSplashscreen);
  let boundaryChoices = 0;
  for (let index = 0; index < expected.length; index++) {
    const x = index % 1920, y = Math.floor(index / 1920);
    assert.ok(admissibleCoordinate(expected[index], x, y), `Native coordinate at ${x},${y}`);
    assert.ok(admissibleCoordinate(actual[index], x, y), `Candidate coordinate at ${x},${y}`);
    if (expected[index] !== actual[index]) boundaryChoices++;
  }
  assert.equal(admissibleCoordinate(expected[960] + 5760 * 2, 960, 0), false, 'The bound rejects a two-row displacement.');
  assert.equal(admissibleCoordinate(expected[960] + 2, 960, 0), false, 'The bound rejects a two-column displacement.');
  observeComparison(t, 'splashscreen projection', { pixels: actual.length, boundaryChoices, hash: hash(Buffer.from(actual.buffer)) },
    { pixels: expected.length, hash: hash(Buffer.from(expected.buffer)) });
  for (const row of native.transforms.filter(row => row.name !== 'coordinates')) {
    const source = await rgba(row.input), nativePixels = await rgba(row.output), pixels = transformSplashscreen(source);
    for (let index = 0; index < expected.length; index++) for (let channel = 0; channel < 4; channel++) {
      const offset = index * 4 + channel;
      if (nativePixels[offset] !== (channel === 3 ? 255 : expected[index] < 0 ? 0 : source[expected[index] * 4 + channel])) assert.fail(`Native ${row.name} ${offset}`);
      if (pixels[offset] !== (channel === 3 ? 255 : actual[index] < 0 ? 0 : source[actual[index] * 4 + channel])) assert.fail(`${row.name} ${offset}`);
    }
    observeComparison(t, row.name, { pixelHash: hash(pixels) }, { pixelHash: row.output.pixelHash });
    if (row.name === 'solid') assert.equal(hash(pixels), row.output.pixelHash);
  }
});

for (const row of native.results) test(`splashscreen encoder: ${row.sample.Name}`, async t => {
  const root = await stateDirectory(t), dataPath = path.join(root, 'data'), filename = path.join(dataPath, 'splashscreen.png');
  if (!row.sample.MissingDataDirectory) await mkdir(dataPath);
  if (row.before) await writeFile(filename, await readFile(recordedFile(row.before)));
  if (row.sample.DirectoryOutput) await mkdir(filename);
  if (row.sample.ReadOnlyOutput) await chmod(filename, 0o444);
  const logs = [], generator = new SplashscreenImageGenerator({ dataPath, assets, random: () => 0,
    logger: { error: (error, message) => logs.push({ level: 'Error', message }) } });
  t.after(() => generator.close());
  let failure = null;
  try { await generator.createSplashscreen(imagePaths(row.sample.Posters), imagePaths(row.sample.Backdrops)); }
  catch (error) { failure = error; }
  assert.equal(Boolean(failure), Boolean(row.failure));
  if (row.failure && row.sample.Name !== 'zero-tile-width') assert.equal(failure.message, row.failure.Message);
  assert.deepEqual(logs, row.logs);
  const file = await stat(filename).then(info => info.isFile(), error => { if (error.code === 'ENOENT') return false; throw error; });
  assert.equal(file, row.after != null);
  if (!file) return;
  const bytes = await readFile(filename);
  if (row.before && (row.failure || !row.sample.Posters.length || !row.sample.Backdrops.length || row.sample.ReadOnlyOutput)) {
    assert.equal(hash(bytes), row.before.sha256); return;
  }
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 1920); assert.equal(decoded.info.height, 1080);
  if (row.sample.Repeat) {
    await generator.createSplashscreen(imagePaths(row.sample.Posters), imagePaths(row.sample.Backdrops));
    assert.equal(hash(await readFile(filename)), hash(bytes), 'A controlled row choice produces repeatable files.');
    return;
  }
  const candidateWall = await composeSplashscreenWall(imagePaths(row.sample.Posters), imagePaths(row.sample.Backdrops), { assets, random: () => 0 });
  const nativeWall = await rgba(row.wall.file);
  let quantizedChannels = 0;
  for (let offset = 0; offset < nativeWall.length; offset++) {
    const difference = Math.abs(candidateWall[offset] - nativeWall[offset]);
    if (difference > (offset % 4 === 3 ? 0 : 1)) assert.fail(`Wall channel ${offset}: ${difference}`);
    if (difference) quantizedChannels++;
  }
  const actual = await candidateCoordinates(transformSplashscreen), expected = await recordedCoordinates(), nativePixels = await rgba(row.after);
  for (let index = 0; index < expected.length; index++) for (let channel = 0; channel < 4; channel++) {
    const offset = index * 4 + channel;
    if (nativePixels[offset] !== (channel === 3 ? 255 : expected[index] < 0 ? 0 : nativeWall[expected[index] * 4 + channel])) assert.fail(`Native pixel ${offset}`);
    if (decoded.data[offset] !== (channel === 3 ? 255 : actual[index] < 0 ? 0 : candidateWall[actual[index] * 4 + channel])) assert.fail(`Candidate pixel ${offset}`);
  }
  observeComparison(t, row.sample.Name, { bytes: bytes.length, sha256: hash(bytes), wallPixelHash: hash(candidateWall),
    quantizedChannels, pixelHash: hash(decoded.data) }, { bytes: row.after.bytes, sha256: row.after.sha256,
    wallPixelHash: row.wall.pixelHash, pixelHash: row.after.pixelHash });
});

test('splashscreen shutdown aborts an active read and every queued generation before they can write', async t => {
  const root = await stateDirectory(t), dataPath = path.join(root, 'data'); await mkdir(dataPath);
  const started = Promise.withResolvers(); let reads = 0;
  const generator = new SplashscreenImageGenerator({ dataPath, assets: {
    async stat() { return { kind: 'file' }; },
    async read(filename, { signal }) {
      reads++; started.resolve();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  } });
  const first = generator.createSplashscreen(['first.png'], ['backdrop.png']), second = generator.createSplashscreen(['second.png'], ['backdrop.png']);
  const results = Promise.allSettled([first, second]); await started.promise;
  const closing = generator.close(); assert.equal(generator.close(), closing); await closing; assert.equal(reads, 1);
  for (const result of await results) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.name, 'AbortError'); }
  await assert.rejects(generator.createSplashscreen(['later.png'], ['later.png']), { name: 'AbortError' });
  await assert.rejects(stat(path.join(dataPath, 'splashscreen.png')), { code: 'ENOENT' });
});

test('splashscreen read failures preserve an existing output and do not admit another image', async t => {
  const root = await stateDirectory(t), dataPath = path.join(root, 'data'); await mkdir(dataPath);
  const filename = path.join(dataPath, 'splashscreen.png'), old = Buffer.from('Preserved output bytes'); await writeFile(filename, old);
  const error = Object.assign(new Error('Controlled network interruption'), { code: 'connection-reset' }); let reads = 0;
  const generator = new SplashscreenImageGenerator({ dataPath, assets: { async stat() { return { kind: 'file' }; },
    async read() { reads++; throw error; } } });
  t.after(() => generator.close());
  await assert.rejects(generator.createSplashscreen(['first.png', 'later.png'], ['backdrop.png']), value => value === error);
  assert.equal(reads, 1); assert.deepEqual(await readFile(filename), old);
});
