import assert from 'node:assert/strict';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { createRuntime } from '../../src/runtime.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { defaultLibraryOptions } from '../../src/library/options.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { idKey } from '../../src/library/records.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { editFilesystemSnapshot, editHttpTables } from '../../tools/compat/record-internal-edits.js';

/** Import exactly the restored private SQLite input, including native users,
 * migration history and all other tables. Runtime files still use plugins. */
export async function currentEditHttpCandidate({ current, referenceRoot, input }) {
  const database = await createPostgresTestDatabase(null, 'current_edit');
  const storage = new StorageRegistry(), runtimeErrors = [], records = [], stages = [];
  let runtime, before, afterShutdown, transfer, error, origin;
  const snapshot = async db => ({ database: Object.fromEntries(await Promise.all(editHttpTables.map(async table => [table, await db.rows(table)]))),
    filesystem: await editFilesystemSnapshot(input.filesystemRoots) });
  try {
    const instanceState = await discoverInstanceState({ instanceRoot: referenceRoot });
    const sqlite = new SqliteDatabase(path.join(referenceRoot, 'data/data/jellyfin.db'), { readOnly: true, requireMigrationHistory: true });
    try { transfer = await transferDatabase(sqlite, database, { instanceBinding: {
      serverId: instanceState.identity.serverId, originIdentityDigest: instanceState.identity.digest } }); }
    finally { sqlite.close(); }
    storage.registerType('local', configuration => LocalAdapter.open(configuration));
    await storage.createInstance('media', 'local', { root: input.mediaPath, writable: true });
    const vfs = new VirtualFileSystem(storage), identityMap = new IdentityAccessMap();
    vfs.mount({ path: '/media', instanceId: 'media', capabilities: { create: true, replace: true, mkdir: true, delete: true, atomicReplace: true } });
    identityMap.addPrefix({ identityRoot: input.mediaPath, accessRoot: '/media', style: process.platform === 'win32' ? 'windows' : 'posix',
      returnAccess: 'Exact private media path restored before the PostgreSQL run.' });
    const settings = await readInstanceConfiguration(referenceRoot);
    const libraryOptions = new Map([[idKey(input.ids.CollectionFolder), { ...defaultLibraryOptions(), SaveLocalMetadata: true, MetadataSavers: ['Nfo'] }]]);
    runtime = await createRuntime({ database, programDataPath: input.programDataPath, configurationDirectoryPath: path.join(referenceRoot, 'config'),
      configuration: settings.configuration, networkConfiguration: { ...settings.networkConfiguration,
        InternalHttpPort: 0, LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false, EnablePublishedServerUriByRequest: true },
      serverId: current.preparation.nativeServerId, vfs, identityMap, libraryOptions,
      onError: failure => runtimeErrors.push({ message: failure.message, code: failure.code, stack: failure.stack }) });
    await runtime.start();
    origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
    before = await snapshot(database);
    for (const testCase of input.cases) {
      const window = { startedAt: new Date().toISOString() };
      const response = await fetch(`${origin}/Items/${testCase.itemId}`, { method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json',
          Authorization: `MediaBrowser Client="InternalEditOracle", Device="Isolated", DeviceId="internal-edit-oracle", Version="1", Token="${current.accessToken}"` },
        body: JSON.stringify(testCase.body) });
      const value = { status: response.status, contentType: response.headers.get('content-type'), bodyText: await response.text() };
      window.finishedAt = new Date().toISOString();
      records.push({ name: testCase.name, response: value });
      stages.push({ name: testCase.name, window, ...await snapshot(database) });
    }
  } catch (failure) { error = { message: failure.message, code: failure.code, stack: failure.stack }; }
  finally {
    try {
      await runtime?.close();
      if (before) {
        const reader = await database.constructor.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema: database.schemaName });
        try { afterShutdown = await snapshot(reader); } finally { await reader.close(); }
      }
    } finally { await storage.close(); await dropPostgresTestDatabase(database); }
  }
  assert.ok(!runtime || runtime.networkHost.listeners.every(listener => !listener.server.listening));
  return { before, stages, afterShutdown, records, transfer, runtimeErrors, error,
    cleanup: { runtimeClosed: !runtime || runtime.networkHost.listeners.every(listener => !listener.server.listening), postgresSchemasRemoved: true, storageClosed: true } };
}
