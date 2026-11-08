import { isDeepStrictEqual } from 'node:util';
import { quoteIdentifier, tableDefinition } from '../database/model.js';
import { nativeTextBytes } from '../database/native-text.js';
import { queryPostgresLibraryStatement } from '../database/postgres.js';

function metadataRelationshipsExist(tables) {
  const checks = tables.map(name => `SELECT 1 FROM ${quoteIdentifier(tableDefinition(name).name)} WHERE "ItemId"=$1`);
  return `EXISTS (${checks.join(' UNION ALL ')})`;
}

async function hasMetadataRelationships(db, id, tables) {
  const { rows: [result] } = await queryPostgresLibraryStatement(db, {
    text: `SELECT ${metadataRelationshipsExist(tables)} AS present`, values: [nativeTextBytes(id)],
  });
  return result.present;
}

const metadataConflict = message => Object.assign(new Error(message), { code: 'metadata-conflict', status: 409 });
const itemChanged = 'The media item changed during metadata refresh.';
const relationsChanged = 'Metadata relations changed during refresh.';

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
  const relationships = Object.entries(loaded.relationships ?? {});
  const emptyRelations = relationships.length > 0 && relationships.every(([, rows]) => rows.length === 0);
  if (loaded.snapshot === undefined && emptyRelations && !loaded.ownedExtraOwner && loaded.versionLinks == null) {
    // A new draft needs only absence checks, at the same transaction snapshot.
    const { rows: [result] } = await queryPostgresLibraryStatement(db, {
      text: `SELECT EXISTS (SELECT 1 FROM "BaseItems" WHERE "Id"=$1) AS item,
        ${metadataRelationshipsExist(relationships.map(([table]) => table))} AS relations`,
      values: [nativeTextBytes(id)],
    });
    if (result.item) throw metadataConflict(itemChanged);
    if (result.relations) throw metadataConflict(relationsChanged);
    return undefined;
  }
  const current = (await db.rows('BaseItems', { where: { Id: id } }))[0];
  if (!isDeepStrictEqual(current, loaded.snapshot)) throw metadataConflict(itemChanged);
  if (loaded.ownedExtraOwner) {
    const owner = loaded.ownedExtraOwner;
    const [row] = await db.rows('BaseItems', { where: { Id: owner.Id } });
    const links = await db.rows('LinkedChildren', { where: { ParentId: owner.Id }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
    if (!isDeepStrictEqual(row, owner.snapshot) || owner.versionLinks != null && !isDeepStrictEqual(links, owner.versionLinks)) {
      throw metadataConflict('The extra owner changed before its metadata save.');
    }
  }
  if (current || !emptyRelations || await hasMetadataRelationships(db, id, relationships.map(([table]) => table))) {
    for (const [table, rows] of relationships) {
      if (!isDeepStrictEqual(await db.rows(table, { where: { ItemId: id } }), rows)) {
        throw metadataConflict(relationsChanged);
      }
    }
  }
  if (loaded.versionLinks != null && !isDeepStrictEqual(await db.rows('LinkedChildren', { where: { ParentId: id },
    orderBy: [{ column: 'SortOrder', direction: 'ASC' }] }), loaded.versionLinks)) {
    throw metadataConflict('Video version relations changed during refresh.');
  }
  return current;
}
