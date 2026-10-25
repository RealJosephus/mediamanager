import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { buildPostgresChannelItemsQuery } from './postgres-channel-items-query.js';

/**
 * The specified UserViewManager and BaseItemRepository.Querying latest queries.
 * Candidate selection, TV windows, container access and the manager's early
 * grouping stop all stay relational; only the final bounded page is decoded.
 */
export async function queryPostgresLatestItems(database, {
  query = {}, scope, userId, visibility, collectionType, groupItems = true, limit = 20, channelQuery,
} = {}) {
  const sql = nativeTextSql(database.schemaName);
  const items = `${q(database.schemaName)}.${q('BaseItems')}`;
  const ancestors = `${q(database.schemaName)}.${q('AncestorIds')}`;
  const type = alias => `substring(${sql.projection(`${alias}."Type"`)} from '[^.]+$')`;
  const same = (a, b) => `${sql.guidKey(a)} = ${sql.guidKey(b)}`;
  const date = expression => {
    const text = `regexp_replace(replace(${sql.projection(expression)}, 'T', ' '), '(Z|\\+00:00)$', '')`;
    return `(split_part(${text}, '.', 1) || '.' || rpad(CASE WHEN strpos(${text}, '.') = 0 THEN '' ELSE split_part(${text}, '.', 2) END, 7, '0')) COLLATE "C"`;
  };
  const order = alias => `${date(`${alias}."DateCreated"`)} DESC NULLS LAST, ${sql.guidKey(`${alias}."Id"`)} COLLATE "C" DESC`;
  const repository = !channelQuery && groupItems && ['music', 'movies', 'tvshows', null].includes(collectionType);
  const presentationGrouping = !query.includeitemtypes?.length || query.includeitemtypes.some(type =>
    ['Episode', 'Video', 'Movie', 'MusicVideo', 'Series', 'Season'].includes(type));
  const base = channelQuery ? buildPostgresChannelItemsQuery(database, channelQuery, { userId, visibility, scope }) : buildPostgresItemPageQuery(database, query, {
    scope, userId, visibility,
    groupByPresentationKey: !repository && presentationGrouping, includeOrdinal: true,
  });
  const values = [...base.values];
  const bind = value => { values.push(value); return `$${values.length}`; };
  const doubledLimit = (limit * 2) | 0;
  // SQLite's negative Take is unbounded; the manager then stops on its first
  // group for a negative requested limit. Enumerable.Take in movie/TV latest
  // returns no rows instead. Keep that observable distinction in bounded SQL.
  const emptyNegative = repository && collectionType !== 'music' || !repository && doubledLimit === 0;
  const outputLimit = limit < 0 ? (!channelQuery && emptyNegative ? 0 : 1) : limit;
  const cap = bind(outputLimit);
  const ctes = [`source_page AS (${base.text})`, `source AS (
    SELECT item.*, source_page."__ordinal" AS __source_order
    FROM source_page JOIN ${items} item ON ${same('item."Id"', 'source_page."Id"')}
  )`];

  if (repository) {
    // Native's returned album/container must satisfy parental restrictions on
    // its own. The caller's library scope and leaf filters do not constrain it.
    if (collectionType !== 'movies') {
      const access = buildPostgresItemPageQuery(database, {}, {
        userId, visibility, includeOwnedItems: true, includeAlternateVersions: true,
      });
      const rebased = access.text.replace(/\$(\d+)/gu, (_, ordinal) => `$${Number(ordinal) + values.length}`);
      values.push(...access.values);
      ctes.push(`accessible AS (${rebased})`);
    }
    if (collectionType === 'music') {
      const albumScope = scope.topParentIds?.length
        ? `${sql.guidKey('album."TopParentId"')} = ANY(${bind(scope.topParentIds.map(id => id.replaceAll('-', '').toLowerCase()))}::text[])
          AND album."TopParentId" IS NOT NULL AND album."IsVirtualItem" IS FALSE`
        : `EXISTS (SELECT 1 FROM ${ancestors} relation JOIN source track
            ON ${same('track."Id"', 'relation."ItemId"')}
            WHERE ${same('relation."ParentItemId"', 'album."Id"')})`;
      ctes.push(`latest AS (
        SELECT album."Id", row_number() OVER (ORDER BY ${order('album')}) AS __latest_order
        FROM ${items} album JOIN accessible access ON ${same('access."Id"', 'album."Id"')}
        WHERE ${type('album')} = 'MusicAlbum' AND ${albumScope}
        ORDER BY ${order('album')} LIMIT ${cap}
      )`);
    } else {
      if (collectionType !== 'tvshows') {
        ctes.push(`movie_ranked AS (
          SELECT source.*, row_number() OVER (PARTITION BY source."PresentationUniqueKey"
            ORDER BY ${order('source')}) AS __key_rank FROM source
          WHERE source."PresentationUniqueKey" IS NOT NULL${collectionType == null ? ' AND source."SeriesName" IS NULL' : ''}
        )`, `latest_movies AS (
          SELECT "Id", ${date('movie."DateCreated"')} AS __latest_date
          FROM movie_ranked movie WHERE __key_rank = 1 ORDER BY ${order('movie')} LIMIT ${cap}
        )`);
      }
      if (collectionType !== 'movies') {
        // A single global bound in the native implementation is an optimization;
        // each series still uses its own full 100 ns, inclusive 24-hour window.
        ctes.push(`recent_series AS (
          SELECT "SeriesName", max(${date('source."DateCreated"')}) AS __max_date FROM source
          WHERE "SeriesName" IS NOT NULL GROUP BY "SeriesName"
          ORDER BY __max_date DESC NULLS LAST, "SeriesName" LIMIT ${cap}
        )`, `recent_episodes AS (
          SELECT episode.*, row_number() OVER (PARTITION BY episode."SeriesName"
            ORDER BY ${order('episode')}) AS __recent_order, recent.__max_date
          FROM source episode JOIN recent_series recent ON episode."SeriesName" = recent."SeriesName"
          WHERE ${date('episode."DateCreated"')} >=
            (to_char(substring(recent.__max_date from 1 for 19)::timestamp - interval '24 hours',
              'YYYY-MM-DD HH24:MI:SS') || substring(recent.__max_date from 20)) COLLATE "C"
        )`, `series_analysis AS (
          SELECT "SeriesName", max(__max_date) AS __latest_date, count(*) AS __recent_count,
            count(DISTINCT "SeasonId") AS __season_count,
            (array_agg("SeasonId" ORDER BY __recent_order) FILTER (WHERE "SeasonId" IS NOT NULL))[1] AS __season_id,
            (array_agg("SeriesId" ORDER BY __recent_order) FILTER (WHERE "SeriesId" IS NOT NULL))[1] AS __series_id,
            (array_agg("Id" ORDER BY __recent_order))[1] AS __episode_id
          FROM recent_episodes GROUP BY "SeriesName"
        )`, `series_choice AS (
          SELECT analysis.*, CASE
            WHEN __season_count = 1 AND (__recent_count > 1 OR __recent_count =
              (SELECT count(*) FROM ${items} ep WHERE ${type('ep')} = 'Episode'
                AND ${same('ep."SeasonId"', 'analysis.__season_id')}))
              THEN CASE WHEN COALESCE(NULLIF((SELECT count(*) FROM ${items} season
                WHERE ${type('season')} = 'Season' AND ${same('season."SeriesId"', 'analysis.__series_id')}), 0), 1) > 1
                THEN __season_id ELSE __series_id END
            WHEN __season_count > 1 THEN __series_id ELSE NULL END AS __container_id
          FROM series_analysis analysis
        )`, `latest_shows AS (
          SELECT CASE WHEN EXISTS (SELECT 1 FROM accessible access
            WHERE ${same('access."Id"', 'choice.__container_id')})
            THEN choice.__container_id ELSE choice.__episode_id END AS "Id", __latest_date
          FROM series_choice choice
          ORDER BY __latest_date DESC NULLS LAST, ${sql.guidKey('COALESCE(choice.__container_id, choice.__episode_id)')} COLLATE "C" DESC
          LIMIT ${cap}
        )`);
      }
      const union = collectionType === 'movies' ? 'SELECT * FROM latest_movies'
        : collectionType === 'tvshows' ? 'SELECT * FROM latest_shows'
          : 'SELECT * FROM latest_movies UNION ALL SELECT * FROM latest_shows';
      // The mixed-library branch reorders the returned entities by their own
      // creation dates, whereas TV alone retains the latest episode's date.
      const resultDate = collectionType == null ? date('latest_entity."DateCreated"') : 'result.__latest_date';
      ctes.push(`latest AS (
        SELECT result."Id", row_number() OVER (ORDER BY ${resultDate} DESC NULLS LAST,
          ${sql.guidKey('result."Id"')} COLLATE "C" DESC) AS __latest_order
        FROM (${union}) result ${collectionType == null ? `JOIN ${items} latest_entity ON ${same('latest_entity."Id"', 'result."Id"')}` : ''}
        ORDER BY ${resultDate} DESC NULLS LAST,
          ${sql.guidKey('result."Id"')} COLLATE "C" DESC LIMIT ${cap}
      )`);
    }
  } else if (channelQuery) {
    // ChannelManager already applies the caller's exact repository Limit and
    // ordering. UserViewManager groups that selection without a doubled window.
    ctes.push('latest AS (SELECT "Id", __source_order AS __latest_order FROM source)');
  } else {
    const candidateLimit = limit < 0 ? outputLimit : doubledLimit;
    ctes.push(`latest AS (SELECT "Id", __source_order AS __latest_order FROM source
      ORDER BY __source_order${candidateLimit < 0 ? '' : ` LIMIT ${bind(candidateLimit)}`})`);
  }

  if (groupItems) {
    // Audio/Photo find their nearest typed ancestor. Episode.Series also permits
    // a resolved parent when its stored SeriesId is absent.
    ctes.push(`parent_walk AS (
      SELECT item."Id" AS __item_id, parent."Id", parent."ParentId", parent."Type", 1 AS __depth,
        ARRAY[${sql.guidKey('item."Id"')}, ${sql.guidKey('parent."Id"')}] AS __seen
      FROM latest JOIN ${items} item ON ${same('item."Id"', 'latest."Id"')}
      JOIN ${items} parent ON ${same('parent."Id"', 'item."ParentId"')}
      WHERE item."IsFolder" IS FALSE AND ${type('item')} IN ('Audio', 'Photo', 'Episode')
      UNION ALL SELECT walk.__item_id, parent."Id", parent."ParentId", parent."Type", walk.__depth + 1,
        walk.__seen || ${sql.guidKey('parent."Id"')}
      FROM parent_walk walk JOIN ${items} parent ON ${same('parent."Id"', 'walk."ParentId"')}
      WHERE NOT ${sql.guidKey('parent."Id"')} = ANY(walk.__seen)
    )`, `indexed AS (
      SELECT latest.*, container."Id" AS __container_id, container."Type" AS __container_type,
        CASE WHEN container."Id" IS NULL THEN 'item:' ELSE 'container:' END ||
          ${sql.guidKey('COALESCE(container."Id", item."Id")')} AS __group_key
      FROM latest JOIN ${items} item ON ${same('item."Id"', 'latest."Id"')}
      LEFT JOIN LATERAL (
        SELECT parent."Id", parent."Type" FROM ${items} parent
        WHERE item."IsFolder" IS FALSE AND (
          (${type('item')} = 'Episode' AND ${type('parent')} = 'Series'
            AND ${same('parent."Id"', 'item."SeriesId"')})
          OR EXISTS (SELECT 1 FROM parent_walk walk WHERE ${same('walk.__item_id', 'item."Id"')}
            AND ${same('walk."Id"', 'parent."Id"')}
            AND ((${type('item')} = 'Audio' AND ${type('walk')} = 'MusicAlbum')
              OR (${type('item')} = 'Photo' AND ${type('walk')} = 'PhotoAlbum')
              OR (${type('item')} = 'Episode' AND ${type('walk')} = 'Series'
                AND (item."SeriesId" IS NULL OR ${sql.guidKey('item."SeriesId"')} = '00000000000000000000000000000000')))))
        ORDER BY (${same('parent."Id"', 'item."SeriesId"')}) DESC NULLS LAST,
          (SELECT min(walk.__depth) FROM parent_walk walk
            WHERE ${same('walk.__item_id', 'item."Id"')} AND ${same('walk."Id"', 'parent."Id"')})
        LIMIT 1
      ) container ON TRUE
    )`, `group_order AS (
      SELECT __group_key, min(__latest_order) AS __first_order,
        row_number() OVER (ORDER BY min(__latest_order)) AS __group_order
      FROM indexed GROUP BY __group_key
    )`, `page AS (
      SELECT CASE WHEN count(*) > 1 OR substring(${sql.projection('indexed.__container_type')} from '[^.]+$') = 'MusicAlbum'
          THEN (array_agg(__container_id ORDER BY __latest_order))[1]
          ELSE (array_agg(indexed."Id" ORDER BY __latest_order))[1] END AS "Id",
        CASE WHEN count(*) > 1 OR substring(${sql.projection('indexed.__container_type')} from '[^.]+$') = 'MusicAlbum'
          THEN count(*) ELSE 0 END AS "ChildCount", min(__latest_order) AS __ordinal
      FROM indexed JOIN group_order USING (__group_key)
      WHERE __group_order <= ${cap} AND __latest_order <= COALESCE(
        (SELECT __first_order FROM group_order WHERE __group_order = ${cap}), 9223372036854775807)
      GROUP BY __group_key, indexed.__container_type
    )`);
  } else ctes.push(`page AS (SELECT "Id", 0::bigint AS "ChildCount", __latest_order AS __ordinal
    FROM latest ORDER BY __latest_order LIMIT ${cap})`);
  const text = `WITH RECURSIVE ${ctes.join(',\n')} SELECT * FROM page ORDER BY __ordinal`;
  const result = await database.client.query({ text, values });
  const selected = result.rows.map(row => ({ id: decodeNativeTextBytes(row.Id), childCount: Number(row.ChildCount) }));
  const rows = selected.length ? await database.rows('BaseItems', { whereIn: { Id: selected.map(row => row.id) } }) : [];
  const byId = new Map(rows.map(row => [row.Id.toLowerCase(), row]));
  const entries = selected.flatMap(entry => {
    const row = byId.get(entry.id.toLowerCase());
    return row ? [{ row, childCount: entry.childCount }] : [];
  });
  return { rows: entries.map(entry => entry.row), childCounts: entries.map(entry => entry.childCount) };
}
