import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { composeUserViewCollage } from '../../src/images/user-view-collage.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { recordedInputPath } from '../../tools/validation/paths.js';

const fixture = new URL('./fixtures/user-view-collage/', import.meta.url);
const nativeBytes = await readFile(new URL('native.json', fixture));
const proofBytes = await readFile(new URL('./fixtures/user-view-collage/provenance.json', import.meta.url));
const proof = JSON.parse(proofBytes);
const required = JSON.parse(await readFile(new URL('./fixtures/user-view-collage/required-inputs.json', import.meta.url)));
const native = JSON.parse(nativeBytes), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assets = new MetadataImageAssets({ fileSystem: testFileSystem, stateRoots: [fileURLToPath(fixture)] });
const filenames = names => names.map(name => fileURLToPath(new URL('assets/' + name, fixture)));

test('UserView collage recording preserves actual native inputs, outputs, source and execution identities', async () => {
  assert.equal(hash(proofBytes), required.provenanceSha256);
  for (const value of required.requiredInputs) {
    assert.equal(value.required, true);
    const bytes = await readFile(recordedInputPath(value.path, [value.sha256]));
    assert.equal(bytes.length, value.bytes, value.path); assert.equal(hash(bytes), value.sha256, value.path);
  }
  assert.equal(hash(nativeBytes), proof.nativeSha256);
  assert.equal(native.actualSkiaEncoder, true); assert.equal(native.actualStripCollageBuilder, true);
  assert.equal(native.results.length, 21); assert.equal(proof.process.status, 0); assert.equal(proof.build.status, 0);
  for (const file of proof.files) assert.equal(hash(await readFile(new URL(file.path, fixture))), file.sha256, file.path);
  for (const source of proof.oracleSources) {
    const name = source.filename.replaceAll('\\', '/').split('/').at(-1);
    const file = name === 'Directory.Build.props' ? new URL('../Directory.Build.props', import.meta.url) : new URL(name, fixture);
    assert.equal(hash(await readFile(file)), source.sha256, name);
  }
});

for (const name of ['same', 'large', 'wide', 'alpha', 'skip', 'empty', 'invalid']) {
  test(`UserView thumbnail exact native bitmap pixels: ${name}`, async () => {
    const row = native.results.find(value => value.sample.Name === name);
    const output = await composeUserViewCollage(filenames(row.sample.Paths), row.sample.Text, { assets });
    const image = await loadImage(output), canvas = createCanvas(image.width, image.height);
    canvas.getContext('2d').drawImage(image, 0, 0);
    assert.deepEqual({ Width: image.width, Height: image.height, pixelHash: hash(canvas.data()) },
      { Width: row.output.Width, Height: row.output.Height, pixelHash: row.output.pixelHash });
  });
}

test('UserView thumbnail decoder preserves directory and multi-frame errors before saving', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mm-view-collage-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('mm-view-collage-')); await rm(root, { recursive: true });
  });
  const directory = path.join(root, 'directory.png'); await mkdir(directory);
  const scoped = new MetadataImageAssets({ fileSystem: testFileSystem, stateRoots: [root] });
  await assert.rejects(composeUserViewCollage([directory], 'Movies', { assets: scoped }), /File not found/);
  await assert.rejects(composeUserViewCollage(filenames(['static.gif']), 'Movies', { assets }),
    { message: native.results.find(value => value.sample.Name === 'gif').error.Message });
});
