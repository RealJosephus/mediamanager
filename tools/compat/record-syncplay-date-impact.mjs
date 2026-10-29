// Record the original six Ready cases against this workflow's actual reference.
// Historical recordings remain archived; no expected response is an input.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { nativeModel } from '../../src/database/model.js';
import { databaseDigest } from '../../src/migration/database-transfer.js';
import { describeFile } from '../validation/inventory.js';
import { assertIsolatedOutput, assertValidationOutputChild } from '../validation/paths.js';
import { currentNativeReference } from './current-native-reference.js';
import { normalizeSyncPlayDateImpact, recordSyncPlayDateImpact } from '../../tests/sessions/syncplay-date-impact-scenario.js';

export const dateImpactJson = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? { $integer: entry.toString() } : entry, 2) + '\n';

export async function datePersistenceMatches(database, values) {
  const matches = [];
  for (const table of nativeModel.tables) {
    for (let offset = 0;;) {
      const rows = await database.rows(table.name, { limit: 500, offset });
      for (const row of rows) for (const value of values) if (dateImpactJson(row).includes(value)) matches.push({ table: table.name, value });
      if (rows.length < 500) break;
      offset += rows.length;
    }
  }
  return matches;
}

async function availablePort(port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => port && error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.listen(port, '127.0.0.1', () => {
      const chosen = server.address().port;
      server.close(error => error ? reject(error) : resolve(port ? true : chosen));
    });
  });
}

export async function recordCurrentSyncPlayDateImpact({ privateRoot, outputRoot }) {
  assertIsolatedOutput(privateRoot);
  assertValidationOutputChild(outputRoot);
  await mkdir(outputRoot, { recursive: false });
  const current = await currentNativeReference();
  const referenceRoot = path.join(privateRoot, 'reference');
  await cp(current.sourceRoot, referenceRoot, { recursive: true, force: false, errorOnExist: true });
  const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
  await current.prepareClone(referenceRoot, port);
  const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
  const source = new SqliteDatabase(databasePath);
  let username;
  try {
    username = source.rows('Users', { where: { Id: current.userId } })[0].Username;
    // Retain the original two-hour queue item's duration; no media is decoded.
    source.update('BaseItems', { Id: '22222222-2222-2222-2222-222222222222' }, { RunTimeTicks: 72000000000n });
  } finally { source.close(); }
  const credentials = { username, password: randomUUID() };
  const preRequestDatabase = path.join(privateRoot, 'before-requests.db');
  const actualWhens = [], stages = { cases: [] };
  const receipt = { source: current.preparation,
    recorder: await describeFile(fileURLToPath(import.meta.url)),
    scenario: await describeFile(fileURLToPath(new URL('../../tests/sessions/syncplay-date-impact-scenario.js', import.meta.url))),
    nativeSources: await current.sourceBindings(['MediaBrowser.Controller/SyncPlay/GroupStates/WaitingGroupState.cs',
      'Emby.Server.Implementations/SyncPlay/Group.cs', 'Jellyfin.Api/Controllers/SyncPlayController.cs',
      'Emby.Server.Implementations/Session/SessionManager.cs', 'Emby.Server.Implementations/Session/WebSocketController.cs']),
    credentialsRecorded: false, historicalRecordingReused: false, phaseAcceptance: false };
  const snapshot = async callback => {
    const database = new SqliteDatabase(databasePath, { readOnly: true });
    try { return await callback(database); } finally { database.close(); }
  };
  const request = async (route, body) => {
    const response = await fetch(origin + route, { method: 'POST', headers: {
      Authorization: `MediaBrowser Token="${current.accessToken}"`, 'Content-Type': 'application/json',
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    await response.body?.cancel();
    return response.status;
  };
  let referenceProcess, raw, contract, failure;
  try {
    referenceProcess = current.start({ referenceRoot, outputRoot: privateRoot, label: 'native', origin });
    await referenceProcess.ready();
    // Administrator self-update without an explicit target follows the real API.
    assert.equal(await request('/Users/Password', { NewPw: credentials.password }), 204);
    await snapshot(database => database.snapshot(preRequestDatabase));
    receipt.preRequestDatabase = await describeFile(preRequestDatabase);
    raw = await recordSyncPlayDateImpact(origin, { credentials,
      async onAuthenticated() { stages.afterAuthentication = await snapshot(databaseDigest); },
      async onBeforeTargetReady(entry) { actualWhens.push(entry.actualWhen); },
      async onAfterTargetReady(entry) { stages.cases.push({ name: entry.name, database: await snapshot(databaseDigest) }); },
      async onCompleted() {
        stages.afterCases = await snapshot(databaseDigest);
        stages.persistenceMatches = await snapshot(database => datePersistenceMatches(database, actualWhens));
      },
    });
    contract = normalizeSyncPlayDateImpact(raw);
    for (const stage of stages.cases) assert.deepEqual(stage.database, stages.afterAuthentication, stage.name);
    assert.deepEqual(stages.afterCases, stages.afterAuthentication);
    assert.deepEqual(stages.persistenceMatches, []);
  } catch (error) { failure = error; }
  finally {
    if (referenceProcess) {
      try {
        receipt.process = await referenceProcess.stop(() => request('/System/Shutdown'), () => availablePort(port));
        assert.equal(receipt.process.cleanShutdown, true);
        assert.equal(receipt.process.pidGone, true);
        assert.equal(receipt.process.portAvailable, true);
        await current.finish();
        stages.afterShutdown = await snapshot(databaseDigest);
        const before = new Map(stages.afterCases?.map(table => [table.name, table]));
        for (const table of stages.afterShutdown) if (table.name !== 'ActivityLogs' && before.has(table.name)) {
          assert.deepEqual(table, before.get(table.name), `shutdown:${table.name}`);
        }
      } catch (error) { failure = failure ? new AggregateError([failure, error], 'Native Ready scenario and cleanup failed.') : error; }
    }
    const secrets = [current.accessToken, credentials.password];
    const redact = text => secrets.reduce((value, secret) => value.replaceAll(secret, '[isolated credential redacted]'), text);
    for (const name of ['native-stdout.log', 'native-stderr.log']) {
      try { await writeFile(path.join(outputRoot, name), redact(await readFile(path.join(privateRoot, name), 'utf8')), { flag: 'wx' }); }
      catch (error) { if (error.code !== 'ENOENT') failure ??= error; }
    }
    receipt.failure = failure ? { message: failure.message, stack: failure.stack } : null;
    await writeFile(path.join(outputRoot, 'native.json'), redact(dateImpactJson({ receipt, raw, contract, stages, actualWhens })), { flag: 'wx' });
  }
  if (failure) throw failure;
  return { contract, preRequestDatabase, referenceRoot, credentials, receipt };
}
