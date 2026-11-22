import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { tokenizeJson } from '../../core/json-tokens.js';
import { exists } from './files.js';
import {
  itemTypes,
  scalarFields,
  dateFields,
  stateFields,
  toBlob,
  same,
  sqliteValue,
  statement,
  imageEntries,
  locks,
  editObjectFields,
  jsonProperty,
} from './format.js';
import { valueTypes, personTypes } from './catalog.js';
import { isMarkerField, reserveChapterIndexes, writeMarker } from './chapter-markers.js';
import { insert, update } from './write-jellyfin.js';
import { editEmbyLibraryOptions } from './libraries.js';

const configName = name => typeof name === 'string' && name && !/[/\\:*?"<>|\u0000-\u001f]/u.test(name) &&
  !['.', '..'].includes(name) && !/[. ]$/u.test(name);

async function renameExistingUser(db, user, id, username, root, report) {
  const { data } = db.prepare('SELECT data FROM accounts.LocalUsersv2 WHERE Id=?').get(user);
  let updated, previousName, legacy;
  try {
    const json = tokenizeJson(data);
    previousName = jsonProperty(json, 'Name')?.value;
    const usesId = jsonProperty(json, 'UsesIdForConfigurationPath')?.value;
    if (usesId != null && typeof usesId !== 'boolean') throw new Error('Invalid user configuration path mode');
    legacy = usesId !== true;
    if (legacy && (!configName(previousName) || !configName(username)))
      throw new Error('legacy policy directory name cannot be moved unambiguously');
    updated = editObjectFields(data, { Name: username, ...(legacy ? { UsesIdForConfigurationPath: true } : {}) });
  } catch (error) {
    report('conflict', 'user', id, 'Username', error.message);
    return;
  }
  if (legacy) {
    const users = path.join(root, 'config', 'users');
    const oldDir = path.join(users, previousName);
    const newDir = path.join(users, id.replaceAll('-', '').toLowerCase());
    if (oldDir !== newDir && await exists(newDir)) {
      report('conflict', 'user', id, 'Username', 'target policy directory already exists');
      return;
    }
    if (oldDir !== newDir && await exists(oldDir)) await rename(oldDir, newDir);
  }
  update(db, 'LocalUsersv2', { data: updated }, { Id: user }, { schema: 'accounts' });
}

function remove(db, table, column, id) {
  db.prepare('DELETE FROM "' + table + '" WHERE "' + column + '"=?').run(id);
}
function getKey(db, id) {
  const key = id.replaceAll('-', '').toLowerCase();
  db.prepare('INSERT INTO UserDataKeys2(UserDataKey) VALUES (?) ON CONFLICT DO NOTHING').run(key);
  return statement(db, 'SELECT Id FROM UserDataKeys2 WHERE UserDataKey=?').get(key).Id;
}
function findOrCreateNamed(db, type, name, existingId) {
  const row = existingId
    ? statement(db, 'SELECT Id FROM MediaItems WHERE guid=? AND type=?').get(toBlob(existingId), type)
    : null;
  if (row) return row.Id;
  const matches = statement(db, 'SELECT Id FROM MediaItems WHERE type=? AND Name=? LIMIT 2').all(type, name);
  if (matches.length > 1) throw new Error('Ambiguous Emby named item: ' + name);
  if (matches.length) return matches[0].Id;
  const id = existingId ?? randomUUID();
  return insert(db, 'MediaItems', { guid: toBlob(id), type, Name: name, UserDataKeyId: getKey(db, id) })
    .lastInsertRowid;
}
function refreshSearch(db, int) {
  const table = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='fts_search9'").get();
  if (!table) return;
  db.prepare('DELETE FROM fts_search9 WHERE rowid=?').run(int);
  db.prepare(
    'INSERT INTO fts_search9(rowid,Name,OriginalTitle,SeriesName,Album) SELECT m.Id,m.Name,m.OriginalTitle,m.SeriesName,a.Name FROM MediaItems m LEFT JOIN MediaItems a ON a.Id=m.AlbumId WHERE m.Id=?',
  ).run(int);
}
function removeMedia(db, id) {
  // Unknown references must fail the final foreign key check. A deletion only
  // touches rows owned by the item, leaving shared names, accounts and keys intact.
  for (const [t, c] of [
    ['MediaStreams2', 'ItemId'],
    ['Chapters3', 'ItemId'],
    ['ListItems', 'ListId'],
    ['ListItems', 'ListItemId'],
    ['ItemLinks2', 'ItemId'],
    ['ItemLinks2', 'LinkedId'],
    ['ItemPeople2', 'ItemId'],
    ['ItemPeople2', 'PersonId'],
    ['UserItemShares', 'ItemId'],
    ['AncestorIds2', 'ItemId'],
    ['AncestorIds2', 'AncestorId'],
    ['ItemExtradata', 'ItemId'],
    ['ImportedCollections', 'ItemId'],
  ]) {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(t)) remove(db, t, c, id);
  }
  remove(db, 'MediaItems', 'Id', id);
  refreshSearch(db, id);
}
function relation(db, field, id, integer, value, item, find, report) {
  if (field === 'LockedFields') {
    const raw = db.prepare('SELECT LockedFields FROM MediaItems WHERE Id=?').get(integer).LockedFields ?? '';
    const privateFields = raw.split('|').filter((name) => name && !locks.includes(name));
    update(db, 'MediaItems', { LockedFields: [...value, ...privateFields].join('|') || null }, { Id: integer });
    return;
  }
  if (field === 'Providers') {
    if (value.some(([key, v]) => !key || key.includes('=') || key.includes('|') || String(v).includes('|'))) {
      report('conflict', 'item', id, field, 'value contains the Emby delimiter');
      return;
    }
    const raw = db.prepare('SELECT ProviderIds FROM MediaItems WHERE Id=?').get(integer).ProviderIds;
    const next = new Map();
    for (const [key, id] of value) {
      if (!next.has(key)) next.set(key, []);
      next.get(key).push(key + '=' + id);
    }
    const serialized = [];
    for (const part of raw ? raw.split('|') : []) {
      const separator = part.indexOf('=');
      const replacement = separator < 1 ? part : next.get(part.slice(0, separator))?.shift();
      if (replacement !== undefined) serialized.push(replacement);
    }
    serialized.push(...[...next.values()].flat());
    update(
      db,
      'MediaItems',
      { ProviderIds: serialized.join('|') || null },
      { Id: integer },
    );
    return;
  }
  if (field === 'Images') {
    const originals = (db.prepare('SELECT Images FROM MediaItems WHERE Id=?').get(integer).Images ?? '')
      .split('|')
      .filter(Boolean);
    if (value.some((v) => !v.ImageType || !v.Path || v.Path.includes('|'))) {
      report('conflict', 'item', id, field, 'unsupported image type or delimiter');
      return;
    }
    const result = value.map((image) => {
      const index = originals.findIndex((raw) => {
        const a = imageEntries(raw)[0];
        return a?.Path === image.Path && a.ImageType === image.ImageType;
      });
      const original = index < 0 ? null : originals.splice(index, 1)[0];
      if (original && same(imageEntries(original)[0], image)) return original;
      const orientation =
        original
          ?.slice(original.lastIndexOf('*' + image.ImageType + '*') + image.ImageType.length + 2)
          .split('*')[2] ?? 'null';
      return [
        image.Path,
        image.DateModified ?? '0',
        image.ImageType,
        image.Width,
        image.Height,
        orientation,
      ].join('*');
    });
    result.push(...originals.filter((raw) => imageEntries(raw)[0]?.raw));
    update(db, 'MediaItems', { Images: result.join('|') || null }, { Id: integer });
    return;
  }
  if (field === 'Members') {
    const box = item.type === itemTypes[9];
    if (box && new Set(value).size !== value.length) {
      report('conflict', 'item', id, field, 'Emby collections require unique member IDs');
      return;
    }
    if (box) db.prepare('DELETE FROM ItemLinks2 WHERE Type=6 AND LinkedId=?').run(integer);
    else remove(db, 'ListItems', 'ListId', integer);
    value.forEach((child, i) => {
      const int = find(child);
      if (!int) {
        report('origin-only', 'item', id, field, String(child));
        return;
      }
      if (box)
        insert(db, 'ItemLinks2', { ItemId: int, Type: 6, LinkedId: integer, LinkOrder: i }, { ignore: true });
      else insert(db, 'ListItems', { ListId: integer, ListItemId: int, ListItemOrder: i });
    });
    return;
  }
  if (field === 'Chapters' || field === 'Streams') {
    const table = field === 'Streams' ? 'MediaStreams2' : 'Chapters3',
      key = field === 'Streams' ? 'StreamIndex' : 'ChapterIndex';
    const cols = new Set(
      db
        .prepare('PRAGMA table_info(' + table + ')')
        .all()
        .map((r) => r.name),
    );
    const range = ' WHERE ItemId=?' + (field === 'Chapters' ? ' AND (MarkerType=0 OR MarkerType IS NULL)' : '');
    const old = new Map(
      statement(db, 'SELECT * FROM ' + table + range)
        .all(integer)
        .map((r) => [Number(r[key]), r]),
    );
    db.prepare('DELETE FROM ' + table + range).run(integer);
    if (field === 'Chapters') reserveChapterIndexes(db, integer, value);
    for (const r of value) {
      const row = { ...(old.get(r[key]) ?? {}), ItemId: integer };
      for (const [k, v] of Object.entries(r)) if (cols.has(k)) row[k] = sqliteValue(k, v);
      if (field === 'Chapters') {
        row.MarkerType ??= 0;
        if (r.ImageDateModified != null) row.ImageDateModified = BigInt(r.ImageDateModified);
        else row.ImageDateModified = old.get(r[key])?.ImageDateModified === 0n ? 0n : null;
      }
      insert(db, table, row);
    }
    return;
  }
  if (field === 'People') {
    remove(db, 'ItemPeople2', 'ItemId', integer);
    value.forEach((p, i) => {
      const type = personTypes.indexOf(p.Type);
      if (type < 0) {
        report('origin-only', 'item', id, field, p.Name + ' (' + p.Type + ')');
        return;
      }
      insert(db, 'ItemPeople2', {
        ItemId: integer,
        PersonId: findOrCreateNamed(db, 23, p.Name, p.Id),
        Role: p.Role,
        PersonType: type,
        ListOrder: i,
      });
    });
    return;
  }
  if (Object.hasOwn(valueTypes, field)) {
    const type = {
      Artists: 13,
      AlbumArtists: 13,
      Genres: item.type === itemTypes[11] || item.type === itemTypes[12] ? 14 : 21,
      Studios: 29,
      Tags: 34,
    }[field];
    db.prepare('DELETE FROM ItemLinks2 WHERE ItemId=? AND Type=?').run(integer, valueTypes[field]);
    value.forEach((name, i) =>
      insert(
        db,
        'ItemLinks2',
        { ItemId: integer, Type: valueTypes[field], LinkedId: findOrCreateNamed(db, type, name), LinkOrder: i },
        { ignore: true },
      ),
    );
  }
}
export async function writeEmby(db, changes, catalog, source, report, root) {
  const ids = new Map([...catalog.items].map(([id, r]) => [id, r.Id]));
  const userIds = new Map([...catalog.users].map(([id, r]) => [id, r.Id]));
  const items = changes.filter((c) => c.key.startsWith('item/') && c.value);
  for (const { key, value } of items) {
    const id = key.slice(5);
    if (ids.has(id)) continue;
    const type = itemTypes.indexOf(value.type);
    if (type < 1) {
      report('origin-only', 'item', id, 'type', value.type);
      continue;
    }
    const result = insert(db, 'MediaItems', {
      guid: toBlob(id),
      type,
      Name: value.Name,
      UserDataKeyId: getKey(db, id),
    });
    ids.set(id, result.lastInsertRowid);
  }
  for (const { key, value, fields } of changes) {
    const [kind, id] = key.split('/');
    if (!value || kind === 'play') continue;
    if (kind === 'user') {
      if (!userIds.has(id)) {
        const found = statement(
          db,
          "SELECT Id FROM accounts.LocalUsersv2 WHERE lower(json_extract(data,'$.Name'))=lower(?)",
        ).get(value.Username);
        if (found) throw new Error('Emby username belongs to another identity: ' + value.Username);
        // Random unreachable credential. The original authentication material
        // belongs to the originating server and remains in the private snapshot.
        const data = {
          Name: value.Username,
          Password: randomBytes(48).toString('hex'),
          UsesIdForConfigurationPath: true,
        };
        const userDir = path.join(root, 'config', 'users', id.replaceAll('-', '').toLowerCase());
        await mkdir(userDir, { recursive: true, mode: 0o700 });
        await writeFile(
          path.join(userDir, 'policy.xml'),
          '<UserPolicy><IsAdministrator>false</IsAdministrator><IsDisabled>true</IsDisabled><EnableAllFolders>false</EnableAllFolders><EnableMediaPlayback>false</EnableMediaPlayback><EnableRemoteAccess>false</EnableRemoteAccess></UserPolicy>',
          { mode: 0o600, flag: 'wx' },
        );
        const r = insert(
          db,
          'LocalUsersv2',
          { guid: toBlob(id), data: JSON.stringify(data) },
          { schema: 'accounts' },
        );
        userIds.set(id, r.lastInsertRowid);
        report('requires-action', 'user', id, 'login', 'review the account in Emby and set a target password');
      } else if (fields.includes('Username'))
        await renameExistingUser(db, userIds.get(id), id, value.Username, root, report);
      continue;
    }
    const int = ids.get(id);
    if (!int) continue;
    const patch = {};
    if (value.type === itemTypes[4]) {
      if (fields.includes('PhysicalFolders')) {
        db.prepare('DELETE FROM ItemLinks2 WHERE ItemId=? AND Type=8').run(int);
        value.PhysicalFolders.forEach((child, index) => {
          if (!ids.has(child)) {
            report('origin-only', 'item', id, 'PhysicalFolders', child);
            return;
          }
          insert(db, 'ItemLinks2', { ItemId: int, Type: 8, LinkedId: ids.get(child), LinkOrder: index });
        });
      }
      if (fields.some((f) => ['CollectionType', 'Locations', 'Options'].includes(f))) {
        db.prepare(
          "INSERT INTO ItemExtradataTypes(Name) VALUES('LibraryOptions') ON CONFLICT DO NOTHING",
        ).run();
        const type = statement(
          db,
          "SELECT ExtradataTypeId FROM ItemExtradataTypes WHERE Name='LibraryOptions'",
        ).get().ExtradataTypeId;
        const old = db
          .prepare('SELECT Value FROM ItemExtradata WHERE ItemId=? AND ExtradataTypeId=?')
          .get(int, type);
        let options;
        try {
          options = editEmbyLibraryOptions(old?.Value, value, fields);
        } catch (error) {
          report('conflict', 'item', id, 'Options', error.message);
        }
        if (options !== undefined && options !== old?.Value)
          db.prepare(
            'INSERT INTO ItemExtradata(ItemId,ExtradataTypeId,Value) VALUES(?,?,?) ON CONFLICT(ItemId,ExtradataTypeId) DO UPDATE SET Value=excluded.Value',
          ).run(int, type, options);
      }
    }
    for (const field of fields) {
      if (scalarFields.includes(field) || field === 'Container' || field === 'IndexNumberEnd')
        patch[field] = sqliteValue(field, value[field]);
      else if (dateFields.includes(field)) patch[field] = value[field] == null ? null : BigInt(value[field]);
      else if (['ParentId', 'SeriesId'].includes(field)) {
        if (value[field] && !ids.has(value[field])) {
          report('origin-only', 'item', id, field, value[field]);
          continue;
        }
        patch[field] = ids.get(value[field]) ?? null;
      } else if (isMarkerField(field)) {
        const target = catalog.rows?.get(key);
        writeMarker(db, 'emby', int, id, field, value[field], target,
          fields.includes('RunTimeTicks') ? value.RunTimeTicks : target?.RunTimeTicks, report);
      } else if (field === 'Album') {
        const parent = ids.get(value.ParentId);
        const album =
          parent &&
          statement(db, 'SELECT Id FROM MediaItems WHERE Id=? AND type=12 AND Name=?').get(parent, value.Album);
        patch.AlbumId = !value.Album ? null : (album?.Id ?? findOrCreateNamed(db, 12, value.Album));
        db.prepare('DELETE FROM ItemLinks2 WHERE ItemId=? AND Type=7').run(int);
        if (patch.AlbumId != null)
          insert(db, 'ItemLinks2', { ItemId: int, Type: 7, LinkedId: patch.AlbumId, LinkOrder: 0 });
      } else if (field === 'type') patch.type = itemTypes.indexOf(value.type);
      else relation(db, field, id, int, value[field], value, (x) => ids.get(x), report);
    }
    update(db, 'MediaItems', patch, { Id: int });
    if (['Name', 'OriginalTitle', 'SeriesName', 'Album', 'type'].some((f) => fields.includes(f)))
      refreshSearch(db, int);
  }
  const processed = new Set();
  const plays = new Map(changes.filter((c) => c.key.startsWith('play/')).map((c) => [c.key, c]));
  for (const { key, value } of plays.values()) {
    const [, id, user] = key.split('/'),
      int = ids.get(id),
      account = userIds.get(user);
    if (!int || !account) {
      report('origin-only', 'play', key, 'identity', 'missing mapped account or item');
      continue;
    }
    let keyId = statement(db, 'SELECT UserDataKeyId AS k FROM MediaItems WHERE Id=?').get(int).k;
    if (keyId == null) {
      keyId = getKey(db, id);
      update(db, 'MediaItems', { UserDataKeyId: keyId }, { Id: int });
    }
    const groupKey = keyId + '/' + account;
    if (processed.has(groupKey)) continue;
    processed.add(groupKey);
    const group = catalog.shared.get(BigInt(keyId)) ?? [id];
    const keys = group.map((item) => 'play/' + item + '/' + user);
    if (!value) {
      if (keys.some((k) => source.rows.has(k))) {
        report('conflict', 'play', key, 'deletion', 'shared playback key: ' + group.join(','));
        continue;
      }
      db.prepare('DELETE FROM UserDatas WHERE UserDataKeyId=? AND userId=?').run(keyId, account);
      continue;
    }
    const fields = [...new Set(keys.flatMap((k) => plays.get(k)?.fields ?? []))].filter((f) => {
      if (
        keys.every(
          (k) =>
            source.rows.has(k) && same(source.rows.get(k)[f], value[f]) && !source.ambiguous?.get(k)?.has(f),
        )
      )
        return true;
      report('conflict', 'play', key, f, 'ambiguous playback values for ' + group.join(','));
      return false;
    });
    if (!fields.length) continue;
    const cols = {};
    for (const f of fields) if (stateFields.includes(f)) cols[f] = sqliteValue(f, value[f]);
    if (fields.includes('LastPlayedDate'))
      cols.LastPlayedDateInt = value.LastPlayedDate == null ? null : BigInt(value.LastPlayedDate);
    const now = Math.floor(Date.now() / 1000);
    if (db.prepare('SELECT 1 FROM UserDatas WHERE UserDataKeyId=? AND userId=?').get(keyId, account)) {
      if (fields.includes('Rating') || fields.includes('IsFavorite')) cols.RatingLastModified = now;
      if (fields.some((f) => !['Rating', 'IsFavorite'].includes(f))) cols.PlaystateLastModified = now;
      update(db, 'UserDatas', cols, { UserDataKeyId: keyId, userId: account });
    } else
      insert(db, 'UserDatas', {
        UserDataKeyId: keyId,
        userId: account,
        played: 0,
        playCount: 0,
        isFavorite: 0,
        HideFromResume: 0,
        playbackPositionTicks: 0,
        RatingLastModified: now,
        PlaystateLastModified: now,
        ...Object.fromEntries(Object.entries(cols).map(([k, v]) => [k[0].toLowerCase() + k.slice(1), v])),
      });
  }
  for (const { key, value } of changes) {
    if (value) continue;
    const [kind, id] = key.split('/');
    if (kind === 'item' && ids.has(id)) removeMedia(db, ids.get(id));
    if (kind === 'user' && userIds.has(id)) {
      const int = userIds.get(id);
      remove(db, 'UserDatas', 'userId', int);
      remove(db, 'UserItemShares', 'UserId', int);
      db.prepare('DELETE FROM accounts.UserSettings WHERE UserId=?').run(int);
      db.prepare('DELETE FROM accounts.LocalUsersv2 WHERE Id=?').run(int);
    }
  }
  if (items.some((c) => c.fields.includes('ParentId'))) {
    const queue = items
        .filter((c) => c.fields.includes('ParentId'))
        .map((c) => ids.get(c.key.slice(5)))
        .filter(Boolean),
      done = new Set();
    for (let i = 0; i < queue.length; i++) {
      const child = queue[i];
      if (done.has(String(child))) continue;
      done.add(String(child));
      remove(db, 'AncestorIds2', 'ItemId', child);
      const seen = new Set([String(child)]);
      let parent = statement(db, 'SELECT ParentId FROM MediaItems WHERE Id=?').get(child)?.ParentId,
        distance = 1;
      if (parent) insert(db, 'AncestorIds2', { ItemId: child, AncestorId: child, Distance: 0 });
      while (parent) {
        if (seen.has(String(parent))) throw new Error('Cycle in Emby ancestry');
        seen.add(String(parent));
        insert(db, 'AncestorIds2', { ItemId: child, AncestorId: parent, Distance: distance++ });
        parent = statement(db, 'SELECT ParentId FROM MediaItems WHERE Id=?').get(parent)?.ParentId;
      }
      for (const row of statement(db, 'SELECT Id FROM MediaItems WHERE ParentId=?').all(child))
        queue.push(row.Id);
    }
  }
}
