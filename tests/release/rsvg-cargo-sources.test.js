import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity, removeOwned, tree } from '../../tools/release/materials.js';
import { rsvgCargoSourceMaterials } from '../../tools/release/rsvg-cargo-sources.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), relative = 'tools/release/source-materials';

async function fixture(t) {
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'rsvg-cargo-materials-'));
  t.after(() => removeOwned(parent, directory));
  const target = path.join(directory, relative); await mkdir(target, { recursive: true });
  for (const name of ['source-offer.json', 'native-full-sources.json', 'native-full-sources/rsvg/members.json',
    'rsvg-cargo-sources.json', 'rsvg-cargo-sources', 'libvips-linux-original.log.gz', 'libvips-macos-original.log.gz']) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await cp(path.join(root, relative, name), path.join(target, name), { recursive: true });
  }
  const offerFile = path.join(target, 'source-offer.json'), offer = JSON.parse(await readFile(offerFile, 'utf8'));
  const catalogFile = path.join(target, offer.rsvgCargoSources.path), catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  return { directory, target, offer, catalog, async saveCatalog() {
    await writeFile(catalogFile, JSON.stringify(catalog));
    Object.assign(offer.rsvgCargoSources, await fileIdentity(catalogFile));
    await writeFile(offerFile, JSON.stringify(offer));
  }, async consume() { return await rsvgCargoSourceMaterials(directory, await tree(directory, relative)); } };
}

test('supplied published Rust sources cover the original librsvg Linux/macOS compile observations', async t => {
  const state = await fixture(t), result = await state.consume();
  assert.equal(result.path, relative + '/rsvg-cargo-sources.json');
  assert.deepEqual(result.limitations, state.catalog.limitations);
});

test('omitting an observed compiled crate cannot be hidden by repinning the source catalog', async t => {
  const state = await fixture(t); state.catalog.crates.pop(); await state.saveCatalog();
  await assert.rejects(state.consume(), /source set is incomplete/u);
});

test('compiler-tool output cannot replace the actual librsvg library compilation region', async t => {
  const state = await fixture(t); state.catalog.observations[0].start.line = 1; await state.saveCatalog();
  await assert.rejects(state.consume(), /compilation boundaries changed/u);
});

test('a repinned crate archive still has to match the checksum in the original library source lock', async t => {
  const state = await fixture(t), source = state.catalog.crates.find(source => source.name === 'proc-macro2');
  const filename = path.join(state.target, source.archive.path), raw = await readFile(filename);
  raw[9] ^= 1; await writeFile(filename, raw);
  Object.assign(source.archive, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /pristine librsvg lock checksum/u);
});

test('the published container binds every regular source member despite local catalog repinning', async t => {
  const state = await fixture(t), source = state.catalog.crates[0];
  source.members.find(member => member.path.endsWith('/Cargo.toml')).sha256 = '0'.repeat(64);
  await state.saveCatalog();
  await assert.rejects(state.consume(), /source catalog differs from the locked archive/u);
});

test('separately supplied original notices retain their actual archive member bytes', async t => {
  const state = await fixture(t), source = state.catalog.crates.find(source => source.notices.length);
  const notice = source.notices[0], filename = path.join(state.target, notice.path);
  await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nUnbound notice.\n')]));
  Object.assign(notice, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /original notice differs from its archive member/u);
});

test('original source declarations are preserved without treating a registry license expression as a notice', async t => {
  const state = await fixture(t), source = state.catalog.crates.find(source => source.name === 'selectors');
  assert.equal(source.notices.length, 0);
  source.license = 'MIT'; await state.saveCatalog();
  await assert.rejects(state.consume(), /package or original VCS declaration changed/u);
});

test('the extracted pristine lock remains bound to the original complete librsvg source container', async t => {
  const state = await fixture(t), filename = path.join(state.target, state.catalog.library.lock.path);
  await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\n# Replacement lock.\n')]));
  Object.assign(state.catalog.library.lock, await fileIdentity(filename)); await state.saveCatalog();
  await assert.rejects(state.consume(), /lock differs from its original archive member/u);
});
