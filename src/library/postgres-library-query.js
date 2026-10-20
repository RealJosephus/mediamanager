import { decodeNativeTextBytes, nativeTextPathKey, nativeTextBytes } from '../database/native-text.js';
import { tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { quoteIdentifier as q } from '../database/model.js';
import { lowerInvariant } from '../core/identity.js';
import { postgresInvariantLowerFunctionName,
  postgresNativePathKeyFunctionName } from '../database/postgres-runtime-schema.js';
import { postgresAliasedVersionFamilyKey } from '../database/postgres-query-expressions.js';
import { nativePathKey } from './native-path.js';
import { queryPostgresSeriesEpisodePage } from './postgres-series-episodes-query.js';
import { resolveSeries } from './series-reference.js';
import { createPresentationUniqueKey } from './presentation-key.js';
import { clrTrim } from '../metadata/whitespace.js';
import { cleanValue, idKey, mapRecord, nonemptyId } from './records.js';

const NAVIGATION_TYPES = Object.freeze([
  'UserRootFolder',
  'AggregateFolder',
  'CollectionFolder',
  'PlaylistsFolder',
]);

function qualified(database, name) {
  if (database?.dialect !== 'postgres') throw new TypeError('A PostgreSQL database is required.');
  return `${q(database.schemaName)}.${q(name)}`;
}

async function itemIds(database, text, values) {
  const result = await database.client.query({ text, values });
  return result.rows.map(row => row.Id == null ? null : decodeNativeTextBytes(row.Id)).filter(nonemptyId);
}

/** Count linked children only for the projected page, without loading links. */
export async function queryPostgresLinkedChildCounts(database, ids) {
  if (!ids.length) return new Map();
  const result = await database.client.query({
    text: `SELECT replace(${nativeTextSql(database.schemaName).guidLower("\"ParentId\"")}, '-', '') AS "Key", count(*) AS "Count"
      FROM ${qualified(database, 'LinkedChildren')}
      WHERE replace(${nativeTextSql(database.schemaName).guidLower("\"ParentId\"")}, '-', '') = ANY($1::text[])
      GROUP BY replace(${nativeTextSql(database.schemaName).guidLower("\"ParentId\"")}, '-', '')`,
    values: [ids.map(idKey)],
  });
  return new Map(result.rows.map(row => [row.Key, safeNonnegativeInteger(row.Count, 'linked child count')]));
}

function safeNonnegativeInteger(value, description) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`PostgreSQL returned an invalid ${description}.`);
  }
  return number;
}

export async function loadPostgresRowsByIds(database, ids) {
  const unique = [...new Map(ids.filter(nonemptyId).map(id => [idKey(id), id])).values()];
  if (!unique.length) return [];
  // Jellyfin GUID text is NOCASE in SQLite and real databases may contain
  // either hexadecimal case or Guid "N"/"D" formatting. PostgreSQL's C
  // collation is deliberately binary, so resolve the stored spelling before
  // using the typed rows adapter.
  const lookup = [...new Set(unique.map(idKey))];
  const stored = await itemIds(database,
    `SELECT "Id" FROM ${qualified(database, 'BaseItems')} WHERE replace(${nativeTextSql(database.schemaName).guidLower("\"Id\"")}, '-', '') = ANY($1::text[])`,
    [lookup]);
  return stored.length ? database.rows('BaseItems', { whereIn: { Id: stored } }) : [];
}

/** Follow entity ParentId, including the user's physical-root translation.
 * AncestorIds and TopParentId are repository selectors, not this parent chain. */
export async function queryPostgresAncestorIds(database, id, translations = []) {
  const items = qualified(database, 'BaseItems');
  const key = alias => `replace(${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)}, '-', '')`;
  return itemIds(database, `/* item-ancestors */
    WITH RECURSIVE translations AS (
      SELECT * FROM jsonb_to_recordset($2::jsonb) AS mapping(source text, target text)
    ), chain("Id", depth, visited) AS (
      SELECT seed."Id", 0, ARRAY[${key('seed')}]
      FROM ${items} seed WHERE ${key('seed')} = $1
      UNION ALL
      SELECT parent."Id", chain.depth + 1, chain.visited || ${key('parent')}
      FROM chain
      JOIN ${items} current ON current."Id" = chain."Id"
      JOIN ${items} physical ON ${key('physical')}
        = replace(${nativeTextSql(database.schemaName).guidLower('current."ParentId"')}, '-', '')
      LEFT JOIN translations mapping ON mapping.source = ${key('physical')}
      JOIN ${items} parent ON ${key('parent')}
        = CASE WHEN mapping.source IS NULL THEN ${key('physical')} ELSE mapping.target END
      WHERE NOT (${key('parent')} = ANY(chain.visited))
    )
    SELECT "Id" FROM chain WHERE depth > 0 ORDER BY depth`,
  [idKey(id), JSON.stringify(translations)]);
}

/** Load only direct CollectionFolder children of a UserRootFolder for the
 * external-playlist provider. The JSON projection remains bounded to those
 * navigation rows; media descendants never cross the database boundary. */
export async function queryPostgresPlaylistLibraryRoots(database) {
  const baseItems = qualified(database, 'BaseItems');
  const ids = await itemIds(database,
    `/* playlist-library-roots */
      SELECT collection."Id"
      FROM ${baseItems} collection
      WHERE substring(${nativeTextSql(database.schemaName).projection("collection.\"Type\"")} from '[^.]+$') = 'CollectionFolder'
        AND EXISTS (
          SELECT 1
          FROM ${baseItems} root
          WHERE substring(${nativeTextSql(database.schemaName).projection("root.\"Type\"")} from '[^.]+$') = 'UserRootFolder'
            AND replace(${nativeTextSql(database.schemaName).guidLower("root.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("collection.\"ParentId\"")}, '-', '')
        )
      ORDER BY collection."Id" ASC`, []);
  const rows = await loadPostgresRowsByIds(database, ids);
  const ignored = new Set(['livetv', 'boxsets', 'playlists']);
  const roots = [];
  for (const row of rows) {
    const item = mapRecord(row);
    if (item?.CollectionType == null || ignored.has(String(item.CollectionType).toLowerCase())) continue;
    roots.push(...(item.PhysicalLocations ?? []), ...(item.PhysicalLocationsList ?? []));
  }
  return [...new Set(roots.filter(value => typeof value === 'string' && value.length > 0))];
}

/** Use the verified immutable native-path expression index, then apply optional
 * type and per-path result bounds before rows cross the database boundary. */
async function queryPostgresRowsByPaths(database, paths, {
  itemTypes = [],
  maxOwnersPerPath = 2,
} = {}) {
  const keys = [...new Map(paths.map(nativeTextPathKey).filter(value => value !== null)
    .map(value => [value.toString('hex'), value])).values()];
  if (!keys.length) return [];
  const nativePathKeySql = `${q(database.schemaName)}.${q(postgresNativePathKeyFunctionName)}`;
  const result = await database.client.query({
    text: `/* folder-scan-path-owners */
      WITH matched AS (
        SELECT item."Id", item."Type", item."Path",
          ${nativePathKeySql}(item."Path") AS path_key,
          row_number() OVER (
            PARTITION BY ${nativePathKeySql}(item."Path")
            ORDER BY item."Path" ASC, item."Id" ASC
          ) AS collision_rank
        FROM ${qualified(database, 'BaseItems')} item
        WHERE ${nativePathKeySql}(item."Path") = ANY($1::bytea[])
          AND (cardinality($2::text[]) = 0
            OR substring(${nativeTextSql(database.schemaName).projection("item.\"Type\"")} from '[^.]+$') = ANY($2::text[]))
      )
      SELECT "Id", "Type", "Path"
      FROM matched
      WHERE $3::integer IS NULL OR collision_rank <= $3
      ORDER BY "Path" ASC, "Id" ASC`,
    values: [keys, itemTypes, maxOwnersPerPath],
  });
  return result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    const column = tableDefinition('BaseItems').columns.find(column => column.name === key);
    return [key, column ? decodeValue(column, value) : value];
  })));
}

/** Load no more than two owners for each requested native path. Two rows are
 * sufficient for folder reconciliation to distinguish unique ownership from
 * a collision without transferring an arbitrarily large duplicate set. */
export async function loadPostgresRowsByPaths(database, paths) {
  return queryPostgresRowsByPaths(database, paths);
}

/** Count bounded video rows whose native JSON will take the mapper fallback. */
export async function countPostgresNullVideoTypeRows(database, ids) {
  const lookup = [...new Set(ids.filter(nonemptyId).map(idKey))];
  if (!lookup.length) return 0;
  const result = await database.client.query({
    text: `SELECT count(*)::bigint AS "Count"
      FROM ${qualified(database, 'BaseItems')} item
      WHERE replace(${nativeTextSql(database.schemaName).guidLower("item.\"Id\"")}, '-', '') = ANY($1::text[])
        AND substring(${nativeTextSql(database.schemaName).projection("item.\"Type\"")} from '[^.]+$') IN ('Movie', 'Video', 'Episode', 'MusicVideo', 'Trailer')
        AND COALESCE(${nativeTextSql(database.schemaName).projection('item."Data"')}, '') ~ '"VideoType"[[:space:]]*:[[:space:]]*null'`,
    values: [lookup],
  });
  const count = Number(result.rows[0]?.Count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('PostgreSQL returned an invalid native-data diagnostic count.');
  return count;
}

async function loadPostgresDiscoveryRowsByIds(database, ids) {
  const lookup = [...new Set(ids.filter(nonemptyId).map(idKey))];
  if (!lookup.length) return [];
  const result = await database.client.query({
    text: `SELECT * FROM ${qualified(database, 'BaseItems')}
      WHERE replace(${nativeTextSql(database.schemaName).guidLower("\"Id\"")}, '-', '') = ANY($1::text[])`,
    values: [lookup],
  });
  return result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    const column = tableDefinition('BaseItems').columns.find(column => column.name === key);
    return [key, column ? decodeValue(column, value) : value];
  })));
}

/** Return only link-type presence for bounded parents, never their child rows. */
export async function queryPostgresLinkTypes(database, parentIds) {
  const ids = [...new Set(parentIds.filter(nonemptyId).map(idKey))];
  if (!ids.length) return new Map();
  const result = await database.client.query({
    text: `SELECT "ParentId", array_agg(DISTINCT "ChildType" ORDER BY "ChildType") AS "ChildTypes"
      FROM ${qualified(database, 'LinkedChildren')}
      WHERE replace(${nativeTextSql(database.schemaName).guidLower("\"ParentId\"")}, '-', '') = ANY($1::text[])
      GROUP BY "ParentId"`,
    values: [ids],
  });
  return new Map(result.rows.map(row => [idKey(decodeNativeTextBytes(row.ParentId)), new Set(row.ChildTypes.map(Number))]));
}

/** The caller freezes this complete selection in SQL and hydrates bounded pages. */
export function buildPostgresValidationChildrenQuery(database, parentId) {
  return {
    text: `SELECT row_number() OVER(ORDER BY "SortName" ASC NULLS FIRST, "Id") AS "Ordinal", item.*
      FROM ${qualified(database, 'BaseItems')} item
      WHERE replace(${nativeTextSql(database.schemaName).guidLower("\"ParentId\"")}, '-', '') = $1
        AND ("OwnerId" IS NULL
          OR replace(${nativeTextSql(database.schemaName).guidLower("\"OwnerId\"")}, '-', '') = '00000000000000000000000000000000'
          OR "ExtraType" IS NOT NULL)
      ORDER BY "SortName" ASC NULLS FIRST, "Id" ASC`,
    values: [nonemptyId(parentId) ? idKey(parentId) : null],
  };
}

/**
 * Resolve each Albums query token to at most one repository album id.
 *
 * The native controller runs a separate global MusicAlbum query for every
 * token with its default SortName ordering and Limit=1.  A lateral selector
 * preserves that per-token behavior without materializing every duplicate
 * album in Node.  A null selector represents a CLR-trimmed empty token and
 * therefore matches the first eligible album globally.
 */
export async function queryPostgresAlbumSelectorIds(database, names) {
  if (!names.length) return [];
  const selectorNames = names.map(name => name === '' ? null : cleanValue(name));
  const baseItems = qualified(database, 'BaseItems');
  const result = await database.client.query({
    text: `SELECT selected."Id"
      FROM unnest($1::bytea[]) WITH ORDINALITY requested("CleanName", "Ordinal")
      JOIN LATERAL (
        SELECT album."Id"
        FROM ${baseItems} album
        WHERE substring(${nativeTextSql(database.schemaName).projection("album.\"Type\"")} from '[^.]+$') = 'MusicAlbum'
          AND (requested."CleanName" IS NULL OR album."CleanName" = requested."CleanName")
          AND (album."OwnerId" IS NULL OR album."ExtraType" IS NOT NULL)
          AND (album."PrimaryVersionId" IS NULL
            OR replace(${nativeTextSql(database.schemaName).guidLower("album.\"PrimaryVersionId\"")}, '-', '') = '00000000000000000000000000000000'
            OR NOT EXISTS (
              SELECT 1 FROM ${baseItems} primary_album
              WHERE replace(${nativeTextSql(database.schemaName).guidLower("primary_album.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("album.\"PrimaryVersionId\"")}, '-', '')
                AND replace(${nativeTextSql(database.schemaName).guidLower("primary_album.\"TopParentId\"")}, '-', '')
                  IS NOT DISTINCT FROM replace(${nativeTextSql(database.schemaName).guidLower("album.\"TopParentId\"")}, '-', '')
            ))
        ORDER BY album."SortName" ASC NULLS FIRST,
          album."Id" ASC
        LIMIT 1
      ) selected ON TRUE
      ORDER BY requested."Ordinal"`,
    values: [selectorNames.map(value => value == null ? null : nativeTextBytes(value))],
  });
  return result.rows.map(row => row.Id == null ? null : decodeNativeTextBytes(row.Id)).filter(nonemptyId);
}

/** Resolve native Artists selectors in request order without hydrating candidates. */
export async function queryPostgresArtistSelectorIds(database, names) {
  if (!names.length) return [];
  const normalizedNames = names.map(name => name === '' ? null : lowerInvariant(name));
  const baseItems = qualified(database, 'BaseItems');
  const invariantLower = `${q(database.schemaName)}.${q(postgresInvariantLowerFunctionName)}`;
  const result = await database.client.query({
    text: `/* artist-selectors */
      SELECT selected."Id"
      FROM unnest($1::bytea[]) WITH ORDINALITY requested("Name", "Ordinal")
      LEFT JOIN LATERAL (
        SELECT artist."Id"
        FROM ${baseItems} artist
        WHERE substring(${nativeTextSql(database.schemaName).projection("artist.\"Type\"")} from '[^.]+$') = 'MusicArtist'
          AND (requested."Name" IS NULL OR ${invariantLower}(artist."Name") = requested."Name")
          AND (artist."OwnerId" IS NULL OR artist."ExtraType" IS NOT NULL)
          AND (artist."PrimaryVersionId" IS NULL OR NOT EXISTS (
            SELECT 1 FROM ${baseItems} primary_artist
            WHERE replace(${nativeTextSql(database.schemaName).guidLower("primary_artist.\"Id\"")}, '-', '')
                = replace(${nativeTextSql(database.schemaName).guidLower("artist.\"PrimaryVersionId\"")}, '-', '')
              AND replace(${nativeTextSql(database.schemaName).guidLower("primary_artist.\"TopParentId\"")}, '-', '')
                IS NOT DISTINCT FROM replace(${nativeTextSql(database.schemaName).guidLower("artist.\"TopParentId\"")}, '-', '')
          ))
        ORDER BY (artist."ParentId" IS NULL), artist."SortName" ASC NULLS FIRST,
          artist."Id" ASC
        LIMIT 1
      ) selected ON TRUE
      ORDER BY requested."Ordinal"`,
    values: [normalizedNames.map(value => value == null ? null : nativeTextBytes(value))],
  });
  return result.rows.map(row => row.Id == null ? null : decodeNativeTextBytes(row.Id));
}

/** Resolve one native Artists selector without hydrating the candidate set. */
export async function queryPostgresArtistSelectorId(database, name) {
  return (await queryPostgresArtistSelectorIds(database, [name]))[0] ?? undefined;
}

/** Resolve deterministic by-name identities in request order in one lookup. */
export async function queryPostgresIdentitySelectorIds(database, ids) {
  if (!ids.length) return [];
  const baseItems = qualified(database, 'BaseItems');
  const result = await database.client.query({
    text: `/* identity-selectors */
      SELECT selected."Id"
      FROM unnest($1::text[]) WITH ORDINALITY requested("Id", "Ordinal")
      LEFT JOIN LATERAL (
        SELECT item."Id"
        FROM ${baseItems} item
        WHERE replace(${nativeTextSql(database.schemaName).guidLower("item.\"Id\"")}, '-', '') = requested."Id"
        ORDER BY item."Id" ASC
        LIMIT 1
      ) selected ON TRUE
      ORDER BY requested."Ordinal"`,
    values: [ids.map(idKey)],
  });
  return result.rows.map(row => row.Id == null ? null : decodeNativeTextBytes(row.Id));
}

/**
 * Load only the small navigation plane needed to resolve a client Items scope.
 * Media rows are intentionally excluded; they are selected by the page query.
 */
export async function loadPostgresNavigationRows(database, parentId, {
  deferBaseItemHydration = false,
} = {}) {
  const baseItems = qualified(database, 'BaseItems');
  const loadRows = deferBaseItemHydration ? loadPostgresDiscoveryRowsByIds : loadPostgresRowsByIds;
  const ids = await itemIds(database,
    `SELECT "Id" FROM ${baseItems} item
     WHERE substring(${nativeTextSql(database.schemaName).projection("item.\"Type\"")} from '[^.]+$') = ANY($1::text[])
       OR (substring(${nativeTextSql(database.schemaName).projection("item.\"Type\"")} from '[^.]+$') = 'Folder' AND EXISTS (
         SELECT 1 FROM ${baseItems} root
         WHERE substring(${nativeTextSql(database.schemaName).projection("root.\"Type\"")} from '[^.]+$') IN ('AggregateFolder', 'UserRootFolder')
           AND replace(${nativeTextSql(database.schemaName).guidLower("root.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("item.\"ParentId\"")}, '-', '')
       ))`,
    [NAVIGATION_TYPES]);
  if (nonemptyId(parentId)) ids.push(parentId);

  const rows = new Map((await loadRows(database, ids)).map(row => [idKey(row.Id), row]));
  // CollectionFolder can bind a physical root by persisted location even when
  // PhysicalFolderIds is empty or stale. Resolve only those SQL-matched paths;
  // returning every Folder row would turn this navigation read into a library
  // scan. The database expression mirrors the stored separator/case boundary
  // needed by nativePathKey while the final native comparison remains in the
  // caller that consumes these candidates.
  const physicalLocations = [...rows.values()].flatMap(row => {
    const item = mapRecord(row);
    return item?.Type === 'CollectionFolder'
      ? [...(item.PhysicalLocations ?? []), ...(item.PhysicalLocationsList ?? [])]
        .filter(location => nativePathKey(location) !== null)
      : [];
  });
  if (physicalLocations.length) {
    const locationIds = (await queryPostgresRowsByPaths(database, physicalLocations, {
      itemTypes: ['Folder'],
      maxOwnersPerPath: null,
    })).map(row => row.Id);
    for (const row of await loadRows(database, locationIds)) rows.set(idKey(row.Id), row);
  }
  // Display parents, persisted parents and physical library roots form a finite
  // graph rooted in the navigation entities. Resolve it to a fixed point without
  // touching unrelated descendants in the media catalogue.
  for (;;) {
    const references = [];
    for (const row of rows.values()) {
      const item = mapRecord(row);
      if (!item) continue;
      for (const id of [item.ParentId, item.DisplayParentId, ...(item.PhysicalFolderIds ?? [])]) {
        if (nonemptyId(id) && !rows.has(idKey(id))) references.push(id);
      }
    }
    if (!references.length) break;
    const added = await loadRows(database, references);
    if (!added.length) break;
    for (const row of added) rows.set(idKey(row.Id), row);
  }
  return [...rows.values()];
}

/**
 * Expand a SQL-selected page with the finite relationship graph required for
 * DTO projection. Ancestors supply context but never become roots for member
 * expansion. Only selected entities and their explicit version/link/owned
 * families can contribute members.
 */
export async function loadPostgresPageGraph(database, pageRows, navigationRows = [], {
  includeManualLinks = false,
  includeOwnedItems = false,
  deferBaseItemHydration = false,
} = {}) {
  const loadRows = deferBaseItemHydration ? loadPostgresDiscoveryRowsByIds : loadPostgresRowsByIds;
  const rows = new Map([...navigationRows, ...pageRows].map(row => [idKey(row.Id), row]));

  // Navigation supplies library policy and display context, but is not part
  // of the selected page. Expanding its links loads unrelated media.
  const seeds = [...new Set(pageRows.map(row => idKey(row.Id)))];
  if (!seeds.length) return [...rows.values()];
  const baseItems = qualified(database, 'BaseItems');
  const ancestors = qualified(database, 'AncestorIds');
  const links = qualified(database, 'LinkedChildren');
  // Resolve the complete upward/version/link frame in one recursive statement.
  // The recursive relation appears once and every expansion is correlated to
  // its current frontier row, so query count remains constant as depth grows.
  const result = await database.client.query({
    text: `/* page-relationship-graph */
      WITH RECURSIVE graph("Id", "ExpandMembers") AS (
        SELECT seed."Id", TRUE
        FROM ${baseItems} seed
        WHERE replace(${nativeTextSql(database.schemaName).guidLower("seed.\"Id\"")}, '-', '') = ANY($1::text[])
        UNION
        SELECT edge."Id", edge."ExpandMembers"
        FROM graph parent
        CROSS JOIN LATERAL (
          SELECT referenced."Id", parent."ExpandMembers" AND reference."Version" AS "ExpandMembers"
          FROM ${baseItems} current
          CROSS JOIN LATERAL (VALUES
            (current."ParentId", FALSE), (current."TopParentId", FALSE),
            (current."SeasonId", FALSE), (current."SeriesId", FALSE),
            (current."OwnerId", FALSE), (current."PrimaryVersionId", TRUE)
          ) reference("Id", "Version")
          JOIN ${baseItems} referenced
            ON replace(${nativeTextSql(database.schemaName).guidLower("referenced.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("reference.\"Id\"")}, '-', '')
          WHERE replace(${nativeTextSql(database.schemaName).guidLower("current.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")}, '-', '')
            AND reference."Id" IS NOT NULL
          UNION
          SELECT referenced."Id", FALSE
          FROM ${ancestors} relation
          JOIN ${baseItems} referenced ON ${nativeTextSql(database.schemaName).guidLower("referenced.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("relation.\"ParentItemId\"")}
          WHERE ${nativeTextSql(database.schemaName).guidLower("relation.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")}
          UNION
          SELECT alternate."Id", TRUE
          FROM ${baseItems} current
          JOIN ${baseItems} alternate
            ON replace(${nativeTextSql(database.schemaName).guidLower("alternate.\"PrimaryVersionId\"")}, '-', '')
              = replace(${nativeTextSql(database.schemaName).guidLower("current.\"Id\"")}, '-', '')
          WHERE replace(${nativeTextSql(database.schemaName).guidLower("current.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")}, '-', '')
            AND parent."ExpandMembers"
            AND (current."PrimaryVersionId" IS NULL
              OR replace(${nativeTextSql(database.schemaName).guidLower("current.\"PrimaryVersionId\"")}, '-', '')
                = '00000000000000000000000000000000')
          UNION
          SELECT child."Id", TRUE
          FROM ${links} relation
          JOIN ${baseItems} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("relation.\"ChildId\"")}
          WHERE ${nativeTextSql(database.schemaName).guidLower("relation.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")}
            AND parent."ExpandMembers"
            AND ($2::boolean OR relation."ChildType" IN (2, 3))
          UNION
          SELECT owned."Id", TRUE
          FROM ${baseItems} owned
          WHERE $3::boolean AND parent."ExpandMembers"
            AND replace(${nativeTextSql(database.schemaName).guidLower("owned.\"OwnerId\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")}, '-', '')
        ) edge
      )
      SELECT DISTINCT "Id" FROM graph`,
    values: [seeds, includeManualLinks === true, includeOwnedItems === true],
  });
  const missingIds = result.rows.map(row => row.Id == null ? null : decodeNativeTextBytes(row.Id))
    .filter(nonemptyId).filter(id => !rows.has(idKey(id)));
  for (const row of await loadRows(database, missingIds)) rows.set(idKey(row.Id), row);

  return [...rows.values()];
}

/** Discover a bounded item/navigation relationship graph, then hydrate it once. */
export async function loadPostgresItemGraph(database, ids, {
  includeManualLinks = false,
} = {}) {
  const requestedRows = await loadPostgresDiscoveryRowsByIds(database, ids);
  const navigationRows = await loadPostgresNavigationRows(database, undefined,
    { deferBaseItemHydration: true });
  const graphRows = await loadPostgresPageGraph(database, requestedRows, navigationRows,
    { includeManualLinks, deferBaseItemHydration: true });
  return loadPostgresRowsByIds(database, graphRows.map(row => row.Id));
}

/**
 * Load the relationship frame needed by metadata refresh for one item. Direct
 * children and owned extras are bounded by the requested item. Folder metadata
 * traverses its physical subtree; by-name artists and TV items use their native
 * repository selectors, including presentation-key members outside that tree.
 */
export async function loadPostgresMetadataRows(database, referenceId, {
  targetType,
  targetName,
  includeDescendants = false,
  includeChildren = true,
  configuration = {},
} = {}) {
  const navigationRows = await loadPostgresNavigationRows(database, referenceId);
  const targetRows = await loadPostgresRowsByIds(database, [referenceId]);
  const target = targetRows[0] ? mapRecord(targetRows[0]) : null;
  targetType ??= target?.Type;
  targetName ??= target?.Name;
  const baseItems = qualified(database, 'BaseItems');
  const ancestors = qualified(database, 'AncestorIds');
  const itemValues = qualified(database, 'ItemValues');
  const itemValuesMap = qualified(database, 'ItemValuesMap');
  const seriesKey = targetType === 'Series'
    ? target?.PresentationUniqueKey ?? (target && createPresentationUniqueKey(target)) : null;
  const values = [idKey(referenceId), targetType ?? '', nativeTextBytes(cleanValue(targetName ?? '')), includeDescendants === true,
    !nonemptyId(target?.ParentId), seriesKey == null ? null : nativeTextBytes(seriesKey), Boolean(clrTrim(seriesKey ?? '')), includeChildren];
  const result = await database.client.query({
    text: `SELECT item."Id"
      FROM ${baseItems} item
      WHERE $8::boolean AND (replace(${nativeTextSql(database.schemaName).guidLower("item.\"ParentId\"")}, '-', '') = $1
        OR replace(${nativeTextSql(database.schemaName).guidLower("item.\"OwnerId\"")}, '-', '') = $1)
      UNION
      SELECT descendant."ItemId" AS "Id"
      FROM ${ancestors} descendant
      WHERE replace(${nativeTextSql(database.schemaName).guidLower("descendant.\"ParentItemId\"")}, '-', '') = $1
        AND $8::boolean AND ($4::boolean OR $2 = ANY(ARRAY['Folder', 'PhotoAlbum', 'Series', 'Season', 'MusicAlbum', 'MusicArtist']::text[]))
      UNION
      SELECT subtree."Id"
      FROM (
        WITH RECURSIVE descendants("Id") AS (
          SELECT child."Id"
          FROM ${baseItems} child
          WHERE replace(${nativeTextSql(database.schemaName).guidLower("child.\"ParentId\"")}, '-', '') = $1
          UNION
          SELECT child."Id"
          FROM descendants parent
          JOIN ${baseItems} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")}
        )
        SELECT "Id" FROM descendants
      ) subtree
      WHERE $8::boolean AND ($4::boolean OR $2 = ANY(ARRAY['Folder', 'PhotoAlbum', 'Series', 'Season', 'MusicAlbum', 'MusicArtist']::text[]))
      UNION
      SELECT album."Id"
      FROM ${baseItems} album
      JOIN ${itemValuesMap} value_map ON ${nativeTextSql(database.schemaName).guidLower("value_map.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("album.\"Id\"")}
      JOIN ${itemValues} value ON ${nativeTextSql(database.schemaName).guidLower("value.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("value_map.\"ItemValueId\"")}
      WHERE $2 = 'MusicArtist' AND $5::boolean
        AND substring(${nativeTextSql(database.schemaName).projection("album.\"Type\"")} from '[^.]+$') IN ('MusicAlbum', 'Audio', 'MusicVideo')
        AND album."IsFolder" IS FALSE
        AND value."Type" IN (0, 1)
        AND value."CleanValue" = $3
      UNION
      SELECT member."Id"
      FROM ${baseItems} member
      WHERE $2 = 'Series' AND substring(${nativeTextSql(database.schemaName).projection("member.\"Type\"")} from '[^.]+$') IN ('Season', 'Episode')
        AND (NOT $7::boolean OR member."SeriesPresentationUniqueKey" = $6)`,
    values,
  });
  const relatedRows = await loadPostgresRowsByIds(database,
    result.rows.map(row => row.Id == null ? null : decodeNativeTextBytes(row.Id)).filter(nonemptyId));
  const relationshipSeeds = [...targetRows, ...relatedRows];
  let graphRows = await loadPostgresPageGraph(database, relationshipSeeds, [],
    { includeManualLinks: includeChildren, includeOwnedItems: includeChildren });
  if (target?.Type === 'Season') {
    const byId = new Map(graphRows.map(row => [idKey(row.Id), mapRecord(row)]));
    const series = resolveSeries(target, byId);
    if (series && series.SourceType !== 'Channel' && series.SourceType !== 1) {
      const page = await queryPostgresSeriesEpisodePage(database, {
        mode: 'season', seasonId: target.Id,
        seriesKey: series.PresentationUniqueKey ?? createPresentationUniqueKey(series),
        includeMissing: true,
        includeSpecials: configuration.DisplaySpecialsWithinSeasons ?? true,
      });
      graphRows = await loadPostgresPageGraph(database, [...relationshipSeeds, ...page.rows], [],
        { includeManualLinks: true, includeOwnedItems: true });
    }
  }
  // A flat Episode can point directly at its Series while relying on
  // ParentIndexNumber to recover the persisted Season.  Upward graph loading
  // reaches the Series but intentionally never expands its children, so load
  // only the matching numbered Season sibling instead of the Series subtree.
  if (target?.Type === 'Episode' && target.ParentIndexNumber != null) {
    const graphItems = new Map(graphRows.map(row => {
      const item = mapRecord(row);
      return [idKey(row.Id), item];
    }));
    const parent = graphItems.get(idKey(target.ParentId));
    const seriesId = nonemptyId(target.SeriesId) ? target.SeriesId
      : parent?.Type === 'Series' ? parent.Id
        : parent?.Type === 'Season' ? parent.SeriesId ?? parent.ParentId : null;
    if (nonemptyId(seriesId)) {
      const seasonIds = await database.client.query({
        text: `SELECT season."Id"
          FROM ${baseItems} season
          WHERE substring(${nativeTextSql(database.schemaName).projection("season.\"Type\"")} from '[^.]+$') = 'Season'
            AND (replace(${nativeTextSql(database.schemaName).guidLower("season.\"ParentId\"")}, '-', '') = $1
              OR replace(${nativeTextSql(database.schemaName).guidLower("season.\"SeriesId\"")}, '-', '') = $1)
            AND season."IndexNumber" = $2`,
        values: [idKey(seriesId), target.ParentIndexNumber],
      });
      const seasonRows = await loadPostgresRowsByIds(database,
        seasonIds.rows.map(row => row.Id).filter(nonemptyId));
      if (seasonRows.length) graphRows = await loadPostgresPageGraph(database,
        [...relationshipSeeds, ...seasonRows], [], { includeManualLinks: true, includeOwnedItems: true });
    }
  }
  // Keep navigation out of every ownership/link expansion, including later
  // generations of extras. Merge the context only after discovery converges.
  return [...new Map([...navigationRows, ...graphRows].map(row => [idKey(row.Id), row])).values()];
}

/**
 * Compute Jellyfin folder user-data counters in PostgreSQL for only the folders
 * on the selected page.  Presentation-key replicas and linked descendants are
 * folded before ownership/version filtering, matching DTO aggregation without
 * materialising every descendant in the application process.
 */
export async function queryPostgresFolderStats(database, folderIds, userId) {
  const ids = [...new Set(folderIds.filter(nonemptyId).map(idKey))];
  if (!ids.length || !nonemptyId(userId)) return new Map();
  const baseItems = qualified(database, 'BaseItems');
  const ancestors = qualified(database, 'AncestorIds');
  const links = qualified(database, 'LinkedChildren');
  const userData = qualified(database, 'UserData');
  const family = alias => postgresAliasedVersionFamilyKey(database.schemaName, alias);
  const result = await database.client.query({
    text: `WITH RECURSIVE requested AS (
      SELECT folder."Id", folder."PresentationUniqueKey"
      FROM ${baseItems} folder
      WHERE replace(${nativeTextSql(database.schemaName).guidLower("folder.\"Id\"")}, '-', '') = ANY($1::text[])
    ), members AS (
      SELECT requested."Id" AS "FolderId", member."Id" AS "MemberId"
      FROM requested
      JOIN ${baseItems} member ON ${nativeTextSql(database.schemaName).guidLower("member.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("requested.\"Id\"")}
        OR (requested."PresentationUniqueKey" IS NOT NULL
          AND member."IsFolder" IS TRUE
          AND member."PresentationUniqueKey" = requested."PresentationUniqueKey"
          AND NOT EXISTS (SELECT 1 FROM ${links} own_link WHERE ${nativeTextSql(database.schemaName).guidLower("own_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("requested.\"Id\"")}))
    ), parent_tree("FolderId", "ItemId") AS (
      SELECT members."FolderId", child."Id"
      FROM members
      JOIN ${baseItems} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("members.\"MemberId\"")}
      UNION
      SELECT parent_tree."FolderId", child."Id"
      FROM parent_tree
      JOIN ${baseItems} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("parent_tree.\"ItemId\"")}
    ), candidate_ids AS (
      SELECT parent_tree."FolderId", parent_tree."ItemId"
      FROM parent_tree
      UNION
      SELECT members."FolderId", relation."ItemId"
      FROM members JOIN ${ancestors} relation ON ${nativeTextSql(database.schemaName).guidLower("relation.\"ParentItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("members.\"MemberId\"")}
      UNION
      SELECT members."FolderId", relation."ChildId"
      FROM members JOIN ${links} relation ON ${nativeTextSql(database.schemaName).guidLower("relation.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("members.\"MemberId\"")}
      UNION
      SELECT members."FolderId", descendant."ItemId"
      FROM members
      JOIN ${links} relation ON ${nativeTextSql(database.schemaName).guidLower("relation.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("members.\"MemberId\"")}
      JOIN ${ancestors} descendant ON ${nativeTextSql(database.schemaName).guidLower("descendant.\"ParentItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("relation.\"ChildId\"")}
    ), leaves AS (
      SELECT DISTINCT candidate_ids."FolderId", leaf.*
      FROM candidate_ids JOIN ${baseItems} leaf ON ${nativeTextSql(database.schemaName).guidLower("leaf.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("candidate_ids.\"ItemId\"")}
      WHERE leaf."IsFolder" IS FALSE AND leaf."IsVirtualItem" IS FALSE
        AND (leaf."OwnerId" IS NULL OR leaf."ExtraType" IS NOT NULL)
        AND (leaf."PrimaryVersionId" IS NULL OR NOT EXISTS (
          SELECT 1 FROM ${baseItems} primary_item
          WHERE replace(${nativeTextSql(database.schemaName).guidLower("primary_item.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("leaf.\"PrimaryVersionId\"")}, '-', '')
            AND ${nativeTextSql(database.schemaName).guidLower("primary_item.\"TopParentId\"")} IS NOT DISTINCT FROM ${nativeTextSql(database.schemaName).guidLower("leaf.\"TopParentId\"")}
        ))
    ), leaf_state AS (
      SELECT leaves."FolderId", leaves."Id",
        EXISTS (
          SELECT 1 FROM ${baseItems} version_item
          JOIN ${userData} played_data ON ${nativeTextSql(database.schemaName).guidLower("played_data.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("version_item.\"Id\"")}
          WHERE ${family('version_item')} = ${family('leaves')}
            AND replace(${nativeTextSql(database.schemaName).guidLower("played_data.\"UserId\"")}, '-', '') = $2
            AND played_data."Played" IS TRUE
        ) AS "Played"
      FROM leaves
    )
    SELECT requested."Id", count(leaf_state."Id")::bigint AS "RecursiveItemCount",
      count(leaf_state."Id") FILTER (WHERE leaf_state."Played")::bigint AS "PlayedItemCount"
    FROM requested LEFT JOIN leaf_state ON ${nativeTextSql(database.schemaName).guidLower("leaf_state.\"FolderId\"")} = ${nativeTextSql(database.schemaName).guidLower("requested.\"Id\"")}
    GROUP BY requested."Id"`,
    values: [ids, idKey(userId)],
  });
  return new Map(result.rows.map(row => {
    const total = safeNonnegativeInteger(row.RecursiveItemCount, 'folder recursive-item count');
    const played = safeNonnegativeInteger(row.PlayedItemCount, 'folder played-item count');
    if (played > total) throw new Error('PostgreSQL returned inconsistent folder item counts.');
    return [idKey(decodeNativeTextBytes(row.Id)), Object.freeze({
      RecursiveItemCount: total,
      UnplayedItemCount: total - played,
      Played: played === total,
      PlayedPercentage: total ? played / total * 100 : null,
    })];
  }));
}
