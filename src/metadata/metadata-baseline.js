import { isDeepStrictEqual } from 'node:util';
import { quoteIdentifier, tableDefinition } from '../database/model.js';
import { nativeTextBytes } from '../database/native-text.js';

async function hasMetadataRelationships(db, id, tables) {
  const checks = tables.map(name => `SELECT 1 FROM ${quoteIdentifier(tableDefinition(name).name)} WHERE "ItemId"=$1`);
  const { rows: [result] } = await db.client.query({
    text: `SELECT EXISTS (${checks.join(' UNION ALL ')}) AS present`, values: [nativeTextBytes(id)],
  });
  return result.present;
}

export async function readMetadataRelationships(db, id, tables, { checkEmpty = false } = {}) {
  if (checkEmpty && tables.length && !await hasMetadataRelationships(db, id, tables)) {
    return Object.fromEntries(tables.map(table => [table, []]));
  }
  const relationships = {};
  for (const table of tables) relationships[table] = await db.rows(table, { where: { ItemId: id } });
  return relationships;
}

// Shared by metadata persistence and pre-save extracted-data invalidation.
// A new owned draft still has an authoritative absent row and owner frame.
export async function assertMetadataBaseline(db, loaded) {
  const id = loaded.item.Id;
  const current = (await db.rows('BaseItems', { where: { Id: id } }))[0];
  if (!isDeepStrictEqual(current, loaded.snapshot)) throw Object.assign(new Error('The media item changed during metadata refresh.'), { code: 'metadata-conflict', status: 409 });
  if (loaded.ownedExtraOwner) {
    const owner = loaded.ownedExtraOwner;
    const [row] = await db.rows('BaseItems', { where: { Id: owner.Id } });
    const links = await db.rows('LinkedChildren', { where: { ParentId: owner.Id }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
    if (!isDeepStrictEqual(row, owner.snapshot) || owner.versionLinks != null && !isDeepStrictEqual(links, owner.versionLinks)) {
      throw Object.assign(new Error('The extra owner changed before its metadata save.'), { code: 'metadata-conflict', status: 409 });
    }
  }
  const relationships = Object.entries(loaded.relationships ?? {});
  const expectedEmpty = !current && relationships.length > 0 && relationships.every(([, rows]) => rows.length === 0);
  if (!expectedEmpty || await hasMetadataRelationships(db, id, relationships.map(([table]) => table))) {
    for (const [table, rows] of relationships) {
      if (!isDeepStrictEqual(await db.rows(table, { where: { ItemId: id } }), rows)) {
        throw Object.assign(new Error('Metadata relations changed during refresh.'), { code: 'metadata-conflict', status: 409 });
      }
    }
  }
  if (loaded.versionLinks != null && !isDeepStrictEqual(await db.rows('LinkedChildren', { where: { ParentId: id },
    orderBy: [{ column: 'SortOrder', direction: 'ASC' }] }), loaded.versionLinks)) {
    throw Object.assign(new Error('Video version relations changed during refresh.'), { code: 'metadata-conflict', status: 409 });
  }
  return current;
}
