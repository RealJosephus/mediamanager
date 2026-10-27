import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity, removeOwned, tree } from '../../tools/release/materials.js';
import { skiaDependencySourceMaterials } from '../../tools/release/skia-dependency-sources.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), relative = 'tools/release/source-materials';

async function fixture(t, { archives = false } = {}) {
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'skia-dependency-materials-')); t.after(() => removeOwned(parent, directory));
  const target = path.join(directory, relative); await mkdir(target, { recursive: true });
  for (const name of ['source-offer.json', 'native-packages.json', 'skia-sources.json', 'skia-sources/build-files',
    'recipes/canvas/scripts/build-skia.js', 'skia-dependency-sources.json', 'skia-dependency-sources']) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await cp(path.join(root, relative, name), path.join(target, name), { recursive: true,
      filter: filename => archives || !filename.endsWith('.tar.gz') });
  }
  const offerFile = path.join(target, 'source-offer.json'), offer = JSON.parse(await readFile(offerFile, 'utf8'));
  const catalogFile = path.join(target, offer.skiaDependencySources.path), catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  return { target, catalog, async saveCatalog() {
    await writeFile(catalogFile, JSON.stringify(catalog)); Object.assign(offer.skiaDependencySources, await fileIdentity(catalogFile));
    await writeFile(offerFile, JSON.stringify(offer));
  }, async consume() { return await skiaDependencySourceMaterials(directory, await tree(directory, relative)); } };
}

test('selected native codec/text source containers preserve complete original Git source and notices', async t => {
  const state = await fixture(t, { archives: true }); await state.consume();
});

test('a selected native source cannot be omitted by repinning its local source catalog', async t => {
  const state = await fixture(t); state.catalog.components.pop(); await state.saveCatalog();
  await assert.rejects(state.consume(), /dependency source set is incomplete/u);
});

test('a dependency cannot use another revision instead of the actual Skia DEPS identity', async t => {
  const state = await fixture(t); state.catalog.components[0].candidate.commit = '0'.repeat(40); await state.saveCatalog();
  await assert.rejects(state.consume(), /original DEPS repository or revision/u);
});

test('the retained dependency commit object must have its actual original Git identity', async t => {
  const state = await fixture(t), source = state.catalog.components[0], filename = path.join(state.target, source.commitObject.path);
  await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nChanged source object.\n')]));
  Object.assign(source.commitObject, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /original Git commit changed/u);
});

test('nested source gitlinks remain original identities rather than supplied or rewritten nested source', async t => {
  const state = await fixture(t); state.catalog.components.find(source => source.name === 'libjxl').gitlinks.pop(); await state.saveCatalog();
  await assert.rejects(state.consume(), /original nested gitlinks changed/u);
});

test('original dependency notices cannot be dropped from the readable source offer', async t => {
  const state = await fixture(t); state.catalog.components[0].notices.pop(); await state.saveCatalog();
  await assert.rejects(state.consume(), /original notice set is incomplete/u);
});
