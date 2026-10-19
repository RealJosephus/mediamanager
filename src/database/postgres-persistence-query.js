import { nativeTextSql, postgresColumnType } from './native-text-sql.js';
import { lowerInvariant } from '../core/identity.js';
import { randomUUID } from 'node:crypto';
import { columnDefinition, quoteIdentifier as q, tableDefinition } from './model.js';
import { postgresInvariantLowerFunctionName } from './postgres-runtime-schema.js';
import { decodeValue, encodeValue } from './values.js';

function postgresTable(database, name) {
  if (database?.dialect !== 'postgres'
    || !/^[A-Za-z_][A-Za-z0-9_]{0,39}$/u.test(database.schemaName ?? '')) {
    throw new TypeError('A PostgreSQL database with an explicit schema is required.');
  }
  return `${q(database.schemaName)}.${q(name)}`;
}

function decodeRows(name, rows) {
  const table = tableDefinition(name);
  return rows.map(row => Object.fromEntries(table.columns.map(column => [
    column.name,
    decodeValue(column, row[column.name], 'postgres'),
  ])));
}

const normalizedGuid = (database, expression) => nativeTextSql(database.schemaName).guidKey(expression);

export async function collectPostgresItemDeletionKeys(database, ids) {
  const requested = [...new Set(ids.map(id => String(id).replaceAll('-', '').toLowerCase()))];
  const plan = buildPostgresItemDeletionPlan(database, {
    text: 'SELECT DISTINCT value AS "Key" FROM unnest($1::text[]) value', values: [requested],
  });
  const result = await database.client.query(plan.text, plan.values);
  return result.rows.map(row => row.Key);
}

function requireScopePlan(plan) {
  if (!plan || typeof plan.text !== 'string' || !Array.isArray(plan.values)) {
    throw new TypeError('A relational deletion scope requires SQL and bound values.');
  }
}

/** Expand a normalized Key relation without transferring its roots or closure
 * into Node. The caller can materialize this plan at the persistence boundary. */
export function buildPostgresItemDeletionPlan(database, requestedPlan) {
  requireScopePlan(requestedPlan);
  const ancestor = postgresTable(database, 'AncestorIds');
  const items = postgresTable(database, 'BaseItems');
  return { text: `
    WITH RECURSIVE
    requested("Key") AS (
      SELECT DISTINCT requested."Key" FROM (${requestedPlan.text}) requested
      WHERE requested."Key" IS NOT NULL
    ),
    ancestor_direct("Key") AS (
      SELECT DISTINCT ${normalizedGuid(database, 'ancestor."ItemId"')}
      FROM requested
      JOIN ${ancestor} ancestor
        ON ${normalizedGuid(database, 'ancestor."ParentItemId"')} = requested."Key"
    ),
    ancestor_indirect("Key") AS (
      SELECT DISTINCT ${normalizedGuid(database, 'ancestor."ItemId"')}
      FROM ancestor_direct
      JOIN ${ancestor} ancestor
        ON ${normalizedGuid(database, 'ancestor."ParentItemId"')} = ancestor_direct."Key"
    ),
    initial("Key") AS (
      SELECT "Key" FROM requested
      UNION
      SELECT "Key" FROM ancestor_direct
      UNION
      SELECT "Key" FROM ancestor_indirect
    ),
    related("Key") AS (
      SELECT "Key" FROM initial
      UNION
      SELECT child."Key"
      FROM related parent
      CROSS JOIN LATERAL (
        SELECT ${normalizedGuid(database, 'item."Id"')} AS "Key"
        FROM ${items} item
        WHERE ${normalizedGuid(database, 'item."ParentId"')} = parent."Key"
        UNION
        SELECT ${normalizedGuid(database, 'item."Id"')} AS "Key"
        FROM ${items} item
        WHERE item."OwnerId" IS NOT NULL
          AND ${normalizedGuid(database, 'item."OwnerId"')} = parent."Key"
      ) child
    )
    SELECT "Key"
    FROM related
    ORDER BY "Key" COLLATE "C"`, values: requestedPlan.values };
}

export async function deletePostgresItemRows(database, relatedIds, { retainedItemId, retentionDate }) {
  const scope = [...new Set(relatedIds.map(id => String(id).replaceAll('-', '').toLowerCase()))];
  return deletePostgresItemRowsFromStableScope(database, {
    text: 'SELECT value AS "Key" FROM unnest($1::text[]) value', values: [scope],
  }, { retainedItemId, retentionDate });
}

/** Keep native retained-data and relation cleanup in the caller's transaction.
 * A scope relation lets maintenance delete one complete batch with bounded IO. */
export async function deletePostgresItemRowsFromPlan(database, scope, { retainedItemId, retentionDate }) {
  requireScopePlan(scope);
  const relation = q('mm_delete_' + randomUUID().replaceAll('-', ''));
  let failure;
  try {
    await database.client.query({ text: `CREATE TEMP TABLE ${relation} AS ${scope.text}`, values: scope.values });
    await database.client.query(`CREATE INDEX ON ${relation} ("Key")`);
    return await deletePostgresItemRowsFromStableScope(database, {
      text: `SELECT "Key" FROM ${relation}`, values: [],
    }, { retainedItemId, retentionDate });
  } catch (error) { failure = error; throw error; }
  finally {
    try { await database.client.query(`DROP TABLE IF EXISTS ${relation}`); }
    catch (error) { if (!failure || error.code !== '25P02') throw error; }
  }
}

async function deletePostgresItemRowsFromStableScope(database, scope, { retainedItemId, retentionDate }) {
  const parameter = offset => `$${scope.values.length + offset}`;
  const userData = postgresTable(database, 'UserData');
  const dateOrder = `CASE WHEN data."LastPlayedDate" IS NULL THEN NULL ELSE
    substring(${nativeTextSql(database.schemaName).projection('data."LastPlayedDate"')} from 1 for 10)
    || substring(${nativeTextSql(database.schemaName).projection('data."LastPlayedDate"')} from 12 for 8)
    || rpad(COALESCE(substring(${nativeTextSql(database.schemaName).projection('data."LastPlayedDate"')} from '\\.([0-9]{1,7})'), ''), 7, '0') END`;

  await database.client.query(`
    WITH scope AS (${scope.text}),
    ranked AS (
      SELECT data."ItemId", data."UserId", data."CustomDataKey",
        row_number() OVER (
          PARTITION BY ${normalizedGuid(database, 'data."UserId"')}, data."CustomDataKey"
          ORDER BY ${dateOrder} COLLATE "C" DESC NULLS LAST,
            data."PlayCount" DESC,
            data."ItemId" ASC,
            data."UserId" ASC
        ) AS position
      FROM ${userData} data
      JOIN scope ON ${normalizedGuid(database, 'data."ItemId"')} = scope."Key"
    )
    DELETE FROM ${userData} data
    USING ranked
    WHERE ranked.position > 1
      AND data."ItemId" = ranked."ItemId"
      AND data."UserId" = ranked."UserId"
      AND data."CustomDataKey" = ranked."CustomDataKey"`, scope.values);

  const retainedKey = String(retainedItemId).replaceAll('-', '').toLowerCase();
  await database.client.query(`
    WITH scope AS (${scope.text}),
    incoming AS (
      SELECT DISTINCT ${normalizedGuid(database, 'data."UserId"')} AS "UserKey", data."CustomDataKey"
      FROM ${userData} data
      JOIN scope ON ${normalizedGuid(database, 'data."ItemId"')} = scope."Key"
    )
    DELETE FROM ${userData} retained
    USING incoming
    WHERE ${normalizedGuid(database, 'retained."ItemId"')} = ${parameter(1)}
      AND ${normalizedGuid(database, 'retained."UserId"')} = incoming."UserKey"
      AND retained."CustomDataKey" = incoming."CustomDataKey"`, [...scope.values, retainedKey]);

  const itemColumn = columnDefinition(tableDefinition('UserData'), 'ItemId');
  const retentionColumn = columnDefinition(tableDefinition('UserData'), 'RetentionDate');
  await database.client.query(`
    WITH scope AS (${scope.text})
    UPDATE ${userData} data
    SET "ItemId" = ${parameter(1)}, "RetentionDate" = ${parameter(2)}
    FROM scope
    WHERE ${normalizedGuid(database, 'data."ItemId"')} = scope."Key"`, [
    ...scope.values,
    encodeValue(itemColumn, retainedItemId, 'postgres'),
    encodeValue(retentionColumn, retentionDate, 'postgres'),
  ]);

  for (const table of ['CustomItemDisplayPreferences', 'ItemDisplayPreferences']) {
    await database.client.query(`
      WITH scope AS (${scope.text})
      DELETE FROM ${postgresTable(database, table)} data
      USING scope
      WHERE ${normalizedGuid(database, 'data."ItemId"')} = scope."Key"`, scope.values);
  }

  // Native performs this sweep before deleting the target ItemValuesMap rows.
  await deletePostgresOrphanItemValues(database);

  const linked = postgresTable(database, 'LinkedChildren');
  await database.client.query(`
    WITH scope AS (${scope.text})
    DELETE FROM ${linked} link
    USING scope
    WHERE ${normalizedGuid(database, 'link."ParentId"')} = scope."Key"
      OR ${normalizedGuid(database, 'link."ChildId"')} = scope."Key"`, scope.values);

  const peopleMap = postgresTable(database, 'PeopleBaseItemMap');
  const people = postgresTable(database, 'Peoples');
  await database.client.query(`
    WITH scope AS (${scope.text}),
    candidates AS MATERIALIZED (
      SELECT DISTINCT map."PeopleId"
      FROM ${peopleMap} map
      JOIN scope ON ${normalizedGuid(database, 'map."ItemId"')} = scope."Key"
    )
    DELETE FROM ${people} person
    USING candidates
    WHERE person."Id" = candidates."PeopleId"
      AND NOT EXISTS (
        SELECT 1
        FROM ${peopleMap} remaining
        WHERE remaining."PeopleId" = person."Id"
          AND NOT EXISTS (SELECT 1 FROM scope remaining_scope
            WHERE remaining_scope."Key" = ${normalizedGuid(database, 'remaining."ItemId"')})
      )`, scope.values);

  const items = postgresTable(database, 'BaseItems');
  await database.client.query(`
    WITH scope AS (${scope.text})
    UPDATE ${items} item
    SET "OwnerId" = NULL
    FROM scope
    WHERE ${normalizedGuid(database, 'item."Id"')} = scope."Key"
      AND item."OwnerId" IS NOT NULL`, scope.values);
  await database.client.query(`
    WITH scope AS (${scope.text})
    DELETE FROM ${items} item
    USING scope
    WHERE ${normalizedGuid(database, 'item."Id"')} = scope."Key"`, scope.values);

  for (const table of ['MediaSegments', 'TrickplayInfos']) {
    await database.client.query(`
      WITH scope AS (${scope.text})
      DELETE FROM ${postgresTable(database, table)} data
      USING scope
      WHERE ${normalizedGuid(database, 'data."ItemId"')} = scope."Key"`, scope.values);
  }
}

export async function findPostgresPeople(database, people) {
  const table = tableDefinition('Peoples');
  const nameColumn = columnDefinition(table, 'Name');
  const typeColumn = columnDefinition(table, 'PersonType');
  const requested = new Map();
  for (const person of people) {
    encodeValue(nameColumn, person.Name, 'postgres');
    encodeValue(typeColumn, person.Type, 'postgres');
    const personType = person.Type;
    const nameKey = lowerInvariant(person.Name);
    requested.set(JSON.stringify([nameKey, personType]), { nameKey, personType });
  }
  if (!requested.size) return [];
  const entries = [...requested.values()];
  const result = await database.client.query(`
    WITH requested("NameKey", "PersonType") AS (
      SELECT * FROM unnest($1::${postgresColumnType(nameColumn)}[], $2::${postgresColumnType(typeColumn)}[])
    )
    SELECT person."Id", person."Name", person."PersonType"
    FROM requested
    JOIN ${postgresTable(database, 'Peoples')} person
      ON ${q(database.schemaName)}.${q(postgresInvariantLowerFunctionName)}(person."Name") = requested."NameKey"
      AND person."PersonType" IS NOT DISTINCT FROM requested."PersonType"
    ORDER BY person."Id" ASC NULLS FIRST`, [
    entries.map(entry => encodeValue(nameColumn, entry.nameKey, 'postgres')),
    entries.map(entry => encodeValue(typeColumn, entry.personType, 'postgres')),
  ]);
  const rows = decodeRows('Peoples', result.rows);
  return rows.filter(row => entries.some(entry => entry.personType === row.PersonType
    && entry.nameKey === lowerInvariant(row.Name)));
}

export async function deletePostgresOrphanItemValues(database) {
  const result = await database.client.query(`
    DELETE FROM ${postgresTable(database, 'ItemValues')} value
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${postgresTable(database, 'ItemValuesMap')} map
      WHERE map."ItemValueId" = value."ItemValueId"
    )`);
  return BigInt(result.rowCount);
}

export async function deletePostgresInheritedItemValueMaps(database) {
  const type = encodeValue(columnDefinition(tableDefinition('ItemValues'), 'Type'), 6, 'postgres');
  const result = await database.client.query(`
    DELETE FROM ${postgresTable(database, 'ItemValuesMap')} map
    USING ${postgresTable(database, 'ItemValues')} value
    WHERE value."ItemValueId" = map."ItemValueId"
      AND value."Type" = $1`, [type]);
  return BigInt(result.rowCount);
}

export async function reattachPostgresUserDataRows(database, itemId, customDataKeys, {
  placeholderId = '00000000-0000-0000-0000-000000000001',
  signal,
} = {}) {
  signal?.throwIfAborted();
  const table = tableDefinition('UserData');
  const itemColumn = columnDefinition(table, 'ItemId');
  const keyColumn = columnDefinition(table, 'CustomDataKey');
  const item = encodeValue(itemColumn, itemId, 'postgres');
  const placeholderKey = String(placeholderId).replaceAll('-', '').toLowerCase();
  const keys = [...new Set(customDataKeys)].map(key => encodeValue(keyColumn, key, 'postgres'));
  await database.client.query(`
    UPDATE ${postgresTable(database, 'UserData')} data
    SET "ItemId" = $1, "RetentionDate" = NULL
    WHERE ${normalizedGuid(database, 'data."ItemId"')} = $2
      AND data."CustomDataKey" = ANY($3::${postgresColumnType(keyColumn)}[])`, [item, placeholderKey, keys]);
  signal?.throwIfAborted();
  const attached = await database.client.query(`
    SELECT ${table.columns.map(column => q(column.name)).join(', ')}
    FROM ${postgresTable(database, 'UserData')} data
    WHERE ${normalizedGuid(database, 'data."ItemId"')} = $1
    ORDER BY data."ItemId", data."UserId",
      data."CustomDataKey"`, [String(itemId).replaceAll('-', '').toLowerCase()]);
  signal?.throwIfAborted();
  return decodeRows('UserData', attached.rows);
}
