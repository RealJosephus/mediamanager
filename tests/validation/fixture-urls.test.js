import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeJavaScriptDependencies, inventory } from '../../tools/validation/inventory.js';
import { captureInputIdentity } from '../../tools/validation/inputs.js';
import { repositoryRoot } from '../../tools/validation/paths.js';

test('static relative JSON URLs retain fixture edges through variables without interpreting DTOs, dynamic bases or shadowed URL', () => {
  const source = `
    const provenanceFile = new URL('../metadata/fixtures/book-comic/rar4-entry/provenance.json', import.meta.url);
    const proof = JSON.parse(await readFile(provenanceFile));
    const resource = new URL('../data/records.json', import.meta.url);
    assert.equal(await readFile(new URL('./data/asserted.json', import.meta.url)), expected);
    const escaped = new URL('./data/sealed%20record.json?raw#metadata', import.meta.url);
    const dto = { Path: '../data/not-an-input.json' };
    const variable = new URL(target, import.meta.url);
    const unbound = new URL('./data/unbound.json', arbitraryBase);
    const external = new URL('https://example.test/remote.json', import.meta.url);
    const rooted = new URL('/tmp/rooted.json', import.meta.url);
    writeFile(new URL('./data/output.json', import.meta.url), '{}');
    assert.equal(identity, new URL('./data/identity.json', import.meta.url));
    // new URL('./data/comment.json', import.meta.url);
  `;
  assert.deepEqual(analyzeJavaScriptDependencies(source).fixtureSpecifiers, [
    '../data/records.json', '../metadata/fixtures/book-comic/rar4-entry/provenance.json',
    './data/asserted.json', './data/sealed%20record.json?raw#metadata',
  ]);
  for (const shadowed of [
    "function read(URL) { return new URL('../data/record.json', import.meta.url); }",
    "const URL = makeUrl; new URL('../data/record.json', import.meta.url);",
    "globalThis.URL = makeUrl; new URL('../data/record.json', import.meta.url);",
    "import.meta.url = other; new URL('../data/record.json', import.meta.url);",
  ]) assert.deepEqual(analyzeJavaScriptDependencies(shadowed).fixtureSpecifiers, [], shadowed);
  const externalEvidence = analyzeJavaScriptDependencies(`
    const bytes = await readFile(new URL('../../.agent-docs/evidence/record.json', import.meta.url));
  `);
  assert.deepEqual(externalEvidence.fixtureSpecifiers, [], 'external evidence retains its existing environment-aware declaration');
  assert.equal(externalEvidence.referenceDeclarations[0].required, true);
});

test('the real RAR entry consumer discovers both manifests and captures their required original inputs before execution', async () => {
  const consumer = 'tests/storage/rar-entry.test.js';
  const dependencies = await inventory();
  const actual = dependencies.entries.find(entry => entry.path === consumer);
  const manifests = actual.fixtureReferences.filter(reference => /\/book-comic\/(?:rar4-entry|rar-directory)\/provenance\.json$/u.test(reference.relativePath));
  assert.equal(manifests.length, 2, 'both cross-directory literal URL declarations are fixture dependencies');
  assert.ok(manifests.every(reference => reference.available && reference.kind === 'file'));
  // Isolate this input boundary from unrelated production imports; retain the
  // actual inventory descriptors and the actual sealed manifest contents.
  const identity = await captureInputIdentity({ selected: [consumer], dependencies: { entries: [{ ...actual,
    imports: [], importedFiles: [], services: [], tools: [], unresolvedImports: [], unresolvedExecutables: [] }] },
  environment: {}, preflight: { ready: true, services: [], tools: [] } });
  for (const manifest of manifests) {
    const proof = JSON.parse(await readFile(manifest.filename, 'utf8'));
    assert.ok(proof.requiredInputs.length > 0);
    for (const descriptor of proof.requiredInputs) {
      assert.equal(descriptor.required, true);
      const required = identity.entries.find(input => input.filename === path.resolve(repositoryRoot, descriptor.path));
      assert.ok(required?.required, descriptor.path);
      assert.ok(required.requiredReasons.length > 0 && required.requiredReasons.every(reason => reason.startsWith(consumer + ':')), descriptor.path);
      assert.ok(required.expectedDigests.includes(descriptor.sha256), descriptor.path);
    }
  }
});
