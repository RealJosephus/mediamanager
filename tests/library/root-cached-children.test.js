import { testFileSystem } from '../storage/plugin-files.js';
import { attachLibraryNavigation, closeLibraryNavigation } from './navigation-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { LibraryService } from '../../src/library/library-service.js';
import { stringifyNativeJson } from '../../src/core/json.js';
import { expandStatePath } from './fixture-state-path.js';

const fixtures = [];
for (const [filename, sha256, items] of [['native.json', 'fbb598befe36fddf3d1bcfb9ebd1df384253875865cbde0c6f65acb2a8c917a4', 22], ['native-virtual-controls.json', '90cd587fa63f072dbbd07b7f3bdf9e3bd37364cddb1e36cbe8150fcb3c2e7e50', 26]]) {
  const bytes = await readFile(new URL('./fixtures/root-cached-children/' + filename, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
  const fixture = JSON.parse(bytes); fixtures.push(fixture);
  assert.equal(fixture.nativeVerified, true); assert.equal(fixture.phaseAcceptance, false);
  assert.equal(fixture.native.length, 24); assert.equal(fixture.actualUserAndViews.length, 12); assert.equal(fixture.seed.BaseItems.length, items);
  assert.equal(fixture.provenance.passed, true); assert.deepEqual(fixture.provenance.processResult, { code: 0, signal: null });
  assert.equal(fixture.provenance.portAvailable, true); assert.equal(fixture.provenance.dllSha256, '31236d2a520e52ab2130742515a552980b0edbde4cfe8da124c0a0cd87c9046c');
  for (const row of fixture.actualUserAndViews) {
    const intended = fixture.input.cases.find(testCase => testCase.name === row.name).policy;
    assert.equal(row.user.status, 200); assert.equal(row.views.status, 200);
    assert.equal(row.user.bodyJson.Policy.EnableAllFolders, intended.EnableAllFolders);
    assert.deepEqual(row.user.bodyJson.Policy.EnabledFolders.map(id => id.replaceAll('-', '').toLowerCase()).sort(), intended.EnabledFolders.map(id => id.replaceAll('-', '').toLowerCase()).sort());
    assert.deepEqual(row.user.bodyJson.Policy.BlockedMediaFolders, []);
  }
  for (const stage of fixture.audit.stages.concat(fixture.audit.endpoints)) {
    assert.ok(stage.tables.every(table => table.unchanged)); assert.ok(stage.filesystem.every(domain => domain.unchanged)); assert.deepEqual(stage.foreignKeyCheck, []);
  }
}

const columns = table => tableDefinition(table).columns.filter(column => !column.generated);
const empty = table => Object.fromEntries(columns(table).map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false
  : column.type === 'TEXT' ? '' : column.clrType === 'long' || column.clrType === 'uint' ? 0n : 0]));
const adapt = (table, row) => ({ ...empty(table), ...Object.fromEntries(columns(table).filter(column => Object.hasOwn(row, column.name))
  .map(column => [column.name, row[column.name] == null ? null : column.clrType === 'bool' ? Boolean(row[column.name])
    : column.clrType === 'long' || column.clrType === 'uint' ? BigInt(row[column.name]) : row[column.name]])) });
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, key === 'ServerId' ? '$server' : normalize(entry)])) : value;
const stable = value => JSON.stringify(normalize(value));

for (const dialect of ['postgres']) test(`${dialect}: 48 complete cached-root and virtual-root DTO responses match native`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const schema = `root_cached_${process.pid}_${randomBytes(4).toString('hex')}`;
  const db = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const cases = [], differences = [], cleanup = { databaseClosed: false, schemasRemoved: false, closeProbe: false };
  const seedReadback = [], runtimes = [];
  try {
    for (const run of fixtures) {
      for (const table of ['PeopleBaseItemMap', 'Peoples', 'ItemValuesMap', 'ItemValues', 'AncestorIds', 'BaseItems', 'Users']) {
        await db.client.query('DELETE FROM ' + quoteIdentifier(table));
      }
      await db.insert('Users', { ...empty('Users'), Id: run.input.userId, Username: 'Search audit', NormalizedUsername: 'SEARCH AUDIT', InternalId: 1 });
      // The fixture preserves actual native table rows. Deferred parent keys
      // permit this recorded insertion order without replacing the root graph.
      await db.transaction(async transaction => {
        await transaction.client.query('SET CONSTRAINTS ALL DEFERRED');
        for (const source of run.seed.BaseItems) {
          const row = { ...source };
          for (const macro of ['%AppDataPath%', '%MetadataPath%']) row.Path = expandStatePath(row.Path, macro, macro);
          await transaction.insert('BaseItems', adapt('BaseItems', row));
        }
      });
      for (const table of ['AncestorIds', 'ItemValues', 'ItemValuesMap', 'Peoples', 'PeopleBaseItemMap']) {
        for (const row of run.seed[table]) await db.insert(table, adapt(table, row));
      }
      const before = {};
      for (const table of ['BaseItems', 'AncestorIds', 'ItemValues', 'ItemValuesMap', 'Peoples', 'PeopleBaseItemMap']) before[table] = await db.rows(table);
      const runtime = await mkdtemp(path.join(tmpdir(), 'mm-root-cached-')); runtimes.push(runtime);
      const library = new LibraryService({fileSystem: testFileSystem,  store: new DomainStore(db), serverId: 'candidate-search-audit', programDataPath: runtime,
        configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false } });
      await attachLibraryNavigation(library);
      try {
      for (const expected of run.native) {
        const readback = run.actualUserAndViews.find(row => row.name === expected.name).user.bodyJson;
        const user = { ...readback, MaxParentalRatingScore: readback.Policy.MaxParentalRating, MaxParentalRatingSubScore: readback.Policy.MaxParentalSubRating };
        const query = Object.fromEntries(new URL(expected.route, 'http://localhost').searchParams);
        let actual;
        try { actual = { status: 200, body: JSON.parse(stringifyNativeJson(await (expected.endpoint.startsWith('views') ? library.getViews({ userId: run.input.userId, includeHidden: true }, { user }) : library.queryItems(query, { user })))) }; }
        catch (error) { actual = { status: error.status ?? 500, error: { name: error.name, message: error.message } }; }
        const wanted = { status: expected.response.status, body: expected.response.bodyJson };
        const row = { nativeInputSha256: run.provenance.fixtureSha256, name: expected.name, endpoint: expected.endpoint, route: expected.route, actual, expected: wanted };
        cases.push(row);
        if (stable(actual) !== stable(wanted)) differences.push(row);
      }
      } finally { await closeLibraryNavigation(library); }
      const after = {}; for (const table of Object.keys(before)) after[table] = await db.rows(table);
      assert.deepEqual(after, before, 'Candidate reads preserve the raw recorded seed');
      seedReadback.push({ nativeInputSha256: run.provenance.fixtureSha256, before, after, unchanged: true, libraryClosed: true });
    }
  } finally {
    await db.client.query('DROP SCHEMA ' + quoteIdentifier(db.schemaName) + ' CASCADE');
    await db.client.query('DROP SCHEMA ' + quoteIdentifier(db.controlSchema) + ' CASCADE');
    cleanup.schemasRemoved = (await db.client.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])', [[db.schemaName, db.controlSchema]])).rows.length === 0;
    await db.close(); cleanup.databaseClosed = true;
    try {
      await db.client.query('SELECT 1');
    } catch (error) { cleanup.closeProbe = /not open|closed/i.test(error.message); }
    if (process.env.MEDIAMANAGER_ROOT_CACHED_ARTIFACT_DIR) {
      const directory = path.resolve(process.env.MEDIAMANAGER_ROOT_CACHED_ARTIFACT_DIR);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, dialect + '.json'), JSON.stringify({ phaseAcceptance: false, dialect, schema, cases, differences, seedReadback, runtimes, cleanup,
        boundary: 'Actual database service and native serializer replay complete DTO/status. Native recorded policy/view inputs and raw built-in Playlists row are supplied; an independent runtime program data path expands its recorded %AppDataPath% placeholder and derives the same portable native ID; candidate HTTP transport, authentication and legacy routing are not invoked.' }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    }
  }
  assert.deepEqual(cleanup, { databaseClosed: true, schemasRemoved: true, closeProbe: true });
  assert.equal(cases.length, 48);
  assert.deepEqual(differences, []);
});
