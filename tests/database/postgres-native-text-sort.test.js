import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tableDefinition } from '../../src/database/model.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeTextBytes, decodeNativeTextBytes, nativeTextProjection, nativeTextOrdinalKey } from '../../src/database/native-text.js';
import { nativeTextSql } from '../../src/database/native-text-sql.js';
import { buildPostgresItemPageQuery, queryPostgresItemPage } from '../../src/database/postgres-item-query.js';
import { resolvePostgresSearchCollation } from '../../src/library/postgres-search-provider.js';

const fixtureRoot = new URL('../core/fixtures/native-text-sort-boundaries/', import.meta.url);
const referenceBytes = await readFile(new URL('native.json', fixtureRoot));
const reference = JSON.parse(referenceBytes);
const provenance = JSON.parse(await readFile(new URL('provenance.json', fixtureRoot), 'utf8'));

test('actual PostgreSQL native TEXT projection preserves complete UTF8 bytes, escapes and invalid-input errors', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const schema = 'native_text_projection_' + randomUUID().replaceAll('-', '').slice(0, 14);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true });
  t.after(async () => { try { await database.dropSchemasCreatedByThisOpen(); } finally { await database.close(); } });
  const values = [null, '', '87200000-0000-0000-0000-000000000027', 'MediaBrowser.Controller.Entities.Movies.Movie',
    'ABCDEF01-2345-6789-ABCD-EF0123456789', 'abcdef0123456789ABCDEF0123456789',
    Array.from({ length: 126 }, (_, index) => String.fromCharCode(index + 2)).join(''),
    Array.from({ length: 128 }, (_, index) => String.fromCharCode(index)).join(''),
    String.raw`C:\Library\Movie.mkv`, '/library/%25literal', 'Café 中文 😀', 'e\u0301', '\0', '\u0001', '\0\u0001',
    '\u00010', '\u00011', '\u000110', '\u000111', '\u0001\u0001', '\u0001\0', '\0\u0001\0',
    '0\u00010\u00011\u000110\u0001110', 'literal\u00010 and \u00011',
    'before\0between\u0001after', 'Unknown traceId & opaque bytes\0中文'];
  const raw = values.map(value => value === null ? null : nativeTextBytes(value));
  const originals = raw.map(value => value === null ? null : Buffer.from(value));
  const expected = values.map(value => value === null ? null : nativeTextProjection(value));
  const result = await database.client.query({ text: `SELECT source.ordinal,source.value,
      "${schema}".mm_bytes_text_projection(source.value) AS projected,
      "${schema}".mm_native_guid_lower(source.value) AS guid_lower,
      lower(source.expected) AS expected_guid_lower,
      "${schema}".mm_text_utf8_key("${schema}".mm_bytes_text_projection(source.value)) AS restored,
      "${schema}".mm_text_utf8_key(source.expected) AS encoded,
      "${schema}".mm_text_utf16_key(source.value) AS ordinal_key,
      "${schema}".mm_projected_utf16_key(source.expected) AS projected_ordinal_key
    FROM unnest($1::bytea[],$2::text[]) WITH ORDINALITY source(value,expected,ordinal) ORDER BY source.ordinal`, values: [raw, expected] });
  assert.deepEqual(result.rows.map(row => row.projected), expected);
  assert.deepEqual(result.rows.map(row => row.guid_lower), result.rows.map(row => row.expected_guid_lower),
    'The GUID query/index consumer retains its database-locale lower of the complete canonical projection.');
  assert.deepEqual(result.rows.map(row => row.value), originals);
  assert.deepEqual(result.rows.map(row => row.restored), originals);
  assert.deepEqual(result.rows.map(row => row.encoded), originals);
  const ordinalKeys = values.map(value => value === null ? null : nativeTextOrdinalKey(value));
  assert.deepEqual(result.rows.map(row => row.ordinal_key), ordinalKeys);
  assert.deepEqual(result.rows.map(row => row.projected_ordinal_key), ordinalKeys,
    'ASCII, adjacent escaped NUL/SOH, literal escape suffixes and Unicode retain complete UTF16 code units.');
  assert.deepEqual(raw, originals, 'SQL projection leaves every original byte buffer unchanged.');

  for (const value of [Buffer.from([0x80]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xf5, 0x80, 0x80, 0x80]), Buffer.from([0xe2, 0x82]), Buffer.from([0x00, 0x80]), Buffer.from([0xff, 0x00, 0x01])]) {
    const original = Buffer.from(value);
    await assert.rejects(database.client.query(`SELECT "${schema}".mm_bytes_text_projection($1::bytea)`, [value]), { code: '22021' });
    await assert.rejects(database.client.query(`SELECT "${schema}".mm_native_guid_lower($1::bytea)`, [value]), { code: '22021' });
    await assert.rejects(database.client.query(`SELECT "${schema}".mm_text_utf16_key($1::bytea)`, [value]), { code: '22021' });
    assert.deepEqual(value, original);
  }
  for (const value of ['\u0001', '\u0001x', 'before\u0001after', '\u0001\u000101', '\u00010\u0001', '\u00011\u0001x']) {
    await assert.rejects(database.client.query(`SELECT "${schema}".mm_text_utf8_key($1::text)`, [value]), { code: '22023' });
    await assert.rejects(database.client.query(`SELECT "${schema}".mm_projected_utf16_key($1::text)`, [value]), { code: '22023' });
  }
  const subsequent = await database.client.query(`SELECT "${schema}".mm_bytes_text_projection($1::bytea) AS value`, [raw[2]]);
  assert.equal(subsequent.rows[0].value, values[2]);
});

test('postgres: native path containment uses the correct Windows separator and a complete directory boundary', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  const schema = 'native_path_prefix_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, schema, create: true, max: 1 });
  const cases = [
    [String.raw`c:\library\Movies`, String.raw`C:\Library`, true],
    [String.raw`c:\library`, String.raw`C:\Library`, true],
    [String.raw`C:\LibrarySibling\Movie`, String.raw`C:\Library`, false],
    ['C:/Library/Movies', String.raw`C:\Library`, true],
    [String.raw`C:\Library\Movies`, 'C:\\Library\\', true],
    [String.raw`C:\Library\..\Other`, String.raw`C:\Library`, false],
    [String.raw`C:\Library\Movie`, 'C:\\', true],
    [String.raw`\\server\share\Library\Movie`, String.raw`\\SERVER\SHARE\library`, true],
    ['/library/Movie', '/library', true],
    ['/Library/Movie', '/library', false],
    ['/librarySibling/Movie', '/library', false],
    ['/library/Movie', '/', true],
    ['/library/Movie', String.raw`C:\library`, false],
    [null, '/library', null],
    ['/library/Movie', null, null],
  ];
  try {
    const sql = nativeTextSql(schema);
    const result = await database.client.query({ text: `SELECT source.ordinal,${sql.pathWithin('source.value', 'source.parent')} AS matched
      FROM unnest($1::bytea[],$2::bytea[]) WITH ORDINALITY source(value,parent,ordinal) ORDER BY source.ordinal`,
    values: [0, 1].map(index => cases.map(row => row[index] == null ? null : nativeTextBytes(row[index]))) });
    assert.deepEqual(result.rows.map(row => row.matched), cases.map(row => row[2]));
  } finally {
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE;DROP SCHEMA "${schema}__mm" CASCADE`); await database.close();
  }
});

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
