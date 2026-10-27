import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity, removeOwned, tree } from '../../tools/release/materials.js';
import { rsvgOriginalNoticeMaterials } from '../../tools/release/rsvg-original-notices.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), relative = 'tools/release/source-materials';

async function fixture(t) {
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'rsvg-original-notices-')); t.after(() => removeOwned(parent, directory));
  const target = path.join(directory, relative); await mkdir(target, { recursive: true });
  const offer = JSON.parse(await readFile(path.join(root, relative, 'source-offer.json'), 'utf8'));
  const catalog = JSON.parse(await readFile(path.join(root, relative, offer.rsvgOriginalNotices.path), 'utf8'));
  const names = new Set(['source-offer.json', offer.rsvgOriginalNotices.path, offer.rsvgCargoSources.path,
    offer.nativePackages.path, catalog.instructions.path, catalog.sourceHeaderTerms.path]);
  const add = pin => names.add(pin.path);
  for (const source of catalog.sources) {
    add(source.archive); add(source.commitReceipt); add(source.treeReceipt); if (source.refReceipt) add(source.refReceipt);
    for (const file of source.notices) { add(file); if (file.blobReceipt) add(file.blobReceipt); }
    for (const file of source.sourceVariations) { add(file.original); add(file.original.blobReceipt); }
  }
  for (const name of names) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await cp(path.join(root, relative, name), path.join(target, name));
  }
  const catalogFile = path.join(target, offer.rsvgOriginalNotices.path), offerFile = path.join(target, 'source-offer.json');
  const saveCatalog = async () => {
    await writeFile(catalogFile, JSON.stringify(catalog)); Object.assign(offer.rsvgOriginalNotices, await fileIdentity(catalogFile));
    await writeFile(offerFile, JSON.stringify(offer));
  };
  return { target, catalog, saveCatalog, async consume() { return await rsvgOriginalNoticeMaterials(directory, await tree(directory, relative)); } };
}

test('original mutants notice, selectors source headers and legacy source declarations retain their exact identities', async t => {
  const state = await fixture(t); await state.consume();
});

test('local repinning cannot change the original root MIT permission bytes', async t => {
  const state = await fixture(t), notice = state.catalog.sources.find(source => source.name === 'mutants').notices[0];
  const filename = path.join(state.target, notice.path), bytes = await readFile(filename); bytes[0] ^= 1;
  await writeFile(filename, bytes); Object.assign(notice, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /Original mutants root MIT notice changed/u);
});

test('selectors cannot drop an actual original MPL source-header notice by repinning the catalog', async t => {
  const state = await fixture(t); state.catalog.sources.find(source => source.name === 'selectors').notices.pop(); await state.saveCatalog();
  await assert.rejects(state.consume(), /MPL source-header notice set is incomplete/u);
});

test('an absent legacy published VCS declaration is not inferred from a matching version tag', async t => {
  const state = await fixture(t); state.catalog.sources.find(source => source.name === 'block').association = 'original-published-vcs-base'; await state.saveCatalog();
  await assert.rejects(state.consume(), /actual published VCS base/u);
});

test('a published manifest difference remains explicit rather than becoming a clean-checkout claim', async t => {
  const state = await fixture(t); state.catalog.sources.find(source => source.name === 'malloc_buf').sourceVariations = []; await state.saveCatalog();
  await assert.rejects(state.consume(), /source member associations are incomplete/u);
});

test('a repinned recursive tree must still retain every original Git subtree identity', async t => {
  const state = await fixture(t), source = state.catalog.sources.find(source => source.name === 'block');
  const filename = path.join(state.target, source.treeReceipt.path), value = JSON.parse(await readFile(filename, 'utf8'));
  value.tree.find(entry => entry.type === 'blob').sha = '0'.repeat(40);
  await writeFile(filename, JSON.stringify(value)); Object.assign(source.treeReceipt, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /Git (?:subtree|complete Git tree) identity changed|complete Git tree identity changed/u);
});
