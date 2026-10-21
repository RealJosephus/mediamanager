import { testFileSystem } from '../storage/plugin-files.js';
import { attachLibraryNavigation, closeLibraryNavigation } from './navigation-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { stringifyNativeJson } from '../../src/core/json.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile(new URL('./fixtures/resume-query-scope/native.json', import.meta.url));
const fixture = JSON.parse(bytes);
const key = value => String(value).replaceAll('-', '').toLowerCase();
const columns = table => tableDefinition(table).columns.filter(column => !column.generated);
const empty = table => Object.fromEntries(columns(table).map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false
  : column.type === 'TEXT' ? '' : column.clrType === 'long' || column.clrType === 'uint' ? 0n : 0]));
const adapt = (table, row) => ({ ...empty(table), ...Object.fromEntries(columns(table).filter(column => Object.hasOwn(row, column.name))
  .map(column => [column.name, row[column.name] == null ? null : column.clrType === 'bool' ? Boolean(row[column.name])
    : column.clrType === 'long' || column.clrType === 'uint' ? BigInt(row[column.name]) : row[column.name]])) });
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, entry]) => [name, name === 'ServerId' ? '$server' : normalize(entry)])) : value;
const stable = value => JSON.stringify(normalize(value), (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry);

test('Resume scope fixture retains complete native HTTP/state and actual LatestExcludes readbacks', () => {
  assert.equal(sha(bytes), '64ad8c4876d638706223c35c611e677111e750d909a2f6c189c993843ebdd65c');
  assert.equal(fixture.nativeVerified, true); assert.equal(fixture.phaseAcceptance, false);
  assert.equal(fixture.native.length, 18); assert.equal(fixture.actualUserAndViews.length, 6);
  assert.equal(fixture.actualConfigurationUpdates.length, 2); assert.equal(fixture.seed.BaseItems.length, 27); assert.equal(fixture.seed.UserData.length, 13);
  assert.equal(fixture.provenance.passed, true); assert.equal(fixture.provenance.cases, 18);
  assert.equal(fixture.provenance.dllSha256, '31236d2a520e52ab2130742515a552980b0edbde4cfe8da124c0a0cd87c9046c');
  assert.deepEqual(fixture.provenance.processResult, { code: 0, signal: null }); assert.equal(fixture.provenance.portAvailable, true);
  assert.equal(sha(fixture.provenance.executedRecorderSource), fixture.provenance.recorderSha256);
  assert.equal(sha(fixture.provenance.exactInputSource), fixture.provenance.fixtureSha256);
  assert.deepEqual(JSON.parse(fixture.provenance.exactInputSource), fixture.input);
  assert.equal(fixture.provenance.nativeRuntimeBindings.length, 230);
  assert.equal(fixture.nativeState.tables.length, 12); assert.equal(fixture.nativeState.filesystemDomains.length, 4);
  assert.deepEqual(fixture.nativeState.before.database.foreignKeyCheck, []);
  assert.equal(sha(JSON.stringify(fixture.nativeState.before)), fixture.nativeState.beforeSha256);
  assert.equal(fixture.nativeState.afterReadsSha256, fixture.nativeState.beforeSha256);
  assert.equal(fixture.nativeState.afterShutdownSha256, fixture.nativeState.beforeSha256);
  const databaseHash = sha(JSON.stringify(fixture.nativeState.before.database));
  const filesystemHash = sha(JSON.stringify(fixture.nativeState.before.filesystem));
  assert.equal(fixture.nativeState.endpoints.length, 18);
  for (const endpoint of fixture.nativeState.endpoints) {
    assert.equal(endpoint.databaseSha256, databaseHash); assert.equal(endpoint.filesystemSha256, filesystemHash);
  }
  for (const update of fixture.actualConfigurationUpdates) {
    assert.equal(update.status, 204);
    const readback = fixture.actualUserAndViews.find(row => row.name === update.name);
    assert.deepEqual(readback.user.bodyJson.Configuration.LatestItemsExcludes.map(key).sort(), update.configuration.LatestItemsExcludes.map(key).sort());
    assert.ok(update.configuration.LatestItemsExcludes.length > 0);
    for (const endpoint of ['resume', 'resume-legacy']) {
      const record = fixture.native.find(row => row.name === update.name && row.endpoint === endpoint);
      assert.equal(record.response.status, 200); assert.equal(record.response.bodyJson.TotalRecordCount, 0); assert.deepEqual(record.response.bodyJson.Items, []);
    }
  }
});

for (const dialect of ['postgres']) test(`${dialect}: complete Resume and generic Items responses match stored native parent/top/ancestor scope`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const schema = `resume_scope_${process.pid}_${randomBytes(4).toString('hex')}`;
  const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
  const db = await PostgresDatabase.open({ connectionString, schema, create: true });
  const records = [], differences = [], snapshots = {};
  const cleanup = { databaseClosed: false, schemasRemoved: false, closeProbe: false };
  let library;
  try {
    const userId = fixture.seed.UserData[0].UserId;
    assert.equal(key(userId), key(fixture.input.userId));
    await db.insert('Users', { ...empty('Users'), Id: userId, Username: 'Resume scope fixture', NormalizedUsername: 'RESUME SCOPE FIXTURE', InternalId: 1 });
    await db.transaction(async transaction => {
      await transaction.client.query('SET CONSTRAINTS ALL DEFERRED');
      for (const row of fixture.seed.BaseItems) {
        await transaction.insert('BaseItems', adapt('BaseItems', row));
      }
    }, { isolation: 'read-committed' });
    for (const table of fixture.nativeState.tables.filter(table => table !== 'BaseItems')) for (const row of fixture.seed[table]) await db.insert(table, adapt(table, row));
    const snapshot = async () => Object.fromEntries(await Promise.all(fixture.nativeState.tables.map(async table => [table, await db.rows(table)])));
    snapshots.before = await snapshot();
    library = new LibraryService({fileSystem: testFileSystem,  store: new DomainStore(db), serverId: 'resume-scope-fixture',
      configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false } });
    await attachLibraryNavigation(library);
    for (const expected of fixture.native) {
      const readback = fixture.actualUserAndViews.find(row => row.name === expected.name).user.bodyJson;
      const user = { ...readback, Id: userId, MaxParentalRatingScore: readback.Policy.MaxParentalRating, MaxParentalRatingSubScore: readback.Policy.MaxParentalSubRating };
      const query = Object.fromEntries(new URL(expected.route, 'http://localhost').searchParams);
      let actual;
      try { actual = { status: 200, body: JSON.parse(stringifyNativeJson(await (expected.endpoint === 'items'
        ? library.queryItems(query, { user }) : library.queryResumeItems(query, { user })))) }; }
      catch (error) { actual = { status: error.status ?? 500, error: { name: error.name, message: error.message } }; }
      const wanted = { status: expected.response.status, body: expected.response.bodyJson };
      const stateAfter = await snapshot();
      const row = { name: expected.name, endpoint: expected.endpoint, route: expected.route, actual, expected: wanted,
        matched: stable(actual) === stable(wanted), stateUnchanged: stable(stateAfter) === stable(snapshots.before) };
      records.push(row); if (!row.matched || !row.stateUnchanged) differences.push(row);
    }
    snapshots.after = await snapshot();
  } finally {
    await closeLibraryNavigation(library);
    await db.client.query('DROP SCHEMA ' + quoteIdentifier(db.schemaName) + ' CASCADE');
    await db.client.query('DROP SCHEMA ' + quoteIdentifier(db.controlSchema) + ' CASCADE');
    cleanup.schemasRemoved = (await db.client.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])', [[db.schemaName, db.controlSchema]])).rows.length === 0;
    await db.close(); cleanup.databaseClosed = true;
    try { await db.client.query('SELECT 1'); }
    catch { cleanup.closeProbe = true; }
  }
  const evidence = process.env.MEDIAMANAGER_RESUME_SCOPE_EVIDENCE;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, `${dialect}.json`), JSON.stringify({ schema, fixtureSha256: sha(bytes), records, differences, snapshots, cleanup,
      phaseAcceptance: false }, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n');
  }
  assert.equal(records.length, 18); assert.deepEqual(differences, []);
  assert.equal(cleanup.schemasRemoved, true); assert.equal(cleanup.databaseClosed, true); assert.equal(cleanup.closeProbe, true);
});
