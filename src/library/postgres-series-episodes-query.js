import { decodeNativeTextBytes, nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { quoteIdentifier as q } from '../database/model.js';
import { postgresSignedPaddedInteger as signedPadded } from '../database/postgres-query-expressions.js';
import { postgresOrdinalIgnoreCaseKeyFunctionName, postgresSafeInt32FunctionName,
  postgresSafeNativeItemDataFunctionName } from '../database/postgres-runtime-schema.js';
import { clrTrim, clrWhitespaceCharacters } from '../metadata/whitespace.js';
import { cleanValue, idKey, nonemptyId } from './records.js';

const VIDEO_TYPES = Object.freeze(['Movie', 'Video', 'Episode', 'MusicVideo', 'Trailer']);

function qualified(database, name) {
  if (database?.dialect !== 'postgres') throw new TypeError('A PostgreSQL database is required.');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/u.test(database.schemaName ?? '')) {
    throw new TypeError('A valid PostgreSQL schema is required for Shows episode queries.');
  }
  return `${q(database.schemaName)}.${q(name)}`;
}

const leafType = (database, alias) => `substring(${nativeTextSql(database.schemaName).projection(`${alias}."Type"`)} from '[^.]+$')`;
const normalizedId = (database, expression) => `replace(${nativeTextSql(database.schemaName).guidLower(expression)}, '-', '')`;
const presentId = (database, expression) => `${expression} IS NOT NULL AND ${expression} <> decode('','hex')
  AND ${normalizedId(database, expression)} <> '00000000000000000000000000000000'`;
const repositoryOrder = alias => `${alias}."SortName" ASC NULLS FIRST, ${alias}."Id" ASC`;
const ordinalKey = (database, expression) => nativeTextSql(database.schemaName).ordinalIgnoreCaseKey(expression);

function seasonKey(database, alias, fallbackSeriesKey) {
  const sql = nativeTextSql(database.schemaName);
  return `COALESCE(${alias}."PresentationUniqueKey", CASE
    WHEN ${alias}."IndexNumber" IS NOT NULL THEN COALESCE(${alias}."SeriesPresentationUniqueKey", ${fallbackSeriesKey}, decode('','hex'))
      || decode('2d','hex') || ${sql.fromProjection(signedPadded(`${alias}."IndexNumber"`, 3))}
    ELSE ${sql.fromProjection(normalizedId(database, `${alias}."Id"`))}
  END)`;
}

function extractedInteger(database, alias, property) {
  const document = `${qualified(database, postgresSafeNativeItemDataFunctionName)}(${alias}."Type", ${alias}."Data")`;
  return `${nativeTextSql(database.schemaName).safeInt32(nativeTextSql(database.schemaName).fromProjection(`${document} ->> '${property}'`))}`;
}

function int32(expression) {
  return `(mod(mod((${expression})::bigint + 2147483648, 4294967296) + 4294967296, 4294967296) - 2147483648)`;
}

function comparison(left, right) {
  return `CASE WHEN ${left} < ${right} THEN -1 WHEN ${left} > ${right} THEN 1 ELSE 0 END`;
}

function episodeSortName(database, alias, trimCharacters) {
  const project = expression => nativeTextSql(database.schemaName).projection(expression);
  const parent = signedPadded(`${alias}."ParentIndexNumber"`, 3);
  const index = signedPadded(`${alias}."IndexNumber"`, 4);
  return `CASE WHEN COALESCE(${project(`${alias}."ForcedSortName"`)}, '') = '' THEN concat(
    CASE WHEN ${alias}."ParentIndexNumber" IS NULL THEN '' ELSE ${parent} || ' - ' END,
    CASE WHEN ${alias}."IndexNumber" IS NULL THEN '' ELSE ${index} || ' - ' END,
    COALESCE(${project(`${alias}."Name"`)}, ''))
    ELSE btrim(${project(`${alias}."ForcedSortName"`)}, ${trimCharacters}) END`;
}

function airedEpisodeComparison(left, right) {
  const leftSpecial = `COALESCE(${left}."ParentIndexNumber", -1) = 0`;
  const rightSpecial = `COALESCE(${right}."ParentIndexNumber", -1) = 0`;
  const specialValue = alias => `(COALESCE(${alias}."AirsAfterSeasonNumber", ${alias}."AirsBeforeSeasonNumber", 0)::bigint * 1000000000
    + CASE WHEN ${alias}."AirsAfterSeasonNumber" IS NULL THEN 0 ELSE 1000000 END
    + ${int32(`COALESCE(${alias}."AirsBeforeEpisodeNumber", 0)::bigint * 1000`)}
    + COALESCE(${alias}."IndexNumber", 0)::bigint)`;
  const regularValue = alias => int32(`${int32(`COALESCE(${alias}."ParentIndexNumber", -1)::bigint * 1000`)} + COALESCE(${alias}."IndexNumber", -1)::bigint`);
  const regularToSpecial = (regular, special) => `CASE
    WHEN COALESCE(${regular}."ParentIndexNumber", -1) < COALESCE(${special}."AirsAfterSeasonNumber", ${special}."AirsBeforeSeasonNumber", -1) THEN -1
    WHEN COALESCE(${regular}."ParentIndexNumber", -1) > COALESCE(${special}."AirsAfterSeasonNumber", ${special}."AirsBeforeSeasonNumber", -1) THEN 1
    WHEN ${special}."AirsAfterSeasonNumber" IS NOT NULL THEN -1
    WHEN ${special}."AirsBeforeEpisodeNumber" IS NULL THEN 1
    WHEN ${regular}."IndexNumber" IS NULL THEN 0
    WHEN ${regular}."IndexNumber" = ${special}."AirsBeforeEpisodeNumber" THEN 1
    ELSE ${comparison(`${regular}."IndexNumber"`, `${special}."AirsBeforeEpisodeNumber"`)} END`;
  const regularCompare = `CASE
    WHEN ${regularValue(left)} <> ${regularValue(right)} THEN ${comparison(regularValue(left), regularValue(right))}
    WHEN ${left}."PremiereDate" IS NOT NULL AND ${right}."PremiereDate" IS NOT NULL
      THEN ${comparison(`${left}."PremiereDate"`, `${right}."PremiereDate"`)}
    ELSE 0 END`;
  return `CASE
    WHEN ${leftSpecial} AND ${rightSpecial} THEN ${comparison(specialValue(left), specialValue(right))}
    WHEN NOT (${leftSpecial}) AND NOT (${rightSpecial}) THEN ${regularCompare}
    WHEN ${leftSpecial} THEN -(${regularToSpecial(right, left)})
    ELSE ${regularToSpecial(left, right)} END`;
}

function memoryEpisodeComparison(database, left, right, season, trimCharacters) {
  const sql = nativeTextSql(database.schemaName);
  const leftName = ordinalKey(database, sql.fromProjection(episodeSortName(database, left, trimCharacters)));
  const rightName = ordinalKey(database, sql.fromProjection(episodeSortName(database, right, trimCharacters)));
  return `CASE WHEN ${season}."IndexNumber" = 0
    THEN ${comparison(leftName, rightName)}
    ELSE ${airedEpisodeComparison(left, right)} END`;
}

function validateVisibility(visibility) {
  if (visibility == null) return;
  if (!visibility || typeof visibility !== 'object' || Array.isArray(visibility)) {
    throw new TypeError('visibility must be an object.');
  }
  const allowed = new Set(['blockedTags', 'allowedTags', 'maxRating', 'maxSubRating', 'blockUnratedTypes',
    'libraryTopParentIds', 'ratingContext']);
  const unknown = Object.keys(visibility).filter(key => !allowed.has(key));
  if (unknown.length) throw new TypeError(`Unknown episode visibility option: ${unknown.join(', ')}`);
}

/**
 * Build the relational equivalent of TvShowsController.GetEpisodes. The
 * repository filter/group stage deliberately precedes series scoping, while
 * the metadata-child stage can assign a special to more than one season.
 */
export function buildPostgresSeriesEpisodePageQuery(database, {
  mode = 'series', seriesKey = null, seasonId, seasonNumber,
  includeMissing = false, includeSpecials = true, groupByPresentationKey = false,
  isMissing, startItemId, adjacentTo, random = false, startIndex, limit, visibility,
} = {}) {
  if (!['series', 'season', 'number'].includes(mode)) throw new TypeError('Unknown series episode query mode.');
  if (mode === 'season' && !nonemptyId(seasonId)) throw new TypeError('seasonId is required for a season query.');
  if (mode === 'number' && !Number.isSafeInteger(seasonNumber)) throw new TypeError('seasonNumber is required for a numbered season query.');
  if (startIndex !== undefined && !Number.isSafeInteger(startIndex)) throw new TypeError('startIndex must be an integer.');
  if (limit !== undefined && !Number.isSafeInteger(limit)) throw new TypeError('limit must be an integer.');
  validateVisibility(visibility);

  const baseItems = qualified(database, 'BaseItems');
  const ancestors = qualified(database, 'AncestorIds');
  const itemValues = qualified(database, 'ItemValues');
  const itemValuesMap = qualified(database, 'ItemValuesMap');
  const links = qualified(database, 'LinkedChildren');
  const values = [];
  const bind = value => { values.push(value); return `$${values.length}`; };
  const clrWhitespaceParameter = bind(clrWhitespaceCharacters);
  const bindTexts = value => `${bind(value)}::text[]`;
  const bindNative = value => bind(value == null ? null : nativeTextBytes(value));
  const bindNativeTexts = value => `${bind(value.map(nativeTextBytes))}::bytea[]`;
  const predicates = [
    `${nativeTextSql(database.schemaName).projection('i."Type"')} <> 'PLACEHOLDER'`,
    `${leafType(database, 'i')} IN ('Season', 'Episode')`,
    `(i."OwnerId" IS NULL OR i."ExtraType" IS NOT NULL)`,
    `(i."PrimaryVersionId" IS NULL OR NOT EXISTS (
      SELECT 1 FROM ${baseItems} primary_item
      WHERE replace(${nativeTextSql(database.schemaName).guidLower("primary_item.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("i.\"PrimaryVersionId\"")}, '-', '')
        AND ${nativeTextSql(database.schemaName).guidLower("primary_item.\"TopParentId\"")} IS NOT DISTINCT FROM ${nativeTextSql(database.schemaName).guidLower("i.\"TopParentId\"")}
    ))`,
  ];
  if (!includeMissing) predicates.push('i."IsVirtualItem" IS NOT TRUE');

  if (visibility != null) {
    const inheritedTagExists = names => {
      const parameter = bindNativeTexts(names.map(cleanValue));
      return `EXISTS (
        SELECT 1 FROM ${itemValuesMap} permission_map
        JOIN ${itemValues} permission_value
          ON ${nativeTextSql(database.schemaName).guidLower("permission_value.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemValueId\"")}
        WHERE permission_value."Type" = 4
          AND permission_value."CleanValue" = ANY(${parameter})
          AND (${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")}
            OR ${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"TopParentId\"")}
            OR ${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"SeriesId\"")}
            OR ${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemId\"")} IN (
              SELECT ${nativeTextSql(database.schemaName).guidLower("permission_ancestor.\"ParentItemId\"")}
              FROM ${ancestors} permission_ancestor
              WHERE ${nativeTextSql(database.schemaName).guidLower("permission_ancestor.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")}
            ))
      )`;
    };
    if (visibility.blockedTags?.length) predicates.push(`NOT ${inheritedTagExists(visibility.blockedTags)}`);
    if (visibility.allowedTags?.length) predicates.push(inheritedTagExists(visibility.allowedTags));
    if (visibility.maxRating != null) {
      predicates.push(`(i."InheritedParentalRatingValue" IS NULL
        OR i."InheritedParentalRatingValue" < ${bind(visibility.maxRating)}
        OR (i."InheritedParentalRatingValue" = ${bind(visibility.maxRating)}
          AND COALESCE(i."InheritedParentalRatingSubValue", 0) <= ${bind(visibility.maxSubRating ?? 0)}))`);
      const childMax = bind(visibility.maxRating), childSub = bind(visibility.maxSubRating ?? 0);
      predicates.push(`(NOT EXISTS (
        SELECT 1 FROM ${links} rating_link
        WHERE ${nativeTextSql(database.schemaName).guidLower("rating_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND rating_link."ChildType" = 0
      ) OR EXISTS (
        SELECT 1 FROM ${links} rating_link
        JOIN ${baseItems} rating_child ON ${nativeTextSql(database.schemaName).guidLower("rating_child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("rating_link.\"ChildId\"")}
        WHERE ${nativeTextSql(database.schemaName).guidLower("rating_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND rating_link."ChildType" = 0
          AND (rating_child."InheritedParentalRatingValue" IS NULL
            OR rating_child."InheritedParentalRatingValue" < ${childMax}
            OR (rating_child."InheritedParentalRatingValue" = ${childMax}
              AND COALESCE(rating_child."InheritedParentalRatingSubValue", 0) <= ${childSub}))
      ))`);
    }
    if (visibility.blockUnratedTypes?.length) {
      predicates.push(`(i."InheritedParentalRatingValue" IS NULL
        AND i."UnratedType" = ANY(${bindNativeTexts(visibility.blockUnratedTypes)})) IS NOT TRUE`);
    }
  }

  const seriesKeyParameter = `${bindNative(seriesKey)}::bytea`;
  const hasSeriesKey = clrTrim(String(seriesKey ?? '')).length > 0;
  const seriesScope = alias => hasSeriesKey
    ? `${alias}."SeriesPresentationUniqueKey" IS NOT DISTINCT FROM ${seriesKeyParameter}` : 'TRUE';
  const groupingRank = source => groupByPresentationKey
    ? `SELECT ${source}.*, row_number() OVER (
        PARTITION BY ${source}."PresentationUniqueKey"
        ORDER BY (${presentId(database, `${source}."PrimaryVersionId"`)}) ASC, ${source}."Id" ASC
      ) AS "__group_rank" FROM eligible ${source}`
    : `SELECT ${source}.*, 1::bigint AS "__group_rank" FROM eligible ${source}`;

  const ctes = [
    `eligible AS (
      SELECT i.* FROM ${baseItems} i
      WHERE ${predicates.join('\n        AND ')}
    )`,
    `joint_ranked AS (${groupingRank('joint_item')})`,
    `joint_selected AS (SELECT * FROM joint_ranked WHERE "__group_rank" = 1)`,
    `season_ranked AS (${groupingRank('season_item')} WHERE ${leafType(database, 'season_item')} = 'Season')`,
    `season_selected AS (SELECT * FROM season_ranked WHERE "__group_rank" = 1)`,
    `episode_ranked AS (${groupingRank('episode_item')} WHERE ${leafType(database, 'episode_item')} = 'Episode')`,
    `episode_selected AS (SELECT * FROM episode_ranked WHERE "__group_rank" = 1)`,
  ];

  if (mode === 'season') {
    ctes.push(`chosen_seasons AS (
      SELECT target.*, 1::bigint AS "__season_ordinal"
      FROM ${baseItems} target
      WHERE ${normalizedId(database, 'target."Id"')} = ${bind(idKey(seasonId))}
    )`);
  } else if (mode === 'number') {
    ctes.push(`season_choices AS (
      SELECT candidate.*, row_number() OVER (ORDER BY candidate."SortName" ASC NULLS FIRST,
        candidate."Name" ASC NULLS FIRST, candidate."Id" ASC) AS "__season_ordinal"
      FROM season_selected candidate
      WHERE ${seriesScope('candidate')} AND candidate."IndexNumber" = ${bind(seasonNumber)}
    )`);
    ctes.push('chosen_seasons AS (SELECT * FROM season_choices WHERE "__season_ordinal" = 1)');
  } else {
    ctes.push(`chosen_seasons AS (
      SELECT candidate.*, row_number() OVER (ORDER BY ${repositoryOrder('candidate')}) AS "__season_ordinal"
      FROM joint_selected candidate
      WHERE ${leafType(database, 'candidate')} = 'Season' AND ${seriesScope('candidate')}
    )`);
  }

  const episodeSource = mode === 'series' ? 'joint_selected' : 'episode_selected';
  const episodePredicates = [`${leafType(database, 'episode')} = 'Episode'`];
  if (mode === 'series' || includeSpecials) episodePredicates.push(seriesScope('episode'));
  if (mode !== 'series' && !includeSpecials) {
    const key = seasonKey(database, 'chosen', seriesKeyParameter);
    episodePredicates.push(`(btrim(${nativeTextSql(database.schemaName).projection(key)}, ${clrWhitespaceParameter}) = '' OR EXISTS (
      SELECT 1 FROM ${ancestors} candidate_ancestor
      WHERE ${nativeTextSql(database.schemaName).guidLower("candidate_ancestor.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("episode.\"Id\"")}
        AND ${nativeTextSql(database.schemaName).guidLower("candidate_ancestor.\"ParentItemId\"")} IN (
          SELECT ${nativeTextSql(database.schemaName).guidLower("state_item.\"Id\"")} FROM (
            SELECT eligible_season."Id", eligible_season."PresentationUniqueKey"
              FROM eligible eligible_season
              WHERE ${leafType(database, 'eligible_season')} = 'Season'
            UNION ALL
            SELECT selected_episode."Id", selected_episode."PresentationUniqueKey"
              FROM episode_selected selected_episode
          ) state_item
          WHERE state_item."PresentationUniqueKey" = ${key}
        )
    ))`);
  }
  ctes.push(`episode_pool AS (
    SELECT DISTINCT episode.*
    FROM ${episodeSource} episode
    ${mode === 'series' ? '' : 'CROSS JOIN chosen_seasons chosen'}
    WHERE ${episodePredicates.join('\n      AND ')}
  )`);
  ctes.push(`episode_enriched AS (
    SELECT episode.*,
      ${extractedInteger(database, 'episode', 'AirsAfterSeasonNumber')} AS "AirsAfterSeasonNumber",
      ${extractedInteger(database, 'episode', 'AirsBeforeSeasonNumber')} AS "AirsBeforeSeasonNumber",
      ${extractedInteger(database, 'episode', 'AirsBeforeEpisodeNumber')} AS "AirsBeforeEpisodeNumber",
      row_number() OVER (ORDER BY ${repositoryOrder('episode')}) AS "__repository_ordinal"
    FROM episode_pool episode
  )`);

  // Resolve the Season getter without loading the catalogue. An explicit
  // SeasonId is authoritative; otherwise walk physical parents, then fall
  // back to the resolved Series' direct season with the matching index.
  ctes.push(`parent_walk("EpisodeId", "NodeId", "Depth", "Seen") AS (
    SELECT episode."Id", episode."ParentId", 1, ARRAY[${normalizedId(database, 'episode."Id"')}]
    FROM episode_enriched episode
    WHERE NOT (${presentId(database, 'episode."SeasonId"')}) AND ${presentId(database, 'episode."ParentId"')}
    UNION ALL
    SELECT walk."EpisodeId", parent."ParentId", walk."Depth" + 1,
      walk."Seen" || ${normalizedId(database, 'parent."Id"')}
    FROM parent_walk walk
    JOIN ${baseItems} parent ON ${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower('walk."NodeId"')}
    WHERE ${presentId(database, 'parent."ParentId"')}
      AND NOT (${normalizedId(database, 'parent."Id"')} = ANY(walk."Seen"))
  )`);
  ctes.push(`physical_season AS (
    SELECT DISTINCT ON (walk."EpisodeId") walk."EpisodeId", parent."Id" AS "SeasonId"
    FROM parent_walk walk
    JOIN ${baseItems} parent ON ${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower('walk."NodeId"')}
    WHERE ${leafType(database, 'parent')} = 'Season'
    ORDER BY walk."EpisodeId", walk."Depth"
  )`);
  ctes.push(`parent_series AS (
    SELECT DISTINCT ON (walk."EpisodeId") walk."EpisodeId", parent."Id" AS "SeriesId"
    FROM parent_walk walk
    JOIN ${baseItems} parent ON ${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower('walk."NodeId"')}
    WHERE ${leafType(database, 'parent')} = 'Series'
    ORDER BY walk."EpisodeId", walk."Depth"
  )`);
  ctes.push(`episode_series AS (
    SELECT episode."Id" AS "EpisodeId", series."Id" AS "SeriesId"
    FROM episode_enriched episode
    LEFT JOIN parent_series inherited ON ${nativeTextSql(database.schemaName).guidLower('inherited."EpisodeId"')} = ${nativeTextSql(database.schemaName).guidLower("episode.\"Id\"")}
    JOIN ${baseItems} series ON ${leafType(database, 'series')} = 'Series'
      AND ${nativeTextSql(database.schemaName).guidLower("series.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower(`CASE WHEN ${presentId(database, 'episode."SeriesId"')} THEN episode."SeriesId" ELSE inherited."SeriesId" END`)}
  )`);
  ctes.push(`fallback_season AS (
    SELECT episode."Id" AS "EpisodeId", fallback."Id" AS "SeasonId",
      row_number() OVER (PARTITION BY episode."Id" ORDER BY ${repositoryOrder('fallback')}) AS "__fallback_rank"
    FROM episode_enriched episode
    JOIN episode_series resolved ON ${nativeTextSql(database.schemaName).guidLower('resolved."EpisodeId"')} = ${nativeTextSql(database.schemaName).guidLower("episode.\"Id\"")}
    JOIN ${baseItems} fallback ON ${nativeTextSql(database.schemaName).guidLower("fallback.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("resolved.\"SeriesId\"")}
      AND ${leafType(database, 'fallback')} = 'Season'
      AND fallback."IndexNumber" IS NOT DISTINCT FROM episode."ParentIndexNumber"
      AND (fallback."OwnerId" IS NULL OR fallback."ExtraType" IS NOT NULL)
      AND (fallback."PrimaryVersionId" IS NULL OR NOT EXISTS (
        SELECT 1 FROM ${baseItems} fallback_primary
        WHERE replace(${nativeTextSql(database.schemaName).guidLower("fallback_primary.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("fallback.\"PrimaryVersionId\"")}, '-', '')
          AND ${nativeTextSql(database.schemaName).guidLower("fallback_primary.\"TopParentId\"")} IS NOT DISTINCT FROM ${nativeTextSql(database.schemaName).guidLower("fallback.\"TopParentId\"")}
      ))
    WHERE NOT (${presentId(database, 'episode."SeasonId"')})
      AND NOT EXISTS (SELECT 1 FROM physical_season physical
        WHERE ${nativeTextSql(database.schemaName).guidLower('physical."EpisodeId"')} = ${nativeTextSql(database.schemaName).guidLower("episode.\"Id\"")})
  )`);
  ctes.push(`episode_reference AS (
    SELECT episode."Id" AS "EpisodeId", reference."Id" AS "SeasonId"
    FROM episode_enriched episode
    LEFT JOIN physical_season physical ON ${nativeTextSql(database.schemaName).guidLower('physical."EpisodeId"')} = ${nativeTextSql(database.schemaName).guidLower("episode.\"Id\"")}
    LEFT JOIN fallback_season fallback ON ${nativeTextSql(database.schemaName).guidLower('fallback."EpisodeId"')} = ${nativeTextSql(database.schemaName).guidLower("episode.\"Id\"")}
      AND fallback."__fallback_rank" = 1
    JOIN ${baseItems} reference ON ${leafType(database, 'reference')} = 'Season'
      AND ${nativeTextSql(database.schemaName).guidLower("reference.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower(`CASE WHEN ${presentId(database, 'episode."SeasonId"')} THEN episode."SeasonId" ELSE COALESCE(physical."SeasonId", fallback."SeasonId") END`)}
  )`);

  const chosenSeasonKey = seasonKey(database, 'chosen', seriesKeyParameter);
  const referencedSeasonKey = seasonKey(database, 'referenced', seriesKeyParameter);
  const currentSeason = includeSpecials
    ? `CASE WHEN chosen."IndexNumber" IS NOT NULL AND chosen."IndexNumber" <> 0
        THEN COALESCE(episode."AirsAfterSeasonNumber", episode."AirsBeforeSeasonNumber", episode."ParentIndexNumber")
        ELSE episode."ParentIndexNumber" END`
    : 'episode."ParentIndexNumber"';
  ctes.push(`membership AS (
    SELECT chosen."Id" AS "__selected_season_id", chosen."__season_ordinal", chosen."IndexNumber" AS "SeasonIndexNumber",
      chosen."Path" AS "SeasonPath", chosen."ChannelId" AS "SeasonChannelId",
      episode.*, reference."SeasonId" AS "ReferencedSeasonId",
      ${currentSeason} AS "CurrentSeasonNumber",
      ${chosenSeasonKey} AS "SeasonKey",
      ${referencedSeasonKey} AS "ReferencedSeasonKey"
    FROM chosen_seasons chosen
    CROSS JOIN episode_enriched episode
    LEFT JOIN episode_reference reference ON ${nativeTextSql(database.schemaName).guidLower('reference."EpisodeId"')} = ${nativeTextSql(database.schemaName).guidLower("episode.\"Id\"")}
    LEFT JOIN ${baseItems} referenced ON ${nativeTextSql(database.schemaName).guidLower("referenced.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("reference.\"SeasonId\"")}
  )`);
  const seasonVirtual = `(membership."SeasonPath" IS NULL OR membership."SeasonPath" = decode('','hex'))
    AND NOT (${presentId(database, 'membership."SeasonChannelId"')})`;
  const referencedVirtual = `(referenced."Path" IS NULL OR referenced."Path" = decode('','hex'))
    AND NOT (${presentId(database, 'referenced."ChannelId"')})`;
  ctes.push(`matched AS (
    SELECT membership.*
    FROM membership
    LEFT JOIN ${baseItems} referenced ON ${nativeTextSql(database.schemaName).guidLower("referenced.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower('membership."ReferencedSeasonId"')}
    WHERE (membership."CurrentSeasonNumber" IS NOT NULL
        AND membership."SeasonIndexNumber" IS NOT NULL
        AND membership."CurrentSeasonNumber" = membership."SeasonIndexNumber")
      OR (membership."CurrentSeasonNumber" IS NULL
        AND membership."SeasonIndexNumber" IS NULL
        AND ${seasonVirtual}
        AND (membership."ReferencedSeasonId" IS NULL OR ${referencedVirtual}))
      OR (membership."ReferencedSeasonId" IS NOT NULL
        AND ${ordinalKey(database, 'membership."ReferencedSeasonKey"')}
          = ${ordinalKey(database, 'membership."SeasonKey"')})
  )`);

  // PostgreSQL recursive insertion keeps the repository order for comparer
  // ties. This mirrors the stable observable result of the frozen in-memory
  // episode comparer without hydrating every episode in Node.
  ctes.push(`season_input AS (
    SELECT matched.*, row_number() OVER (
      PARTITION BY matched."__selected_season_id" ORDER BY matched."__repository_ordinal"
    ) AS "__input_ordinal",
      count(*) OVER (PARTITION BY matched."__selected_season_id") AS "__input_count"
    FROM matched
  )`);
  ctes.push(`episode_sort("SeasonId", "Step", "Ids", "InputCount") AS (
    SELECT chosen."Id", 0::bigint, (ARRAY[]::bytea[]), COALESCE(max(input."__input_count"), 0)::bigint
    FROM chosen_seasons chosen
    LEFT JOIN season_input input ON ${nativeTextSql(database.schemaName).guidLower('input."__selected_season_id"')} = ${nativeTextSql(database.schemaName).guidLower("chosen.\"Id\"")}
    GROUP BY chosen."Id"
    UNION ALL
    SELECT state."SeasonId", state."Step" + 1,
      CASE WHEN insertion."Ordinal" IS NULL THEN state."Ids" || incoming."Id"
        WHEN insertion."Ordinal" = 1 THEN ARRAY[incoming."Id"] || state."Ids"
        ELSE state."Ids"[1:insertion."Ordinal" - 1] || ARRAY[incoming."Id"]
          || state."Ids"[insertion."Ordinal":cardinality(state."Ids")] END,
      state."InputCount"
    FROM episode_sort state
    JOIN season_input incoming ON ${nativeTextSql(database.schemaName).guidLower('incoming."__selected_season_id"')} = ${nativeTextSql(database.schemaName).guidLower("state.\"SeasonId\"")}
      AND incoming."__input_ordinal" = state."Step" + 1
    JOIN chosen_seasons chosen ON ${nativeTextSql(database.schemaName).guidLower("chosen.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("state.\"SeasonId\"")}
    LEFT JOIN LATERAL (
      SELECT existing_position."Ordinal"
      FROM unnest(state."Ids") WITH ORDINALITY existing_position("Id", "Ordinal")
      JOIN season_input existing ON ${nativeTextSql(database.schemaName).guidLower('existing."__selected_season_id"')} = ${nativeTextSql(database.schemaName).guidLower("state.\"SeasonId\"")}
        AND ${nativeTextSql(database.schemaName).guidLower("existing.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("existing_position.\"Id\"")}
      WHERE ${memoryEpisodeComparison(database, 'incoming', 'existing', 'chosen', clrWhitespaceParameter)} < 0
      ORDER BY existing_position."Ordinal"
      LIMIT 1
    ) insertion ON TRUE
    WHERE state."Step" < state."InputCount"
  )`);
  ctes.push(`occurrences AS (
    SELECT chosen."__season_ordinal", ordered."Ordinal" AS "__episode_ordinal", ordered."Id",
      row_number() OVER (ORDER BY chosen."__season_ordinal", ordered."Ordinal") AS "__occurrence_ordinal"
    FROM episode_sort state
    JOIN chosen_seasons chosen ON ${nativeTextSql(database.schemaName).guidLower("chosen.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("state.\"SeasonId\"")}
    CROSS JOIN LATERAL unnest(state."Ids") WITH ORDINALITY ordered("Id", "Ordinal")
    WHERE state."Step" = state."InputCount"
  )`);
  ctes.push(`last_occurrence AS (
    SELECT occurrences.*, row_number() OVER (
      PARTITION BY ${nativeTextSql(database.schemaName).guidLower("occurrences.\"Id\"")} ORDER BY occurrences."__occurrence_ordinal" DESC
    ) AS "__duplicate_rank"
    FROM occurrences
  )`);
  ctes.push(`series_ordered AS (
    SELECT "Id", row_number() OVER (ORDER BY "__occurrence_ordinal") AS "__ordinal"
    FROM last_occurrence WHERE "__duplicate_rank" = 1
  )`);

  const virtualEpisode = `(episode."Path" IS NULL OR episode."Path" = decode('','hex'))
    AND NOT (${presentId(database, 'episode."ChannelId"')})`;
  ctes.push(`post_missing AS (
    SELECT ordered.* FROM series_ordered ordered
    JOIN ${baseItems} episode ON ${nativeTextSql(database.schemaName).guidLower("episode.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("ordered.\"Id\"")}
    ${isMissing === undefined ? '' : `WHERE ${isMissing ? virtualEpisode : `NOT (${virtualEpisode})`}`}
  )`);
  ctes.push(`post_missing_ordered AS (
    SELECT "Id", row_number() OVER (ORDER BY "__ordinal") AS "__ordinal" FROM post_missing
  )`);

  let previous = 'post_missing_ordered';
  if (nonemptyId(startItemId)) {
    const startKey = bind(idKey(startItemId));
    ctes.push(`start_identity AS (
      SELECT CASE WHEN ${leafType(database, 'start_item')} = ANY(${bindTexts(VIDEO_TYPES)})
          AND ${presentId(database, 'start_item."PrimaryVersionId"')}
        THEN ${normalizedId(database, 'start_item."PrimaryVersionId"')} ELSE ${normalizedId(database, 'start_item."Id"')} END AS "Id"
      FROM ${baseItems} start_item WHERE ${normalizedId(database, 'start_item."Id"')} = ${startKey}
      UNION ALL
      SELECT ${startKey} WHERE NOT EXISTS (
        SELECT 1 FROM ${baseItems} start_item WHERE ${normalizedId(database, 'start_item."Id"')} = ${startKey}
      )
      LIMIT 1
    )`);
    ctes.push(`start_anchor AS (
      SELECT source."__ordinal" FROM ${previous} source
      JOIN start_identity target ON ${normalizedId(database, 'source."Id"')} = target."Id"
      LIMIT 1
    )`);
    ctes.push(`after_start AS (
      SELECT source."Id", row_number() OVER (ORDER BY source."__ordinal") AS "__ordinal"
      FROM ${previous} source CROSS JOIN start_anchor anchor
      WHERE source."__ordinal" >= anchor."__ordinal"
    )`);
    previous = 'after_start';
  }
  if (nonemptyId(adjacentTo)) {
    const adjacentKey = bind(idKey(adjacentTo));
    ctes.push(`adjacent_anchor AS (
      SELECT "__ordinal" FROM ${previous}
      WHERE ${normalizedId(database, '"Id"')} = ${adjacentKey} LIMIT 1
    )`);
    ctes.push(`after_adjacency AS (
      SELECT source."Id", row_number() OVER (ORDER BY source."__ordinal") AS "__ordinal"
      FROM ${previous} source CROSS JOIN adjacent_anchor anchor
      WHERE source."__ordinal" BETWEEN greatest(anchor."__ordinal" - 1, 1) AND anchor."__ordinal" + 1
    )`);
    previous = 'after_adjacency';
  }
  if (random) {
    ctes.push(`after_random AS (
      SELECT "Id", row_number() OVER (ORDER BY random()) AS "__ordinal" FROM ${previous}
    )`);
    previous = 'after_random';
  }

  const paging = startIndex !== undefined || limit !== undefined;
  let pageSuffix = '';
  if (paging) {
    if (limit !== undefined) pageSuffix += ` LIMIT ${bind(Math.max(limit, 0))}`;
    if (Math.max(startIndex ?? 0, 0)) pageSuffix += ` OFFSET ${bind(Math.max(startIndex ?? 0, 0))}`;
  }
  ctes.push(`final_rows AS (SELECT * FROM ${previous})`);
  ctes.push(`page AS (SELECT "Id", "__ordinal" FROM final_rows ORDER BY "__ordinal"${pageSuffix})`);
  ctes.push('total AS (SELECT count(*)::bigint AS "TotalRecordCount" FROM final_rows)');

  const text = `WITH RECURSIVE ${ctes.join(',\n')}
    SELECT page."Id", total."TotalRecordCount"
    FROM total LEFT JOIN page ON TRUE
    ORDER BY page."__ordinal" NULLS LAST`;
  const relation = Object.freeze({ text: `WITH RECURSIVE ${ctes.join(',\n')}
    SELECT "Id", "__ordinal" AS "Ordinal" FROM page ORDER BY "__ordinal"`, values: Object.freeze(values) });
  return Object.freeze({ text, values: Object.freeze(values), relation, startIndex: startIndex ?? 0, limit });
}

/** Execute an episode page and hydrate only its selected BaseItems rows. */
export async function queryPostgresSeriesEpisodePage(database, options = {}) {
  const plan = buildPostgresSeriesEpisodePageQuery(database, options);
  const result = await database.client.query({ text: plan.text, values: plan.values, signal: options.signal });
  const ids = result.rows.filter(row => row.Id != null).map(row => decodeNativeTextBytes(row.Id)).filter(nonemptyId);
  const total = result.rows.length ? Number(result.rows[0].TotalRecordCount) : 0;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('PostgreSQL returned an invalid episode count.');
  const rows = ids.length ? await database.rows('BaseItems', { whereIn: { Id: ids } }) : [];
  const byId = new Map(rows.map(row => [idKey(row.Id), row]));
  return { rows: ids.map(id => byId.get(idKey(id))).filter(Boolean), total, startIndex: plan.startIndex, plan };
}
