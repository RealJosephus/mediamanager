import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileIdentity, removeOwned, tree } from '../../tools/release/materials.js';
import { canvasCargoSourceMaterials } from '../../tools/release/canvas-cargo-sources.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), relative = 'tools/release/source-materials';

async function fixture(t) {
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'canvas-cargo-materials-')); t.after(() => removeOwned(parent, directory));
  const target = path.join(directory, relative); await mkdir(target, { recursive: true });
  const offer = JSON.parse(await readFile(path.join(root, relative, 'source-offer.json'), 'utf8'));
  const catalog = JSON.parse(await readFile(path.join(root, relative, 'canvas-cargo-sources.json'), 'utf8'));
  const native = JSON.parse(await readFile(path.join(root, relative, offer.nativePackages.path), 'utf8'));
  const names = new Set(['source-offer.json', 'canvas-cargo-sources.json', offer.nativePackages.path, offer.rsvgCargoSources.path,
    native.canvas.files.find(file => file.upstreamPath === catalog.lockFile).path, catalog.instructions.path]);
  const add = pin => names.add(pin.path);
  for (const observation of catalog.observations) { add(observation.jobReceipt); add(observation.archive); }
  for (const source of catalog.crates) {
    add(source.archive); if (source.registry) add(source.registry.receipt); for (const notice of source.notices) add(notice);
  }
  for (const source of catalog.repositoryNotices) {
    add(source.commitReceipt); add(source.treeReceipt); for (const file of source.files) { add(file); add(file.blobReceipt); }
  }
  for (const name of names) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await cp(path.join(root, relative, name), path.join(target, name));
  }
  const offerFile = path.join(target, 'source-offer.json'), catalogFile = path.join(target, 'canvas-cargo-sources.json');
  const saveCatalog = async () => {
    await writeFile(catalogFile, JSON.stringify(catalog)); offer.canvasCargoSources = { path: 'canvas-cargo-sources.json', ...await fileIdentity(catalogFile) };
    await writeFile(offerFile, JSON.stringify(offer));
  };
  await saveCatalog();
  return { target, catalog, saveCatalog, async consume() { return await canvasCargoSourceMaterials(directory, await tree(directory, relative)); } };
}

test('original Canvas build windows and published containers preserve their actual source and notices', async t => {
  const state = await fixture(t); await state.consume();
});

test('an observed source cannot disappear by repinning the local source catalog', async t => {
  const state = await fixture(t); state.catalog.crates = state.catalog.crates.filter(source => source.name !== 'infer'); await state.saveCatalog();
  await assert.rejects(state.consume(), /Actual Canvas Cargo source set is incomplete/u);
});

test('repinning the gzip envelope cannot replace the original producer compile log bytes', async t => {
  const state = await fixture(t), observation = state.catalog.observations[0], filename = path.join(state.target, observation.archive.path);
  const raw = gunzipSync(await readFile(filename)); raw[0] ^= 1;
  await writeFile(filename, gzipSync(raw));
  Object.assign(observation.archive, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /original compile log changed/u);
});

test('the additional actual Windows dependency must retain the exact original source lock checksum', async t => {
  const state = await fixture(t), source = state.catalog.crates.find(source => source.name === 'windows-link');
  const filename = path.join(state.target, source.archive.path), raw = await readFile(filename); raw[9] ^= 1;
  await writeFile(filename, raw); Object.assign(source.archive, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /archive differs from its original lock checksum/u);
});

test('a repository root notice cannot be attributed to another published VCS base', async t => {
  const state = await fixture(t), source = state.catalog.crates.find(source => source.name === 'napi');
  source.repositoryNotice = state.catalog.repositoryNotices.find(notice => notice.repository === 'Nugine/simd').id; await state.saveCatalog();
  await assert.rejects(state.consume(), /repository notice differs from its original published VCS base/u);
});
