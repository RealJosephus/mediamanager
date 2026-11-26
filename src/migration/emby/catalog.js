import { nativeGuid } from '../../users/native.js';
import { searchHistoryClient, searchHistoryKey } from '../../sessions/search-history.js';
import { commonLibraryOptions, libraryLocations } from './libraries.js';
import { readMarkers } from './chapter-markers.js';
import {
  itemTypes,
  scalarFields,
  dateFields,
  stateFields,
  portableValue,
  fromBlob,
  providers,
  imageEntries,
  locks,
  images,
  statement,
  keyFor,
  timeToSeconds,
  toImageTicks,
} from './format.js';

export const valueTypes = { Artists: 0, AlbumArtists: 1, Genres: 2, Studios: 3, Tags: 4 };
const linkTypes = Object.fromEntries(Object.entries(valueTypes).map(([name, id]) => [id, name]));
export const personTypes = [
  'Actor',
  'Director',
  'Writer',
  'Producer',
  'GuestStar',
  'Composer',
  'Conductor',
  'Lyricist',
];
export const streamFields = [
  'StreamIndex',
  'StreamType',
  'Codec',
  'Language',
  'ChannelLayout',
  'Profile',
  'AspectRatio',
  'Path',
  'IsInterlaced',
  'BitRate',
  'Channels',
  'SampleRate',
  'IsDefault',
  'IsForced',
  'IsExternal',
  'Height',
  'Width',
  'AverageFrameRate',
  'RealFrameRate',
  'Level',
  'PixelFormat',
  'BitDepth',
  'IsAnamorphic',
  'RefFrames',
  'CodecTag',
  'Comment',
  'Title',
  'TimeBase',
  'ColorPrimaries',
  'ColorSpace',
  'ColorTransfer',
  'IsHearingImpaired',
];
const chapterFields = ['ChapterIndex', 'StartPositionTicks', 'Name', 'ImagePath'];
export const numeric = (name, value) => portableValue(name, value);
export function fields(row, names) {
  const columns = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  const result = {};
  for (const name of names) {
    const column = columns.get(name.toLowerCase());
    if (column !== undefined || name !== 'IsHearingImpaired') result[name] = numeric(name, row[column]);
  }
  return result;
}
export function jellyfinPlaybackState(row) {
  return { ...fields(row, stateFields), LastPlayedDate: timeToSeconds(row.LastPlayedDate) };
}
export function schemaColumns(db, table, schema = 'main') {
  return new Set(
    db
      .prepare(`PRAGMA ${schema}.table_info("${table}")`)
      .all()
      .map((c) => c.name),
  );
}
function guid(value) {
  return value ? nativeGuid(value) : null;
}
const scan = (db, sql) => statement(db, sql).iterate();
function baseItem(row, type) {
  return {
    type,
    ...fields(row, scalarFields),
    ParentId: null,
    SeriesId: null,
    Providers: [],
    LockedFields: [],
    Images: [],
    Members: [],
    People: [],
    Chapters: [],
    IntroSkip: null,
    CreditsSkip: null,
    Streams: [],
    Artists: [],
    AlbumArtists: [],
    Genres: [],
    Studios: [],
    Tags: [],
  };
}
function register(map, key, value) {
  if (map.has(key)) throw new Error('Duplicate mapped identity: ' + key);
  map.set(key, value);
}
function readChildren(db, sql, values, field, project) {
  for (const row of scan(db, sql)) {
    const owner = values.get(row.ItemId);
    if (owner) owner[field].push(project(row));
  }
}
function jsonUser(value) {
  const user = JSON.parse(value);
  if (!user || typeof user !== 'object' || typeof user.Name !== 'string' || !user.Name)
    throw new Error('Unknown Emby user serialization');
  return user;
}

export function embyCatalog(db, serverId, report) {
  const items = new Map(),
    users = new Map(),
    idMap = new Map(),
    userMap = new Map(),
    rawItems = new Map(),
    shared = new Map();
  const rows = new Map();
  const cols = schemaColumns(db, 'MediaItems');
  const required = [
    'Id',
    'guid',
    'type',
    'UserDataKeyId',
    'ProviderIds',
    'Images',
    'LockedFields',
    ...scalarFields,
    ...dateFields,
  ];
  for (const key of required) if (!cols.has(key)) throw new Error('Unsupported Emby MediaItems column: ' + key);
  for (const r of scan(db, 'SELECT * FROM MediaItems ORDER BY Id')) {
    const id = fromBlob(r.guid, serverId + '/item/' + r.Id);
    register(idMap, r.Id, id);
    register(rawItems, id, r);
    if (!itemTypes[Number(r.type)]) {
      report('origin-only', 'item', id, 'type', String(r.type));
      continue;
    }
    const item = baseItem(r, itemTypes[Number(r.type)]);
    item.Container = r.Container ?? null;
    if (Number(r.type) === 8) item.IndexNumberEnd = numeric('IndexNumberEnd', r.IndexNumberEnd);
    if (Number(r.type) === 4)
      Object.assign(item, { CollectionType: null, PhysicalFolders: [], Locations: [], Options: {} });
    for (const field of dateFields) item[field] = r[field] == null ? null : String(r[field]);
    item.Providers = providers(r.ProviderIds).filter(([key, value]) => {
      if (value != null && key) return true;
      report('origin-only', 'item', id, 'ProviderIds', key);
      return false;
    });
    item.LockedFields = (r.LockedFields || '')
      .split('|')
      .filter(Boolean)
      .filter((name) => {
        if (locks.includes(name)) return true;
        report('origin-only', 'item', id, 'LockedFields', name);
        return false;
      })
      .sort();
    item.Images = imageEntries(r.Images).filter((image) => {
      if (!image.raw) return true;
      report('origin-only', 'item', id, 'Images', 'unrecognized record');
      return false;
    });
    register(items, r.Id, item);
    register(rows, keyFor('item', id), item);
    if (r.UserDataKeyId != null) {
      const group = shared.get(r.UserDataKeyId) ?? [];
      group.push(id);
      shared.set(r.UserDataKeyId, group);
    }
  }
  for (const [int, item] of items) {
    const r = rawItems.get(idMap.get(int));
    item.Album = r.AlbumId == null ? null : (rawItems.get(idMap.get(r.AlbumId))?.Name ?? null);
    for (const name of ['ParentId', 'SeriesId']) {
      if (r[name] != null && !items.has(r[name]))
        report('origin-only', 'item', idMap.get(int), name, String(r[name]));
      item[name] = items.has(r[name]) ? idMap.get(r[name]) : null;
    }
  }
  for (const r of scan(db, 'SELECT * FROM accounts.LocalUsersv2 ORDER BY Id')) {
    const id = fromBlob(r.guid, serverId + '/user/' + r.Id),
      u = jsonUser(r.data);
    register(userMap, r.Id, id);
    register(users, id, r);
    register(rows, keyFor('user', id), { Username: u.Name });
  }
  readChildren(
    db,
    'SELECT ListId AS ItemId,ListItemId FROM ListItems ORDER BY ListId,ListItemOrder,ListItemEntryId',
    items,
    'Members',
    (r) => idMap.get(r.ListItemId),
  );
  const links =
    'SELECT l.ItemId,l.Type,l.LinkedId,r.Name FROM ItemLinks2 l JOIN MediaItems r ON r.Id=l.LinkedId WHERE l.Type IS NOT 6 ORDER BY l.ItemId,l.Type,l.LinkOrder,l.LinkedId';
  for (const r of scan(db, links)) {
    if (Number(r.Type) === 8) {
      const folder = items.get(r.ItemId);
      if (folder?.PhysicalFolders && items.has(r.LinkedId)) folder.PhysicalFolders.push(idMap.get(r.LinkedId));
      continue;
    }
    const field = linkTypes[Number(r.Type)];
    if (field && items.has(r.ItemId) && r.Name) items.get(r.ItemId)[field].push(r.Name);
    else if (!field && ![7].includes(Number(r.Type)))
      report('origin-only', 'item', idMap.get(r.ItemId), 'ItemLinks2.Type', String(r.Type));
  }
  for (const { ItemId, LinkedId } of scan(db,
    'SELECT ItemId,LinkedId FROM ItemLinks2 WHERE Type=6 ORDER BY LinkedId,LinkOrder,ItemId')) {
    const box = items.get(LinkedId);
    if (box && items.has(ItemId)) box.Members.push(idMap.get(ItemId));
  }
  for (const r of scan(
    db,
    "SELECT e.ItemId,e.Value FROM ItemExtradata e JOIN ItemExtradataTypes t ON t.ExtradataTypeId=e.ExtradataTypeId WHERE t.Name='LibraryOptions'",
  )) {
    const folder = items.get(r.ItemId);
    if (!folder?.PhysicalFolders) continue;
    const data = JSON.parse(r.Value);
    folder.CollectionType = data.ContentType ?? null;
    folder.Locations = libraryLocations(data);
    folder.Options = commonLibraryOptions(data);
  }
  readChildren(
    db,
    'SELECT p.*,m.Name FROM ItemPeople2 p JOIN MediaItems m ON m.Id=p.PersonId ORDER BY p.ItemId,p.ListOrder,p.rowid',
    items,
    'People',
    (r) => ({
      Id: idMap.get(r.PersonId),
      Name: r.Name,
      Role: r.Role ?? '',
      Type: personTypes[Number(r.PersonType)] ?? null,
    }),
  );
  readChildren(db, 'SELECT * FROM Chapters3 WHERE MarkerType IS NULL OR MarkerType=0 ORDER BY ItemId,ChapterIndex', items, 'Chapters', (r) =>
    ({ ...fields(r, chapterFields), ImageDateModified: r.ImageDateModified ? String(r.ImageDateModified) : null }),
  );
  readMarkers(db, 'emby', items, id => idMap.get(id), report);
  readChildren(db, 'SELECT * FROM MediaStreams2 ORDER BY ItemId,StreamIndex', items, 'Streams', (r) =>
    fields(r, streamFields),
  );
  const states = new Map();
  const hasDateLastSearched = schemaColumns(db, 'UserDatas').has('DateLastSearchedInt');
  for (const r of scan(db, 'SELECT * FROM UserDatas ORDER BY userId,UserDataKeyId')) {
    const ids = shared.get(r.UserDataKeyId),
      user = userMap.get(r.userId);
    if (!user || !ids) {
      report('origin-only', 'play', String(r.UserDataKeyId), 'user/key', 'unlinked');
      continue;
    }
    for (const id of ids) {
      const key = keyFor('play', id, user);
      register(rows, key, {
        ...fields(r, stateFields),
        LastPlayedDate: r.LastPlayedDateInt == null ? null : String(r.LastPlayedDateInt),
      });
      states.set(key, r);
      if (hasDateLastSearched && r.DateLastSearchedInt != null)
        register(rows, keyFor('search', id, user), { [searchHistoryKey]: String(r.DateLastSearchedInt) });
    }
  }
  return { rows, items: rawItems, users, states, idMap, userMap, shared, hasDateLastSearched };
}

export function jellyfinCatalog(db, report) {
  const rows = new Map(),
    items = new Map(),
    users = new Map(),
    states = new Map(),
    ambiguous = new Map();
  for (const r of scan(db, 'SELECT * FROM BaseItems ORDER BY Id')) {
    const id = guid(r.Id);
    if (!itemTypes.includes(r.Type)) {
      report('origin-only', 'item', id, 'type', r.Type);
      continue;
    }
    const item = baseItem(r, r.Type);
    let data;
    try {
      data = r.Data ? JSON.parse(r.Data) : {};
    } catch {
      report('origin-only', 'item', id, 'Data', 'invalid native JSON');
    }
    item.Container = typeof data?.Container === 'string' ? data.Container : null;
    if (r.Type === itemTypes[8]) item.IndexNumberEnd = data?.IndexNumberEnd ?? null;
    if (r.Type === itemTypes[4]) {
      data ??= {};
      Object.assign(item, {
        CollectionType: data.CollectionType ?? null,
        PhysicalFolders: (data.PhysicalFolderIds ?? []).map(guid),
        Locations: data.PhysicalLocationsList ?? [],
        Options: {},
      });
    }
    for (const field of dateFields) item[field] = timeToSeconds(r[field]);
    item.ParentId = guid(r.ParentId);
    item.SeriesId = guid(r.SeriesId);
    item.Album = r.Album;
    items.set(r.Id, item);
    register(rows, keyFor('item', id), item);
  }
  for (const r of scan(db, 'SELECT * FROM Users ORDER BY Id')) {
    users.set(guid(r.Id), r);
    register(rows, keyFor('user', guid(r.Id)), { Username: r.Username });
  }
  readChildren(
    db,
    'SELECT * FROM BaseItemProviders ORDER BY ItemId,ProviderId COLLATE BINARY',
    items,
    'Providers',
    (r) => [r.ProviderId, r.ProviderValue],
  );
  readChildren(
    db,
    'SELECT * FROM BaseItemMetadataFields ORDER BY ItemId,Id',
    items,
    'LockedFields',
    (r) => locks[Number(r.Id)],
  );
  for (const item of items.values()) item.LockedFields = item.LockedFields.filter(Boolean).sort();
  readChildren(db, 'SELECT * FROM BaseItemImageInfos ORDER BY rowid', items, 'Images', (r) => ({
    Path: r.Path,
    DateModified: toImageTicks(r.DateModified),
    ImageType: images[Number(r.ImageType)],
    Width: Number(r.Width),
    Height: Number(r.Height),
  }));
  readChildren(
    db,
    'SELECT ParentId AS ItemId,ChildId FROM LinkedChildren WHERE ChildType=0 ORDER BY ParentId,SortOrder',
    items,
    'Members',
    (r) => guid(r.ChildId),
  );
  const names =
    'SELECT m.ItemId,v.Type,v.Value FROM ItemValuesMap m JOIN ItemValues v ON v.ItemValueId=m.ItemValueId ORDER BY m.rowid';
  for (const r of scan(db, names)) {
    const field = Object.keys(valueTypes).find((k) => valueTypes[k] === Number(r.Type));
    if (field && items.has(r.ItemId)) items.get(r.ItemId)[field].push(r.Value);
  }
  readChildren(
    db,
    'SELECT p.ItemId,p.PeopleId,p.Role,n.Name,n.PersonType FROM PeopleBaseItemMap p JOIN Peoples n ON n.Id=p.PeopleId ORDER BY p.ItemId,p.ListOrder,p.rowid',
    items,
    'People',
    (r) => ({
      Id: guid(r.PeopleId),
      Name: r.Name,
      Role: r.Role ?? '',
      Type: r.PersonType == null ? null : String(r.PersonType),
    }),
  );
  readChildren(db, 'SELECT * FROM Chapters ORDER BY ItemId,ChapterIndex', items, 'Chapters', (r) =>
    ({ ...fields(r, chapterFields), ImageDateModified: timeToSeconds(r.ImageDateModified) }),
  );
  readMarkers(db, 'jellyfin', items, guid, report);
  readChildren(db, 'SELECT * FROM MediaStreamInfos ORDER BY ItemId,StreamIndex', items, 'Streams', (r) =>
    fields(r, streamFields),
  );
  for (const r of scan(
    db,
    'SELECT * FROM UserData ORDER BY ItemId,UserId,LastPlayedDate DESC,PlayCount DESC,PlaybackPositionTicks DESC,CustomDataKey',
  )) {
    const key = keyFor('play', guid(r.ItemId), guid(r.UserId));
    const record = jellyfinPlaybackState(r);
    if (!rows.has(key)) {
      rows.set(key, record);
      states.set(key, [r]);
    } else {
      states.get(key).push(r);
      for (const name of Object.keys(record)) {
        if (rows.get(key)[name] === record[name]) continue;
        const names = ambiguous.get(key) ?? new Set();
        if (!names.has(name))
          report('conflict', 'play', key, name, 'different values across native custom keys');
        names.add(name);
        ambiguous.set(key, names);
      }
    }
  }
  for (const row of statement(db, `SELECT ItemId,UserId,Value FROM CustomItemDisplayPreferences
    WHERE Client=? AND Key=? AND Value IS NOT NULL ORDER BY ItemId,UserId`).iterate(searchHistoryClient, searchHistoryKey)) {
    const user = guid(row.UserId), key = keyFor('search', guid(row.ItemId), user);
    if (items.has(row.ItemId) && users.has(user)) register(rows, key, { [searchHistoryKey]: row.Value });
    else report('origin-only', 'search', key, searchHistoryKey, 'missing item or user');
  }
  return { rows, items, users, states, ambiguous };
}
