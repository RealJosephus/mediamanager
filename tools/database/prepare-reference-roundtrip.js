import { validationPath } from '../validation/paths.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { createStatePackage, restoreStatePackage } from '../../src/migration/state-package.js';
import { createIsolatedOfflineCopyCaptureSession } from '../../src/migration/capture-session.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { assertIsolatedInstanceOutput, cloneStoppedInstance } from '../../src/migration/instance-copy.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { canonicalPortableMountContract } from '../../src/storage/portable-mount-contract.js';
import { readStableJsonFile } from './cli-common.js';

function updateRequiredConfiguration(xml, replacements, label) {
  let updated = xml;
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(updated)) throw new Error(`Missing required ${label} setting: ${pattern.source}`);
    updated = updated.replace(pattern, replacement);
  }
  return updated;
}

function pathsOverlap(left, right) {
  const relative = path.relative(left, right);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

const [sourceRoot, workRoot, destination, contractFilename] = process.argv.slice(2);
if (!sourceRoot || !workRoot || !destination || !contractFilename || process.argv.length !== 6
  || !process.env.MEDIAMANAGER_TEST_POSTGRES) {
  throw new Error('Usage: MEDIAMANAGER_TEST_POSTGRES=... node tools/database/prepare-reference-roundtrip.js STOPPED_INSTANCE NEW_WORK_DIRECTORY NEW_INSTANCE PORTABLE_MOUNT_CONTRACT_JSON (STOPPED_INSTANCE must already be offline)');
}
// Mount identity is evidence supplied by the caller. It must not be guessed
// from current rows, an adjacent historical artifact, or storage credentials.
const portableMountContract = (await readStableJsonFile(contractFilename,
  'Portable mount contract', canonicalPortableMountContract)).value;
const sourceState = await discoverInstanceState({ instanceRoot: sourceRoot });
const isolatedWorkRoot = await assertIsolatedInstanceOutput({ instanceState: sourceState, output: workRoot });
const isolatedDestination = await assertIsolatedInstanceOutput({ instanceState: sourceState, output: destination });
if (pathsOverlap(isolatedWorkRoot, isolatedDestination) || pathsOverlap(isolatedDestination, isolatedWorkRoot)) {
  throw new Error('The roundtrip work directory and restored instance destination must not overlap');
}
await mkdir(isolatedWorkRoot, { recursive: false });
const staging = path.join(isolatedWorkRoot, 'state');
// The caller must provide a stopped source. Once copied, staging is owned exclusively by this tool.
await cloneStoppedInstance({ instanceState: sourceState, destination: staging });
const networkPath = path.join(staging, 'config/network.xml');
const network = await readFile(networkPath, 'utf8');
await writeFile(networkPath, updateRequiredConfiguration(network, [
  [/<InternalHttpPort>\d+<\/InternalHttpPort>/, '<InternalHttpPort>18297</InternalHttpPort>'],
  [/<PublicHttpPort>\d+<\/PublicHttpPort>/, '<PublicHttpPort>18297</PublicHttpPort>'],
  [/<AutoDiscovery>.*?<\/AutoDiscovery>/, '<AutoDiscovery>false</AutoDiscovery>'],
], 'network'));
const systemPath = path.join(staging, 'config/system.xml');
const system = await readFile(systemPath, 'utf8');
await writeFile(systemPath, updateRequiredConfiguration(system, [
  [/<LogFileRetentionDays>\d+<\/LogFileRetentionDays>/, '<LogFileRetentionDays>7</LogFileRetentionDays>'],
], 'system'));
const stagedState = await discoverInstanceState({ instanceRoot: staging });
await assertIsolatedInstanceOutput({ instanceState: stagedState, output: isolatedDestination });
for (const stateRoot of Object.values(stagedState.roots)) if (!path.relative(staging, stateRoot)
  || path.relative(staging, stateRoot).startsWith(`..${path.sep}`) || path.relative(staging, stateRoot) === '..'
  || path.isAbsolute(path.relative(staging, stateRoot))) throw new Error('The isolated clone contains a state root outside its destination');
const source = new SqliteDatabase(stagedState.paths.sqlite, { readOnly: true, requireMigrationHistory: true });
// Opening a WAL database can update its SHM reader state even through a
// read-only logical connection. Bind the capture session after that one-time
// initialization, then continue to reject every later state-generation change.
const instanceState = await discoverInstanceState({ instanceRoot: staging });
const capturedState = JSON.stringify(instanceState);
const captureSession = createIsolatedOfflineCopyCaptureSession({
  instanceState,
  ownerId: `prepare-reference-roundtrip:${isolatedWorkRoot}`,
  assertHeld: async () => {
    await source.preflight();
    const current = await discoverInstanceState({ instanceRoot: staging });
    if (JSON.stringify(current) !== capturedState) throw new Error('The tool-owned staging instance changed after its capture session was established');
  },
});
const schema = `state_roundtrip_${Date.now()}`;
let postgres, operationError;
try {
  postgres = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const imported = await transferDatabase(source, postgres, { instanceBinding: {
    serverId: instanceState.identity.serverId,
    originIdentityDigest: instanceState.identity.digest,
  }, portableMountContract });
  const marker = await postgres.insert('ActivityLogs', { DateCreated: '2026-09-26 12:34:56.1234567', ItemId: null, LogSeverity: 2, Name: 'Current Node PostgreSQL state', Overview: 'Created after importing the native Jellyfin instance.', RowVersion: 0n, ShortOverview: null, Type: 'System', UserId: '00000000-0000-0000-0000-000000000000' });
  await postgres.update('ActivityLogs', { Id: marker.Id }, { Name: 'Edited current Node PostgreSQL state', ShortOverview: '中文 / current state' }, { rowVersion: 0n });
  const baselineManifest = JSON.parse(await readFile(validationPath('.agent-docs/baselines/jellyfin-current/manifest.json'), 'utf8'));
  const packagePath = path.join(isolatedWorkRoot, 'package');
  const manifest = await createStatePackage({ database: postgres, destination: packagePath, instanceState,
    baseline: { head: baselineManifest.head, contentDigest: baselineManifest.contentDigest }, captureSession,
    extensionState: { validation: 'native-sqlite-to-postgres-current-state-to-native-sqlite', markerId: marker.Id } });
  await restoreStatePackage(packagePath, isolatedDestination);
  const restoredState = await discoverInstanceState({ instanceRoot: isolatedDestination });
  const fileCount = manifest.instanceFiles.length + manifest.remoteAssets.length;
  const mountIds = portableMountContract.mounts.map(mount => mount.mountId);
  await writeFile(path.join(isolatedWorkRoot, 'report.json'), `${JSON.stringify({ importedRows: imported.tables.reduce((count, table) => count + table.rows, 0), importedHistoryRows: imported.migrationHistory.length, mountIds, files: fileCount, restoredInstance: isolatedDestination, restoredIdentityDigest: restoredState.identity.digest, mutation: { table: 'ActivityLogs', id: marker.Id, RowVersion: '1', config: 'LogFileRetentionDays:7' }, isolation: { port: 18297, address: '127.0.0.1', autoDiscovery: false }, remaining: ['Reference boot validation', 'Real media access', 'Full media and sidecar mutation scenarios', 'Client workflows'] }, null, 2)}\n`);
  console.log(JSON.stringify({ restoredInstance: isolatedDestination, mountIds, files: fileCount, markerId: marker.Id, importedHistoryRows: imported.migrationHistory.length, restoredIdentityDigest: restoredState.identity.digest }));
} catch (error) {
  operationError = error;
} finally {
  const cleanupErrors = [];
  try { source.close(); } catch (error) { cleanupErrors.push(error); }
  if (postgres) {
    for (const name of [schema, `${schema}__mm`]) {
      try { await postgres.client.query(`DROP SCHEMA IF EXISTS ${q(name)} CASCADE`); } catch (error) { cleanupErrors.push(error); }
    }
    try { await postgres.close(); } catch (error) { cleanupErrors.push(error); }
  }
  const failures = [...(operationError ? [operationError] : []), ...cleanupErrors];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Reference roundtrip and cleanup did not complete cleanly');
}
