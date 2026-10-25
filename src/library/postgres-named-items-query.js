import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes, nativeTextBytes } from '../database/native-text.js';
import { buildPostgresItemPageQuery, queryPostgresItemPage } from '../database/postgres-item-query.js';
import { cleanValue, idKey } from './records.js';

const valueTypes = Object.freeze({ Studio: [3], Genre: [2], MusicGenre: [2], MusicArtist: [0, 1] });
const countedTypes = Object.freeze({ Movie: 'MovieCount', Series: 'SeriesCount', Episode: 'EpisodeCount',
  MusicArtist: 'ArtistCount', LiveTvProgram: 'ProgramCount', Trailer: 'TrailerCount', Audio: 'SongCount',
  MusicAlbum: 'AlbumCount', MusicVideo: 'MusicVideoCount', BoxSet: 'BoxSetCount', Book: 'BookCount' });
const publicCounts = Object.values(countedTypes).filter(name => !['BoxSetCount', 'BookCount'].includes(name));
const leaf = (sql, alias) => `substring(${sql.projection(`${alias}."Type"`)} from '[^.]+$')`;
const int32 = expression => `(((((${expression})::bigint + 2147483648) % 4294967296 + 4294967296) % 4294967296) - 2147483648)`;

function context(database, kind) {
  if (!Object.hasOwn(valueTypes, kind)) throw new TypeError(`Unsupported named item kind: ${kind}`);
  const sql = nativeTextSql(database.schemaName);
  const table = name => `${q(database.schemaName)}.${q(name)}`;
  const values = [], ctes = [];
  const bind = value => { values.push(value); return `$${values.length}`; };
  const append = (name, plan) => {
    const text = plan.text.replace(/\$(\d+)/gu, (_, ordinal) => `$${Number(ordinal) + values.length}`);
    values.push(...plan.values);
    ctes.push(`${name} AS (${text})`);
  };
  const same = (a, b) => `${sql.guidKey(a)} = ${sql.guidKey(b)}`;
  return { sql, table, values, ctes, bind, append, same };
}

/** Resolve source relations, filter the named entities, collapse and page in SQL. */
export async function queryPostgresNamedItemPage(database, {
  kind, mediaQuery = {}, nameQuery = {}, scope = {}, userId, visibility,
  topParentIds = [], startIndex = 0, limit, enableTotalRecordCount = true,
  itemValueTypes = valueTypes[kind],
} = {}) {
  const { sql, table, values, ctes, bind, append, same } = context(database, kind);
  append('media_ids', buildPostgresItemPageQuery(database, mediaQuery, { scope, userId, visibility,
    nameAccessTypes: ['Person', 'Genre', 'MusicGenre', 'Studio', 'Year', 'MusicArtist']
      .filter(type => mediaQuery.includeitemtypes?.includes(type)) }));
  append('name_ids', buildPostgresItemPageQuery(database, { ...nameQuery, includeitemtypes: [kind] }, {
    userId, visibility, includeOrdinal: true, repositoryFolderPlayback: true,
  }));
  const types = bind(itemValueTypes);
  const preferred = kind === 'MusicArtist'
    ? `COALESCE(${sql.guidKey('named."TopParentId"')} = ANY(${bind(topParentIds.map(idKey))}::text[]), FALSE) DESC, ` : '';
  ctes.push(`candidates AS (
    SELECT named.*, names."__ordinal" AS __name_order,
      row_number() OVER (PARTITION BY named."PresentationUniqueKey"
        ORDER BY ${preferred}${sql.guidKey('named."Id"')} COLLATE "C") AS __representative
    FROM name_ids names JOIN ${table('BaseItems')} named ON ${same('named."Id"', 'names."Id"')}
    WHERE EXISTS (SELECT 1 FROM ${table('ItemValues')} value
      JOIN ${table('ItemValuesMap')} relation ON ${same('relation."ItemValueId"', 'value."ItemValueId"')}
      JOIN media_ids media ON ${same('media."Id"', 'relation."ItemId"')}
      WHERE value."Type" = ANY(${types}::integer[])
        AND value."CleanValue" IS NOT DISTINCT FROM named."CleanName")
  )`, 'representatives AS (SELECT * FROM candidates WHERE __representative = 1)',
  `page AS (SELECT "Id", __name_order FROM representatives ORDER BY __name_order
    ${limit === undefined || limit < 0 ? '' : `LIMIT ${bind(limit)}`} OFFSET ${bind(Math.max(startIndex, 0))})`);
  const result = await database.client.query({
    text: `WITH ${ctes.join(',\n')}, total AS (SELECT count(*) AS "Total" FROM representatives)
      SELECT page."Id", total."Total" FROM total LEFT JOIN page ON TRUE ORDER BY page.__name_order`, values,
  });
  const ids = result.rows.filter(row => row.Id != null).map(row => decodeNativeTextBytes(row.Id));
  const rows = ids.length ? await database.rows('BaseItems', { whereIn: { Id: ids } }) : [];
  const byId = new Map(rows.map(row => [idKey(row.Id), row]));
  const total = enableTotalRecordCount ? Number(result.rows[0]?.Total ?? 0) : 0;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('PostgreSQL returned an invalid named item count.');
  return { rows: ids.map(id => byId.get(idKey(id))).filter(Boolean), total, startIndex };
}

/** Count the selected names, including studio/genre inheritance to episodes. */
export async function queryPostgresNamedItemCounts(database, {
  kind, ids, query = {}, scope = {}, userId, visibility, itemValueTypes = valueTypes[kind],
  includeEmpty = false,
} = {}) {
  const counts = new Map(includeEmpty ? ids.map(id => [idKey(id), Object.fromEntries([...publicCounts.map(name => [name, 0]), ['ChildCount', 0]])]) : []);
  if (!ids.length) return counts;
  const { sql, table, values, ctes, bind, append, same } = context(database, kind);
  const requested = bind(ids.map(idKey));
  const types = bind(itemValueTypes);
  // Both native count paths carry access scope without IncludeItemTypes;
  // the scalar related-kind restriction is a separate source predicate.
  append('source_ids', buildPostgresItemPageQuery(database, query, { scope, userId, visibility, repositoryFolderPlayback: true }));
  ctes.push(`requested AS (SELECT "Id", "CleanName" FROM ${table('BaseItems')}
      WHERE ${sql.guidKey('"Id"')} = ANY(${requested}::text[])
        ${includeEmpty ? '' : 'AND "CleanName" IS NOT NULL AND octet_length("CleanName") > 0'} )`,
  `sources AS (SELECT item.* FROM source_ids source JOIN ${table('BaseItems')} item
      ON ${same('item."Id"', 'source."Id"')})`,
  `tagged AS (SELECT DISTINCT requested."Id" AS __name_id, item."Id", item."Type", item."SeriesId"
    FROM requested JOIN ${table('ItemValues')} value ON value."CleanValue" = requested."CleanName"
    JOIN ${table('ItemValuesMap')} relation ON ${same('relation."ItemValueId"', 'value."ItemValueId"')}
    JOIN sources item ON ${same('item."Id"', 'relation."ItemId"')}
    WHERE value."Type" = ANY(${types}::integer[]))`);
  const inheritEpisodes = itemValueTypes.some(type => type === 2 || type === 3);
  ctes.push(`counted AS (SELECT __name_id, "Id", "Type" FROM tagged
    ${inheritEpisodes ? `UNION SELECT tagged.__name_id, episode."Id", episode."Type" FROM tagged
      JOIN sources episode ON ${same('episode."SeriesId"', 'tagged."Id"')}
      WHERE ${leaf(sql, 'tagged')} = 'Series' AND ${leaf(sql, 'episode')} = 'Episode'` : ''})`);
  const result = await database.client.query({
    text: `WITH ${ctes.join(',\n')} SELECT requested."Id",
      ${Object.entries(countedTypes).map(([type, name]) =>
    `${int32(`count(*) FILTER (WHERE ${leaf(sql, 'counted')} = '${type}')`)} AS ${q(name)}`).join(',\n')}
      FROM requested LEFT JOIN counted ON ${same('counted.__name_id', 'requested."Id"')}
      GROUP BY requested."Id" ${includeEmpty ? '' : 'HAVING count(counted."Id") > 0'}`, values,
  });
  for (const row of result.rows) {
    const values = Object.fromEntries(Object.values(countedTypes).map(name => [name, Number(row[name])]));
    const dto = Object.fromEntries(publicCounts.map(name => [name, values[name]]));
    dto.ChildCount = Object.values(values).reduce((sum, value) => (sum + value) | 0, 0);
    counts.set(idKey(decodeNativeTextBytes(row.Id)), dto);
  }
  return counts;
}

/** Slug lookups use the repository's clean-name comparison without user scope. */
export async function queryPostgresNamedSlug(database, kind, name) {
  const { table } = context(database, kind);
  for (const replacement of ['&', '/', '?']) {
    const page = await queryPostgresItemPage(database, { includeitemtypes: [kind], limit: 1 }, {
      itemIdsPlan: { text: `SELECT "Id" FROM ${table('BaseItems')} WHERE "CleanName" = $1`,
        values: [nativeTextBytes(cleanValue(name.replaceAll('-', replacement)))] },
    });
    if (page.rows.length) return page.rows[0];
  }
  return null;
}
