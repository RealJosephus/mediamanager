import { decodeNativeTextBytes, nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { quoteIdentifier as q } from '../database/model.js';
import { buildPostgresItemPageQuery, queryPostgresItemPage } from '../database/postgres-item-query.js';
import { postgresOrdinalIgnoreCaseKeyFunctionName } from '../database/postgres-runtime-schema.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { guid, idKey } from './records.js';
import { calculateSimilarScore } from './similar-items.js';

function table(database, name) {
  if (database?.dialect !== 'postgres') throw new TypeError('A PostgreSQL database is required.');
  return `${q(database.schemaName)}.${q(name)}`;
}

function ordinalKey(database, expression) {
  return `${q(database.schemaName)}.${q(postgresOrdinalIgnoreCaseKeyFunctionName)}(${expression})`;
}

function uniqueIds(ids) {
  return [...new Map((ids ?? []).filter(value => value != null && String(value) !== '')
    .map(value => [idKey(value), guid(value)])).values()];
}

/** Translate the native unweighted providers' bounded query contract. */
export function localGenreTagSimilarQuery(item, query = {}, { enableExternalContent = true } = {}) {
  const program = item.Type === 'LiveTvProgram';
  const movie = program && item.IsMovie;
  const requestedLimit = query.limit ?? 50;
  const includeItemTypes = movie ? enableExternalContent ? ['Movie', 'Trailer', 'LiveTvProgram'] : ['Movie']
    : program ? item.IsSeries ? ['Series'] : ['Program'] : [item.Type];
  return {
    includeItemTypes,
    genres: item.Genres ?? [],
    tags: item.Tags ?? [],
    excludeItemIds: query.excludeItemIds ?? [],
    excludeArtistIds: ['Series', 'LiveTvProgram'].includes(item.Type) ? [] : query.excludeArtistIds ?? [],
    limit: movie ? Math.max(0, (requestedLimit + 4) | 0) : Math.max(0, requestedLimit),
    // The pin's GetBaseItemKind is Program, which ItemTypeLookup does not map.
    // Its empty WhereOneOrMany type set matches nothing, not all TV programs.
    matchNoItems: program && !item.IsMovie && !item.IsSeries,
  };
}

/**
 * Execute Jellyfin's local genre/tag similar-items provider entirely in
 * PostgreSQL. The returned rows are bounded by the provider's requested limit;
 * no catalogue rows are materialised by the application process.
 */
export async function queryPostgresLocalSimilarRows(database, {
  itemType,
  includeItemTypes = itemType ? [itemType] : [],
  genres = [],
  tags = [],
  excludeItemIds = [],
  excludeArtistIds = [],
  limit,
  userId,
  visibility,
  nameAccessTypes = [],
  groupByPresentationKey = false,
  matchNoItems = false,
  signal,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('Similar-items limit must be a non-negative integer.');
  if (!includeItemTypes.length) throw new TypeError('Similar-items types are required.');
  if (matchNoItems) return [];
  const page = await queryPostgresItemPage(database, {
    includeitemtypes: includeItemTypes,
    genres,
    tags,
    excludeitemids: uniqueIds(excludeItemIds),
    excludeartistids: uniqueIds(excludeArtistIds),
    sortby: ['Random'],
    sortorder: ['Ascending'],
    limit,
  }, {
    userId,
    visibility,
    nameAccessTypes,
    requireRelatedNameAccess: nameAccessTypes.length > 0,
    groupByPresentationKey,
    signal,
  });
  return page.rows;
}

/**
 * Movie/Trailer weighting, pre-access shortlist, access filtering, exact-key
 * deduplication and paging remain relational. Only the final page is decoded.
 * Each source key is distinct, while duplicate matching candidate map rows
 * intentionally contribute repeatedly, as in MovieSimilarItemsProvider.
 */
export async function queryPostgresMovieSimilarRows(database, {
  sourceId,
  excludeItemIds = [],
  enableExternalContent = true,
  limit = 50,
  userId,
  visibility,
  signal,
} = {}) {
  if (!Number.isInteger(limit) || limit < 0 || limit > 2_147_483_647) {
    throw new TypeError('Movie similar-items limit must be a non-negative Int32.');
  }
  const source = guid(sourceId);
  // LINQ Take receives the unchecked native Int32 multiplication.
  const candidateLimit = Math.max(0, Math.imul(limit, 3));
  if (!candidateLimit || !limit) return [];
  const baseItems = table(database, 'BaseItems');
  const maps = table(database, 'ItemValuesMap');
  const itemValues = table(database, 'ItemValues');
  const people = table(database, 'Peoples');
  const peopleMaps = table(database, 'PeopleBaseItemMap');
  const valueOrder = `${q(database.controlSchema)}.${q('item_value_order')}`;
  const accessPlan = buildPostgresItemPageQuery(database, {
    includeitemtypes: enableExternalContent ? ['Movie', 'Trailer', 'LiveTvProgram'] : ['Movie'],
    excludeitemids: uniqueIds(excludeItemIds),
    ismovie: true,
    isplayed: false,
  }, {
    itemIdsPlan: { text: 'SELECT "Id" FROM similar_shortlist', values: [] },
    userId,
    visibility,
    // The provider applies TranslateQuery, not the repository's usual grouping.
    groupByPresentationKey: false,
  });
  const offset = 3;
  const accessText = accessPlan.text.replace(/\$(\d+)/gu,
    (_match, ordinal) => `$${Number(ordinal) + offset}`);
  const hiddenVersion = `NOT EXISTS (SELECT 1 FROM ${baseItems} alternate
    JOIN ${baseItems} primary_item ON ${nativeTextSql(database.schemaName).guidLower("primary_item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("alternate.\"PrimaryVersionId\"")}
      AND ${nativeTextSql(database.schemaName).guidLower("primary_item.\"TopParentId\"")} IS NOT DISTINCT FROM ${nativeTextSql(database.schemaName).guidLower("alternate.\"TopParentId\"")}
    WHERE ${nativeTextSql(database.schemaName).guidLower("alternate.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("candidate_map.\"ItemId\"")}
      AND alternate."PrimaryVersionId" IS NOT NULL)`;
  // The pinned native access lookup uses IX_BaseItems_Type_TopParentId_Id
  // for a parent-constrained query and the Id key otherwise. Its subsequent
  // score sort is stable; preserve that observed order for equal scores.
  const accessTieOrder = visibility?.topParentIds?.length
    ? 'item."Type", item."TopParentId", item."Id"'
    : 'item."Id"';
  const scoreCtes = `/* movie-similar-weighted-page */
      WITH source_values AS (
        SELECT DISTINCT ON (value."Type", value."CleanValue")
          value."Type", value."CleanValue" AS "CleanValue", value."Value" AS "KeyOrder"
        FROM ${maps} source_map
        JOIN ${itemValues} value ON ${nativeTextSql(database.schemaName).guidLower("value.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("source_map.\"ItemValueId\"")}
        WHERE ${nativeTextSql(database.schemaName).guidLower("source_map.\"ItemId\"")} = $1 AND value."Type" IN (2, 4, 3)
        ORDER BY value."Type", value."CleanValue", value."Value" ASC NULLS LAST
      ), ordered_values AS (
        SELECT source_values.*, row_number() OVER (PARTITION BY "Type" ORDER BY "KeyOrder") AS "KeyPosition"
        FROM source_values
      ), source_people AS (
        SELECT DISTINCT ${nativeTextSql(database.schemaName).guidLower("source_map.\"PeopleId\"")} AS "PeopleId",
          CASE ${nativeTextSql(database.schemaName).projection('person."PersonType"')} WHEN 'Director' THEN 50 ELSE 15 END AS "Weight"
        FROM ${peopleMaps} source_map
        JOIN ${people} person ON ${nativeTextSql(database.schemaName).guidLower("person.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("source_map.\"PeopleId\"")}
        WHERE ${nativeTextSql(database.schemaName).guidLower("source_map.\"ItemId\"")} = $1
          AND ${nativeTextSql(database.schemaName).projection('person."PersonType"')} COLLATE "C" IN ('Director', 'Actor', 'GuestStar')
      ), ordered_people AS (
        SELECT source_people.*, min("PeopleId" COLLATE "C") OVER (PARTITION BY "Weight") AS "WeightOrder"
        FROM source_people
      ), dimension_matches AS (
        SELECT ${nativeTextSql(database.schemaName).guidLower("candidate_map.\"ItemId\"")} AS "Id",
          CASE source_value."Type" WHEN 2 THEN 10 ELSE 5 END AS "Weight",
          (CASE source_value."Type" WHEN 2 THEN '0/' WHEN 4 THEN '1/' ELSE '2/' END
            || lpad(source_value."KeyPosition"::text, 20, '0') || '/'
            || lpad(value_sequence.position::text, 20, '0') || '/' || ${nativeTextSql(database.schemaName).guidLower("candidate_map.\"ItemId\"")}) AS "EntryOrder"
        FROM ordered_values source_value
        JOIN ${itemValues} value ON value."Type" = source_value."Type"
          AND value."CleanValue" = source_value."CleanValue"
        JOIN ${valueOrder} value_sequence ON value_sequence.value_id = value."ItemValueId"
        JOIN ${maps} candidate_map ON ${nativeTextSql(database.schemaName).guidLower("candidate_map.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("value.\"ItemValueId\"")}
        WHERE ${nativeTextSql(database.schemaName).guidLower("candidate_map.\"ItemId\"")} <> $1 AND ${hiddenVersion}
        UNION ALL
        SELECT ${nativeTextSql(database.schemaName).guidLower("candidate_map.\"ItemId\"")}, source_person."Weight",
          '3/' || source_person."WeightOrder" || '/' || source_person."PeopleId" || '/' || ${nativeTextSql(database.schemaName).guidLower("candidate_map.\"ItemId\"")}
        FROM ordered_people source_person
        JOIN ${peopleMaps} candidate_map ON ${nativeTextSql(database.schemaName).guidLower("candidate_map.\"PeopleId\"")} = source_person."PeopleId"
        WHERE ${nativeTextSql(database.schemaName).guidLower("candidate_map.\"ItemId\"")} <> $1 AND ${hiddenVersion}
      ), similar_scores AS (
        SELECT "Id", sum("Weight") AS "Score", min("EntryOrder" COLLATE "C") AS "FirstEntry"
        FROM dimension_matches GROUP BY "Id"
      ), similar_shortlist AS MATERIALIZED (
        SELECT "Id", "Score" FROM similar_scores
        ORDER BY "Score" DESC, "FirstEntry" COLLATE "C" LIMIT $2
      )`;
  if (!userId) {
    // A null user only throws after scoring produced a shortlist. Do not
    // confuse a source-only relation with an actual comparison candidate.
    const candidates = await database.client.query({
      text: `${scoreCtes} SELECT EXISTS (SELECT 1 FROM similar_shortlist) AS "HasCandidates"`,
      values: [source, candidateLimit], signal,
    });
    if (candidates.rows[0]?.HasCandidates) throw new TypeError('Movie similar-items IsPlayed filtering requires a user.');
    return [];
  }
  const result = await database.client.query({
    text: `${scoreCtes}, accessible AS (
        ${accessText}
      ), ranked AS (
        SELECT item."Id", shortlist."Score", item."PrimaryVersionId" IS NOT NULL AS "Alternate",
          row_number() OVER (ORDER BY ${accessTieOrder}) AS "AccessOrdinal",
          row_number() OVER (PARTITION BY item."PresentationUniqueKey"
            ORDER BY shortlist."Score" DESC, item."PrimaryVersionId" IS NOT NULL, ${accessTieOrder}) AS "KeyRank"
        FROM accessible
        JOIN ${baseItems} item ON ${nativeTextSql(database.schemaName).guidLower("item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("accessible.\"Id\"")}
        JOIN similar_shortlist shortlist ON shortlist."Id" = ${nativeTextSql(database.schemaName).guidLower("item.\"Id\"")}
      )
      SELECT "Id" FROM ranked WHERE "KeyRank" = 1
      ORDER BY "Score" DESC, "Alternate", "AccessOrdinal" LIMIT $3`,
    values: [source, candidateLimit, limit, ...accessPlan.values],
    signal,
  });
  const ids = result.rows.map(row => decodeNativeTextBytes(row.Id));
  const rows = ids.length ? await database.rows('BaseItems', { whereIn: { Id: ids } }) : [];
  const byId = new Map(rows.map(row => [idKey(row.Id), row]));
  return ids.map(id => byId.get(idKey(id))).filter(Boolean);
}

async function filterPostgresSimilarRows(database, ids, {
  userId,
  visibility,
  nameAccessTypes = [],
  includeOwnedItems,
  includeAlternateVersions,
  signal,
} = {}) {
  const requested = uniqueIds(ids);
  if (!requested.length) return [];
  const page = await queryPostgresItemPage(database, { limit: requested.length }, {
    scope: { ids: requested },
    userId,
    visibility,
    nameAccessTypes,
    requireRelatedNameAccess: nameAccessTypes.length > 0,
    includeOwnedItems,
    includeAlternateVersions,
    signal,
  });
  const selected = new Map(page.rows.map(row => [idKey(row.Id), row]));
  return requested.map(id => selected.get(idKey(id))).filter(Boolean);
}

/**
 * Resolve a bounded remote-provider reference batch through
 * BaseItemProviders. Access policy is evaluated in PostgreSQL, while owned and
 * alternate rows are intentionally retained until SimilarItemsManager's final
 * access-filter boundary.
 */
export async function resolvePostgresRemoteSimilarRows(database, {
  itemType,
  references = [],
  referencePositions,
  providerOrderIndex = 10,
  limit,
  after,
  userId,
  visibility,
  nameAccessTypes = [],
  signal,
} = {}) {
  if (!itemType) throw new TypeError('Similar-items type is required.');
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError('Remote similar-items page limit must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(providerOrderIndex) || providerOrderIndex < 0) {
    throw new TypeError('Remote similar-items provider order must be a non-negative integer.');
  }
  if (after != null && (!after || !Number.isSafeInteger(after.ordinal) || after.ordinal < 1
    || typeof after.id !== 'string' || !after.id)) {
    throw new TypeError('Remote similar-items cursor must contain a positive ordinal and item id.');
  }
  const values = references.filter(reference => reference
    && typeof reference.ProviderName === 'string' && typeof reference.ProviderId === 'string');
  if (!values.length || limit === 0) return { rows: [], nextCursor: null };
  const positions = referencePositions ?? values.map((_reference, index) => index);
  if (!Array.isArray(positions) || positions.length !== values.length
    || positions.some(position => !Number.isSafeInteger(position) || position < 0)) {
    throw new TypeError('Remote similar-items reference positions must match the reference page.');
  }
  const providerOrders = new Map();
  const providerOrder = values.map(reference => {
    const key = ordinalIgnoreCaseKey(reference.ProviderName);
    if (!providerOrders.has(key)) providerOrders.set(key, providerOrders.size);
    return providerOrders.get(key);
  });
  const priorities = Array(values.length);
  values.map((reference, index) => ({
    index,
    position: positions[index],
    score: calculateSimilarScore(reference.Score, providerOrderIndex, positions[index]),
  })).sort((left, right) => right.score - left.score || left.position - right.position || left.index - right.index)
    .forEach((entry, index) => { priorities[entry.index] = index + 1; });
  const result = await database.client.query({
    text: `WITH reference("ProviderName", "ProviderValue", "ProviderOrder", "Position", "Priority") AS (
      SELECT * FROM unnest($1::bytea[], $2::bytea[], $3::integer[], $4::integer[], $5::integer[])
    ), matched AS (
      SELECT item."Id", reference."Priority",
        row_number() OVER (PARTITION BY item."Id"
          ORDER BY reference."ProviderOrder", reference."Position", reference."Priority") AS "MatchRank"
      FROM reference
      JOIN ${table(database, 'BaseItemProviders')} provider
        ON ${ordinalKey(database, 'provider."ProviderId"')}
          = ${ordinalKey(database, 'reference."ProviderName"')}
        AND ${ordinalKey(database, 'provider."ProviderValue"')}
          = ${ordinalKey(database, 'reference."ProviderValue"')}
      JOIN ${table(database, 'BaseItems')} item ON ${nativeTextSql(database.schemaName).guidLower("item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("provider.\"ItemId\"")}
      WHERE substring(${nativeTextSql(database.schemaName).projection("item.\"Type\"")} from '[^.]+$') = $6
        AND ${nativeTextSql(database.schemaName).projection('item."Type"')} <> 'PLACEHOLDER'
    ), chosen AS (
      SELECT "Id", "Priority" FROM matched WHERE "MatchRank" = 1
    )
    SELECT "Id", "Priority" AS "Ordinal"
    FROM chosen
    WHERE $7::integer IS NULL OR ("Priority", "Id") > ($7::integer, $8::bytea)
    ORDER BY "Priority", "Id"
    LIMIT $9`,
    values: [values.map(reference => nativeTextBytes(reference.ProviderName)),
      values.map(reference => nativeTextBytes(reference.ProviderId)), providerOrder, positions, priorities, itemType,
      after?.ordinal ?? null, nativeTextBytes(after?.id ?? ''), limit],
    signal,
  });
  const ids = result.rows.map(row => decodeNativeTextBytes(row.Id));
  if (!ids.length) return { rows: [], nextCursor: null };
  const rows = await filterPostgresSimilarRows(database, ids, {
    userId,
    visibility,
    nameAccessTypes,
    includeOwnedItems: true,
    includeAlternateVersions: true,
    signal,
  });
  const last = result.rows.at(-1);
  const ordinal = Number(last.Ordinal);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error('PostgreSQL returned an invalid remote similar-items cursor.');
  }
  return {
    rows,
    // A full page might be the final page. Returning its cursor can cost one
    // empty bounded probe, while avoiding an extra look-ahead row that would
    // exceed the manager's current hydration allowance.
    nextCursor: result.rows.length === limit ? { ordinal, id: decodeNativeTextBytes(last.Id) } : null,
  };
}

/**
 * Apply SimilarItemsManager's final user access filter to only the already
 * selected identifiers. Input order is retained because provider scores have
 * already established the result order at this boundary.
 */
export async function filterPostgresSimilarAccessRows(database, ids, {
  userId,
  visibility,
  nameAccessTypes = [],
  signal,
} = {}) {
  return filterPostgresSimilarRows(database, ids, {
    userId,
    visibility,
    nameAccessTypes,
    includeOwnedItems: false,
    includeAlternateVersions: false,
    signal,
  });
}

/** Determine whether a MusicArtist has at least one bounded, visible relation. */
export async function hasPostgresVisibleArtistRelation(database, artistId, {
  userId,
  visibility,
  signal,
} = {}) {
  const page = await queryPostgresItemPage(database, {
    artistids: uniqueIds([artistId]),
    limit: 1,
  }, {
    userId,
    visibility,
    includeOwnedItems: true,
    includeAlternateVersions: true,
    signal,
  });
  return page.rows.length > 0;
}
