import { readNativeQueryRecorderSource } from './native-query-inputs.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import { verifyNativeItemFilterEvidenceContract } from './native-item-filter-evidence.js';
import { describeFile } from '../../tools/validation/inventory.js';

const bindingUrl = new URL('./fixtures/native-query-inputs/static-audio-source-permissions.json', import.meta.url);
const originalFixtureUrl = new URL('./fixtures/rating-permissions/input.json', import.meta.url);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function boundJson(descriptor) {
  const bytes = await readFile(descriptor.filename);
  assert.equal(sha(bytes), descriptor.sha256, 'Static Audio input hash: ' + descriptor.filename);
  return JSON.parse(bytes);
}

export async function verifyNativeStaticAudioSourcePermissionBinding(binding) {
  const expectedCases = Array.from({ length: 8 }, (_, index) => ({
    name: 'static-audio-source-permissions-' + index, query: 'IncludeItemTypes=Audio', scope: ['alpha'],
    detailKey: 'alpha', maxRating: null, blockUnrated: [], detailExpectedStatus: 200, endpoints: ['detail'],
    transcodingPolicy: { EnableVideoPlaybackTranscoding: Boolean(index & 1),
      EnableAudioPlaybackTranscoding: Boolean(index & 2), EnablePlaybackRemuxing: Boolean(index & 4) },
  }));
  assert.deepEqual(binding.cases, expectedCases, 'Static Audio matrix inputs');
  assert.equal(binding.recordings.length, 2, 'Two independent Audio recordings are required');
  assert.equal(path.resolve(binding.originalNeutralFixture.filename), fileURLToPath(originalFixtureUrl));
  const originalFixture = await boundJson(binding.originalNeutralFixture);
  const fixture = await boundJson(binding.neutralFixture);
  assert.deepEqual(fixture, { ...originalFixture, items: originalFixture.items.map(item => item.key === 'alpha'
    ? { ...item, type: 'Audio', mediaType: 'Audio' } : item) },
  'Static Audio neutral fixture must contain only the declared input changes');
  assert.equal(path.resolve(repoRoot, binding.recorderFixtureRelative), path.resolve(binding.neutralFixture.filename));
  const audit = await boundJson(binding.independentAudit);
  for (const key of ['passed', 'recipeIndependentlyReconstructed', 'originalPreparationAndArtifactGuardsRetained',
    'allSourceAndArtifactHashesVerified', 'completeNativeHttpBodiesByteEqual', 'candidateFullDetailBodiesEqual'])
    assert.equal(audit[key], true, 'Static Audio independent audit: ' + key);
  assert.deepEqual(audit.neutralFixture, binding.neutralFixture);
  assert.deepEqual(audit.repetitions.map(entry => entry.root), binding.recordings.map(entry => entry.evidenceRoot));
  const original = await readNativeQueryRecorderSource();
  const declaration = parse(original, { sourceType: 'module', ecmaVersion: 'latest' }).body
    .flatMap(node => node.declarations ?? []).find(node => node.id.name === 'RATING_PERMISSION_CASES');
  assert.ok(declaration?.init);
  let recipe = original.slice(0, declaration.init.start) + JSON.stringify(binding.cases, null, 2) + original.slice(declaration.init.end);
  const replaceOnce = (marker, replacement) => {
    assert.equal(recipe.split(marker).length, 2, 'Exact static Audio recipe marker: ' + marker);
    recipe = recipe.replace(marker, replacement);
  };
  replaceOnce('    cases: RATING_PERMISSION_CASES,\n    expectedRecords: 36,',
    '    cases: RATING_PERMISSION_CASES,\n    expectedRecords: 8,');
  replaceOnce("    fixture: 'tests/library/fixtures/rating-permissions/input.json',",
    `    fixture: '${binding.recorderFixtureRelative}',`);
  replaceOnce("      Folder: 'MediaBrowser.Controller.Entities.Folder',",
    "      Folder: 'MediaBrowser.Controller.Entities.Folder',\n      Audio: 'MediaBrowser.Controller.Entities.Audio.Audio',");
  replaceOnce('        ...basePolicy,\n        ...(scenarioName',
    '        ...basePolicy,\n        ...testCase.transcodingPolicy,\n        ...(scenarioName');
  const observation = `    const effectiveUser = await request(origin, \`/Users/\${userId}\`, { token });
    assert.equal(effectiveUser.status, 200);
    for (const [key, expected] of Object.entries(testCase.transcodingPolicy))
      assert.equal(effectiveUser.bodyJson.Policy[key], expected, testCase.name + ':' + key);
    setupRecords.push({ name: testCase.name, kind: 'static-source-policy-readback',
      status: effectiveUser.status, requestedPolicy: testCase.transcodingPolicy,
      effectivePolicy: Object.fromEntries(Object.keys(testCase.transcodingPolicy)
        .map(key => [key, effectiveUser.bodyJson.Policy[key]])) });
`;
  replaceOnce('    const databaseBeforeCaseReads = completeDatabaseSnapshot();',
    observation + '    const databaseBeforeCaseReads = completeDatabaseSnapshot();');
  const runs = [];
  for (const [repetition, recording] of binding.recordings.entries()) {
    assert.equal(recording.directory.path, recording.evidenceRoot);
    const current = await describeFile(recording.directory.path);
    assert.equal(current.available, true);
    assert.equal(current.entriesSha256, recording.directory.entriesSha256, 'Current static Audio recording directory');
    assert.equal(audit.repetitions[repetition].directory.entriesSha256, recording.directory.entriesSha256);
    const oracle = await boundJson(recording.oracle);
    const run = await verifyNativeItemFilterEvidenceContract({
      evidence: pathToFileURL(path.join(recording.evidenceRoot, 'native-run/')),
      fixtureUrl: pathToFileURL(binding.neutralFixture.filename), scenario: 'rating-permissions',
      runDirectory: 'native-run', expectedRecords: 8, recorderSource: recipe,
    });
    assert.deepEqual(run.oracle, oracle);
    assert.equal(run.summary.cases, 8);
    assert.equal(run.summary.scenarioDefinitionSha256, binding.scenarioDefinitionSha256);
    const setup = JSON.parse(await readFile(path.join(recording.evidenceRoot, 'native-run/setup-http.json')));
    const readbacks = setup.records.filter(entry => entry.kind === 'static-source-policy-readback');
    assert.equal(readbacks.length, 8);
    for (const [index, entry] of readbacks.entries()) {
      assert.equal(entry.name, binding.cases[index].name); assert.equal(entry.status, 200);
      assert.deepEqual(entry.requestedPolicy, binding.cases[index].transcodingPolicy);
      assert.deepEqual(entry.effectivePolicy, entry.requestedPolicy);
      const body = run.nativeHttp.records[index].response.bodyJson;
      assert.equal(body.Type, 'Audio'); assert.equal(body.MediaType, 'Audio');
      assert.equal(body.MediaSources.length, 1);
      assert.equal(body.MediaSources[0].SupportsTranscoding, Boolean(index & 2));
      assert.equal(body.MediaSources[0].SupportsDirectStream, true);
      assert.equal(body.MediaSources[0].SupportsDirectPlay, true);
    }
    runs.push(run);
  }
  assert.deepEqual(runs[0].nativeHttp.records, runs[1].nativeHttp.records);
  return { binding, fixture, nativeHttp: runs[0].nativeHttp };
}

export async function readNativeStaticAudioSourcePermissionEvidence() {
  return verifyNativeStaticAudioSourcePermissionBinding(JSON.parse(await readFile(bindingUrl)));
}
