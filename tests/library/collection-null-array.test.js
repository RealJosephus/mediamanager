import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { tableDefinition, quoteIdentifier } from '../../src/database/model.js';
import { loadLibrary, idKey } from '../../src/library/records.js';
import { collectionFoldersForItem } from '../../src/library/collection-membership.js';
import { observeComparison } from '../comparison-observations.js';

const bytes = await readFile(new URL('./fixtures/collection-null-array/native.json', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '0dc2303b3688f1136cb780af7fcaa3a6f3fd0da22b340ee1e542c55addfed25a');
const fixture = JSON.parse(bytes);
assert.equal(fixture.nativeVerified, true);
assert.equal(fixture.phaseAcceptance, false);
assert.equal(fixture.rows.length, 72);
assert.equal(fixture.rawNativeSha256, '190d85114da87a928a452aa92c2497c3c82db9d2f66a9958d9f67d33d6a939d7');
assert.equal(fixture.provenance.process.code, 0);
assert.equal(fixture.provenance.sourceStable, true);
for (const assembly of fixture.provenance.assemblies) assert.equal(assembly.sha256, assembly.frozenSha256);
const fixtureSha256 = createHash('sha256').update(bytes).digest('hex');
const empty = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => [column.name,
  column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' || column.clrType === 'uint' ? 0n : 0]));
const typeNames = { Folder: 'MediaBrowser.Controller.Entities.Folder', CollectionFolder: 'MediaBrowser.Controller.Entities.CollectionFolder', AggregateFolder: 'MediaBrowser.Controller.Entities.AggregateFolder' };
for (const dialect of ['postgres']) test(`${dialect}: 72 native null-array getter outcomes preserve lazy failure and membership`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = `null_array_${process.pid}_${randomBytes(4).toString('hex')}`;
  const db = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  const cases = [], differences = [], cleanup = { databaseClosed: false, schemasRemoved: false, closeProbe: false };
  try {
    for (const expected of fixture.rows) {
      await db.client.query('DELETE FROM "BaseItems"');
      for (const item of [
        { Id: expected.readback.itemId, Type: typeNames.Folder, Path: expected.readback.itemPath, Data: '{}' },
        { Id: expected.readback.folderId, Type: typeNames[expected.type], Path: expected.readback.folderPath, Data: expected.json },
      ]) await db.insert('BaseItems', { ...empty('BaseItems'), ...item, IsFolder: true });
      const inputReadback = await db.rows('BaseItems'), state = await loadLibrary(db, {},
        { baseRows: inputReadback }), item = state.byId.get(idKey(expected.readback.itemId)), folder = state.byId.get(idKey(expected.readback.folderId));
      let actual;
      try { actual = { collectionFolders: collectionFoldersForItem(item, state, [folder]).map(result => result.Id) }; }
      catch (error) {
        assert.equal(folder.PhysicalLocationsList, null);
        actual = { exceptionType: error.name, message: error.message, code: error.code, status: error.status, stack: error.stack };
      }
      const wanted = expected.outcome.collectionFolders ? { collectionFolders: expected.outcome.collectionFolders } : { exceptionType: expected.outcome.exceptionType, message: expected.outcome.message, parameterName: expected.outcome.parameterName };
      const result = { name: expected.name, actual, expected: wanted, inputReadback };
      observeComparison(t, expected.name + ' collection failure', actual, wanted);
      const outcome = value => value.collectionFolders ? { collectionFolders: value.collectionFolders } : { failed: value.exceptionType != null };
      cases.push(result); if (JSON.stringify(outcome(actual)) !== JSON.stringify(outcome(wanted))) differences.push(result);
      assert.deepEqual(await db.rows('BaseItems'), inputReadback, 'membership failure must not change persisted input');
    }
  } finally {
    if (dialect === 'postgres') {
      await db.client.query('DROP SCHEMA ' + quoteIdentifier(db.schemaName) + ' CASCADE');
      await db.client.query('DROP SCHEMA ' + quoteIdentifier(db.controlSchema) + ' CASCADE');
      cleanup.schemasRemoved = (await db.client.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])', [[db.schemaName, db.controlSchema]])).rows.length === 0;
    }
    await db.close(); cleanup.databaseClosed = true;
    try { await db.client.query('SELECT 1'); }
    catch (error) { cleanup.closeProbe = /not open|closed/i.test(error.message); }
    if (process.env.MEDIAMANAGER_NULL_ARRAY_ARTIFACT_DIR) {
      const directory = path.resolve(process.env.MEDIAMANAGER_NULL_ARRAY_ARTIFACT_DIR); await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, dialect + '.json'), JSON.stringify({ phaseAcceptance: false, dialect, schema, fixtureSha256, cases, differences, cleanup,
        boundary: 'Actual DB loadLibrary mapping and membership helper with explicit folders. Typed-domain exception markers, not HTTP transport equivalence; no cached/virtual UserRoot child proof.' }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    }
  }
  assert.deepEqual(cleanup, { databaseClosed: true, schemasRemoved: true, closeProbe: true });
  assert.equal(cases.length, 72);
  assert.deepEqual(differences, []);
});
