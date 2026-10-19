import { readNativeQueryRecorderSource } from './native-query-inputs.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { verifyNativeItemFilterEvidenceContract } from './native-item-filter-evidence.js';
import { describeFile } from '../../tools/validation/inventory.js';

const bindingUrl = new URL('./fixtures/native-query-inputs/static-source-permissions.json', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function boundJson(descriptor) {
  const bytes = await readFile(descriptor.filename);
  assert.equal(sha(bytes), descriptor.sha256);
  return JSON.parse(bytes);
}
export async function readNativeStaticSourcePermissionEvidence() {
  const binding = JSON.parse(await readFile(bindingUrl));
  assert.equal(binding.neutralFixture, ['tests', 'library', 'fixtures', 'rating-permissions', 'input.json'].join('/'));
  assert.equal(binding.cases.length, 8); assert.equal(binding.recordings.length, 2);
  for (const [index, entry] of binding.cases.entries()) {
    assert.deepEqual(entry, { name: 'static-source-permissions-' + index, query: 'IncludeItemTypes=Movie', scope: ['alpha'],
      detailKey: 'alpha', maxRating: null, blockUnrated: [], detailExpectedStatus: 200, endpoints: ['detail'],
      transcodingPolicy: { EnableVideoPlaybackTranscoding: Boolean(index & 1), EnableAudioPlaybackTranscoding: Boolean(index & 2),
        EnablePlaybackRemuxing: Boolean(index & 4) } });
  }
  const audit = await boundJson(binding.independentAudit);
  assert.equal(audit.passed, true); assert.equal(audit.allSourceAndArtifactHashesVerified, true);
  assert.equal(audit.completeNativeHttpBodiesByteEqual, true); assert.equal(audit.candidateFullDetailBodiesEqual, true);
  const original = await readNativeQueryRecorderSource();
  const declaration = parse(original, { sourceType: 'module', ecmaVersion: 'latest' }).body
    .flatMap(node => node.declarations ?? []).find(node => node.id.name === 'RATING_PERMISSION_CASES');
  assert.ok(declaration?.init);
  let recipe = original.slice(0, declaration.init.start) + JSON.stringify(binding.cases, null, 2) + original.slice(declaration.init.end);
  const countMarker = '    cases: RATING_PERMISSION_CASES,\n    expectedRecords: 36,';
  assert.equal(recipe.split(countMarker).length, 2);
  recipe = recipe.replace(countMarker, '    cases: RATING_PERMISSION_CASES,\n    expectedRecords: 8,');
  const policyMarker = '        ...basePolicy,\n        ...(scenarioName';
  assert.equal(recipe.split(policyMarker).length, 2);
  recipe = recipe.replace(policyMarker, '        ...basePolicy,\n        ...testCase.transcodingPolicy,\n        ...(scenarioName');
  const readMarker = '    const databaseBeforeCaseReads = completeDatabaseSnapshot();';
  assert.equal(recipe.split(readMarker).length, 2);
  const observation = `    const effectiveUser = await request(origin, \`/Users/\${userId}\`, { token });
    assert.equal(effectiveUser.status, 200);
    for (const [key, expected] of Object.entries(testCase.transcodingPolicy))
      assert.equal(effectiveUser.bodyJson.Policy[key], expected, testCase.name + ':' + key);
    setupRecords.push({ name: testCase.name, kind: 'static-source-policy-readback',
      status: effectiveUser.status, requestedPolicy: testCase.transcodingPolicy,
      effectivePolicy: Object.fromEntries(Object.keys(testCase.transcodingPolicy)
        .map(key => [key, effectiveUser.bodyJson.Policy[key]])) });
`;
  recipe = recipe.replace(readMarker, observation + readMarker);
  const runs = [];
  for (const recording of binding.recordings) {
    assert.equal(recording.directory.path, recording.evidenceRoot);
    assert.match(recording.directory.entriesSha256, /^[a-f0-9]{64}$/u);
    const currentDirectory = await describeFile(recording.directory.path);
    assert.equal(currentDirectory.available, true);
    assert.equal(currentDirectory.entriesSha256, recording.directory.entriesSha256);
    const oracle = await boundJson(recording.oracle);
    const run = await verifyNativeItemFilterEvidenceContract({ evidence: pathToFileURL(path.join(recording.evidenceRoot, 'native-run/')),
      fixtureUrl: new URL('./fixtures/rating-permissions/input.json', import.meta.url), scenario: 'rating-permissions',
      runDirectory: 'native-run', expectedRecords: 8, recorderSource: recipe });
    assert.deepEqual(run.oracle, oracle); assert.equal(run.summary.cases, 8);
    const setup = JSON.parse(await readFile(path.join(recording.evidenceRoot, 'native-run/setup-http.json')));
    const readbacks = setup.records.filter(entry => entry.kind === 'static-source-policy-readback');
    assert.equal(readbacks.length, 8);
    for (const [index, entry] of readbacks.entries()) {
      assert.equal(entry.name, binding.cases[index].name); assert.equal(entry.status, 200);
      assert.deepEqual(entry.requestedPolicy, binding.cases[index].transcodingPolicy);
      assert.deepEqual(entry.effectivePolicy, entry.requestedPolicy);
    }
    runs.push(run);
  }
  assert.deepEqual(runs[0].nativeHttp.records, runs[1].nativeHttp.records);
  assert.equal(runs[0].summary.scenarioDefinitionSha256, runs[1].summary.scenarioDefinitionSha256);
  return { binding, nativeHttp: runs[0].nativeHttp };
}
