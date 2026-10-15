import { randomUUID } from 'node:crypto';
import { insertNativeImageBatch, orderNativeItemBatch } from '../database/native-relation-order.js';
import { assertMetadataBaseline } from './metadata-baseline.js';
import { tableDefinition } from '../database/model.js';
import { cleanValue, dateTicks, guid, idKey, VIDEO_TYPES, EMPTY_ID } from '../library/records.js';
import { metadataFields } from '../library/metadata-context.js';
import { nativeDate, userDataKeys } from '../sessions/user-data.js';
import { lowerInvariant } from '../core/identity.js';
import { clrTrim } from './whitespace.js';
import { imageTypes } from './image-paths.js';
import { persistItemProviderIds, persistItemRelations } from '../library/item-relations.js';
import { itemListColumn } from '../library/item-list-columns.js';
import { prepareItemSaveTuple, itemTopParentId } from '../library/item-save-tuple.js';
import { persistVideoVersionRelations } from '../library/video-version-relations.js';
import { isResolverNativeItemType, nativeItemDescriptor, isNativeItemEntity } from '../library/native-item-entity.js';
import { serializeNativeItemData } from '../library/native-item-data.js';
import { sortName } from '../library/dto.js';
import { readItemTrailerRows } from '../library/trailer-order.js';
import { findPostgresPeople, reattachPostgresUserDataRows } from '../database/postgres-persistence-query.js';

const nullMinimumDates = new Set(['DateCreated', 'DateModified', 'DateLastRefreshed', 'DateLastSaved', 'DateLastMediaAdded']);
const extraTypes = ['Unknown', 'Clip', 'Trailer', 'BehindTheScenes', 'DeletedScene', 'Interview', 'Scene', 'Sample',
  'ThemeSong', 'ThemeVideo', 'Featurette', 'Short'];
const programAudioTypes = ['Mono', 'Stereo', 'Dolby', 'DolbyDigital', 'Thx', 'Atmos'];
const trailerTypes = [null, 'ComingSoonToTheaters', 'ComingSoonToDvd', 'ComingSoonToStreaming', 'Archive', 'LocalTrailer'];
const userDataPlaceholderId = '00000000-0000-0000-0000-000000000001';
const ensureSerializedWrites = (store, operation, options) => typeof store.ensureSerializedWrites === 'function'
  ? store.ensureSerializedWrites(operation, options)
  : store.serializeWrites(operation, options);

export async function reattachUserDataInDatabase(db, item, { signal } = {}) {
  signal?.throwIfAborted();
  const keys = new Set(await userDataKeys(db, item));
  signal?.throwIfAborted();
  return reattachPostgresUserDataRows(db, item.Id, [...keys], {
    placeholderId: userDataPlaceholderId,
    signal,
  });
}

export async function reattachUserData(store, item, { signal } = {}) {
  return ensureSerializedWrites(store, async () => {
    const attached = await store.transaction(
      db => reattachUserDataInDatabase(db, item, { signal }),
      { signal }
    );
    // Match BaseItem.UserData rehydration, but only publish the cache after the
    // transaction commits successfully and before another writer can advance it.
    item.UserData = attached;
    return attached;
  }, { signal });
}

async function savePeople(db, itemId, people) {
  if (people == null) return;
  const old = await db.rows('PeopleBaseItemMap', { where: { ItemId: itemId } });
  const persons = [];
  const credits = [];
  for (const source of people) {
    // PeopleRepository mutates the same objects consumed by SavePeopleMetadataAsync.
    source.Name = clrTrim(source.Name); source.Role = source.Role == null ? '' : clrTrim(source.Role);
    const person = { ...source, Type: source.Type ?? 'Unknown' };
    const key = `${lowerInvariant(person.Name)}\0${person.Type}\0${lowerInvariant(person.Role)}`;
    if (credits.some(entry => entry.key === key)) continue;
    credits.push({ person, key });
  }
  persons.push(...await findPostgresPeople(db, credits.map(entry => entry.person)));
  const retained = new Set();
  for (const [index, { person }] of credits.entries()) {
    let row = persons.find(row => lowerInvariant(row.Name) === lowerInvariant(person.Name) && row.PersonType === person.Type);
    if (!row) { row = await db.insert('Peoples', { Id: randomUUID().toUpperCase(), Name: person.Name, PersonType: person.Type }); persons.push(row); }
    const existing = old.find(entry => entry.PeopleId === row.Id && lowerInvariant(entry.Role) === lowerInvariant(person.Role));
    if (existing) {
      retained.add(existing);
      if (existing.ListOrder !== index || existing.SortOrder !== (person.SortOrder ?? null)) await db.update('PeopleBaseItemMap',
        { ItemId: itemId, PeopleId: row.Id, Role: existing.Role }, { ListOrder: index, SortOrder: person.SortOrder ?? null });
    } else await db.insert('PeopleBaseItemMap', { ItemId: itemId, PeopleId: row.Id, Role: person.Role, ListOrder: index, SortOrder: person.SortOrder ?? null });
  }
  const dropped = old.filter(entry => !retained.has(entry));
  for (const row of dropped) await db.delete('PeopleBaseItemMap', { ItemId: itemId, PeopleId: row.PeopleId, Role: row.Role });
  for (const id of new Set(dropped.map(entry => entry.PeopleId))) if (!(await db.rows('PeopleBaseItemMap', { where: { PeopleId: id } })).length) await db.delete('Peoples', { Id: id });
}

export async function persistMetadata(store, loaded, result, { signal, newVersions = [] } = {}) {
  return ensureSerializedWrites(store, async () => {
    let committed;
    const item = await store.transaction(async db => {
      await insertVideoVersions(db, loaded, newVersions, { signal });
      const saved = await persistMetadataInDatabase(db, loaded, result, { signal });
      const relationships = {};
      for (const table of Object.keys(loaded.relationships ?? {})) relationships[table] = await db.rows(table, { where: { ItemId: saved.Id } });
      committed = { snapshot: (await db.rows('BaseItems', { where: { Id: saved.Id } }))[0], relationships,
        newVersionSnapshots: newVersions.length ? await db.rows('BaseItems', { whereIn: { Id: newVersions.map(version => version.Id) } }) : [] };
      if (VIDEO_TYPES.has(saved.Type)) committed.versionLinks = await db.rows('LinkedChildren', { where: { ParentId: saved.Id },
        orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
      return saved;
    }, { signal });
    // Only advance the conflict baseline after COMMIT. The first-refresh save
    // and the final save share it without accepting intervening external edits.
    Object.assign(loaded, committed);
    return item;
  }, { signal });
}

// The caller commits credits before running the independent person lifecycle.
export async function persistPeopleCredits(store, loaded, people) {
  return ensureSerializedWrites(store, async () => {
    const rows = await store.transaction(async db => {
      await assertMetadataBaseline(db, loaded);
      await savePeople(db, loaded.item.Id, people);
      return db.rows('PeopleBaseItemMap', { where: { ItemId: loaded.item.Id } });
    });
    loaded.relationships.PeopleBaseItemMap = rows;
  });
}

export async function persistImageMetadata(store, loaded, images) {
  const id = loaded.item.Id;
  return ensureSerializedWrites(store, async () => {
    // Native SaveImagesAsync executes its delete before SaveChanges' insert
    // transaction. A later insert failure keeps that earlier deletion.
    await store.run(db => db.deleteWhere('BaseItemImageInfos', { ItemId: id }));
    const rows = await store.transaction(async db => {
      if (!(await db.rows('BaseItems', { where: { Id: id } })).length) return [];
      const imageRows = images.map(image => imageRow(id, image));
      await insertNativeImageBatch(db, imageRows);
      return db.rows('BaseItemImageInfos', { where: { ItemId: id } });
    });
    loaded.relationships ??= {};
    loaded.relationships.BaseItemImageInfos = rows;
  });
}

const imageRow = (id, image) => ({
  Id: image.Id ?? randomUUID().toUpperCase(), ItemId: id, ImageType: imageTypes.indexOf(image.Type), Path: image.Path,
  DateModified: image.DateModified ?? '0001-01-01 00:00:00', Width: image.Width ?? 0, Height: image.Height ?? 0, Blurhash: image.Blurhash ?? null,
});

export async function persistMetadataInDatabase(db, loaded, result, { signal, saveVideoRelations = true } = {}) {
    signal?.throwIfAborted();
    const item = result.Item, id = item.Id;
    if (!isNativeItemEntity(item)) throw new TypeError('Metadata persistence requires a branded native entity.');
    const stored = await assertMetadataBaseline(db, loaded);
    const resolverEntity = isResolverNativeItemType(item.NativeType);
    if (!stored) {
      const ownedExtra = loaded.creationIntent === 'owned-extra' && item.ExtraType != null && ['Video', 'Trailer', 'Audio'].includes(item.Type);
      const videoVersion = loaded.creationIntent === 'video-version' && VIDEO_TYPES.has(item.Type);
      const resolvedItem = loaded.creationIntent === 'library-resolve' && resolverEntity;
      const nativeSave = loaded.creationIntent === 'library-save' && isNativeItemEntity(item);
      if (!ownedExtra && !videoVersion && !resolvedItem && !nativeSave) {
        throw Object.assign(new Error('A missing metadata item has no validated creation intent.'), { code: 'metadata-conflict', status: 409 });
      }
    }
    const tuple = await prepareItemSaveTuple(db, item, loaded);
    const changes = mapNativeItemRow(item, loaded);
    // Hydration starts with a cleared cache. Mapping uses the live getter,
    // including a cache warmed by an earlier save or provider read.
    changes.SortName = loaded.sortName(item);
    item.SortName = changes.SortName;
    changes.TopParentId = itemTopParentId(item, loaded.parents);
    if (stored) await db.update('BaseItems', { Id: id }, changes);
    else await db.insert('BaseItems', changes);
    await persistItemProviderIds(db, item);
    await db.deleteWhere('BaseItemMetadataFields', { ItemId: id });
    const metadataFieldRows = [];
    for (const field of new Set(item.LockedFields ?? [])) {
      const fieldId = typeof field === 'number' ? field : metadataFields.indexOf(field);
      if (fieldId < 0) throw new TypeError(`Unknown native metadata field: ${field}`);
      metadataFieldRows.push({ ItemId: id, Id: fieldId });
    }
    await db.insertBatch('BaseItemMetadataFields', metadataFieldRows);
    await persistItemRelations(db, item,
      { parents: loaded.parents ?? [], collectionFolders: loaded.collectionFolders ?? [], preparedRelations: tuple.relations });
    if (result.Images != null) {
      await db.deleteWhere('BaseItemImageInfos', { ItemId: id });
      const rows = result.Images.map(image => imageRow(id, image));
      await insertNativeImageBatch(db, rows);
    } else {
      // SaveItems maps the live entity's images, not a provider's image result.
      // Updated items rewrite owned image rows wholesale inside the transaction.
      await db.deleteWhere('BaseItemImageInfos', { ItemId: id });
      const rows = (item.ImageInfos ?? []).map(image => imageRow(id, {
        ...image, Blurhash: image.BlurHash == null ? null : Buffer.from(image.BlurHash, 'utf8')
      }));
      await insertNativeImageBatch(db, rows);
    }
    if (item.Type === 'Trailer') {
      const orderedTrailerRows = await readItemTrailerRows(db, id);
      const existingTrailerTypes = new Set(orderedTrailerRows.map(row => row.Id));
      const addedTrailerRows = [];
      for (const type of item.TrailerTypes ?? []) {
        const typeId = typeof type === 'number' ? type : trailerTypes.indexOf(type);
        if (typeId < 1) throw new TypeError(`Unknown native trailer type: ${type}`);
        if (!existingTrailerTypes.has(typeId)) {
          addedTrailerRows.push({ ItemId: id, Id: typeId });
          existingTrailerTypes.add(typeId);
        }
      }
      await db.insertBatch('BaseItemTrailerTypes', addedTrailerRows.sort((left, right) => left.Id - right.Id));
    }
    if (saveVideoRelations) {
      await persistFolderLinks(db, item, { logger: loaded.logger, linkedChildren: loaded.linkedChildren, reversePath: loaded.reversePath });
      await persistVideoVersionRelations(db, item, { reversePath: loaded.reversePath, logger: loaded.logger });
    }
    signal?.throwIfAborted();
    return item;
}

export async function insertVideoVersions(db, loaded, versions, { signal } = {}) {
  // Native SaveItems rejects cancellation before mapping or issuing insert SQL.
  // Resolution and independent wrong-type cleanup have already completed.
  signal?.throwIfAborted();
  for (const item of versions) {
    const context = await loaded.loadDraftContext(item);
    if (context.snapshot) throw Object.assign(new Error('A newly resolved video version already exists.'), { code: 'metadata-conflict', status: 409 });
    context.creationIntent = 'video-version';
    await persistMetadataInDatabase(db, context, { Item: item }, { signal });
  }
}

export async function saveNativeItems(store, contexts, { signal, creationIntent = 'library-save' } = {}) {
  signal?.throwIfAborted();
  const frames = [];
  const items = await store.transaction(async db => {
    // EF orders insert commands after mapping the complete batch. PostgreSQL
    // validates the same final graph while mapping retains native input order.
    await db.client.query('SET CONSTRAINTS ALL DEFERRED');
    const newIds = contexts.filter(loaded => !loaded.snapshot).map(loaded => loaded.item.Id);
    for (const loaded of contexts) {
      loaded.creationIntent = creationIntent;
      await persistMetadataInDatabase(db, loaded, { Item: loaded.item }, { signal, saveVideoRelations: false });
    }
    await orderNativeItemBatch(db, newIds);
    for (const loaded of contexts) {
      await persistFolderLinks(db, loaded.item, { logger: loaded.logger, linkedChildren: loaded.linkedChildren, reversePath: loaded.reversePath });
      await persistVideoVersionRelations(db, loaded.item, { reversePath: loaded.reversePath, logger: loaded.logger });
    }
    for (const loaded of contexts) frames.push((await db.rows('BaseItems', { where: { Id: loaded.item.Id } }))[0]);
    signal?.throwIfAborted();
    return contexts.map(loaded => loaded.item);
  }, { signal });
  // Do not publish a new live source frame for a failed or cancelled save.
  for (const [index, loaded] of contexts.entries()) loaded.snapshot = frames[index];
  return items;
}

export function mapNativeItemRow(item, { reversePath = value => value, configuration = {} } = {}) {
  const empty = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => !column.generated).map(column =>
    [column.name, column.nullable ? null : column.clrType === 'bool' ? false : column.type === 'TEXT' ? '' : column.clrType === 'long' ? 0n : 0]));
  const descriptor = nativeItemDescriptor(item.NativeType);
  const row = { ...empty, Id: item.Id, Type: item.NativeType, Path: reversePath(item.Path),
    ParentId: nonempty(item.ParentId), OwnerId: nonempty(item.OwnerId), ChannelId: item.ChannelId ?? EMPTY_ID,
    PrimaryVersionId: descriptor.family === 'video' ? item.PrimaryVersionId ?? null : null,
    MediaType: item.MediaType, UnratedType: item.UnratedType,
    IsFolder: descriptor.family === 'folder' && item.IsFolder, Width: item.Width ?? 0, Height: item.Height ?? 0,
    Data: serializeNativeItemData(item), CleanName: cleanValue(item.Name) };
  for (const key of ['Name', 'EndDate', 'CommunityRating', 'CustomRating', 'IndexNumber', 'IsLocked', 'OfficialRating',
    'Overview', 'ParentIndexNumber', 'PremiereDate', 'ProductionYear', 'SortName', 'ForcedSortName', 'RunTimeTicks',
    'PreferredMetadataLanguage', 'PreferredMetadataCountryCode', 'IsInMixedFolder', 'InheritedParentalRatingValue',
    'InheritedParentalRatingSubValue', 'CriticRating', 'PresentationUniqueKey', 'OriginalTitle', 'OriginalLanguage',
    'Album', 'LUFS', 'NormalizationGain', 'IsVirtualItem', 'ExternalSeriesId', 'Tagline', 'TotalBitrate', 'ExternalId', 'Size']) {
    row[key] = item[key] ?? (typeof empty[key] === 'boolean' ? false : null);
  }
  for (const key of ['DateCreated', 'DateModified', 'DateLastRefreshed', 'DateLastSaved',
    ...(descriptor.family === 'folder' ? ['DateLastMediaAdded'] : []), 'EndDate', 'PremiereDate']) {
    row[key] = item[key] == null || nullMinimumDates.has(key) && dateTicks(item[key]) === 0n ? null : nativeDate(item[key]);
  }
  for (const key of ['Genres', 'Studios', 'Tags', 'ProductionLocations', ...(descriptor.hasArtist ? ['Artists'] : []),
    ...(descriptor.hasAlbumArtist ? ['AlbumArtists'] : [])]) row[key] = itemListColumn(item, key);
  if (descriptor.hasSeries) for (const key of ['SeriesId', 'SeriesName', 'SeriesPresentationUniqueKey']) row[key] = item[key] ?? (key === 'SeriesId' ? EMPTY_ID : null);
  if (descriptor.type === 'Episode') { row.SeasonId = item.SeasonId ?? EMPTY_ID; row.SeasonName = item.SeasonName ?? null; }
  for (const [key, names] of [['Audio', programAudioTypes], ['ExtraType', extraTypes]]) {
    const value = item[key]; row[key] = value == null ? null : typeof value === 'number' ? value : names.indexOf(value);
    if (row[key] === -1) throw new TypeError(`Unknown native ${key}: ${value}`);
  }
  row.SortName = item.SortName ?? sortName(item, { configuration });
  return row;
}

export async function persistFolderLinks(db, item, { logger, linkedChildren, reversePath } = {}) {
  if (nativeItemDescriptor(item.NativeType).family !== 'folder' || item.LinkedChildrenLoaded === false) return;
  if (!linkedChildren || typeof linkedChildren.persist !== 'function') throw new TypeError('Folder persistence requires its relational linked-child owner.');
  await linkedChildren.persist(db, item, { reversePath, logger });
}

const nonempty = value => value && idKey(value) !== '00000000000000000000000000000000' ? value : null;
