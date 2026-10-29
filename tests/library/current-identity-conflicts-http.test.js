import test from 'node:test';
import assert from 'node:assert/strict';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { compareCurrentConflicts, assertCurrentConflictResult } from '../helpers/current-conflict-scenario.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE), port: 19502 });

for (const kind of ['artist', 'studio']) test(`postgres: current native ${kind} path conflicts, blocked file and wrong-type replacement`, {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE, timeout: 600000,
}, nativeCallback(async (t, port) => {
  const { actual, scenario, interval } = await compareCurrentConflicts(kind, { port, signal: t.signal });
  for (const mutate of [
    value => { value.caseStages[3].database.BaseItems.find(row => row.Name === 'Shadow').Type = 'MediaBrowser.Controller.Entities.Movies.Movie'; },
    value => { value.caseStages[3].database.BaseItems.find(row => row.Name === 'Shadow').RunTimeTicks = 1n; },
    value => { value.caseStages[3].database.BaseItems.find(row => row.Name === 'Shadow').Unexpected = null; },
    value => { value.caseStages[3].database.BaseItems.find(row => row.Name === 'Shadow').DateCreated = '2026-01-01 00:00:00'; },
    value => { value.blockedFiles[3].sha256 = '0'.repeat(64); },
  ]) {
    const changed = structuredClone(actual);
    mutate(changed);
    assert.throws(() => assertCurrentConflictResult(changed, scenario, interval));
  }
}));
