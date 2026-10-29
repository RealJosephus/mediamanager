import { nativeTextBytes } from './native-text.js';
import { nativeTextSql, sqliteCellProjection, sqliteSetProjection } from './native-text-sql.js';
import { quoteIdentifier as q, tableDefinition } from './model.js';
import { decodeValue } from './values.js';

const imageTable = 'BaseItemImageInfos';
const trailerTable = 'BaseItemTrailerTypes';
const layouts = {
  Users: { table: 'user_order', keys: [['user_id', 'Id', 'bytea']], order: [] },
  BaseItems: { table: 'item_order', keys: [['item_id', 'Id', 'bytea']], order: [], batchOrder: true },
  [imageTable]: { table: 'image_order', keys: [['image_id', 'Id', 'bytea']], order: ['ItemId', 'ImageType'] },
  [trailerTable]: { table: 'trailer_order', keys: [['type_id', 'Id', 'integer'], ['item_id', 'ItemId', 'bytea']], order: ['ItemId'] },
  ItemValues: { table: 'item_value_order', keys: [['value_id', 'ItemValueId', 'bytea']], order: ['Type', 'CleanValue'] },
  MediaSegments: { table: 'media_segment_order', keys: [['segment_id', 'Id', 'bytea']], order: ['ItemId'] },
};
export const nativeInsertionOrderedTables = Object.freeze(Object.keys(layouts));
export function nativeRelationOrderDefinition(name) {
  const definition = layout(name);
  return Object.freeze({ table: definition.table, keys: Object.freeze(definition.keys.map(([key, column]) => Object.freeze([key, column]))) });
}
function layout(name) {
  if (!Object.hasOwn(layouts, name)) throw new TypeError('This relation has no native insertion order.');
  return layouts[name];
}
const decode = (row, dialect, columns, consumer = 'runtime') => {
  const decoded = {};
  for (const column of columns) decoded[column.name] = decodeValue(column, row[column.name], dialect, consumer);
  return decoded;
};

/** Persist SQLite insertion order wherever a native reader consumes it. */
export function postgresRelationOrderStatements(schema, controlSchema) {
  return Object.entries(layouts).flatMap(([name, { table, keys, batchOrder }]) => {
    const relation = `${q(schema)}.${q(name)}`;
    const order = `${q(controlSchema)}.${q(table)}`;
    const record = `${q(controlSchema)}.${q(`record_${table}`)}`;
    const primaryKey = keys.map(([key]) => q(key)).join(', ');
    return [
      `CREATE TABLE ${order} (
        ${keys.map(([key, , type]) => `${q(key)} ${type} NOT NULL`).join(', ')},
        position bigint GENERATED ${batchOrder ? 'BY DEFAULT' : 'ALWAYS'} AS IDENTITY NOT NULL,
        UNIQUE (position)${batchOrder ? ' DEFERRABLE INITIALLY DEFERRED' : ''},
        PRIMARY KEY (${primaryKey}),
        FOREIGN KEY (${primaryKey}) REFERENCES ${relation}(${keys.map(([, key]) => q(key)).join(', ')})
          ON DELETE CASCADE ON UPDATE CASCADE
      )`,
      `CREATE FUNCTION ${record}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
        BEGIN
          INSERT INTO ${order}(${primaryKey}) VALUES (${keys.map(([, key]) => `NEW.${q(key)}`).join(', ')});
          RETURN NEW;
        END $$`,
      `CREATE TRIGGER ${q(`mm_${table}`)} AFTER INSERT ON ${relation}
        FOR EACH ROW EXECUTE FUNCTION ${record}()`,
    ];
  });
}

/** EF inserts a new BaseItems batch in dependency layers, then Guid order.
 * Reassign only this batch's reserved positions without changing save order,
 * relationships or the sequence high-water mark. Updates keep their position. */
export async function orderNativeItemBatch(database, itemIds) {
  if (!itemIds.length) return;
  return orderNativeItemSelection(database, { text: 'SELECT unnest($1::bytea[]) AS "Id"', values: [itemIds.map(nativeTextBytes)] });
}

/** The complete batch may live in SQL. Its selected identities are never
 * collected in Node or reordered independently in bounded pages. */
export async function orderNativeItemSelection(database, plan) {
  if (typeof plan?.text !== 'string' || !Array.isArray(plan.values)) throw new TypeError('Native insertion order requires a SQL identity relation.');
  const items = `${q(database.schemaName)}.${q('BaseItems')}`;
  const sequence = `${q(database.controlSchema)}.${q('item_order')}`;
  const key = nativeTextSql(database.schemaName).guidKey;
  // item_id is the order relation's primary key. Keep its single-slot bound
  // explicit even when a newly populated relation has no useful statistics.
  const result = await database.client.query({ text: `/* native-item-batch-order */
    WITH RECURSIVE selected AS MATERIALIZED (${plan.text}), fresh AS MATERIALIZED (
      SELECT item."Id", item."ParentId", item."OwnerId", sequence.position
      FROM ${items} item JOIN LATERAL (
        SELECT position FROM ${sequence} WHERE item_id = item."Id" LIMIT 1
      ) sequence ON TRUE
      WHERE EXISTS (SELECT 1 FROM selected WHERE ${key('selected."Id"')}=${key('item."Id"')})
    ), edges AS (
      SELECT child."Id" AS "Child", parent."Id" AS "Parent" FROM fresh child JOIN fresh parent
        ON parent."Id" IN (child."ParentId", child."OwnerId") AND parent."Id" <> child."Id"
    ), reach("Id", "Ancestor") AS (
      SELECT "Child", "Parent" FROM edges
      UNION
      SELECT reach."Id", edges."Parent" FROM reach JOIN edges ON edges."Child" = reach."Ancestor"
    ), summary AS (
      SELECT (SELECT count(*) FROM fresh) AS "Count", (SELECT count(*) FROM selected) AS "Expected", EXISTS (
        SELECT 1 FROM reach WHERE "Id" = "Ancestor") AS "Cycle"
    ), walk("Id", "Ancestor", "Depth") AS (
      SELECT "Id", "Id", 0 FROM fresh CROSS JOIN summary WHERE NOT summary."Cycle"
      UNION
      SELECT walk."Id", edges."Parent", walk."Depth" + 1 FROM walk JOIN edges ON edges."Child" = walk."Ancestor"
    ), ranked AS (
      SELECT "Id", row_number() OVER (ORDER BY max("Depth"), ${key('"Id"')} COLLATE "C") AS "Ordinal"
      FROM walk GROUP BY "Id"
    ), positions AS (
      SELECT position, row_number() OVER (ORDER BY position) AS "Ordinal" FROM fresh
    ), updated AS (
      UPDATE ${sequence} sequence SET position = positions.position
      FROM ranked JOIN positions USING ("Ordinal") CROSS JOIN summary
      WHERE sequence.item_id = ranked."Id" AND NOT summary."Cycle" RETURNING sequence.item_id
    ) SELECT summary.*, (SELECT count(*) FROM updated) AS "Updated" FROM summary`,
    values: plan.values });
  const observed = result.rows[0];
  if (observed.Cycle || BigInt(observed.Count) !== BigInt(observed.Expected) || BigInt(observed.Updated) !== BigInt(observed.Expected)) {
    throw new Error('A native item batch requires complete, acyclic insertion dependencies.');
  }
}

export async function verifyPostgresRelationOrder(database) {
  for (const [name, { table, keys }] of Object.entries(layouts)) {
    const storage = `${q(database.controlSchema)}.${q(table)}`;
    const present = await database.client.query('SELECT to_regclass($1) IS NOT NULL AS present', [storage]);
    if (!present.rows[0].present) {
      throw new Error(`PostgreSQL native relation order storage is missing: ${name}`);
    }
    const result = await database.client.query(`SELECT EXISTS (
      SELECT 1 FROM ${q(database.schemaName)}.${q(name)} relation
      WHERE NOT EXISTS (SELECT 1 FROM ${q(database.controlSchema)}.${q(table)} sequence
        WHERE ${keys.map(([key, column]) => `sequence.${q(key)} = relation.${q(column)}`).join(' AND ')})
    ) AS missing`);
    if (result.rows[0].missing) throw new Error(`PostgreSQL native relation order is incomplete: ${name}`);
  }
}

/** Read a bounded item's native image sequence, independent of process state. */
export async function readNativeImageRows(database, itemIds) {
  return readNativeRelationRows(database, imageTable, itemIds);
}

export async function readNativeTrailerRows(database, itemIds) {
  return readNativeRelationRows(database, trailerTable, itemIds);
}

async function readNativeRelationRows(database, name, itemIds) {
  const { table, keys, order } = layout(name);
  const columns = tableDefinition(name).columns;
  if (!Array.isArray(itemIds)) throw new TypeError('Relation reads require item IDs.');
  if (!itemIds.length) return [];
  const selected = columns.map(column => database.dialect === 'sqlite' ? sqliteCellProjection(column, 'image') : `image.${q(column.name)}`).join(', ');
  if (database.dialect === 'postgres') {
    const result = await database.client.query({
      text: `SELECT ${selected} FROM ${q(database.schemaName)}.${q(name)} image
        JOIN ${q(database.controlSchema)}.${q(table)} sequence ON ${keys.map(([key, column]) => `sequence.${q(key)} = image.${q(column)}`).join(' AND ')}
        WHERE image."ItemId" = ANY($1::bytea[])
        ORDER BY ${order.map(column => `image.${q(column)}`).join(', ')}, sequence.position`,
      values: [itemIds.map(nativeTextBytes)],
    });
    return result.rows.map(row => decode(row, 'postgres', columns));
  }
  if (database.dialect !== 'sqlite') throw new TypeError('Unsupported relation database.');
  const query = database.database.prepare(`SELECT ${selected} FROM ${q(name)} image
    WHERE image."ItemId" IN (SELECT CAST(unhex(value) AS TEXT) FROM json_each(?))
    ORDER BY ${order.map(column => `image.${q(column)}`).join(', ')}, image.rowid`);
  query.setReadBigInts(true);
  return query.all(JSON.stringify(itemIds.map(value => nativeTextBytes(value).toString('hex')))).map(row => decode(row, 'sqlite', columns));
}

/** Transfer the original insertion sequence, including cross-type order. */
export async function scanNativeRelationRows(database, name, { after, limit, consumer = 'runtime' } = {}) {
  const { table, keys } = layout(name);
  const columns = tableDefinition(name).columns;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('A relation scan requires a positive batch size.');
  const selected = columns.map(column => database.dialect === 'sqlite' ? sqliteCellProjection(column, 'image') : `image.${q(column.name)}`).join(', ');
  let rows;
  if (database.dialect === 'postgres') {
    rows = (await database.client.query({
      text: `SELECT ${selected}, sequence.position AS "__position"
        FROM ${q(database.schemaName)}.${q(name)} image
        JOIN ${q(database.controlSchema)}.${q(table)} sequence ON ${keys.map(([key, column]) => `sequence.${q(key)} = image.${q(column)}`).join(' AND ')}
        ${after === undefined ? '' : 'WHERE sequence.position > $2::bigint'}
        ORDER BY sequence.position LIMIT $1`,
      values: after === undefined ? [limit] : [limit, after],
    })).rows;
  } else if (database.dialect === 'sqlite') {
    const query = database.database.prepare(`SELECT ${selected}, image.rowid AS "__position"
      FROM ${q(name)} image ${after === undefined ? '' : 'WHERE image.rowid > ?'}
      ORDER BY image.rowid LIMIT ?`);
    query.setReadBigInts(true);
    rows = query.all(...(after === undefined ? [limit] : [after, limit]));
  } else throw new TypeError('Unsupported relation database.');
  return { rows: rows.map(row => decode(row, database.dialect, columns, consumer)), after: rows.at(-1)?.__position };
}

/** EF SaveChanges orders new image commands by Guid before inserting them. */
export function insertNativeImageBatch(database, rows) {
  const key = value => value.replaceAll('-', '').toLowerCase();
  return database.insertBatch(imageTable, rows.toSorted((left, right) =>
    key(left.Id) < key(right.Id) ? -1 : key(left.Id) > key(right.Id) ? 1 : 0));
}
