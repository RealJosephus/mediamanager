import { assertNativeByNameFilterOutput, verifyNativeByNameFilterRecording } from '../../tests/library/native-byname-filter-inputs.js';
import { validationPath } from '../validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

await verifyNativeByNameFilterRecording('studio');

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sourceEvidence = '.agent-docs/evidence/byname-filter-inputs/studio-filter-restoration-v1/native-contract.json';
const fixtureInput = 'tests/library/fixtures/studio-filters/input.json';
const trackedFixture = 'tests/library/fixtures/studio-filters/native.json';
const integrityTest = 'tests/library/studio-filter-native-fixture.test.js';
const projector = 'tools/compat/project-studio-filter-fixture.js';
const projectionBinding = 'tests/library/fixtures/studio-filters/projection.json';
const projectionSpec = Object.freeze({
  id: 'studio-filter-native-v1-contract-projection',
  version: 1,
  topLevel: 'Drop only kind and mode; add frozenJellyfin, the exact source path, and its SHA-256; preserve schemaVersion, fixtureInputSha256, endpoints, setup, and cases.',
  cases: 'Preserve every case, response item, JSON field, and array order verbatim. The authoritative contract excludes all runtime-native ids.',
  authority: 'The v1 projection is created only from the pinned main native contract and has no predecessor fixture.',
});

const absolute = relative => validationPath(path.join(repoRoot, relative));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const load = async relative => {
  const bytes = await readFile(absolute(relative));
  return { bytes, value: JSON.parse(bytes) };
};

const main = await load(sourceEvidence);
const input = await load(fixtureInput);
assert.equal(main.value.schemaVersion, 1);
assert.equal(main.value.kind, 'studio-filters-native-contract');
assert.equal(main.value.mode, 'main');
assert.equal(main.value.fixtureInputSha256, sha256(input.bytes));
assert.equal(main.value.setup?.dynamicIdsExcluded, true);

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
