import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { fileIdentity, json } from '../../tools/release/materials.js';
import { recombinationInputs, originalInlineEdits, pristineSourceSnapshot, originalPatchForExecution, replaceOnce } from '../../tools/release/native-recombination-linux/inputs.js';
import { imageCases, verifyConsumerPair } from '../../tools/release/native-recombination-linux/verify.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const materials = 'tools/release/source-materials';

function runTar(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('tar', args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

function runGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function fixture(t) {
  const inputs = await recombinationInputs(root);
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const target = await mkdtemp(path.join(parent, 'native-recombination-inputs-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  for (const name of [materials + '/source-offer.json', ...inputs.pins.map(value => value.path)]) {
    const destination = path.join(target, name);
    await mkdir(path.dirname(destination), { recursive: true }); await cp(path.join(root, name), destination);
  }
  return { target, inputs, async changeCatalog(change) {
    const offerFile = path.join(target, materials, 'source-offer.json'), offer = await json(offerFile);
    const filename = path.join(target, materials, offer.nativeFullSources.path), catalog = await json(filename);
    change(catalog); await writeFile(filename, JSON.stringify(catalog));
    Object.assign(offer.nativeFullSources, await fileIdentity(filename)); await writeFile(offerFile, JSON.stringify(offer));
  } };
}

test('the scoped native recombination consumes the complete actually supplied libvips version and original producer inputs', async () => {
  const result = await recombinationInputs(root);
  assert.equal(result.source.version, '8.18.6');
  assert.equal(result.members.filter(value => value.kind === 'file').length, 841);
  assert.deepEqual(result.profile.formats, ['png', 'jpeg', 'webp']);
});

test('a damaged original native source container is rejected before extraction or compilation', async t => {
  const state = await fixture(t), filename = path.join(state.target, materials, state.inputs.source.archive.path);
  const file = await open(filename, 'r+');
  try { const original = Buffer.alloc(1); await file.read(original, 0, 1, 0); original[0] ^= 1; await file.write(original, 0, 1, 0); }
  finally { await file.close(); }
  await assert.rejects(recombinationInputs(state.target), /supplied recombination source input changed/u);
});

test('repinning a source catalog cannot substitute another version for the actual original recipe selection', async t => {
  const state = await fixture(t);
  await state.changeCatalog(catalog => catalog.sources.find(value => value.name === 'vips').version = '8.18.5');
  await assert.rejects(recombinationInputs(state.target), /actual supplied version/u);
});

test('the full original extracted source retains dotted siblings and directory descendants with every file byte bound', async t => {
  const inputs = await recombinationInputs(root), parent = path.join(root, '.test-output');
  await mkdir(parent, { recursive: true });
  const target = await mkdtemp(path.join(parent, 'native-recombination-pristine-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const archive = path.relative(target, path.join(root, materials, inputs.source.archive.path)).split(path.sep).join('/');
  await runTar(['-xf', archive], { cwd: target, maxBuffer: 2 * 1024 * 1024 });
  const sourceRoot = path.join(target, inputs.source.root);
  const snapshot = await pristineSourceSnapshot(sourceRoot, inputs.members, inputs.source.root);
  for (const name of ['libvips/colour/profiles.c', 'libvips/colour/profiles.h', 'libvips/colour/profiles/cmyk.icm']) {
    assert.ok(snapshot.some(value => value.path === name), 'The full original source member must remain present: ' + name);
  }
  const changed = await open(path.join(sourceRoot, 'libvips/colour/profiles.c'), 'r+');
  try { const byte = Buffer.alloc(1); await changed.read(byte, 0, 1, 0); byte[0] ^= 1; await changed.write(byte, 0, 1, 0); }
  finally { await changed.close(); }
  await assert.rejects(pristineSourceSnapshot(sourceRoot, inputs.members, inputs.source.root), /Extracted complete libvips files differ/u);
});

test('repinning a container path cannot allow extraction outside the supplied source root', async t => {
  const state = await fixture(t);
  await state.changeCatalog(catalog => catalog.sources.find(value => value.name === 'vips').archive.path = '../../outside.tar.xz');
  await assert.rejects(recombinationInputs(state.target), /strictly inside/u);
});

test('the original unterminated patch stays immutable while its executable copy actually applies the full source SONAME change and rejects a conflicting version', async t => {
  const inputs = await recombinationInputs(root), parent = path.join(root, '.test-output');
  await mkdir(parent, { recursive: true });
  const target = await mkdtemp(path.join(parent, 'native-recombination-patch-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const archive = path.relative(target, path.join(root, materials, inputs.source.archive.path)).split(path.sep).join('/');
  await runTar(['-xf', archive], { cwd: target, maxBuffer: 2 * 1024 * 1024 });
  const sourceRoot = path.join(target, inputs.source.root);
  await pristineSourceSnapshot(sourceRoot, inputs.members, inputs.source.root);
  const originalPath = path.join(root, materials, inputs.recipe.patch.path), original = await readFile(originalPath);
  const executable = originalPatchForExecution(original), filename = path.join(target, 'soname.execution.patch');
  assert.equal(original.length, inputs.recipe.patch.bytes);
  assert.equal(executable.transformation, 'append-one-terminal-LF');
  assert.equal(executable.bytes.length, original.length + 1);
  assert.ok(executable.bytes.subarray(0, original.length).equals(original));
  assert.equal(executable.bytes.at(-1), 0x0a);
  await writeFile(filename, executable.bytes, { flag: 'wx' });
  // The source regression can run on every validation platform using Git's
  // ordinary file-only applier. The actual Linux build independently uses
  // strict GNU patch and verifies the resulting ELF SONAME before loading it.
  await runGit(['init', '--quiet', sourceRoot]);
  const cpp = path.join(sourceRoot, 'cplusplus/meson.build'), before = await readFile(cpp, 'utf8');
  const expected = replaceOnce(before, '    version: library_version,\n    darwin_versions: darwin_versions,\n',
    '    version: meson.project_version(),\n    soversion: meson.project_version(),\n', 'original producer SONAME');
  const args = ['-c', 'core.autocrlf=false', '-c', 'apply.ignoreWhitespace=no', 'apply', '--whitespace=error-all', filename];
  await runGit(args, { cwd: sourceRoot });
  assert.equal(await readFile(cpp, 'utf8'), expected);
  await writeFile(cpp, before.replace('version: library_version,', "version: '8.18.5',"));
  await assert.rejects(runGit(args, { cwd: sourceRoot }));
  assert.deepEqual(await fileIdentity(originalPath), { bytes: inputs.recipe.patch.bytes, sha256: inputs.recipe.patch.sha256 });
  assert.ok((await readFile(originalPath)).equals(original));
});

test('the compatible build keeps the actual original static aggregate, nodelete and excluded tool edits distinct', async () => {
  const inputs = await recombinationInputs(root), files = {};
  for (const name of ['meson.build', 'libvips/meson.build', 'cplusplus/meson.build']) {
    files[name] = (await runTar(['-xOf', inputs.source.archive.path, inputs.source.root + name], { cwd: path.join(root, materials), maxBuffer: 2 * 1024 * 1024 })).stdout;
  }
  const edits = originalInlineEdits(files);
  assert.match(edits['libvips/meson.build'], /static_library\('vips'/u);
  assert.ok(!edits['libvips/meson.build'].includes('    version: library_version,'));
  assert.match(edits['cplusplus/meson.build'], /link_args: nodelete_link_args/u);
  assert.ok(!edits['meson.build'].includes("subdir('tools')"));
  assert.throws(() => originalInlineEdits({ ...files, 'libvips/meson.build': edits['libvips/meson.build'] }), /no longer unique/u);
});

function pair() {
  const original = { bytes: 100, sha256: 'a'.repeat(64) }, replacement = { bytes: 120, sha256: 'b'.repeat(64) };
  const libraryPath = path.join(os.tmpdir(), 'private-delivery', 'libvips-cpp.so.8.18.6');
  const input = mode => ({ mode, pid: mode === 'stock' ? 101 : 102, candidate: { commit: 'c'.repeat(40), tree: 'd'.repeat(40) },
    dataRoot: path.join(os.tmpdir(), 'native-recombination', mode + '-data'), loadedLibrary: { path: libraryPath, ...(mode === 'stock' ? original : replacement) },
    closed: true, inputs: imageCases.map(value => ({ name: value.name + '.' + value.format, bytes: 99, sha256: 'e'.repeat(64) })),
    bindings: [{ path: path.join(os.tmpdir(), 'private-delivery', 'sharp.node'), bytes: 123, sha256: 'f'.repeat(64) }],
    sourceFiles: [{ path: 'src/images/processor.js', bytes: 42, sha256: '0'.repeat(64) }],
    cases: imageCases.map(fixture => {
      const pixel = [...fixture.rgba]; if (mode === 'modified' && fixture.format === 'png') pixel[0] = Math.min(255, pixel[0] + 7);
      return { name: fixture.name, size: { Width: 5, Height: 4 }, sharp: { info: { width: 5, height: 4, channels: 4 }, pixels: Array.from({ length: 20 }, () => pixel).flat() },
        application: { original: false, mimeType: 'image/png', size: { width: 3, height: 2 }, cacheReadEqual: true,
          path: path.join(os.tmpdir(), 'native-recombination', mode + '-data', 'cache', fixture.name + '.png'), pixels: Array.from({ length: 6 }, () => pixel).flat() } };
    }) });
  return { stock: input('stock'), modified: input('modified'), expected: { original, replacement, libraryPath, redBias: 7 } };
}

test('actual loaded-library and complete public pixel records can establish a scoped recombination result', () => {
  const state = pair(); verifyConsumerPair(state.stock, state.modified, state.expected);
});

test('a changed file beside a still loaded vendor aggregate cannot pass as a replacement', () => {
  const state = pair(); state.modified.loadedLibrary = state.stock.loadedLibrary;
  assert.throws(() => verifyConsumerPair(state.stock, state.modified, state.expected));
});

test('a reused cache or process cannot turn an unexecuted replacement consumer into success', () => {
  const sameCache = pair(); sameCache.modified.dataRoot = sameCache.stock.dataRoot;
  assert.throws(() => verifyConsumerPair(sameCache.stock, sameCache.modified, sameCache.expected), /must not overlap/u);
  const sameProcess = pair(); sameProcess.modified.pid = sameProcess.stock.pid;
  assert.throws(() => verifyConsumerPair(sameProcess.stock, sameProcess.modified, sameProcess.expected), /independent Node/u);
});

test('an absent semantic modification or a wrapped saturated channel is an actual consumer failure', () => {
  const noop = pair(); noop.modified.cases[0].sharp.pixels = noop.stock.cases[0].sharp.pixels;
  assert.throws(() => verifyConsumerPair(noop.stock, noop.modified, noop.expected), /actual PNG\/WebP pixels/u);
  const wrapped = pair(); wrapped.modified.cases[1].sharp.pixels[0] = 3;
  assert.throws(() => verifyConsumerPair(wrapped.stock, wrapped.modified, wrapped.expected), /actual PNG\/WebP pixels/u);
});

test('valid Sharp pixels cannot conceal a stale application image or incomplete owner closure', () => {
  const stale = pair(); stale.modified.cases[0].application.pixels = stale.stock.cases[0].application.pixels;
  assert.throws(() => verifyConsumerPair(stale.stock, stale.modified, stale.expected), /independently decoded application/u);
  const unclosed = pair(); unclosed.modified.closed = false;
  assert.throws(() => verifyConsumerPair(unclosed.stock, unclosed.modified, unclosed.expected), /owners must close/u);
});
