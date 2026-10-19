import { nativeTextProjection, nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import path from 'node:path';
import { quoteIdentifier as q } from '../database/model.js';
import { postgresCleanValueFunctionName, postgresNativeJsonGuidKeyFunctionName,
  postgresSafeNativeItemDataFunctionName, postgresOrdinalIgnoreCaseKeyFunctionName } from '../database/postgres-runtime-schema.js';
import { cleanValue, guid, idKey, mapRecord, nonemptyId, sameId } from './records.js';
import { loadPostgresNavigationRows, loadPostgresPageGraph, loadPostgresRowsByIds } from './postgres-library-query.js';
import { visibleLibrary } from './permissions.js';
import { nativeContainsSubPath, nativeSubpathParent, sameNativePath } from './native-path.js';

function table(database, name) {
  if (database?.dialect !== 'postgres') throw new TypeError('PostgreSQL playlist queries require PostgreSQL.');
  return `${q(database.schemaName)}.${q(name)}`;
}

function uniqueIds(ids) {
  return [...new Map(ids.filter(nonemptyId).map(id => [idKey(id), id])).values()];
}

function idVariants(id) {
  return [...new Set([guid(id), idKey(id)])];
}

const leafType = (database, alias) => `substring(${nativeTextSql(database.schemaName).projection(`${alias}."Type"`)} from '[^.]+$')`;

/** Native managed-playlist sharing gate, embedded before SQL count and paging. */
export function postgresPlaylistSharingPredicate(database, { userId, dataPath, metadataPath }, bind, alias = 'i') {
  if (!userId || !dataPath) return 'TRUE';
  const windows = process.platform === 'win32';
  const parent = nativeSubpathParent(dataPath, { windows });
  const prefix = bind(nativeTextProjection(parent));
  // Expand only the native state variables, preserving the literal path's
  // separator/case spelling for ManagedFileSystem.ContainsSubPath semantics.
  let expandedPath = `COALESCE(${nativeTextSql(database.schemaName).projection(`${alias}."Path"`)}, '')`;
  for (const [token, root] of [['AppDataPath', dataPath], ['MetadataPath', metadataPath]]) {
    if (root) expandedPath = `array_to_string(regexp_split_to_array(${expandedPath}, '(?i)%${token}%'), ${bind(nativeTextProjection(root))}::text)`;
  }
  const key = expression => windows
    ? `${q(database.schemaName)}.${q(postgresOrdinalIgnoreCaseKeyFunctionName)}(${expression})`
    : expression;
  const separator = character => character === '/' || windows && character === '\\';
  const boundary = separator(parent.at(-1)) ? 'TRUE'
    : `substring(playlist_path.value from char_length(${prefix}::text) + 1 for 1) = ANY(${bind(windows ? ['/', '\\'] : ['/'])}::text[])`;
  const managed = `char_length(playlist_path.value) > char_length(${prefix}::text)
    AND ${key(`left(playlist_path.value, char_length(${prefix}::text))`)} = ${key(`${prefix}::text`)}
    AND ${boundary}`;
  const user = bind(idKey(userId));
  const guidKey = expression => `${q(database.schemaName)}.${q(postgresNativeJsonGuidKeyFunctionName)}(${expression})`;
  return `(${leafType(database, alias)} <> 'Playlist' OR EXISTS (
    SELECT 1 FROM (SELECT ${expandedPath} AS value) playlist_path
    CROSS JOIN LATERAL (SELECT ${q(database.schemaName)}.${q(postgresSafeNativeItemDataFunctionName)}(
      ${alias}."Type", ${alias}."Data") AS data) playlist_document
    WHERE NOT (${managed}) OR CASE
      WHEN playlist_document.data ->> 'OpenAccess' = 'true' THEN TRUE
      WHEN ${guidKey("playlist_document.data -> 'OwnerUserId'")} = ${user} THEN TRUE
      ELSE EXISTS (SELECT 1 FROM json_array_elements(COALESCE(playlist_document.data -> 'Shares', '[]'::json)) share
        WHERE ${guidKey("share -> 'UserId'")} = ${user})
    END
  ))`;
}

function physicalFolderIds(collection, items, byId) {
  if (collection.PhysicalFolderIds?.length) return collection.PhysicalFolderIds;
  const locations = [...(collection.PhysicalLocations ?? []), ...(collection.PhysicalLocationsList ?? [])];
  const ids = [];
  for (const location of locations) {
    const matches = items.filter(candidate => candidate.IsFolder && candidate.Type !== 'CollectionFolder'
      && sameNativePath(candidate.Path, location));
    const physical = matches.find(candidate => byId.get(idKey(candidate.ParentId))?.Type === 'AggregateFolder')
      ?? matches.find(candidate => sameId(candidate.Id, candidate.TopParentId)) ?? matches[0];
    if (physical) ids.push(physical.Id);
  }
  return ids;
}

function searchIds(ids) {
  return [...new Set(ids.filter(nonemptyId).flatMap(idVariants))];
}

/** Build the small policy frame consumed by the relational playlist selector. */
export function buildPostgresPlaylistVisibility(navigationRows, user, libraryOptions) {
  if (!user) return null;
  const items = navigationRows.map(row => row?.NativeType ? row : mapRecord(row)).filter(Boolean);
  const byId = new Map(items.map(item => [idKey(item.Id), item]));
  const collections = items.filter(item => item.Type === 'CollectionFolder');
  const allTopParentIds = [];
  const allowedTopParentIds = [];
  const collectionBlockedTopParentIds = [];
  const collectionAllowedTopParentIds = [];
  const blockedTags = (user.Policy.BlockedTags ?? []).filter(tag => tag.trim()).map(cleanValue);
  const allowedTags = (user.Policy.AllowedTags ?? []).filter(tag => tag.trim()).map(cleanValue);
  for (const collection of collections) {
    const scopeIds = [collection.Id, ...physicalFolderIds(collection, items, byId)];
    allTopParentIds.push(...scopeIds);
    if (visibleLibrary(collection, user, libraryOptions)) allowedTopParentIds.push(...scopeIds);
    const tags = (collection.Tags ?? []).map(cleanValue);
    if (blockedTags.some(tag => tags.includes(tag))) collectionBlockedTopParentIds.push(...scopeIds);
    if (allowedTags.some(tag => tags.includes(tag))) collectionAllowedTopParentIds.push(...scopeIds);
  }
  const policy = user.Policy;
  return Object.freeze({
    userId: user.Id,
    allTopParentIds: searchIds(allTopParentIds),
    allowedTopParentIds: searchIds(allowedTopParentIds),
    collectionBlockedTopParentIds: searchIds(collectionBlockedTopParentIds),
    collectionAllowedTopParentIds: searchIds(collectionAllowedTopParentIds),
    blockedTags,
    allowedTags,
    maxRating: user.MaxParentalRatingScore ?? policy.MaxParentalRatingScore ?? policy.MaxParentalRating ?? null,
    maxSubRating: user.MaxParentalRatingSubScore ?? policy.MaxParentalRatingSubScore ?? policy.MaxParentalSubRating ?? null,
    blockUnratedTypes: policy.BlockUnratedItems ?? [],
  });
}

/**
 * Load the finite graph used by playlist operations. The graph contains only
 * navigation entities, explicit operation seeds, requested playlists and the
 * playlists' linked children; it never reads the complete BaseItems table.
 */
export async function loadPostgresPlaylistStateRows(database, {
  ids = [],
} = {}) {
  const requestedIds = uniqueIds(ids);
  const requestedRows = await loadPostgresRowsByIds(database, requestedIds);
  const navigationRows = await loadPostgresNavigationRows(database);
  return loadPostgresPageGraph(database, requestedRows, navigationRows, { includeManualLinks: true });
}

export async function postgresPlaylistItemExists(database, id) {
  const result = await database.client.query({
    text: `SELECT 1 FROM ${table(database, 'BaseItems')}
      WHERE ${nativeTextSql(database.schemaName).guidLower("\"Id\"")} = ANY($1::text[]) LIMIT 1`,
    values: [idVariants(id)],
  });
  return result.rowCount > 0;
}

/** Reload a bounded candidate batch as playlist shells in one statement. */
export async function queryPostgresPlaylistShellBatch(database, ids) {
  const requested = uniqueIds(ids).map(idKey);
  if (!requested.length) return [];
  const result = await database.client.query({
    text: `SELECT playlist.*
      FROM ${table(database, 'BaseItems')} playlist
      WHERE ${leafType(database, 'playlist')} = 'Playlist'
        AND replace(${nativeTextSql(database.schemaName).guidLower("playlist.\"Id\"")}, '-', '') = ANY($1::text[])
      ORDER BY playlist."Id"`,
    values: [requested],
  });
  return result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    const column = tableDefinition(Object.hasOwn(row, 'Type') ? 'BaseItems' : 'LinkedChildren').columns.find(column => column.name === key);
    return [key, column ? decodeValue(column, value) : value];
  })));
}

function playlistVisibilityPredicate(database, visibility, bind, alias = 'selected', {
  partitionByPlaylist = false,
} = {}) {
  if (!visibility) return 'TRUE';
  const baseItems = table(database, 'BaseItems');
  const itemValues = table(database, 'ItemValues');
  const itemValuesMap = table(database, 'ItemValuesMap');
  const predicates = [];
  const relatedOccurrence = ancestryAlias => `${ancestryAlias}."__SortOrder" = ${alias}."__SortOrder"${partitionByPlaylist
    ? ` AND ${ancestryAlias}."__PlaylistKey" = ${alias}."__PlaylistKey"` : ''}`;
  const scopeId = `COALESCE(${nativeTextSql(database.schemaName).guidLower(`${alias}."TopParentId"`)}, ${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)})`;
  const scopeMatches = parameter => `(${scopeId} = ANY(${parameter}) OR ${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)} = ANY(${parameter})
    OR EXISTS (SELECT 1 FROM ancestry scope_ancestor
      WHERE ${relatedOccurrence('scope_ancestor')}
        AND ${nativeTextSql(database.schemaName).guidLower("scope_ancestor.\"Id\"")} = ANY(${parameter})))`;
  if (visibility.allTopParentIds.length) {
    const all = `${bind(visibility.allTopParentIds)}::text[]`;
    const allowed = `${bind(visibility.allowedTopParentIds)}::text[]`;
    predicates.push(`(NOT ${scopeMatches(all)} OR ${scopeMatches(allowed)})`);
  }
  if (visibility.collectionBlockedTopParentIds.length) {
    const blocked = `${bind(visibility.collectionBlockedTopParentIds)}::text[]`;
    predicates.push(`NOT ${scopeMatches(blocked)}`);
  }
  const inheritedTagExists = tags => {
    const parameter = `${bind(tags.map(nativeTextBytes))}::bytea[]`;
    const normalized = `${q(database.schemaName)}.${q(postgresCleanValueFunctionName)}(${nativeTextSql(database.schemaName).fromProjection('raw_tag')})`;
    return `EXISTS (
      SELECT 1 FROM ancestry tag_ancestor
      WHERE ${relatedOccurrence('tag_ancestor')} AND (
        EXISTS (SELECT 1 FROM regexp_split_to_table(COALESCE(${nativeTextSql(database.schemaName).projection('tag_ancestor."Tags"')}, ''), '[|]') raw_tag
          WHERE ${normalized} = ANY(${parameter}))
        OR EXISTS (
          SELECT 1 FROM ${itemValuesMap} tag_map
          JOIN ${itemValues} tag_value ON ${nativeTextSql(database.schemaName).guidLower("tag_value.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("tag_map.\"ItemValueId\"")}
          WHERE ${nativeTextSql(database.schemaName).guidLower("tag_map.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("tag_ancestor.\"Id\"")}
            AND tag_value."Type" = 4 AND tag_value."CleanValue" = ANY(${parameter})
        )
      )
    )`;
  };
  if (visibility.blockedTags.length) predicates.push(`NOT ${inheritedTagExists(visibility.blockedTags)}`);
  if (visibility.allowedTags.length) {
    const collectionAllowed = visibility.collectionAllowedTopParentIds.length
      ? ` OR ${scopeMatches(`${bind(visibility.collectionAllowedTopParentIds)}::text[]`)}`
      : '';
    const parentExempt = `EXISTS (SELECT 1 FROM ${baseItems} direct_parent
      WHERE ${nativeTextSql(database.schemaName).guidLower("direct_parent.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."ParentId"`)}
        AND ${leafType(database, 'direct_parent')} = ANY(${bind(['UserRootFolder', 'AggregateFolder', 'UserView'])}::text[]))`;
    predicates.push(`(${leafType(database, alias)} = 'Person' OR ${parentExempt}
      OR ${inheritedTagExists(visibility.allowedTags)}${collectionAllowed})`);
  }
  if (visibility.maxRating != null) {
    const maximum = bind(visibility.maxRating);
    const subScore = visibility.maxSubRating == null ? null : bind(visibility.maxSubRating);
    predicates.push(`NOT EXISTS (
      SELECT 1 FROM ancestry rating_ancestor
      WHERE ${relatedOccurrence('rating_ancestor')}
        AND rating_ancestor."InheritedParentalRatingValue" IS NOT NULL
        AND (rating_ancestor."InheritedParentalRatingValue" > ${maximum}
          ${subScore == null ? '' : `OR (rating_ancestor."InheritedParentalRatingValue" = ${maximum}
            AND COALESCE(rating_ancestor."InheritedParentalRatingSubValue", 0) > ${subScore})`})
    )`);
  }
  if (visibility.blockUnratedTypes.length) {
    const blocked = `${bind(visibility.blockUnratedTypes.map(nativeTextBytes))}::bytea[]`;
    const nameTypes = `${bind(['Person', 'Genre', 'MusicGenre', 'MusicArtist', 'Studio'])}::text[]`;
    predicates.push(`NOT EXISTS (
      SELECT 1 FROM ancestry unrated_ancestor
      WHERE ${relatedOccurrence('unrated_ancestor')}
        ${visibility.checkParentUnrated === false ? `AND ${nativeTextSql(database.schemaName).guidLower("unrated_ancestor.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)}` : ''}
        AND unrated_ancestor."InheritedParentalRatingValue" IS NULL
        AND unrated_ancestor."UnratedType" = ANY(${blocked})
        AND ((unrated_ancestor."IsFolder" IS NOT TRUE AND ${leafType(database, 'unrated_ancestor')} <> ALL(${nameTypes}))
          OR ${leafType(database, 'unrated_ancestor')} = ANY(${bind(['BoxSet', 'Series', 'MusicAlbum'])}::text[]))
    )`);
  }
  return predicates.length ? predicates.map(predicate => `(${predicate})`).join('\n        AND ') : 'TRUE';
}

/**
 * Apply the playlist occurrence filter, stable link order, count and paging in
 * PostgreSQL. SortOrder identifies an occurrence, so duplicate ChildIds remain
 * observable exactly as stored.
 */
export async function queryPostgresPlaylistPage(database, playlistId, {
  visibility,
  startIndex,
  limit,
} = {}) {
  const offset = startIndex == null ? 0 : Math.max(0, startIndex);
  const pageLimit = limit == null ? null : Math.max(0, limit);
  const values = [];
  const bind = value => { values.push(value); return `$${values.length}`; };
  const parentIds = `${bind(idVariants(playlistId))}::text[]`;
  const visibilityPredicate = playlistVisibilityPredicate(database, visibility, bind);
  let pagination = '';
  if (pageLimit != null) {
    pagination += ` LIMIT ${bind(pageLimit)}`;
  }
  if (offset) pagination += ` OFFSET ${bind(offset)}`;
  const baseItems = table(database, 'BaseItems');
  const links = table(database, 'LinkedChildren');
  const result = await database.client.query({
    text: `WITH RECURSIVE selected AS (
        SELECT item.*, link."ParentId" AS "__LinkParentId", link."SortOrder" AS "__SortOrder",
          link."ChildId" AS "__ChildId", link."ChildType" AS "__ChildType"
        FROM ${links} link
        JOIN ${baseItems} item ON ${nativeTextSql(database.schemaName).guidLower("item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("link.\"ChildId\"")}
        WHERE ${nativeTextSql(database.schemaName).guidLower("link.\"ParentId\"")} = ANY(${parentIds})
      ), ancestry AS (
        SELECT selected."__SortOrder", selected."Id", selected."ParentId", selected."Tags",
          selected."InheritedParentalRatingValue", selected."InheritedParentalRatingSubValue",
          selected."UnratedType", selected."Type", selected."IsFolder",
          ARRAY[${nativeTextSql(database.schemaName).guidLower("selected.\"Id\"")}]::text[] AS "__Visited"
        FROM selected
        UNION ALL
        SELECT ancestry."__SortOrder", parent."Id", parent."ParentId", parent."Tags",
          parent."InheritedParentalRatingValue", parent."InheritedParentalRatingSubValue",
          parent."UnratedType", parent."Type", parent."IsFolder",
          ancestry."__Visited" || ${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")}
        FROM ancestry
        JOIN ${baseItems} parent ON ${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("ancestry.\"ParentId\"")}
        WHERE NOT ${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")} = ANY(ancestry."__Visited")
      ), visible AS (
        SELECT selected.* FROM selected WHERE ${visibilityPredicate}
      ), page AS (
        SELECT "__LinkParentId", "__SortOrder", "__ChildId", "__ChildType"
        FROM visible ORDER BY "__SortOrder" ASC${pagination}
      ), total AS (
        SELECT count(*)::bigint AS "TotalRecordCount" FROM visible
      )
      SELECT page."__LinkParentId" AS "ParentId", page."__SortOrder" AS "SortOrder",
        page."__ChildId" AS "ChildId", page."__ChildType" AS "ChildType", total."TotalRecordCount"
      FROM total LEFT JOIN page ON TRUE
      ORDER BY page."__SortOrder" ASC NULLS LAST`,
    values,
  });
  const total = result.rows.length ? Number(result.rows[0].TotalRecordCount) : 0;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('PostgreSQL returned an invalid playlist item count.');
  return {
    links: result.rows.filter(row => row.ChildId != null).map(row => ({
      ParentId: decodeNativeTextBytes(row.ParentId),
      SortOrder: row.SortOrder,
      ChildId: decodeNativeTextBytes(row.ChildId),
      ChildType: row.ChildType,
    })),
    total,
    startIndex: startIndex ?? 0,
  };
}

/**
 * Evaluate the native managed-playlist visibility gate without hydrating its
 * members. A rating-limited user may see a playlist only when it is empty or
 * at least one resolved child passes the parental checks.
 */
export async function queryPostgresPlaylistAccess(database, playlistRow, {
  user,
  dataPath,
  programDataPath,
  visibility,
} = {}) {
  const playlist = playlistRow?.NativeType ? playlistRow : mapRecord(playlistRow);
  if (!playlist || playlist.Type !== 'Playlist') return false;
  if (!user) return true;
  const effectiveDataPath = dataPath ?? (programDataPath && path.join(programDataPath, 'data'));
  const shared = playlist.Path && effectiveDataPath && nativeContainsSubPath(playlist.Path, effectiveDataPath);
  if (shared) {
    const shares = playlist.Shares === undefined ? [] : playlist.Shares;
    if (!Array.isArray(shares)) throw new TypeError('Invalid Playlist.Shares.');
    if (!(playlist.OpenAccess || sameId(user.Id, playlist.OwnerUserId)
      || shares.some(share => sameId(share.UserId, user.Id)))) return false;
  }
  // Non-managed playlists use the ordinary standalone-item policy. The SQL
  // selector below applies that policy to their members; the playlist shell is
  // still bounded and its normal ancestor checks are handled by the caller.
  const maximum = visibility?.maxRating;
  if (maximum == null) return true;
  const parentalVisibility = {
    ...visibility,
    allTopParentIds: [],
    allowedTopParentIds: [],
    allowedTags: [],
    checkParentUnrated: false,
  };
  const allowed = await queryPostgresPlaylistPage(database, playlist.Id, {
    visibility: parentalVisibility,
    limit: 1,
  });
  if (allowed.total > 0) return true;
  const result = await database.client.query({
    text: `SELECT EXISTS (
      SELECT 1 FROM ${table(database, 'LinkedChildren')} link
      JOIN ${table(database, 'BaseItems')} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("link.\"ChildId\"")}
      WHERE ${nativeTextSql(database.schemaName).guidLower("link.\"ParentId\"")} = ANY($1::text[])
    ) AS "HasResolvedChild"`,
    values: [idVariants(playlist.Id)],
  });
  return result.rows[0]?.HasResolvedChild !== true;
}

/**
 * Evaluate the managed-playlist shell gate and parental member gate for a
 * bounded page of playlists in one relational query.
 */
export async function queryPostgresPlaylistAccessBatch(database, playlistRows, {
  user,
  dataPath,
  programDataPath,
  visibility,
} = {}) {
  if (!Array.isArray(playlistRows)) throw new TypeError('Playlist rows must be an array.');
  const access = new Map();
  const pending = new Map();
  const effectiveDataPath = dataPath ?? (programDataPath && path.join(programDataPath, 'data'));
  for (const row of playlistRows) {
    const playlist = row?.NativeType ? row : mapRecord(row);
    const key = idKey(playlist?.Id);
    if (!playlist || playlist.Type !== 'Playlist') {
      if (key) access.set(key, false);
      continue;
    }
    if (!user) {
      access.set(key, true);
      continue;
    }
    const shared = playlist.Path && effectiveDataPath
      && nativeContainsSubPath(playlist.Path, effectiveDataPath);
    if (shared) {
      const shares = playlist.Shares === undefined ? [] : playlist.Shares;
      if (!Array.isArray(shares)) throw new TypeError('Invalid Playlist.Shares.');
      if (!(playlist.OpenAccess || sameId(user.Id, playlist.OwnerUserId)
        || shares.some(share => sameId(share.UserId, user.Id)))) {
        access.set(key, false);
        continue;
      }
    }
    if (visibility?.maxRating == null) {
      access.set(key, true);
      continue;
    }
    if (!pending.has(key)) pending.set(key, playlist);
  }
  if (!pending.size) return access;

  const parentalVisibility = {
    ...visibility,
    allTopParentIds: [],
    allowedTopParentIds: [],
    allowedTags: [],
    checkParentUnrated: false,
  };
  const values = [];
  const bind = value => { values.push(value); return `$${values.length}`; };
  const requestedIds = [...pending.keys()];
  const requested = `${bind(requestedIds)}::text[]`;
  const visibilityPredicate = playlistVisibilityPredicate(database, parentalVisibility, bind,
    'selected', { partitionByPlaylist: true });
  const baseItems = table(database, 'BaseItems');
  const links = table(database, 'LinkedChildren');
  const result = await database.client.query({
    text: `WITH RECURSIVE requested("PlaylistKey") AS (
        SELECT DISTINCT value COLLATE "C" FROM unnest(${requested}) value
      ), selected AS (
        SELECT requested."PlaylistKey" AS "__PlaylistKey", item.*,
          link."SortOrder" AS "__SortOrder"
        FROM requested
        JOIN ${links} link
          ON replace(${nativeTextSql(database.schemaName).guidLower("link.\"ParentId\"")}, '-', '') = requested."PlaylistKey"
        JOIN ${baseItems} item ON ${nativeTextSql(database.schemaName).guidLower("item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("link.\"ChildId\"")}
      ), ancestry AS (
        SELECT selected."__PlaylistKey", selected."__SortOrder", selected."Id",
          selected."ParentId", selected."Tags", selected."InheritedParentalRatingValue",
          selected."InheritedParentalRatingSubValue", selected."UnratedType", selected."Type",
          selected."IsFolder", ARRAY[${nativeTextSql(database.schemaName).guidLower("selected.\"Id\"")}]::text[] AS "__Visited"
        FROM selected
        UNION ALL
        SELECT ancestry."__PlaylistKey", ancestry."__SortOrder", parent."Id",
          parent."ParentId", parent."Tags", parent."InheritedParentalRatingValue",
          parent."InheritedParentalRatingSubValue", parent."UnratedType", parent."Type",
          parent."IsFolder", ancestry."__Visited" || ${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")}
        FROM ancestry
        JOIN ${baseItems} parent ON ${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("ancestry.\"ParentId\"")}
        WHERE NOT ${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")} = ANY(ancestry."__Visited")
      ), visible AS (
        SELECT selected."__PlaylistKey", selected."__SortOrder"
        FROM selected
        WHERE ${visibilityPredicate}
      )
      SELECT requested."PlaylistKey",
        EXISTS (SELECT 1 FROM visible
          WHERE visible."__PlaylistKey" = requested."PlaylistKey") AS "HasAllowedChild",
        EXISTS (SELECT 1 FROM selected
          WHERE selected."__PlaylistKey" = requested."PlaylistKey") AS "HasResolvedChild"
      FROM requested
      ORDER BY requested."PlaylistKey" COLLATE "C"`,
    values,
  });
  for (const row of result.rows) {
    access.set(row.PlaylistKey, row.HasAllowedChild === true || row.HasResolvedChild !== true);
  }
  return access;
}

/** Select one stable batch of managed playlists visible to a deleted user. */
export async function queryPostgresDeletedUserPlaylistBatch(database, {
  userId,
  playlistFolderId,
  afterId = '',
  limit = 32,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Playlist cleanup batch size must be positive.');
  const guidKey = expression => `${table(database, postgresNativeJsonGuidKeyFunctionName)}(${expression})`;
  const result = await database.client.query({
    text: `SELECT playlist."Id",
        CASE WHEN json_typeof(document.data -> 'OpenAccess') = 'boolean'
          THEN (document.data ->> 'OpenAccess')::boolean ELSE FALSE END AS "OpenAccess",
        CASE WHEN json_typeof(document.data -> 'Shares') = 'array'
          THEN document.data -> 'Shares' ELSE '[]'::json END AS "Shares"
      FROM ${table(database, 'BaseItems')} playlist
      CROSS JOIN LATERAL (SELECT ${table(database, postgresSafeNativeItemDataFunctionName)}(
        playlist."Type", playlist."Data") AS data) document
      WHERE ${leafType(database, 'playlist')} = 'Playlist'
        AND ${nativeTextSql(database.schemaName).guidLower("playlist.\"ParentId\"")} = ANY($1::text[])
        AND replace(${nativeTextSql(database.schemaName).guidLower("playlist.\"Id\"")}, '-', '') > $2
        AND (
          CASE WHEN json_typeof(document.data -> 'OpenAccess') = 'boolean'
            THEN (document.data ->> 'OpenAccess')::boolean ELSE FALSE END
          OR ${guidKey("document.data -> 'OwnerUserId'")} = $3
          OR EXISTS (
            SELECT 1
            FROM json_array_elements(CASE WHEN json_typeof(document.data -> 'Shares') = 'array'
              THEN document.data -> 'Shares' ELSE '[]'::json END) share
            WHERE ${guidKey("share -> 'UserId'")} = $3
          )
        )
      ORDER BY replace(${nativeTextSql(database.schemaName).guidLower("playlist.\"Id\"")}, '-', '') ASC
      LIMIT $4`,
    values: [idVariants(playlistFolderId), idKey(afterId), idKey(userId), limit],
  });
  return result.rows.filter(row => row.Id != null).map(row => ({
    Id: decodeNativeTextBytes(row.Id),
    OpenAccess: row.OpenAccess === true,
    Shares: row.Shares,
  }));
}
