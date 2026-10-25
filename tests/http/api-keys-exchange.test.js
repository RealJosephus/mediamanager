import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTestRuntime } from '../helpers/runtime.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { nativeModel, quoteIdentifier } from '../../src/database/model.js';
import { transferDatabase, exportCurrentSqlite, databaseDigest } from '../../src/migration/database-transfer.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { normalizeKeyRows } from './fixtures/api-keys/observations.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('postgres: API-created and revoked keys export to native controller/EF continuation and reimport with all tables unchanged', {
  skip: !postgresTestConnectionString || !process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE || !process.env.MEDIAMANAGER_JELLYFIN_DLL
}, async t => {
  const root = path.join(path.resolve(validationOutputRoot()), 'api-key-exchange'); await fs.mkdir(root);
  const sourceBytes = await fs.readFile(process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE), sourceHash = hash(sourceBytes);
  const sourcePath = path.join(root, 'source.db'); await fs.writeFile(sourcePath, sourceBytes, { flag: 'wx' });
  let source, returned, database, reimported, runtime, importedRuntime;
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    await attempt(() => importedRuntime?.close()); await attempt(() => runtime?.close());
    await attempt(() => source?.close()); await attempt(() => returned?.close());
    await attempt(() => dropPostgresTestDatabase(reimported)); await attempt(() => dropPostgresTestDatabase(database));
    if (failures.length) throw new AggregateError(failures, 'API-key exchange cleanup failed.');
  });
  source = new SqliteDatabase(sourcePath, { requireMigrationHistory: true });
  source.transaction(() => {
    source.database.exec('PRAGMA defer_foreign_keys = ON');
    for (const table of nativeModel.tables) source.database.exec('DELETE FROM ' + quoteIdentifier(table.name));
  });
  database = await createPostgresTestDatabase(null, 'api_key_export');
  const serverId = 'e6200000000000000000000000000001';
  const options = { instanceBinding: { serverId, originIdentityDigest: sourceHash }, portableMountContract: { mounts: [] } };
  await transferDatabase(source, database, options);
  runtime = await createTestRuntime({ database, configuration: { IsStartupWizardCompleted: true }, serverId });

  const bootstrap = await runtime.apiKeys.create('Exchange bootstrap'), origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(listener => listener.scheme === 'http').port}`;
  const headers = { Accept: 'application/json', Authorization: `MediaBrowser Token="${bootstrap.AccessToken}"` };
  for (const name of ['Node consumer\0key', 'Remove before export']) assert.equal((await fetch(origin + '/Auth/Keys?app=' + encodeURIComponent(name), { method: 'POST', headers })).status, 204);
  let response = await fetch(origin + '/Auth/Keys', { headers }); assert.equal(response.status, 200); const initial = await response.json();
  const selected = initial.Items[1].AccessToken, removed = initial.Items[2].AccessToken;
  assert.equal((await fetch(origin + '/Auth/Keys/' + removed, { method: 'DELETE', headers })).status, 204);
  response = await fetch(origin + '/Auth/Keys', { headers }); assert.equal(response.status, 200); const before = await response.json();
  const originalRows = await database.rows('ApiKeys');
  const exported = path.join(root, 'returned.db'), exportResult = await exportCurrentSqlite(database, exported);
  assert.equal(exportResult.verified, true); const exportedSha256 = hash(await fs.readFile(exported));
  const recording = await recordOracle({ project: 'tests/http/fixtures/api-keys/consumer/Oracle.csproj', output: path.join(root, 'native'), args: [exported, selected, '{output}/reading.json'] });
  const native = JSON.parse(await fs.readFile(path.join(root, 'native/reading.json')));
  for (const field of ['actualController', 'actualManager', 'actualEfSqlite']) assert.equal(native[field], true);
  assert.equal(native.originalSha256, exportedSha256); assert.deepEqual(native.before, before); assert.deepEqual(native.afterUppercase, before);
  assert.deepEqual(normalizeKeyRows(native.beforeRows), normalizeKeyRows(originalRows));
  returned = new SqliteDatabase(exported, { readOnly: true, requireMigrationHistory: true });
  assert.deepEqual(normalizeKeyRows(await returned.rows('ApiKeys')), normalizeKeyRows(native.afterRows));
  reimported = await createPostgresTestDatabase(null, 'api_key_return'); await transferDatabase(returned, reimported, options);
  assert.deepEqual(await databaseDigest(reimported), await databaseDigest(returned));
  importedRuntime = await createTestRuntime({ database: reimported, configuration: { IsStartupWizardCompleted: true }, serverId });
  assert.deepEqual(await importedRuntime.apiKeys.list(), native.after);
  assert.deepEqual(native.after.Items.map(row => row.AppName), ['Exchange bootstrap', 'Native consumer\0key']);
  await assert.rejects(importedRuntime.authentication.authenticate({ headers: { authorization: `MediaBrowser Token="${selected}"` } }), { status: 401 });
  await assert.rejects(importedRuntime.authentication.authenticate({ headers: { authorization: `MediaBrowser Token="${removed}"` } }), { status: 401 });
  assert.equal((await importedRuntime.authentication.authenticate({ headers: { authorization: `MediaBrowser Token="${native.after.Items[1].AccessToken}"` } })).IsApiKey, true);
  assert.equal(hash(await fs.readFile(process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE)), sourceHash);
  await fs.writeFile(path.join(root, 'proof.json'), JSON.stringify({ sourceHash, exportedSha256, exportResult, recording,
    actualNativeReadAndWrite: true, allTablesRoundTrip: true, fullInstanceVerified: false, completeBuildInputClosure: false, phaseAcceptance: false },
    (_, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2) + '\n', { flag: 'wx' });
});
