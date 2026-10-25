import { nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { quoteIdentifier as q } from '../database/model.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { postgresNativeJsonEnumFunctionName, postgresNativeJsonGuidKeyFunctionName,
  } from '../database/postgres-runtime-schema.js';
import { nativeItemTypes } from './native-item-entity.js';
import { idKey } from './records.js';

const table = (database, name = 'BaseItems') => `${q(database.schemaName)}.${q(name)}`;
const data = (database, alias) => `(${nativeTextSql(database.schemaName).safeItemData(`${alias}."Type"`, `${alias}."Data"`)})::text`;
const bytesLiteral = value => `decode('${Buffer.from(value, 'utf8').toString('hex')}', 'hex')`;

/** Folder.Children uses default repository selection and ordering. The result
 * stays relational until the task reads one root page; unknown types are
 * omitted as they are by native repository hydration. */
export function buildPostgresCollectionRootQuery(database, root) {
  const selected = buildPostgresItemPageQuery(database, {}, { scope: { parentId: root.Id }, includeOrdinal: true });
  return { text: `/* collection-root-selection */ SELECT selected."__ordinal" AS "Ordinal",
    item."Id", item."Name", item."Type", item."Path", item."ParentId"
    FROM (${selected.text}) selected JOIN ${table(database)} item ON item."Id" = selected."Id"
    WHERE item."Type" = ANY($${selected.values.length + 1}::bytea[])
    ORDER BY selected."__ordinal"`, values: [...selected.values, nativeItemTypes.map(nativeTextBytes)] };
}

function viewScope(database, parent) {
  const nativeItems = table(database), nativeAncestors = table(database, 'AncestorIds');
  const items = q('collection_scope_items'), ancestors = q('collection_scope_ancestors');
  const sql = nativeTextSql(database.schemaName);
  const key = value => {
    const match = /^(item|next|aggregate|ancestor)\."(Id|ParentId|TopParentId|ParentItemId)"$/u.exec(value);
    return match ? match[1] + '."' + match[2] + 'Key"' : sql.guidKey(value);
  };
  const nonempty = value => `NULLIF(NULLIF(${key(value)}, ''), '00000000000000000000000000000000')`;
  const guidKey = value => `${q(database.schemaName)}.${q(postgresNativeJsonGuidKeyFunctionName)}((${value})::json)`;
  const display = alias => `NULLIF(${guidKey(`${alias}."Data"::json -> 'DisplayParentId'`)}, '00000000000000000000000000000000')`;
  const collectionType = (alias, name) => `${q(database.schemaName)}.${q(postgresNativeJsonEnumFunctionName)}((${alias}."Data"::json -> '${name}')::json, 'CollectionType')`;
  return { text: `WITH RECURSIVE ${items} AS MATERIALIZED (
      SELECT source.*, ${sql.guidKey('source."Id"')} AS "IdKey",
        ${sql.guidKey('source."ParentId"')} AS "ParentIdKey", ${sql.guidKey('source."TopParentId"')} AS "TopParentIdKey"
      FROM ${nativeItems} source
    ), ${ancestors} AS MATERIALIZED (
      SELECT source.*, ${sql.guidKey('source."ParentItemId"')} AS "ParentItemIdKey" FROM ${nativeAncestors} source
    ), parent AS (
      SELECT item."Id", item."ParentId", item."Type", ${data(database, 'item')} AS "Data" FROM ${items} item
      WHERE ${key('item."Id"')} = $1
    ), view_walk("Id", "ParentId", "Type", "Data") AS (
      SELECT * FROM parent UNION
      SELECT next."Id", next."ParentId", next."Type", ${data(database, 'next')}
      FROM view_walk current JOIN ${items} next ON ${key('next."Id"')} =
        COALESCE(${display('current')}, ${nonempty('current."ParentId"')})
      WHERE current."Type" = ${bytesLiteral("MediaBrowser.Controller.Entities.UserView")}
        AND ${collectionType('current', 'ViewType')} IS DISTINCT FROM 'livetv'
        AND next."Type" = ANY($2::bytea[])
    ), resolved AS (
      SELECT * FROM view_walk WHERE "Type" <> ${bytesLiteral("MediaBrowser.Controller.Entities.UserView")}
        OR ${collectionType('view_walk', 'ViewType')} = 'livetv'
    ), ancestry("Id", "ParentId", "Type", "Data", "Depth", "Seen") AS (
      SELECT "Id", "ParentId", "Type", "Data", 0, ARRAY[${key('"Id"')}] FROM resolved
      WHERE "Type" <> ${bytesLiteral("MediaBrowser.Controller.Entities.CollectionFolder")}
      UNION ALL
      SELECT next."Id", next."ParentId", next."Type", ${data(database, 'next')}, current."Depth" + 1,
        current."Seen" || ${key('next."Id"')}
      FROM ancestry current JOIN ${items} next ON ${key('next."Id"')} = ${key('current."ParentId"')}
      WHERE NOT (${key('next."Id"')} = ANY(current."Seen")) AND next."Type" = ANY($2::bytea[])
    ), top_parent AS (
      SELECT ancestry."Id" FROM ancestry WHERE "Type" IN
        (${bytesLiteral("MediaBrowser.Controller.Entities.BasePluginFolder")}, ${bytesLiteral("Emby.Server.Implementations.Playlists.PlaylistsFolder")},
          ${bytesLiteral("MediaBrowser.Controller.Channels.Channel")})
        OR ${collectionType('ancestry', 'ViewType')} = 'livetv' OR ${collectionType('ancestry', 'CollectionType')} = 'livetv'
        OR EXISTS (SELECT 1 FROM ${items} aggregate WHERE ${key('aggregate."Id"')} = ${key('ancestry."ParentId"')}
          AND aggregate."Type" = ${bytesLiteral("MediaBrowser.Controller.Entities.AggregateFolder")})
      ORDER BY "Depth" LIMIT 1
    ), physical AS (
      SELECT ${guidKey('entry."Id"')} AS "Id" FROM resolved
      CROSS JOIN LATERAL json_array_elements(COALESCE(resolved."Data"::json -> 'PhysicalFolderIds', '[]'::json)) entry("Id")
      WHERE resolved."Type" = ${bytesLiteral("MediaBrowser.Controller.Entities.CollectionFolder")}
      UNION SELECT ${key('"Id"')} FROM top_parent
    ) SELECT item."Id" FROM ${items} item WHERE
      (EXISTS (SELECT 1 FROM physical) AND EXISTS (
        SELECT 1 FROM physical WHERE physical."Id" = ${key('item."TopParentId"')}))
      OR (NOT EXISTS (SELECT 1 FROM physical) AND EXISTS (
        SELECT 1 FROM ${ancestors} ancestor CROSS JOIN parent
        WHERE ${key('ancestor."ParentItemId"')} = CASE WHEN parent."Type" = ${bytesLiteral("MediaBrowser.Controller.Entities.UserView")}
          THEN COALESCE(${display('parent')}, ${nonempty('parent."ParentId"')}, ${key('parent."Id"')})
          ELSE ${key('parent."Id"')} END
        AND ${nativeTextSql(database.schemaName).sqliteAsciiLowerKey('ancestor."ItemId"')} = ${nativeTextSql(database.schemaName).sqliteAsciiLowerKey('item."Id"')}))`, values: [idKey(parent.Id), nativeItemTypes.map(nativeTextBytes)] };
}

function linkedContainerScope(database, parent) {
  const nativeItems = table(database), nativeAncestors = table(database, 'AncestorIds'), nativeLinks = table(database, 'LinkedChildren');
  const items = q('collection_linked_items'), ancestors = q('collection_linked_ancestors'), links = q('collection_linked_links');
  const sql = nativeTextSql(database.schemaName);
  const key = value => value.replace(/"(Id|ItemId|ParentItemId|ParentId|ChildId)"$/u, '"$1Key"');
  // The native descendant helper expands two closure levels and follows links
  // only from folders. It does not repair missing AncestorIds from ParentId.
  const closure = roots => `SELECT ${key('direct."ItemId"')} AS "Id" FROM ${ancestors} direct
      WHERE ${key('direct."ParentItemId"')} = ANY(${roots})
    UNION SELECT ${key('indirect."ItemId"')} FROM ${ancestors} direct JOIN ${ancestors} indirect
      ON ${key('indirect."ParentItemId"')} = ${key('direct."ItemId"')} WHERE ${key('direct."ParentItemId"')} = ANY(${roots})`;
  return { text: `WITH RECURSIVE ${items} AS MATERIALIZED (
      SELECT source."Id", source."IsFolder", ${sql.guidKey('source."Id"')} AS "IdKey" FROM ${nativeItems} source
    ), ${ancestors} AS MATERIALIZED (
      SELECT source.*, ${sql.guidKey('source."ItemId"')} AS "ItemIdKey",
        ${sql.guidKey('source."ParentItemId"')} AS "ParentItemIdKey" FROM ${nativeAncestors} source
    ), ${links} AS MATERIALIZED (
      SELECT source.*, ${sql.guidKey('source."ParentId"')} AS "ParentIdKey",
        ${sql.guidKey('source."ChildId"')} AS "ChildIdKey" FROM ${nativeLinks} source
    ), root AS (SELECT ${key('"Id"')} AS "Id" FROM ${items} WHERE ${key('"Id"')} = $1),
    state("Visited", "ClosureRoots", "Frontier") AS (
      SELECT ARRAY["Id"], ARRAY["Id"], ARRAY["Id"] FROM root UNION ALL
      SELECT current."Visited" || next."Ids", current."ClosureRoots" || next."ClosureIds", next."Ids"
      FROM state current CROSS JOIN LATERAL (
        WITH closure_ids AS (${closure('current."Frontier"')}), linked AS (
          SELECT ${key('link."ChildId"')} AS "Id" FROM ${links} link WHERE ${key('link."ParentId"')} = ANY(current."Frontier")
        ), linked_folders AS (
          SELECT ${key('folder."Id"')} AS "Id" FROM ${items} folder
          WHERE folder."IsFolder" IS TRUE AND ${key('folder."Id"')} IN (SELECT "Id" FROM linked)
        ), owners AS (
          SELECT ${key('owner."Id"')} AS "Id" FROM ${items} owner WHERE owner."IsFolder" IS TRUE
            AND EXISTS (SELECT 1 FROM ${links} link WHERE ${key('link."ParentId"')} = ${key('owner."Id"')})
            AND (${key('owner."Id"')} IN (SELECT "Id" FROM closure_ids) OR ${key('owner."Id"')} IN (SELECT "Id" FROM linked))
        ), unseen AS (
          SELECT "Id" FROM (SELECT "Id" FROM owners UNION SELECT "Id" FROM linked_folders) selected
          WHERE NOT ("Id" = ANY(current."Visited"))
        ) SELECT COALESCE(array_agg(unseen."Id" ORDER BY unseen."Id"), ARRAY[]::text[]) AS "Ids",
          COALESCE(array_agg(unseen."Id" ORDER BY unseen."Id") FILTER (WHERE EXISTS (
            SELECT 1 FROM linked_folders WHERE linked_folders."Id" = unseen."Id")), ARRAY[]::text[]) AS "ClosureIds" FROM unseen
      ) next WHERE cardinality(current."Frontier") > 0
    ), final_state AS (SELECT * FROM state WHERE cardinality("Frontier") = 0), descendants AS (
      SELECT selected."Id" FROM final_state current CROSS JOIN LATERAL (${closure('current."ClosureRoots"')}) selected
      UNION SELECT ${key('link."ChildId"')} FROM final_state current JOIN ${links} link
        ON ${key('link."ParentId"')} = ANY(current."Visited")
    ) SELECT item."Id" FROM descendants selected JOIN ${items} item ON ${key('item."Id"')} = selected."Id" CROSS JOIN root
      WHERE selected."Id" <> root."Id" AND EXISTS (SELECT 1 FROM ${links} link WHERE ${key('link."ParentId"')} = root."Id")
    UNION SELECT ancestor."ItemId" FROM ${ancestors} ancestor JOIN root ON root."Id" = ${key('ancestor."ParentItemId"')}
      WHERE NOT EXISTS (SELECT 1 FROM ${links} link WHERE ${key('link."ParentId"')} = root."Id")`, values: [idKey(parent.Id)] };
}

/** Movie getters are projected after native repository filtering and paging.
 * PrimaryVersionId and empty CollectionName must not shrink the 1000-row page.
 * Ordinal is page-local, matching the task's StartIndex + Ordinal sequence. */
export function buildPostgresCollectionMoviePageQuery(database, parent, query) {
  if (!Number.isSafeInteger(query?.StartIndex) || query.StartIndex < 0
    || !Number.isSafeInteger(query?.Limit) || query.Limit < 1 || query.Limit > 1000) {
    throw new TypeError('Collection Movie pages require a nonnegative offset and a limit from 1 to 1000.');
  }
  const type = String(parent.NativeType ?? parent.Type ?? '').split('.').at(-1);
  const scoped = ['CollectionFolder', 'UserView', 'PlaylistsFolder'].includes(type) ? viewScope(database, parent)
    : ['BoxSet', 'Playlist'].includes(type) ? linkedContainerScope(database, parent) : null;
  const selected = buildPostgresItemPageQuery(database, {
    includeitemtypes: ['Movie'], mediatypes: ['Video'], ismissing: false,
    sortby: ['SortName'], sortorder: ['Ascending'], recursive: true,
    startindex: query.StartIndex, limit: query.Limit,
  }, { scope: scoped ? {} : { ancestorIds: [parent.Id] }, itemIdsPlan: scoped,
    includeOrdinal: true });
  return { text: `/* collection-movie-selection */ SELECT selected."__ordinal" AS "Ordinal", item."Id", item."PrimaryVersionId",
    ${nativeTextSql(database.schemaName).jsonTextBytes(`(${data(database, 'item')})::json`, "'TmdbCollectionName'")} AS "CollectionName"
    FROM (${selected.text}) selected JOIN ${table(database)} item ON item."Id" = selected."Id"
    ORDER BY selected."__ordinal"`, values: selected.values };
}

export function buildPostgresCollectionBoxSetQuery(database) {
  const selected = buildPostgresItemPageQuery(database, { includeitemtypes: ['BoxSet'],
    collapseboxsetitems: false, recursive: true }, { includeOrdinal: true });
  return { text: `/* collection-box-set-selection */ SELECT selected."__ordinal" AS "Ordinal", item."Id", item."Name"
    FROM (${selected.text}) selected JOIN ${table(database)} item ON item."Id" = selected."Id"
    ORDER BY selected."__ordinal"`, values: selected.values };
}

/** Live option lookup is an explicit bounded root operation. In production the
 * callback reads the root's current library context, rather than treating the
 * SQL scalar projection or an old options snapshot as an entity. */
export function createPostgresCollectionMaintenanceSource({ host, getLibraryOptions }) {
  if (typeof host?.getAggregateFolder !== 'function' || typeof getLibraryOptions !== 'function') {
    throw new TypeError('Collection selection requires an aggregate root and live library options.');
  }
  return Object.freeze({
    getRootFolder: () => host.getAggregateFolder(), getLibraryOptions,
    rootQuery: buildPostgresCollectionRootQuery,
    moviePageQuery: buildPostgresCollectionMoviePageQuery,
    boxSetQuery: buildPostgresCollectionBoxSetQuery,
  });
}
