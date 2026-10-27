import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { buildLogMaterials, copyRegular, createReleaseDirectory, dependencyMaterials, fileIdentity, inside, nodeCommand, removeOwned, tree, verifyFiles } from '../../tools/release/materials.js';
import { resolveDependencyLicenseTexts } from '../../tools/release/license-texts.js';
import { nativeFullSourceMaterials } from '../../tools/release/native-full-sources.js';

const root = fileURLToPath(new URL('../../', import.meta.url)), temporaryParent = path.join(root, '.test-output');
async function fixture(t) {
  await mkdir(temporaryParent, { recursive: true });
  const directory = await mkdtemp(path.join(temporaryParent, 'release-materials-'));
  t.after(() => removeOwned(temporaryParent, directory));
  return directory;
}

test('delivery verification rejects altered bytes, missing files and injected files', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'source.js'), 'export const value = 1;\n');
  const original = await tree(directory);
  await verifyFiles(directory, original);
  await verifyFiles(directory, original.map(({ path: filename, bytes, sha256 }) => ({ sha256, bytes, path: filename })).reverse());
  await writeFile(path.join(directory, 'source.js'), 'export const value = 2;\n');
  await assert.rejects(verifyFiles(directory, original), /changed/u);
  await writeFile(path.join(directory, 'source.js'), 'export const value = 1;\n');
  await writeFile(path.join(directory, 'extra.js'), 'unbound code');
  await assert.rejects(verifyFiles(directory, original), /changed/u);
  await removeOwned(directory, path.join(directory, 'extra.js'));
  await removeOwned(directory, path.join(directory, 'source.js'));
  await assert.rejects(verifyFiles(directory, original), /changed/u);
});

test('workspace link evidence survives relocation and rejects external link targets', async t => {
  const directory = await fixture(t), snapshots = [];
  for (const name of ['first', 'relocated']) {
    const application = path.join(directory, name);
    await mkdir(path.join(application, 'packages/sdk'), { recursive: true });
    await mkdir(path.join(application, 'node_modules'));
    await writeFile(path.join(application, 'packages/sdk/module.js'), 'export {};\n');
    await symlink(path.join(application, 'packages/sdk'), path.join(application, 'node_modules/sdk'),
      process.platform === 'win32' ? 'junction' : 'dir');
    snapshots.push(await tree(application));
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
  await symlink(path.join(directory, 'first'), path.join(directory, 'relocated/external'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(tree(path.join(directory, 'relocated')), /inside/u);
  await assert.rejects(copyRegular(path.join(directory, 'relocated'), path.join(directory, 'first'), ['external']), /ordinary/u);
  assert.throws(() => inside(directory, path.dirname(directory)), /inside/u);
});

test('package output cannot traverse an intermediate junction or replace an existing destination', async t => {
  const directory = await fixture(t), parent = path.join(directory, '.test-output'), outside = path.join(directory, 'outside');
  await mkdir(parent); await mkdir(outside); await writeFile(path.join(outside, 'retained'), 'retained');
  await symlink(outside, path.join(parent, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createReleaseDirectory(directory, path.join(parent, 'redirect/package')), /direct child/u);
  await assert.rejects(lstat(path.join(outside, 'package')), { code: 'ENOENT' });
  await assert.rejects(createReleaseDirectory(directory, path.join(parent, 'redirect')), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(outside, 'retained'), 'utf8'), 'retained');
  await createReleaseDirectory(directory, path.join(parent, 'package'));
});

test('large tracked member output remains complete and oversized output fails explicitly', async () => {
  const output = await nodeCommand(['-e', 'process.stdout.write("begin\\0" + "x".repeat(1100000) + "\\0end")']);
  assert.ok(output.startsWith('begin\0')); assert.ok(output.endsWith('\0end'));
  await assert.rejects(nodeCommand(['-e', 'process.stdout.write("x".repeat(17000000))']), /complete-output limit/u);
});

async function licenseFixture(t) {
  const directory = await fixture(t);
  const materials = path.join('tools', 'release', 'license-materials');
  await mkdir(path.join(directory, 'tools/release'), { recursive: true });
  await cp(path.join(root, materials), path.join(directory, materials), { recursive: true });
  return directory;
}

test('a complete license in the delivered README is usable without a separate LICENSE file', async t => {
  const directory = await licenseFixture(t), name = 'node_modules/readme-license';
  await mkdir(path.join(directory, name), { recursive: true });
  await mkdir(path.join(directory, 'dependency-cache'));
  await writeFile(path.join(directory, name, 'package.json'), JSON.stringify({ name: 'readme-license', version: '1.0.0', license: 'MIT' }));
  const license = await readFile(path.join(root, 'tools/release/license-materials/entities-LICENSE'), 'utf8');
  await writeFile(path.join(directory, name, 'README.md'), '# Package\n\n## License\n\n' + license);
  const archive = Buffer.from('the installed locked package archive');
  await writeFile(path.join(directory, 'dependency-cache/package.tgz'), archive);
  const lock = { packages: { [name]: { version: '1.0.0', resolved: 'https://example.test/readme-license-1.0.0.tgz',
    integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') } } };
  const cacheFiles = await tree(directory, 'dependency-cache');
  const materials = await dependencyMaterials(directory, lock, cacheFiles);
  assert.deepEqual(materials.unavailableLicenseTexts, []);
  assert.deepEqual(materials.packages[0].licenseTexts, ['third-party-licenses/' + name + '/README.md']);
  assert.equal(await readFile(path.join(directory, materials.packages[0].licenseTexts[0]), 'utf8'), '# Package\n\n## License\n\n' + license);
  await writeFile(path.join(directory, name, 'README.md'), '# Package\n\n## License\n\nMIT\n');
  assert.deepEqual((await dependencyMaterials(directory, lock, cacheFiles)).unavailableLicenseTexts, [name]);
});

test('platform distributions share the declared companion license only through their exact optional package relationship', async t => {
  const directory = await licenseFixture(t);
  const owner = { path: 'node_modules/koffi', name: 'koffi', version: '3.3.3', license: 'MIT', licenses: ['koffi/LICENSE.txt'],
    licenseTexts: ['koffi/LICENSE.txt'], distribution: {} };
  const platform = { path: 'node_modules/@koromix/koffi-linux-x64', name: '@koromix/koffi-linux-x64', version: '3.3.3', license: 'MIT',
    licenses: [], licenseTexts: [], distribution: {} };
  const manifests = new Map([[owner.path, { optionalDependencies: { [platform.name]: '3.3.3' } }]]);
  assert.deepEqual(await resolveDependencyLicenseTexts(directory, [owner, platform], manifests), []);
  assert.deepEqual(platform.licenseTexts, owner.licenseTexts);
  assert.deepEqual(platform.licenseSources, [{ package: owner.path, version: owner.version, licenseTexts: owner.licenseTexts }]);
  for (const change of [{ version: '3.3.4' }, { license: 'BSD-2-Clause' }, { name: '@koromix/koffi-freebsd-x64' }]) {
    const unmatched = { ...platform, ...change, licenses: [], licenseTexts: [] };
    assert.deepEqual(await resolveDependencyLicenseTexts(directory, [owner, unmatched], manifests), [unmatched.path]);
  }
});

test('supplemental upstream license text binds the actual npm identity and preserves its original bytes', async t => {
  const directory = await licenseFixture(t), relative = 'tools/release/license-materials';
  const catalog = JSON.parse(await readFile(path.join(directory, relative, 'index.json'), 'utf8'));
  const source = catalog.packages.find(pkg => pkg.name === '@nodable/entities');
  const pkg = { path: 'node_modules/@nodable/entities', name: source.name, version: source.version, license: source.license,
    licenses: [], licenseTexts: [], distribution: { integrity: source.integrity } };
  assert.deepEqual(await resolveDependencyLicenseTexts(directory, [pkg], new Map()), []);
  assert.deepEqual(pkg.licenseTexts, [relative + '/entities-LICENSE']);
  assert.deepEqual(await readFile(path.join(directory, pkg.licenseTexts[0])), await readFile(path.join(root, pkg.licenseTexts[0])));
  const otherArchive = { ...pkg, licenseTexts: [], licenses: [], distribution: { integrity: 'sha512-unrelated' } };
  assert.deepEqual(await resolveDependencyLicenseTexts(directory, [otherArchive], new Map()), [otherArchive.path]);
  await writeFile(path.join(directory, pkg.licenseTexts[0]), 'unbound replacement license');
  await assert.rejects(resolveDependencyLicenseTexts(directory, [{ ...pkg, licenses: [], licenseTexts: [] }], new Map()), /material changed/u);
});

async function buildLogFixture(t, { includeFullSources = false } = {}) {
  const directory = await fixture(t), relative = 'tools/release/source-materials';
  await mkdir(path.join(directory, 'tools/release'), { recursive: true });
  await cp(path.join(root, relative), path.join(directory, relative), { recursive: true,
    filter: filename => {
      const group = path.relative(path.join(root, relative), filename).split(path.sep)[0];
      return !['rsvg-cargo-sources', 'skia-sources', 'skia-dependency-sources', 'canvas-cargo-sources', 'rsvg-windows-sources', 'rsvg-original-notices', 'canvas-current-graphs', 'native-aggregate-sources', 'rsvg-posix-sources', 'windows-native-aggregate-sources'].includes(group) && (includeFullSources || group !== 'native-full-sources');
    } });
  await cp(path.join(root, 'package-lock.json'), path.join(directory, 'package-lock.json'));
  const filename = path.join(directory, relative, 'source-offer.json');
  const offer = JSON.parse(await readFile(filename, 'utf8'));
  const catalog = JSON.parse(await readFile(path.join(directory, relative, offer.nativePackages.path), 'utf8'));
  // These unit fixtures contain metadata only. The package workflow checks the actual locked installation.
  for (const source of catalog.sharpNativeNotices.platforms) {
    if (source.platform !== process.platform || source.architecture !== process.arch) continue;
    const installed = path.join(directory, source.lockPath);
    await mkdir(installed, { recursive: true });
    await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: source.name, version: source.version }));
    await cp(path.join(directory, relative, source.versions.path), path.join(directory, source.versions.member));
  }
  return { directory, relative, filename, offer };
}

test('archived build evidence accepts different gzip packaging and rejects changed original log bytes', async t => {
  const { directory, relative, filename, offer } = await buildLogFixture(t);
  await buildLogMaterials(directory, await tree(directory, relative));
  const source = offer.sources[0], archive = path.join(directory, relative, source.archive.path);
  const raw = gunzipSync(await readFile(archive));
  await writeFile(archive, gzipSync(raw, { level: 1 }));
  Object.assign(source.archive, await fileIdentity(archive));
  await writeFile(filename, JSON.stringify(offer));
  await buildLogMaterials(directory, await tree(directory, relative));
  raw[0] ^= 1;
  await writeFile(archive, gzipSync(raw));
  Object.assign(source.archive, await fileIdentity(archive));
  await writeFile(filename, JSON.stringify(offer));
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /raw bytes changed/u);
});

test('a repinned job receipt cannot attribute build evidence to another source run', async t => {
  const { directory, relative, filename, offer } = await buildLogFixture(t);
  const source = offer.sources[0], receipt = path.join(directory, relative, source.jobReceipt.path);
  const job = JSON.parse(await readFile(receipt, 'utf8'));
  job.run_id += 1;
  await writeFile(receipt, JSON.stringify(job));
  Object.assign(source.jobReceipt, await fileIdentity(receipt));
  await writeFile(filename, JSON.stringify(offer));
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /source identity changed/u);
});

async function recipeFixture(t) {
  const state = await buildLogFixture(t);
  const filename = path.join(state.directory, state.relative, state.offer.recipeFragments.path);
  const catalog = JSON.parse(await readFile(filename, 'utf8'));
  return { ...state, catalog, async saveCatalog() {
    await writeFile(filename, JSON.stringify(catalog));
    Object.assign(state.offer.recipeFragments, await fileIdentity(filename));
    await writeFile(state.filename, JSON.stringify(state.offer));
  } };
}

test('a locally repinned recipe fragment must still match its upstream Git blob', async t => {
  const { directory, relative, catalog, saveCatalog } = await recipeFixture(t);
  const file = catalog.sources.find(source => source.id === 'sharp').files.find(file => file.upstreamPath === 'src/binding.gyp');
  const filename = path.join(directory, relative, file.path);
  await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\n# unbound compiler setting\n')]));
  Object.assign(file, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Recipe Git blob changed/u);
});

test('valid log observations from another checkout cannot identify a recipe source', async t => {
  const { directory, relative, catalog, saveCatalog } = await recipeFixture(t);
  const sharp = catalog.sources.find(source => source.id === 'sharp');
  const libvips = catalog.sources.find(source => source.id === 'sharp-libvips');
  sharp.evidence.logAnchors[0] = libvips.evidence.logAnchors[0];
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Recipe checkout differs from its observed build/u);
});

test('patch bytes must remain associated with the recipe that references their fixed URL', async t => {
  const { directory, relative, catalog, saveCatalog } = await recipeFixture(t);
  catalog.patches[0].upstreamPath = 'build/win.sh';
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Patch source differs from its recorded recipe/u);
});

test('downloaded release-tag recipes do not claim an observed producer checkout', async t => {
  const { directory, relative, catalog, saveCatalog } = await recipeFixture(t);
  catalog.sources.find(source => source.id === 'libvips-win64-mxe').evidence.kind = 'observed-checkout';
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Recipe checkout differs from its observed build/u);
});

async function nativePackageFixture(t) {
  const state = await buildLogFixture(t);
  const filename = path.join(state.directory, state.relative, state.offer.nativePackages.path);
  const catalog = JSON.parse(await readFile(filename, 'utf8'));
  return { ...state, catalog, async saveCatalog() {
    await writeFile(filename, JSON.stringify(catalog));
    Object.assign(state.offer.nativePackages, await fileIdentity(filename));
    await writeFile(state.filename, JSON.stringify(state.offer));
  } };
}

test('published native source archive bytes remain bound to the actual npm lock integrity', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const filename = path.join(directory, relative, catalog.koffi.archive.path), raw = await readFile(filename);
  raw[9] ^= 1; // A different gzip OS marker still decodes to the same tar source bytes.
  await writeFile(filename, raw);
  Object.assign(catalog.koffi.archive, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /source archive differs from the lock/u);
});

test('published source member identities and extracted notices retain their original archive association', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const member = catalog.koffi.members.find(member => member.path === 'package/src/koffi/src/ffi.cc'), original = member.sha256;
  member.sha256 = '0'.repeat(64);
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /source catalog differs from the locked archive/u);
  member.sha256 = original;
  const license = catalog.koffi.licenses.find(license => license.member === 'package/LICENSE.txt');
  const other = catalog.koffi.licenses.find(license => license.member === 'package/vendor/node-api-headers/LICENSE');
  const filename = path.join(directory, relative, license.path);
  await writeFile(filename, await readFile(path.join(directory, relative, other.path)));
  Object.assign(license, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /source notice differs from its archive member/u);
});

test('Canvas download recipes retain the exact Git blob at the npm-declared source commit', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const file = catalog.canvas.files.find(file => file.upstreamPath === 'scripts/utils.mjs');
  const filename = path.join(directory, relative, file.path);
  await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\n// unbound download identity\n')]));
  Object.assign(file, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Native recipe Git blob changed/u);
});

test('a valid platform attestation cannot identify another locked Canvas distribution', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const linux = catalog.canvas.distributions.find(source => source.name === '@napi-rs/canvas-linux-x64-gnu');
  const windows = catalog.canvas.distributions.find(source => source.name === '@napi-rs/canvas-win32-x64-msvc');
  windows.attestations = { ...linux.attestations, url: windows.attestations.url };
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /provenance subject or source association changed/u);
});

test('a locally repinned provenance payload must still name the archived source and publication run', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const source = catalog.canvas.distributions.find(source => source.name === '@napi-rs/canvas');
  const filename = path.join(directory, relative, source.attestations.path);
  const response = JSON.parse(await readFile(filename, 'utf8'));
  const envelope = response.attestations.find(value => value.predicateType === 'https://slsa.dev/provenance/v1').bundle.dsseEnvelope;
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = '0'.repeat(40);
  envelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
  await writeFile(filename, JSON.stringify(response));
  Object.assign(source.attestations, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /provenance subject or source association changed/u);
});

test('a complete own native source claim remains bound to every member of its original Git tree', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  catalog.canvas.files = catalog.canvas.files.filter(file => file.upstreamPath !== 'src/avif.rs');
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Native source directory is incomplete: src/u);
});

test('related original notices retain both their declared Gitlink and their upstream Git blob', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const source = catalog.relatedSources.find(source => source.id === 'skia'), originalLink = source.gitlink;
  source.gitlink = 'depot_tools';
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Native related source differs from its declared Gitlink/u);
  source.gitlink = originalLink;
  const license = source.files.find(file => file.upstreamPath === 'LICENSE'), filename = path.join(directory, relative, license.path);
  await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nUnbound replacement notice.\n')]));
  Object.assign(license, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Native recipe Git blob changed: LICENSE/u);
});

test('published Cargo source archives retain the original Canvas lock checksum despite local repinning', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const source = catalog.canvas.cargo.crates.find(source => source.name === 'mimalloc-safe');
  const filename = path.join(directory, relative, source.archive.path), raw = await readFile(filename);
  raw[9] ^= 1; // The original lock identifies compressed archive bytes, including this gzip marker.
  await writeFile(filename, raw);
  Object.assign(source.archive, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Cargo source archive differs from its original Cargo.lock checksum/u);
});

test('an original version registry response cannot identify a different locked Cargo source', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const source = catalog.canvas.cargo.crates.find(source => source.name === 'libavif-sys');
  const other = catalog.canvas.cargo.crates.find(source => source.name === 'libaom-sys');
  source.registry.receipt = { ...other.registry.receipt };
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Cargo source registry differs from the original Canvas lock/u);
});

test('complete original Cargo archives and their extracted notices preserve the actual member association', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  // This consumes the actual libavif-sys archive, including its GNU long paths.
  await buildLogMaterials(directory, await tree(directory, relative));
  const source = catalog.canvas.cargo.crates.find(source => source.name === 'libaom-sys');
  const license = source.notices.find(notice => notice.member.endsWith('/vendor/LICENSE'));
  const patents = source.notices.find(notice => notice.member.endsWith('/vendor/PATENTS'));
  const filename = path.join(directory, relative, license.path);
  await writeFile(filename, await readFile(path.join(directory, relative, patents.path)));
  Object.assign(license, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Cargo notice differs from its archive member/u);
});

test('published dirty Cargo metadata and repository notices retain their exact declared VCS base', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const source = catalog.canvas.cargo.crates.find(source => source.name === 'libaom-sys');
  const other = catalog.canvas.cargo.crates.find(source => source.name === 'libavif-sys');
  source.vcs.value.git.dirty = false;
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Cargo package or VCS identity changed/u);
  source.vcs.value.git.dirty = true;
  source.repositoryNotice = other.repositoryNotice;
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Cargo repository notice differs from its published VCS base/u);
});

test('Sharp MIT notices bind current component declarations without imposing their JSON representation', async t => {
  const { directory, relative, catalog } = await nativePackageFixture(t);
  const source = catalog.sharpNativeNotices.platforms.find(source => source.platform === process.platform && source.architecture === process.arch);
  const filename = path.join(directory, source.versions.member);
  const versions = JSON.parse(await readFile(filename, 'utf8'));
  await writeFile(filename, JSON.stringify(Object.fromEntries(Object.entries(versions).reverse()), null, 4) + '\n');
  await buildLogMaterials(directory, await tree(directory, relative));
  versions.cgif = '0.0.0';
  await writeFile(filename, JSON.stringify(versions));
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Installed Sharp constituent notice version changed: cgif/u);
});

test('Sharp component notice versions and original release refs remain associated with the held recipe', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const expat = catalog.sharpNativeNotices.components.find(source => source.name === 'expat');
  const cgif = catalog.sharpNativeNotices.components.find(source => source.name === 'cgif');
  const originalVersion = expat.version;
  expat.version = '2.8.2';
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /notice differs from the original version recipe: expat/u);
  expat.version = originalVersion;
  expat.source.refReceipt = { ...cgif.source.refReceipt };
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /notice release ref changed: expat/u);
});

test('Sharp original constituent notices retain their release Git blob despite local repinning', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const source = catalog.sharpNativeNotices.components.find(source => source.name === 'lcms');
  const notice = source.source.files[0], filename = path.join(directory, relative, notice.path);
  await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nUnbound replacement notice.\n')]));
  Object.assign(notice, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Native recipe Git blob changed: LICENSE/u);
});

test('Sharp notice platform evidence cannot identify another locked npm distribution', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const linux = catalog.sharpNativeNotices.platforms.find(source => source.platform === 'linux');
  const windows = catalog.sharpNativeNotices.platforms.find(source => source.platform === 'win32');
  linux.distribution.integrity = windows.distribution.integrity;
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Sharp notice platform differs from the locked distribution/u);
});

test('the complete proxy source remains bound to its original Git root and recipe archive despite local repinning', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  // This consumes the actual source tar, including its PAX comment and explicit root directory.
  await buildLogMaterials(directory, await tree(directory, relative));
  const proxy = catalog.sharpNativeNotices.components.find(source => source.name === 'proxy-libintl');
  const originalFiles = proxy.source.files;
  proxy.source.files = originalFiles.filter(file => file.upstreamPath !== 'libintl.h');
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Native source directory is incomplete: \./u);
  proxy.source.files = originalFiles;
  const filename = path.join(directory, relative, proxy.archive.path), raw = await readFile(filename);
  raw[9] ^= 1; // Unchanged source members do not make a different archive the source container named by the recipe checksum.
  await writeFile(filename, raw);
  Object.assign(proxy.archive, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /source archive differs from its original recipe: proxy-libintl/u);
});

test('Cairo original terms retain their annotated tag, commit and root tree association', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const source = catalog.sharpNativeNotices.cairo.source;
  const filename = path.join(directory, relative, source.tagObject.path), raw = await readFile(filename);
  await writeFile(filename, Buffer.concat([raw, Buffer.from('\nUnbound tag attribution.\n')]));
  Object.assign(source.tagObject, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Native GitLab release source identity changed/u);
  await writeFile(filename, raw);
  Object.assign(source.tagObject, await fileIdentity(filename));
  const rootReceipt = source.rootTreeReceipts[0], treeFile = path.join(directory, relative, rootReceipt.path);
  const members = JSON.parse(await readFile(treeFile, 'utf8'));
  members.find(member => member.path === 'COPYING').id = '0'.repeat(40);
  await writeFile(treeFile, JSON.stringify(members));
  Object.assign(rootReceipt, await fileIdentity(treeFile));
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Native GitLab root tree identity changed/u);
});

test('Cairo original license bytes cannot be replaced by repinning the local catalog', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const notice = catalog.sharpNativeNotices.cairo.source.files.find(file => file.upstreamPath === 'COPYING');
  const filename = path.join(directory, relative, notice.path);
  await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nUnbound replacement terms.\n')]));
  Object.assign(notice, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Native GitLab original source blob changed: COPYING/u);
});

test('proxy and Cairo terms bind current declarations and preserve the original publisher choice', async t => {
  const { directory, relative, catalog, saveCatalog } = await nativePackageFixture(t);
  const platform = catalog.sharpNativeNotices.platforms.find(source => source.platform === process.platform && source.architecture === process.arch);
  const filename = path.join(directory, platform.versions.member), versions = JSON.parse(await readFile(filename, 'utf8'));
  versions['proxy-libintl'] = '0.0.0';
  await writeFile(filename, JSON.stringify(versions));
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Installed Sharp constituent notice version changed: proxy-libintl/u);
  versions['proxy-libintl'] = '0.5';
  versions.cairo = '0.0.0';
  await writeFile(filename, JSON.stringify(versions));
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Installed Sharp constituent notice version changed: cairo/u);
  versions.cairo = '1.18.4';
  await writeFile(filename, JSON.stringify(versions));
  catalog.sharpNativeNotices.cairo.publisherNotice.term = 'LGPLv3';
  await saveCatalog();
  await assert.rejects(buildLogMaterials(directory, await tree(directory, relative)), /Cairo original publisher declaration changed/u);
});

test('complete original library archives preserve actual directory/link membership and streamed regular source bytes', async t => {
  const { directory, relative } = await buildLogFixture(t, { includeFullSources: true });
  await nativeFullSourceMaterials(directory, await tree(directory, relative));
});

async function fullSourceFixture(t) {
  const state = await buildLogFixture(t, { includeFullSources: true });
  const filename = path.join(state.directory, state.relative, state.offer.nativeFullSources.path);
  const catalog = JSON.parse(await readFile(filename, 'utf8'));
  return { ...state, catalog, async saveCatalog() {
    await writeFile(filename, JSON.stringify(catalog));
    Object.assign(state.offer.nativeFullSources, await fileIdentity(filename));
    await writeFile(state.filename, JSON.stringify(state.offer));
  } };
}

test('complete source containers retain the checksum actually named by the original producer recipe', async t => {
  const { directory, relative, catalog, saveCatalog } = await fullSourceFixture(t);
  const source = catalog.sources.find(source => source.name === 'heif');
  const filename = path.join(directory, relative, source.archive.path), raw = await readFile(filename);
  raw[9] ^= 1;
  await writeFile(filename, raw);
  Object.assign(source.archive, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(nativeFullSourceMaterials(directory, await tree(directory, relative)), /original recipe checksum: heif/u);
});

test('complete source notices and current component declarations stay associated with their actual source', async t => {
  const { directory, relative, catalog, saveCatalog } = await fullSourceFixture(t);
  const source = catalog.sources.find(source => source.name === 'cairo'), originalVersion = source.version;
  source.version = '1.18.2';
  await saveCatalog();
  await assert.rejects(nativeFullSourceMaterials(directory, await tree(directory, relative)), /Installed native source version differs: cairo/u);
  source.version = originalVersion;
  const notice = source.notices.find(notice => notice.member.endsWith('/COPYING'));
  const filename = path.join(directory, relative, notice.path);
  await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\nUnbound replacement notice.\n')]));
  Object.assign(notice, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(nativeFullSourceMaterials(directory, await tree(directory, relative)), /notice differs from its archive member/u);
});

test('an intact source container cannot use a repinned catalog to change original regular member bytes', async t => {
  const { directory, relative, catalog, saveCatalog } = await fullSourceFixture(t);
  const source = catalog.sources.find(source => source.name === 'fribidi');
  const filename = path.join(directory, relative, source.members.path), members = JSON.parse(await readFile(filename, 'utf8'));
  members.find(member => member.path === source.root + 'meson.build').sha256 = '0'.repeat(64);
  await writeFile(filename, JSON.stringify(members));
  Object.assign(source.members, await fileIdentity(filename));
  await saveCatalog();
  await assert.rejects(nativeFullSourceMaterials(directory, await tree(directory, relative)), /source member bytes changed:.*meson\.build/u);
});
