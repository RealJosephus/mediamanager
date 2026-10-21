import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes, nativeTextBytes } from '../database/native-text.js';
import { buildPostgresItemPageQuery, queryPostgresItemPage } from '../database/postgres-item-query.js';
import { libraryError } from './records.js';

export async function queryPostgresPrograms(database, query, { rootId, userId, visibility } = {}) {
  return queryPostgresItemPage(database, { ...query, includeitemtypes: ['LiveTvProgram'],
    startindex: Math.max(0, query.startindex ?? 0),
    sortby: query.sortby?.length ? query.sortby : ['StartDate'],
    sortorder: query.sortby?.length ? query.sortorder : ['Ascending'] }, {
    scope: { topParentIds: [rootId] }, userId, visibility, includeOwnedItems: true, includeAlternateVersions: true,
  });
}

/** The repository window and recommendation manager's stable scoring stay in SQL. */
export async function queryPostgresRecommendedPrograms(database, query, {
  rootId, userId, visibility, configuration = {},
} = {}) {
  const options = { scope: { topParentIds: [rootId] }, userId, visibility,
    includeOwnedItems: true, includeAlternateVersions: true, includeOrdinal: true };
  const baseQuery = { ...query, includeitemtypes: ['LiveTvProgram'], sortby: ['StartDate'], sortorder: ['Ascending'] };
  if (query.isairing !== true) return queryPostgresItemPage(database, baseQuery, options);
  const positiveLimit = query.limit > 0;
  const base = buildPostgresItemPageQuery(database, { ...baseQuery, startindex: 0,
    limit: positiveLimit ? Math.max((query.limit * 4) | 0, 200) : undefined }, options);
  const values = [...base.values], bind = value => { values.push(value); return `$${values.length}`; };
  const sql = nativeTextSql(database.schemaName);
  const items = `${q(database.schemaName)}.${q('BaseItems')}`, data = `${q(database.schemaName)}.${q('UserData')}`;
  const same = (left, right) => `${sql.guidKey(left)} = ${sql.guidKey(right)}`;
  const guid = sql.guidKey('channel."Id"');
  const idKey = `substring(${guid} from 1 for 8) || '-' || substring(${guid} from 9 for 4) || '-'
    || substring(${guid} from 13 for 4) || '-' || substring(${guid} from 17 for 4) || '-' || substring(${guid} from 21 for 12)`;
  const namedKey = sql.fromProjection(`'TvChannel-' || COALESCE(${sql.projection('channel."Name"')}, '')`);
  const user = bind(userId ? nativeTextBytes(userId) : null);
  const channelNameKey = bind(configuration.DisableLiveTvChannelUserDataName === false);
  const tag = name => `EXISTS (SELECT 1 FROM unnest(string_to_array(${sql.projection('program."Tags"')}, '|')) tag(value)
    WHERE ${sql.ordinalIgnoreCaseKey(sql.fromProjection('tag.value'))} = ${sql.ordinalIgnoreCaseKey(bind(nativeTextBytes(name)))})`;
  const live = tag('Live');
  const rawScore = `(CASE WHEN ${live} THEN 1 ELSE 0 END
    + CASE WHEN program."IsSeries" IS TRUE AND program."IsRepeat" IS NOT TRUE THEN 1 ELSE 0 END
    + CASE WHEN channel."Id" IS NULL THEN 0 ELSE COALESCE(channel_data."PlayCount", 0)::bigint
      + CASE WHEN channel_data."Rating" IS NULL THEN 0 WHEN channel_data."Rating" >= 6.5 THEN 2 ELSE -2 END
      + CASE WHEN channel_data."IsFavorite" IS TRUE THEN 3 ELSE 0 END END)`;
  const limit = positiveLimit ? ` LIMIT ${bind(query.limit)}` : '';
  const result = await database.client.query({ text: `WITH source AS (${base.text}), scored AS (
      SELECT program."Id", source."__ordinal", substring(${sql.projection('program."StartDate"')} from 1 for 10) AS day,
        ${rawScore} AS raw_score, channel."Id" IS NOT NULL AS needs_user,
        COALESCE(${sql.guidKey('program."ChannelId"')}, '') IN ('', '${'0'.repeat(32)}') AS empty_channel,
        channel_data."Rating" < 0 OR channel_data."Rating" > 10 AS invalid_rating
      FROM source JOIN ${items} program ON program."Id" = source."Id"
      LEFT JOIN ${items} channel ON ${same('channel."Id"', 'program."ChannelId"')}
      LEFT JOIN LATERAL (SELECT entry."PlayCount", entry."Rating", entry."IsFavorite" FROM ${data} entry
        WHERE ${same('entry."ItemId"', 'channel."Id"')} AND ${same('entry."UserId"', user + '::bytea')}
        ORDER BY CASE WHEN ${channelNameKey}::boolean AND entry."CustomDataKey" = ${namedKey} THEN 0
          WHEN entry."CustomDataKey" = ${sql.fromProjection(idKey)} THEN 1 ELSE 2 END, entry."CustomDataKey" LIMIT 1
      ) channel_data ON TRUE
    ), ordered AS (
      SELECT "Id", row_number() OVER (ORDER BY day COLLATE "C", CASE WHEN raw_score > 2147483647 THEN raw_score - 4294967296
        WHEN raw_score < -2147483648 THEN raw_score + 4294967296 ELSE raw_score END DESC, "__ordinal") AS ordinal
      FROM scored
    ), page AS (SELECT * FROM ordered ORDER BY ordinal${limit}), total AS (
      SELECT count(*) AS count, bool_or(needs_user) AS needs_user, bool_or(empty_channel) AS empty_channel,
        bool_or(invalid_rating) AS invalid_rating FROM scored
    ) SELECT page."Id", total.* FROM total LEFT JOIN page ON TRUE ORDER BY page.ordinal NULLS LAST`, values });
  const total = result.rows[0];
  if (total?.empty_channel || total?.invalid_rating || !userId && total?.needs_user) {
    throw libraryError(400, 'Invalid recommendation user or channel data.');
  }
  const count = Number(total?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid recommendation count.');
  return { ids: result.rows.filter(row => row.Id != null).map(row => decodeNativeTextBytes(row.Id)),
    total: count, startIndex: query.startindex ?? 0 };
}
