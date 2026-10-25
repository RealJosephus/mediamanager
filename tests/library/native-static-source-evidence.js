import assert from 'node:assert/strict';
import { loadCurrentFilterScenario } from './current-filter-http.js';

export async function readNativeStaticSourcePermissionEvidence() {
  const scenario = await loadCurrentFilterScenario('static-source-permissions');
  assert.equal(scenario.binding.cases.length, 8);
  for (const [index, entry] of scenario.binding.cases.entries()) {
    assert.deepEqual(entry, { name: 'static-source-permissions-' + index, query: 'IncludeItemTypes=Movie', scope: ['alpha'],
      detailKey: 'alpha', maxRating: null, blockUnrated: [], detailExpectedStatus: 200, endpoints: ['detail'],
      transcodingPolicy: { EnableVideoPlaybackTranscoding: Boolean(index & 1), EnableAudioPlaybackTranscoding: Boolean(index & 2),
        EnablePlaybackRemuxing: Boolean(index & 4) } });
  }
  return scenario;
}
