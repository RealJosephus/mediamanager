import { decodeNativeTextBytes, nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { quoteIdentifier as q } from '../database/model.js';
import { cleanValue, idKey, nonemptyId } from './records.js';
import { queryPostgresUserViewMenuPage } from './postgres-user-view-menu-query.js';
import { clrWhitespaceCharacters } from '../metadata/whitespace.js';


function table(database, name) {
  if (database?.dialect !== 'postgres') throw new TypeError('A PostgreSQL database is required.');
  return `${q(database.schemaName)}.${q(name)}`;
}

function stringArray(values, name) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
    throw new TypeError(`${name} must be a string array.`);
  }
  return values;
}

async function resolveStoredSelectorIds(database, query) {
  const keys = ['ids', 'excludeitemids', 'genreids', 'studioids'];
  const requested = keys.flatMap(key => query[key] ?? []).filter(nonemptyId);
  if (!requested.length) return query;
  const result = await database.client.query({
    text: `SELECT "Id" FROM ${table(database, 'BaseItems')}
      WHERE replace(${nativeTextSql(database.schemaName).guidLower("\"Id\"")}, '-', '') = ANY($1::text[])`,
    values: [[...new Set(requested.map(idKey))]],
  });
  const stored = new Map(result.rows.map(row => { const id = decodeNativeTextBytes(row.Id); return [idKey(id), id]; }));
  const resolved = { ...query };
  for (const key of keys) {
    if (query[key]?.length) resolved[key] = query[key].map(id => stored.get(idKey(id)) ?? id);
  }
  return resolved;
}

function sourcePlan(database, {
  itemType,
  scope,
  groupByPresentationKey = false,
  visibility,
  pageQuery,
  itemId,
} = {}) {
  if (!['Movie', 'Series'].includes(itemType)) throw new TypeError('Genre source itemType must be Movie or Series.');
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new TypeError('Genre source scope must be an object.');
  const unknownScope = Object.keys(scope).filter(key => !['topParentIds', 'ancestorId'].includes(key));
  if (unknownScope.length) throw new TypeError(`Unknown genre source scope: ${unknownScope.join(', ')}`);
  if (!pageQuery || typeof pageQuery !== 'object' || Array.isArray(pageQuery)) {
    throw new TypeError('Genre menu query must be an object.');
  }
  const startIndex = pageQuery.startindex ?? 0;
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
    throw new TypeError('Genre menu startIndex must be a non-negative integer.');
  }
  if (pageQuery.limit !== undefined && (!Number.isSafeInteger(pageQuery.limit) || pageQuery.limit < 0)) {
    throw new TypeError('Genre menu limit must be a non-negative integer or undefined.');
  }
  if (!nonemptyId(itemId)) throw new TypeError('Genre menu itemId must be a nonempty id.');

  const values = [];
  const bind = value => { values.push(value); return `$${values.length}`; };
  const bindNativeArray = (entries, name) => `${bind(stringArray(entries, name).map(nativeTextBytes))}::bytea[]`;
  const bindTextArray = (entries, name) => `${bind(stringArray(entries, name))}::text[]`;
  const bindIds = (entries, name) => bindTextArray(stringArray(entries, name).map(idKey), name);
  const baseItems = table(database, 'BaseItems');
  const ancestors = table(database, 'AncestorIds');
  const links = table(database, 'LinkedChildren');
  const itemValues = table(database, 'ItemValues');
  const itemValuesMap = table(database, 'ItemValuesMap');
  const leafType = alias => `substring(${nativeTextSql(database.schemaName).projection(`${alias}."Type"`)} from '[^.]+$')`;
  const predicates = [`${leafType('i')} = ${bind(itemType)}`];

  if (Object.hasOwn(scope, 'topParentIds')) {
    predicates.push(`replace(${nativeTextSql(database.schemaName).guidLower("i.\"TopParentId\"")}, '-', '') = ANY(${bindIds(scope.topParentIds, 'scope.topParentIds')})`);
  } else if (Object.hasOwn(scope, 'ancestorId')) {
    if (!nonemptyId(scope.ancestorId)) predicates.push('FALSE');
    else predicates.push(`EXISTS (SELECT 1 FROM ${ancestors} source_ancestor
      WHERE replace(${nativeTextSql(database.schemaName).guidLower("source_ancestor.\"ItemId\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")}, '-', '')
        AND replace(${nativeTextSql(database.schemaName).guidLower("source_ancestor.\"ParentItemId\"")}, '-', '') = ${bind(idKey(scope.ancestorId))})`);
  } else predicates.push('FALSE');

  if (visibility != null) {
    if (!visibility || typeof visibility !== 'object' || Array.isArray(visibility)) {
      throw new TypeError('Genre source visibility must be an object.');
    }
    const allowedVisibilityKeys = new Set(['blockedTags', 'allowedTags', 'maxRating', 'maxSubRating', 'blockUnratedTypes']);
    const unknown = Object.keys(visibility).filter(key => !allowedVisibilityKeys.has(key));
    if (unknown.length) throw new TypeError(`Unknown genre source visibility option: ${unknown.join(', ')}`);
    const inheritedTagExists = names => {
      const parameter = bindNativeArray(names.map(cleanValue), 'visibility tags');
      return `EXISTS (SELECT 1 FROM ${itemValuesMap} permission_map
        JOIN ${itemValues} permission_value
          ON replace(${nativeTextSql(database.schemaName).guidLower("permission_value.\"ItemValueId\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemValueId\"")}, '-', '')
        WHERE permission_value."Type" = 4
          AND permission_value."CleanValue" = ANY(${parameter})
          AND (replace(${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemId\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")}, '-', '')
            OR replace(${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemId\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("i.\"TopParentId\"")}, '-', '')
            OR replace(${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemId\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("i.\"SeriesId\"")}, '-', '')
            OR replace(${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemId\"")}, '-', '') IN (
              SELECT replace(${nativeTextSql(database.schemaName).guidLower("permission_ancestor.\"ParentItemId\"")}, '-', '')
              FROM ${ancestors} permission_ancestor
              WHERE replace(${nativeTextSql(database.schemaName).guidLower("permission_ancestor.\"ItemId\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")}, '-', '')
            )))`;
    };
    if (visibility.blockedTags?.length) predicates.push(`NOT ${inheritedTagExists(visibility.blockedTags)}`);
    if (visibility.allowedTags?.length) predicates.push(inheritedTagExists(visibility.allowedTags));
    if (visibility.maxRating != null) {
      const maximum = bind(visibility.maxRating);
      const maximumSub = bind(visibility.maxSubRating ?? 0);
      predicates.push(`(i."InheritedParentalRatingValue" IS NULL
        OR i."InheritedParentalRatingValue" < ${maximum}
        OR (i."InheritedParentalRatingValue" = ${maximum}
          AND COALESCE(i."InheritedParentalRatingSubValue", 0) <= ${maximumSub}))`);
      const childMaximum = bind(visibility.maxRating);
      const childMaximumSub = bind(visibility.maxSubRating ?? 0);
      predicates.push(`(NOT EXISTS (SELECT 1 FROM ${links} rating_link
          WHERE replace(${nativeTextSql(database.schemaName).guidLower("rating_link.\"ParentId\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")}, '-', '')
            AND rating_link."ChildType" = 0)
        OR EXISTS (SELECT 1 FROM ${links} rating_link
          JOIN ${baseItems} rating_child
            ON replace(${nativeTextSql(database.schemaName).guidLower("rating_child.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("rating_link.\"ChildId\"")}, '-', '')
          WHERE replace(${nativeTextSql(database.schemaName).guidLower("rating_link.\"ParentId\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")}, '-', '')
            AND rating_link."ChildType" = 0
            AND (rating_child."InheritedParentalRatingValue" IS NULL
              OR rating_child."InheritedParentalRatingValue" < ${childMaximum}
              OR (rating_child."InheritedParentalRatingValue" = ${childMaximum}
                AND COALESCE(rating_child."InheritedParentalRatingSubValue", 0) <= ${childMaximumSub}))))`);
    }
    if (visibility.blockUnratedTypes?.length) {
      predicates.push(`(i."InheritedParentalRatingValue" IS NULL
        AND i."UnratedType" = ANY(${bindNativeArray(visibility.blockUnratedTypes, 'visibility.blockUnratedTypes')})) IS NOT TRUE`);
    }
  }

  predicates.push('(i."OwnerId" IS NULL OR i."ExtraType" IS NOT NULL)');
  predicates.push(`(i."PrimaryVersionId" IS NULL OR NOT EXISTS (
    SELECT 1 FROM ${baseItems} primary_item
    WHERE replace(${nativeTextSql(database.schemaName).guidLower("primary_item.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("i.\"PrimaryVersionId\"")}, '-', '')
      AND ${nativeTextSql(database.schemaName).guidLower("primary_item.\"TopParentId\"")} IS NOT DISTINCT FROM ${nativeTextSql(database.schemaName).guidLower("i.\"TopParentId\"")}))`);

  const selected = groupByPresentationKey
    ? `group_ranked AS (
      SELECT filtered.*, row_number() OVER (
        PARTITION BY "PresentationUniqueKey"
        ORDER BY ("PrimaryVersionId" IS NOT NULL) ASC, "Id" ASC
      ) AS __group_rank
      FROM filtered
    ), selected AS (SELECT * FROM group_ranked WHERE __group_rank = 1)`
    : 'selected AS (SELECT * FROM filtered)';
  const clrWhitespaceParameter = bind(clrWhitespaceCharacters);
  const ctes = `filtered AS (
      SELECT i."Id", i."SortName", i."Genres", i."PresentationUniqueKey", i."PrimaryVersionId"
      FROM ${baseItems} i
      WHERE ${predicates.join('\n        AND ')}
    ), ${selected}, source_ordered AS (
      SELECT selected.*, row_number() OVER (
        ORDER BY selected."SortName" ASC NULLS FIRST, selected."Id" ASC
      ) AS __source_ordinal
      FROM selected
    ), genre_occurrences AS (
      SELECT ${nativeTextSql(database.schemaName).fromProjection('genre."Name"')} AS "Name", source_ordered.__source_ordinal, genre.__genre_ordinal
      FROM source_ordered
      CROSS JOIN LATERAL string_to_table(
        CASE WHEN btrim(COALESCE(${nativeTextSql(database.schemaName).projection('source_ordered."Genres"')}, ''), ${clrWhitespaceParameter}) = ''
          THEN NULL ELSE ${nativeTextSql(database.schemaName).projection('source_ordered."Genres"')} END,
        '|'
      ) WITH ORDINALITY AS genre("Name", __genre_ordinal)
    ), exact_first AS (
      SELECT DISTINCT ON ("Name") "Name", __source_ordinal, __genre_ordinal
      FROM genre_occurrences
      ORDER BY "Name", __source_ordinal, __genre_ordinal
    ), normalized AS (
      SELECT "Name", __source_ordinal, __genre_ordinal,
        ${nativeTextSql(database.schemaName).ordinalIgnoreCaseKey(nativeTextSql(database.schemaName).removeDiacritics('"Name"'))} AS __normalized_name
      FROM exact_first
    ), normalized_first AS (
      SELECT DISTINCT ON (__normalized_name)
        "Name", __source_ordinal, __genre_ordinal
      FROM normalized
      ORDER BY __normalized_name, __source_ordinal, __genre_ordinal
    )`;
  let pagination = '';
  // UserViewBuilder treats zero as an unbounded page after StartIndex.
  if (pageQuery.limit !== undefined && pageQuery.limit !== 0) pagination += ` LIMIT ${bind(pageQuery.limit)}`;
  if (startIndex) pagination += ` OFFSET ${bind(startIndex)}`;
  const adjacentId = nonemptyId(pageQuery.adjacentto) ? idKey(pageQuery.adjacentto) : null;
  const text = `WITH ${ctes}, ordered AS (
      SELECT normalized_first.*,
        row_number() OVER (ORDER BY __source_ordinal, __genre_ordinal) AS __ordinal
      FROM normalized_first
    ), adjacent AS (
      SELECT * FROM ordered
      WHERE ${bind(adjacentId)}::text IS NULL
        OR (replace(lower(${bind(itemId)}::text), '-', '') = ${bind(adjacentId)}::text AND __ordinal <= 2)
    ), page AS (
      SELECT * FROM adjacent ORDER BY __ordinal${pagination}
    ), summary AS (
      SELECT
        (SELECT count(*)::bigint FROM ordered) AS "SourceRecordCount",
        (SELECT count(*)::bigint FROM adjacent) AS "TotalRecordCount",
        (SELECT "Name" FROM ordered ORDER BY __ordinal LIMIT 1) AS "SeedName"
    )
    SELECT page."Name", page.__source_ordinal, page.__genre_ordinal, page.__ordinal,
      summary."SourceRecordCount", summary."TotalRecordCount", summary."SeedName"
    FROM summary LEFT JOIN page ON TRUE
    ORDER BY page.__ordinal NULLS LAST`;
  return Object.freeze({ text, values: Object.freeze(values), limit: pageQuery.limit, startIndex });
}

/**
 * Build the complete PostgreSQL source page for a movie/TV genre menu. The
 * distinct count, stable source order, adjacency window and public paging all
 * remain relational; the result contains only the requested names plus one
 * scalar seed used to preserve the shared UserView's lazy creation contract.
 */
export function buildPostgresUserViewGenrePageQuery(database, query = {}, options = {}) {
  return sourcePlan(database, { ...options, pageQuery: query });
}

/** Execute one SQL-owned source page without materializing every genre name. */
export async function queryPostgresUserViewGenrePage(database, query, options = {}) {
  const plan = buildPostgresUserViewGenrePageQuery(database, query, options);
  const result = await database.client.query({ text: plan.text, values: plan.values, signal: options.signal });
  const summary = result.rows[0];
  const sourceTotal = Number(summary?.SourceRecordCount ?? 0);
  const total = Number(summary?.TotalRecordCount ?? 0);
  if (!Number.isSafeInteger(sourceTotal) || sourceTotal < 0
    || !Number.isSafeInteger(total) || total < 0) {
    throw new Error('PostgreSQL returned an invalid genre menu count.');
  }
  return {
    rows: result.rows.filter(row => row.__ordinal != null).map(row => ({
      name: decodeNativeTextBytes(row.Name),
      sourceOrdinal: Number(row.__source_ordinal),
      genreOrdinal: Number(row.__genre_ordinal),
      ordinal: Number(row.__ordinal),
    })),
    seedName: summary?.SeedName == null ? undefined : decodeNativeTextBytes(summary.SeedName),
    sourceTotal,
    total,
    startIndex: plan.startIndex,
  };
}

/** Filter the persisted shared Genre UserView without applying source paging. */
export async function matchesPostgresUserViewGenre(database, query, {
  itemId,
  userId,
  memorySortConfiguration = {},
  memoryRatingContext = null,
  signal,
} = {}) {
  if (!nonemptyId(itemId)) return false;
  const selectors = await resolveStoredSelectorIds(database, query);
  const matchQuery = { ...selectors, adjacentto: undefined, startindex: 0, limit: 1 };
  const match = await queryPostgresUserViewMenuPage(database, matchQuery, [itemId], {
    userId,
    memorySortConfiguration,
    memoryRatingContext,
    signal,
  });
  return match.total > 0;
}
