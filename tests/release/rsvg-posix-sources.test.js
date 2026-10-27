import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity, removeOwned, tree } from '../../tools/release/materials.js';
import { rsvgPosixSourceMaterials } from '../../tools/release/rsvg-posix-sources.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), relative = 'tools/release/source-materials';
const catalogPath = 'rsvg-posix-sources.json';

async function fixture(t) {
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'rsvg-posix-materials-')); t.after(() => removeOwned(parent, directory));
  const target = path.join(directory, relative); await mkdir(target, { recursive: true });
  const offer = JSON.parse(await readFile(path.join(root, relative, 'source-offer.json'), 'utf8'));
  const catalog = JSON.parse(await readFile(path.join(root, relative, catalogPath), 'utf8'));
  offer.rsvgPosixSources = { path: catalogPath, ...await fileIdentity(path.join(root, relative, catalogPath)) };
  const supplied = new Map();
  const names = new Set(['source-offer.json', catalogPath, catalog.instructions.path]);
  const add = pin => names.add(pin.path);
  [catalog.runReceipt, catalog.jobsReceipt, catalog.artifactsReceipt, catalog.producerCommit.object].forEach(add);
  catalog.producerTrees.forEach(entry => add(entry.object)); catalog.producer.forEach(add);
  for (const graph of catalog.graphs) {
    add(graph.archive);
    for (const binding of graph.inputBindings) if (binding.source.kind === 'material') add(binding.source.pin);
  }
  for (const pin of [offer.nativeFullSources, offer.rsvgCargoSources, offer.rsvgWindowsSources, offer.canvasCargoSources]) {
    add(pin); supplied.set(pin.path, JSON.parse(await readFile(path.join(root, relative, pin.path), 'utf8')));
  }
  const library = supplied.get(offer.nativeFullSources.path).sources.find(entry => entry.name === 'rsvg');
  add(library.archive); add(library.members); library.notices.forEach(add);
  for (const origin of catalog.crateOrigins) {
    const source = supplied.get(origin.catalog).crates.find(entry => entry.name === origin.name && entry.version === origin.version);
    add(source.archive); source.notices.forEach(add);
  }
  for (const name of names) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true }); await cp(path.join(root, relative, name), path.join(target, name));
  }
  const offerFile = path.join(target, 'source-offer.json'), catalogFile = path.join(target, catalogPath);
  const saveCatalog = async () => {
    await writeFile(catalogFile, JSON.stringify(catalog)); Object.assign(offer.rsvgPosixSources, await fileIdentity(catalogFile));
    await writeFile(offerFile, JSON.stringify(offer));
  };
  await saveCatalog();
  return { target, catalog, supplied, offer, saveCatalog, async saveSupplied(name) {
    const filename = path.join(target, name); await writeFile(filename, JSON.stringify(supplied.get(name)));
    const pin = [offer.rsvgCargoSources, offer.rsvgWindowsSources, offer.canvasCargoSources].find(entry => entry.path === name);
    Object.assign(pin, await fileIdentity(filename)); await saveCatalog();
  }, async consume() { return await rsvgPosixSourceMaterials(directory, await tree(directory, relative)); } };
}

test('both actual current post-edit POSIX graphs bind original ZIPs and complete selected source/notice members', async t => {
  const state = await fixture(t), result = await state.consume();
  assert.deepEqual(result.profiles, state.catalog.graphs.map(entry => entry.platform));
  assert.equal(result.selectedRegistrySources, state.catalog.crateOrigins.length);
});

test('repinning a POSIX graph ZIP cannot replace its original artifact API digest', async t => {
  const state = await fixture(t), graph = state.catalog.graphs[0], filename = path.join(state.target, graph.archive.path);
  const bytes = await readFile(filename); bytes[0] ^= 1; await writeFile(filename, bytes);
  Object.assign(graph.archive, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /ZIP differs from its original API digest/u);
});

test('an actual POSIX host profile cannot disappear behind another target selection', async t => {
  const state = await fixture(t); state.catalog.graphs.pop(); await state.saveCatalog();
  await assert.rejects(state.consume(), /actual profile or complete selected source group is incomplete/u);
});

test('a selected POSIX source cannot disappear after catalog repinning', async t => {
  const state = await fixture(t); state.catalog.crateOrigins = state.catalog.crateOrigins.filter(entry => entry.name !== 'semver');
  await state.saveCatalog();
  await assert.rejects(state.consume(), /selected original source container is absent/u);
});

test('a repinned selected notice must still equal its complete original package member', async t => {
  const state = await fixture(t), origin = state.catalog.crateOrigins.find(entry => entry.name === 'semver');
  const source = state.supplied.get(origin.catalog).crates.find(entry => entry.name === origin.name && entry.version === origin.version);
  const notice = source.notices[0], filename = path.join(state.target, notice.path);
  await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nUnbound notice change.\n')]));
  Object.assign(notice, await fileIdentity(filename)); await state.saveSupplied(origin.catalog);
  await assert.rejects(state.consume(), /notice differs from its complete original package member/u);
});
