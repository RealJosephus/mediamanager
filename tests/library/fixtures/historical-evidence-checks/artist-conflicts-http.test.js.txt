import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNativeConflictResult, recordNativeConflictCandidate } from './native-conflict-scenario.js';

const dialects = process.env.MEDIAMANAGER_ARTIST_CONFLICT_DIALECT
  ? [process.env.MEDIAMANAGER_ARTIST_CONFLICT_DIALECT] : ['postgres'];
if (dialects.some(dialect => dialect !== 'postgres')) throw new Error('Invalid Artist conflict dialect.');

test('postgres: Artist name/path conflicts and wrong-type primary key match frozen GET', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const { actual, scenario } = await recordNativeConflictCandidate('artist', process.env.MEDIAMANAGER_TEST_POSTGRES);
  const mutations = [
    value => { value.caseStages[3].database.BaseItems.find(row => row.Name === 'Shadow').Type = 'MediaBrowser.Controller.Entities.Movies.Movie'; },
    value => { value.caseStages[3].database.BaseItems.find(row => row.Name === 'Shadow').RunTimeTicks = 1n; },
    value => { value.caseStages[3].database.BaseItems.find(row => row.Name === 'Shadow').Unexpected = null; },
    value => { value.caseStages[3].database.BaseItems.find(row => row.Name === 'Shadow').DateCreated = '2026-01-01 00:00:00'; },
    value => { value.blockedFiles[3].sha256 = '0'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(actual);
    mutate(changed);
    assert.throws(() => assertNativeConflictResult(changed, scenario));
  }
});
