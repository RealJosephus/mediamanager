import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity, removeOwned, tree } from '../../tools/release/materials.js';
import { nativeAggregateSourceMaterials } from '../../tools/release/native-aggregate-sources.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), relative = 'tools/release/source-materials';

async function fixture(t) {
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'native-aggregate-materials-'));
  t.after(() => removeOwned(parent, directory));
  const target = path.join(directory, relative); await mkdir(target, { recursive: true });
  for (const name of ['source-offer.json', 'recipe-fragments.json', 'recipes', 'native-full-sources.json', 'native-packages.json', 'native-aggregate-sources']) {
    await cp(path.join(root, relative, name), path.join(target, name), { recursive: true });
  }
  const offerFile = path.join(target, 'source-offer.json'), offer = JSON.parse(await readFile(offerFile, 'utf8'));
  const catalogFile = path.join(target, offer.nativeAggregateSources.path), catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  const state = { target, directory, catalog,
    source(name) { return catalog.components.find(source => source.name === name); },
    async save(pin, contents) {
      const filename = path.join(target, pin.path); await writeFile(filename, contents);
      Object.assign(pin, await fileIdentity(filename));
    },
    async saveJson(pin, value) { await state.save(pin, JSON.stringify(value)); },
    async saveCatalog() {
      await writeFile(catalogFile, JSON.stringify(catalog));
      Object.assign(offer.nativeAggregateSources, await fileIdentity(catalogFile));
      await writeFile(offerFile, JSON.stringify(offer));
    },
    async replaceArchive(source, contents) {
      await state.save(source.archive, contents);
      const http = JSON.parse(await readFile(path.join(target, source.httpReceipt.path), 'utf8'));
      Object.assign(http, { bytes: source.archive.bytes, sha256: source.archive.sha256 });
      await state.saveJson(source.httpReceipt, http);
      await state.saveCatalog();
    },
    async consume() { return await nativeAggregateSourceMaterials(directory, await tree(directory, relative)); },
  };
  return state;
}

test('all nineteen actual POSIX native inputs and notices are complete and Ultra HDR patches apply to its real 2.0.2 source', async t => {
  const state = await fixture(t), result = await state.consume();
  assert.equal(state.catalog.components.length, 19);
  assert.deepEqual(result.preparedPatch.map(file => file.path).sort(), ['CMakeLists.txt', 'cmake/package.cmake']);
  assert.ok(result.preparedPatch.every(file => file.bytes > 0 && /^[a-f0-9]{64}$/u.test(file.sha256)));
  assert.deepEqual(await readdir(path.join(state.directory, '.test-output')), []);
});

test('repinning the catalog cannot omit a native input selected by the actual POSIX producer', async t => {
  const state = await fixture(t); state.catalog.components = state.catalog.components.filter(source => source.name !== 'fontconfig');
  await state.saveCatalog();
  await assert.rejects(state.consume(), /Selected native aggregate source set is incomplete/u);
});

test('the original libvips prerelease URL form remains bound to its actual held source URL', async t => {
  const state = await fixture(t), filename = path.join(state.target, 'native-full-sources.json');
  const full = JSON.parse(await readFile(filename, 'utf8'));
  full.sources.find(source => source.name === 'vips').archive.url = 'https://example.invalid/vips-8.18.6.tar.xz';
  await writeFile(filename, JSON.stringify(full));
  const offerFile = path.join(state.target, 'source-offer.json'), offer = JSON.parse(await readFile(offerFile, 'utf8'));
  Object.assign(offer.nativeFullSources, await fileIdentity(filename)); await writeFile(offerFile, JSON.stringify(offer));
  await assert.rejects(state.consume(), /actual recipe selection: vips/u);
});

test('the POSIX source group cannot claim another platform or Windows native closure', async t => {
  const state = await fixture(t); state.catalog.profiles.push('win32-x64'); await state.saveCatalog();
  await assert.rejects(state.consume(), /actual declared POSIX scope/u);
});

test('the Windows AOM declaration cannot replace the actual POSIX AOM version', async t => {
  const state = await fixture(t); state.source('aom').version = '3.14.1'; await state.saveCatalog();
  await assert.rejects(state.consume(), /actual original version recipe: aom/u);
});

test('a different Skia dependency source cannot replace the exact Sharp source URL', async t => {
  const state = await fixture(t); state.source('freetype').archive.url = 'https://skia.googlesource.com/third_party/freetype2/+archive/264b5fbf5b912b39f98d038bf75d39be0a73f21b.tar.gz';
  await state.saveCatalog();
  await assert.rejects(state.consume(), /actual original version recipe: freetype/u);
});

test('an acquired URL alone cannot replace the held original Git identity or published checksum proof', async t => {
  const state = await fixture(t); delete state.source('pixman').git; await state.saveCatalog();
  await assert.rejects(state.consume(), /original source identity proof is missing: pixman/u);
});

test('repinning changed archive bytes cannot bypass the checksum in the original MXE source recipe', async t => {
  const state = await fixture(t), source = state.source('archive');
  const raw = await readFile(path.join(state.target, source.archive.path)); raw[1000] ^= 1;
  await state.replaceArchive(source, raw);
  await assert.rejects(state.consume(), /original recipe checksum: archive/u);
});

test('repinning an exact-size AOM container cannot bypass its original published Google object checksum', async t => {
  const state = await fixture(t), source = state.source('aom');
  const raw = await readFile(path.join(state.target, source.archive.path)); raw[1000] ^= 1;
  await state.replaceArchive(source, raw);
  await assert.rejects(state.consume(), /original published object checksum/u);
});

test('a repinned Git tree cannot omit source from the actual original commit tree', async t => {
  const state = await fixture(t), source = state.source('cgif');
  const tree = JSON.parse(await readFile(path.join(state.target, source.git.treeReceipt.path), 'utf8'));
  tree.tree = tree.tree.filter(member => member.path !== 'src/cgif.c');
  await state.saveJson(source.git.treeReceipt, tree); await state.saveCatalog();
  await assert.rejects(state.consume(), /original Git tree identity changed/u);
});

test('an upstream Git commit object remains independently bound to the Fontconfig source tree', async t => {
  const state = await fixture(t), source = state.source('fontconfig');
  const original = await readFile(path.join(state.target, source.git.commitObject.path)); original[original.length - 2] ^= 1;
  await state.save(source.git.commitObject, original); await state.saveCatalog();
  await assert.rejects(state.consume(), /original Git commit changed: fontconfig/u);
});

test('Fontconfig export omissions retain the original wildcard and directory attribute scope', async t => {
  const state = await fixture(t), source = state.source('fontconfig');
  source.git.exportedOut = source.git.exportedOut.filter(name => name !== '.gitlab-ci/build.py'); await state.saveCatalog();
  await assert.rejects(state.consume(), /export omissions differ from original attributes/u);
});

test('published Git export omissions must be justified by the original attribute file', async t => {
  const state = await fixture(t), source = state.source('zlib-ng');
  await state.save(source.git.exportAttributes, '*.c export-ignore\n'); await state.saveCatalog();
  await assert.rejects(state.consume(), /original export attributes changed/u);
});

test('a catalog cannot classify an arbitrary source file as absent from the published Git export', async t => {
  const state = await fixture(t), source = state.source('mozjpeg'); source.git.exportedOut.push('jcapimin.c');
  await state.saveCatalog();
  await assert.rejects(state.consume(), /export omissions differ from original attributes/u);
});

test('the TIFF PowerShell export conversion remains bound to the original upstream attribute', async t => {
  const state = await fixture(t), source = state.source('tiff'), pin = source.git.exportAttributes;
  const original = await readFile(path.join(state.target, pin.path), 'utf8');
  await state.save(pin, original.replace('*.ps1 text eol=crlf', '*.ps1 text eol=lf')); await state.saveCatalog();
  await assert.rejects(state.consume(), /original export attributes changed/u);
});

test('a repinned TIFF source blob cannot change the original LF bytes behind its published CRLF export', async t => {
  const state = await fixture(t), pin = state.source('tiff').git.exportConversions[0].originalBlob;
  const original = await readFile(path.join(state.target, pin.path)); original[100] ^= 1;
  await state.save(pin, original); await state.saveCatalog();
  await assert.rejects(state.consume(), /original Git source blob changed during export conversion/u);
});

test('an arbitrary TIFF source path cannot claim the PowerShell export transformation', async t => {
  const state = await fixture(t); state.source('tiff').git.exportConversions[0].member = 'libtiff/tif_read.c'; await state.saveCatalog();
  await assert.rejects(state.consume(), /export conversion differs from its original attributes/u);
});

test('an original notice cannot disappear by repinning the source catalog', async t => {
  const state = await fixture(t); state.source('lcms').notices.pop(); await state.saveCatalog();
  await assert.rejects(state.consume(), /original notice set is incomplete: lcms/u);
});

test('a separately readable notice must remain the actual bytes in its complete original container', async t => {
  const state = await fixture(t), notice = state.source('aom').notices[0];
  await state.save(notice, Buffer.concat([await readFile(path.join(state.target, notice.path)), Buffer.from('\nChanged notice.\n')]));
  await state.saveCatalog();
  await assert.rejects(state.consume(), /original notice differs from its archive member/u);
});

test('both original Ultra HDR PR commits are required in their actual order', async t => {
  const state = await fixture(t); state.catalog.ultrahdrPatch.commits.pop(); await state.saveCatalog();
  await assert.rejects(state.consume(), /original ordered PR commits/u);
});

test('a repinned mutable PR response must still agree with the immutable individual commit diffs', async t => {
  const state = await fixture(t), patch = state.catalog.ultrahdrPatch;
  const original = await readFile(path.join(state.target, patch.currentResponse.path), 'utf8');
  await state.save(patch.currentResponse, original.replace('+    set(ARCH aarch64)', '+    set(ARCH replaced)'));
  const http = JSON.parse(await readFile(path.join(state.target, patch.httpReceipt.path), 'utf8'));
  Object.assign(http, { bytes: patch.currentResponse.bytes, sha256: patch.currentResponse.sha256 });
  await state.saveJson(patch.httpReceipt, http); await state.saveCatalog();
  await assert.rejects(state.consume(), /diff differs from its immutable commit patch/u);
});

test('an Ultra HDR commit patch cannot be exchanged for a different source edit', async t => {
  const state = await fixture(t), patch = state.catalog.ultrahdrPatch.commits[0];
  const original = await readFile(path.join(state.target, patch.path), 'utf8');
  await state.save(patch, original.replace('diff --git a/CMakeLists.txt', 'diff --git a/OtherSource.txt')); await state.saveCatalog();
  await assert.rejects(state.consume(), /diff differs from its immutable commit patch/u);
});

test('the actual recipe inline edit cannot become a different current source modification', async t => {
  const state = await fixture(t); state.catalog.ultrahdrPatch.inlineEdit = "sed -i'.bak' 's/TRUE/FALSE/' CMakeLists.txt";
  await state.saveCatalog();
  await assert.rejects(state.consume(), /actual native recipe/u);
});
