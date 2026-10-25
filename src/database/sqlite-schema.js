import { sqliteCellProjection } from './native-text-sql.js';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { nativeModel, quoteIdentifier as q, createTableSql, createIndexSql } from './model.js';
import { encodeValue, decodeValue } from './values.js';

const statement = (database, sql) => {
  const prepared = database.prepare(sql);
  prepared.setReadBigInts(true);
  return prepared;
};
const compare = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ordered = (rows) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
const canonicalEfSchemaDdl = Object.freeze([
  `CREATE TABLE "__EFMigrationsHistory" (
  "MigrationId" TEXT NOT NULL CONSTRAINT "PK___EFMigrationsHistory" PRIMARY KEY,
  "ProductVersion" TEXT NOT NULL
)`,
  `CREATE TABLE "__EFMigrationsLock" (
  "Id" INTEGER NOT NULL CONSTRAINT "PK___EFMigrationsLock" PRIMARY KEY,
  "Timestamp" TEXT NOT NULL
)`,
]);

function sqlTokens(sql) {
  const tokens = [];
  for (let index = 0; index < sql.length;) {
    const character = sql[index], next = sql[index + 1];
    if (/\s/u.test(character)) { index += 1; continue; }
    if (character === '-' && next === '-') {
      index += 2;
      while (index < sql.length && !['\r', '\n'].includes(sql[index])) index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) throw new Error('SQLite schema contains an unterminated comment');
      index = end + 2;
      continue;
    }
    if (["'", '"', '`'].includes(character)) {
      const quote = character;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] !== quote) { index += 1; continue; }
        if (sql[index + 1] === quote) { index += 2; continue; }
        index += 1; closed = true; break;
      }
      if (!closed) throw new Error('SQLite schema contains an unterminated quoted value');
      continue;
    }
    if (character === '[') {
      const end = sql.indexOf(']', index + 1);
      if (end < 0) throw new Error('SQLite schema contains an unterminated quoted identifier');
      index = end + 1;
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/u.test(sql[end])) end += 1;
      tokens.push(sql.slice(index, end).toUpperCase());
      index = end;
      continue;
    }
    tokens.push(character);
    index += 1;
  }
  return tokens;
}

function containsTokenSequence(tokens, sequence) {
  return tokens.some((_, index) => sequence.every((token, offset) => tokens[index + offset] === token));
}

function canonicalIndexSql(sql) {
  const tokens = [];
  for (let index = 0; index < sql.length;) {
    const character = sql[index], next = sql[index + 1];
    if (/\s/u.test(character)) { index += 1; continue; }
    if (character === '-' && next === '-') {
      index += 2;
      while (index < sql.length && !['\r', '\n'].includes(sql[index])) index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) throw new Error('SQLite index SQL contains an unterminated comment');
      index = end + 2;
      continue;
    }
    if (character === "'") {
      let value = '';
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] !== "'") { value += sql[index]; index += 1; continue; }
        if (sql[index + 1] === "'") { value += "'"; index += 2; continue; }
        index += 1; closed = true; break;
      }
      if (!closed) throw new Error('SQLite index SQL contains an unterminated string');
      tokens.push(`STRING:${JSON.stringify(value)}`);
      continue;
    }
    if (['"', '`'].includes(character) || character === '[') {
      const quote = character, close = character === '[' ? ']' : character;
      let value = '';
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] !== close) { value += sql[index]; index += 1; continue; }
        if (sql[index + 1] === close) { value += close; index += 2; continue; }
        index += 1; closed = true; break;
      }
      if (!closed) throw new Error('SQLite index SQL contains an unterminated quoted identifier');
      tokens.push(`WORD:${value.toUpperCase()}`);
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/u.test(sql[end])) end += 1;
      tokens.push(`WORD:${sql.slice(index, end).toUpperCase()}`);
      index = end;
      continue;
    }
    const operator = sql.slice(index, index + 2);
    if (['<=', '>=', '<>', '!=', '==', '||', '<<', '>>'].includes(operator)) {
      tokens.push(`OP:${operator}`);
      index += 2;
      continue;
    }
    tokens.push(`TOKEN:${character}`);
    index += 1;
  }
  for (let index = 0; index <= tokens.length - 3; index += 1) {
    if (tokens[index] === 'WORD:IF' && tokens[index + 1] === 'WORD:NOT'
      && tokens[index + 2] === 'WORD:EXISTS') tokens.splice(index, 3);
  }
  if (tokens.at(-1) === 'TOKEN:;') tokens.pop();
  return tokens.join('\u0000');
}

export function inspectSqliteSchema(database) {
  const objects = database.prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name COLLATE BINARY").all();
  const tables = objects.filter((object) => object.type === 'table').map((object) => {
    const tokens = sqlTokens(object.sql);
    const columns = database.prepare(`PRAGMA table_xinfo(${q(object.name)})`).all().map((column) => ({ name: column.name, type: column.type.toUpperCase(), nullable: column.notnull === 0, default: column.dflt_value, primaryKey: column.pk, hidden: column.hidden })).sort((a, b) => a.name < b.name ? -1 : 1);
    const rawFks = database.prepare(`PRAGMA foreign_key_list(${q(object.name)})`).all();
    const foreignKeys = ordered([...new Set(rawFks.map((fk) => fk.id))].map((id) => {
      const group = rawFks.filter((fk) => fk.id === id).sort((a, b) => a.seq - b.seq);
      return { table: group[0].table, columns: group.map((fk) => fk.from), referencedColumns: group.map((fk) => fk.to), onDelete: group[0].on_delete, onUpdate: group[0].on_update, match: group[0].match };
    }));
    const indices = database.prepare(`PRAGMA index_list(${q(object.name)})`).all().filter((index) => index.origin !== 'pk').map((index) => {
      const columns = database.prepare(`PRAGMA index_xinfo(${q(index.name)})`).all()
        .filter((column) => column.key === 1)
        .map((column) => ({ name: column.name, descending: Boolean(column.desc), collation: column.coll }));
      const partial = Boolean(index.partial);
      return {
        name: index.name,
        unique: Boolean(index.unique),
        origin: index.origin,
        partial,
        columns,
        // PRAGMA metadata fully describes ordinary column indexes. Preserve a
        // tokenized definition only where SQLite exposes neither an expression
        // nor a partial predicate through PRAGMA, avoiding raw DDL sensitivity
        // while still rejecting behavior-changing expression/filter drift.
        sql: partial || columns.some(column => column.name === null)
          ? canonicalIndexSql(objects.find((entry) => entry.name === index.name)?.sql ?? '')
          : null,
      };
    }).sort((a, b) => a.name < b.name ? -1 : 1);
    return {
      name: object.name,
      columns,
      foreignKeys,
      indices,
      autoincrement: tokens.includes('AUTOINCREMENT'),
      extraClauses: ['COLLATE', 'CHECK', 'STRICT', 'GENERATED'].some(token => tokens.includes(token))
        || containsTokenSequence(tokens, ['WITHOUT', 'ROWID']),
      unsupportedConstraintSemantics: containsTokenSequence(tokens, ['ON', 'CONFLICT'])
        || ['DEFERRABLE', 'INITIALLY', 'MATCH'].some(token => tokens.includes(token))
        || containsTokenSequence(tokens, ['PRIMARY', 'KEY']) && tokens.some(token => ['ASC', 'DESC'].includes(token)),
    };
  });
  const sqliteSequence = database.prepare("SELECT name FROM sqlite_schema WHERE name = 'sqlite_sequence'").get() ? statement(database, 'SELECT name, seq FROM sqlite_sequence ORDER BY name COLLATE BINARY').all() : [];
  const ddl = objects.map(({ sql }) => sql).filter(Boolean);
  const fingerprint = createHash('sha256').update(JSON.stringify(objects)).digest('hex');
  return { objects, tables, ddl, fingerprint, sqliteSequence };
}

let expectedSchema;
function getExpectedSchema() {
  if (!expectedSchema) {
    const database = new DatabaseSync(':memory:');
    for (const table of nativeModel.tables) database.exec(createTableSql(table));
    for (const table of nativeModel.tables) for (const index of table.indices) database.exec(createIndexSql(table, index));
    expectedSchema = inspectSqliteSchema(database);
    database.close();
  }
  return expectedSchema;
}

let canonicalSchema;
/** Return the one repository-owned SQLite schema used for every Jellyfin export.
 * Source sqlite_schema SQL is compatibility evidence, never export provenance. */
export function canonicalNativeSqliteSchema() {
  if (!canonicalSchema) {
    const database = new DatabaseSync(':memory:');
    try {
      for (const table of nativeModel.tables) database.exec(createTableSql(table));
      for (const table of nativeModel.tables) for (const index of table.indices) database.exec(createIndexSql(table, index));
      for (const sql of canonicalEfSchemaDdl) database.exec(sql);
      const inspected = inspectSqliteSchema(database);
      canonicalSchema = Object.freeze({
        ddl: Object.freeze([...inspected.ddl]),
        fingerprint: inspected.fingerprint,
      });
    } finally { database.close(); }
  }
  return { ddl: [...canonicalSchema.ddl], fingerprint: canonicalSchema.fingerprint };
}

export function preflightSqlite(database, { requireMigrationHistory = false, validateRows = true } = {}) {
  const schema = inspectSqliteSchema(database);
  const expected = getExpectedSchema();
  const differences = [];
  for (const expectedTable of expected.tables) {
    const actual = schema.tables.find((table) => table.name === expectedTable.name);
    if (!actual) differences.push(`Missing table ${expectedTable.name}`);
    else for (const key of ['columns', 'foreignKeys', 'indices', 'autoincrement', 'extraClauses', 'unsupportedConstraintSemantics']) if (!compare(actual[key], expectedTable[key])) differences.push(`${actual.name}: ${key} differ from the pinned model`);
  }
  for (const table of schema.tables) if (!expected.tables.some((entry) => entry.name === table.name) && !['__EFMigrationsHistory', '__EFMigrationsLock'].includes(table.name)) differences.push(`Unknown table ${table.name}`);
  const lockTable = schema.tables.find((table) => table.name === '__EFMigrationsLock');
  if (lockTable) {
    const expectedColumns = [{ name: 'Id', type: 'INTEGER', nullable: false, default: null, primaryKey: 1, hidden: 0 }, { name: 'Timestamp', type: 'TEXT', nullable: false, default: null, primaryKey: 0, hidden: 0 }];
    if (!compare(lockTable.columns, expectedColumns) || lockTable.foreignKeys.length || lockTable.indices.length
      || lockTable.extraClauses || lockTable.unsupportedConstraintSemantics || lockTable.autoincrement) differences.push('Unknown EF migration lock schema');
    else if (database.prepare('SELECT 1 FROM "__EFMigrationsLock" LIMIT 1').get()) differences.push('EF migration lock is held; an offline migration snapshot is required');
  }
  for (const object of schema.objects) if (object.type !== 'table' && object.type !== 'index') differences.push(`Unknown ${object.type} ${object.name}`);
  const historyTable = schema.tables.find((table) => table.name === '__EFMigrationsHistory');
  let history = [];
  if (!historyTable && requireMigrationHistory) differences.push('Native EF migration history is required');
  if (historyTable) {
    const expectedColumns = [{ name: 'MigrationId', type: 'TEXT', nullable: false, default: null, primaryKey: 1, hidden: 0 }, { name: 'ProductVersion', type: 'TEXT', nullable: false, default: null, primaryKey: 0, hidden: 0 }];
    if (!compare(historyTable.columns, expectedColumns) || historyTable.foreignKeys.length || historyTable.indices.length
      || historyTable.extraClauses || historyTable.unsupportedConstraintSemantics) differences.push('Unknown EF migration history schema');
    else {
      history = database.prepare('SELECT "MigrationId", "ProductVersion" FROM "__EFMigrationsHistory" ORDER BY "MigrationId" COLLATE BINARY').all();
      for (const row of history) if (![...nativeModel.migrations, ...nativeModel.dataMigrations].includes(row.MigrationId)) differences.push(`Unknown migration ${row.MigrationId}`);
      const requiredMigrations = [...nativeModel.migrations, ...nativeModel.dataMigrations];
      if (requireMigrationHistory && requiredMigrations.some((id) => !history.some((row) => row.MigrationId === id))) differences.push('Incomplete native EF migration history');
    }
  }
  const integrity = database.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') differences.push('SQLite integrity check failed');
  if (database.prepare('PRAGMA foreign_key_check').all().length) differences.push('Foreign key violations');
  if (validateRows && !differences.length) for (const table of nativeModel.tables) {
    for (const row of statement(database, `SELECT ${table.columns.map(column => sqliteCellProjection(column)).join(', ')} FROM ${q(table.name)}`).iterate()) {
      for (const column of table.columns) {
        try { encodeValue(column, decodeValue(column, row[column.name], 'sqlite', 'exchange'), 'sqlite'); }
        catch (error) { differences.push(`${table.name}.${column.name}: ${error.message}`); break; }
      }
      if (differences.length) break;
    }
    // Raw TEXT bytes can cross exchange without a Unicode decoding step.
    // Non-TEXT SQLite storage classes are not silently coerced by this view.
    for (const column of table.columns.filter(entry => entry.type === 'TEXT')) {
      if (database.prepare(`SELECT 1 FROM ${q(table.name)} WHERE ${q(column.name)} IS NOT NULL AND typeof(${q(column.name)}) <> 'text' LIMIT 1`).get()) {
        differences.push(`${table.name}.${column.name}: unexpected native TEXT storage class`); break;
      }
    }
    if (differences.length) break;
  }
  if (differences.length) throw new SchemaCompatibilityError(differences);
  return { ...schema, history };
}

export class SchemaCompatibilityError extends Error {
  constructor(differences) { super(`Database compatibility preflight failed: ${differences.join('; ')}`); this.name = 'SchemaCompatibilityError'; this.differences = differences; }
}
