import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity, removeOwned, tree } from '../../tools/release/materials.js';
import { rsvgWindowsSourceMaterials } from '../../tools/release/rsvg-windows-sources.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), relative = 'tools/release/source-materials';

async function fixture(t) {
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'rsvg-windows-materials-')); t.after(() => removeOwned(parent, directory));
  const target = path.join(directory, relative); await mkdir(target, { recursive: true });
  const offer = JSON.parse(await readFile(path.join(root, relative, 'source-offer.json'), 'utf8'));
  const catalog = JSON.parse(await readFile(path.join(root, relative, 'rsvg-windows-sources.json'), 'utf8'));
  const originalFull = catalog.inputBindings.find(binding => binding.original.path === 'native-full-sources.json');
  const full = JSON.parse(await readFile(path.join(root, relative, originalFull.supplied.path), 'utf8'));
  const names = new Set(['source-offer.json', 'rsvg-windows-sources.json', offer.rsvgCargoSources.path, offer.canvasCargoSources.path,
    full.sources.find(source => source.name === 'rsvg').members.path]);
  const add = pin => names.add(pin.path);
  [catalog.runReceipt, catalog.jobReceipt, catalog.captureReceipt, catalog.instructions].forEach(add);
  catalog.producer.forEach(add); catalog.producerTrees.forEach(tree => add(tree.object));
  catalog.inputBindings.forEach(binding => add(binding.supplied)); catalog.pristine.forEach(add); catalog.effective.forEach(add); catalog.logs.forEach(add);
  for (const source of catalog.crates) { add(source.archive); if (source.registry) add(source.registry.receipt); source.notices.forEach(add); }
  for (const name of names) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true }); await cp(path.join(root, relative, name), path.join(target, name));
  }
  const offerFile = path.join(target, 'source-offer.json'), catalogFile = path.join(target, 'rsvg-windows-sources.json');
  const saveCatalog = async () => {
    await writeFile(catalogFile, JSON.stringify(catalog)); offer.rsvgWindowsSources = { path: 'rsvg-windows-sources.json', ...await fileIdentity(catalogFile) };
    await writeFile(offerFile, JSON.stringify(offer));
  };
  await saveCatalog();
  return { target, catalog, saveCatalog, async consume() { return await rsvgWindowsSourceMaterials(directory, await tree(directory, relative)); } };
}

test('actual Windows source graph and independently applied effective patch preserve selected original inputs', async t => {
  const state = await fixture(t); await state.consume();
});

test('effective source cannot replace the actual result of the original Windows patch', async t => {
  const state = await fixture(t), source = state.catalog.effective.find(source => source.upstreamPath === 'rsvg/Cargo.toml');
  const filename = path.join(state.target, source.path);
  await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\n# Unbound effective source.\n')]));
  Object.assign(source, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /differs from its original applied patch/u);
});

test('actual source producer blobs remain bound to their original candidate Git trees', async t => {
  const state = await fixture(t), source = state.catalog.producer.find(source => source.upstreamPath.endsWith('capture-rsvg-windows-sources.js'));
  const filename = path.join(state.target, source.path);
  await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\n// Unbound producer source.\n')]));
  Object.assign(source, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /producer original Git blob changed/u);
});

test('a selected Windows registry source cannot be omitted after local source catalog repinning', async t => {
  const state = await fixture(t); state.catalog.crates = state.catalog.crates.filter(source => source.name !== 'windows-sys'); await state.saveCatalog();
  await assert.rejects(state.consume(), /library source set is incomplete/u);
});
