import { tableDefinition } from '../../../../src/database/model.js';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { pathToFileURL } from 'node:url';

export const persistenceIds = Object.fromEntries(['series', 'season', 'episode', 'child', 'owned', 'grandchild', 'associated',
  'outside', 'user', 'person', 'sharedPerson', 'orphanPerson', 'value', 'unusedValue'].map((name, index) =>
  [name, `F3333333-3333-3333-3333-${String(index + 1).padStart(12, '0')}`]));
export const placeholderId = '00000000-0000-0000-0000-000000000001';
export const emptyRow = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : 0]));
export async function seedPersistence(db) {
  const ids = persistenceIds;
  const entries = [
    ['series', 'Series', {}], ['season', 'Season', { ParentId: ids.series }],
    ['episode', 'Episode', { ParentId: ids.season, IsVirtualItem: true }],
    ['child', 'Episode', { ParentId: ids.episode }], ['owned', 'Folder', { OwnerId: ids.episode }],
    ['grandchild', 'Episode', { ParentId: ids.owned }], ['associated', 'Episode', {}], ['outside', 'Episode', {}],
  ];
  for (const [name, type, values] of entries) await db.insert('BaseItems', { ...emptyRow('BaseItems'), Id: ids[name], Name: name,
    SortName: name, IsFolder: ['Series', 'Season', 'Folder'].includes(type), Data: '{}',
    Type: `MediaBrowser.Controller.Entities.${type === 'Folder' ? '' : 'TV.'}${type}`, ...values });
  await db.insert('BaseItems', { ...emptyRow('BaseItems'), Id: placeholderId, Type: 'PLACEHOLDER', Name: 'PLACEHOLDER' });
  await db.insert('BaseItemProviders', { ItemId: ids.episode, ProviderId: 'Tmdb', ProviderValue: '101' });
  await db.insert('AncestorIds', { ItemId: ids.episode, ParentItemId: ids.series });
  await db.insert('AncestorIds', { ItemId: ids.child, ParentItemId: ids.episode });
  await db.insert('AncestorIds', { ItemId: ids.outside, ParentItemId: ids.series });
  await db.insert('LinkedChildren', { ParentId: ids.episode, ChildId: ids.associated, ChildType: 0, SortOrder: 0 });
  await db.insert('LinkedChildren', { ParentId: ids.series, ChildId: ids.episode, ChildType: 0, SortOrder: 0 });
  await db.insert('Users', { ...emptyRow('Users'), Id: ids.user, InternalId: 1, Username: 'Fixture', NormalizedUsername: 'FIXTURE' });
  for (const [ItemId, CustomDataKey, LastPlayedDate, PlayCount, position] of [
    [ids.episode, 'shared', '2026-09-01 00:00:00', 3, 9007199254740993n],
    [ids.child, 'shared', '2026-09-02 00:00:00', 1, 9007199254740995n],
    [ids.owned, 'shared', '2026-09-02 00:00:00', 8, 9007199254740997n],
    [placeholderId, 'shared', '2026-09-03 00:00:00', 99, 99n],
    [ids.episode, 'unique', null, 2, 33n], [placeholderId, 'unrelated', null, 4, 44n],
  ]) await db.insert('UserData', { ...emptyRow('UserData'), ItemId, UserId: ids.user, CustomDataKey, LastPlayedDate,
    PlayCount, PlaybackPositionTicks: position, IsFavorite: true, Played: true });
  for (const name of ['person', 'sharedPerson', 'orphanPerson']) await db.insert('Peoples', { ...emptyRow('Peoples'), Id: ids[name], Name: name });
  for (const [name, ItemId] of [['person', ids.episode], ['sharedPerson', ids.episode], ['sharedPerson', ids.associated]]) {
    await db.insert('PeopleBaseItemMap', { ...emptyRow('PeopleBaseItemMap'), ItemId, PeopleId: ids[name], Role: 'role' });
  }
  for (const name of ['value', 'unusedValue']) await db.insert('ItemValues', { ...emptyRow('ItemValues'), ItemValueId: ids[name], Type: 2,
    Value: name, CleanValue: name });
  await db.insert('ItemValuesMap', { ItemId: ids.episode, ItemValueId: ids.value });
  // These four tables deliberately have no BaseItems FK; native deletion
  // explicitly removes related rows while retaining association-only targets.
  for (const [index, ItemId] of [ids.episode, ids.child, ids.owned, ids.associated].entries()) {
    await db.insert('CustomItemDisplayPreferences', { ...emptyRow('CustomItemDisplayPreferences'), Id: index + 1,
      ItemId, UserId: ids.user, Client: 'Fixture', Key: 'Layout', Value: 'List' });
    await db.insert('ItemDisplayPreferences', { ...emptyRow('ItemDisplayPreferences'), Id: index + 1,
      ItemId, UserId: ids.user, Client: 'Fixture', SortBy: 'Name', RememberSorting: true });
    await db.insert('MediaSegments', { ...emptyRow('MediaSegments'), Id: ItemId, ItemId,
      SegmentProviderId: 'Fixture', StartTicks: 10n, EndTicks: 20n, Type: 1 });
    await db.insert('TrickplayInfos', { ...emptyRow('TrickplayInfos'), ItemId, Width: 320,
      Height: 180, TileHeight: 10, TileWidth: 10, ThumbnailCount: 1, Interval: 10000 });
  }
}

export const persistenceTables = ['BaseItems', 'AncestorIds', 'LinkedChildren', 'UserData', 'Peoples', 'PeopleBaseItemMap',
  'ItemValues', 'ItemValuesMap', 'CustomItemDisplayPreferences', 'ItemDisplayPreferences', 'MediaSegments', 'TrickplayInfos'];
export async function persistenceProjection(db) {
  const result = {};
  for (const table of persistenceTables) result[table] = (await db.rows(table)).map(row => {
    if (table === 'BaseItems') return { Id: row.Id, Name: row.Name };
    if (table === 'Peoples') return { Id: row.Id, Name: row.Name };
    if (table === 'ItemValues') return { ItemValueId: row.ItemValueId, Value: row.Value };
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      typeof value === 'bigint' ? value.toString() : key.endsWith('Date') && value != null ? value.replace(' ', 'T').replace(/Z?$/, 'Z') : value]));
  });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = new SqliteDatabase(process.argv[2], { create: true });
  try { await seedPersistence(db); } finally { await db.close(); }
}
