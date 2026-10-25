import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadCurrentFilterScenario, readCurrentFilterBoundFile } from './current-filter-http.js';

const bindingUrl = new URL('./fixtures/filter-http-current/static-audio-binding.json', import.meta.url);
const fixtureRoot = new URL('./fixtures/filter-http-current/', import.meta.url);

export async function verifyNativeStaticAudioSourcePermissionBinding(binding) {
  const expectedCases = Array.from({ length: 8 }, (_, index) => ({
    name: 'static-audio-source-permissions-' + index, query: 'IncludeItemTypes=Audio', scope: ['alpha'],
    detailKey: 'alpha', maxRating: null, blockUnrated: [], detailExpectedStatus: 200, endpoints: ['detail'],
    transcodingPolicy: { EnableVideoPlaybackTranscoding: Boolean(index & 1),
      EnableAudioPlaybackTranscoding: Boolean(index & 2), EnablePlaybackRemuxing: Boolean(index & 4) },
  }));
  assert.equal(binding.kind, 'same-workflow-current-native-static-audio');
  assert.equal(binding.historicalRecordingReused, false);
  assert.deepEqual(binding.cases, expectedCases, 'Static Audio matrix inputs');
  const boundJson = async descriptor => JSON.parse(await readCurrentFilterBoundFile(descriptor, 'Static Audio input hash'));
  assert.equal(fileURLToPath(new URL(binding.originalNeutralFixture.filename, fixtureRoot)),
    fileURLToPath(new URL('./fixtures/rating-permissions/input.json', import.meta.url)));
  const originalFixture = await boundJson(binding.originalNeutralFixture), fixture = await boundJson(binding.neutralFixture);
  assert.deepEqual(fixture, { ...originalFixture, items: originalFixture.items.map(item => item.key === 'alpha'
    ? { ...item, type: 'Audio', mediaType: 'Audio' } : item) },
  'Static Audio neutral fixture must contain only the declared input changes');
  assert.equal(binding.neutralFixture.filename, 'audio-input.json', 'Static Audio neutral fixture');
  assert.equal(binding.nativeRecorder.filename, 'record-native.js');
  await readCurrentFilterBoundFile(binding.nativeRecorder, 'Static Audio recorder hash');
  assert.equal(binding.requestMatrix.filename, 'scenario.js');
  await readCurrentFilterBoundFile(binding.requestMatrix, 'Static Audio request matrix hash');
  return { binding, fixture };
}

export async function readNativeStaticAudioSourcePermissionEvidence() {
  const binding = JSON.parse(await readFile(bindingUrl, 'utf8'));
  const verified = await verifyNativeStaticAudioSourcePermissionBinding(binding);
  const scenario = await loadCurrentFilterScenario('static-audio-source');
  assert.deepEqual(scenario.binding.cases, binding.cases);
  assert.deepEqual(scenario.fixture, verified.fixture);
  for (const run of scenario.runs) for (const [index, entry] of run.nativeHttp.records.entries()) {
    const body = entry.response.bodyJson;
    assert.equal(body.Type, 'Audio'); assert.equal(body.MediaType, 'Audio');
    assert.equal(body.MediaSources.length, 1);
    assert.equal(body.MediaSources[0].SupportsTranscoding, Boolean(index & 2));
    assert.equal(body.MediaSources[0].SupportsDirectStream, true);
    assert.equal(body.MediaSources[0].SupportsDirectPlay, true);
  }
  return { ...scenario, binding };
}
