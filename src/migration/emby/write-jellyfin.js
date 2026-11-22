import { randomBytes, randomUUID } from 'node:crypto';
import { createPasswordHash } from '../../core/password.js';
import {
  AUTHENTICATION_PROVIDER,
  PASSWORD_RESET_PROVIDER,
  permissionNames,
  upperInvariant,
} from '../../users/native.js';
import { cleanValue } from '../../library/records.js';
import { itemTopParentId } from '../../library/item-save-tuple.js';
import { tableDefinition, quoteIdentifier as q } from '../../database/model.js';
import {
  itemTypes,
  folders,
  scalarFields,
  dateFields,
  stateFields,
  fromSeconds,
  timeToSeconds,
  fromImageTicks,
  images,
  locks,
  sqliteValue,
  editObjectFields,
} from './format.js';
import { valueTypes } from './catalog.js';
import { isMarkerField, writeMarker } from './chapter-markers.js';

export function insert(db, table, row, { schema, ignore = false } = {}) {
  const keys = Object.keys(row);
  const name = (schema ? q(schema) + '.' : '') + q(table);
  const statement = db.prepare(
    `INSERT ${ignore ? 'OR IGNORE ' : ''}INTO ${name} (${keys.map(q)}) VALUES (${keys.map(() => '?')})`,
  );
  statement.setReadBigInts(true);
  return statement.run(...Object.values(row));
}
export function update(db, table, row, where, { schema } = {}) {
  if (!Object.keys(row).length) return;
  const name = (schema ? q(schema) + '.' : '') + q(table);
  db.prepare(
    `UPDATE ${name} SET ${Object.keys(row).map((k) => q(k) + '=?')} WHERE ${Object.keys(where)
      .map((k) => q(k) + '=?')
      .join(' AND ')}`,
  ).run(...Object.values(row), ...Object.values(where));
}
const makeId = () => randomUUID().toUpperCase();
function defaults(table) {
  return Object.fromEntries(
    tableDefinition(table)
      .columns.filter((c) => !c.nullable && !c.generated && c.default === undefined)
      .map((c) => [c.name, c.type === 'INTEGER' ? 0 : c.type === 'REAL' ? 0 : '']),
  );
}
function remove(db, table, id, col = 'ItemId') {
  db.prepare(`DELETE FROM ${q(table)} WHERE ${q(col)}=?`).run(id);
}
function knownParent(db, id) {
  return id != null && db.prepare('SELECT 1 FROM BaseItems WHERE Id=?').get(id) ? id : null;
}
function changeValues(db, id, field, values) {
  const type = valueTypes[field];
  db.prepare(
    'DELETE FROM ItemValuesMap WHERE ItemId=? AND ItemValueId IN (SELECT ItemValueId FROM ItemValues WHERE Type=?)',
  ).run(id, type);
  for (const value of new Set(values)) {
    let row = db
      .prepare('SELECT ItemValueId FROM ItemValues WHERE Type=? AND Value=? LIMIT 1')
      .get(type, value);
    if (!row) {
      row = { ItemValueId: makeId() };
      insert(db, 'ItemValues', { ...row, Type: type, Value: value, CleanValue: cleanValue(value) ?? '' });
    }
    insert(db, 'ItemValuesMap', { ItemId: id, ...row });
  }
  update(db, 'BaseItems', { [field]: values.length ? values.join('|') : null }, { Id: id });
}
function changeRelations(db, id, name, values, report) {
  switch (name) {
    case 'Providers': {
      const next = new Map(values);
      const existing = db.prepare('SELECT ProviderId,ProviderValue FROM BaseItemProviders WHERE ItemId=?').all(id);
      const removeProvider = db.prepare('DELETE FROM BaseItemProviders WHERE ItemId=? AND ProviderId=?');
      for (const { ProviderId, ProviderValue } of existing) {
        if (!next.has(ProviderId)) removeProvider.run(id, ProviderId);
        else if (next.get(ProviderId) !== ProviderValue)
          update(db, 'BaseItemProviders', { ProviderValue: next.get(ProviderId) }, { ItemId: id, ProviderId });
        next.delete(ProviderId);
      }
      for (const [ProviderId, ProviderValue] of next)
        insert(db, 'BaseItemProviders', { ItemId: id, ProviderId, ProviderValue });
      break;
    }
    case 'LockedFields':
      db.prepare('DELETE FROM BaseItemMetadataFields WHERE ItemId=? AND Id>=0 AND Id<?').run(id, locks.length);
      for (const value of new Set(values))
        if (locks.includes(value))
          insert(db, 'BaseItemMetadataFields', { ItemId: id, Id: locks.indexOf(value) });
      break;
    case 'Images': {
      const old = db.prepare('SELECT * FROM BaseItemImageInfos WHERE ItemId=? ORDER BY rowid').all(id);
      remove(db, 'BaseItemImageInfos', id);
      for (const image of values) {
        const type = images.indexOf(image.ImageType);
        if (type < 0) {
          report('origin-only', 'item', id, 'Images', String(image.ImageType));
          continue;
        }
        const index = old.findIndex((r) => r.Path === image.Path && Number(r.ImageType) === type);
        const original = index < 0 ? {} : old.splice(index, 1)[0];
        insert(db, 'BaseItemImageInfos', {
          ...original,
          Id: original.Id ?? makeId(),
          ItemId: id,
          Path: image.Path,
          ImageType: type,
          DateModified: fromImageTicks(image.DateModified),
          Width: image.Width,
          Height: image.Height,
        });
      }
      break;
    }
    case 'Members':
      if (db.prepare('SELECT 1 FROM LinkedChildren WHERE ParentId=? AND ChildType<>0 LIMIT 1').get(id)) {
        report('conflict', 'item', id, 'Members', 'target folder also has non-manual links');
        break;
      }
      remove(db, 'LinkedChildren', id, 'ParentId');
      values.forEach((child, i) => {
        if (knownParent(db, child))
          insert(db, 'LinkedChildren', { ParentId: id, ChildId: child, SortOrder: i, ChildType: 0 });
        else report('origin-only', 'item', id, 'Members', String(child));
      });
      break;
    case 'People':
      remove(db, 'PeopleBaseItemMap', id);
      values.forEach((p, i) => {
        const exact = p.Id && db.prepare('SELECT Id,Name,PersonType FROM Peoples WHERE Id=?').get(p.Id);
        const existing =
          (exact?.Name === p.Name && exact.PersonType === p.Type ? exact : null) ??
          db.prepare('SELECT Id FROM Peoples WHERE Name=? AND PersonType IS ? LIMIT 1').get(p.Name, p.Type);
        const personId = existing?.Id ?? (!exact && p.Id ? p.Id : makeId());
        if (!existing) insert(db, 'Peoples', { Id: personId, Name: p.Name, PersonType: p.Type });
        if (
          db
            .prepare('SELECT 1 FROM PeopleBaseItemMap WHERE ItemId=? AND PeopleId=? AND Role=?')
            .get(id, personId, p.Role ?? '')
        ) {
          report('origin-only', 'item', id, 'People', 'duplicate credit ' + p.Name);
          return;
        }
        insert(db, 'PeopleBaseItemMap', {
          ItemId: id,
          PeopleId: personId,
          Role: p.Role ?? '',
          ListOrder: i,
          SortOrder: i,
        });
      });
      break;
    case 'Chapters':
    case 'Streams': {
      const table = name === 'Streams' ? 'MediaStreamInfos' : 'Chapters',
        key = name === 'Streams' ? 'StreamIndex' : 'ChapterIndex';
      const existing = db.prepare(`SELECT * FROM ${table} WHERE ItemId=?`);
      existing.setReadBigInts(true);
      const old = new Map(existing.all(id).map((r) => [Number(r[key]), r]));
      remove(db, table, id);
      for (const r of values) {
        const row = {
          ...(old.get(r[key]) ?? {}),
          ItemId: id,
          ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, sqliteValue(k, v)])),
        };
        if (name === 'Streams')
          for (const k of ['IsDefault', 'IsExternal', 'IsForced', 'IsOriginal']) row[k] ??= 0;
        else {
          const original = old.get(r[key])?.ImageDateModified ?? null;
          row.ImageDateModified = timeToSeconds(original) === r.ImageDateModified ? original : fromSeconds(r.ImageDateModified);
        }
        insert(db, table, row);
      }
      break;
    }
    default:
      if (Object.hasOwn(valueTypes, name)) changeValues(db, id, name, values);
  }
}
function refreshHierarchy(db, changes, previousRows, sourceRows, report) {
  const [seriesType, seasonType, episodeType] = itemTypes.slice(6, 9);
  const get = db.prepare('SELECT Id,Type,Name,ParentId,SeriesId,SeasonId,ParentIndexNumber FROM BaseItems WHERE Id=?');
  const children = db.prepare('SELECT Id FROM BaseItems WHERE ParentId=?');
  const seasons = db.prepare('SELECT Id,Name,SeriesId FROM BaseItems WHERE ParentId=? AND Type=? AND IndexNumber=? LIMIT 2');
  const directEpisodes = db.prepare('SELECT Id FROM BaseItems WHERE ParentId=? AND Type=?');
  const walk = (item) => {
    const seen = new Set([item.Id]);
    const parents = [];
    while (item.ParentId) {
      if (seen.has(item.ParentId)) throw new Error('Jellyfin parent cycle at ' + item.Id);
      item = get.get(item.ParentId);
      if (!item) break;
      seen.add(item.Id);
      parents.push(item);
    }
    return parents;
  };
  const pending = new Set(), physical = new Set(), seasonParents = new Set();
  for (const { key, value, fields } of changes) {
    if (!key.startsWith('item/')) continue;
    const id = key.slice(5);
    if (!value) for (const child of children.all(id)) physical.add(child.Id);
    if (fields.includes('ParentId') || fields.includes('type')) physical.add(id);
    if (value?.type === episodeType && fields.some(field => ['SeriesId', 'ParentIndexNumber'].includes(field)))
      pending.add(id);
    const previous = previousRows.get(key);
    if (!value || fields.some(field => ['IndexNumber', 'ParentId', 'type'].includes(field))) {
      if (previous?.type === seasonType && previous.ParentId) seasonParents.add(previous.ParentId);
      const parentId = value?.type === seasonType && get.get(id)?.ParentId;
      if (parentId) seasonParents.add(parentId);
    }
  }
  for (const id of seasonParents)
    for (const episode of directEpisodes.all(id, episodeType)) pending.add(episode.Id);
  for (const id of physical) {
    const item = get.get(id);
    if (!item) continue;
    const parents = walk(item);
    remove(db, 'AncestorIds', id);
    for (const parent of parents) insert(db, 'AncestorIds', { ItemId: id, ParentItemId: parent.Id });
    update(db, 'BaseItems', { TopParentId: itemTopParentId(item, parents) }, { Id: id });
    if (item.Type === episodeType) pending.add(id);
    for (const child of children.all(id)) physical.add(child.Id);
  }
  // Earlier exchanges can have the correct mapped parents but lack SeasonId.
  const missing = db.prepare('SELECT Id,ParentId,SeriesId,ParentIndexNumber FROM BaseItems WHERE Type=? AND SeasonId IS NULL AND ParentId IS NOT NULL');
  for (const item of missing.iterate(episodeType)) {
    const origin = sourceRows.get('item/' + item.Id);
    if (origin?.type === episodeType && origin.ParentId === item.ParentId && origin.SeriesId === item.SeriesId &&
        origin.ParentIndexNumber === item.ParentIndexNumber) pending.add(item.Id);
  }
  for (const id of pending) {
    const item = get.get(id);
    if (item?.Type !== episodeType) continue;
    const parents = walk(item);
    const tvParent = parents.find(parent => parent.Type === seriesType || parent.Type === seasonType);
    let season = tvParent?.Type === seasonType ? tvParent : null;
    const series = parents.find(parent => parent.Type === seriesType);
    let reason = 'no confirmed season parent';
    if (!season && tvParent?.Type === seriesType && item.ParentIndexNumber != null) {
      const candidates = seasons.all(tvParent.Id, seasonType, item.ParentIndexNumber);
      if (candidates.length === 1) [season] = candidates;
      if (candidates.length > 1) reason = 'multiple seasons under the parent series have the same season number';
    }
    const linkedSeries = get.get(season?.SeriesId ?? null);
    const seriesId = series?.Id ?? (linkedSeries?.Type === seriesType ? linkedSeries.Id : null);
    if (season && seriesId && [item.SeriesId, season.SeriesId].some(id => id && id !== seriesId)) {
      season = null;
      reason = 'season parent and recorded series disagree';
    }
    if (!season) report('requires-action', 'item', id, 'SeasonId', reason);
    update(db, 'BaseItems', {
      SeasonId: season?.Id ?? null,
      SeasonName: season?.Name ?? null,
      ...(season && seriesId && !item.SeriesId ? { SeriesId: seriesId } : {}),
    }, { Id: id });
  }
}
export async function writeJellyfin(db, changes, catalog, source, report, { adminUser, adminPassword, creditsEnd, skipperTarget } = {}) {
  const adminHash = adminPassword ? await createPasswordHash(adminPassword) : null;
  const inaccessible = await createPasswordHash(randomBytes(48).toString('base64url'));
  const items = changes.filter((c) => c.key.startsWith('item/') && c.value);
  for (const { key, value } of items) {
    const [, id] = key.split('/');
    if (!db.prepare('SELECT 1 FROM BaseItems WHERE Id=?').get(id)) {
      const type = itemTypes.indexOf(value.type);
      const mediaType = [5, 8, 10, 15, 18].includes(type)
        ? 'Video'
        : type === 11
          ? 'Audio'
          : type === 25
            ? 'Photo'
            : type === 20
              ? 'Book'
              : null;
      insert(db, 'BaseItems', {
        ...defaults('BaseItems'),
        Id: id,
        Type: value.type,
        IsFolder: folders.has(type) ? 1 : 0,
        MediaType: mediaType,
      });
    }
  }
  for (const { key, value, fields } of changes) {
    const [kind, id] = key.split('/');
    if (!value || kind === 'play') continue;
    if (kind === 'user') {
      if (!catalog.users.has(id)) {
        const account = source.users.get(id);
        const original = account ? JSON.parse(account.data) : {};
        const admin = adminHash && value.Username === adminUser;
        const internal = db.prepare('SELECT COALESCE(MAX(InternalId),0)+1 AS next FROM Users').get().next;
        insert(db, 'Users', {
          ...defaults('Users'),
          Id: id,
          InternalId: internal,
          Username: value.Username,
          NormalizedUsername: upperInvariant(value.Username),
          AuthenticationProviderId: AUTHENTICATION_PROVIDER,
          PasswordResetProviderId: PASSWORD_RESET_PROVIDER,
          Password: admin ? adminHash : inaccessible,
          RememberAudioSelections: 1,
          RememberSubtitleSelections: 1,
          EnableUserPreferenceAccess: 1,
        });
        for (const [i, name] of permissionNames.entries()) {
          const permission = admin
            ? name === 'IsAdministrator' || name === 'EnableMediaPlayback' || name === 'EnableAllFolders'
            : name === 'IsDisabled' ||
              (original.Policy?.[name] === true && !['IsAdministrator', 'EnableAllFolders'].includes(name));
          insert(db, 'Permissions', { UserId: id, Kind: i, Value: permission ? 1 : 0, RowVersion: 0 });
        }
        if (!admin)
          report(
            'requires-action',
            'user',
            id,
            'login',
            'set a target password and review library access before enabling',
          );
      } else if (fields.includes('Username'))
        update(
          db,
          'Users',
          { Username: value.Username, NormalizedUsername: upperInvariant(value.Username) },
          { Id: id },
        );
      continue;
    }
    const patch = {};
    const keys = {
      Container: 'Container',
      IndexNumberEnd: 'IndexNumberEnd',
      PhysicalFolders: 'PhysicalFolderIds',
      Locations: 'PhysicalLocationsList',
      CollectionType: 'CollectionType',
    };
    const edits = Object.fromEntries(
      fields.filter((f) => Object.hasOwn(keys, f)).map((f) => [keys[f], value[f]]),
    );
    if (Object.keys(edits).length) {
      const current = db.prepare('SELECT Data FROM BaseItems WHERE Id=?').get(id)?.Data;
      if (current || Object.values(edits).some((v) => v != null)) {
        try {
          patch.Data = editObjectFields(current, edits);
        } catch (e) {
          report('conflict', 'item', id, 'Data', e.message);
        }
      }
    }
    for (const field of fields) {
      if (scalarFields.includes(field) || field === 'Album') patch[field] = sqliteValue(field, value[field]);
      else if (dateFields.includes(field)) patch[field] = fromSeconds(value[field]);
      else if (['ParentId', 'SeriesId'].includes(field)) patch[field] = knownParent(db, value[field]);
      else if (field === 'type') {
        patch.Type = value.type;
        patch.IsFolder = folders.has(itemTypes.indexOf(value.type)) ? 1 : 0;
      } else if (isMarkerField(field)) {
        const target = catalog.rows?.get(key);
        writeMarker(db, 'jellyfin', id, id, field, value[field], target,
          fields.includes('RunTimeTicks') ? value.RunTimeTicks : target?.RunTimeTicks, report, creditsEnd, skipperTarget);
      } else changeRelations(db, id, field, value[field], report);
    }
    if (Object.hasOwn(patch, 'Name')) patch.CleanName = cleanValue(patch.Name);
    update(db, 'BaseItems', patch, { Id: id });
  }
  for (const { key, value, fields } of changes.filter((c) => c.key.startsWith('play/'))) {
    const [, id, user] = key.split('/');
    if (!value) {
      db.prepare('DELETE FROM UserData WHERE ItemId=? AND UserId=?').run(id, user);
      continue;
    }
    if (!knownParent(db, id) || !db.prepare('SELECT 1 FROM Users WHERE Id=?').get(user)) {
      report('origin-only', 'play', key, 'identity', 'missing item or user');
      continue;
    }
    const data = Object.fromEntries(
      fields.filter((f) => stateFields.includes(f)).map((f) => [f, sqliteValue(f, value[f])]),
    );
    if (fields.includes('LastPlayedDate')) data.LastPlayedDate = fromSeconds(value.LastPlayedDate);
    if (catalog.states.has(key)) {
      const original = catalog.states.get(key);
      for (const name of Object.keys(data)) {
        if (original.some((row) => row[name] !== original[0][name])) {
          report('conflict', 'play', key, name, 'target has differing native custom keys');
          delete data[name];
        }
      }
      update(db, 'UserData', data, { ItemId: id, UserId: user });
    } else
      insert(db, 'UserData', {
        ...defaults('UserData'),
        ItemId: id,
        UserId: user,
        CustomDataKey: id.replaceAll('-', '').toLowerCase(),
        ...data,
      });
  }
  for (const { key, value } of changes) {
    if (value) continue;
    const [kind, id] = key.split('/');
    if (kind === 'item') remove(db, 'BaseItems', id, 'Id');
    if (kind === 'user') remove(db, 'Users', id, 'Id');
  }
  refreshHierarchy(db, changes, catalog.rows, source.rows, report);
}
