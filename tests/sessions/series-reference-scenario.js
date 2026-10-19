import { tableDefinition } from '../../src/database/model.js';
import { hydrateItem, userDataKeys, guidN, emptyGuid } from '../../src/sessions/user-data.js';

export const seriesUserId = 'a9400000-0000-0000-0000-000000000090';
const isEmpty = value => value == null || guidN(value) === emptyGuid;
const persistedId = value => String(value).toUpperCase();
export const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated)
  .map(column => [column.name, column.nullable ? null : column.clrType === 'bool' ? false
    : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
const persisted = entry => ({ ...blank('BaseItems'), Id: persistedId(entry.Id),
  Type: `MediaBrowser.Controller.Entities.${['Series', 'Season', 'Episode'].includes(entry.type) ? 'TV.' : ''}${entry.type}`,
  Name: entry.Name ?? `${entry.type}-${entry.mode ?? ''}`, SortName: entry.SortName ?? entry.type.toLowerCase(),
  CleanName: entry.type.toLowerCase(), ParentId: isEmpty(entry.ParentId) ? null : persistedId(entry.ParentId),
  SeriesId: isEmpty(entry.SeriesId) ? null : persistedId(entry.SeriesId), SeriesName: entry.SeriesName ?? null,
  ParentIndexNumber: entry.ParentIndexNumber ?? null,
  IndexNumber: entry.IndexNumber ?? entry.indexNumber ?? null, IsFolder: entry.type !== 'Episode',
  MediaType: entry.type === 'Episode' ? 'Video' : 'Unknown', Data: entry.serializedData ?? '{}' });

export async function seedSeriesReference(db, raw) {
  await db.insert('Users', { ...blank('Users'), Id: persistedId(seriesUserId), InternalId: 90n,
    Username: 'SeriesGetterUser', NormalizedUsername: 'SERIESGETTERUSER', RowVersion: 0n });
  for (const entry of raw.parentItems) {
    await db.insert('BaseItems', persisted(entry));
    for (const [ProviderId, ProviderValue] of Object.entries(entry.ProviderIds)) {
      await db.insert('BaseItemProviders', { ItemId: persistedId(entry.Id), ProviderId, ProviderValue });
    }
  }
  for (const entry of [raw.getters[0], raw.getters[6], { ...raw.ignoredAlias, type: 'Episode' }]) {
    await db.insert('BaseItems', persisted(entry));
    const keys = new Set([entry.Id, ...raw.getters.filter(row => row.type === entry.type).flatMap(row => row.userDataKeys),
      entry.type === 'Episode' ? 'serialized-fake-key001002' : 'serialized-fake-key000']);
    const suffix = entry.type === 'Episode' ? '001002' : '000';
    for (const parent of raw.parentItems.filter(parent => parent.type === 'Series')) {
      keys.add(parent.ProviderIds.Tvdb + suffix); keys.add(parent.Id + suffix);
    }
    let index = 0;
    for (const CustomDataKey of keys) await db.insert('UserData', { ...blank('UserData'),
      ItemId: persistedId(entry.Id), UserId: persistedId(seriesUserId), CustomDataKey, PlayCount: ++index,
      PlaybackPositionTicks: BigInt(index) * 10000000n, Played: false, IsFavorite: index % 2 === 0 });
    for (const ParentItemId of [raw.parentItems[1].Id, raw.parentItems[0].Id]) {
      await db.insert('AncestorIds', { ItemId: persistedId(entry.Id), ParentItemId: persistedId(ParentItemId) });
    }
  }
}

export async function setSeriesCase(db, entry) {
  const row = persisted(entry);
  await db.update('BaseItems', { Id: persistedId(entry.Id) }, { ParentId: row.ParentId, SeriesId: row.SeriesId,
    ParentIndexNumber: row.ParentIndexNumber, IndexNumber: row.IndexNumber, SeriesName: row.SeriesName,
    Data: entry.serializedData ?? JSON.stringify({ SeriesName: entry.SeriesName ?? '' }) });
  return hydrateItem(db, (await db.rows('BaseItems', { where: { Id: persistedId(entry.Id) } }))[0]);
}

export async function observeInitialUserData(db, raw) {
  const output = [];
  for (const entry of raw.getters) {
    const hydrated = await setSeriesCase(db, entry);
    const plain = { ...hydrated, SeriesId: entry.SeriesId };
    const persistedKeys = await userDataKeys(db, hydrated), domainKeys = await userDataKeys(db, plain);
    output.push({ type: entry.type, mode: entry.mode, input: entry,
      persistedKeys, domainKeys, expectedKeys: entry.userDataKeys,
      persistedEqual: JSON.stringify(persistedKeys) === JSON.stringify(entry.userDataKeys),
      domainEqual: JSON.stringify(domainKeys) === JSON.stringify(entry.userDataKeys) });
  }
  const alias = { ...raw.ignoredAlias, type: 'Episode' };
  const hydrated = await setSeriesCase(db, alias);
  const keys = await userDataKeys(db, hydrated);
  return { output, ignoredAlias: { keys, expectedKeys: alias.userDataKeys,
    equal: JSON.stringify(keys) === JSON.stringify(alias.userDataKeys), hydrated },
    differing: output.filter(entry => !entry.persistedEqual || !entry.domainEqual).length +
      (JSON.stringify(keys) === JSON.stringify(alias.userDataKeys) ? 0 : 1) };
}
