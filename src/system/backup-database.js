import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeInsertionOrderedTables, nativeRelationOrderDefinition } from '../database/native-relation-order.js';

// Catalog names always come from the selected PostgreSQL instance. Keep the
// server's row JSON as text so BIGINTs and native bytea values round-trip exactly.
async function catalog(db) {
  const schemas = [db.schemaName, db.controlSchema];
  const tables = await db.client.query(`
    SELECT n.nspname AS schema, c.relname AS name, array_agg(a.attname::text ORDER BY a.attnum) AS columns,
           array_agg(format_type(a.atttypid, a.atttypmod) ORDER BY a.attnum) AS types
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
    WHERE n.nspname = ANY($1::text[]) AND c.relkind = 'r'
    GROUP BY n.nspname, c.relname ORDER BY n.nspname, c.relname`, [schemas]);
  const sequences = await db.client.query(`SELECT schemaname AS schema, sequencename AS name FROM pg_sequences
    WHERE schemaname = ANY($1::text[]) ORDER BY schemaname, sequencename`, [schemas]);
  return { tables: tables.rows, sequences: sequences.rows };
}

const qualified = row => q(row.schema) + '.' + q(row.name);
const tableFile = index => 'Database/' + index + '.ndjson';

export async function captureBackupDatabase(db, save) {
  const layout = await catalog(db);
  const positions = [];
  for (const sequence of layout.sequences) {
    const result = await db.client.query('SELECT last_value::text, is_called FROM ' + qualified(sequence));
    positions.push(result.rows[0]);
  }
  await save('Database/catalog.json', [Buffer.from(JSON.stringify({ layout, positions }))]);
  for (const [index, table] of layout.tables.entries()) {
    await db.client.query('DECLARE mm_backup NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS data FROM ' + qualified(table) + ' t');
    async function* pages() {
      for (;;) {
        const { rows } = await db.client.query('FETCH FORWARD 128 FROM mm_backup');
        if (!rows.length) break;
        yield Buffer.from('[' + rows.map(row => row.data).join(',') + ']\n');
      }
    }
    await save(tableFile(index), pages());
    await db.client.query('CLOSE mm_backup');
  }
}

export async function validateBackupDatabase(db, payloads, { layout, positions }) {
  const current = await catalog(db);
  if (!isDeepStrictEqual(current, layout) || !Array.isArray(positions) || positions.length !== current.sequences.length
    || positions.some(p => !p || !/^-?\d+$/u.test(p.last_value) || typeof p.is_called !== 'boolean')
    || current.tables.some((_, index) => !payloads.has(tableFile(index)))
    || [...payloads.keys()].filter(key => key.startsWith('Database/')).length !== current.tables.length + 1) {
    throw new Error('The backup does not match the active PostgreSQL schema.');
  }
  return current;
}

export async function restoreBackupDatabase(db, payloads, backup) {
  const current = await validateBackupDatabase(db, payloads, backup);
  // The order tables below are themselves archived, including their gaps.
  // Suppress only their insert mirrors while replacing the original rows.
  const mirrors = nativeInsertionOrderedTables.map(name => ({ table: q(db.schemaName) + '.' + q(name),
    trigger: q('mm_' + nativeRelationOrderDefinition(name).table) }));
  for (const { table, trigger } of mirrors) await db.client.query('ALTER TABLE ' + table + ' DISABLE TRIGGER ' + trigger);
  await db.client.query('SET CONSTRAINTS ALL DEFERRED');
  await db.client.query('TRUNCATE ' + current.tables.map(qualified).join(', ') + ' RESTART IDENTITY');
  for (const [index, table] of current.tables.entries()) {
    const relation = qualified(table), columns = table.columns.map(q).join(', ');
    const sql = 'INSERT INTO ' + relation + ' (' + columns + ') OVERRIDING SYSTEM VALUE SELECT ' + columns +
      ' FROM json_populate_recordset(NULL::' + relation + ', $1::json)';
    const stream = createReadStream(payloads.get(tableFile(index)), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try { for await (const page of lines) await db.client.query(sql, [page]); }
    finally { lines.close(); stream.destroy(); }
  }
  await db.client.query('SET CONSTRAINTS ALL IMMEDIATE');
  for (const { table, trigger } of mirrors) await db.client.query('ALTER TABLE ' + table + ' ENABLE TRIGGER ' + trigger);
  for (const [index, sequence] of current.sequences.entries()) {
    const { last_value, is_called } = backup.positions[index];
    await db.client.query('SELECT setval($1::regclass, $2::bigint, $3::boolean)', [qualified(sequence), last_value, is_called]);
  }
}
