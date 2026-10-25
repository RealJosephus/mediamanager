import { quoteIdentifier as q, columnDefinition } from './model.js';

/** Explicit bytea consumers. This module does not rewrite arbitrary SQL. */
export function nativeTextSql(schema) {
  if (typeof schema !== 'string' || !schema) throw new TypeError('A function schema is required.');
  const call = (name, args) => `${q(schema)}.${q(name)}(${args.join(', ')})`;
  const pathKey = expression => call('mm_native_path_key', [expression]);
  return Object.freeze({
    projection: expression => call('mm_bytes_text_projection', [expression]),
    fromProjection: expression => call('mm_text_utf8_key', [expression]),
    invariantLower: expression => call('mm_invariant_lower', [expression]),
    invariantCharUpper: expression => call('mm_invariant_char_upper', [expression]),
    removeDiacritics: expression => call('mm_remove_diacritics', [expression]),
    cleanValue: expression => call('mm_clean_value', [expression]),
    safeInt32: expression => call('mm_safe_int32', [expression]),
    ordinalKey: expression => call('mm_text_utf16_key', [expression]),
    ordinalIgnoreCaseKey: expression => call('mm_ordinal_ignore_case_key', [expression]),
    pathKey,
    pathWithin: (value, parent) => {
      const target = pathKey(value), root = pathKey(parent);
      const separator = `CASE WHEN substring(${root} FROM 1 FOR 14)=decode('00770069006e0064006f00770073','hex')
        THEN decode('005c','hex') ELSE decode('002f','hex') END`;
      const prefix = `(${root} || CASE WHEN substring(${root} FROM octet_length(${root})-1 FOR 2)
        IN (decode('002f','hex'),decode('005c','hex')) THEN ''::bytea ELSE ${separator} END)`;
      return `(${target}=${root} OR substring(${target} FROM 1 FOR octet_length(${prefix}))=${prefix})`;
    },
    sqliteBinaryKey: expression => expression,
    sqliteAsciiLowerKey: expression => call('mm_native_ascii_lower', [expression]),
    sqliteLike: (source, pattern, escape = "''") => call('mm_text_sqlite_like', [source, pattern, escape]),
    jsonProjection: expression => call('mm_text_json_projection', [expression]),
    safeItemData: (nativeType, data) => call('mm_safe_native_item_data', [nativeType, data]),
    jsonTextBytes: (document, propertyName) => call('mm_native_json_text_bytes', [document, propertyName]),
    ratingScore: (rating, countryContext) => call('mm_parental_rating_score', [rating, countryContext]),
    // Existing native Guid SQL semantics are case folding plus hyphen removal.
    // Invalid opaque values remain unmatched; this is not HTTP Guid parsing.
    guidLower: expression => call('mm_native_guid_lower', [expression]),
    guidKey: expression => `replace(${call('mm_native_guid_lower', [expression])}, '-', '')`,
  });
}

export function postgresColumnType(column) { return column.type === 'TEXT' ? 'bytea' : column.pgType; }
export function sqliteCellProjection(column, alias) {
  const source = `${alias ? q(alias) + '.' : ''}${q(column.name)}`;
  return column.type === 'TEXT' ? `CAST(${source} AS BLOB) AS ${q(column.name)}` : source;
}
export function sqliteCellParameter(column, placeholder = '?') {
  return column.type === 'TEXT' ? `CAST(${placeholder} AS TEXT)` : placeholder;
}
export function sqliteSetProjection(column) {
  return column.type === 'TEXT' ? 'CAST(unhex(value) AS TEXT)' : column.type === 'BLOB' ? 'unhex(value)' : `CAST(value AS ${column.type})`;
}
export function rawPostgresRowPlan(table, schema, { after, limit = 128 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new TypeError('Raw exchange pages are limited to 128 rows.');
  const values = [], predicates = [];
  if (after !== undefined) {
    if (!after || table.primaryKey.some(key => !Object.hasOwn(after, key)) || Object.keys(after).length !== table.primaryKey.length) throw new TypeError('The exchange cursor requires a complete primary key.');
    const placeholders = table.primaryKey.map(key => {
      const column = columnDefinition(table, key), value = after[key];
      if (column.type === 'TEXT' && !(value instanceof Uint8Array)) throw new TypeError('Raw TEXT cursors require bytea bytes.');
      values.push(value); return `$${values.length}::${postgresColumnType(column)}`;
    });
    predicates.push(`ROW(${table.primaryKey.map(q).join(', ')}) > ROW(${placeholders.join(', ')})`);
  }
  values.push(limit);
  return { text: `SELECT ${table.columns.map(column => q(column.name)).join(', ')} FROM ${q(schema)}.${q(table.name)}${predicates.length ? ' WHERE ' + predicates.join(' AND ') : ''} ORDER BY ${table.primaryKey.map(q).join(', ')} LIMIT $${values.length}`, values };
}

export function rawSqliteRowPlan(table, { after, limit = 128 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new TypeError('Raw exchange pages are limited to 128 rows.');
  const values = [], predicates = [];
  if (after !== undefined) {
    if (!after || table.primaryKey.some(key => !Object.hasOwn(after, key)) || Object.keys(after).length !== table.primaryKey.length) throw new TypeError('The exchange cursor requires a complete primary key.');
    const placeholders = table.primaryKey.map(key => {
      const column = columnDefinition(table, key), value = after[key];
      if (column.type === 'TEXT' && !(value instanceof Uint8Array)) throw new TypeError('Raw TEXT cursors require bytes.');
      values.push(value); return sqliteCellParameter(column);
    });
    predicates.push(`(${table.primaryKey.map(q).join(', ')}) > (${placeholders.join(', ')})`);
  }
  values.push(limit);
  return { text: `SELECT ${table.columns.map(column => sqliteCellProjection(column)).join(', ')} FROM ${q(table.name)}${predicates.length ? ' WHERE ' + predicates.join(' AND ') : ''} ORDER BY ${table.primaryKey.map(q).join(', ')} LIMIT ?`, values };
}
