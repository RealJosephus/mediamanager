import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createTestRuntime } from '../helpers/runtime.js';
import { parseLosslessJson, stringifyNativeJson } from '../../src/core/json.js';
import { createPostgresTestDatabase } from '../database/postgres-fixture.js';
import { recordSyncPlay, normalizeSyncPlay } from './syncplay-scenario.js';
import { recordSyncPlayAccess } from './syncplay-access-scenario.js';
import { recordSyncPlayWait } from './syncplay-wait-scenario.js';
import { seedPostgresRuntime } from './postgres-seed.js';

for (const [name, record, fixture, expectedErrors] of [['protocol', recordSyncPlay, 'reference.json', 2], ['access', recordSyncPlayAccess, 'access-reference.json', 1], ['wait', recordSyncPlayWait, 'wait-reference.json', 0]])
test(`SyncPlay ${name} HTTP and WebSocket reproduce native operations (postgres)`, async t => {
  const seed = JSON.parse(await readFile(new URL('./fixtures/syncplay/seed.json', import.meta.url), 'utf8'), (_, value) => value && typeof value === 'object' && '$integer' in value ? BigInt(value.$integer) : value);
  const database = await createPostgresTestDatabase(t, `syncplay_${name}`);
  await seedPostgresRuntime(database, seed);
  const errors = [];
  const runtime = await createTestRuntime({ database, configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true }, serverId: 'syncplay-test', onError: error => errors.push({ status: error.status, message: error.message }) });
  try {
    let waitClock = 0;
    if (name === 'wait' && !process.env.MEDIAMANAGER_SYNCPLAY_REAL_WAIT) runtime.syncPlay.groupOptions = { monotonic: () => waitClock };
    const actual = await record(`http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`, name === 'wait' && !process.env.MEDIAMANAGER_SYNCPLAY_REAL_WAIT ? {
      advanceWait: async () => { waitClock += 31500; await runtime.syncPlay.checkTimeouts(); await runtime.syncPlay.drain(); }
    } : {});
    const expected = parseLosslessJson(await readFile(new URL(`./fixtures/syncplay/${fixture}`, import.meta.url), 'utf8'));
    const normalizedExpected = normalizeSyncPlay(expected), normalizedActual = normalizeSyncPlay(actual);
    const differences = [];
    for (let index = 0; index < normalizedExpected.length; index++) {
      try { assert.deepEqual(normalizedActual[index], normalizedExpected[index]); }
      catch { differences.push({ name: normalizedExpected[index].name, expected: normalizedExpected[index], actual: normalizedActual[index] }); }
    }
    if (process.env.MEDIAMANAGER_SYNCPLAY_EVIDENCE) {
      await writeFile(`${process.env.MEDIAMANAGER_SYNCPLAY_EVIDENCE}/postgres-${name}.json`, stringifyNativeJson({ actual, differences, errors }), { flag: 'wx' });
    }
    assert.equal(actual.records.length, expected.records.length);
    assert.deepEqual(differences, []);
    assert.equal(errors.length, expectedErrors);
    assert.ok(errors.every(error => error.status === 400));
  } finally {
    await runtime.syncPlay.drain();
    await runtime.close();
  }
});
