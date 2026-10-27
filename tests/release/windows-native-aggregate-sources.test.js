import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity, removeOwned, tree } from '../../tools/release/materials.js';
import { windowsNativeAggregateSourceMaterials } from '../../tools/release/windows-native-aggregate-sources.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), relative = 'tools/release/source-materials';

async function fixture(t) {
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'windows-native-materials-')); t.after(() => removeOwned(parent, directory));
  const target = path.join(directory, relative); await mkdir(target, { recursive: true });
  for (const name of ['source-offer.json', 'recipe-fragments.json', 'recipes', 'native-full-sources.json', 'native-full-sources',
    'native-packages.json', 'native-aggregate-sources', 'sharp-native-components', 'sharp-native-notices/platforms/windows/versions.json', 'windows-native-aggregate-sources']) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await cp(path.join(root, relative, name), path.join(target, name), { recursive: true });
  }
  const offerFile = path.join(target, 'source-offer.json'), offer = JSON.parse(await readFile(offerFile, 'utf8'));
  const filename = path.join(target, 'windows-native-aggregate-sources/catalog.json'), catalog = JSON.parse(await readFile(filename, 'utf8'));
  const state = { directory, target, catalog, offer,
    source(name) { return catalog.sources.find(source => source.packages.includes(name)); },
    async save(pin, bytes) {
      const filename = path.join(target, pin.path); await writeFile(filename, bytes); Object.assign(pin, await fileIdentity(filename));
    },
    async saveCatalog() {
      await writeFile(filename, JSON.stringify(catalog));
      offer.windowsNativeAggregateSources = { path: 'windows-native-aggregate-sources/catalog.json', ...await fileIdentity(filename) };
      await writeFile(offerFile, JSON.stringify(offer));
    },
    async consume() { return await windowsNativeAggregateSourceMaterials(directory, await tree(directory, relative)); },
  };
  await state.saveCatalog(); return state;
}

test('the actual Windows static native graph is supplied by all 28 original containers and 16 original patches', async t => {
  const state = await fixture(t), result = await state.consume();
  assert.equal(result.selectedNativeNodes, 29); assert.equal(result.suppliedContainers, 28); assert.equal(result.selectedOriginalPatches, 16);
  assert.equal(state.catalog.sources.filter(source => source.origin).length, 20);
  assert.deepEqual(await readdir(path.join(state.directory, '.test-output')), []);
});

test('repinning the catalog cannot omit the actual Windows AOM container', async t => {
  const state = await fixture(t); state.catalog.sources = state.catalog.sources.filter(source => !source.packages.includes('aom')); await state.saveCatalog();
  await assert.rejects(state.consume(), /actual selected Windows native source container set is incomplete/iu);
});

test('the POSIX AOM version cannot replace the Windows original source through a reuse declaration', async t => {
  const state = await fixture(t), source = state.source('aom');
  source.origin = { catalog: 'native-aggregate-sources/catalog.json', name: 'aom' }; await state.saveCatalog();
  await assert.rejects(state.consume(), /actually held original container/u);
});

test('repinning an altered original graph ZIP cannot bypass its original Actions API digest', async t => {
  const state = await fixture(t), pin = state.catalog.graph.archive;
  const raw = await readFile(path.join(state.target, pin.path)); raw[100] ^= 1;
  await state.save(pin, raw); await state.saveCatalog();
  await assert.rejects(state.consume(), /actual successful CI source/u);
});

test('a repinned copied graph receipt must remain the original member of the original ZIP', async t => {
  const state = await fixture(t), pin = state.catalog.graph.members.find(member => member.member.endsWith('/receipt.json'));
  const receipt = JSON.parse(await readFile(path.join(state.target, pin.path), 'utf8')); receipt.selected.pop();
  await state.save(pin, JSON.stringify(receipt)); await state.saveCatalog();
  await assert.rejects(state.consume(), /member differs from its original ZIP/u);
});

test('selected original patches cannot be replaced by repinning the copied graph member', async t => {
  const state = await fixture(t), pin = state.catalog.graph.members.find(member => member.member.endsWith('/aom-3-fixes.patch'));
  const raw = await readFile(path.join(state.target, pin.path)); raw[raw.length - 2] ^= 1;
  await state.save(pin, raw); await state.saveCatalog();
  await assert.rejects(state.consume(), /member differs from its original ZIP/u);
});

test('FreeType original permission text remains separately supplied with its selected complete source', async t => {
  const state = await fixture(t), source = state.source('freetype');
  assert.ok(source.notices.some(notice => notice.member.toLowerCase().endsWith('/ftl.txt')));
  source.notices = source.notices.filter(notice => !notice.member.toLowerCase().endsWith('/ftl.txt')); await state.saveCatalog();
  await assert.rejects(state.consume(), /original notice set is incomplete/u);
});

test('a readable original native notice remains identical to its complete archive member', async t => {
  const state = await fixture(t), pin = state.source('aom').notices[0];
  await state.save(pin, Buffer.concat([await readFile(path.join(state.target, pin.path)), Buffer.from('\nChanged notice.\n')])); await state.saveCatalog();
  await assert.rejects(state.consume(), /notice differs from its complete archive member/u);
});

test('repinning a changed native archive cannot replace its actual GNU Make source checksum', async t => {
  const state = await fixture(t), pin = state.source('highway').archive;
  const raw = await readFile(path.join(state.target, pin.path)); raw[100] ^= 1;
  await state.save(pin, raw); await state.saveCatalog();
  await assert.rejects(state.consume(), /actual selected container/u);
});

test('a complete native source cannot be reclassified as an empty or unrelated extraction root', async t => {
  const state = await fixture(t); state.source('fontconfig').root = 'unrelated-empty-root/'; await state.saveCatalog();
  await assert.rejects(state.consume(), /actual recipe extraction root/u);
});

test('the current Windows declared versions cannot silently substitute the POSIX AOM version', async t => {
  const state = await fixture(t), nativeFile = path.join(state.target, 'native-packages.json'), native = JSON.parse(await readFile(nativeFile, 'utf8'));
  const pin = native.sharpNativeNotices.platforms.find(platform => platform.platform === 'win32' && platform.architecture === 'x64').versions;
  const values = JSON.parse(await readFile(path.join(state.target, pin.path), 'utf8')); values.aom = '3.15.0';
  await state.save(pin, JSON.stringify(values)); await writeFile(nativeFile, JSON.stringify(native));
  Object.assign(state.offer.nativePackages, await fileIdentity(nativeFile)); await state.saveCatalog();
  await assert.rejects(state.consume(), /current constituent version declarations/u);
});

test('a native source outside the actual captured graph cannot enter through a container alias', async t => {
  const state = await fixture(t); state.source('aom').file = 'unselected-native-1.0.tar.gz'; await state.saveCatalog();
  await assert.rejects(state.consume(), /actual selected container/u);
});

test('repinning producer source bytes cannot change the original CI candidate Git blob', async t => {
  const state = await fixture(t), pin = state.catalog.graph.producer.find(file => file.upstreamPath.endsWith('/capture-windows-native-source-graph.js'));
  await state.save(pin, Buffer.concat([await readFile(path.join(state.target, pin.path)), Buffer.from('\n// Different producer.\n')])); await state.saveCatalog();
  await assert.rejects(state.consume(), /producer source blob changed/u);
});
