// BaseNfoParser imports are ordered and only persist when its item already has an ID.
import { nativeGuid } from '@mediamanager/plugin-sdk/users/native';
import { nativeDate } from '@mediamanager/plugin-sdk/sessions/user-data';

const hasPersistentId = item => Boolean(item.Id) && !/^0{32}$/.test(item.Id.replaceAll('-', ''));

export async function applyNfoUserDataEntry(entry, { configuration, userData, store }) {
  let userId;
  try { userId = nativeGuid(configuration.UserId); } catch { return false; }
  if (!(await store.run(db => db.rows('Users', { where: { Id: userId } }))).length) return false;
  if (!userData) throw Object.assign(new Error('NFO import requires the user data event service.'), { code: 'metadata-context-required' });
  if (!hasPersistentId(entry.item)) {
    // BaseNfoProvider parses into a new item with an empty id. Xml parsing still
    // performs GetUserData and mutates that transient value, but never saves it.
    const data = await userData.readTransient(userId, entry.item);
    data[entry.field] = entry.field === 'LastPlayedDate' ? nativeDate(entry.value) : entry.value;
    return false;
  }
  await userData.mutate(userId, entry.item, data => {
    data[entry.field] = entry.field === 'LastPlayedDate' ? nativeDate(entry.value) : entry.value;
  }, 'Import');
  return true;
}

export async function applyNfoUserData(result, { configuration, userData, store }) {
  const imports = result.UserDataImports ?? [];
  let applied = 0;
  for (const entry of imports) if (await applyNfoUserDataEntry(entry, { configuration, userData, store })) applied++;
  return { applied, ignored: imports.length - applied };
}
