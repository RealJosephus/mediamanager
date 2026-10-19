import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import manifest from '../../tools/validation/recorded-inputs.json' with { type: 'json' };
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
  const source = JSON.parse(await readFile(new URL(sourcePackage.sourceManifest.path, sourcePackageUrl)));
  const modifications = JSON.parse(await readFile(new URL(sourcePackage.localModifications.path, sourcePackageUrl)));
  assert.equal(source.files.length, 2620); assert.equal(sourcePackage.sourceFiles, source.files.length);
  assert.equal(modifications.entries.length, 20); assert.equal(sourcePackage.localModificationFiles, modifications.entries.length);
  assert.equal(source.contentDigest, sourcePackage.sourceContentDigest);
  assert.deepEqual(sourcePackage.excludedSourceFiles, []);
  assert.equal(sourcePackage.audit.archiveMemberDigestsMatched, true);
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
