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
import { projectItemBody } from '../helpers/http-body-projection.js';

const fixtureBytes = await readFile(new URL('./fixtures/root-query-scope/native.json', import.meta.url));
assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), '4a9239771497057becedb6fb2c07edca9458d48085a5e69e68aba0f0ecd0b1c6');
const fixture = JSON.parse(fixtureBytes);
assert.equal(fixture.nativeVerified, true);
assert.equal(fixture.phaseAcceptance, false);
assert.equal(fixture.native.length, 40);
assert.equal(fixture.actualUserAndViews.length, 20);
assert.equal(fixture.seed.BaseItems.length, 27);
assert.equal(fixture.provenance.passed, true);
assert.deepEqual(fixture.provenance.processResult, { code: 0, signal: null });
assert.equal(fixture.provenance.portAvailable, true);
assert.equal(fixture.provenance.dllSha256, '31236d2a520e52ab2130742515a552980b0edbde4cfe8da124c0a0cd87c9046c');
for (const row of fixture.actualUserAndViews) {
  const intended = fixture.input.cases.find(testCase => testCase.name === row.name).policy;
  assert.equal(row.user.status, 200);
  assert.equal(row.views.status, 200);
  assert.equal(row.user.bodyJson.Policy.EnableAllFolders, intended.EnableAllFolders);
  assert.deepEqual(row.user.bodyJson.Policy.EnabledFolders.map(id => id.replaceAll('-', '').toLowerCase()).sort(), intended.EnabledFolders.map(id => id.replaceAll('-', '').toLowerCase()).sort());
  assert.deepEqual(row.user.bodyJson.Policy.BlockedMediaFolders, []);
}

const columns = table => tableDefinition(table).columns.filter(column => !column.generated);
const empty = table => Object.fromEntries(columns(table).map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false
  : column.type === 'TEXT' ? '' : column.clrType === 'long' || column.clrType === 'uint' ? 0n : 0]));
const adapt = (table, row) => ({ ...empty(table), ...Object.fromEntries(columns(table).filter(column => Object.hasOwn(row, column.name))
  .map(column => [column.name, row[column.name] == null ? null : column.clrType === 'bool' ? Boolean(row[column.name])
    : column.clrType === 'long' || column.clrType === 'uint' ? BigInt(row[column.name]) : row[column.name]])) });
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, normalize(entry)])) : value;
const stable = value => JSON.stringify(normalize(value));
const candidateServerId = 'candidate-search-audit';

for (const dialect of ['postgres']) test(`${dialect}: 40 complete root and folder query DTO responses match native persisted scope`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const schema = `root_scope_${process.pid}_${randomBytes(4).toString('hex')}`;
  const db = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const cases = [], differences = [], cleanup = { databaseClosed: false, schemasRemoved: false, closeProbe: false };
  const seedReadback = {};
  try {
    for (const run of [fixture]) {
      const observedNativeServerId = run.native.flatMap(record => record.response.bodyJson?.Items ?? [])
        .find(item => typeof item.Id === 'string' && typeof item.Type === 'string')?.ServerId;
      assert.equal(typeof observedNativeServerId, 'string');
      for (const table of ['PeopleBaseItemMap', 'Peoples', 'ItemValuesMap', 'ItemValues', 'AncestorIds', 'BaseItems', 'Users']) {
        await db.client.query('DELETE FROM ' + quoteIdentifier(table));
      }
      await db.insert('Users', { ...empty('Users'), Id: run.input.userId, Username: 'Search audit', NormalizedUsername: 'SEARCH AUDIT', InternalId: 1 });
      // The fixture preserves actual native table rows. Deferred parent keys
      // permit this recorded insertion order without replacing the root graph.
      await db.transaction(async transaction => {
        await transaction.client.query('SET CONSTRAINTS ALL DEFERRED');
        for (const row of run.seed.BaseItems) await transaction.insert('BaseItems', adapt('BaseItems', row));
      });
      for (const table of ['AncestorIds', 'ItemValues', 'ItemValuesMap', 'Peoples', 'PeopleBaseItemMap']) {
        for (const row of run.seed[table]) await db.insert(table, adapt(table, row));
      }
      for (const table of ['BaseItems', 'AncestorIds', 'ItemValues', 'ItemValuesMap', 'Peoples', 'PeopleBaseItemMap']) seedReadback[table] = await db.rows(table);
      const library = new LibraryService({fileSystem: testFileSystem,  store: new DomainStore(db), serverId: candidateServerId,
        configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false } });
      await attachLibraryNavigation(library);
      try {
      for (const expected of run.native) {
        const readback = run.actualUserAndViews.find(row => row.name === expected.name).user.bodyJson;
        const user = { ...readback, MaxParentalRatingScore: readback.Policy.MaxParentalRating, MaxParentalRatingSubScore: readback.Policy.MaxParentalSubRating };
        const query = Object.fromEntries(new URL(expected.route, 'http://localhost').searchParams);
        let actual;
        try { actual = { status: 200, body: JSON.parse(stringifyNativeJson(await library.queryItems(query, { user }))) }; }
        catch (error) { actual = { status: error.status ?? 500, error: { name: error.name, message: error.message } }; }
        const wanted = { status: expected.response.status, body: expected.response.bodyJson };
        const row = { name: expected.name, endpoint: expected.endpoint, route: expected.route, actual, expected: wanted };
        cases.push(row);
        const comparable = Object.hasOwn(actual, 'body') ? { ...actual, body: projectItemBody(actual.body,
          { serverId: candidateServerId, serverToken: observedNativeServerId, date: value => value }) } : actual;
        if (stable(comparable) !== stable(wanted)) differences.push(row);
      }
      } finally { await closeLibraryNavigation(library); }
    }
  } finally {
    await db.client.query('DROP SCHEMA ' + quoteIdentifier(db.schemaName) + ' CASCADE');
    await db.client.query('DROP SCHEMA ' + quoteIdentifier(db.controlSchema) + ' CASCADE');
    cleanup.schemasRemoved = (await db.client.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])', [[db.schemaName, db.controlSchema]])).rows.length === 0;
    await db.close(); cleanup.databaseClosed = true;
    try {
      await db.client.query('SELECT 1');
    } catch (error) { cleanup.closeProbe = /not open|closed/i.test(error.message); }
    if (process.env.MEDIAMANAGER_ROOT_SCOPE_ARTIFACT_DIR) {
      const directory = path.resolve(process.env.MEDIAMANAGER_ROOT_SCOPE_ARTIFACT_DIR);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, dialect + '.json'), JSON.stringify({ phaseAcceptance: false, dialect, schema, cases, differences, seedReadback, cleanup,
        boundary: 'Actual database service and native serializer replay complete DTO/status. Native recorded policy/view inputs are supplied; candidate HTTP transport, authentication and legacy routing are not invoked.' }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    }
  }
  assert.deepEqual(cleanup, { databaseClosed: true, schemasRemoved: true, closeProbe: true });
  assert.equal(cases.length, 40);
  assert.deepEqual(differences, []);
});
