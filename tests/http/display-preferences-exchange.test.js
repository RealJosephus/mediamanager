import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRuntime } from '../../src/runtime.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { nativeModel, quoteIdentifier } from '../../src/database/model.js';
import { transferDatabase, exportCurrentSqlite, databaseDigest } from '../../src/migration/database-transfer.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { normalizePreferenceState, preferenceTables } from './fixtures/display-preferences/observations.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const dto = value => ({ ...value, ViewType: value.ViewType ?? null, IndexBy: value.IndexBy ?? null,
  ScrollDirection: { Horizontal: 0, Vertical: 1 }[value.ScrollDirection] ?? value.ScrollDirection,
  SortOrder: { Ascending: 0, Descending: 1 }[value.SortOrder] ?? value.SortOrder });
test('postgres: display preference API writes export to real native EF/controller consumption and native edits reimport losslessly', {
  skip: !postgresTestConnectionString || !process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE || !process.env.MEDIAMANAGER_JELLYFIN_DLL
}, async t => {
  const output = path.resolve(validationOutputRoot()), root = path.join(output, 'display-preferences-exchange'); await fs.mkdir(root, { recursive: false });
  const sourceBytes = await fs.readFile(process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE);
  const sourceHash = hash(sourceBytes), sourcePath = path.join(root, 'source.db'); await fs.writeFile(sourcePath, sourceBytes, { flag: 'wx' });
  let source, returned, database, reimported, runtime;
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    await attempt(() => runtime?.close()); await attempt(() => source?.close()); await attempt(() => returned?.close());
    await attempt(() => dropPostgresTestDatabase(reimported)); await attempt(() => dropPostgresTestDatabase(database));
    if (failures.length) throw new AggregateError(failures, 'Display preference exchange cleanup failed.');
  });
  source = new SqliteDatabase(sourcePath, { requireMigrationHistory: true });
  source.transaction(() => {
    source.database.exec('PRAGMA defer_foreign_keys = ON');
    for (const table of nativeModel.tables) source.database.exec('DELETE FROM ' + quoteIdentifier(table.name));
  });
  database = await createPostgresTestDatabase(null, 'display_export');
  const serverId = 'de150000000000000000000000000001';
  await transferDatabase(source, database, { instanceBinding: { serverId, originIdentityDigest: sourceHash }, portableMountContract: { mounts: [] } });
  runtime = await createRuntime({ database, configuration: { IsStartupWizardCompleted: true }, serverId });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const owner = await runtime.users.createUser({ Name: 'Exchange', Password: 'Native preference exchange password' });
  const key = await runtime.apiKeys.create('Preference exchange'), url = `http://127.0.0.1:${runtime.server.address().port}/DisplayPreferences/usersettings?client=emby&userId=${owner.Id}`;
  const headers = { Accept: 'application/json', Authorization: `MediaBrowser Token="${key.AccessToken}"`, 'Content-Type': 'application/json' };
  const write = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ SortBy: 'DateCreated', SortOrder: 'Descending',
    IndexBy: 'ProductionYear', ShowSidebar: true, CustomPrefs: { foo: 'Node\0write', homesection0: 'Resume', homesection4: 'LatestMedia', unknown: null } }) });
  assert.equal(write.status, 204); const current = await fetch(url, { headers }); assert.equal(current.status, 200); const before = await current.json();
  const originalRows = Object.fromEntries(await Promise.all(preferenceTables.map(async table => [table, await database.rows(table)])));
  const exported = path.join(root, 'returned.db'); const exportResult = await exportCurrentSqlite(database, exported);
  assert.equal(exportResult.verified, true); const exportedSha256 = hash(await fs.readFile(exported));
  const recording = await recordOracle({ project: 'tests/http/fixtures/display-preferences/consumer/Oracle.csproj', output: path.join(root, 'native'), args: [exported, owner.Id, '{output}/reading.json'] });
  assert.equal(recording.passed, true); const native = JSON.parse(await fs.readFile(path.join(root, 'native/reading.json')));
  assert.equal(native.actualController, true); assert.equal(native.actualManager, true); assert.equal(native.actualEfSqlite, true); assert.equal(native.originalSha256, exportedSha256);
  assert.deepEqual(native.before, dto(before)); assert.deepEqual(normalizePreferenceState(native.beforeRows), normalizePreferenceState(originalRows));
  returned = new SqliteDatabase(exported, { readOnly: true, requireMigrationHistory: true });
  const afterNative = Object.fromEntries(await Promise.all(preferenceTables.map(async table => [table, await returned.rows(table)])));
  assert.deepEqual(normalizePreferenceState(afterNative), normalizePreferenceState(native.afterRows));
  reimported = await createPostgresTestDatabase(null, 'display_return');
  await transferDatabase(returned, reimported, { instanceBinding: { serverId, originIdentityDigest: sourceHash }, portableMountContract: { mounts: [] } });
  assert.deepEqual(await databaseDigest(reimported), await databaseDigest(returned));
  const importedRuntime = await createRuntime({ database: reimported, configuration: { IsStartupWizardCompleted: true }, serverId });
  try {
    const after = await importedRuntime.displayPreferences.get('usersettings', owner.Id, 'emby');
    assert.deepEqual(native.after, dto({ ...after, CustomPrefs: Object.fromEntries(after.CustomPrefs) }));
    assert.equal(after.SortBy, 'Name'); assert.equal(after.CustomPrefs.get('foo'), 'native\0write');
    assert.equal(after.CustomPrefs.get('homesection0'), 'librarybuttons'); assert.equal(after.CustomPrefs.get('homesection4'), 'latestmedia');
  } finally { await importedRuntime.close(); }
  assert.equal(hash(await fs.readFile(process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE)), sourceHash);
  await fs.writeFile(path.join(root, 'proof.json'), JSON.stringify({ sourceHash, exportedSha256, exportResult, nativeRecording: recording,
    allTablesRoundTrip: true, actualNativeReadAndWrite: true, fullInstanceVerified: false, completeBuildInputClosure: false, phaseAcceptance: false },
    (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2) + '\n');
});
