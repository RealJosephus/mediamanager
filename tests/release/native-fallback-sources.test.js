import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileIdentity, removeOwned, tree } from '../../tools/release/materials.js';
import { nativeFallbackSourceMaterials } from '../../tools/release/native-fallback-sources.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), relative = 'tools/release/source-materials';

async function fixture(t) {
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'native-fallback-materials-'));
  t.after(() => removeOwned(parent, directory));
  const target = path.join(directory, relative); await mkdir(target, { recursive: true });
  for (const name of ['source-offer.json', 'native-full-sources.json', 'native-full-sources/glib/members.json', 'native-fallback-sources',
    'recipe-fragments.json', 'recipes/sharp-libvips/build/posix.sh']) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await cp(path.join(root, relative, name), path.join(target, name), { recursive: true });
  }
  const offerFile = path.join(target, 'source-offer.json'), offer = JSON.parse(await readFile(offerFile, 'utf8'));
  const catalogFile = path.join(target, offer.nativeFullSources.path), catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  return { target, catalog, source: catalog.fallbacks[0], async saveCatalog() {
    await writeFile(catalogFile, JSON.stringify(catalog));
    Object.assign(offer.nativeFullSources, await fileIdentity(catalogFile));
    await writeFile(offerFile, JSON.stringify(offer));
  }, async consume() { await nativeFallbackSourceMaterials(directory, await tree(directory, relative)); } };
}

test('complete gvdb source and original notices match the exact fallback in the original GLib wrap', async t => {
  const state = await fixture(t); await state.consume();
});

test('repinning the catalog cannot omit the fallback selected by the actual native recipe', async t => {
  const state = await fixture(t); state.catalog.fallbacks.length = 0;
  state.catalog.sources.find(source => source.name === 'glib').modifications.posix.originalRegion = '';
  await state.saveCatalog();
  await assert.rejects(state.consume(), /fallback source set is incomplete/u);
});

test('a replacement wrap must still match the original pristine GLib archive member', async t => {
  const state = await fixture(t), filename = path.join(state.target, state.source.wrap.path);
  await writeFile(filename, (await readFile(filename, 'utf8')).replace('depth=1', 'depth=2'));
  Object.assign(state.source.wrap, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /wrap differs from its original library archive/u);
});

test('a repinned recursive tree cannot drop a source directory from the original commit', async t => {
  const state = await fixture(t), filename = path.join(state.target, state.source.treeReceipt.path);
  const members = JSON.parse(await readFile(filename, 'utf8'));
  await writeFile(filename, JSON.stringify(members.filter(member => member.path !== 'gvdb/tests')));
  Object.assign(state.source.treeReceipt, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /original Git tree identity changed/u);
});

test('repinned published archive members must still have their original Git source identities', async t => {
  const state = await fixture(t), source = state.source;
  const archiveFile = path.join(state.target, source.archive.path), raw = gunzipSync(await readFile(archiveFile));
  const offset = raw.indexOf(Buffer.from(source.root + 'README.md\0')); assert.notEqual(offset, -1);
  const start = offset + 512;
  raw[start] ^= 1;
  await writeFile(archiveFile, gzipSync(raw)); Object.assign(source.archive, await fileIdentity(archiveFile));
  const memberFile = path.join(state.target, source.members.path), members = JSON.parse(await readFile(memberFile, 'utf8'));
  const readme = members.find(member => member.path === source.root + 'README.md');
  readme.sha256 = createHash('sha256').update(raw.subarray(start, start + readme.bytes)).digest('hex');
  await writeFile(memberFile, JSON.stringify(members)); Object.assign(source.members, await fileIdentity(memberFile));
  await state.saveCatalog();
  await assert.rejects(state.consume(), /archive differs from its original Git blob/u);
});

test('separately supplied fallback notices preserve their original archive bytes', async t => {
  const state = await fixture(t), notice = state.source.notices[0], filename = path.join(state.target, notice.path);
  await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nReplacement notice.\n')]));
  Object.assign(notice, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /original notice differs from its archive member/u);
});

test('the original SPDX license directory cannot be omitted from the supplied fallback notice set', async t => {
  const state = await fixture(t); state.source.notices.pop(); await state.saveCatalog();
  await assert.rejects(state.consume(), /original notice set is incomplete/u);
});
