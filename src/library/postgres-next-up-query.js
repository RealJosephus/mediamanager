import { nativeTextBytes, decodeNativeTextBytes, nativeTextOrdinalIgnoreCaseKey } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { quoteIdentifier as q } from '../database/model.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { postgresAliasedVersionFamilyKey, postgresSignedPaddedInteger } from '../database/postgres-query-expressions.js';
import {
  postgresInvariantCharUpperFunctionName,
  postgresNativeJsonEnumFunctionName,
  postgresOrdinalIgnoreCaseKeyFunctionName,
  postgresSafeInt32FunctionName,
  postgresSafeNativeItemDataFunctionName,
} from '../database/postgres-runtime-schema.js';
import { ecmaWhitespaceCharacters } from '../metadata/whitespace.js';
import { dateText, guid, idKey, MIN_DATE, nonemptyId } from './records.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';

function qualified(database, name) {
  if (database?.dialect !== 'postgres') throw new TypeError('A PostgreSQL database is required.');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/u.test(database.schemaName ?? '')) {
    throw new TypeError('A valid PostgreSQL schema is required for Next Up queries.');
  }
  return `${q(database.schemaName)}.${q(name)}`;
}

function safeNonnegativeInteger(value, description) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`PostgreSQL returned an invalid ${description}.`);
  }
  return number;
}

function orderedDate(value = MIN_DATE) {
  const native = dateText(value);
  return `${native.slice(0, 10)} ${native.slice(11, 19)}.${native.slice(20, 27)}`;
}

function storedDateOrder(database, expression) {
  const base = `regexp_replace(replace(${nativeTextSql(database.schemaName).projection(expression)}, 'T', ' '), '(Z|\\+00:00)$', '')`;
  return `(split_part(${base}, '.', 1) || '.' || rpad(CASE WHEN strpos(${base}, '.') = 0 THEN '' ELSE split_part(${base}, '.', 2) END, 7, '0')) COLLATE "C"`;
}

function jsonInteger(database, alias, name) {
  const document = `${qualified(database, postgresSafeNativeItemDataFunctionName)}(${alias}."Type", ${alias}."Data")`;
  return `${qualified(database, postgresSafeInt32FunctionName)}(${document} ->> '${name}')`;
}

function int32(expression) {
  return `(((((${expression})::bigint + 2147483648) % 4294967296 + 4294967296) % 4294967296) - 2147483648)`;
}

function compareValues(left, right) {
  return `(CASE WHEN ${left} < ${right} THEN -1 WHEN ${left} > ${right} THEN 1 ELSE 0 END)`;
}

function regularToSpecial(regular, special) {
  const regularSeason = `COALESCE(${regular}."ParentIndexNumber", -1)`;
  const specialSeason = `COALESCE(${special}.__placement_season, -1)`;
  return `(CASE
    WHEN ${regularSeason} < ${specialSeason} THEN -1
    WHEN ${regularSeason} > ${specialSeason} THEN 1
    WHEN ${special}.__airs_after_season IS NOT NULL THEN -1
    WHEN ${special}.__airs_before_episode IS NULL THEN 1
    WHEN ${regular}."IndexNumber" IS NULL THEN 0
    WHEN ${regular}."IndexNumber" = ${special}.__airs_before_episode THEN 1
    WHEN ${regular}."IndexNumber" < ${special}.__airs_before_episode THEN -1
    ELSE 1
  END)`;
}

function airedCompare(left, right) {
  const regular = `(CASE
    WHEN ${left}.__regular_order < ${right}.__regular_order THEN -1
    WHEN ${left}.__regular_order > ${right}.__regular_order THEN 1
    WHEN ${left}."PremiereDate" IS NOT NULL AND ${right}."PremiereDate" IS NOT NULL
      THEN ${compareValues(`${left}.__premiere_order`, `${right}.__premiere_order`)}
    ELSE 0
  END)`;
  return `(CASE
    WHEN ${left}.__special AND ${right}.__special
      THEN ${compareValues(`${left}.__special_order`, `${right}.__special_order`)}
    WHEN ${left}.__special THEN -${regularToSpecial(right, left)}
    WHEN ${right}.__special THEN ${regularToSpecial(left, right)}
    ELSE ${regular}
  END)`;
}

function consideredBefore(left, right) {
  const comparison = airedCompare(left, right);
  return `(${comparison} < 0 OR (${comparison} = 0 AND
    (${left}.__considered_group < ${right}.__considered_group OR
      (${left}.__considered_group = ${right}.__considered_group
        AND ${left}.__source_order < ${right}.__source_order))))`;
}

function afterLast(candidate, previous) {
  const comparison = airedCompare(candidate, previous);
  return `(${previous}."Id" IS NULL OR ${comparison} > 0 OR
    (${comparison} = 0 AND ${candidate}.__considered_group > 1))`;
}

function seriesReference(database, alias, baseItems, ancestors) {
  const empty = '00000000000000000000000000000000';
  return `(SELECT series."Id"
    FROM ${baseItems} series
    WHERE substring(${nativeTextSql(database.schemaName).projection("series.\"Type\"")} from '[^.]+$') = 'Series'
      AND (${nativeTextSql(database.schemaName).guidLower("series.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."SeriesId"`)}
        OR ((${alias}."SeriesId" IS NULL OR replace(${nativeTextSql(database.schemaName).guidLower(`${alias}."SeriesId"`)}, '-', '') = '${empty}')
          AND (${nativeTextSql(database.schemaName).guidLower("series.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."ParentId"`)} OR EXISTS (
            SELECT 1 FROM ${ancestors} series_ancestor
            WHERE ${nativeTextSql(database.schemaName).guidLower("series_ancestor.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)}
              AND ${nativeTextSql(database.schemaName).guidLower("series_ancestor.\"ParentItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("series.\"Id\"")}
          ))))
    ORDER BY (${nativeTextSql(database.schemaName).guidLower("series.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."SeriesId"`)}) DESC, series."Id"
    LIMIT 1)`;
}

function preferredDataJoin(database, alias, joinAlias, user, baseItems, ancestors, providers, userData, ordinalKey) {
  const series = seriesReference(database, alias, baseItems, ancestors);
  const suffix = `(${postgresSignedPaddedInteger(`${alias}."ParentIndexNumber"`, 3)} || ${postgresSignedPaddedInteger(`${alias}."IndexNumber"`, 3)})`;
  const provider = name => `(SELECT provider."ProviderValue" FROM ${providers} provider
    WHERE ${nativeTextSql(database.schemaName).guidLower("provider.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower(series)}
      AND ${ordinalKey('provider."ProviderId"')} = decode('${nativeTextOrdinalIgnoreCaseKey(name).toString('hex')}', 'hex')
    ORDER BY provider."ProviderValue" LIMIT 1)`;
  const possible = (value, priority) => `WHEN ${value} IS NOT NULL AND preferred."CustomDataKey" = ${value} || convert_to(${suffix}, 'UTF8') THEN ${priority}`;
  return `LEFT JOIN LATERAL (
    SELECT preferred.*
    FROM ${userData} preferred
    WHERE replace(${nativeTextSql(database.schemaName).guidLower("preferred.\"UserId\"")}, '-', '') = ${user}
      AND ${nativeTextSql(database.schemaName).guidLower("preferred.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)}
    ORDER BY CASE
      ${possible(provider('Custom'), 0)}
      ${possible(provider('Tvdb'), 1)}
      ${possible(provider('Imdb'), 2)}
      ${possible(series, 4)}
      WHEN ${nativeTextSql(database.schemaName).guidLower("preferred.\"CustomDataKey\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)} THEN 6
      ELSE 7
    END, preferred."CustomDataKey"
    LIMIT 1
  ) ${joinAlias} ON TRUE`;
}

/** Select/count/page Next Up in SQL; only the final page is hydrated. */
export async function queryPostgresNextUpPage(database, {
  seriesKeys,
  seriesDiscovery,
  userId,
  visibility,
  displaySpecialsWithinSeasons = false,
  enableRewatching = false,
  enableResumable = false,
  enableUserData = true,
  startIndex = 0,
  limit,
  enableTotalRecordCount = true,
} = {}) {
  if (seriesKeys !== undefined
    && (!Array.isArray(seriesKeys) || seriesKeys.some(key => typeof key !== 'string'))) {
    throw new TypeError('Next Up series keys must be a string array.');
  }
  if (seriesDiscovery !== undefined && (!seriesDiscovery || typeof seriesDiscovery !== 'object'
    || Array.isArray(seriesDiscovery))) throw new TypeError('Next Up series discovery must be an object.');
  if (seriesKeys !== undefined && seriesDiscovery !== undefined) {
    throw new TypeError('Next Up accepts explicit series keys or a discovery scope, not both.');
  }
  if (seriesDiscovery !== undefined && !Array.isArray(seriesDiscovery.topParentIds ?? [])) {
    throw new TypeError('Next Up discovery top-parent ids must be an array.');
  }
  if (seriesDiscovery?.limit !== undefined
    && (!Number.isSafeInteger(seriesDiscovery.limit) || seriesDiscovery.limit < 0)) {
    throw new TypeError('Invalid Next Up series discovery limit.');
  }
  if (!nonemptyId(userId)) throw new TypeError('A Next Up user is required.');
  if (!Number.isSafeInteger(startIndex)) throw new TypeError('Invalid Next Up start index.');
  if (limit !== undefined && !Number.isSafeInteger(limit)) throw new TypeError('Invalid Next Up limit.');
  const explicitKeys = seriesKeys ?? [];
  const discoveryParents = seriesDiscovery === undefined ? []
    : [...new Set((seriesDiscovery.topParentIds ?? []).filter(nonemptyId).map(id => idKey(guid(id))))];
  if (!explicitKeys.length && !discoveryParents.length) {
    return { rows: [], total: 0, startIndex, entries: [] };
  }

  const eligiblePlan = buildPostgresItemPageQuery(database, { includeitemtypes: ['Episode'] }, {
    scope: explicitKeys.length ? { seriesPresentationKeys: explicitKeys } : {}, userId, visibility,
  });
  const values = [...eligiblePlan.values];
  const bind = value => { values.push(value); return `$${values.length}`; };
  let seriesOrderSql;
  let user;
  if (explicitKeys.length) {
    const keys = bind(explicitKeys.map(nativeTextBytes));
    user = bind(idKey(guid(userId)));
    seriesOrderSql = `SELECT "Key", (__ordinal - 1)::integer AS __key_order
      FROM unnest(${keys}::bytea[]) WITH ORDINALITY AS requested("Key", __ordinal)`;
  } else {
    const topParents = bind(discoveryParents);
    user = bind(idKey(guid(userId)));
    const cutoff = bind(orderedDate(seriesDiscovery.nextUpDateCutoff));
    const discoveryLimit = seriesDiscovery.limit === undefined ? '' : ` LIMIT ${bind(seriesDiscovery.limit)}`;
    const discoveryPlayedDate = storedDateOrder(database, 'played."LastPlayedDate"');
    const baseItems = qualified(database, 'BaseItems');
    const userData = qualified(database, 'UserData');
    seriesOrderSql = `SELECT discovered."Key",
        (row_number() OVER (ORDER BY discovered.__last_played DESC,
          discovered."Key" ASC) - 1)::integer AS __key_order
      FROM (
        SELECT episode."SeriesPresentationUniqueKey" AS "Key",
          max(${discoveryPlayedDate}) AS __last_played
        FROM ${baseItems} episode
        JOIN ${userData} played ON ${nativeTextSql(database.schemaName).guidLower("played.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("episode.\"Id\"")}
        WHERE episode."Type" <> 'PLACEHOLDER'
          AND substring(${nativeTextSql(database.schemaName).projection("episode.\"Type\"")} from '[^.]+$') = 'Episode'
          AND episode."SeriesPresentationUniqueKey" IS NOT NULL
          AND replace(${nativeTextSql(database.schemaName).guidLower("episode.\"TopParentId\"")}, '-', '') = ANY(${topParents}::text[])
          AND replace(${nativeTextSql(database.schemaName).guidLower("played.\"UserId\"")}, '-', '') = ${user}
          AND played."LastPlayedDate" IS NOT NULL
        GROUP BY episode."SeriesPresentationUniqueKey"
        HAVING max(${discoveryPlayedDate}) >= ${cutoff}
      ) discovered
      ORDER BY discovered.__last_played DESC, discovered."Key" ASC${discoveryLimit}`;
  }
  const includeSpecials = bind(Boolean(displaySpecialsWithinSeasons));
  const includeRewatch = bind(Boolean(enableRewatching));
  // Native's flag means resumable candidates are permitted. When it is false,
  // a selected successor with progress is removed without trying a later one.
  const checkResume = bind(!enableResumable);
  const attachUserData = bind(Boolean(enableUserData));
  let pagination = '';
  if (limit > 0) pagination += ` LIMIT ${bind(limit)}`;
  if (startIndex > 0) pagination += ` OFFSET ${bind(startIndex)}`;

  const baseItems = qualified(database, 'BaseItems');
  const userData = qualified(database, 'UserData');
  const links = qualified(database, 'LinkedChildren');
  const ancestors = qualified(database, 'AncestorIds');
  const providers = qualified(database, 'BaseItemProviders');
  const providerOrdinalKey = expression =>
    `${qualified(database, postgresOrdinalIgnoreCaseKeyFunctionName)}(${expression})`;
  const directPlayed = alias => `(EXISTS (
    SELECT 1 FROM ${userData} direct_data
    WHERE replace(${nativeTextSql(database.schemaName).guidLower("direct_data.\"UserId\"")}, '-', '') = ${user}
      AND ${nativeTextSql(database.schemaName).guidLower("direct_data.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)} AND direct_data."Played" IS TRUE
  ) OR EXISTS (
    SELECT 1 FROM ${links} played_link
    JOIN ${userData} linked_data ON ${nativeTextSql(database.schemaName).guidLower("linked_data.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("played_link.\"ChildId\"")}
    WHERE ${nativeTextSql(database.schemaName).guidLower("played_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)} AND played_link."ChildType" IN (2, 3)
      AND replace(${nativeTextSql(database.schemaName).guidLower("linked_data.\"UserId\"")}, '-', '') = ${user} AND linked_data."Played" IS TRUE
  ))`;
  const candidateAfterNormal = afterLast('candidate', 'previous');
  const candidateAfterRewatch = afterLast('candidate', 'previous');
  const normalOtherBefore = consideredBefore('other', 'candidate');
  const rewatchOtherBefore = consideredBefore('other', 'candidate');
  const rewatchDate = storedDateOrder(database, 'rewatch_data."LastPlayedDate"');
  const lastPreferredDate = storedDateOrder(database, 'last_preferred."LastPlayedDate"');

  const result = await database.client.query({
    text: `WITH series_order AS (
      ${seriesOrderSql}
    ), eligible_plan AS (
      ${eligiblePlan.text}
    ), eligible AS (
      SELECT item.*, series_order.__key_order,
        row_number() OVER (ORDER BY item."SortName" ASC NULLS FIRST, item."Id" ASC) AS __source_order,
        item."ParentIndexNumber" = 0 AS __special,
        ${jsonInteger(database, 'item', 'AirsAfterSeasonNumber')} AS __airs_after_season,
        ${jsonInteger(database, 'item', 'AirsBeforeSeasonNumber')} AS __airs_before_season,
        ${jsonInteger(database, 'item', 'AirsBeforeEpisodeNumber')} AS __airs_before_episode,
        COALESCE(${jsonInteger(database, 'item', 'AirsAfterSeasonNumber')}, ${jsonInteger(database, 'item', 'AirsBeforeSeasonNumber')}) AS __placement_season,
        (COALESCE(${jsonInteger(database, 'item', 'AirsAfterSeasonNumber')}, ${jsonInteger(database, 'item', 'AirsBeforeSeasonNumber')}, 0)::bigint * 1000000000
          + CASE WHEN ${jsonInteger(database, 'item', 'AirsAfterSeasonNumber')} IS NULL THEN 0 ELSE 1000000 END
          + ${int32(`COALESCE(${jsonInteger(database, 'item', 'AirsBeforeEpisodeNumber')}, 0)::bigint * 1000`)}
          + COALESCE(item."IndexNumber", 0))::bigint AS __special_order,
        ${int32(`${int32('COALESCE(item."ParentIndexNumber", -1)::bigint * 1000')} + COALESCE(item."IndexNumber", -1)`)} AS __regular_order,
        ${storedDateOrder(database, 'item."PremiereDate"')} AS __premiere_order
      FROM eligible_plan plan
      JOIN ${baseItems} item ON ${nativeTextSql(database.schemaName).guidLower("item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("plan.\"Id\"")}
      JOIN series_order ON series_order."Key" = item."SeriesPresentationUniqueKey"
      WHERE plan."Id" IS NOT NULL
    ), episode_state AS (
      SELECT eligible.*, ${directPlayed('eligible')} AS __played,
        COALESCE(preferred."Played", FALSE) AS __preferred_played
      FROM eligible
      ${preferredDataJoin(database, 'eligible', 'preferred', user, baseItems, ancestors, providers, userData, providerOrdinalKey)}
    ), regular AS (
      SELECT * FROM episode_state WHERE "ParentIndexNumber" IS DISTINCT FROM 0
    ), last_ranked AS (
      SELECT regular.*, row_number() OVER (
        PARTITION BY "SeriesPresentationUniqueKey"
        ORDER BY "ParentIndexNumber" DESC NULLS LAST, "IndexNumber" DESC NULLS LAST, __source_order ASC
      ) AS __rank
      FROM regular WHERE __played
    ), last_episode AS (
      SELECT *, 1::integer AS __considered_group FROM last_ranked WHERE __rank = 1
    ), next_ranked AS (
      SELECT candidate.*, row_number() OVER (
        PARTITION BY candidate."SeriesPresentationUniqueKey"
        ORDER BY candidate."ParentIndexNumber" ASC NULLS FIRST,
          candidate."IndexNumber" ASC NULLS FIRST, candidate.__source_order ASC
      ) AS __rank
      FROM regular candidate
      LEFT JOIN last_episode previous ON previous."SeriesPresentationUniqueKey" = candidate."SeriesPresentationUniqueKey"
      WHERE candidate."IsVirtualItem" IS NOT TRUE AND candidate.__played IS NOT TRUE
        AND (previous."Id" IS NULL OR previous."ParentIndexNumber" IS NULL OR previous."IndexNumber" IS NULL
          OR candidate."ParentIndexNumber" IS NOT NULL
            AND (candidate."ParentIndexNumber" > previous."ParentIndexNumber"
              OR candidate."ParentIndexNumber" = previous."ParentIndexNumber"
                AND candidate."IndexNumber" IS NOT NULL AND candidate."IndexNumber" > previous."IndexNumber"))
    ), next_episode AS (
      SELECT *, 2::integer AS __considered_group FROM next_ranked WHERE __rank = 1
    ), rewatch_ranked AS (
      SELECT episode."SeriesPresentationUniqueKey", episode."Id", episode.__source_order,
        row_number() OVER (PARTITION BY episode."SeriesPresentationUniqueKey"
          ORDER BY ${rewatchDate} DESC NULLS LAST, episode.__source_order ASC,
            version."Id" ASC, rewatch_data."CustomDataKey" ASC) AS __rank
      FROM regular episode
      JOIN ${baseItems} version ON ${postgresAliasedVersionFamilyKey(database.schemaName, 'version')} = replace(${nativeTextSql(database.schemaName).guidLower("episode.\"Id\"")}, '-', '')
      JOIN ${userData} rewatch_data ON ${nativeTextSql(database.schemaName).guidLower("rewatch_data.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("version.\"Id\"")}
      WHERE ${includeRewatch} AND replace(${nativeTextSql(database.schemaName).guidLower("rewatch_data.\"UserId\"")}, '-', '') = ${user} AND rewatch_data."Played" IS TRUE
    ), rewatch_last AS (
      SELECT episode.*, 1::integer AS __considered_group
      FROM rewatch_ranked ranked
      JOIN regular episode ON ${nativeTextSql(database.schemaName).guidLower("episode.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("ranked.\"Id\"")}
      WHERE ranked.__rank = 1
    ), rewatch_next_ranked AS (
      SELECT candidate.*, row_number() OVER (
        PARTITION BY candidate."SeriesPresentationUniqueKey"
        ORDER BY candidate."ParentIndexNumber" ASC NULLS FIRST,
          candidate."IndexNumber" ASC NULLS FIRST, candidate.__source_order ASC) AS __rank
      FROM regular candidate
      JOIN rewatch_last previous ON previous."SeriesPresentationUniqueKey" = candidate."SeriesPresentationUniqueKey"
      WHERE candidate."IsVirtualItem" IS NOT TRUE AND candidate.__played
        AND (previous."ParentIndexNumber" IS NULL OR previous."IndexNumber" IS NULL
          OR candidate."ParentIndexNumber" IS NOT NULL
            AND (candidate."ParentIndexNumber" > previous."ParentIndexNumber"
              OR candidate."ParentIndexNumber" = previous."ParentIndexNumber"
                AND candidate."IndexNumber" IS NOT NULL AND candidate."IndexNumber" > previous."IndexNumber"))
    ), rewatch_next AS (
      SELECT *, 2::integer AS __considered_group FROM rewatch_next_ranked WHERE __rank = 1
    ), placed_specials AS (
      SELECT episode_state.*, NULL::bigint AS __rank, 0::integer AS __considered_group FROM episode_state
      WHERE ${includeSpecials} AND "ParentIndexNumber" = 0 AND "IsVirtualItem" IS NOT TRUE
        AND (__airs_before_season IS NOT NULL OR __airs_after_season IS NOT NULL)
    ), normal_pool AS (
      SELECT * FROM next_episode UNION ALL SELECT * FROM placed_specials
    ), normal_eligible_pool AS (
      SELECT candidate.* FROM normal_pool candidate
      LEFT JOIN last_episode previous ON previous."SeriesPresentationUniqueKey" = candidate."SeriesPresentationUniqueKey"
      WHERE (NOT EXISTS (SELECT 1 FROM episode_state any_special
          WHERE ${includeSpecials}
            AND any_special."SeriesPresentationUniqueKey" = candidate."SeriesPresentationUniqueKey"
            AND any_special."ParentIndexNumber" = 0 AND any_special."IsVirtualItem" IS NOT TRUE)
          OR ${candidateAfterNormal})
        AND (NOT ${attachUserData} OR candidate.__preferred_played IS NOT TRUE)
    ), normal_choice AS (
      SELECT candidate.* FROM normal_eligible_pool candidate
      WHERE NOT EXISTS (SELECT 1 FROM normal_eligible_pool other
        WHERE other."SeriesPresentationUniqueKey" = candidate."SeriesPresentationUniqueKey"
          AND ${normalOtherBefore})
    ), rewatch_pool AS (
      SELECT * FROM rewatch_next UNION ALL SELECT * FROM placed_specials
    ), rewatch_eligible_pool AS (
      SELECT candidate.* FROM rewatch_pool candidate
      JOIN rewatch_last previous ON previous."SeriesPresentationUniqueKey" = candidate."SeriesPresentationUniqueKey"
      WHERE NOT EXISTS (SELECT 1 FROM episode_state any_special
          WHERE ${includeSpecials}
            AND any_special."SeriesPresentationUniqueKey" = candidate."SeriesPresentationUniqueKey"
            AND any_special."ParentIndexNumber" = 0 AND any_special."IsVirtualItem" IS NOT TRUE)
        OR ${candidateAfterRewatch}
    ), rewatch_choice AS (
      SELECT candidate.* FROM rewatch_eligible_pool candidate
      WHERE NOT EXISTS (SELECT 1 FROM rewatch_eligible_pool other
        WHERE other."SeriesPresentationUniqueKey" = candidate."SeriesPresentationUniqueKey"
          AND ${rewatchOtherBefore})
    ), raw_selections AS (
      SELECT normal."SeriesPresentationUniqueKey", normal.__key_order, 0::integer AS __kind,
        normal."Id" AS "NextId", previous."Id" AS "LastId"
      FROM normal_choice normal
      LEFT JOIN last_episode previous ON previous."SeriesPresentationUniqueKey" = normal."SeriesPresentationUniqueKey"
      UNION ALL
      SELECT rewatch."SeriesPresentationUniqueKey", rewatch.__key_order, 1::integer AS __kind,
        rewatch."Id" AS "NextId", previous."Id" AS "LastId"
      FROM rewatch_choice rewatch
      JOIN rewatch_last previous ON previous."SeriesPresentationUniqueKey" = rewatch."SeriesPresentationUniqueKey"
    ), next_group_versions AS (
      SELECT selection.__key_order, selection.__kind, root.*, 0::bigint AS __version_order
      FROM raw_selections selection JOIN ${baseItems} root ON ${nativeTextSql(database.schemaName).guidLower("root.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("selection.\"NextId\"")}
      UNION ALL
      SELECT selection.__key_order, selection.__kind, child.*,
        1000 + row_number() OVER (PARTITION BY selection.__key_order, selection.__kind
          ORDER BY child."SortName", relation."SortOrder", child."Id") AS __version_order
      FROM raw_selections selection
      JOIN ${links} relation ON ${nativeTextSql(database.schemaName).guidLower("relation.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("selection.\"NextId\"")} AND relation."ChildType" = 3
      JOIN ${baseItems} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("relation.\"ChildId\"")}
      UNION ALL
      SELECT selection.__key_order, selection.__kind, primary_item.*, 100000::bigint AS __version_order
      FROM raw_selections selection JOIN ${baseItems} root ON ${nativeTextSql(database.schemaName).guidLower("root.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("selection.\"NextId\"")}
      JOIN ${baseItems} primary_item ON replace(${nativeTextSql(database.schemaName).guidLower("primary_item.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("root.\"PrimaryVersionId\"")}, '-', '')
      UNION ALL
      SELECT selection.__key_order, selection.__kind, child.*,
        101000 + row_number() OVER (PARTITION BY selection.__key_order, selection.__kind
          ORDER BY child."SortName", relation."SortOrder", child."Id") AS __version_order
      FROM raw_selections selection JOIN ${baseItems} root ON ${nativeTextSql(database.schemaName).guidLower("root.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("selection.\"NextId\"")}
      JOIN ${links} relation ON replace(${nativeTextSql(database.schemaName).guidLower("relation.\"ParentId\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("root.\"PrimaryVersionId\"")}, '-', '') AND relation."ChildType" = 3
      JOIN ${baseItems} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("relation.\"ChildId\"")}
    ), next_versions AS (
      SELECT * FROM next_group_versions
      UNION ALL
      SELECT grouped.__key_order, grouped.__kind, child.*,
        1000000 + grouped.__version_order * 10000 + relation."SortOrder" AS __version_order
      FROM next_group_versions grouped
      JOIN ${links} relation ON ${nativeTextSql(database.schemaName).guidLower("relation.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("grouped.\"Id\"")} AND relation."ChildType" = 2
      JOIN ${baseItems} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("relation.\"ChildId\"")}
    ), next_version_unique AS (
      SELECT * FROM (SELECT version.*, row_number() OVER (
          PARTITION BY __key_order, __kind, ${nativeTextSql(database.schemaName).guidLower("\"Id\"")} ORDER BY __version_order) AS __duplicate_rank
        FROM next_versions version
        WHERE substring(${nativeTextSql(database.schemaName).projection("version.\"Type\"")} from '[^.]+$') IN ('Movie', 'Video', 'Episode', 'MusicVideo', 'Trailer')
      ) ranked WHERE __duplicate_rank = 1
    ), next_resume AS (
      SELECT version.__key_order, version.__kind, version."Id", preferred."PlaybackPositionTicks"
      FROM next_version_unique version
      ${preferredDataJoin(database, 'version', 'preferred', user, baseItems, ancestors, providers, userData, providerOrdinalKey)}
    ), selections AS (
      SELECT selection.* FROM raw_selections selection
      WHERE selection.__kind = 1 OR NOT ${checkResume} OR NOT EXISTS (
        SELECT 1 FROM next_resume resume
        WHERE resume.__key_order = selection.__key_order AND resume.__kind = selection.__kind
          AND (${attachUserData} OR ${nativeTextSql(database.schemaName).guidLower("resume.\"Id\"")} <> ${nativeTextSql(database.schemaName).guidLower("selection.\"NextId\"")})
          AND COALESCE(resume."PlaybackPositionTicks", 0) > 0)
    ), last_group_versions AS (
      SELECT selection.__key_order, selection.__kind, root.*, 0::bigint AS __version_order
      FROM selections selection JOIN ${baseItems} root ON ${nativeTextSql(database.schemaName).guidLower("root.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("selection.\"LastId\"")}
      UNION ALL
      SELECT selection.__key_order, selection.__kind, child.*,
        1000 + row_number() OVER (PARTITION BY selection.__key_order, selection.__kind
          ORDER BY child."SortName", relation."SortOrder", child."Id") AS __version_order
      FROM selections selection
      JOIN ${links} relation ON ${nativeTextSql(database.schemaName).guidLower("relation.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("selection.\"LastId\"")} AND relation."ChildType" = 3
      JOIN ${baseItems} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("relation.\"ChildId\"")}
      UNION ALL
      SELECT selection.__key_order, selection.__kind, primary_item.*, 100000::bigint AS __version_order
      FROM selections selection JOIN ${baseItems} root ON ${nativeTextSql(database.schemaName).guidLower("root.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("selection.\"LastId\"")}
      JOIN ${baseItems} primary_item ON replace(${nativeTextSql(database.schemaName).guidLower("primary_item.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("root.\"PrimaryVersionId\"")}, '-', '')
      UNION ALL
      SELECT selection.__key_order, selection.__kind, child.*,
        101000 + row_number() OVER (PARTITION BY selection.__key_order, selection.__kind
          ORDER BY child."SortName", relation."SortOrder", child."Id") AS __version_order
      FROM selections selection JOIN ${baseItems} root ON ${nativeTextSql(database.schemaName).guidLower("root.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("selection.\"LastId\"")}
      JOIN ${links} relation ON replace(${nativeTextSql(database.schemaName).guidLower("relation.\"ParentId\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("root.\"PrimaryVersionId\"")}, '-', '') AND relation."ChildType" = 3
      JOIN ${baseItems} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("relation.\"ChildId\"")}
    ), last_versions AS (
      SELECT * FROM last_group_versions
      UNION ALL
      SELECT grouped.__key_order, grouped.__kind, child.*,
        1000000 + grouped.__version_order * 10000 + relation."SortOrder" AS __version_order
      FROM last_group_versions grouped
      JOIN ${links} relation ON ${nativeTextSql(database.schemaName).guidLower("relation.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("grouped.\"Id\"")} AND relation."ChildType" = 2
      JOIN ${baseItems} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("relation.\"ChildId\"")}
    ), last_version_unique AS (
      SELECT * FROM (SELECT version.*, row_number() OVER (
          PARTITION BY __key_order, __kind, ${nativeTextSql(database.schemaName).guidLower("\"Id\"")} ORDER BY __version_order) AS __duplicate_rank
        FROM last_versions version
        WHERE substring(${nativeTextSql(database.schemaName).projection("version.\"Type\"")} from '[^.]+$') IN ('Movie', 'Video', 'Episode', 'MusicVideo', 'Trailer')
      ) ranked WHERE __duplicate_rank = 1
    ), last_version_dates AS (
      SELECT version.*, last_preferred."LastPlayedDate", ${lastPreferredDate} AS __played_date,
        row_number() OVER (PARTITION BY version.__key_order, version.__kind
          ORDER BY ${lastPreferredDate} DESC NULLS LAST, version.__version_order) AS __date_rank
      FROM last_version_unique version
      ${preferredDataJoin(database, 'version', 'last_preferred', user, baseItems, ancestors, providers, userData, providerOrdinalKey)}
      WHERE last_preferred."LastPlayedDate" IS NOT NULL
    ), most_recent_version AS (
      SELECT * FROM last_version_dates WHERE __date_rank = 1
    ), ordered AS (
      SELECT selection.*, played."Id" AS "PlayedVersionId", played.__played_date,
        row_number() OVER (ORDER BY
          CASE WHEN selection."LastId" IS NULL THEN 0 WHEN played."Id" IS NULL THEN 1 ELSE 2 END DESC,
          played.__played_date DESC NULLS LAST, selection.__key_order ASC, selection.__kind ASC) AS __ordinal
      FROM selections selection LEFT JOIN most_recent_version played
        ON played.__key_order = selection.__key_order AND played.__kind = selection.__kind
    ), page AS (
      SELECT * FROM ordered ORDER BY __ordinal${pagination}
    ), total AS (
      SELECT count(*)::bigint AS "TotalRecordCount" FROM selections
    )
    SELECT page."NextId", page."LastId", page."PlayedVersionId", page.__ordinal AS "Ordinal",
      total."TotalRecordCount"
    FROM total LEFT JOIN page ON TRUE ORDER BY page.__ordinal NULLS LAST`,
    values,
  });

  const entries = result.rows.filter(row => row.NextId !== null).map(row => ({
    nextId: decodeNativeTextBytes(row.NextId), lastId: row.LastId == null ? null : decodeNativeTextBytes(row.LastId), playedVersionId: row.PlayedVersionId == null ? null : decodeNativeTextBytes(row.PlayedVersionId),
    ordinal: safeNonnegativeInteger(row.Ordinal, 'Next Up ordinal'),
  }));
  const total = enableTotalRecordCount && result.rows.length
    ? safeNonnegativeInteger(result.rows[0].TotalRecordCount, 'Next Up count') : 0;
  const preferredIds = await queryPostgresPreferredNextUpIds(database, entries);
  const rows = preferredIds.length ? await database.rows('BaseItems', { whereIn: { Id: preferredIds } }) : [];
  const byId = new Map(rows.map(row => [idKey(row.Id), row]));
  return {
    rows: preferredIds.map(id => byId.get(idKey(id))).filter(Boolean), entries,
    total,
    startIndex, plan: eligiblePlan,
  };
}

async function queryPostgresPreferredNextUpIds(database, entries) {
  if (!entries.length) return [];
  const baseItems = qualified(database, 'BaseItems');
  const links = qualified(database, 'LinkedChildren');
  const streams = qualified(database, 'MediaStreamInfos');
  const invariantUpper = expression => nativeTextSql(database.schemaName).invariantCharUpper(nativeTextSql(database.schemaName).fromProjection(expression));
  const nativeEnum = (expression, kind) =>
    `${qualified(database, postgresNativeJsonEnumFunctionName)}(${expression}, '${kind}')`;
  const ordinalKey = expression => `${qualified(database, postgresOrdinalIgnoreCaseKeyFunctionName)}(${expression})`;
  const asciiLower = expression => nativeTextSql(database.schemaName).projection(nativeTextSql(database.schemaName).sqliteAsciiLowerKey(nativeTextSql(database.schemaName).fromProjection(expression)));
  const textValue = value => value == null ? null : nativeTextBytes(value);
  const values = [entries.map(entry => entry.ordinal), entries.map(entry => textValue(entry.nextId)),
    entries.map(entry => textValue(entry.lastId)), entries.map(entry => textValue(entry.playedVersionId)), ecmaWhitespaceCharacters];
  const ecmaTrimCharacters = '$5';
  const sourceSuffix = `regexp_replace(array_to_string(source.__stem_tokens[prefix.__prefix_length + 1:], ''), '^[ _.-]+', '')`;
  const sourceLabel = `concat_ws('/', CASE WHEN source.__stem IS NULL THEN source.__source_name
      WHEN prefix.__prefix_length > 0
        AND btrim(${sourceSuffix}, ${ecmaTrimCharacters}) <> ''
        THEN ${sourceSuffix}
      ELSE source.__stem END,
    CASE WHEN ${nativeEnum("source.__source_data -> 'Video3DFormat'", 'Video3DFormat')} IS NOT NULL THEN '3D' END,
    CASE WHEN ${nativeEnum("source.__source_data -> 'VideoType'", 'VideoType')} = 'BluRay'
        OR ${nativeEnum("source.__source_data -> 'VideoType'", 'VideoType')} = 'Iso'
          AND ${nativeEnum("source.__source_data -> 'IsoType'", 'IsoType')} = 'BluRay' THEN 'Bluray'
      WHEN ${nativeEnum("source.__source_data -> 'VideoType'", 'VideoType')} = 'Dvd'
        OR ${nativeEnum("source.__source_data -> 'VideoType'", 'VideoType')} = 'Iso'
          AND ${nativeEnum("source.__source_data -> 'IsoType'", 'IsoType')} = 'Dvd' THEN 'DVD'
      WHEN ${nativeEnum("source.__source_data -> 'VideoType'", 'VideoType')} = 'Iso'
        AND ${nativeEnum("source.__source_data -> 'IsoType'", 'IsoType')} IS NULL THEN 'ISO' END)`;
  const result = await database.client.query({
    text: `WITH requests AS (
      SELECT * FROM unnest($1::bigint[], $2::bytea[], $3::bytea[], $4::bytea[])
        AS request(__ordinal, "NextId", "LastId", "PlayedVersionId")
    ), roots AS (
      SELECT request.*, 'next'::text AS __role, next_item.* FROM requests request
      JOIN ${baseItems} next_item ON ${nativeTextSql(database.schemaName).guidLower("next_item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("request.\"NextId\"")}
      UNION ALL
      SELECT request.*, 'last'::text AS __role, last_item.* FROM requests request
      JOIN ${baseItems} last_item ON ${nativeTextSql(database.schemaName).guidLower("last_item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("request.\"LastId\"")}
    ), group_sources AS (
      SELECT root.*, root."Id" AS __source_id, 0::bigint AS __source_order FROM roots root
      UNION ALL
      SELECT root.*, child."Id" AS __source_id,
        1000 + row_number() OVER (PARTITION BY root.__ordinal, root.__role
          ORDER BY child."SortName", relation."SortOrder", child."Id") AS __source_order
      FROM roots root JOIN ${links} relation ON ${nativeTextSql(database.schemaName).guidLower("relation.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("root.\"Id\"")} AND relation."ChildType" = 3
      JOIN ${baseItems} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("relation.\"ChildId\"")}
      UNION ALL
      SELECT root.*, primary_item."Id" AS __source_id, 100000::bigint AS __source_order
      FROM roots root JOIN ${baseItems} primary_item ON replace(${nativeTextSql(database.schemaName).guidLower("primary_item.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("root.\"PrimaryVersionId\"")}, '-', '')
      UNION ALL
      SELECT root.*, child."Id" AS __source_id,
        101000 + row_number() OVER (PARTITION BY root.__ordinal, root.__role
          ORDER BY child."SortName", relation."SortOrder", child."Id") AS __source_order
      FROM roots root JOIN ${links} relation ON replace(${nativeTextSql(database.schemaName).guidLower("relation.\"ParentId\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("root.\"PrimaryVersionId\"")}, '-', '') AND relation."ChildType" = 3
      JOIN ${baseItems} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("relation.\"ChildId\"")}
    ), source_ids AS (
      SELECT __ordinal, __role, "NextId", "LastId", "PlayedVersionId", "Id" AS "RootId",
        __source_id, __source_order FROM group_sources
      UNION ALL
      SELECT grouped.__ordinal, grouped.__role, grouped."NextId", grouped."LastId", grouped."PlayedVersionId",
        grouped."Id" AS "RootId", child."Id" AS __source_id,
        1000000 + grouped.__source_order * 10000 + relation."SortOrder" AS __source_order
      FROM group_sources grouped
      JOIN ${links} relation ON ${nativeTextSql(database.schemaName).guidLower("relation.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("grouped.__source_id")} AND relation."ChildType" = 2
      JOIN ${baseItems} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("relation.\"ChildId\"")}
    ), source_unique AS (
      SELECT * FROM (SELECT source_ids.*, ${nativeTextSql(database.schemaName).projection('source_item."Name"')} AS __source_name,
          ${nativeTextSql(database.schemaName).projection('source_item."Path"')} AS __source_path,
          ${qualified(database, postgresSafeNativeItemDataFunctionName)}(source_item."Type", source_item."Data") AS __source_data,
          row_number() OVER (PARTITION BY source_ids.__ordinal, source_ids.__role, ${nativeTextSql(database.schemaName).guidLower("source_ids.__source_id")}
            ORDER BY source_ids.__source_order) AS __duplicate_rank
        FROM source_ids JOIN ${baseItems} source_item ON ${nativeTextSql(database.schemaName).guidLower("source_item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("source_ids.__source_id")}
        WHERE substring(${nativeTextSql(database.schemaName).projection("source_item.\"Type\"")} from '[^.]+$') IN ('Movie', 'Video', 'Episode', 'MusicVideo', 'Trailer')
      ) ranked WHERE __duplicate_rank = 1
    ), file_stems AS (
      SELECT source.*, CASE WHEN source.__source_path IS NOT NULL
          AND ${asciiLower('source.__source_path')} !~ '^(rtsp|rtmp|http|rtp|ftp|udp)'
          AND ${asciiLower('source.__source_path')} !~ '^[a-z][a-z0-9+.-]*://'
        THEN regexp_replace(regexp_replace(source.__source_path, '^.*[\\\\/]', ''), '\\.[^.]*$', '')
        ELSE NULL END AS __stem
      FROM source_unique source
    ), tokenized_stems AS (
      SELECT file_stems.*, ARRAY(SELECT token[1]
        FROM regexp_matches(__stem, E'\\x01[01]|[^\\x01]', 'g') token) AS __stem_tokens
      FROM file_stems
    ), stem_summary AS (
      SELECT __ordinal, __role, count(__stem)::integer AS __stem_count,
        (min(cardinality(__stem_tokens)) FILTER (WHERE __stem IS NOT NULL))::integer AS __minimum_length,
        (array_agg(__stem ORDER BY __source_order) FILTER (WHERE __stem IS NOT NULL))[1] AS __first_stem,
        (SELECT first.__stem_tokens FROM tokenized_stems first
          WHERE first.__ordinal = tokenized_stems.__ordinal AND first.__role = tokenized_stems.__role
            AND first.__stem IS NOT NULL ORDER BY first.__source_order LIMIT 1) AS __first_stem_tokens
      FROM tokenized_stems GROUP BY __ordinal, __role
    ), common_positions AS (
      SELECT summary.__ordinal, summary.__role, position
      FROM stem_summary summary
      CROSS JOIN LATERAL generate_series(0, COALESCE(summary.__minimum_length, 0)) position
      WHERE summary.__stem_count > 1 AND NOT EXISTS (SELECT 1 FROM tokenized_stems candidate
        WHERE candidate.__ordinal = summary.__ordinal AND candidate.__role = summary.__role
          AND candidate.__stem IS NOT NULL
          AND ${invariantUpper("array_to_string(candidate.__stem_tokens[1:position], '')")}
            <> ${invariantUpper("array_to_string(summary.__first_stem_tokens[1:position], '')")})
    ), raw_prefix AS (
      SELECT summary.*, COALESCE(max(common.position), 0)::integer AS __raw_length
      FROM stem_summary summary LEFT JOIN common_positions common
        ON common.__ordinal = summary.__ordinal AND common.__role = summary.__role
      GROUP BY summary.__ordinal, summary.__role, summary.__stem_count,
        summary.__minimum_length, summary.__first_stem, summary.__first_stem_tokens
    ), prefix_cut AS MATERIALIZED (
      SELECT prefix.*, CASE WHEN prefix.__stem_count <= 1 THEN 0
          WHEN EXISTS (SELECT 1 FROM tokenized_stems exact
            WHERE exact.__ordinal = prefix.__ordinal AND exact.__role = prefix.__role
              AND cardinality(exact.__stem_tokens) = prefix.__raw_length) THEN prefix.__raw_length
          ELSE COALESCE((SELECT max(position) FROM generate_series(1, prefix.__raw_length) position
              WHERE prefix.__first_stem_tokens[position] IN ('-', '_', '.')),
            (SELECT max(position) FROM generate_series(1, prefix.__raw_length) position
              WHERE prefix.__first_stem_tokens[position] = ' '), 0)
        END::integer AS __prefix_length
      FROM raw_prefix prefix
    ), source_labels AS (
      SELECT source.*,
        ${ordinalKey(sourceLabel)} AS __label,
        EXISTS (SELECT 1 FROM ${streams} video_stream
          WHERE ${nativeTextSql(database.schemaName).guidLower("video_stream.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("source.__source_id")} AND video_stream."StreamType" = 1) AS __has_video_stream,
        COALESCE((SELECT max(video_stream."Width") FROM ${streams} video_stream
          WHERE ${nativeTextSql(database.schemaName).guidLower("video_stream.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("source.__source_id")} AND video_stream."StreamType" = 1), 0) AS __video_width
      FROM tokenized_stems source JOIN prefix_cut prefix
        ON prefix.__ordinal = source.__ordinal AND prefix.__role = source.__role
    ), played_labels AS (
      SELECT request.__ordinal, played.__label, played.__source_path
      FROM requests request JOIN source_labels played
        ON played.__ordinal = request.__ordinal AND played.__role = 'last'
          AND ${nativeTextSql(database.schemaName).guidLower("played.__source_id")} = ${nativeTextSql(database.schemaName).guidLower("request.\"PlayedVersionId\"")}
      JOIN ${baseItems} played_item ON ${nativeTextSql(database.schemaName).guidLower("played_item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("request.\"PlayedVersionId\"")}
      WHERE played_item."PrimaryVersionId" IS NOT NULL
    ), matching_candidates AS (
      SELECT candidate.*, played.__source_path AS __played_source_path,
        count(*) OVER (PARTITION BY candidate.__ordinal, candidate.__label,
          ${ordinalKey('candidate.__source_path')}) AS __same_path_count
      FROM source_labels candidate JOIN played_labels played
        ON played.__ordinal = candidate.__ordinal AND played.__label = candidate.__label
      WHERE candidate.__role = 'next'
    ), matching AS (
      SELECT candidate.__ordinal, candidate.__source_id,
        row_number() OVER (PARTITION BY candidate.__ordinal ORDER BY
          (${nativeTextSql(database.schemaName).guidLower("candidate.__source_id")} = ${nativeTextSql(database.schemaName).guidLower("candidate.\"RootId\"")}) DESC,
          (COALESCE(${nativeEnum("candidate.__source_data -> 'VideoType'", 'VideoType')}, 'VideoFile') = 'VideoFile') DESC,
          (${nativeEnum("candidate.__source_data -> 'Video3DFormat'", 'Video3DFormat')} IS NOT NULL) ASC,
          CASE WHEN candidate.__same_path_count > 1
            THEN candidate.__has_video_stream::integer ELSE 0 END DESC,
          CASE WHEN candidate.__same_path_count > 1
            THEN candidate.__video_width ELSE 0 END DESC, candidate.__source_order) AS __match_rank
      FROM matching_candidates candidate
    )
    SELECT request.__ordinal, COALESCE(match.__source_id, request."NextId") AS "Id"
    FROM requests request LEFT JOIN matching match
      ON match.__ordinal = request.__ordinal AND match.__match_rank = 1
    ORDER BY request.__ordinal`, values,
  });
  return result.rows.map(row => row.Id == null ? null : decodeNativeTextBytes(row.Id)).filter(nonemptyId);
}
