import { nativeGuid, domainError } from '../users/native.js';

export const searchHistoryClient = 'emby-search-history';
export const searchHistoryKey = 'DateLastSearched';

export async function markSearchedItems({ users, library, userData }, userId, ids, { clock = () => Date.now() } = {}) {
  const owner = nativeGuid(userId);
  if (!await users.getUser(owner)) throw domainError(500, 'Object reference not set to an instance of an object.');
  for (const id of [...new Set(ids.map(nativeGuid))]) {
    let item;
    try { item = await library.getItemRecord(id); }
    catch (error) { if (error.status === 404) continue; throw error; }
    await userData.mutate(owner, item, async (_data, database) => {
      const where = { UserId: owner, ItemId: nativeGuid(item.Id), Client: searchHistoryClient, Key: searchHistoryKey };
      const current = (await database.rows('CustomItemDisplayPreferences', { where, columns: ['Id'], limit: 1 }))[0];
      // Emby stores DateLastSearchedInt in whole Unix seconds. WasSearched is
      // not bound by the marking action; every submitted existing item is set.
      const Value = String(Math.floor(clock() / 1000));
      if (current) await database.update('CustomItemDisplayPreferences', { Id: current.Id }, { Value });
      else await database.insert('CustomItemDisplayPreferences', { ...where, Value });
    }, 'UpdateUserData');
  }
}

export async function clearSearchHistory({ store, users }, userId) {
  const UserId = nativeGuid(userId);
  await store.transaction(async database => {
    if (!await users.loadUser(database, UserId)) throw domainError(500, 'Object reference not set to an instance of an object.');
    await database.deleteWhere('CustomItemDisplayPreferences', { UserId, Client: searchHistoryClient, Key: searchHistoryKey });
  });
}
