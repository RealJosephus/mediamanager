import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeModel } from '../../src/database/model.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { databaseDigest } from '../../src/migration/database-transfer.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { assertSyncPlayDateImpactContract, normalizeSyncPlayDateImpact, recordSyncPlayDateImpact } from './syncplay-date-impact-scenario.js';
import { seedPostgresRuntime } from './postgres-seed.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { dateImpactJson, datePersistenceMatches, recordCurrentSyncPlayDateImpact } from '../../tools/compat/record-syncplay-date-impact.mjs';

const enabled = process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES;

test('SyncPlay minimum-year Ready guard matches current native HTTP/WebSocket behavior and persistence', { skip: !enabled, timeout: 180000 }, async () => {
  const output = path.join(validationOutputRoot(), 'syncplay-date-impact');
  await mkdir(output, { recursive: false });
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-syncplay-date-'));
  let native, database, runtime, failure;
  const errors = [], actualWhens = [], stages = [];
  const report = { credentialsRecorded: false, historicalRecordingReused: false, phaseAcceptance: false };
  try {
    native = await recordCurrentSyncPlayDateImpact({ privateRoot, outputRoot: path.join(output, 'native') });
    const source = new SqliteDatabase(native.preRequestDatabase, { readOnly: true });
    const seed = {};
    try { for (const table of nativeModel.tables) seed[table.name] = source.rows(table.name); }
    finally { source.close(); }
    database = await createPostgresTestDatabase(null, 'syncplay_date');
    await seedPostgresRuntime(database, seed);
    const settings = await readInstanceConfiguration(native.referenceRoot);
    const networkConfiguration = { ...settings.networkConfiguration, InternalHttpPort: 0,
      LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false, EnablePublishedServerUriByRequest: true };
    report.nodeNetworkInput = networkConfiguration;
    runtime = await createTestRuntime({ ...settings, networkConfiguration, database, autoDiscoveryOptions: { enabled: false },
      onError: error => errors.push({ status: error.status, message: error.message }) });
    const raw = await recordSyncPlayDateImpact(`http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`, {
      credentials: native.credentials,
      async onAuthenticated() { report.before = await databaseDigest(database); },
      async onBeforeTargetReady(entry) { actualWhens.push(entry.actualWhen); },
      async onAfterTargetReady(entry) { stages.push({ name: entry.name, database: await databaseDigest(database) }); },
      async onCompleted() {
        report.after = await databaseDigest(database);
        report.persistenceMatches = await datePersistenceMatches(database, actualWhens);
        // Complete the real close handshake before the fixture terminates sockets.
        await runtime.webSockets.close();
        report.afterSocketShutdown = await databaseDigest(database);
      },
    });
    report.raw = raw;
    report.contract = normalizeSyncPlayDateImpact(raw);
    assertSyncPlayDateImpactContract(report.contract, native.contract);
    assert.equal(stages.length, 6);
    for (const stage of stages) assert.deepEqual(stage.database, report.before, stage.name);
    assert.deepEqual(report.after, report.before);
    assert.deepEqual(report.afterSocketShutdown, report.before);
    assert.deepEqual(report.persistenceMatches, []);
    assert.deepEqual(errors, []);
    // Prove the public comparison still detects changed state/command/echo behavior.
    for (const mutate of [value => { value.cases[0].result.command = 'Seek'; },
      value => { value.cases[1].result.state = 'Waiting'; },
      value => { value.cases[2].result.requestWhenEchoed = true; }]) {
      const changed = structuredClone(native.contract); mutate(changed);
      assert.throws(() => assertSyncPlayDateImpactContract(changed, native.contract), assert.AssertionError);
    }
  } catch (error) { failure = error; }
  finally {
    const cleanup = [];
    for (const close of [async () => { if (runtime) { await runtime.syncPlay.drain(); await runtime.close(); } },
      () => dropPostgresTestDatabase(database), async () => {
        assert.equal(path.dirname(privateRoot), os.tmpdir());
        assert.ok(path.basename(privateRoot).startsWith('mediamanager-syncplay-date-'));
        await rm(privateRoot, { recursive: true, force: true });
      }]) try { await close(); } catch (error) { cleanup.push(error); }
    report.stages = stages; report.actualWhens = actualWhens; report.errors = errors;
    report.runtimeListenersAfterClose = runtime?.networkHost.listeners.map(entry => ({ scheme: entry.scheme,
      address: entry.address, port: entry.port, listening: entry.server.listening }));
    report.failure = failure ? { message: failure.message, stack: failure.stack } : null;
    report.cleanupErrors = cleanup.map(error => ({ message: error.message, stack: error.stack }));
    let serialized = dateImpactJson(report);
    for (const secret of [process.env.MEDIAMANAGER_TEST_POSTGRES, native?.credentials.password]) {
      if (secret) serialized = serialized.replaceAll(secret, '[isolated credential redacted]');
    }
    await writeFile(path.join(output, 'postgres.json'), serialized, { flag: 'wx' });
    if (cleanup.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanup], 'SyncPlay validation or cleanup failed.');
  }
  if (failure) throw failure;
  assert.ok(runtime.networkHost.listeners.every(entry => !entry.server.listening));
});
