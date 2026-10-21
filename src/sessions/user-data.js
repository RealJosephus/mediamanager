import { EventEmitter } from 'node:events';
import { mapRecord } from '../library/records.js';
import { nativeGuid, wireDate, domainError } from '../users/native.js';
import { resolveSeries, resolveSeriesAsync } from '../library/series-reference.js';
import { requireNativeList } from '../library/item-relations.js';
import {
  loadPostgresItemVersionFamilyRelations,
  loadPostgresItemVersionRelations,
  loadPostgresUserDataKeyItems,
  loadPostgresUserDataRows,
  upsertPostgresUserDataRows,
} from './postgres-user-data-mutation.js';
import diacritics from './resources/diacritics.json' with { type: 'json' };

const videoTypes = new Set(['Video', 'Movie', 'Episode', 'MusicVideo', 'Trailer']);
const extraTypes = ['Unknown', 'Clip', 'Trailer', 'BehindTheScenes', 'DeletedScene', 'Interview', 'Scene', 'Sample', 'ThemeSong', 'ThemeVideo', 'Featurette', 'Short'];
const fields = ['AudioStreamIndex', 'IsFavorite', 'LastPlayedDate', 'Likes', 'PlaybackPositionTicks', 'PlayCount', 'Played', 'Rating', 'SubtitleStreamIndex'];
const minLikeRating = 6.5;
export const emptyGuid = '00000000000000000000000000000000';
export const guidN = (value) => String(value ?? emptyGuid).replaceAll('-', '').toLowerCase();
export const guidD = (value) => guidN(value).replace(/^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/, '$1-$2-$3-$4-$5');
export const sameGuid = (left, right) => guidN(left) === guidN(right);
export const itemType = (item) => (item.Type ?? '').split('.').at(-1);
export const removeDiacritics = (value) => [...String(value ?? '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')].map((character) => diacritics[character] ?? character).join('');
export const isVideo = (item) => videoTypes.has(itemType(item));
export const nativeDate = (date) => {
  const [seconds, fraction = ''] = (date instanceof Date ? date.toISOString() : String(date)).replace('T', ' ').replace(/Z$/, '').split('.');
  const significantFraction = fraction.replace(/0+$/, '');
  return significantFraction ? `${seconds}.${significantFraction}` : seconds;
};
export const dtoDate = wireDate;
export function int64(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Object.assign(new TypeError('Int64 requires an exact integer.'), { status: 400 });
  if (!['bigint', 'number', 'string'].includes(typeof value) || (typeof value === 'string' && !/^[+-]?\d+$/.test(value))) throw Object.assign(new TypeError('Invalid Int64.'), { status: 400 });
  const result = BigInt(value);
  if (result < -(2n ** 63n) || result > 2n ** 63n - 1n) throw Object.assign(new RangeError('Int64 out of range.'), { status: 400 });
  return result;
}
export function supportsPlayed(item) {
  if (item.SupportsPlayedStatus !== undefined) return item.SupportsPlayedStatus;
  if (['AggregateFolder', 'CollectionFolder', 'UserRootFolder', 'UserView', 'MusicAlbum', 'MusicArtist', 'PhotoAlbum'].includes(itemType(item))) return false;
  return isVideo(item) || ['Audio', 'AudioBook', 'Book'].includes(itemType(item)) || item.IsFolder === true;
}
export function supportsResume(item) {
  if (item.SupportsPositionTicksResume !== undefined) return item.SupportsPositionTicksResume;
  return ['AudioBook', 'Book'].includes(itemType(item)) || (isVideo(item) && !['Sample', 'ThemeVideo', 'Trailer'].includes(extraTypes[item.ExtraType] ?? item.ExtraType));
}
export const defaultPlayStateConfiguration = Object.freeze({ MinResumePct: 5, MaxResumePct: 90, MinResumeDurationSeconds: 300, MinAudiobookResume: 5, MaxAudiobookResume: 5 });

export function updatePlayState(item, data, reportedPositionTicks, configuration = {}) {
  const config = { ...defaultPlayStateConfiguration, ...configuration };
  const runtime = int64(item.RunTimeTicks ?? 0n);
  let position = int64(reportedPositionTicks ?? runtime);
  let completed = false;
  if (position > 0n && runtime > 0n && !['AudioBook', 'Book'].includes(itemType(item))) {
    // Integer cross products retain the native decimal comparison at Int64 boundaries.
    if (position * 100n < runtime * BigInt(config.MinResumePct)) position = 0n;
    else if (position * 100n > runtime * BigInt(config.MaxResumePct) || position >= runtime - 10000000n) {
      position = 0n; data.Played = completed = true;
    } else if (runtime < BigInt(config.MinResumeDurationSeconds) * 10000000n) {
      position = 0n; data.Played = completed = true;
    }
  } else if (position > 0n && runtime > 0n && itemType(item) === 'AudioBook') {
    if (position < BigInt(config.MinAudiobookResume) * 600000000n) position = 0n;
    else if (runtime - position < BigInt(config.MaxAudiobookResume) * 600000000n || position >= runtime) {
      position = 0n; data.Played = completed = true;
    }
  } else if (runtime <= 0n) {
    data.Played = completed = true; position = 0n;
  }
  if (!supportsPlayed(item)) { position = 0n; data.Played = false; }
  if (!supportsResume(item)) position = 0n;
  data.PlaybackPositionTicks = position;
  return completed;
}

export async function hydrateItem(db, row) {
  const item = mapRecord(row);
  if (!item) return null;
  item.ProviderIds = Object.fromEntries((await db.rows('BaseItemProviders', { where: { ItemId: row.Id } })).map((entry) => [entry.ProviderId, entry.ProviderValue]));
  return item;
}

function userDataKeysWithContext(item, providers, seriesKeys) {
  let keys = [guidD(item.Id)];
  if ((item.SourceType === 'Channel' || item.SourceType === 1) && item.ExternalId) keys.unshift(item.ExternalId);
  const type = itemType(item);
  if (isVideo(item) && type !== 'Episode') {
    const extra = extraTypes[item.ExtraType] ?? item.ExtraType;
    for (const name of extra != null ? ['Tmdb', 'Imdb'] : ['Imdb', 'Tmdb']) if (providers[name]) {
      keys.unshift(extra == null ? providers[name] : `${providers[name]}-${extra.toLowerCase()}${item.RunTimeTicks == null ? '' : `-${item.RunTimeTicks}`}`);
    }
  } else if (type === 'LiveTvProgram') {
    if (!item.IsSeries) {
      for (const name of ['Imdb', 'Tmdb']) if (providers[name]) keys.unshift(providers[name]);
    } else if (item.EpisodeTitle) keys.unshift(`Program-${item.Name ?? ''}${item.EpisodeTitle}`);
  } else if (type === 'Series') {
    for (const name of ['Imdb', 'Tvdb', 'Custom']) if (providers[name]) keys.unshift(providers[name]);
  } else if ((type === 'Episode' || type === 'Season') && seriesKeys) {
    if (type === 'Season' || (item.ParentIndexNumber != null && item.IndexNumber != null)) {
      const suffix = type === 'Season' ? padded(item.IndexNumber ?? 0, 3) : padded(item.ParentIndexNumber, 3) + padded(item.IndexNumber, 3);
      keys = [...seriesKeys.slice(0, type === 'Episode' && seriesKeys.length > 1 ? -1 : undefined).map((key) => key + suffix), ...keys];
    }
  } else if (type === 'Audio' || type === 'AudioBook') {
    let key = (item.ParentIndexNumber == null ? '' : `${padded(item.ParentIndexNumber, 4)}-`) + (item.IndexNumber == null ? '' : padded(item.IndexNumber, 4)) + (item.Name ?? '');
    if (item.Album) key = `${item.Album}-${key}`;
    const albumArtist = requireNativeList(item.AlbumArtists)[0];
    if (albumArtist) key = `${albumArtist}-${key}`;
    keys.unshift(key);
  } else if (type === 'MusicAlbum') {
    const albumArtist = requireNativeList(item.AlbumArtists)[0];
    if (albumArtist) keys.unshift(`${albumArtist}-${item.Name ?? ''}`);
    if (providers.MusicBrainzAlbum) keys.unshift(`MusicAlbum-Musicbrainz-${providers.MusicBrainzAlbum}`);
    if (providers.MusicBrainzReleaseGroup) keys.unshift(`MusicAlbum-MusicBrainzReleaseGroup-${providers.MusicBrainzReleaseGroup}`);
  } else if (type === 'MusicArtist') {
    keys.unshift(`Artist-${removeDiacritics(item.Name)}`);
    if (providers.MusicBrainzArtist) keys.unshift(`Artist-Musicbrainz-${providers.MusicBrainzArtist}`);
  } else if (['Genre', 'MusicGenre', 'Person', 'Studio'].includes(type)) keys.unshift(`${type}-${removeDiacritics(item.Name)}`);
  else if (type === 'Year') keys.unshift(`Year-${item.Name ?? ''}`);
  return keys;
}

export async function userDataKeys(db, item) {
  const providers = item.ProviderIds instanceof Map ? Object.fromEntries(item.ProviderIds)
    : item.ProviderIds ?? Object.fromEntries((await db.rows('BaseItemProviders', {
      where: { ItemId: item.Id },
    })).map((row) => [row.ProviderId, row.ProviderValue]));
  const type = itemType(item);
  let seriesKeys = null;
  if (type === 'Episode' || type === 'Season') {
    const series = await resolveSeriesAsync(item, async id => {
      const parent = (await db.rows('BaseItems', { where: { Id: nativeGuid(id) }, limit: 1 }))[0];
      return parent ? hydrateItem(db, parent) : null;
    });
    if (series) seriesKeys = await userDataKeys(db, series);
  }
  return userDataKeysWithContext(item, providers, seriesKeys);
}

export async function postgresUserDataKeyMap(db, items) {
  const roots = [...items];
  for (const item of items) if (Object.hasOwn(item, 'Series') && item.Series) roots.push(item.Series);
  const loaded = await loadPostgresUserDataKeyItems(db, roots.map(item => item.Id));
  const byId = new Map(loaded.map(({ record, providerIds }) => {
    const value = mapRecord(record);
    if (value) value.ProviderIds = providerIds;
    return [guidN(record.Id), value];
  }).filter(([, value]) => value));
  const prepared = new Map();
  for (const item of roots) {
    const stored = byId.get(guidN(item.Id));
    const value = { ...item, ProviderIds: item.ProviderIds instanceof Map
      ? Object.fromEntries(item.ProviderIds) : item.ProviderIds ?? stored?.ProviderIds ?? {} };
    prepared.set(guidN(value.Id), value);
    byId.set(guidN(value.Id), value);
  }
  const keys = new Map();
  const visit = item => {
    const key = guidN(item.Id);
    if (keys.has(key)) return keys.get(key);
    const type = itemType(item);
    const series = type === 'Episode' || type === 'Season' ? resolveSeries(item, byId) : null;
    const value = userDataKeysWithContext(item, item.ProviderIds ?? {}, series ? visit(series) : null);
    keys.set(key, value);
    return value;
  };
  for (const item of items) visit(prepared.get(guidN(item.Id)) ?? item);
  return keys;
}
function padded(value, width) { return value < 0 ? `-${String(-value).padStart(width, '0')}` : String(value).padStart(width, '0'); }
export function defaultUserData(key) {
  return { Key: key, AudioStreamIndex: null, SubtitleStreamIndex: null, IsFavorite: false, LastPlayedDate: null, Likes: null, PlaybackPositionTicks: 0n, PlayCount: 0, Played: false, Rating: null };
}
function likesFromRating(rating) { return rating == null ? null : rating >= minLikeRating; }
function assignRating(data, rating) {
  if (rating != null && (typeof rating !== 'number' || rating < 0 || rating > 10)) {
    throw domainError(400, 'A 0 to 10 rating is required for UserItemData.');
  }
  data.Rating = rating;
  data.Likes = likesFromRating(rating);
}
function assignLikes(data, likes) { assignRating(data, likes == null ? null : likes ? 10 : 1); }
export async function readUserData(db, userId, item) {
  const rows = await db.rows('UserData', { where: { UserId: userId, ItemId: item.Id } });
  return readUserDataRows(db, item, rows);
}
export async function readUserDataRows(db, item, rows, suppliedKeys) {
  const keys = suppliedKeys ?? await userDataKeys(db, item);
  const row = keys.map((key) => rows.find((entry) => entry.CustomDataKey === key)).find(Boolean) ?? rows[0];
  if (!row) return defaultUserData(keys[0]);
  const data = { ...Object.fromEntries(fields.map((field) => [field, row[field]])), Key: row.CustomDataKey };
  assignRating(data, data.Rating);
  return data;
}
function userDataRowsForSave(userId, item, data, keys) {
  assignRating(data, data.Rating);
  const values = Object.fromEntries(fields.map((field) => [field, data[field]]));
  values.RetentionDate = null;
  values.PlaybackPositionTicks = int64(values.PlaybackPositionTicks);
  data.Key = keys.at(-1);
  return keys.map(key => ({ ItemId: item.Id, UserId: userId, CustomDataKey: key, ...values }));
}
export async function saveUserData(db, userId, item, data) {
  const keys = await userDataKeys(db, item);
  await upsertPostgresUserDataRows(db, userDataRowsForSave(userId, item, data, keys));
  return keys;
}
export function userDataDto(item, data) {
  const dto = { Rating: data.Rating, PlayedPercentage: null, UnplayedItemCount: null, PlaybackPositionTicks: data.PlaybackPositionTicks, PlayCount: data.PlayCount, IsFavorite: data.IsFavorite, Likes: likesFromRating(data.Rating), LastPlayedDate: dtoDate(data.LastPlayedDate), Played: data.Played, Key: data.Key, ItemId: guidN(item.Id) };
  if (item.RunTimeTicks > 0n && data.PlaybackPositionTicks > 0n) dto.PlayedPercentage = 100 * (Number(data.PlaybackPositionTicks) / Number(item.RunTimeTicks));
  return dto;
}

export async function itemVersions(db, item) {
  if (!isVideo(item)) return [item];
  const relations = await loadPostgresItemVersionRelations(db, item.Id, item.PrimaryVersionId,
    [...videoTypes]);
  return relations.map(relation => {
    if (relation.kind === 'root') return item;
    const version = mapRecord(relation.record);
    if (version) version.ProviderIds = relation.providerIds;
    return version;
  }).filter(version => version && isVideo(version));
}

async function postgresItemVersionFamilies(db, items) {
  const roots = new Map(items.map(item => [guidN(item.Id), item]));
  const result = new Map(items.map(item => [guidN(item.Id), [item]]));
  const videos = items.filter(isVideo);
  if (!videos.length) return result;
  const relations = await loadPostgresItemVersionFamilyRelations(db, videos.map(item => ({
    itemId: item.Id,
    primaryVersionId: item.PrimaryVersionId ?? null,
  })), [...videoTypes]);
  for (const relation of relations) {
    let version;
    if (relation.kind === 'root') version = roots.get(relation.rootKey);
    else {
      version = mapRecord(relation.record);
      if (version) version.ProviderIds = relation.providerIds;
    }
    if (!version || !isVideo(version)) continue;
    if (!result.has(relation.rootKey)) result.set(relation.rootKey, []);
    if (relation.kind === 'root') result.set(relation.rootKey, [version]);
    else result.get(relation.rootKey).push(version);
  }
  return result;
}

const dateOrder = value => {
  const [seconds, fraction = ''] = String(value ?? '0001-01-01 00:00:00').replace('T', ' ').replace(/Z$/, '').split('.');
  return `${seconds}.${fraction.padEnd(7, '0')}`;
};

export async function applyVersionUserData(db, userId, item, dto) {
  if (!isVideo(item) || item.PrimaryVersionId && guidN(item.PrimaryVersionId) !== emptyGuid) return dto;
  const versions = await itemVersions(db, item);
  if (versions.length < 2) return dto;
  const postgresRows = await loadPostgresUserDataRows(db, userId, versions.map(version => version.Id));
  const postgresKeys = await postgresUserDataKeyMap(db, versions);
  let winner;
  for (const version of versions) {
    const data = await readUserDataRows(db, version,
      postgresRows.filter(row => sameGuid(row.ItemId, version.Id)), postgresKeys.get(guidN(version.Id)));
    if ((data.PlaybackPositionTicks > 0n || data.Played) && (!winner || dateOrder(data.LastPlayedDate) > dateOrder(winner.data.LastPlayedDate))) winner = { version, data };
  }
  if (winner) {
    dto.Played ||= winner.data.Played;
    if (dateOrder(winner.data.LastPlayedDate) > dateOrder(dto.LastPlayedDate)) dto.LastPlayedDate = dtoDate(winner.data.LastPlayedDate);
    if (!sameGuid(winner.version.Id, item.Id) && winner.data.Played && winner.data.PlaybackPositionTicks <= 0n) { dto.PlaybackPositionTicks = 0n; dto.PlayedPercentage = null; }
  }
  return dto;
}

export class UserDataService extends EventEmitter {
  constructor({ store, library, users, clock = () => new Date(), configuration = {} }) {
    super(); Object.assign(this, { store, library, users, clock, configuration });
  }
  async get(userId, itemId) {
    userId = nativeGuid(userId);
    const item = await this.requireItem(userId, itemId);
    if (item.IsFolder && this.library && this.users) return (await this.library.getItemDto(item, { user: await this.users.getUser(userId), fields: [], enableImages: false })).UserData;
    return this.store.run(async (db) => applyVersionUserData(db, userId, item, userDataDto(item, await readUserData(db, userId, item))));
  }
  async getMany(userId, references) {
    userId = nativeGuid(userId);
    const values = [...references];
    if (this.library?.getUserDataList && this.users) {
      const user = await this.users.getUser(userId);
      if (!user) throw Object.assign(new Error('User not found.'), { status: 404 });
      return this.library.getUserDataList(values, { user });
    }
    const result = new Map();
    for (const reference of values) {
      let dto;
      try { dto = await this.get(userId, reference.id); }
      catch (error) {
        if (error.status !== 404 || !reference.fallbackId) {
          if (error.status === 404) continue;
          throw error;
        }
        try { dto = await this.get(userId, reference.fallbackId); }
        catch (fallbackError) { if (fallbackError.status === 404) continue; throw fallbackError; }
      }
      if (dto) result.set(guidN(dto.ItemId ?? reference.id), dto);
    }
    return [...result.values()];
  }
  async requireItem(userId, itemId) {
    userId = nativeGuid(userId);
    const user = this.users ? await this.users.getUser(userId) : await this.store.run(async (db) => (await db.rows('Users', {
      where: { Id: userId }, limit: 1
    }))[0]);
    if (!user) throw Object.assign(new Error('User not found.'), { status: 404 });
    const item = this.library ? await this.library.getItemRecord(itemId, { user }) : await this.store.run(async (db) => {
      const row = (await db.rows('BaseItems', { where: { Id: nativeGuid(itemId) }, limit: 1 }))[0];
      return row ? hydrateItem(db, row) : null;
    });
    if (!item) throw Object.assign(new Error('Item not found.'), { status: 404 });
    return item;
  }
  async readTransient(userId, item) {
    userId = nativeGuid(userId);
    return this.store.run(db => readUserData(db, userId, item));
  }
  async mutate(userId, item, mutate, reason) {
    userId = nativeGuid(userId);
    let event;
    await this.store.serializeWrites(async () => {
      await this.store.transaction(async (db) => {
        const keys = (await postgresUserDataKeyMap(db, [item])).get(guidN(item.Id));
        const data = await readUserDataRows(db, item,
          await loadPostgresUserDataRows(db, userId, [item.Id]), keys);
        if (await mutate(data, db) === false) return;
        await upsertPostgresUserDataRows(db, userDataRowsForSave(userId, item, data, keys));
        const changeReferences = reason === 'PlaybackProgress' ? null : await this.#captureChangeReferences(db, item);
        event = { Keys: keys, UserData: { ...data }, SaveReason: reason,
          UserId: userId, Item: item, ChangeReferences: changeReferences };
      });
      if (event) {
        // UserDataManager publishes its cache and rehydrates BaseItem.UserData
        // only after the SQL transaction commits, and before another writer.
        const attached = await this.store.run(db => db.rows('UserData', { where: { ItemId: item.Id } }));
        item.UserData = attached;
      }
    });
    // Listener work is outside the database writer boundary; subscribers may
    // enqueue independent database work and must not inherit the locked scope.
    if (event) this.emit('UserDataSaved', event);
    return event?.UserData;
  }
  async #captureChangeReferences(db, item) {
    const result = [{ id: item.Id, item }];
    let related = null;
    for (const id of [item.OwnerId, item.ParentId]) {
      if (id == null || sameGuid(id, emptyGuid)) continue;
      const row = (await db.rows('BaseItems', { where: { Id: nativeGuid(id) }, limit: 1 }))[0];
      if (row) { related = await hydrateItem(db, row); break; }
    }
    if (related) result.push({ id: related.Id, item: related });
    return result;
  }
  async update(userId, itemId, dto) {
    for (const field of ['IsFavorite', 'Likes', 'Played']) if (dto[field] != null && typeof dto[field] !== 'boolean') throw domainError(400, 'Invalid Boolean.');
    if (dto.PlayCount != null && (!Number.isInteger(dto.PlayCount) || dto.PlayCount < -2147483648 || dto.PlayCount > 2147483647)) throw domainError(400, 'Int32 out of range.');
    const item = await this.requireItem(userId, itemId);
    await this.mutate(userId, item, (data) => {
      for (const field of ['PlaybackPositionTicks', 'PlayCount', 'IsFavorite', 'Likes', 'Played', 'LastPlayedDate', 'Rating']) if (dto[field] != null) {
        if (field === 'Likes') assignLikes(data, dto[field]);
        else if (field === 'Rating') assignRating(data, dto[field]);
        else data[field] = field === 'PlaybackPositionTicks' ? int64(dto[field]) : field === 'LastPlayedDate' ? nativeDate(dto[field]) : dto[field];
      }
    }, 'UpdateUserData');
    return this.get(userId, itemId);
  }
  async setFavorite(userId, itemId, value) {
    const item = await this.requireItem(userId, itemId);
    await this.mutate(userId, item, (data) => { data.IsFavorite = value; }, 'UpdateUserRating');
    return this.get(userId, itemId);
  }
  async setLikes(userId, itemId, value) {
    const item = await this.requireItem(userId, itemId);
    await this.mutate(userId, item, (data) => { assignLikes(data, value); }, 'UpdateUserRating');
    return this.get(userId, itemId);
  }
  async setPlayed(userId, itemId, played, { datePlayed } = {}) {
    const item = await this.requireItem(userId, itemId);
    if (item.IsFolder) {
      const user = await this.users.getUser(userId);
      const children = await this.library.getItemList({ ParentId: item.Id, Recursive: true,
        Filters: ['IsNotFolder'], EnableImages: false, EnableUserData: false,
        ...(played ? { PlayedFolderScope: { played: true,
          displayMissingEpisodes: Boolean(user.DisplayMissingEpisodes),
          now: nativeDate(this.clock()) } } : {}),
      }, { user });
      await this.#setPlayedItemsPostgres(userId, children, played, datePlayed, [item]);
      return this.get(userId, itemId);
    }
    await this.#setPlayedItem(userId, item, played, datePlayed);
    return this.get(userId, itemId);
  }
  async #setPlayedItem(userId, item, played, datePlayed) {
    await this.#setPlayedItemsPostgres(userId, [item], played, datePlayed);
  }
  async #setPlayedItemsPostgres(userId, items, played, datePlayed, contextItems = []) {
    if (!items.length) return;
    userId = nativeGuid(userId);
    const committedEvents = [];
    let failure;
    try {
      await this.store.serializeWrites(async () => {
        const operations = [];
        await this.store.run(async db => {
        const families = await postgresItemVersionFamilies(db, items);
        const versionsById = new Map();
        for (const item of [...contextItems, ...items]) versionsById.set(guidN(item.Id), item);
        for (const versions of families.values()) for (const version of versions) {
          versionsById.set(guidN(version.Id), version);
        }
        const contextIds = new Set(contextItems.map(item => guidN(item.Id)));
        const stateItems = [...versionsById.values()].filter(version => !contextIds.has(guidN(version.Id)));
        const keyMap = await postgresUserDataKeyMap(db, stateItems);
        const existing = await loadPostgresUserDataRows(db, userId,
          [...versionsById.values()].map(version => version.Id));
        const states = new Map();
        for (const version of stateItems) {
          const keys = keyMap.get(guidN(version.Id));
          const data = await readUserDataRows(db, version,
            existing.filter(row => sameGuid(row.ItemId, version.Id)), keys);
          states.set(guidN(version.Id), { item: version, keys, data });
        }
        const referenceIds = new Set();
        for (const { item } of states.values()) for (const value of [item.OwnerId, item.ParentId]) {
          if (value != null && !sameGuid(value, emptyGuid)) referenceIds.add(nativeGuid(value));
        }
        const references = new Map([...versionsById].map(([key, value]) => [key, value]));
        if (referenceIds.size) for (const row of await db.rows('BaseItems', { whereIn: { Id: [...referenceIds] } })) {
          const reference = mapRecord(row);
          if (reference) references.set(guidN(reference.Id), reference);
        }
        const operationFor = state => {
          state.data.Key = state.keys.at(-1);
          const changeReferences = [{ id: state.item.Id, item: state.item }];
          for (const id of [state.item.OwnerId, state.item.ParentId]) {
            const related = references.get(guidN(id));
            if (related) { changeReferences.push({ id: related.Id, item: related }); break; }
          }
          const data = { ...state.data };
          operations.push({ state, data, event: { Keys: state.keys, UserData: data, SaveReason: 'TogglePlayed',
            UserId: userId, Item: state.item, ChangeReferences: changeReferences } });
        };
        for (const item of items) {
          const direct = states.get(guidN(item.Id));
          if (!direct) continue;
          if (played) {
            direct.data.PlayCount = Math.max(datePlayed == null ? direct.data.PlayCount
              : (direct.data.PlayCount + 1) | 0, 1);
            direct.data.LastPlayedDate = datePlayed == null ? direct.data.LastPlayedDate
              ?? nativeDate(this.clock()) : nativeDate(datePlayed);
            direct.data.Played = true;
            direct.data.PlaybackPositionTicks = 0n;
          } else resetPlayed(direct.data);
          operationFor(direct);
          for (const version of families.get(guidN(item.Id)) ?? [item]) {
            if (sameGuid(version.Id, item.Id)) continue;
            const alternate = states.get(guidN(version.Id));
            if (!alternate) continue;
            if (played) { alternate.data.Played = true; alternate.data.PlaybackPositionTicks = 0n; }
            else resetPlayed(alternate.data);
            operationFor(alternate);
          }
        }
        });
        // BaseItem.MarkPlayed/MarkUnplayed and Video propagation invoke
        // UserDataManager.SaveUserData separately. Preserve that committed
        // prefix: a later alternate or folder child failure cannot roll back
        // earlier rows, and prevents subsequent saves.
        for (const operation of operations) {
          await this.store.transaction(db => upsertPostgresUserDataRows(db,
            userDataRowsForSave(userId, operation.state.item, operation.data, operation.state.keys)));
          operation.state.item.UserData = await this.store.run(db => loadPostgresUserDataRows(db, null,
            [operation.state.item.Id]));
          committedEvents.push(operation.event);
        }
      });
    } catch (error) { failure = error; }
    for (const event of committedEvents) this.emit('UserDataSaved', event);
    if (failure) throw failure;
  }
  async versions(item) {
    return this.store.run((db) => itemVersions(db, item));
  }
  async propagatePlayed(userId, item, played) {
    userId = nativeGuid(userId);
    const committedEvents = [];
    let failure;
    try {
      await this.store.serializeWrites(async () => {
        const operations = [];
        await this.store.run(async db => {
        const versions = (await itemVersions(db, item)).filter(version => !sameGuid(version.Id, item.Id));
        if (!versions.length) return;
        const keyMap = await postgresUserDataKeyMap(db, versions);
        const existing = await loadPostgresUserDataRows(db, userId, versions.map(version => version.Id));
        const referenceIds = new Set();
        for (const version of versions) for (const value of [version.OwnerId, version.ParentId]) {
          if (value != null && !sameGuid(value, emptyGuid)) referenceIds.add(nativeGuid(value));
        }
        const references = new Map();
        if (referenceIds.size) for (const row of await db.rows('BaseItems', {
          whereIn: { Id: [...referenceIds] },
        })) {
          const reference = mapRecord(row);
          if (reference) references.set(guidN(reference.Id), reference);
        }
        for (const version of versions) {
          const keys = keyMap.get(guidN(version.Id));
          const data = await readUserDataRows(db, version,
            existing.filter(row => sameGuid(row.ItemId, version.Id)), keys);
          if (played) { data.Played = true; data.PlaybackPositionTicks = 0n; }
          else resetPlayed(data);
          const changeReferences = [{ id: version.Id, item: version }];
          for (const id of [version.OwnerId, version.ParentId]) {
            const related = references.get(guidN(id));
            if (related) { changeReferences.push({ id: related.Id, item: related }); break; }
          }
          const savedData = { ...data };
          operations.push({ version, keys, data: savedData,
            event: { Keys: keys, UserData: savedData, SaveReason: 'TogglePlayed', UserId: userId,
              Item: version, ChangeReferences: changeReferences } });
        }
        });
        for (const operation of operations) {
          await this.store.transaction(db => upsertPostgresUserDataRows(db,
            userDataRowsForSave(userId, operation.version, operation.data, operation.keys)));
          operation.version.UserData = await this.store.run(db => loadPostgresUserDataRows(db, null,
            [operation.version.Id]));
          committedEvents.push(operation.event);
        }
      });
    } catch (error) { failure = error; }
    for (const event of committedEvents) this.emit('UserDataSaved', event);
    if (failure) throw failure;
  }
  async playback(user, item, phase, info) {
    let completed = false;
    if (phase === 'stop' && info.Failed) return false;
    const data = await this.mutate(user.Id, item, async (data) => {
      if (phase === 'start') {
        data.PlayCount = (data.PlayCount + 1) | 0; data.LastPlayedDate = nativeDate(this.clock());
        if (supportsPlayed(item) && !supportsResume(item)) data.Played = true;
      } else if (phase === 'stop') {
        if (info.PositionTicks != null) completed = updatePlayState(item, data, info.PositionTicks, this.configuration);
        else { data.PlayCount = (data.PlayCount + 1) | 0; data.Played = supportsPlayed(item); data.PlaybackPositionTicks = 0n; completed = true; }
      } else {
        let changed = false;
        if (info.PositionTicks != null) { updatePlayState(item, data, info.PositionTicks, this.configuration); changed = true; }
        for (const [remember, field] of [['RememberAudioSelections', 'AudioStreamIndex'], ['RememberSubtitleSelections', 'SubtitleStreamIndex']]) {
          if (user[remember] ?? user.Configuration?.[remember]) { if (info[field] != null && data[field] !== info[field]) { data[field] = info[field]; changed = true; } }
          else if (data[field] != null) { data[field] = null; changed = true; }
        }
        if (!changed) return false;
      }
    }, { start: 'PlaybackStart', progress: 'PlaybackProgress', stop: 'PlaybackFinished' }[phase]);
    if (phase !== 'start' && data?.Played) await this.propagatePlayed(user.Id, item, true);
    if (phase === 'progress' && ((!user.RememberAudioSelections && info.AudioStreamIndex != null) || (!user.RememberSubtitleSelections && info.SubtitleStreamIndex != null))) {
      await this.store.transaction(async (db) => {
        await db.updateWhere('UserData', { ItemId: item.Id, UserId: user.Id }, {
          AudioStreamIndex: null,
          SubtitleStreamIndex: null,
        });
      });
    }
    return completed;
  }
}
function resetPlayed(data) { data.PlayCount = 0; data.PlaybackPositionTicks = 0n; data.LastPlayedDate = null; data.Played = false; }
