import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import manifest from '../../tools/validation/recorded-inputs.json' with { type: 'json' };
import { designatedJellyfinContentDigest, designatedJellyfinDirtyFiles, designatedJellyfinHead,
  designatedJellyfinSourceFiles, validateDesignatedJellyfinSourceDocuments,
  verifyDesignatedJellyfinSourcePackage } from '../../tools/validation/designated-jellyfin-source.js';
import { inventory } from '../../tools/validation/inventory.js';
import { recordedInput, recordedInputPath, repositoryRoot, validationExecutable, validationPath } from '../../tools/validation/paths.js';

const sourcePackageUrl = new URL('../fixtures/recorded-native/jellyfin-source-package.json', import.meta.url);
const sourcePackage = JSON.parse(await readFile(sourcePackageUrl));

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
