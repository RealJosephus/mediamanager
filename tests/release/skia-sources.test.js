import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity, removeOwned, tree } from '../../tools/release/materials.js';
import { skiaSourceMaterials } from '../../tools/release/skia-sources.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), relative = 'tools/release/source-materials';

async function fixture(t) {
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'skia-source-materials-'));
  t.after(() => removeOwned(parent, directory));
  const target = path.join(directory, relative); await mkdir(target, { recursive: true });
  for (const name of ['source-offer.json', 'native-packages.json', 'related-sources/skia/commit.json', 'skia-sources.json', 'skia-sources']) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await cp(path.join(root, relative, name), path.join(target, name), { recursive: true });
  }
  const offerFile = path.join(target, 'source-offer.json'), offer = JSON.parse(await readFile(offerFile, 'utf8'));
  const catalogFile = path.join(target, offer.skiaSources.path), catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  return { target, catalog, source: catalog.source, async saveCatalog() {
    await writeFile(catalogFile, JSON.stringify(catalog));
    Object.assign(offer.skiaSources, await fileIdentity(catalogFile));
    await writeFile(offerFile, JSON.stringify(offer));
  }, async consume() { return await skiaSourceMaterials(directory, await tree(directory, relative)); } };
}

test('complete original Skia source preserves all declared Git files, links, build inputs and notices', async t => {
  const state = await fixture(t), result = await state.consume();
  assert.equal(result.path, relative + '/skia-sources.json'); assert.deepEqual(result.limitations, state.catalog.limitations);
});

test('the complete source cannot be attributed to a different Canvas Skia gitlink', async t => {
  const state = await fixture(t); state.source.candidate.commit = '0'.repeat(40); await state.saveCatalog();
  await assert.rejects(state.consume(), /actual Canvas Git source and declared gitlink/u);
});

test('a recursive Git source tree cannot omit a source directory after local repinning', async t => {
  const state = await fixture(t), filename = path.join(state.target, state.source.tree.path);
  const value = JSON.parse(await readFile(filename, 'utf8')); value.tree = value.tree.filter(member => member.path !== 'src');
  await writeFile(filename, JSON.stringify(value)); Object.assign(state.source.tree, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /recursive Git tree identity changed/u);
});

test('a source link target still has to match the original Git blob', async t => {
  const state = await fixture(t), filename = path.join(state.target, state.source.members.path);
  const value = JSON.parse(await readFile(filename, 'utf8')); value.find(member => member.kind === 'symlink').target = 'Cargo.toml';
  await writeFile(filename, JSON.stringify(value)); Object.assign(state.source.members, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /member differs from its original Git tree/u);
});

test('an original constituent notice cannot be omitted by repinning the source catalog', async t => {
  const state = await fixture(t); state.source.notices.pop(); await state.saveCatalog();
  await assert.rejects(state.consume(), /original notice set is incomplete/u);
});
