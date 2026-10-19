import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { cleanValue } from './records.js';

function postgresTable(database, name) {
  if (database?.dialect !== 'postgres'
    || !/^[A-Za-z_][A-Za-z0-9_]{0,39}$/u.test(database.schemaName ?? '')) {
    throw new TypeError('A PostgreSQL database with an explicit schema is required.');
  }
  return `${q(database.schemaName)}.${q(name)}`;
}

export async function replacePostgresItemProviderIds(database, itemId, entries) {
  const providers = postgresTable(database, 'BaseItemProviders');
  await database.client.query(`
    WITH desired("ProviderId", "ProviderValue") AS (
      SELECT * FROM unnest($2::bytea[], $3::bytea[])
    ),
    upserted AS (
      INSERT INTO ${providers} ("ItemId", "ProviderId", "ProviderValue")
      SELECT $1, desired."ProviderId", desired."ProviderValue"
      FROM desired
      ON CONFLICT ("ItemId", "ProviderId") DO UPDATE SET
        "ProviderValue" = EXCLUDED."ProviderValue"
      RETURNING "ProviderId"
    )
    DELETE FROM ${providers} stored
    WHERE stored."ItemId" = $1
      AND NOT EXISTS (
        SELECT 1 FROM desired WHERE desired."ProviderId" = stored."ProviderId"
      )`, [nativeTextBytes(itemId), entries.map(([providerId]) => nativeTextBytes(providerId)),
    entries.map(([, providerValue]) => nativeTextBytes(providerValue))]);
}

export async function replacePostgresItemAncestors(database, itemId, ancestorIds) {
  const ancestors = postgresTable(database, 'AncestorIds');
  const items = postgresTable(database, 'BaseItems');
  const result = await database.client.query(`
    WITH input("ParentItemId", "InputOrder") AS (
      SELECT source."ParentItemId", source.ordinality
      FROM unnest($2::bytea[]) WITH ORDINALITY AS source("ParentItemId", ordinality)
    ),
    desired AS (
      SELECT input."ParentItemId", input."InputOrder"
      FROM input
      JOIN ${items} parent ON parent."Id" = input."ParentItemId"
    ),
    upserted AS (
      INSERT INTO ${ancestors} ("ItemId", "ParentItemId")
      SELECT $1, desired."ParentItemId" FROM desired
      ON CONFLICT ("ItemId", "ParentItemId") DO NOTHING
      RETURNING "ParentItemId"
    ),
    deleted AS (
      DELETE FROM ${ancestors} stored
      WHERE stored."ItemId" = $1
        AND NOT EXISTS (
          SELECT 1 FROM desired WHERE desired."ParentItemId" = stored."ParentItemId"
        )
      RETURNING "ParentItemId"
    )
    SELECT desired."ParentItemId"
    FROM desired
    ORDER BY desired."InputOrder"`, [nativeTextBytes(itemId), ancestorIds.map(nativeTextBytes)]);
  return result.rows.map(row => decodeNativeTextBytes(row.ParentItemId));
}

export async function replacePostgresItemValues(database, itemId, desiredValues) {
  const values = postgresTable(database, 'ItemValues');
  const maps = postgresTable(database, 'ItemValuesMap');
  const unique = new Map();
  for (const [type, value] of desiredValues) {
    const key = JSON.stringify([type, value]);
    if (!unique.has(key)) unique.set(key, {
      type,
      value,
      clean: cleanValue(value),
      id: randomUUID().toUpperCase(),
    });
  }
  const rows = [...unique.values()];
  await database.client.query(`
    WITH desired("Type", "Value", "CleanValue", "NewId") AS (
      SELECT * FROM unnest($2::integer[], $3::bytea[], $4::bytea[], $5::bytea[])
    ),
    resolved AS (
      INSERT INTO ${values} AS stored ("ItemValueId", "CleanValue", "Type", "Value")
      SELECT desired."NewId", desired."CleanValue", desired."Type", desired."Value"
      FROM desired
      ON CONFLICT ("Type", "Value") DO UPDATE SET "Value" = stored."Value"
      RETURNING "ItemValueId", "Type", "Value"
    ),
    added AS (
      INSERT INTO ${maps} ("ItemValueId", "ItemId")
      SELECT resolved."ItemValueId", $1 FROM resolved
      ON CONFLICT ("ItemValueId", "ItemId") DO NOTHING
      RETURNING "ItemValueId"
    )
    DELETE FROM ${maps} stored
    WHERE stored."ItemId" = $1
      AND NOT EXISTS (
        SELECT 1 FROM resolved WHERE resolved."ItemValueId" = stored."ItemValueId"
      )`, [nativeTextBytes(itemId), rows.map(row => row.type), rows.map(row => nativeTextBytes(row.value)),
    rows.map(row => nativeTextBytes(row.clean)), rows.map(row => nativeTextBytes(row.id))]);
}
