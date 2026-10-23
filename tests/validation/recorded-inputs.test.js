import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import manifest from '../../tools/validation/recorded-inputs.json' with { type: 'json' };
import sourcePlan from '../../tools/validation/recorded-input-sources.json' with { type: 'json' };
import { designatedJellyfinContentDigest, designatedJellyfinDirtyFiles, designatedJellyfinHead,
  designatedJellyfinSourceFiles, validateDesignatedJellyfinSourceDocuments,
  verifyDesignatedJellyfinSourcePackage } from '../../tools/validation/designated-jellyfin-source.js';
import { inventory } from '../../tools/validation/inventory.js';
import { recordedInput, recordedInputMapPath, recordedInputPath, repositoryRoot,
  validationExecutable, validationPath } from '../../tools/validation/paths.js';

const sourcePackageUrl = new URL('../fixtures/recorded-native/jellyfin-source-package.json', import.meta.url);
const sourcePackage = JSON.parse(await readFile(sourcePackageUrl));
const sourceIdentity = (source, sha256) => path.win32.normalize(source).replaceAll('\\', '/').toLowerCase() + '\0' + sha256;
const bundle = 'tests/fixtures/recorded-native';
const licenseInputs = [
  { path: 'D:/jellyfin/LICENSE', bytes: 18014,
    sha256: 'f371b80469fb235bc500ec29e0e85b682d4a6157a158567d828ff0be544d4f1d', required: true,
    target: `${bundle}/LICENSE-Jellyfin.txt` },
  { path: 'D:/mediamanager/.tools/dotnet/LICENSE.txt', bytes: 9519,
    sha256: '7f6839a61ce892b79c6549e2dc5a81fdbd240a0b260f8881216b45b7fda8b45d', required: true,
    target: `${bundle}/LICENSE-Dotnet.txt` },
  { path: 'D:/mediamanager/.tools/dotnet/ThirdPartyNotices.txt', bytes: 78887,
    sha256: 'deb4427a295e1ed474b0d81c5a0d972c1b550b9a715cda939cdfa9236b1b418f', required: true,
    target: `${bundle}/ThirdPartyNotices-Dotnet.txt` }
];
const licenseTargets = new Map(licenseInputs.map(value => [sourceIdentity(value.path, value.sha256), value.target]));
const licenseSources = new Set(licenseInputs.map(value => path.win32.normalize(value.path).replaceAll('\\', '/').toLowerCase()));
const provenanceDescriptor = (value, source = value.path ?? value.filename) =>
  ({ path: source, bytes: value.bytes, sha256: value.sha256, required: true });
const requiredManifestContracts = new Map([
  ['library-directory-monitor', {
    target: 'tests/library/fixtures/library-directory-monitor/required-inputs.json',
    provenance: 'tests/library/fixtures/library-directory-monitor/provenance.json',
    derive: value => [...value.sourceFiles, ...value.requiredInputs, ...value.runtime.sourceFiles]
      .map(input => provenanceDescriptor(input))
  }],
  ['user-view-collage', {
    target: 'tests/images/fixtures/user-view-collage/required-inputs.json',
    provenance: 'tests/images/fixtures/user-view-collage/provenance.json',
    derive: value => [
      ...value.sources.map(input => provenanceDescriptor(input, 'D:/jellyfin/' + input.path)),
      ...value.oracleSources.map(input => provenanceDescriptor(input)),
      provenanceDescriptor(value.oracleAssembly), provenanceDescriptor(value.jellyfinDll),
      provenanceDescriptor(value.dotnet), provenanceDescriptor(value.executionRecord),
      provenanceDescriptor(value.buildClosureReceipt)
    ]
  }]
]);

async function assertPlainRepositoryFile(relative) {
  let current = repositoryRoot;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    assert.equal((await lstat(current)).isSymbolicLink(), false, relative);
  }
  const resolved = await realpath(current), suffix = path.relative(await realpath(repositoryRoot), resolved);
  assert.ok(suffix && suffix !== '..' && !suffix.startsWith('..' + path.sep) && !path.isAbsolute(suffix), relative);
  return resolved;
}

test('the recorded GPL assembly includes its complete designated source and license', async () => {
  for (const name of ['archive', 'sourceManifest', 'localModifications', 'license', 'buildReceipt', 'nativeAssembly']) {
    const descriptor = sourcePackage[name], bytes = await readFile(new URL(descriptor.path, sourcePackageUrl));
    assert.equal(descriptor.required, true, name);
    if (descriptor.bytes != null) assert.equal(bytes.length, descriptor.bytes, name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256, name);
  }
  const verified = await verifyDesignatedJellyfinSourcePackage();
  assert.equal(verified.package.head, designatedJellyfinHead);
  assert.equal(verified.manifest.head, designatedJellyfinHead);
  assert.equal(verified.modifications.head, designatedJellyfinHead);
  assert.equal(verified.package.sourceContentDigest, designatedJellyfinContentDigest);
  assert.equal(verified.manifest.contentDigest, designatedJellyfinContentDigest);
  assert.equal(verified.modifications.sourceContentDigest, designatedJellyfinContentDigest);
  assert.equal(verified.manifest.files.length, designatedJellyfinSourceFiles);
  assert.equal(verified.modifications.entries.length, designatedJellyfinDirtyFiles);
  assert.equal(verified.inputs.length, 5, 'the package and four current source-offer attachments are byte-bound');
  assert.deepEqual(verified.sourceOffer.map(file => file.path).sort(), [
    'LICENSE-Jellyfin.txt', 'jellyfin-local-modifications.json',
    'jellyfin-source-208c278b75ab.zip', 'jellyfin-source-manifest.json',
  ]);
});

test('the designated Jellyfin source rejects drift in either direction of every authority link', async () => {
  const verified = await verifyDesignatedJellyfinSourcePackage();
  const reject = (mutate, pattern) => {
    const documents = { sourcePackage: structuredClone(verified.package), manifest: structuredClone(verified.manifest),
      modifications: structuredClone(verified.modifications) };
    mutate(documents);
    assert.throws(() => validateDesignatedJellyfinSourceDocuments(documents), pattern);
  };
  reject(documents => { documents.sourcePackage.head = '0'.repeat(40); }, /package identity/u);
  reject(documents => { documents.sourcePackage.archive.sha256 = '0'.repeat(64); }, /archive descriptor/u);
  reject(documents => { documents.manifest.head = '0'.repeat(40); }, /manifest identity/u);
  reject(documents => { documents.manifest.files[0].sha256 = '0'.repeat(64); }, /aggregate source identity/u);
  reject(documents => { [documents.manifest.files[0], documents.manifest.files[1]] =
    [documents.manifest.files[1], documents.manifest.files[0]]; }, /declared order/u);
  reject(documents => { documents.modifications.entries[0].sourceDescriptor.sha256 = '0'.repeat(64); }, /not bound/u);
  reject(documents => { documents.modifications.entries.pop(); }, /ledger identity/u);
  reject(documents => { documents.modifications.entries.at(-1).status = ' M'; }, /not bound/u);
});

test('the recorded-input source plan is the complete deterministic relocation authority', async () => {
  assert.equal(sourcePlan.schemaVersion, 1);
  assert.equal(sourcePlan.entries.length, 49);
  assert.equal(new Set(sourcePlan.entries.map(entry => entry.target)).size, 46);
  assert.equal(new Set(sourcePlan.entries.map(entry => sourceIdentity(entry.source, entry.sha256))).size, 49);
  assert.equal(sourcePlan.requiredInputManifests.length, 2);
  assert.equal(new Set(sourcePlan.requiredInputManifests.map(value => value.target)).size, 2);
  assert.deepEqual(new Set(sourcePlan.requiredInputManifests.map(value => value.kind)),
    new Set(requiredManifestContracts.keys()));
  const derived = {
    schemaVersion: 1,
    scope: sourcePlan.scope,
    sourcesReviewed: sourcePlan.sourcesReviewed,
    entries: sourcePlan.entries.map(({ acquisition: _acquisition, ...entry }) => entry)
  };
  assert.deepEqual(manifest, derived);
  await assertPlainRepositoryFile('tools/validation/recorded-input-sources.json');
  await assertPlainRepositoryFile('tools/validation/recorded-inputs.json');
  assert.equal(await readFile(recordedInputMapPath, 'utf8'), JSON.stringify(derived, null, 2) + '\n');
});

test('every planned acquisition is a tracked sealed payload with its exact bytes', async () => {
  const payloads = new Map();
  const objectTargets = new Set(), friendlyTargets = new Set();
  const consumerFiles = new Set();
  for (const entry of sourcePlan.entries) {
    assert.deepEqual(entry.acquisition, { kind: 'tracked-sealed-payload', path: entry.target }, entry.source);
    assert.ok(entry.consumers.length && new Set(entry.consumers).size === entry.consumers.length, entry.source);
    const identity = sourceIdentity(entry.source, entry.sha256);
    const friendlyTarget = licenseTargets.get(identity);
    const extension = path.win32.extname(entry.source).toLowerCase() || '.txt';
    const expectedTarget = friendlyTarget ?? `${bundle}/objects/${entry.sha256}${extension}`;
    assert.equal(entry.target, expectedTarget, entry.source);
    assert.equal(licenseSources.has(path.win32.normalize(entry.source).replaceAll('\\', '/').toLowerCase()),
      Boolean(friendlyTarget), entry.source);
    if (friendlyTarget) assert.deepEqual(entry.consumers, ['license'], entry.source);
    else assert.equal(entry.consumers.includes('license'), false, entry.source);
    for (const consumer of entry.consumers) if (consumer !== 'license') consumerFiles.add(consumer);
    (friendlyTarget ? friendlyTargets : objectTargets).add(entry.target);
    const bytes = await readFile(await assertPlainRepositoryFile(entry.acquisition.path));
    assert.equal(bytes.length, entry.bytes, entry.source);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.source);
    const existing = payloads.get(entry.target);
    if (existing) assert.deepEqual({ bytes: entry.bytes, sha256: entry.sha256 }, existing, entry.target);
    else payloads.set(entry.target, { bytes: entry.bytes, sha256: entry.sha256 });
  }
  assert.equal(payloads.size, 46);
  assert.equal(objectTargets.size, 43);
  assert.equal(friendlyTargets.size, 3);
  assert.ok(sourcePlan.entries.some((entry, index) => sourcePlan.entries
    .findIndex(candidate => candidate.target === entry.target) !== index), 'shared payload aliases remain explicit');
  for (const consumer of consumerFiles) await assertPlainRepositoryFile(consumer);
});

test('required-input manifests are derived in the source-plan identity order', async () => {
  const entries = new Map(sourcePlan.entries.map(entry => [sourceIdentity(entry.source, entry.sha256), entry]));
  for (const planned of sourcePlan.requiredInputManifests) {
    const contract = requiredManifestContracts.get(planned.kind);
    assert.ok(contract, planned.kind);
    assert.equal(planned.target, contract.target);
    assert.equal(planned.provenance.path, contract.provenance);
    const provenance = await readFile(await assertPlainRepositoryFile(contract.provenance));
    assert.equal(createHash('sha256').update(provenance).digest('hex'), planned.provenance.sha256, contract.provenance);
    const provenanceInputs = contract.derive(JSON.parse(provenance.toString('utf8')));
    const requiredInputs = [...provenanceInputs, ...licenseInputs.map(({ target: _target, ...input }) => input)];
    const expectedIdentities = [
      ...provenanceInputs.map(input => ({ source: input.path, bytes: input.bytes,
        sha256: input.sha256, consumer: contract.provenance })),
      ...licenseInputs.map(input => ({ source: input.path, bytes: input.bytes,
        sha256: input.sha256, consumer: 'license' }))
    ];
    assert.deepEqual(planned.sourceIdentities, expectedIdentities);
    for (const reference of expectedIdentities) {
      const entry = entries.get(sourceIdentity(reference.source, reference.sha256));
      assert.ok(entry, reference.source);
      assert.equal(entry.source, reference.source);
      assert.equal(entry.bytes, reference.bytes);
      assert.ok(entry.consumers.includes(reference.consumer), reference.source);
    }
    const derived = {
      schemaVersion: 1,
      scope: planned.scope,
      provenanceSha256: planned.provenance.sha256,
      requiredInputs
    };
    const generated = await readFile(await assertPlainRepositoryFile(planned.target), 'utf8');
    assert.deepEqual(JSON.parse(generated), derived);
    assert.equal(generated, JSON.stringify(derived, null, 2) + '\n');
  }
});

test('recorded inputs require the exact original path and one consistent recorded digest', () => {
  const entry = manifest.entries.find(value => value.source.endsWith('/LibraryMonitor.cs'));
  const expected = path.resolve(repositoryRoot, entry.target), wrong = '0'.repeat(64);
  assert.equal(recordedInputPath(entry.source, [entry.sha256]), expected);
  assert.equal(recordedInputPath(entry.source.replaceAll('/', '\\').toUpperCase(), [entry.sha256.toUpperCase()]), expected);
  assert.equal(recordedInput(entry.source), null);
  assert.equal(recordedInput(entry.source, [wrong]), null);
  assert.equal(recordedInput(entry.source, [entry.sha256, wrong]), null);
  assert.equal(recordedInput(entry.source, ['invalid']), null);
  assert.equal(recordedInput(entry.source + '.different', [entry.sha256]), null);
  assert.equal(recordedInput(path.win32.basename(entry.source), [entry.sha256]), null);
  assert.equal(recordedInputPath(entry.source, [wrong]), validationPath(entry.source));
});

test('recorded Windows binaries never replace a configured execution tool', () => {
  const entry = manifest.entries.find(value => value.source.endsWith('dotnet.exe'));
  const configured = path.resolve(repositoryRoot, entry.source);
  assert.notEqual(recordedInputPath(entry.source, [entry.sha256]), configured);
  assert.equal(validationPath(entry.source, repositoryRoot, {}), configured);
  assert.equal(validationExecutable('dotnet', { MEDIAMANAGER_DOTNET: entry.source }), configured);
});

test('real inventory discovers both native fixtures and their required evidence manifests', async () => {
  const dependencies = await inventory();
  for (const [filename, fixture] of [
    ['tests/library/library-directory-monitor.test.js', 'library-directory-monitor'],
    ['tests/images/user-view-collage.test.js', 'user-view-collage']
  ]) {
    const entry = dependencies.entries.find(value => value.path === filename);
    assert.ok(entry, filename);
    for (const name of ['provenance.json', 'required-inputs.json']) {
      assert.ok(entry.fixtureReferences.some(reference => reference.relativePath === `./fixtures/${fixture}/${name}`), filename + ': ' + name);
    }
    assert.deepEqual(entry.unresolvedImports, [], filename);
  }
});
