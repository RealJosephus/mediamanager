import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity, removeOwned, tree } from '../../tools/release/materials.js';
import { canvasCurrentGraphMaterials } from '../../tools/release/canvas-current-graphs.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), relative = 'tools/release/source-materials';

async function fixture(t) {
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'canvas-current-graphs-')); t.after(() => removeOwned(parent, directory));
  const target = path.join(directory, relative); await mkdir(target, { recursive: true });
  const offer = JSON.parse(await readFile(path.join(root, relative, 'source-offer.json'), 'utf8'));
  const catalog = JSON.parse(await readFile(path.join(root, relative, offer.canvasCurrentGraphs.path), 'utf8'));
  const supplied = JSON.parse(await readFile(path.join(root, relative, offer.canvasCargoSources.path), 'utf8'));
  const names = new Set(['source-offer.json', offer.canvasCurrentGraphs.path, offer.nativePackages.path, offer.canvasCargoSources.path, catalog.instructions.path]);
  const add = pin => names.add(pin.path);
  add(catalog.runReceipt); add(catalog.jobsReceipt); add(catalog.artifactsReceipt);
  for (const source of catalog.producerTrees) add(source.object);
  for (const file of catalog.producer) add(file);
  for (const input of catalog.inputBindings) add(input.supplied);
  for (const graph of catalog.graphs) { add(graph.archive); for (const member of graph.members) add(member); }
  for (const name of names) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true }); await cp(path.join(root, relative, name), path.join(target, name));
  }
  const offerFile = path.join(target, 'source-offer.json'), catalogFile = path.join(target, offer.canvasCurrentGraphs.path);
  const saveCatalog = async () => {
    await writeFile(catalogFile, JSON.stringify(catalog)); Object.assign(offer.canvasCurrentGraphs, await fileIdentity(catalogFile));
    await writeFile(offerFile, JSON.stringify(offer));
  };
  return { target, catalog, supplied, offer, saveCatalog, async saveSupplied() {
    const filename = path.join(target, offer.canvasCargoSources.path);
    await writeFile(filename, JSON.stringify(supplied)); Object.assign(offer.canvasCargoSources, await fileIdentity(filename)); await saveCatalog();
  }, async consume() { return await canvasCurrentGraphMaterials(directory, await tree(directory, relative)); } };
}

test('three actual current Canvas host/target graphs preserve original ZIPs and cover the supplied Rust containers', async t => {
  const state = await fixture(t); assert.equal((await state.consume()).selectedRegistrySources, 84);
});

test('a current graph cannot disappear because another target happens to select the same sources', async t => {
  const state = await fixture(t); state.catalog.graphs = state.catalog.graphs.filter(graph => graph.runner !== 'ubuntu-24.04'); await state.saveCatalog();
  await assert.rejects(state.consume(), /actual profile\/input group is incomplete/u);
});

test('repinning an original ZIP cannot bypass its original API digest', async t => {
  const state = await fixture(t), graph = state.catalog.graphs[0], filename = path.join(state.target, graph.archive.path);
  const bytes = await readFile(filename); bytes[0] ^= 1; await writeFile(filename, bytes);
  Object.assign(graph.archive, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /ZIP differs from its original API digest/u);
});

test('a separate repinned receipt cannot replace the actual original artifact member', async t => {
  const state = await fixture(t), member = state.catalog.graphs[0].members.find(file => file.member === 'receipt.json');
  const filename = path.join(state.target, member.path), receipt = JSON.parse(await readFile(filename, 'utf8')); receipt.selected.pop();
  await writeFile(filename, JSON.stringify(receipt)); Object.assign(member, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /artifact member bytes changed/u);
});

test('current coverage requires the actual selected container after an equivalent catalog is reserialized', async t => {
  const state = await fixture(t); await state.saveSupplied(); await state.consume();
  state.supplied.crates = state.supplied.crates.filter(source => source.name !== 'infer'); await state.saveSupplied();
  await assert.rejects(state.consume(), /selected source is absent/u);
});
