import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { idKey, nonemptyId } from './records.js';

function request(query) {
  const names = { IsFolder: 'isfolder', IsPlayed: 'isplayed', IsFavorite: 'isfavorite', IsResumable: 'isresumable',
    IsLiked: 'likes', IsFavoriteOrLiked: 'favoriteorlikes', ChannelIds: 'channelids', IncludeItemTypes: 'includeitemtypes',
    EnableTotalRecordCount: 'enabletotalrecordcount' };
  const input = Object.fromEntries(Object.entries(names).filter(([name]) => query[name] != null).map(([name, key]) => [key, query[name]]));
  input.startindex = Math.max(0, query.StartIndex ?? 0);
  input.limit = query.Limit ?? undefined;
  if (query.OrderBy?.length) {
    input.sortby = query.OrderBy.map(order => order[0]); input.sortorder = query.OrderBy.map(order => order[1]);
  }
  return input;
}

export function buildPostgresChannelItemsQuery(database, query, { userId, visibility, scope = {} } = {}) {
  const presentationGrouping = !query.IncludeItemTypes?.length || query.IncludeItemTypes.some(type =>
    ['Episode', 'Video', 'Movie', 'MusicVideo', 'Series', 'Season'].includes(type));
  return buildPostgresItemPageQuery(database, request(query), { userId, visibility,
    scope: { ...scope, ...(nonemptyId(query.ParentId) ? { parentId: query.ParentId } : {}) },
    groupByPresentationKey: Boolean(userId) && presentationGrouping && query.IsResumable !== true
      && query.GroupByPresentationUniqueKey !== false, includeOrdinal: true });
}

/** Capture the repository selection before the first DTO or deletion effect.
 * The finite producer list is used only by the stale selection's SQL EXCEPT. */
async function capture(database, query, liveIds, { userId, visibility, scope = {} } = {}) {
  if (database?.dialect !== 'postgres' || database.connectionSession !== true || database.connectionActive !== true) {
    throw new TypeError('Channel item selections require an active owned PostgreSQL session.');
  }
  if (liveIds !== undefined && (!Array.isArray(liveIds) || liveIds.some(id => typeof id !== 'string'))) {
    throw new TypeError('Stale channel selection requires finite native identities.');
  }
  const source = buildPostgresChannelItemsQuery(database, query, { userId, visibility, scope });
  const name = 'mm_channel_items_' + randomUUID().replaceAll('-', ''), captured = `${q('pg_temp')}.${q(name)}`;
  const table = `${q(database.schemaName)}.${q('BaseItems')}`, values = [...source.values];
  let closing, attempted = false;
  const close = primaryError => closing ??= (async () => {
    if (!attempted) return;
    try { await database.client.query(`DROP TABLE IF EXISTS ${captured}`); }
    catch (error) {
      if (primaryError && database.inTransaction && error.code === '25P02') return;
      database.discardConnection(error);
      if (primaryError) throw new AggregateError([primaryError, error], primaryError.message, { cause: primaryError });
      throw error;
    }
  })();
  try {
    attempted = true;
    let selected = '';
    if (liveIds !== undefined) {
      values.push(liveIds.map(idKey));
      const sql = nativeTextSql(database.schemaName);
      selected = `WHERE source."Id" IS NOT NULL AND ${sql.guidKey('source."Id"')} IN
        (SELECT ${sql.guidKey('candidate."Id"')} FROM source candidate WHERE candidate."Id" IS NOT NULL
         EXCEPT SELECT unnest($${values.length}::text[]))`;
    }
    await database.client.query({ text: `CREATE TEMP TABLE ${q(name)} AS WITH source AS (${source.text})
      SELECT item.*, source."__ordinal", source."TotalRecordCount" AS "__native_count"
      FROM source LEFT JOIN ${table} item ON item."Id" = source."Id" ${selected}`, values });
    const counts = (await database.client.query(`SELECT count("Id")::bigint AS selected,
      COALESCE(max("__native_count"), 0)::bigint AS native FROM ${captured}`)).rows[0];
    const selectedCount = Number(counts.selected);
    const total = query.EnableTotalRecordCount === false ? null : Number(liveIds !== undefined ? counts.selected : counts.native);
    if (!Number.isSafeInteger(selectedCount) || selectedCount < 0 || total !== null && (!Number.isSafeInteger(total) || total < 0)) throw new Error('PostgreSQL returned an invalid channel item count.');
    const startIndex = query.StartIndex ?? 0, columns = tableDefinition('BaseItems').columns;
    const projection = liveIds === undefined ? columns.map(column => q(column.name)).join(', ') : '"Id"';
    const selectedSql = `SELECT ${projection}, "__ordinal" FROM ${captured} WHERE "Id" IS NOT NULL ORDER BY "__ordinal"`;
    return Object.freeze({ total, selectedCount, startIndex, close,
      page: async ({ offset = 0, limit = 128 } = {}) => {
        if (closing) throw new Error('Channel item selection is closed.');
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
          throw new TypeError('Channel item pages require a nonnegative offset and at most 128 rows.');
        }
        const result = await database.client.query({ text: `${selectedSql} OFFSET $1 LIMIT $2`, values: [offset, limit] });
        const rows = result.rows.map(row => liveIds === undefined
          ? Object.fromEntries(columns.map(column => [column.name, decodeValue(column, row[column.name])]))
          : { Id: decodeNativeTextBytes(row.Id), Ordinal: Number(row.__ordinal) });
        return { rows, total, startIndex };
      },
    });
  } catch (error) {
    try { await close(error); } catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
    throw error;
  }
}

export function createPostgresChannelItemsQuery(database, query, options) { return capture(database, query, undefined, options); }
export function createPostgresStaleChannelItemQuery(database, query, liveIds, options) { return capture(database, query, liveIds, options); }
