import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tableDefinition } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../../src/database/native-text.js';
import { nativeTextSql } from '../../src/database/native-text-sql.js';
import { buildPostgresItemPageQuery, queryPostgresItemPage } from '../../src/database/postgres-item-query.js';
import { resolvePostgresSearchCollation } from '../../src/library/postgres-search-provider.js';

const fixtureRoot = new URL('../core/fixtures/native-text-sort-boundaries/', import.meta.url);
const referenceBytes = await readFile(new URL('native.json', fixtureRoot));
const reference = JSON.parse(referenceBytes);
const provenance = JSON.parse(await readFile(new URL('provenance.json', fixtureRoot), 'utf8'));

test('native TEXT sort fixture binds actual getters and comparisons to its recorded inputs', async () => {
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha(referenceBytes), provenance.nativeSha256);
  assert.equal(sha(await readFile(new URL('input.json', fixtureRoot))), provenance.inputSha256);
  assert.equal(reference.actualNativeSortName, true);
  assert.equal(reference.sorts.length, 14);
  assert.equal(reference.sortComparisons.length, 196);
  assert.equal(provenance.sourceInputsStable, true);
  assert.equal(provenance.build.status, 0);
  assert.equal(provenance.process.status, 0);
  for (const source of provenance.oracleSources) {
    const sourceUrl = source.name === 'Directory.Build.props'
      ? new URL('../../../Directory.Build.props', fixtureRoot)
      : new URL(source.name, fixtureRoot);
    assert.equal(sha(await readFile(sourceUrl)), source.sha256);
  }
});
const blank = Object.fromEntries(tableDefinition('BaseItems').columns.filter(c => !c.generated).map(c => [c.name,
  c.clrType.replace('?', '') === 'DateTime' ? '2026-10-01 00:00:00' : c.nullable ? null
    : c.type === 'TEXT' ? '' : c.clrType === 'bool' ? false : 0]));
const id = n => `25000000-0000-0000-0000-${String(n + 1).padStart(12, '0')}`;

// Inspect the real public plan's sort expression rather than duplicate its
// normalization algorithm in a test-only implementation.
function sortExpression(plan) {
  const start = plan.text.indexOf('"mm_ordinal_ignore_case_key"(');
  assert.ok(start >= 0);
  const open = start + '"mm_ordinal_ignore_case_key"'.length;
  let depth = 0, quoted = false;
  for (let i = open; i < plan.text.length; i++) {
    const c = plan.text[i];
    if (c === "'") {
      if (quoted && plan.text[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    }
    if (!quoted) {
      if (c === '(') depth++;
      if (c === ')' && --depth === 0) return plan.text.slice(open + 1, i);
    }
  }
  throw new Error('Unbalanced public sort expression.');
}

test('actual PostgreSQL preserves native TEXT sort getters, culture comparisons and stable pages', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = 'text_sort_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  t.after(async () => {
    await database.dropSchemasCreatedByThisOpen();
    await database.close();
  });
  await database.withConnection(async session => {
  const collation = await resolvePostgresSearchCollation(session, reference.culture);
  const second = await Promise.all(Array.from({ length: 4 }, () => resolvePostgresSearchCollation(session, reference.culture)));
  assert.ok(second.every(value => value.schema === 'pg_temp'));
  assert.equal(new Set([collation, ...second].map(value => value.name)).size, 5);
  try {
  const sql = nativeTextSql(schema);
  for (const [field, nativeType] of [['movie', 'Movies.Movie'], ['person', 'Person']]) {
    await database.client.query(`DELETE FROM "${schema}"."BaseItems"`);
    for (const [index, value] of reference.sorts.entries()) await database.insert('BaseItems', {
      ...blank, Id: id(index), Type: 'MediaBrowser.Controller.Entities.' + nativeType,
      Name: value.name, CleanName: value.name, SortName: value[field], Data: '{}', PresentationUniqueKey: id(index),
    });
    const plan = buildPostgresItemPageQuery(database, { sortby: ['SortName'], limit: 14 }, { resumableMode: 'memory' });
    const generated = await database.client.query({
      text: `SELECT i."Id", ${sortExpression(plan)} AS sort FROM "${schema}"."BaseItems" i ORDER BY i."Id"`,
      values: plan.values.slice(0, -1),
    });
    assert.deepEqual(generated.rows.map(row => decodeNativeTextBytes(row.sort)), reference.sorts.map(value => value[field]));
    const cultureText = expression => `replace(replace(${sql.projection(expression)}, chr(1) || '0', ''), chr(1) || '1', '') COLLATE "${collation.schema}"."${collation.name}"`;
    const pairs = await database.client.query({
      text: `WITH names AS (SELECT * FROM unnest($1::integer[], $2::bytea[]) AS item(index, value))
        SELECT l.index AS l, r.index AS r, CASE WHEN ${cultureText('l.value')} < ${cultureText('r.value')} THEN -1
          WHEN ${cultureText('l.value')} > ${cultureText('r.value')} THEN 1 ELSE 0 END AS sign
        FROM names l CROSS JOIN names r ORDER BY l.index, r.index`,
      values: [reference.sorts.map((_, index) => index), reference.sorts.map(value => nativeTextBytes(value[field]))],
    });
    assert.deepEqual(pairs.rows.map(row => row.sign), reference.sortComparisons.map(pair => pair[field + 'Current']));
    const scores = reference.sorts.map((_, index) => ({ id: id(index), score: 100 }));
    const whole = await queryPostgresItemPage(database, { limit: 14 }, { searchScores: scores, searchCollation: collation });
    assert.deepEqual(whole.rows.map(row => Number(row.Id.slice(-12)) - 1), reference[field + 'Order']);
    for (const [position, index] of reference[field + 'Order'].entries()) {
      const page = await queryPostgresItemPage(database, { startindex: position, limit: 1 }, { searchScores: scores, searchCollation: collation });
      assert.deepEqual(page.rows.map(row => row.Id), [id(index)]);
      assert.equal(page.total, 14);
    }
  }
  } finally { for (const scope of [collation, ...second]) await scope.release(); }
  });
});
