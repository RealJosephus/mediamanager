import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestRuntime } from '../helpers/runtime.js';
import { errorObservation } from '../helpers/error-observation.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { nativeGuid } from '../../src/users/native.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { seedPostgresRuntime } from './postgres-seed.js';
import { recordSyncPlaySlowConnection } from './syncplay-network-scenario.js';

export const requiredValidationServices = ['postgres'];

for (const { name, shutdownWhileBlocked = false, disconnectCaller = false, sessionsWhileBlocked = false } of [
  { name: 'isolates another member and preserves ordered recovery and reconnect' },
  { name: 'retains accepted WS delivery after its real HTTP controller disconnects', disconnectCaller: true },
  { name: 'releases admitted HTTP delivery during runtime shutdown', shutdownWhileBlocked: true },
  { name: 'delivers healthy Sessions playback state beside a stalled subscriber', sessionsWhileBlocked: true }
]) test(`SyncPlay real TCP backpressure ${name} (postgres)`, {
  timeout: 120000,
}, async t => {
  const output = path.join(validationOutputRoot(), 'syncplay-network-' + randomUUID()); await mkdir(output);
  const seedBytes = await readFile(new URL('./fixtures/syncplay/seed.json', import.meta.url));
  const seed = JSON.parse(seedBytes.toString(), (_, value) => value && typeof value === 'object' && '$integer' in value ? BigInt(value.$integer) : value);
  const report = { shutdownWhileBlocked, disconnectCaller, sessionsWhileBlocked, seed: { bytes: seedBytes.length, sha256: createHash('sha256').update(seedBytes).digest('hex') },
    runtimeErrors: [], cleanup: {}, currentNativeCompared: false, phaseAcceptance: false, releaseAcceptance: false };
  let database, runtime, privateRoot, failure, failed = false;
  const cleanupErrors = [];
  try {
    database = await createPostgresTestDatabase(null, 'syncplay_network');
    await seedPostgresRuntime(database, seed);
    if (sessionsWhileBlocked) {
      privateRoot = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-sessions-subscription-'));
      // The real now-playing DTO derives the seed's Genre identities from its
      // program-data path. Give this consumer an owned instance, including a
      // private sibling config directory, without bypassing that projection.
      report.instancePaths = { programDataPath: path.join(privateRoot, 'program'),
        configurationDirectoryPath: path.join(privateRoot, 'config'), dataPath: path.join(privateRoot, 'program/data'),
        metadataPath: path.join(privateRoot, 'program/metadata'), cachePath: path.join(privateRoot, 'program/cache') };
    }
    runtime = await createTestRuntime({ database, ...report.instancePaths,
      configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
      serverId: 'syncplay-network', onError: error => report.runtimeErrors.push(errorObservation(error)) });
    await recordSyncPlaySlowConnection({ runtime, signal: t.signal, report, shutdownWhileBlocked, disconnectCaller, sessionsWhileBlocked,
      readUserData: (userId, itemId) => database.rows('UserData', { where: { UserId: nativeGuid(userId), ItemId: nativeGuid(itemId) } }) });
  } catch (error) { failed = true; failure = error; report.failed = true; report.failure = errorObservation(error); }
  finally {
    for (const [name, action] of [
      ['runtime', async () => { await runtime?.close(); if (runtime) assert.ok(runtime.networkHost.listeners.every(entry => !entry.server.listening)); }],
      ['postgres', () => dropPostgresTestDatabase(database)],
      ...(privateRoot ? [['private-state', async () => {
        if (report.cleanup.runtime !== true) throw new Error('The private instance is retained because runtime cleanup did not complete.');
        const resolved = await realpath(privateRoot), temporaryRoot = await realpath(os.tmpdir());
        assert.equal(path.dirname(resolved), temporaryRoot);
        assert.ok(path.basename(resolved).startsWith('mediamanager-sessions-subscription-'));
        await rm(resolved, { recursive: true, force: true });
      }]] : [])
    ]) {
      try { await action(); report.cleanup[name] = true; }
      catch (error) { cleanupErrors.push(error); report.cleanup[name] = errorObservation(error); }
    }
    const tokens = report.tokens ?? []; delete report.tokens;
    let serialized = stringifyNativeJson(report);
    for (const secret of [...tokens, process.env.MEDIAMANAGER_TEST_POSTGRES]) if (secret) serialized = serialized.replaceAll(secret, '[credential redacted]');
    try { await writeFile(path.join(output, 'report.json'), serialized + '\n', { flag: 'wx' }); }
    catch (error) { cleanupErrors.push(error); }
    t.diagnostic(stringifyNativeJson({ output, shutdownWhileBlocked, disconnectCaller, sessionsWhileBlocked, cleanup: report.cleanup, closedClientSockets: report.closedClientSockets }));
  }
  if (failed && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], 'SyncPlay network test and cleanup failed.', { cause: failure });
  if (failed) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'SyncPlay network test cleanup failed.', { cause: cleanupErrors[0] });
});
