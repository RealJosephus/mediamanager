import { assertNativeByNameFilterOutput, verifyNativeByNameFilterRecording } from '../../tests/library/native-byname-filter-inputs.js';
import { validationPath } from '../validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

await verifyNativeByNameFilterRecording('album');

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sourceEvidence = '.agent-docs/evidence/byname-filter-inputs/album-filter-restoration-v1/native-contract.json';
const fixtureInput = 'tests/library/fixtures/album-filters/input.json';
const trackedFixture = 'tests/library/fixtures/album-filters/native.json';
const integrityTest = 'tests/library/album-filter-native-fixture.test.js';
const projector = 'tools/compat/project-album-filter-fixture.js';
const projectionBinding = 'tests/library/fixtures/album-filters/projection.json';
const projectionSpec = Object.freeze({
  id: 'album-filter-native-v7-contract-projection',
  version: 1,
  topLevel: 'Drop only kind and mode; add frozenJellyfin, the exact source path, and its SHA-256; preserve schemaVersion, fixtureInputSha256, endpoints, setup, and cases.',
  cases: 'Preserve every case, response item, JSON field, and array order verbatim. The authoritative contract excludes all runtime-native ids.',
  authority: 'Create the projection only from the pinned main native contract, with complete HTTP, state and source preparation evidence; no legacy development fixture is required.',
});

const absolute = relative => validationPath(path.join(repoRoot, relative));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const load = async relative => {
  const bytes = await readFile(absolute(relative));
  return { bytes, value: JSON.parse(bytes) };
};

const main = await load(sourceEvidence);
const input = await load(fixtureInput);
const summary = await load(sourceEvidence.replace('native-contract.json', 'summary.json'));
const provenance = await load(sourceEvidence.replace('native-contract.json', 'provenance.json'));
assert.equal(main.value.schemaVersion, 1);
assert.equal(main.value.kind, 'album-filters-native-contract');
assert.equal(main.value.mode, 'main');
assert.equal(main.value.fixtureInputSha256, sha256(input.bytes));
assert.equal(main.value.setup?.dynamicIdsExcluded, true);
assert.equal(summary.value.passed, true, 'A failed or partial native recording cannot become expected output.');
assert.equal(summary.value.contractsRecorded, input.value.cases.length);
assert.equal(provenance.value.result.passed, true);
assert.ok(provenance.value.preparedInputs.some(entry => entry.kind === 'nativeReferencePreparation'));
assert.deepEqual(main.value.cases.map(entry => entry.name), input.value.cases.map(entry => entry.name));

const projected = {
  schemaVersion: main.value.schemaVersion,
  frozenJellyfin: true,
  sourceEvidence,
  sourceEvidenceSha256: sha256(main.bytes),
  fixtureInputSha256: main.value.fixtureInputSha256,
  endpoints: main.value.endpoints,
  setup: main.value.setup,
  cases: main.value.cases,
};
await writeFile(assertNativeByNameFilterOutput(absolute(trackedFixture)), `${JSON.stringify(projected)}\n`);

const fixtureBytes = await readFile(absolute(trackedFixture));
const testBytes = await readFile(absolute(integrityTest));
const projectorBytes = await readFile(absolute(projector));
const binding = {
  schemaVersion: 1,
  projectionLogic: { spec: projectionSpec, sha256: sha256(JSON.stringify(projectionSpec)) },
  authoritativeContract: { path: sourceEvidence, sha256: sha256(main.bytes) },
  fixtureInput: { path: fixtureInput, sha256: sha256(input.bytes) },
  trackedFixture: { path: trackedFixture, sha256: sha256(fixtureBytes) },
  integrityTest: { path: integrityTest, sha256: sha256(testBytes) },
  projector: { path: projector, sha256: sha256(projectorBytes) },
};
await writeFile(assertNativeByNameFilterOutput(absolute(projectionBinding)), `${JSON.stringify(binding, null, 2)}\n`);
console.log(JSON.stringify({ cases: projected.cases.length, fixtureSha256: sha256(fixtureBytes) }));
