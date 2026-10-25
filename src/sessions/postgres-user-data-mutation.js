import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql, postgresColumnType } from '../database/native-text-sql.js';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue, encodeValue } from '../database/values.js';

function postgresTable(database, name) {
  if (database?.dialect !== 'postgres'
    || !/^[A-Za-z_][A-Za-z0-9_]{0,39}$/u.test(database.schemaName ?? '')) {
    throw new TypeError('A PostgreSQL database with an explicit schema is required.');
  }
  return `${q(database.schemaName)}.${q(name)}`;
}

const normalizedGuid = (database, expression) => nativeTextSql(database.schemaName).guidKey(expression);

export async function loadPostgresUserDataRows(database, userId, itemIds) {
  const itemKeys = [...new Set(itemIds.map(value => String(value).replaceAll('-', '').toLowerCase()))];
  if (!itemKeys.length) return [];
  const table = tableDefinition('UserData');
  const userPredicate = userId == null ? '' : `
      AND ${normalizedGuid(database, 'data."UserId"')} = $2`;
  const result = await database.client.query(`
    SELECT ${table.columns.map(column => q(column.name)).join(', ')}
    FROM ${postgresTable(database, 'UserData')} data
    WHERE ${normalizedGuid(database, 'data."ItemId"')} = ANY($1::text[])${userPredicate}
    ORDER BY data."ItemId", data."UserId", data."CustomDataKey"`, userId == null ? [itemKeys] : [
    itemKeys, String(userId).replaceAll('-', '').toLowerCase(),
  ]);
  return result.rows.map(row => Object.fromEntries(table.columns.map(column => [
    column.name,
    decodeValue(column, row[column.name], 'postgres'),
  ])));
}

export async function loadPostgresUserDataKeyItems(database, itemIds) {
  const itemKeys = [...new Set(itemIds.map(value => String(value).replaceAll('-', '').toLowerCase()))];
  if (!itemKeys.length) return [];
  const items = postgresTable(database, 'BaseItems');
  const providers = postgresTable(database, 'BaseItemProviders');
  const result = await database.client.query(`
    WITH RECURSIVE input("ItemKey") AS (
      SELECT DISTINCT value COLLATE "C" FROM unnest($1::text[]) value
    ),
    related("ItemKey") AS (
      SELECT "ItemKey" COLLATE "C" FROM input
      UNION
      SELECT ${normalizedGuid(database, 'parent."Id"')} COLLATE "C"
      FROM related
      JOIN ${items} child ON ${normalizedGuid(database, 'child."Id"')} = related."ItemKey"
      CROSS JOIN LATERAL (VALUES (child."ParentId"), (child."SeriesId")) reference("Id")
      JOIN ${items} parent ON ${normalizedGuid(database, 'parent."Id"')} = ${normalizedGuid(database, 'reference."Id"')}
    )
    SELECT item.*, provider."ProviderIds" AS "__ProviderIds"
    FROM related
    JOIN ${items} item ON ${normalizedGuid(database, 'item."Id"')} = related."ItemKey"
    LEFT JOIN LATERAL (
      SELECT array_agg(ARRAY[entry."ProviderId", entry."ProviderValue"]
        ORDER BY entry."ProviderId") AS "ProviderIds"
      FROM ${providers} entry
      WHERE ${normalizedGuid(database, 'entry."ItemId"')} = related."ItemKey"
    ) provider ON TRUE
    ORDER BY related."ItemKey" COLLATE "C"`, [itemKeys]);
  const table = tableDefinition('BaseItems');
  return result.rows.map(row => ({
    record: Object.fromEntries(table.columns.map(column => [
      column.name,
      decodeValue(column, row[column.name], 'postgres'),
    ])),
    providerIds: Object.fromEntries((row.__ProviderIds ?? []).map(pair =>
      pair.map(value => decodeNativeTextBytes(value)))),
  }));
}

export async function upsertPostgresUserDataRows(database, rows) {
  if (!rows.length) return;
  const table = tableDefinition('UserData');
  const columns = table.columns.filter(column => !column.generated);
  const primaryKeyIndices = table.primaryKey.map(key => columns.findIndex(column => column.name === key));
  const encodedRows = new Map();
  for (const row of rows) {
    const encoded = columns.map(column => encodeValue(column, row[column.name], 'postgres'));
    encodedRows.set(JSON.stringify(primaryKeyIndices.map(index => encoded[index])), encoded);
  }
  const uniqueRows = [...encodedRows.values()];
  const arrays = columns.map((_, index) => uniqueRows.map(row => row[index]));
  const declarations = columns.map((column, index) => `$${index + 1}::${postgresColumnType(column)}[]`).join(', ');
  const updateColumns = columns.filter(column => !table.primaryKey.includes(column.name));
  await database.client.query(`
    INSERT INTO ${postgresTable(database, 'UserData')}
      (${columns.map(column => q(column.name)).join(', ')})
    SELECT *
    FROM unnest(${declarations})
    ON CONFLICT (${table.primaryKey.map(q).join(', ')}) DO UPDATE SET
      ${updateColumns.map(column => `${q(column.name)} = EXCLUDED.${q(column.name)}`).join(', ')}`,
  arrays);
}

export async function loadPostgresItemVersionFamilyRelations(database, roots, videoTypes) {
  if (!roots.length) return [];
  const items = postgresTable(database, 'BaseItems');
  const links = postgresTable(database, 'LinkedChildren');
  const providers = postgresTable(database, 'BaseItemProviders');
  const result = await database.client.query(`
    WITH input("RootKey", "ItemKey", "PrimaryKey", "RootOrder") AS (
      SELECT ${normalizedGuid(database, 'source."ItemId"')}, ${normalizedGuid(database, 'source."ItemId"')},
        CASE WHEN source."PrimaryVersionId" IS NULL THEN NULL
          ELSE ${normalizedGuid(database, 'source."PrimaryVersionId"')} END,
        source.ordinality
      FROM unnest($1::bytea[], $2::bytea[]) WITH ORDINALITY
        AS source("ItemId", "PrimaryVersionId", ordinality)
    ),
    primary_item("RootKey", "ItemKey", "RootOrder") AS (
      SELECT input."RootKey", ${normalizedGuid(database, 'item."Id"')}, input."RootOrder"
      FROM input
      JOIN ${items} item
        ON ${normalizedGuid(database, 'item."Id"')} = input."PrimaryKey"
      WHERE input."PrimaryKey" IS NOT NULL
        AND substring(${nativeTextSql(database.schemaName).projection('item."Type"')} from '[^.]+$') = ANY($3::text[])
    ),
    remote_parents("RootKey", "ItemKey", "Block", "RootOrder") AS (
      SELECT "RootKey", "ItemKey", 0, "RootOrder" FROM input
      UNION ALL
      SELECT "RootKey", "ItemKey", 1, "RootOrder" FROM primary_item
    ),
    remote_links("RootKey", "RootOrder", "Block", "ParentKey", "ItemKey", "SortOrder", "SortName") AS (
      SELECT parent."RootKey", parent."RootOrder", parent."Block", parent."ItemKey",
        ${normalizedGuid(database, 'child."Id"')}, link."SortOrder", child."SortName"
      FROM remote_parents parent
      JOIN ${links} link
        ON ${normalizedGuid(database, 'link."ParentId"')} = parent."ItemKey"
        AND link."ChildType" = 3
      JOIN ${items} child
        ON ${normalizedGuid(database, 'child."Id"')} = ${normalizedGuid(database, 'link."ChildId"')}
        AND substring(${nativeTextSql(database.schemaName).projection('child."Type"')} from '[^.]+$') = ANY($3::text[])
    ),
    remote_ranked AS (
      SELECT remote_links.*,
        row_number() OVER (PARTITION BY "RootKey", "Block"
          ORDER BY COALESCE("SortName", ''::bytea), "SortOrder", "ItemKey" COLLATE "C") AS "RemoteOrder"
      FROM remote_links
    ),
    grouped_candidates("RootKey", "RootOrder", "Kind", "ItemKey", "Block", "WithinBlock") AS (
      SELECT "RootKey", "RootOrder", 'root', "ItemKey", 0, 0::bigint FROM input
      UNION ALL
      SELECT "RootKey", "RootOrder", 'remote', "ItemKey", "Block", "RemoteOrder" FROM remote_ranked
      UNION ALL
      SELECT "RootKey", "RootOrder", 'primary', "ItemKey", 1, 0::bigint FROM primary_item
    ),
    grouped_ordered AS (
      SELECT grouped_candidates.*,
        row_number() OVER (PARTITION BY "RootKey"
          ORDER BY "Block", "WithinBlock", "ItemKey" COLLATE "C") AS "GroupOrder"
      FROM grouped_candidates
    ),
    local_links("RootKey", "RootOrder", "Kind", "ItemKey", "ParentOrder", "SortOrder") AS (
      SELECT parent."RootKey", parent."RootOrder", 'local', ${normalizedGuid(database, 'child."Id"')},
        parent."GroupOrder", link."SortOrder"
      FROM grouped_ordered parent
      JOIN ${links} link
        ON ${normalizedGuid(database, 'link."ParentId"')} = parent."ItemKey"
        AND link."ChildType" = 2
      JOIN ${items} child
        ON ${normalizedGuid(database, 'child."Id"')} = ${normalizedGuid(database, 'link."ChildId"')}
        AND substring(${nativeTextSql(database.schemaName).projection('child."Type"')} from '[^.]+$') = ANY($3::text[])
    ),
    candidates("RootKey", "RootOrder", "Kind", "ItemKey", "Phase", "ParentOrder", "SortOrder") AS (
      SELECT "RootKey", "RootOrder", "Kind", "ItemKey", 0, "GroupOrder", 0 FROM grouped_ordered
      UNION ALL
      SELECT "RootKey", "RootOrder", "Kind", "ItemKey", 1, "ParentOrder", "SortOrder" FROM local_links
    ),
    sequenced AS (
      SELECT candidates.*,
        row_number() OVER (PARTITION BY "RootKey"
          ORDER BY "Phase", "ParentOrder", "SortOrder", "ItemKey" COLLATE "C") AS "VersionOrder"
      FROM candidates
    ),
    relations AS (
      SELECT sequenced.*,
        row_number() OVER (PARTITION BY "RootKey", "ItemKey" ORDER BY "VersionOrder") AS "DuplicateOrder"
      FROM sequenced
    )
    SELECT relation."RootKey" AS "__RootKey", relation."Kind" AS "__Kind",
      relation."VersionOrder" AS "__VersionOrder", item.*,
      provider."ProviderIds" AS "__ProviderIds"
    FROM relations relation
    JOIN ${items} item ON ${normalizedGuid(database, 'item."Id"')} = relation."ItemKey"
    LEFT JOIN LATERAL (
      SELECT array_agg(ARRAY[entry."ProviderId", entry."ProviderValue"]
        ORDER BY entry."ProviderId") AS "ProviderIds"
      FROM ${providers} entry
      WHERE ${normalizedGuid(database, 'entry."ItemId"')} = relation."ItemKey"
    ) provider ON TRUE
    WHERE relation."DuplicateOrder" = 1
    ORDER BY relation."RootOrder", relation."VersionOrder"`, [
    roots.map(root => nativeTextBytes(root.itemId)),
    roots.map(root => root.primaryVersionId == null ? null : nativeTextBytes(root.primaryVersionId)),
    videoTypes,
  ]);
  const table = tableDefinition('BaseItems');
  return result.rows.map(row => ({
    rootKey: row.__RootKey,
    kind: row.__Kind,
    versionOrder: Number(row.__VersionOrder),
    record: Object.fromEntries(table.columns.map(column => [
      column.name,
      decodeValue(column, row[column.name], 'postgres'),
    ])),
    providerIds: Object.fromEntries((row.__ProviderIds ?? []).map(pair =>
      pair.map(value => decodeNativeTextBytes(value)))),
  }));
}

export function loadPostgresItemVersionRelations(database, itemId, primaryVersionId, videoTypes) {
  return loadPostgresItemVersionFamilyRelations(database, [{
    itemId,
    primaryVersionId: primaryVersionId == null ? null : primaryVersionId,
  }], videoTypes);
}
