import { nativeTextBytes } from '../database/native-text.js';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { nativeGuid, domainError } from './native.js';

export const userDataCopyOptions = Object.freeze([
  { Name: 'User Policy (library and feature access, parental controls, etc.)', Id: 'userpolicy' },
  { Name: 'User Configuration (preferred audio and subtitle languages, library order, etc.)', Id: 'userconfiguration' },
  { Name: 'User Data (favorites, watch and listening states, etc.)', Id: 'userdata' },
]);

async function copyPlaybackData(database, sourceId, targetId) {
  const table = tableDefinition('UserData'), columns = table.columns.filter(column => !column.generated);
  const changed = columns.filter(column => !table.primaryKey.includes(column.name));
  // Keep raw native values and target-only keys in SQL. No playback rows are
  // materialized in Node, including orphan-free multi-key item histories.
  await database.client.query(`INSERT INTO ${q(database.schemaName)}."UserData"
    (${columns.map(column => q(column.name)).join(', ')})
    SELECT ${columns.map(column => column.name === 'UserId' ? '$2::bytea' : q(column.name)).join(', ')}
    FROM ${q(database.schemaName)}."UserData" WHERE "UserId" = $1::bytea
    ON CONFLICT (${table.primaryKey.map(q).join(', ')}) DO UPDATE SET
    ${changed.map(column => `${q(column.name)} = EXCLUDED.${q(column.name)}`).join(', ')}`,
  [nativeTextBytes(sourceId), nativeTextBytes(targetId)]);
}

export async function copyUserData({ store, users, displayPreferences, sessions, onError = () => {} }, sourceId, targetIds, options) {
  const source = nativeGuid(sourceId), targets = [...new Set(targetIds.map(nativeGuid))];
  const selected = new Set(options), notifications = [];
  let failure;
  try { await store.serializeWrites(async database => {
    const original = await users.loadUser(database, source);
    if (!original) throw domainError(500, 'Object reference not set to an instance of an object.');
    const settings = selected.has('userconfiguration') ? await displayPreferences.getUserSettings(source) : null;
    for (const target of targets) {
      if (target === source) continue;
      if (!await users.loadUser(database, target)) throw domainError(500, 'Object reference not set to an instance of an object.');
      if (selected.has('userpolicy')) {
        await users.updatePolicy(target, original.Policy);
        notifications.push({ target, data: users.getUserDto(await users.getUser(target)), type: 'UserPolicyUpdated' });
      }
      if (selected.has('userconfiguration')) {
        await users.updateConfiguration(target, original.Configuration);
        await displayPreferences.updateUserSettings(target, settings);
        const updated = await users.getUser(target);
        users.emit('UserUpdated', updated);
        notifications.push({ target, data: users.getUserDto(updated), type: 'UserConfigurationUpdated' });
      }
      if (selected.has('userdata')) await store.transaction(database => copyPlaybackData(database, source, target));
    }
  }); } catch (error) { failure = error; }
  // Network delivery cannot retain the database writer lock or reverse a
  // committed copy. Earlier successful targets still receive their updates.
  for (const { target, data, type } of notifications) try {
    await sessions.sendMessageToUserSessions([target], 'UserUpdated', data, { embyMessageType: type });
  } catch (error) { try { onError(error); } catch {} }
  if (failure) throw failure;
}
