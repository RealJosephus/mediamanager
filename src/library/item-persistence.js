import { nonemptyId, sameId } from './records.js';
import { nativeGuid } from '../users/native.js';
import {
  collectPostgresItemDeletionKeys,
  deletePostgresInheritedItemValueMaps,
  deletePostgresItemRows,
} from '../database/postgres-persistence-query.js';

export const retainedUserDataItemId = '00000000-0000-0000-0000-000000000001';
export async function collectItemDeletionIds(db, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !nonemptyId(id) || sameId(id, retainedUserDataItemId))) {
    throw new TypeError('Deletion requires nonempty item ids other than the retention placeholder.');
  }
  return new Map((await collectPostgresItemDeletionKeys(db, ids)).map(key => [key, nativeGuid(key)]));
}

export async function deleteItemsInDatabase(db, ids, { now = () => new Date().toISOString() } = {}) {
  const retentionDate = now(), related = await collectItemDeletionIds(db, ids);
  await deletePostgresItemRows(db, [...related.keys()], {
    retainedItemId: retainedUserDataItemId,
    retentionDate,
  });
  return new Set(related.keys());
}

export function deletePersistedItems(store, ids, options) {
  return store.transaction(db => deleteItemsInDatabase(db, ids, options));
}

// Native post-scan cleanup removes inherited tag links, retaining ItemValues.
// It has no request token and commits independently of earlier scan operations.
export function updateInheritedValues(store) {
  return store.transaction(async db => {
    await deletePostgresInheritedItemValueMaps(db);
  });
}
