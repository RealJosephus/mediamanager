import { assertNativeByNameFilterOutput, verifyNativeByNameFilterRecording } from '../../tests/library/native-byname-filter-inputs.js';
import { validationPath } from '../validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

await verifyNativeByNameFilterRecording('artist');

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sourceEvidence = '.test-input/evidence/byname-filter-inputs/artist-filter-restoration-v1/native-contract.json';
const fixtureInput = 'tests/library/fixtures/artist-filters/input.json';
const trackedFixture = 'tests/library/fixtures/artist-filters/native.json';
const integrityTest = 'tests/library/artist-filter-native-fixture.test.js';
const projector = 'tools/compat/project-artist-filter-fixture.js';
const projectionBinding = 'tests/library/fixtures/artist-filters/projection.json';
const sideDefinitions = [
  { key: 'unknown-credit', path: '.test-input/evidence/byname-filter-inputs/artist-filter-restoration-unknown-v1/native-contract.json' },
  { key: 'bom-credit', path: '.test-input/evidence/byname-filter-inputs/artist-filter-restoration-bom-credit-v1/native-contract.json' },
  { key: 'request-order', path: '.test-input/evidence/byname-filter-inputs/artist-filter-restoration-request-order-v1/native-contract.json' },
  { key: 'bom-order', path: '.test-input/evidence/byname-filter-inputs/artist-filter-restoration-bom-order-v1/native-contract.json' },
];
const projectionSpec = Object.freeze({
  id: 'artist-filter-native-v2-contract-projection',
  version: 2,
  main: 'Attach the exact source path and SHA-256; copy frozenJellyfin, fixtureInputSha256, endpoints, and cases.',
  sideEffects: 'Project the ordered unknown-credit, bom-credit, request-order, and bom-order contracts with their exact source paths and SHA-256 values.',
  caseTransform: 'Remove only discoveryOnly from every case and preserve every other JSON field and array order verbatim.',
});

const absolute = relative => validationPath(path.join(repoRoot, relative));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const load = async relative => {
  const bytes = await readFile(absolute(relative));
  return { bytes, value: JSON.parse(bytes) };
};
const projectCases = contract => contract.cases.map(({ discoveryOnly, ...entry }) => entry);

const main = await load(sourceEvidence);
const input = await load(fixtureInput);
const sides = await Promise.all(sideDefinitions.map(async definition => ({ ...definition, ...await load(definition.path) })));
assert.equal(main.value.schemaVersion, 2);
assert.equal(main.value.mode, 'main');
assert.ok(main.value.cases.every(entry => entry.discoveryOnly === false));
assert.equal(main.value.fixtureInputSha256, sha256(input.bytes));
for (const side of sides) assert.equal(side.value.fixtureInputSha256, main.value.fixtureInputSha256, side.key);

const projected = {
  schemaVersion: 2,
  frozenJellyfin: main.value.frozenJellyfin,
  sourceEvidence,
  sourceEvidenceSha256: sha256(main.bytes),
  fixtureInputSha256: main.value.fixtureInputSha256,
  endpoints: main.value.endpoints,
  cases: projectCases(main.value),
  sideEffects: sides.map(side => ({
    key: side.key,
    sourceEvidence: side.path,
    sourceEvidenceSha256: sha256(side.bytes),
    frozenJellyfin: side.value.frozenJellyfin,
    mode: side.value.mode,
    fixtureInputSha256: side.value.fixtureInputSha256,
    endpoints: side.value.endpoints,
    cases: projectCases(side.value),
  })),
};
await writeFile(assertNativeByNameFilterOutput(absolute(trackedFixture)), `${JSON.stringify(projected)}\n`);

const fixtureBytes = await readFile(absolute(trackedFixture));
const testBytes = await readFile(absolute(integrityTest));
const projectorBytes = await readFile(absolute(projector));
const binding = {
  schemaVersion: 1,
  projectionLogic: { spec: projectionSpec, sha256: sha256(JSON.stringify(projectionSpec)) },
  authoritativeContract: { path: sourceEvidence, sha256: sha256(main.bytes) },
  sideContracts: sides.map(side => ({ key: side.key, path: side.path, sha256: sha256(side.bytes) })),
  fixtureInput: { path: fixtureInput, sha256: sha256(input.bytes) },
  trackedFixture: { path: trackedFixture, sha256: sha256(fixtureBytes) },
  integrityTest: { path: integrityTest, sha256: sha256(testBytes) },
  projector: { path: projector, sha256: sha256(projectorBytes) },
};
await writeFile(assertNativeByNameFilterOutput(absolute(projectionBinding)), `${JSON.stringify(binding, null, 2)}\n`);
console.log(JSON.stringify({ cases: projected.cases.length, sideEffects: projected.sideEffects.length, fixtureSha256: sha256(fixtureBytes) }));
