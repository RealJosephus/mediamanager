import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity, removeOwned } from '../../tools/release/materials.js';
import { windowsNativeBuildInputs } from '../../tools/release/windows-native-build-inputs.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), relative = 'tools/release/source-materials';

async function fixture(t) {
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'windows-native-inputs-'));
  t.after(() => removeOwned(parent, directory));
  const target = path.join(directory, relative); await mkdir(target, { recursive: true });
  for (const name of ['source-offer.json', 'recipe-fragments.json', 'recipes', 'windows-native-aggregate-sources']) {
    await cp(path.join(root, relative, name), path.join(target, name), { recursive: true });
  }
  const filename = path.join(target, 'windows-native-aggregate-sources/build-inputs.json'), catalog = JSON.parse(await readFile(filename, 'utf8'));
  return { target, directory, catalog, source(name) { return catalog.sources.find(source => source.name === name); },
    async save() { await writeFile(filename, JSON.stringify(catalog)); },
    async change(pin, bytes) {
      const filename = path.join(target, pin.path); await writeFile(filename, bytes); Object.assign(pin, await fileIdentity(filename));
    },
    async consume() { return await windowsNativeBuildInputs(directory); },
  };
}

test('complete current MXE base and original producer source preserve the actual Sharp static dependency profile', async t => {
  const state = await fixture(t), result = await state.consume();
  assert.equal(result.catalog.target, 'x86_64-w64-mingw32.static');
  assert.equal(result.captures.size, 2);
  assert.match(result.captures.get('build-win64-mxe').get('build/vips.mk').toString('utf8'), /--default-library=shared/u);
  assert.match(result.sharpInput.path, /build\/win\.sh$/u);
});

test('an outer shared DLL cannot reclassify the actual MXE target as the shared dependency variant', async t => {
  const state = await fixture(t); state.catalog.target = 'x86_64-w64-mingw32.shared'; await state.save();
  await assert.rejects(state.consume(), /actual Sharp static-dependency input/u);
});

test('a repinned source catalog cannot omit the original producer repository', async t => {
  const state = await fixture(t); state.catalog.sources = state.catalog.sources.filter(source => source.name !== 'build-win64-mxe'); await state.save();
  await assert.rejects(state.consume(), /actual Sharp static-dependency input/u);
});

test('a current compatible base source cannot be attributed to another original branch', async t => {
  const state = await fixture(t); state.source('mxe').reference = 'master'; await state.save();
  await assert.rejects(state.consume(), /original repository identity/u);
});

test('repinning an incomplete recursive tree does not change its original Git identity', async t => {
  const state = await fixture(t), source = state.source('mxe');
  const tree = JSON.parse(await readFile(path.join(state.target, source.treeReceipt.path), 'utf8'));
  tree.tree = tree.tree.filter(member => member.path !== 'src/freetype.mk');
  await state.change(source.treeReceipt, JSON.stringify(tree)); await state.save();
  await assert.rejects(state.consume(), /original Git tree identity changed/u);
});

test('the complete producer archive must include each original recipe source member', async t => {
  const state = await fixture(t), source = state.source('build-win64-mxe');
  const members = JSON.parse(await readFile(path.join(state.target, source.members.path), 'utf8'));
  await state.change(source.members, JSON.stringify(members.filter(member => !member.path.endsWith('/build/vips.mk')))); await state.save();
  await assert.rejects(state.consume(), /complete source membership is incomplete/u);
});

test('the original MXE notice remains separately available with its source', async t => {
  const state = await fixture(t); state.source('mxe').notices.length = 0; await state.save();
  await assert.rejects(state.consume(), /original notice set is incomplete/u);
});

test('tool boundaries cannot silently expand into arbitrary excluded native dependencies', async t => {
  const state = await fixture(t); state.catalog.toolBoundaries.push('glib'); await state.save();
  await assert.rejects(state.consume(), /actual Sharp static-dependency input/u);
});
