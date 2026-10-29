import { sqliteCellProjection, sqliteCellParameter, sqliteSetProjection } from './native-text-sql.js';
import { DatabaseSync, backup } from 'node:sqlite';
import { open } from 'node:fs/promises';
import { nativeModel, quoteIdentifier as q, tableDefinition, columnDefinition, createTableSql, createIndexSql } from './model.js';
import { encodeValue, decodeValue, encodeValueSet } from './values.js';
import { scanNativeRelationRows } from './native-relation-order.js';
import { inspectSqliteSchema, preflightSqlite } from './sqlite-schema.js';

export { inspectSqliteSchema, preflightSqlite, SchemaCompatibilityError } from './sqlite-schema.js';

const statement = (database, sql) => {
  const prepared = database.prepare(sql);
  prepared.setReadBigInts(true);
  return prepared;
};
const decodeRow = (row, columns, consumer) => {
  const decoded = {};
  for (const column of columns) decoded[column.name] = decodeValue(column, row[column.name], 'sqlite', consumer);
  return decoded;
};

export class SqliteDatabase {
  constructor(filename, { create = false, readOnly = false, requireMigrationHistory = false } = {}) {
    this.dialect = 'sqlite';
    this.filename = filename;
    this.readOnly = readOnly;
    this.database = new DatabaseSync(filename, { readOnly, enableForeignKeyConstraints: true });
    this.database.exec('PRAGMA busy_timeout = 60000');
    try {
      if (create) {
        if (readOnly || this.database.prepare('SELECT name FROM sqlite_schema').all().length) throw new Error('Database creation requires a new empty database');
        this.transaction(() => {
          for (const table of nativeModel.tables) this.database.exec(createTableSql(table));
          for (const table of nativeModel.tables) for (const index of table.indices) this.database.exec(createIndexSql(table, index));
        });
      }
      this.schema = preflightSqlite(this.database, { requireMigrationHistory });
    } catch (error) { this.database.close(); throw error; }
  }

  preflight(options) { this.schema = preflightSqlite(this.database, options); return this.schema; }
  transaction(callback) {
    if (callback.constructor.name === 'AsyncFunction') throw new TypeError('SQLite transaction callbacks must be synchronous');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback(this);
      if (result && typeof result.then === 'function') throw new TypeError('SQLite transaction callbacks must be synchronous');
      this.database.exec('COMMIT');
      return result;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  relationRowsInInsertionOrder(name, options) { return scanNativeRelationRows(this, name, options); }
  rows(name, { where = {}, whereIn = {}, whereAny = {}, whereNotNull = [], columns, orderBy, limit, offset = 0, after, consumer = 'runtime' } = {}) {
    const table = tableDefinition(name);
    if (!whereIn || typeof whereIn !== 'object' || Array.isArray(whereIn)) throw new TypeError('whereIn must be a column-to-array object');
    if (!whereAny || typeof whereAny !== 'object' || Array.isArray(whereAny)) throw new TypeError('whereAny must be a column-to-array object');
    if (!Array.isArray(whereNotNull) || new Set(whereNotNull).size !== whereNotNull.length) {
      throw new TypeError('whereNotNull must contain unique column names');
    }
    const selected = columns === undefined ? table.columns : (() => {
      if (!Array.isArray(columns) || !columns.length || new Set(columns).size !== columns.length) {
        throw new TypeError('columns must contain unique column names');
      }
      return columns.map(key => columnDefinition(table, key));
    })();
    if (after !== undefined) {
      if (!after || typeof after !== 'object' || Array.isArray(after)
        || Object.keys(after).length !== table.primaryKey.length
        || table.primaryKey.some(key => !Object.hasOwn(after, key))) {
        throw new TypeError('after must contain exactly the complete primary key');
      }
      if (orderBy !== undefined || offset !== 0) {
        throw new TypeError('after keyset pagination requires the default primary-key order and zero offset');
      }
    }
    const args = [];
    const predicates = Object.entries(where).map(([key, value]) => { const column = columnDefinition(table, key); if (value === null) return `${q(key)} IS NULL`; args.push(encodeValue(column, value)); return `${q(key)} = ${sqliteCellParameter(columnDefinition(table, key))}`; });
    for (const [key, values] of Object.entries(whereIn)) {
      const column = columnDefinition(table, key), encoded = encodeValueSet(column, values);
      const projection = sqliteSetProjection(column);
      const clauses = [];
      if (encoded.values.length) {
        args.push(JSON.stringify(encoded.values));
        clauses.push(`${q(key)} IN (SELECT ${projection} FROM json_each(?))`);
      }
      if (encoded.includesNull) clauses.push(`${q(key)} IS NULL`);
      predicates.push(clauses.length ? `(${clauses.join(' OR ')})` : '0');
    }
    const anyPredicates = [];
    for (const [key, values] of Object.entries(whereAny)) {
      const column = columnDefinition(table, key), encoded = encodeValueSet(column, values);
      const projection = sqliteSetProjection(column);
      const clauses = [];
      if (encoded.values.length) {
        args.push(JSON.stringify(encoded.values));
        clauses.push(`${q(key)} IN (SELECT ${projection} FROM json_each(?))`);
      }
      if (encoded.includesNull) clauses.push(`${q(key)} IS NULL`);
      anyPredicates.push(clauses.length ? `(${clauses.join(' OR ')})` : '0');
    }
    if (anyPredicates.length) predicates.push(`(${anyPredicates.join(' OR ')})`);
    for (const key of whereNotNull) { columnDefinition(table, key); predicates.push(`${q(key)} IS NOT NULL`); }
    if (after !== undefined) {
      for (const key of table.primaryKey) args.push(encodeValue(columnDefinition(table, key), after[key]));
      predicates.push(`(${table.primaryKey.map(q).join(', ')}) > (${table.primaryKey.map(key => sqliteCellParameter(columnDefinition(table, key))).join(', ')})`);
    }
    const order = orderBy ?? table.primaryKey.map((column) => ({ column, direction: 'ASC' }));
    // ORDER BY must name the stored column, rather than its raw-byte output
    // alias. Native TEXT is preflighted as TEXT with the pinned BINARY order.
    let sql = `SELECT ${selected.map(column => sqliteCellProjection(column)).join(', ')} FROM ${q(name)}${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''} ORDER BY ${order.map(({ column, direction = 'ASC' }) => { columnDefinition(table, column); if (!['ASC', 'DESC'].includes(direction)) throw new Error('Invalid sort direction'); return `${q(name)}.${q(column)} ${direction}`; }).join(', ')}`;
    if (limit !== undefined) { if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid pagination'); sql += ' LIMIT ? OFFSET ?'; args.push(limit, offset); }
    const query = statement(this.database, sql);
    query.setReturnArrays(true);
    return query.all(...args).map(row => {
      const decoded = {};
      for (let index = 0; index < selected.length; index++) {
        const column = selected[index];
        decoded[column.name] = decodeValue(column, row[index], 'sqlite', consumer);
      }
      return decoded;
    });
  }
  insert(name, values, { consumer = 'runtime' } = {}) {
    const table = tableDefinition(name);
    const names = Object.keys(values);
    for (const column of table.columns) if (!column.nullable && !column.generated && !names.includes(column.name)) throw new TypeError(`Missing ${name}.${column.name}`);
    const args = names.map((key) => encodeValue(columnDefinition(table, key), values[key]));
    const row = statement(this.database, `INSERT INTO ${q(name)} (${names.map(q).join(', ')}) VALUES (${names.map(key => sqliteCellParameter(columnDefinition(table, key))).join(', ')}) RETURNING ${table.columns.map(column => sqliteCellProjection(column)).join(', ')}`).get(...args);
    return decodeRow(row, table.columns, consumer);
  }
  insertBatch(name, values) {
    const table = tableDefinition(name);
    if (!Array.isArray(values)) throw new TypeError('Batch insert values must be an array');
    if (!values.length) return 0n;
    const first = values[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) {
      throw new TypeError(`Batch inserts require a consistent ${name} row shape`);
    }
    const names = Object.keys(first), columns = table.columns.filter(column => Object.hasOwn(first, column.name));
    for (const key of names) columnDefinition(table, key);
    for (const column of table.columns) {
      if (!column.nullable && !column.generated && !Object.hasOwn(first, column.name)) {
        throw new TypeError(`Missing ${name}.${column.name}`);
      }
    }
    if (!columns.length) throw new TypeError(`Batch inserts require at least one ${name} column`);
    for (const row of values) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== names.length
        || columns.some(column => !Object.hasOwn(row, column.name))) {
        throw new TypeError(`Batch inserts require a consistent ${name} row shape`);
      }
    }
    // Exchange already consumes and verifies bounded source rows. Reuse the
    // insert statement and avoid materializing a discarded RETURNING row.
    const insert = statement(this.database, `INSERT INTO ${q(name)} (${columns.map(column => q(column.name)).join(', ')}) VALUES (${columns.map(column => sqliteCellParameter(column)).join(', ')})`);
    let inserted = 0n;
    for (const row of values) {
      const result = insert.run(...columns.map(column => encodeValue(column, row[column.name])));
      if (result.changes !== 1n) throw new Error(`SQLite batch insert count mismatch for ${name}`);
      inserted += result.changes;
    }
    return inserted;
  }
  upsert(name, values, { consumer = 'runtime' } = {}) {
    const table = tableDefinition(name);
    const names = Object.keys(values);
    if (table.primaryKey.some(key => !names.includes(key))) throw new Error('Upserts require a complete primary key');
    for (const column of table.columns) if (!column.nullable && !column.generated && !names.includes(column.name)) throw new TypeError(`Missing ${name}.${column.name}`);
    const args = names.map(key => encodeValue(columnDefinition(table, key), values[key]));
    const changes = table.columns.filter(column => !column.generated && !table.primaryKey.includes(column.name));
    const assignments = changes.length
      ? changes.map(column => `${q(column.name)} = excluded.${q(column.name)}`).join(', ')
      : `${q(table.primaryKey[0])} = excluded.${q(table.primaryKey[0])}`;
    const row = statement(this.database, `INSERT INTO ${q(name)} (${names.map(q).join(', ')}) VALUES (${names.map(key => sqliteCellParameter(columnDefinition(table, key))).join(', ')}) ON CONFLICT (${table.primaryKey.map(q).join(', ')}) DO UPDATE SET ${assignments} RETURNING ${table.columns.map(column => sqliteCellProjection(column)).join(', ')}`).get(...args);
    return decodeRow(row, table.columns, consumer);
  }
  update(name, keys, values, { rowVersion } = {}) {
    const table = tableDefinition(name);
    if (table.primaryKey.some((key) => !(key in keys))) throw new Error('Updates require a complete primary key');
    const changes = { ...values };
    if (rowVersion !== undefined) changes.RowVersion = (BigInt(rowVersion) + 1n) & 4294967295n;
    if (!Object.keys(changes).length) throw new TypeError('An update requires at least one changed value.');
    const args = Object.entries(changes).map(([key, value]) => encodeValue(columnDefinition(table, key), value));
    const conditions = Object.entries(keys).map(([key, value]) => { args.push(encodeValue(columnDefinition(table, key), value)); return `${q(key)} = ${sqliteCellParameter(columnDefinition(table, key))}`; });
    if (rowVersion !== undefined) { args.push(encodeValue(columnDefinition(table, 'RowVersion'), rowVersion)); conditions.push('"RowVersion" = ?'); }
    const result = statement(this.database, `UPDATE ${q(name)} SET ${Object.keys(changes).map((key) => `${q(key)} = ${sqliteCellParameter(columnDefinition(table, key))}`).join(', ')} WHERE ${conditions.join(' AND ')}`).run(...args);
    if (rowVersion !== undefined && result.changes === 0n) throw new Error('Concurrency conflict');
    return result.changes;
  }
  updateWhere(name, where, values, { whereIn = {} } = {}) {
    const table = tableDefinition(name), changes = Object.entries(values);
    if (!changes.length) throw new TypeError('A bulk update requires at least one changed value.');
    if (!whereIn || typeof whereIn !== 'object' || Array.isArray(whereIn)) throw new TypeError('whereIn must be a column-to-array object');
    const args = changes.map(([key, value]) => encodeValue(columnDefinition(table, key), value));
    const conditions = Object.entries(where).map(([key, value]) => {
      const column = columnDefinition(table, key);
      if (value === null) return `${q(key)} IS NULL`;
      args.push(encodeValue(column, value)); return `${q(key)} = ${sqliteCellParameter(columnDefinition(table, key))}`;
    });
    for (const [key, values] of Object.entries(whereIn)) {
      const column = columnDefinition(table, key), encoded = encodeValueSet(column, values);
      const projection = sqliteSetProjection(column);
      const clauses = [];
      if (encoded.values.length) {
        args.push(JSON.stringify(encoded.values));
        clauses.push(`${q(key)} IN (SELECT ${projection} FROM json_each(?))`);
      }
      if (encoded.includesNull) clauses.push(`${q(key)} IS NULL`);
      conditions.push(clauses.length ? `(${clauses.join(' OR ')})` : '0');
    }
    if (!conditions.length) throw new TypeError('A bulk update requires a nonempty predicate.');
    return statement(this.database, `UPDATE ${q(name)} SET ${changes.map(([key]) => `${q(key)} = ${sqliteCellParameter(columnDefinition(table, key))}`).join(', ')} WHERE ${conditions.join(' AND ')}`).run(...args).changes;
  }
  delete(name, keys) {
    const table = tableDefinition(name);
    if (table.primaryKey.some((key) => !(key in keys))) throw new Error('Deletes require a complete primary key');
    return this.deleteWhere(name, keys);
  }
  deleteWhere(name, where, { whereIn = {} } = {}) {
    const table = tableDefinition(name), entries = Object.entries(where);
    if (!whereIn || typeof whereIn !== 'object' || Array.isArray(whereIn)) throw new TypeError('whereIn must be a column-to-array object');
    const args = [], conditions = entries.map(([key, value]) => {
      const column = columnDefinition(table, key);
      if (value === null) return `${q(key)} IS NULL`;
      args.push(encodeValue(column, value)); return `${q(key)} = ${sqliteCellParameter(columnDefinition(table, key))}`;
    });
    for (const [key, values] of Object.entries(whereIn)) {
      const column = columnDefinition(table, key), encoded = encodeValueSet(column, values);
      const projection = sqliteSetProjection(column);
      const clauses = [];
      if (encoded.values.length) {
        args.push(JSON.stringify(encoded.values));
        clauses.push(`${q(key)} IN (SELECT ${projection} FROM json_each(?))`);
      }
      if (encoded.includesNull) clauses.push(`${q(key)} IS NULL`);
      conditions.push(clauses.length ? `(${clauses.join(' OR ')})` : '0');
    }
    if (!conditions.length) throw new TypeError('A bulk delete requires a nonempty predicate.');
    return statement(this.database, `DELETE FROM ${q(name)} WHERE ${conditions.join(' AND ')}`).run(...args).changes;
  }
  close() { this.database.close(); }
  async snapshot(destination) {
    let reserved;
    try { reserved = await open(destination, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Snapshot destination already exists'); throw error; }
    await reserved.close();
    await backup(this.database, destination);
  }
}
