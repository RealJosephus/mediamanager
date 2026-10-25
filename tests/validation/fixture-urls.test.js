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
    const bytes = await readFile(new URL('../../.test-input/evidence/record.json', import.meta.url));
  `);
  assert.deepEqual(externalEvidence.fixtureSpecifiers, [], 'external evidence retains its existing environment-aware declaration');
  assert.equal(externalEvidence.referenceDeclarations[0].required, true);
});

test('the current RAR consumer captures its execution manifest and every sealed input before execution', async () => {
  const consumer = 'tests/storage/rar-entry.test.js';
  const dependencies = await inventory();
  const actual = dependencies.entries.find(entry => entry.path === consumer);
  const manifestFilename = path.join(repositoryRoot, 'tests/storage/fixtures/rar-entry-current/current-profile.json');
  const manifest = JSON.parse(await readFile(manifestFilename, 'utf8'));
  assert.ok(manifest.inputs.some(input => input.role === 'archive'), 'The execution manifest includes the actual original archives.');
  // Exercise the selected consumer's execution contract without activating its
  // unrelated production imports or requiring a Native runtime for this read.
  const identity = await captureInputIdentity({ selected: [consumer], dependencies: { entries: [{ ...actual,
    imports: [], importedFiles: [], services: [], tools: [], unresolvedImports: [], unresolvedExecutables: [] }] },
  environment: {}, preflight: { ready: true, services: [], tools: [] } });
  assert.ok(identity.entries.find(input => input.filename === manifestFilename)?.required);
  for (const descriptor of manifest.inputs) {
    const filename = path.resolve(path.dirname(manifestFilename), descriptor.filename);
    const required = identity.entries.find(input => input.filename === filename);
    assert.ok(required?.required, descriptor.filename);
    assert.ok(required.requiredReasons.length > 0 && required.requiredReasons.every(reason => reason.startsWith(consumer + ':')), descriptor.filename);
    assert.ok(required.expectedDigests.includes(descriptor.sha256), descriptor.filename);
  }
});
