import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRuntime } from '../../src/runtime.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { nativeModel, quoteIdentifier } from '../../src/database/model.js';
import { nativeGuid, wireGuid } from '../../src/users/native.js';
import { parsePasswordHash, verifyPasswordHash } from '../../src/core/password.js';
import { transferDatabase, exportCurrentSqlite, databaseDigest } from '../../src/migration/database-transfer.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('postgres: startup first-user insertion order survives SQLite export, actual native user continuation and complete table reimport', {
  skip: !postgresTestConnectionString || !process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE || !process.env.MEDIAMANAGER_JELLYFIN_DLL
}, async t => {
  const root = path.join(path.resolve(validationOutputRoot()), 'startup-exchange'); await fs.mkdir(root, { recursive: false });
  const sourceBytes = await fs.readFile(process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE), sourceHash = hash(sourceBytes), sourcePath = path.join(root, 'source.db');
  await fs.writeFile(sourcePath, sourceBytes, { flag: 'wx' });
  let source, returned, database, reimported, runtime, importedRuntime;
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    await attempt(() => importedRuntime?.close()); await attempt(() => runtime?.close()); await attempt(() => source?.close()); await attempt(() => returned?.close());
    await attempt(() => dropPostgresTestDatabase(reimported)); await attempt(() => dropPostgresTestDatabase(database));
    if (failures.length) throw new AggregateError(failures, 'Startup exchange cleanup failed.');
  });
  const recorded = JSON.parse(await fs.readFile(new URL('./fixtures/startup/native.json', import.meta.url)));
  const input = recorded.results.find(row => row.name === 'first-native-insertion-order').before.tables;
  const firstId = nativeGuid('e5100000-0000-0000-0000-000000000002'), otherId = nativeGuid('e5100000-0000-0000-0000-000000000001');
  source = new SqliteDatabase(sourcePath, { requireMigrationHistory: true });
  source.transaction(() => {
    source.database.exec('PRAGMA defer_foreign_keys = ON');
    for (const table of nativeModel.tables) source.database.exec('DELETE FROM ' + quoteIdentifier(table.name));
    for (const id of [firstId, otherId]) source.insert('Users', input.Users.find(row => row.Id === id));
    for (const table of ['Permissions', 'Preferences', 'AccessSchedules', 'ImageInfos']) for (const row of input[table]) source.insert(table, row);
  });
  database = await createPostgresTestDatabase(null, 'startup_export'); const serverId = 'e5400000000000000000000000000001';
  await transferDatabase(source, database, { instanceBinding: { serverId, originIdentityDigest: sourceHash }, portableMountContract: { mounts: [] } });
  runtime = await createRuntime({ database, configuration: { IsStartupWizardCompleted: false }, serverId });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  assert.equal((await runtime.users.getFirstUser()).Id, firstId);
  const url = `http://127.0.0.1:${runtime.server.address().port}/Startup/User`;
  const initial = await fetch(url); assert.equal(initial.status, 200); assert.equal((await initial.json()).Name, 'Beta');
  const update = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Name: 'Node first', Password: 'Node startup password' }) });
  assert.equal(update.status, 204);
  const exported = path.join(root, 'returned.db'), result = await exportCurrentSqlite(database, exported), exportedSha256 = hash(await fs.readFile(exported));
  assert.equal(result.verified, true); await runtime.close();
  const recording = await recordOracle({ project: 'tests/http/fixtures/startup/consumer/Oracle.csproj', output: path.join(root, 'native'), args: [exported, firstId, otherId, '{output}/reading.json'] });
  const native = JSON.parse(await fs.readFile(path.join(root, 'native/reading.json')));
  for (const flag of ['actualController', 'actualUserManager', 'actualEfSqlite', 'nodePasswordMatches']) assert.equal(native[flag], true);
  assert.equal(native.originalSha256, exportedSha256); assert.equal(native.before.Name, 'Node first'); assert.equal(native.after.Name, 'Native first');
  assert.deepEqual(native.beforeOrder, [wireGuid(firstId), wireGuid(otherId)]);
  assert.deepEqual(native.afterOrder, [wireGuid(firstId), native.appendedUserId]);
  returned = new SqliteDatabase(exported, { readOnly: true, requireMigrationHistory: true });
  reimported = await createPostgresTestDatabase(null, 'startup_return');
  await transferDatabase(returned, reimported, { instanceBinding: { serverId, originIdentityDigest: sourceHash }, portableMountContract: { mounts: [] } });
  assert.deepEqual(await databaseDigest(reimported), await databaseDigest(returned));
  assert.deepEqual((await reimported.relationRowsInInsertionOrder('Users', { limit: 128 })).rows.map(row => wireGuid(row.Id)), native.afterOrder);
  importedRuntime = await createRuntime({ database: reimported, configuration: { IsStartupWizardCompleted: false }, serverId });
  const first = await importedRuntime.users.getFirstUser(); assert.equal(first.Id, firstId); assert.equal(first.Username, 'Native first');
  assert.equal(await verifyPasswordHash(parsePasswordHash(first.Password), 'Native startup password'), true);
  assert.equal(await importedRuntime.users.getUser(otherId), null);
  assert.equal(hash(await fs.readFile(process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE)), sourceHash);
  await fs.writeFile(path.join(root, 'proof.json'), JSON.stringify({ sourceHash, exportedSha256, exportResult: result, nativeRecording: recording,
    beforeOrder: native.beforeOrder, afterOrder: native.afterOrder, actualNativeUserReadAndWrite: true, allTablesRoundTrip: true,
    fullInstanceVerified: false, completeBuildInputClosure: false, phaseAcceptance: false }, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2) + '\n', { flag: 'wx' });
});
