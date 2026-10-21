import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { idKey } from './records.js';

const pageSize = 128;
const countValue = value => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid item collection count.');
  return count;
};

/** Manual reverse links select repository BoxSet parents. Native standalone
 * visibility is evaluated in bounded pages before SQL owns the visible
 * relation, complete count, ordinal text ordering and Skip/Take window. */
export async function createPostgresItemCollectionsQuery(database, itemId) {
  if (database?.dialect !== 'postgres' || !database.connectionSession) {
    throw new TypeError('Item collections require a checked-out PostgreSQL session.');
  }
  const suffix = randomUUID().replaceAll('-', '');
  const source = q('mm_item_collection_source_' + suffix), visible = q('mm_item_collection_visible_' + suffix);
  const items = `${q(database.schemaName)}.${q('BaseItems')}`, links = `${q(database.schemaName)}.${q('LinkedChildren')}`;
  const sql = nativeTextSql(database.schemaName);
  let attempted = false, closing;
  const active = () => { if (closing) throw new Error('The item collection query is closed.'); };
  const close = primary => closing ??= (async () => {
    if (!attempted) return;
    try { await database.client.query(`DROP TABLE IF EXISTS ${visible}, ${source}`); }
    catch (error) {
      if (primary && database.inTransaction && error.code === '25P02') return;
      database.discardConnection(error); throw error;
    }
  })();
  const cursor = after => {
    if (typeof after !== 'bigint' || after < 0n) throw new TypeError('Collection cursors require a nonnegative bigint.');
  };
  try {
    attempted = true;
    await database.client.query({ text: `/* item-collections-manual-parents */ CREATE TEMP TABLE ${source} AS
      SELECT row_number() OVER (ORDER BY parent."Id") AS ordinal, parent."Id"
      FROM ${items} parent WHERE parent."Type"=$2 AND EXISTS (
        SELECT 1 FROM ${links} link WHERE link."ChildType"=0
          AND ${sql.guidKey('link."ChildId"')}=$1
          AND ${sql.guidKey('link."ParentId"')}=${sql.guidKey('parent."Id"')})`,
    values: [idKey(itemId), nativeTextBytes('MediaBrowser.Controller.Entities.Movies.BoxSet')] });
    await database.client.query(`CREATE UNIQUE INDEX ON ${source}(ordinal);
      CREATE TEMP TABLE ${visible}(ordinal bigint PRIMARY KEY, "Id" bytea NOT NULL,
        slot text NOT NULL, "SortName" bytea, "Name" bytea)`);
    return Object.freeze({ close,
      async candidates(after = 0n) {
        active(); cursor(after);
        return (await database.client.query({ text: `/* item-collections-candidate-page */
          SELECT ordinal,"Id" FROM ${source} WHERE ordinal>$1 ORDER BY ordinal LIMIT ${pageSize}`, values: [after] })).rows
          .map(row => ({ ordinal: BigInt(row.ordinal), Id: decodeNativeTextBytes(row.Id) }));
      },
      async append(entries) {
        active();
        if (!entries.length || entries.length > pageSize) throw new TypeError('Visible collection pages require 1..128 entries.');
        await database.client.query({ text: `INSERT INTO ${visible}(ordinal,"Id",slot,"SortName","Name")
          SELECT * FROM unnest($1::bigint[],$2::bytea[],$3::text[],$4::bytea[],$5::bytea[])`,
        values: [entries.map(entry => entry.ordinal), entries.map(entry => nativeTextBytes(entry.Id)), entries.map(entry => entry.slot),
          entries.map(entry => entry.SortName == null ? null : nativeTextBytes(entry.SortName)),
          entries.map(entry => entry.Name == null ? null : nativeTextBytes(entry.Name))] });
      },
      async select({ startIndex = null, limit = null } = {}) {
        active();
        if (startIndex != null && !Number.isInteger(startIndex) || limit != null && !Number.isInteger(limit)) {
          throw new TypeError('Collection Skip/Take values must be nullable integers.');
        }
        const total = countValue((await database.client.query(`/* item-collections-count */ SELECT count(*) AS count FROM ${visible}`)).rows[0].count);
        const skip = Math.max(0, startIndex ?? 0), take = limit == null ? total : Math.max(0, limit);
        const order = `${sql.ordinalIgnoreCaseKey('"SortName"')} ASC NULLS FIRST,
          ${sql.ordinalIgnoreCaseKey('"Name"')} ASC NULLS FIRST, ordinal`;
        return Object.freeze({ total, startIndex: startIndex ?? 0, async page(offset = 0) {
          active();
          if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Collection page offsets must be nonnegative integers.');
          const size = Math.min(pageSize, Math.max(0, take - offset));
          if (!size) return [];
          return (await database.client.query({ text: `/* item-collections-result-page */ SELECT ordinal,"Id",slot FROM ${visible}
            ORDER BY ${order} OFFSET $1 LIMIT $2`, values: [skip + offset, size] })).rows
            .map(row => ({ ordinal: BigInt(row.ordinal), Id: decodeNativeTextBytes(row.Id), slot: row.slot }));
        } });
      },
    });
  } catch (error) {
    try { await close(error); } catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
    throw error;
  }
}
