import { createHash } from 'node:crypto';
import { NativeTextCell } from './native-text.js';
import { encodeValue, decodeValue, canonicalCell } from './values.js';
import { quoteIdentifier as q } from './model.js';
import { nativeInsertionOrderedTables, nativeRelationOrderDefinition } from './native-relation-order.js';
import { sqliteCellProjection, sqliteCellParameter, rawPostgresRowPlan, rawSqliteRowPlan } from './native-text-sql.js';

export function decodeExchangeRow(table, row, dialect) {
  return Object.fromEntries(table.columns.map(column => [column.name, decodeValue(column, row[column.name], dialect, 'exchange')]));
}

export function canonicalExchangeRow(table, row) {
  return table.columns.map(column => {
    const value = row[column.name];
    if (column.type === 'TEXT' && value !== null && !(value instanceof NativeTextCell)) throw new TypeError(`Exchange ${table.name}.${column.name} must preserve raw TEXT bytes.`);
    return canonicalCell(value);
  });
}

/** The scanner preserves explicit insertion-sensitive relation order, and
 * otherwise uses the same native primary-key byte order on both databases. */
export async function* exchangePages(database, table, { pageSize = 128, relationOrder, signal } = {}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 128) throw new TypeError('Exchange pages require a limit from 1 through 128.');
  relationOrder ??= nativeInsertionOrderedTables.includes(table.name) ? nativeRelationOrderDefinition(table.name) : undefined;
  if (relationOrder && (!relationOrder.keys?.length || relationOrder.keys.length !== table.primaryKey.length
    || new Set(relationOrder.keys.map(([key]) => key)).size !== relationOrder.keys.length
    || new Set(relationOrder.keys.map(([, key]) => key)).size !== table.primaryKey.length
    || relationOrder.keys.some(([orderKey, nativeKey]) => !orderKey || !table.primaryKey.includes(nativeKey)))) {
    throw new TypeError('A relation order plan requires every native primary-key column exactly once.');
  }
  let after;
  while (true) {
    signal?.throwIfAborted();
    let rows, positions;
    if (database.dialect === 'sqlite') {
      if (relationOrder) {
        const selected = table.columns.map(column => sqliteCellProjection(column, 'source')).join(', ');
        const query = database.database.prepare(`SELECT ${selected}, source.rowid AS "__position" FROM ${q(table.name)} source ${after === undefined ? '' : 'WHERE source.rowid > ?'} ORDER BY source.rowid LIMIT ?`);
        query.setReadBigInts(true); rows = query.all(...(after === undefined ? [pageSize] : [after, pageSize])); positions = rows.map(row => row.__position);
      } else {
        const plan = rawSqliteRowPlan(table, { after, limit: pageSize });
        const query = database.database.prepare(plan.text); query.setReadBigInts(true); rows = query.all(...plan.values);
      }
    } else if (database.dialect === 'postgres') {
      if (relationOrder) {
        const selected = table.columns.map(column => `source.${q(column.name)}`).join(', ');
        const plan = { text: `SELECT ${selected}, sequence.position AS "__position" FROM ${q(database.schemaName)}.${q(table.name)} source
          JOIN ${q(database.controlSchema)}.${q(relationOrder.table)} sequence ON ${relationOrder.keys.map(([orderKey, nativeKey]) => `sequence.${q(orderKey)}=source.${q(nativeKey)}`).join(' AND ')}
          ${after === undefined ? '' : 'WHERE sequence.position > $2::bigint'} ORDER BY sequence.position LIMIT $1`, values: after === undefined ? [pageSize] : [pageSize, after] };
        rows = (await database.client.query(plan)).rows; positions = rows.map(row => row.__position);
      } else {
        rows = (await database.client.query(rawPostgresRowPlan(table, database.schemaName, { after, limit: pageSize }))).rows;
      }
    } else throw new TypeError('Raw exchange requires SQLite or PostgreSQL.');
    if (!rows.length) return;
    yield rows.map(row => decodeExchangeRow(table, row, database.dialect));
    after = positions ? positions.at(-1) : Object.fromEntries(table.primaryKey.map(key => [key, rows.at(-1)[key]]));
    if (rows.length < pageSize) return;
  }
}

export function exchangeInsertPlan(table, rows, dialect, schema) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 128) throw new TypeError('Exchange inserts require 1 through 128 rows.');
  if (!['sqlite', 'postgres'].includes(dialect)) throw new TypeError('Unsupported exchange target.');
  const values = [], tuples = rows.map(row => `(${table.columns.map(column => {
    if (column.type === 'TEXT' && row[column.name] !== null && !(row[column.name] instanceof NativeTextCell)) throw new TypeError(`Exchange ${table.name}.${column.name} requires raw TEXT.`);
    values.push(encodeValue(column, row[column.name], dialect));
    return dialect === 'sqlite' ? sqliteCellParameter(column) : `$${values.length}`;
  }).join(', ')})`);
  const target = dialect === 'sqlite' ? q(table.name) : `${q(schema)}.${q(table.name)}`;
  return { text: `INSERT INTO ${target} (${table.columns.map(column => q(column.name)).join(', ')}) VALUES ${tuples.join(', ')}`, values };
}

export async function exchangeDigest(database, tables, options = {}) {
  const output = [];
  for (const table of tables) {
    const hash = createHash('sha256'); let rows = 0;
    for await (const page of exchangePages(database, table, { ...options, relationOrder: options.relationOrders?.[table.name] })) {
      for (const row of page) { hash.update(JSON.stringify(canonicalExchangeRow(table, row)) + '\n'); rows++; }
    }
    output.push({ name: table.name, rows, sha256: hash.digest('hex') });
  }
  return output;
}
