import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { appendFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { quoteIdentifier, tableDefinition } from '../../src/database/model.js';
import { cleanValue, EMPTY_ID, idKey } from '../../src/library/records.js';
import { clearFolderChildIds, releaseCachedFolderChildren } from '../../src/library/folder-cache.js';
import { postgresFolderChildIds } from '../../src/library/postgres-folder-child-ids.js';
import { createRuntime } from '../../src/runtime.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

const typeNames = {
  Video: 'MediaBrowser.Controller.Entities.Video',
  AggregateFolder: 'MediaBrowser.Controller.Entities.AggregateFolder',
  Audio: 'MediaBrowser.Controller.Entities.Audio.Audio',
  AudioBook: 'MediaBrowser.Controller.Entities.AudioBook',
  Book: 'MediaBrowser.Controller.Entities.Book',
  CollectionFolder: 'MediaBrowser.Controller.Entities.CollectionFolder',
  Folder: 'MediaBrowser.Controller.Entities.Folder',
  Genre: 'MediaBrowser.Controller.Entities.Genre',
  LiveTvChannel: 'MediaBrowser.Controller.LiveTv.LiveTvChannel',
  LiveTvProgram: 'MediaBrowser.Controller.LiveTv.LiveTvProgram',
  BoxSet: 'MediaBrowser.Controller.Entities.Movies.BoxSet',
  Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
  Series: 'MediaBrowser.Controller.Entities.TV.Series',
  Season: 'MediaBrowser.Controller.Entities.TV.Season',
  Episode: 'MediaBrowser.Controller.Entities.TV.Episode',
  MusicAlbum: 'MediaBrowser.Controller.Entities.Audio.MusicAlbum',
  MusicArtist: 'MediaBrowser.Controller.Entities.Audio.MusicArtist',
  MusicGenre: 'MediaBrowser.Controller.Entities.Audio.MusicGenre',
  Studio: 'MediaBrowser.Controller.Entities.Studio',
  Person: 'MediaBrowser.Controller.Entities.Person',
  Playlist: 'MediaBrowser.Controller.Playlists.Playlist',
  PlaylistsFolder: 'Emby.Server.Implementations.Playlists.PlaylistsFolder',
  UserRootFolder: 'MediaBrowser.Controller.Entities.UserRootFolder',
  UserView: 'MediaBrowser.Controller.Entities.UserView',
  Year: 'MediaBrowser.Controller.Entities.Year',
};

const itemValueTypes = {
  Artist: 0,
  AlbumArtist: 1,
  Genre: 2,
  Studio: 3,
  Tags: 4,
};

const endpointNames = new Set(['items', 'legacy', 'detail']);
const authenticationKinds = new Set(['user', 'apiKey']);

function requiredKey(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function requiredId(value, label) {
  const normalized = idKey(value);
  if (!normalized) throw new TypeError(`${label} must be a non-empty id.`);
  return normalized;
}

function uniqueMap(entries, { kind, key, normalize = value => value }) {
  const result = new Map();
  for (const [index, entry] of entries.entries()) {
    const value = key(entry, index);
    const normalized = normalize(value);
    if (result.has(normalized)) throw new Error(`Duplicate ${kind}: ${value}.`);
    result.set(normalized, entry);
  }
  return result;
}

export function validateFixture(fixture) {
  if (!fixture || typeof fixture !== 'object') throw new TypeError('Fixture must be an object.');
  if (!Array.isArray(fixture.items) || fixture.items.length === 0) throw new TypeError('Fixture items must be a non-empty array.');
  if (!Array.isArray(fixture.cases)) throw new TypeError('Fixture cases must be an array.');
  for (const field of ['links', 'people', 'peopleLinks', 'itemValues', 'itemValueLinks', 'mediaStreams', 'images']) {
    if (fixture[field] !== undefined && !Array.isArray(fixture[field])) {
      throw new TypeError(`Fixture ${field} must be an array.`);
    }
  }
  requiredId(fixture.userId, 'userId');
  const items = fixture.items;
  const itemByKey = uniqueMap(items, {
    kind: 'item key',
    key: (item, index) => requiredKey(item.key, `items[${index}].key`),
  });
  const itemById = uniqueMap(items, {
    kind: 'item id',
    key: (item, index) => requiredId(item.id, `items[${index}].id`),
  });
  const rootId = requiredId(fixture.rootId, 'rootId');
  if (!itemById.has(rootId)) throw new Error(`Unknown rootId: ${fixture.rootId}.`);

  const requireItemId = (value, label) => {
    const normalized = requiredId(value, label);
    if (!itemById.has(normalized)) throw new Error(`Unknown ${label}: ${value}.`);
    return itemById.get(normalized);
  };
  const requireItemKey = (value, label) => {
    requiredKey(value, label);
    if (!itemByKey.has(value)) throw new Error(`Unknown ${label}: ${value}.`);
    return itemByKey.get(value);
  };

  for (const [index, item] of items.entries()) {
    if (!Object.hasOwn(typeNames, item.type)) throw new Error(`Unknown items[${index}].type: ${item.type}.`);
    if (item.genresText !== undefined && item.genresText !== null && typeof item.genresText !== 'string') {
      throw new TypeError(`items[${index}].genresText must be a string or null.`);
    }
    if (item.studiosText !== undefined && item.studiosText !== null && typeof item.studiosText !== 'string') {
      throw new TypeError(`items[${index}].studiosText must be a string or null.`);
    }
    if (item.tagsText !== undefined && item.tagsText !== null && typeof item.tagsText !== 'string') {
      throw new TypeError(`items[${index}].tagsText must be a string or null.`);
    }
    if (item.officialRating !== undefined && item.officialRating !== null && typeof item.officialRating !== 'string') {
      throw new TypeError(`items[${index}].officialRating must be a string or null.`);
    }
    if (item.customRating !== undefined && item.customRating !== null && typeof item.customRating !== 'string') {
      throw new TypeError(`items[${index}].customRating must be a string or null.`);
    }
    if (item.dateLastSaved !== undefined && item.dateLastSaved !== null && typeof item.dateLastSaved !== 'string') {
      throw new TypeError(`items[${index}].dateLastSaved must be a string or null.`);
    }
    for (const field of ['inheritedParentalRatingValue', 'inheritedParentalRatingSubValue']) {
      if (item[field] !== undefined && item[field] !== null && !Number.isInteger(item[field])) {
        throw new TypeError(`items[${index}].${field} must be an integer or null.`);
      }
    }
    for (const field of ['parentId', 'topParentId', 'ownerId', 'primaryVersionId']) {
      // Nullable<Guid>.HasValue is true for Guid.Empty, and AlbumIds can match
      // such a direct ParentId. It intentionally has no BaseItems principal.
      if (field === 'parentId' && idKey(item[field]) === idKey(EMPTY_ID)) continue;
      if (item[field] != null) requireItemId(item[field], `items[${index}].${field}`);
    }
    if (item.ancestorIds !== undefined) {
      if (!Array.isArray(item.ancestorIds)) throw new TypeError(`items[${index}].ancestorIds must be an array.`);
      for (const [ancestorIndex, ancestorId] of item.ancestorIds.entries()) {
        requireItemId(ancestorId, `items[${index}].ancestorIds[${ancestorIndex}]`);
      }
    }
  }
  for (const item of items) {
    const path = [];
    const visited = new Set();
    let current = item;
    while (current?.parentId != null) {
      const currentId = idKey(current.id);
      if (visited.has(currentId)) {
        throw new Error(`Parent cycle detected: ${[...path, current.key].join(' -> ')}.`);
      }
      visited.add(currentId);
      path.push(current.key);
      current = itemById.get(idKey(current.parentId));
    }
  }

  for (const [index, link] of (fixture.links ?? []).entries()) {
    requireItemId(link.parentId, `links[${index}].parentId`);
    requireItemId(link.childId, `links[${index}].childId`);
  }

  const people = fixture.people ?? [];
  if (!Array.isArray(people)) throw new TypeError('Fixture people must be an array.');
  const personByKey = uniqueMap(people, {
    kind: 'person key',
    key: (person, index) => requiredKey(person.key, `people[${index}].key`),
  });
  uniqueMap(people, {
    kind: 'person id',
    key: (person, index) => requiredId(person.id, `people[${index}].id`),
  });
  for (const [index, link] of (fixture.peopleLinks ?? []).entries()) {
    requireItemKey(link.itemKey, `peopleLinks[${index}].itemKey`);
    requiredKey(link.personKey, `peopleLinks[${index}].personKey`);
    if (!personByKey.has(link.personKey)) throw new Error(`Unknown peopleLinks[${index}].personKey: ${link.personKey}.`);
  }

  const itemValues = fixture.itemValues ?? [];
  const itemValueByKey = uniqueMap(itemValues, {
    kind: 'item-value key',
    key: (value, index) => requiredKey(value.key, `itemValues[${index}].key`),
  });
  uniqueMap(itemValues, {
    kind: 'item-value id',
    key: (value, index) => requiredId(value.id, `itemValues[${index}].id`),
  });
  for (const [index, value] of itemValues.entries()) {
    const type = typeof value.type === 'string' ? itemValueTypes[value.type] : value.type;
    if (!Number.isInteger(type)) throw new Error(`Unknown itemValues[${index}].type: ${value.type}.`);
  }
  for (const [index, link] of (fixture.itemValueLinks ?? []).entries()) {
    requireItemKey(link.itemKey, `itemValueLinks[${index}].itemKey`);
    requiredKey(link.valueKey, `itemValueLinks[${index}].valueKey`);
    if (!itemValueByKey.has(link.valueKey)) throw new Error(`Unknown itemValueLinks[${index}].valueKey: ${link.valueKey}.`);
  }

  const validateStreamReference = (stream, label, implicitItem) => {
    if (!stream || typeof stream !== 'object') throw new TypeError(`${label} must be an object.`);
    const byId = stream.itemId == null ? null : requireItemId(stream.itemId, `${label}.itemId`);
    const byKey = stream.itemKey == null ? null : requireItemKey(stream.itemKey, `${label}.itemKey`);
    if (!implicitItem && !byId && !byKey) throw new Error(`${label} must reference an itemId or itemKey.`);
    const expected = implicitItem ?? byId ?? byKey;
    if ((byId && idKey(byId.id) !== idKey(expected.id)) || (byKey && idKey(byKey.id) !== idKey(expected.id))) {
      throw new Error(`${label} has conflicting item references.`);
    }
    const streamType = stream.streamType ?? stream.type;
    if (typeof streamType === 'string' && !['Audio', 'Video', 'Subtitle'].includes(streamType)) {
      throw new Error(`Unknown ${label} stream type: ${streamType}.`);
    }
    if (typeof streamType !== 'string' && !Number.isInteger(streamType)) {
      throw new TypeError(`${label} stream type must be Audio, Video, Subtitle, or an integer.`);
    }
  };
  for (const [index, stream] of (fixture.mediaStreams ?? []).entries()) {
    validateStreamReference(stream, `mediaStreams[${index}]`, null);
  }
  for (const [itemIndex, item] of items.entries()) {
    if (item.streams !== undefined && !Array.isArray(item.streams)) {
      throw new TypeError(`items[${itemIndex}].streams must be an array.`);
    }
    for (const [streamIndex, stream] of (item.streams ?? []).entries()) {
      validateStreamReference(stream, `items[${itemIndex}].streams[${streamIndex}]`, item);
    }
  }
  for (const [index, image] of (fixture.images ?? []).entries()) {
    requireItemKey(image.itemKey, `images[${index}].itemKey`);
    requiredId(image.id, `images[${index}].id`);
    if (!Number.isInteger(image.imageType)) throw new TypeError(`images[${index}].imageType must be an integer.`);
  }

  uniqueMap(fixture.cases, {
    kind: 'case name',
    key: (testCase, index) => requiredKey(testCase.name, `cases[${index}].name`),
  });
  for (const [index, testCase] of fixture.cases.entries()) {
    if (typeof testCase.query !== 'string') throw new TypeError(`cases[${index}].query must be a string.`);
    if (!Array.isArray(testCase.scope)) throw new TypeError(`cases[${index}].scope must be an array.`);
    for (const flag of ['omitScope', 'omitParentId', 'omitIds', 'omitSortBy', 'assertOrder', 'expectRuntimeError']) {
      if (testCase[flag] !== undefined && typeof testCase[flag] !== 'boolean') {
        throw new TypeError(`cases[${index}].${flag} must be a boolean.`);
      }
    }
    if (testCase.recursive !== undefined && testCase.recursive !== null && typeof testCase.recursive !== 'boolean') {
      throw new TypeError(`cases[${index}].recursive must be true, false, or null.`);
    }
    if (testCase.expectedStatus !== undefined
      && (!Number.isInteger(testCase.expectedStatus) || testCase.expectedStatus < 100 || testCase.expectedStatus > 599)) {
      throw new TypeError(`cases[${index}].expectedStatus must be an HTTP status integer.`);
    }
    if (testCase.sortBy !== undefined && typeof testCase.sortBy !== 'string') {
      throw new TypeError(`cases[${index}].sortBy must be a string.`);
    }
    if (testCase.expectedRuntimeError !== undefined
      && (typeof testCase.expectedRuntimeError !== 'string' || (testCase.expectedStatus ?? 200) < 400)) {
      throw new TypeError(`cases[${index}].expectedRuntimeError requires an error status and a string message.`);
    }
    if (testCase.detailExpectedStatus !== undefined
      && (!Number.isInteger(testCase.detailExpectedStatus) || testCase.detailExpectedStatus < 100 || testCase.detailExpectedStatus > 599)) {
      throw new TypeError(`cases[${index}].detailExpectedStatus must be an HTTP status integer.`);
    }
    if (testCase.parallelRequests !== undefined
      && (!Number.isInteger(testCase.parallelRequests) || testCase.parallelRequests < 2 || testCase.parallelRequests > 32)) {
      throw new TypeError(`cases[${index}].parallelRequests must be an integer from 2 through 32.`);
    }
    if (testCase.parallelQueries !== undefined
      && (!Array.isArray(testCase.parallelQueries) || testCase.parallelQueries.length < 2
        || testCase.parallelQueries.length > 32 || testCase.parallelQueries.some(query => typeof query !== 'string'))) {
      throw new TypeError(`cases[${index}].parallelQueries must be 2 to 32 query strings.`);
    }
    if (testCase.parallelQueries && testCase.parallelRequests) {
      throw new TypeError(`cases[${index}] cannot combine parallelQueries and parallelRequests.`);
    }
    for (const [scopeIndex, itemKey] of testCase.scope.entries()) {
      requireItemKey(itemKey, `cases[${index}].scope[${scopeIndex}]`);
    }
    if (testCase.parentKey != null) requireItemKey(testCase.parentKey, `cases[${index}].parentKey`);
    if (testCase.detailKey != null) requireItemKey(testCase.detailKey, `cases[${index}].detailKey`);
    if (testCase.policy != null) {
      if (typeof testCase.policy !== 'object' || Array.isArray(testCase.policy)) {
        throw new TypeError(`cases[${index}].policy must be an object.`);
      }
      for (const name of ['AllowedTags', 'BlockedTags']) {
        if (!Array.isArray(testCase.policy[name]) || testCase.policy[name].some(tag => typeof tag !== 'string')) {
          throw new TypeError(`cases[${index}].policy.${name} must be an array of strings.`);
        }
      }
    }
    if (testCase.configuration != null && (typeof testCase.configuration !== 'object' || Array.isArray(testCase.configuration))) {
      throw new TypeError(`cases[${index}].configuration must be an object.`);
    }
    if (testCase.omitScope && testCase.parentKey != null) {
      throw new Error(`cases[${index}] cannot combine omitScope with parentKey.`);
    }
    if (testCase.omitScope && (testCase.omitParentId || testCase.omitIds || Object.hasOwn(testCase, 'recursive'))) {
      throw new Error(`cases[${index}] cannot combine omitScope with explicit scope controls.`);
    }
    if (testCase.omitParentId && testCase.parentKey != null) {
      throw new Error(`cases[${index}] cannot combine omitParentId with parentKey.`);
    }
    const endpoints = testCase.endpoints ?? ['items', 'legacy'];
    if (!Array.isArray(endpoints) || endpoints.length === 0) throw new TypeError(`cases[${index}].endpoints must be a non-empty array.`);
    for (const endpoint of endpoints) {
      if (!endpointNames.has(endpoint)) throw new Error(`Unknown cases[${index}].endpoint: ${endpoint}.`);
      if (endpoint === 'detail' && !testCase.detailKey) {
        throw new Error(`cases[${index}].detailKey is required for the detail endpoint.`);
      }
    }
    if ((testCase.parallelRequests || testCase.parallelQueries)
      && (endpoints.length !== 1 || (testCase.expectedStatus ?? 200) >= 400)) {
      throw new TypeError(`cases[${index}] parallel requests require one successful endpoint.`);
    }
    const auth = testCase.auth ?? 'user';
    if (!authenticationKinds.has(auth)) throw new Error(`Unknown cases[${index}].auth: ${auth}.`);
  }
}

function emptyRow(table) {
  return Object.fromEntries(tableDefinition(table).columns
    .filter(column => !column.generated)
    .map(column => [column.name, column.nullable ? null
      : column.clrType === 'bool' ? false
        : column.type === 'TEXT' ? ''
          : column.clrType === 'uint' || column.clrType === 'long' ? 0n : 0]));
}

function baseItemRow(item, rootId, scenarioName) {
  const isFolder = item.isFolder ?? ['AggregateFolder', 'CollectionFolder', 'Folder', 'BoxSet', 'MusicAlbum', 'MusicArtist', 'Playlist', 'PlaylistsFolder', 'Series', 'UserRootFolder', 'UserView'].includes(item.type);
  const isMovie = item.type === 'Movie';
  const mediaType = Object.hasOwn(item, 'mediaType')
    ? item.mediaType
    : isMovie ? 'Video' : item.type === 'Audio' ? 'Audio' : 'Unknown';
  const familyId = item.primaryVersionId ?? item.id;
  const defaultData = !isMovie ? {} : {
    VideoType: 'VideoFile',
    IsHD: (item.width ?? 0) >= 1200,
    IsShortcut: false,
    Width: item.width ?? 0,
    Height: item.height ?? 0,
    RemoteTrailers: [],
  };
  return {
    ...emptyRow('BaseItems'),
    Id: item.id,
    Type: typeNames[item.type],
    Name: item.name,
    CleanName: Object.hasOwn(item, 'cleanName') ? item.cleanName : cleanValue(item.name),
    SortName: Object.hasOwn(item, 'sortName') ? item.sortName : cleanValue(item.name),
    ParentId: item.parentId ?? null,
    TopParentId: Object.hasOwn(item, 'topParentId') ? item.topParentId : rootId,
    PrimaryVersionId: item.primaryVersionId ?? null,
    OwnerId: item.ownerId ?? null,
    ExtraType: item.extraType ?? null,
    PresentationUniqueKey: item.presentationUniqueKey ?? `${scenarioName}-${idKey(familyId)}`,
    ProductionYear: item.productionYear ?? null,
    Overview: item.overview ?? null,
    Width: item.width ?? null,
    Height: item.height ?? null,
    Genres: item.genresText ?? null,
    Studios: item.studiosText ?? null,
    Tags: item.tagsText ?? null,
    OfficialRating: item.officialRating ?? null,
    CustomRating: item.customRating ?? null,
    InheritedParentalRatingValue: item.inheritedParentalRatingValue ?? null,
    InheritedParentalRatingSubValue: item.inheritedParentalRatingSubValue ?? null,
    IsFolder: isFolder,
    IsMovie: isMovie,
    IsSeries: item.type === 'Series',
    MediaType: mediaType,
    UnratedType: isMovie ? 'Movie'
      : ['MusicAlbum', 'MusicArtist'].includes(item.type) ? 'Music' : 'Other',
    Path: Object.hasOwn(item, 'path') ? item.path : isFolder || ['Person', 'MusicArtist'].includes(item.type)
      ? `Z:\\ItemFilterHttp\\${item.key}`
      : `Z:\\ItemFilterHttp\\${item.key}.${item.type === 'Audio' ? 'flac' : 'mkv'}`,
    DateCreated: '2026-09-27 12:00:00',
    DateModified: '2026-09-27 12:00:00',
    DateLastSaved: item.dateLastSaved ?? '2026-09-27 12:00:00',
    Data: item.dataText ?? JSON.stringify(item.data ?? defaultData),
  };
}

function seedOperations(fixture, scenarioName) {
  const itemById = new Map(fixture.items.map(item => [idKey(item.id), item]));
  const itemByKey = new Map(fixture.items.map(item => [item.key, item]));
  const itemValueByKey = new Map((fixture.itemValues ?? []).map(value => [value.key, value]));
  const personByKey = new Map((fixture.people ?? []).map(person => [person.key, person]));
  const operations = [];
  for (const item of fixture.items) operations.push(['BaseItems', baseItemRow(item, fixture.rootId, scenarioName)]);
  for (const item of fixture.items) {
    const ancestors = Array.isArray(item.ancestorIds) ? [...item.ancestorIds] : [];
    if (!Array.isArray(item.ancestorIds)) {
      let parentId = item.parentId;
      while (parentId) {
        ancestors.push(parentId);
        parentId = itemById.get(idKey(parentId))?.parentId;
      }
    }
    for (const parentItemId of new Map(ancestors.map(id => [idKey(id), id])).values()) {
      operations.push(['AncestorIds', { ItemId: item.id, ParentItemId: parentItemId }]);
    }
  }
  for (const link of fixture.links ?? []) operations.push(['LinkedChildren', {
    ParentId: link.parentId,
    SortOrder: link.sortOrder,
    ChildId: link.childId,
    ChildType: link.childType,
  }]);
  const fixtureStreams = [
    ...(fixture.mediaStreams ?? []),
    ...fixture.items.flatMap(item => (item.streams ?? []).map((stream, index) => ({ ...stream, itemId: item.id, index }))),
  ];
  for (const [index, stream] of fixtureStreams.entries()) {
    operations.push(['MediaStreamInfos', {
      ...emptyRow('MediaStreamInfos'),
      ItemId: stream.itemId ?? itemByKey.get(stream.itemKey)?.id,
      StreamIndex: stream.index ?? index,
      StreamType: typeof (stream.streamType ?? stream.type) === 'string'
        ? ['Audio', 'Video', 'Subtitle'].indexOf(stream.streamType ?? stream.type)
        : stream.streamType ?? stream.type,
      Language: stream.language ?? null,
    }]);
  }
  for (const person of fixture.people ?? []) {
    operations.push(['Peoples', {
      Id: person.id,
      Name: person.name,
      PersonType: person.personType ?? null,
    }]);
  }
  for (const [index, link] of (fixture.peopleLinks ?? []).entries()) {
    const item = itemByKey.get(link.itemKey);
    const person = personByKey.get(link.personKey);
    operations.push(['PeopleBaseItemMap', {
      ItemId: item.id,
      PeopleId: person.id,
      Role: link.role ?? '',
      ListOrder: link.listOrder ?? index,
      SortOrder: link.sortOrder ?? null,
    }]);
  }
  for (const value of fixture.itemValues ?? []) {
    const type = typeof value.type === 'string' ? itemValueTypes[value.type] : value.type;
    if (!Number.isInteger(type)) throw new Error(`Unknown item-value type: ${value.type}`);
    operations.push(['ItemValues', {
      ItemValueId: value.id,
      Type: type,
      Value: value.value,
      CleanValue: Object.hasOwn(value, 'cleanValue') ? value.cleanValue : cleanValue(value.value),
    }]);
  }
  for (const link of fixture.itemValueLinks ?? []) {
    const item = itemByKey.get(link.itemKey);
    const value = itemValueByKey.get(link.valueKey);
    operations.push(['ItemValuesMap', {
      ItemValueId: value.id,
      ItemId: item.id,
    }]);
  }
  for (const image of fixture.images ?? []) {
    const item = itemByKey.get(image.itemKey);
    operations.push(['BaseItemImageInfos', {
      ...emptyRow('BaseItemImageInfos'),
      Id: image.id,
      ItemId: item.id,
      ImageType: image.imageType,
      Path: image.path ?? `Z:\\ItemFilterHttp\\images\\${image.id}.jpg`,
      DateModified: image.dateModified ?? '2026-09-27 12:00:00',
      Width: image.width ?? 100,
      Height: image.height ?? 100,
      Blurhash: image.blurHash == null ? null : Buffer.from(image.blurHash),
    }]);
  }
  return operations;
}

async function seed(database, fixture, scenarioName) {
  const operations = seedOperations(fixture, scenarioName);
  await database.transaction(async transaction => {
    for (const [table, row] of operations) {
      for (const column of tableDefinition(table).columns) {
        if (column.clrType.replace('?', '') === 'Guid' && row[column.name] != null) {
          row[column.name] = row[column.name].toUpperCase();
        }
      }
      if (table === 'BaseItems' && row.Type === typeNames.AggregateFolder) {
        const existing = await transaction.rows('BaseItems', { whereIn: { Id: [row.Id, row.Id.toUpperCase()] } });
        assert.equal(existing.length, 1, 'The native seeded aggregate must reuse the actual runtime aggregate.');
        assert.equal(existing[0].Type, typeNames.AggregateFolder);
        continue;
      }
      if (table === 'BaseItems') {
        const existing = await transaction.rows('BaseItems', { where: { Id: row.Id } });
        if (existing.length) {
          assert.equal(existing.length, 1);
          assert.equal(existing[0].Type, row.Type);
          assert.equal(fixture.items.find(item => idKey(item.id) === idKey(row.Id))?.existingNative, true,
            `Only a declared existing native fixture identity may replace its controlled row: ${row.Type} ${row.Id}.`);
          await transaction.upsert(table, row);
          continue;
        }
      }
      if (table === 'AncestorIds') {
        await transaction.upsert(table, row);
        continue;
      }
      await transaction.insert(table, row);
    }
  });
}

async function prepareSeededRoots(runtime, database, programDataPath) {
  const host = runtime.libraryScanHost, manager = runtime.itemCreation, links = runtime.linkedChildren;
  assert.equal(host, runtime.library.rootHost);
  const previousRoots = [await host.getUserRootFolder(), await host.getAggregateFolder()];
  const virtualChildren = [...previousRoots[1].VirtualChildren];
  const previousItems = new Map([...previousRoots, ...virtualChildren].map(item => [idKey(item.Id), item]));
  const observations = { kind: 'seeded-catalogue-before-first-http', hostRebuilds: 0,
    roots: [], unregistered: [], releases: [], virtualChildren: [] };
  const describe = item => ({ Id: item.Id, NativeType: item.NativeType,
    Path: item.Path, Name: item.Name, ParentId: item.ParentId, IsRoot: item.IsRoot,
    Data: item.NativeData, repository: { ...item.NativeRepositoryColumns },
    physicalLocations: { present: item.PhysicalLocations !== undefined,
      value: item.PhysicalLocations == null ? item.PhysicalLocations : [...item.PhysicalLocations] },
    physicalLocationsList: { present: item.PhysicalLocationsList !== undefined,
      value: item.PhysicalLocationsList == null ? item.PhysicalLocationsList : [...item.PhysicalLocationsList] } });
  for (const root of previousRoots) {
    const ids = postgresFolderChildIds(root);
    observations.roots.push({ before: describe(root),
      childIdsBefore: { present: ids !== null, empty: ids ? await ids.empty() : null } });
    clearFolderChildIds(root);
    releaseCachedFolderChildren(root);
    assert.equal(postgresFolderChildIds(root), null);
  }
  // Native records this input with its business process stopped, then starts a
  // fresh manager. Startup has already read our empty catalogue; discard those
  // exact receivers once, after every injected row/path and before HTTP reads.
  await host.close();
  observations.hostRebuilds++;
  for (const [key, item] of previousItems) {
    const registered = manager.getCachedItemById(item.Id);
    manager.unregisterItem(item.Id);
    assert.equal(manager.getCachedItemById(item.Id), null);
    observations.unregistered.push({ Id: item.Id, registered: registered !== null,
      sameReceiver: registered === item, key });
  }
  await links.flushOwnedReleases();
  observations.releases.push('flushOwnedReleases');
  await links.flushReleases();
  observations.releases.push('flushReleases');
  const roots = [await host.getUserRootFolder(), await host.getAggregateFolder()];
  for (const [index, root] of roots.entries()) {
    const previous = previousRoots[index];
    assert.notEqual(root, previous);
    assert.equal(idKey(root.Id), idKey(previous.Id));
    assert.equal(root.NativeType, previous.NativeType);
    assert.equal(manager.getCachedItemById(root.Id), root);
    assert.equal(postgresFolderChildIds(root), null);
    const rows = await database.rows('BaseItems', { where: { Id: root.Id.toUpperCase() } });
    assert.ok(rows.length <= 1);
    if (root.Type === 'AggregateFolder') assert.equal(rows.length, 1);
    const repository = root.NativeRepositoryColumns;
    if (rows.length) assert.deepEqual(repository, rows[0]);
    assert.equal(root.NativeData, repository.Data);
    const canonicalPath = root.Type === 'UserRootFolder'
      ? path.join(programDataPath, 'root', 'default') : path.join(programDataPath, 'root');
    assert.equal(root.Path, canonicalPath);
    Object.assign(observations.roots[index], { after: describe(root),
      freshReceiver: root !== previous, repositoryRowPresent: rows.length === 1,
      repositoryReadback: rows[0] ?? null, childIdsAfter: { present: postgresFolderChildIds(root) !== null },
      canonicalPath: { stored: repository.Path, actual: root.Path,
        reset: repository.Path !== root.Path } });
  }
  for (const item of roots[1].VirtualChildren) {
    const previous = previousItems.get(idKey(item.Id));
    if (previous) assert.notEqual(item, previous);
    assert.equal(manager.getCachedItemById(item.Id), item);
    const rows = await database.rows('BaseItems', { where: { Id: item.Id.toUpperCase() } });
    assert.equal(rows.length, 1);
    assert.deepEqual(item.NativeRepositoryColumns, rows[0]);
    observations.virtualChildren.push({ ...describe(item), freshReceiver: previous ? item !== previous : null,
      repositoryReadback: rows[0] });
  }
  assert.equal(observations.hostRebuilds, 1);
  return observations;
}

function normalizeProblem(value) {
  if (Array.isArray(value)) return value.map(normalizeProblem);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'traceId')
    .map(([key, item]) => [key, normalizeProblem(item)]));
}

function stableRows(rows) {
  const text = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
  return [...rows].sort((left, right) => text(left).localeCompare(text(right), 'en'));
}

async function targetSnapshot(database) {
  return {
    ApiKeys: stableRows(await database.rows('ApiKeys')),
    BaseItems: stableRows(await database.rows('BaseItems')),
    AncestorIds: stableRows(await database.rows('AncestorIds')),
    LinkedChildren: stableRows(await database.rows('LinkedChildren')),
    MediaStreamInfos: stableRows(await database.rows('MediaStreamInfos')),
    Peoples: stableRows(await database.rows('Peoples')),
    PeopleBaseItemMap: stableRows(await database.rows('PeopleBaseItemMap')),
    ItemValues: stableRows(await database.rows('ItemValues')),
    ItemValuesMap: stableRows(await database.rows('ItemValuesMap')),
    BaseItemImageInfos: stableRows(await database.rows('BaseItemImageInfos')),
    BaseItemProviders: stableRows(await database.rows('BaseItemProviders')),
    BaseItemMetadataFields: stableRows(await database.rows('BaseItemMetadataFields')),
  };
}

async function metadataSnapshot(root, hashFiles = false) {
  const entries = [];
  async function visit(directory) {
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const child of children) {
      const target = path.join(directory, child.name);
      entries.push({ path: path.relative(root, target).replaceAll('\\', '/'), type: child.isDirectory() ? 'directory' : 'file' });
      if (hashFiles && child.isFile()) entries.at(-1).sha256 = createHash('sha256').update(await readFile(target)).digest('hex');
      if (child.isDirectory()) await visit(target);
    }
  }
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

async function instanceFilesystemSnapshot(root, extra = {}) {
  const paths = { userViews: 'root/default', metadata: 'metadata', libraries: 'library-content', collections: 'data/collections', ...extra };
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, relative]) => {
    const directory = path.join(root, relative);
    const resolved = path.relative(path.resolve(root), path.resolve(directory));
    if (resolved === '..' || resolved.startsWith('..' + path.sep) || path.isAbsolute(resolved)) throw new Error('Snapshot escaped its private instance.');
    const exists = await stat(directory).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    return [name, { exists, entries: await metadataSnapshot(directory, Object.hasOwn(extra, name)) }];
  })));
}

async function portAvailable(port) {
  return await new Promise(resolve => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function authorization(token) {
  return `MediaBrowser Client="ResolutionFilterCandidate", Device="Isolated", DeviceId="resolution-filter-candidate", Version="1"${token ? `, Token="${token}"` : ''}`;
}

function routeFor(endpoint, testCase, fixture, userId, fields) {
  if (testCase.action === 'live-tv-recommended') return `/LiveTv/Programs/Recommended?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'live-tv-programs') return `/LiveTv/Programs?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'live-tv-program') return `/LiveTv/Programs/${encodeURIComponent(testCase.programId)}?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'live-tv-channels') return `/LiveTv/Channels?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'live-tv-channel') return `/LiveTv/Channels/${encodeURIComponent(testCase.channelId)}?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'shows-episodes') return `/Shows/${encodeURIComponent(testCase.seriesId)}/Episodes?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'playback-info') return `/Items/${fixture.items.find(item => item.key === testCase.detailKey).id}/PlaybackInfo?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'intros') return `${endpoint === 'legacy' ? '/Users/' + (testCase.introUserId ?? userId) : ''}/Items/${testCase.introItemId ?? fixture.items.find(item => item.key === testCase.detailKey).id}/Intros?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'theme') return `/Items/${testCase.themeItemId ?? fixture.items.find(item => item.key === testCase.detailKey).id}/${testCase.themeRoute}?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'dto-detail') return `${endpoint === 'legacy' ? '/Users/' + userId : ''}/Items/${fixture.items.find(item => item.key === testCase.detailKey).id}?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'named-list' || testCase.action === 'named-detail') return `/${testCase.namedRoute}${testCase.action === 'named-detail' ? '/' + encodeURIComponent(testCase.itemName) : ''}?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (['filters', 'filters2'].includes(testCase.action)) return `/Items/${testCase.action === 'filters' ? 'Filters' : 'Filters2'}?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'studio-name') return `/Studios/${encodeURIComponent(testCase.studioName)}?${testCase.query}`;
  const itemByKey = new Map(fixture.items.map(item => [item.key, item]));
  if (endpoint === 'detail') return `/Items/${itemByKey.get(testCase.detailKey).id}`;
  const common = [];
  const omitParentId = testCase.omitScope === true || testCase.omitParentId === true;
  const omitIds = testCase.omitScope === true || testCase.omitIds === true;
  if (!omitParentId) {
    const parentId = testCase.parentKey ? itemByKey.get(testCase.parentKey).id : fixture.rootId;
    common.push(`ParentId=${encodeURIComponent(parentId)}`);
  }
  const recursive = testCase.omitScope === true
    ? null
    : Object.hasOwn(testCase, 'recursive') ? testCase.recursive : true;
  if (recursive !== null) common.push(`Recursive=${recursive ? 'true' : 'false'}`);
  if (!omitIds) {
    const scopeIds = testCase.scope.map(key => itemByKey.get(key).id).join(',');
    common.push(`Ids=${encodeURIComponent(scopeIds)}`);
  }
  if (!testCase.omitSortBy) common.push(`SortBy=${encodeURIComponent(testCase.sortBy ?? 'SortName')}`);
  common.push(`Fields=${encodeURIComponent(testCase.fields ?? fields)}`, 'EnableImages=false', `EnableUserData=${testCase.enableUserData === true ? 'true' : 'false'}`, testCase.query);
  const prefix = (testCase.action === 'studios' ? '/Studios' : endpoint === 'items' ? '/Items' : `/Users/${userId}/Items`)
    + (testCase.action === 'latest' ? '/Latest' : '');
  // Frozen fixtures refer to the reference account id. Candidate users are
  // created afresh, so only substitute that runtime identity in the wire query.
  const scenarioQuery = testCase.query.replaceAll(fixture.userId, userId);
  common[common.length - 1] = scenarioQuery;
  return `${prefix}?${common.join('&')}`;
}

function responseContract(response, keyById, {
  assertOrder = false, captureOrder = false, captureItems = false, captureParentItems = false,
  captureStartIndex = false, captureTags = false, captureOfficialRatings = false,
  captureSortNames = false, captureErrorText = false, detail = false,
} = {}) {
  if (detail) return {
    status: response.status,
    contentType: response.contentType,
    key: response.body?.Id ? keyById.get(idKey(response.body.Id)) ?? `unknown:${response.body.Id}` : null,
    name: response.body?.Name ?? null,
    tags: response.body?.Tags ?? null,
  };
  const items = Array.isArray(response.body) ? response.body : Array.isArray(response.body?.Items) ? response.body.Items : [];
  const orderedIds = items.map(item => idKey(item.Id));
  const orderedKeys = orderedIds.map((id, index) => keyById.get(id) ?? `unknown:${items[index].Id}`);
  return {
    status: response.status,
    contentType: response.contentType,
    totalRecordCount: response.body?.TotalRecordCount ?? null,
    ...(captureStartIndex ? { startIndex: response.body?.StartIndex ?? null } : {}),
    keys: [...orderedKeys].sort(),
    ...(assertOrder || captureOrder ? { orderedKeys } : {}),
    ...(captureOrder ? { orderedIds } : {}),
    ...(captureTags ? { tags: items.map((item, index) => ({ key: orderedKeys[index], values: item.Tags ?? null })) } : {}),
    ...(captureOfficialRatings ? { officialRatings: items.map((item, index) => ({
      key: orderedKeys[index], value: item.OfficialRating ?? null,
    })) } : {}),
    ...(captureSortNames ? { sortNames: items.map((item, index) => ({
      key: orderedKeys[index], value: item.SortName ?? null,
    })) } : {}),
    ...(captureErrorText && response.status >= 400 ? { errorText: response.bodyText } : {}),
    ...(captureItems ? {
      items: items.map((item, index) => ({
        key: orderedKeys[index],
        id: orderedIds[index],
        name: item.Name ?? null,
        type: item.Type ?? null,
        productionYear: item.ProductionYear ?? null,
      })),
    } : captureParentItems ? {
      // Some native contracts contain runtime-created library ids. Project the
      // parent back to the stable fixture key so candidate replay never freezes
      // a machine-specific CollectionFolder/physical-folder identifier.
      items: items.map((item, index) => ({
        key: orderedKeys[index],
        name: item.Name ?? null,
        type: item.Type ?? null,
        parentKey: item.ParentId == null ? null
          : keyById.get(idKey(item.ParentId)) ?? `unknown:${item.ParentId}`,
      })),
    } : {}),
    problem: response.status >= 400
      ? captureErrorText && !(response.body && typeof response.body === 'object')
        ? null
        : normalizeProblem(response.body && typeof response.body === 'object' ? response.body : { rawBody: response.bodyText })
      : null,
  };
}

async function assertDatabaseClosed(database) {
  try {
    await database.rows('BaseItems', { limit: 1 });
    return false;
  } catch (error) {
    const expected = error?.message === 'Client was closed and is not queryable';
    if (expected) return true;
    throw new Error(`Database close verification failed with an unexpected ${database.dialect} error.`, { cause: error });
  }
}

async function dropAndVerifyPostgresSchemas(connectionString, schema) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const names = [schema, `${schema}__mm`];
    const errors = [];
    for (const name of names) {
      try { await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(name)} CASCADE`); }
      catch (error) { errors.push(error); }
    }
    let remaining;
    try {
      remaining = await client.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1::text[])',
        [names]);
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, `Failed to clean PostgreSQL schemas for ${schema}.`);
    return remaining.rows.length === 0;
  } finally {
    await client.end();
  }
}

export async function recordItemFilterCandidate({ dialect, fixture, connectionString, scenarioName, configuration = {},
  fields = 'Width,Height', captureOrder = false, captureItems = false, captureParentItems = false,
  captureStartIndex = false, captureTags = false, captureOfficialRatings = false, captureSortNames = false,
  captureErrorText = false, captureResponseBodies = false, captureCaseRuntimeErrors = false, trackUserData = false,
  trackFilesystem = false, trackSideEffectCase = null,
  prepareInstance = null, prepareScenario = null, prepareCase = null, afterEndpoint = null, captureCaseStages = false, captureEndpointStages = false,
  captureShutdownState = false, captureFilesystemDomains = false,
  extraFilesystemDomains = {}, captureStateKeys = [],
  requestTimeoutMs = 15000 }) {
  if (!['postgres'].includes(dialect)) throw new Error(`Unknown database dialect: ${dialect}.`);
  if (!Array.isArray(captureStateKeys) || captureStateKeys.some(key => typeof key !== 'string' || !key)) throw new TypeError('State snapshot keys must be nonempty strings.');
  const snapshotState = async db => Object.fromEntries(await Promise.all(captureStateKeys.map(async key => [key, await db.getState(key)])));
  if (typeof fields !== 'string') throw new TypeError('fields must be a string.');
  if (typeof captureOrder !== 'boolean') throw new TypeError('captureOrder must be a boolean.');
  if (typeof captureItems !== 'boolean') throw new TypeError('captureItems must be a boolean.');
  if (typeof captureParentItems !== 'boolean') throw new TypeError('captureParentItems must be a boolean.');
  if (captureItems && captureParentItems) throw new TypeError('captureItems and captureParentItems are mutually exclusive.');
  if (typeof captureStartIndex !== 'boolean') throw new TypeError('captureStartIndex must be a boolean.');
  if (typeof captureTags !== 'boolean') throw new TypeError('captureTags must be a boolean.');
  if (typeof captureOfficialRatings !== 'boolean') throw new TypeError('captureOfficialRatings must be a boolean.');
  if (typeof captureSortNames !== 'boolean') throw new TypeError('captureSortNames must be a boolean.');
  if (typeof captureErrorText !== 'boolean') throw new TypeError('captureErrorText must be a boolean.');
  if (typeof captureResponseBodies !== 'boolean' || typeof captureCaseRuntimeErrors !== 'boolean' || typeof trackUserData !== 'boolean') {
    throw new TypeError('Response and user-data capture flags must be boolean.');
  }
  if (prepareScenario !== null && typeof prepareScenario !== 'function') throw new TypeError('prepareScenario must be a function.');
  if (prepareInstance !== null && typeof prepareInstance !== 'function') throw new TypeError('prepareInstance must be a function.');
  if (prepareCase !== null && typeof prepareCase !== 'function') throw new TypeError('prepareCase must be a function.');
  if (afterEndpoint !== null && typeof afterEndpoint !== 'function') throw new TypeError('afterEndpoint must be a function.');
  if (typeof captureEndpointStages !== 'boolean' || (captureEndpointStages && !trackFilesystem)) {
    throw new TypeError('Endpoint-stage capture requires filesystem tracking.');
  }
  if (typeof captureShutdownState !== 'boolean') throw new TypeError('Shutdown-state capture must be a boolean.');
  if (typeof captureFilesystemDomains !== 'boolean' || (captureFilesystemDomains && !trackFilesystem)) {
    throw new TypeError('Filesystem-domain capture requires filesystem tracking.');
  }
  if (typeof captureCaseStages !== 'boolean' || (captureCaseStages && !trackFilesystem)) {
    throw new TypeError('Case-stage capture requires filesystem tracking.');
  }
  if (trackSideEffectCase != null && (!trackFilesystem || typeof trackSideEffectCase !== 'string')) {
    throw new TypeError('Side-effect tracking requires a case name and filesystem tracking.');
  }
  validateFixture(fixture);
  // PostgresDatabase reserves a strict 40-character explicit-schema budget.
  // Keep the 16-character random suffix while making long scenario labels safe.
  const slug = String(scenarioName).replace(/[^a-z0-9]+/giu, '_').replace(/^_+|_+$/gu, '').toLowerCase().slice(0, 23);
  if (!slug) throw new TypeError('scenarioName must contain an ASCII letter or digit.');
  const schema = `${slug}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  const runtimeErrors = [];
  const handledExpectedRuntimeErrors = [];
  let runtime;
  let port;
  let result;
  let scenarioError;
  let currentCase = null;
  const requestHistory = [];
  const failureFile = path.join(validationOutputRoot(), 'item-filter-failure-' + schema + '.jsonl');
  assertValidationOutputChild(failureFile);
  const describeError = (error, seen = new Set()) => {
    if (error == null || typeof error !== 'object') return { message: String(error) };
    if (seen.has(error)) return { repeatedReference: true };
    seen.add(error);
    const redact = text => typeof text === 'string' && connectionString ? text.replaceAll(connectionString, '[fixture-secret]') : text;
    return { name: error.name, code: error.code, message: redact(error.message), stack: redact(error.stack),
      ...(error.cause === undefined ? {} : { cause: describeError(error.cause, seen) }),
      ...(Array.isArray(error.errors) ? { errors: error.errors.map(value => describeError(value, seen)) } : {}) };
  };
  const preserveFailure = async phase => {
    try {
      await mkdir(path.dirname(failureFile), { recursive: true });
      await appendFile(failureFile, JSON.stringify({ phase, scenarioName, schema, currentCase, requestHistory,
        error: describeError(scenarioError), cleanup, scope: 'Actual failure/cause chain and request progress only; no retry or changed expectation.' }) + '\n');
    } catch (error) {
      scenarioError = new AggregateError([scenarioError, error], 'Could not preserve the original HTTP scenario failure.');
    }
  };
  let programDataDirectory;
  const cleanup = { runtimeClosed: false, databaseClosed: false, portReleased: false,
    postgresSchemasRemoved: false };
  let databaseClosed = false;
  const closeDatabase = database.close.bind(database);
  database.close = async () => { await closeDatabase(); databaseClosed = true; };
  try {
    programDataDirectory = await mkdtemp(path.join(tmpdir(), 'mm-item-filter-'));
    if (prepareInstance) await prepareInstance({ programDataPath: programDataDirectory, database });
    runtime = await createRuntime({
      database,
      configuration: { IsStartupWizardCompleted: true, UICulture: 'en-US', ...configuration },
      serverId: `${slug}-${dialect}`,
      serverName: 'Item Filter HTTP Test',
      programDataPath: programDataDirectory,
      onError: error => runtimeErrors.push({ name: error.name, message: error.message }),
    });
    const closeFile = path.join(validationOutputRoot(), 'item-filter-close-' + schema + '.jsonl');
    assertValidationOutputChild(closeFile); await mkdir(path.dirname(closeFile), { recursive: true });
    const recordClose = value => appendFileSync(closeFile, JSON.stringify({ ...value, time: new Date().toISOString(),
      scope: 'Actual owner close entry and settlement only; no timeout, retry or forced release.' }) + '\n');
    const observedOwners = new Set([runtime.server]);
    for (const [name, owner] of [...Object.entries(runtime), ['resourceGraph', runtime.linkedChildren?.resourceGraph]]) {
      if (!owner || typeof owner !== 'object' || typeof owner.close !== 'function' || observedOwners.has(owner)) continue;
      observedOwners.add(owner);
      const close = owner.close;
      owner.close = function (...args) {
        recordClose({ owner: name, phase: 'start' });
        try {
          return Promise.resolve(close.apply(this, args)).then(value => {
            recordClose({ owner: name, phase: 'settled' }); return value;
          }, error => { recordClose({ owner: name, phase: 'failed', error: describeError(error) }); throw error; });
        } catch (error) { recordClose({ owner: name, phase: 'failed', error: describeError(error) }); throw error; }
      };
    }
    if (captureEndpointStages || captureShutdownState) {
      const closeStore = runtime.store.close.bind(runtime.store);
      runtime.store.close = async () => {
        // Capture shutdown after HTTP and all background hosts have stopped,
        // immediately before closing the native connection.
        if (result) await runtime.store.run(async connection => {
          result.afterShutdown = await targetSnapshot(connection);
          if (trackUserData) result.userDataAfterShutdown = stableRows(await connection.rows('UserData'));
          if (captureStateKeys.length) result.stateAfterShutdown = await snapshotState(connection);
        });
        return closeStore();
      };
    }
    const created = await runtime.users.createUser({ Name: 'FilterAdmin', Password: 'filter password' });
    const current = await runtime.users.getUser(created.Id);
    await runtime.users.updatePolicy(created.Id, { ...current.Policy, IsAdministrator: true, EnableAllFolders: true });
    const user = await runtime.users.getUser(created.Id);
    await seed(database, fixture, slug);
    if (prepareScenario) await prepareScenario({ database, programDataPath: programDataDirectory, fixture, user, users: runtime.users,
      storage: runtime.storage, plugins: runtime.plugins });
    const rootPreparation = await prepareSeededRoots(runtime, database, programDataDirectory);

    runtime.server.listen(0, '127.0.0.1');
    await once(runtime.server, 'listening');
    port = runtime.server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const request = async (route, { method = 'GET', token, body } = {}) => {
      const description = new URL(route, origin);
      for (const key of description.searchParams.keys()) if (/^(?:api_key|access_token|accesstoken|token)$/iu.test(key))
        description.searchParams.set(key, '[fixture-secret]');
      const observed = { case: currentCase, method, route: description.pathname + description.search, completed: false };
      requestHistory.push(observed);
      const response = await fetch(origin + route, {
        method,
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: {
          Accept: 'application/json',
          Authorization: authorization(token),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const bodyText = await response.text();
      observed.completed = true; observed.status = response.status;
      let parsed;
      try { parsed = bodyText === '' ? null : JSON.parse(bodyText); }
      catch { parsed = undefined; }
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        bodyText,
        ...(parsed === undefined ? {} : { body: parsed }),
      };
    };

    const login = await request('/Users/AuthenticateByName', {
      method: 'POST',
      body: { Username: 'FilterAdmin', Pw: 'filter password' },
    });
    if (login.status !== 200) throw new Error(`Candidate login failed with ${login.status}.`);
    const userToken = login.body.AccessToken;
    const appName = `${scenarioName} HTTP Oracle`;
    const createKey = await request(`/Auth/Keys?app=${encodeURIComponent(appName)}`, { method: 'POST', token: userToken });
    if (createKey.status !== 204) throw new Error(`Candidate API-key creation failed with ${createKey.status}.`);
    const listedKeys = await request('/Auth/Keys', { token: userToken });
    if (listedKeys.status !== 200) throw new Error(`Candidate API-key listing failed with ${listedKeys.status}.`);
    const apiKey = listedKeys.body.Items.find(item => item.AppName === appName)?.AccessToken;
    if (!apiKey) throw new Error('Candidate API key was not returned by /Auth/Keys.');

    let warmUserViews = null;
    if (fixture.warmUserViews) {
      for (const [field, suffix] of [['configuration', 'Configuration'], ['policy', 'Policy']]) {
        const updated = await request('/Users/' + user.Id + '/' + suffix, { method: 'POST', token: apiKey,
          body: { ...login.body.User[suffix], ...fixture.warmUserViews[field] } });
        assert.equal(updated.status, 204, updated.bodyText);
      }
      const route = '/UserViews?UserId=' + user.Id + '&IncludeHidden=true';
      const response = await request(route, { token: userToken });
      assert.equal(response.status, 200, response.bodyText);
      assert.ok(Array.isArray(response.body?.Items));
      await runtime.library.userViews.drain();
      warmUserViews = { route, response, refreshQueueDrained: true };
    }
    const beforeReads = await targetSnapshot(database);
    const stateBeforeReads = captureStateKeys.length ? await snapshotState(database) : null;
    const userDataBeforeReads = trackUserData ? stableRows(await database.rows('UserData')) : null;
    const filesystemBeforeReads = trackFilesystem
      ? await metadataSnapshot(path.join(programDataDirectory, 'metadata')) : null;
    const filesystemDomainsBeforeReads = captureFilesystemDomains ? await instanceFilesystemSnapshot(programDataDirectory, extraFilesystemDomains) : null;
    const keyById = new Map(fixture.items.map(item => [idKey(item.id), item.key]));
    const cases = [];
    const caseStages = [];
    const sideEffect = trackSideEffectCase == null ? null : {};
    let httpCases = 0;
    for (const testCase of fixture.cases) {
      currentCase = testCase.name;
      const endpoints = testCase.endpoints ?? ['items', 'legacy'];
      if (prepareCase) await prepareCase({ testCase, runtime, database, user });
      let policyReadback;
      if (testCase.configuration) {
        const update = await request(`/Users/${user.Id}/Configuration`, { method: 'POST', token: apiKey,
          body: { ...user.Configuration, ...testCase.configuration } });
        if (update.status !== 204) throw new Error(`${testCase.name}: candidate user configuration update returned ${update.status}: ${update.bodyText}`);
      }
      if (testCase.policy) {
        const update = await request(`/Users/${user.Id}/Policy`, { method: 'POST', token: apiKey,
          body: { ...user.Policy, ...testCase.policy } });
        if (update.status !== 204) throw new Error(`${testCase.name}: candidate policy update returned ${update.status}: ${update.bodyText}`);
        if (typeof testCase.policy.IsAdministrator === 'boolean') {
          const effective = await request(`/Users/${user.Id}`, { token: userToken });
          if (effective.status !== 200 || effective.body.Policy.IsAdministrator !== testCase.policy.IsAdministrator) {
            throw new Error(`${testCase.name}: candidate administrator policy readback did not match.`);
          }
          policyReadback = effective.body.Policy;
        }
      }
      if ((testCase.parallelRequests || testCase.parallelQueries) && testCase.name === trackSideEffectCase) {
        throw new TypeError('Parallel requests cannot capture intermediate side-effect stages.');
      }
      const endpointContracts = [];
      if (testCase.name === trackSideEffectCase) {
        sideEffect.before = await targetSnapshot(database);
        sideEffect.filesystemBefore = await metadataSnapshot(path.join(programDataDirectory, 'metadata'));
      }
      for (const endpoint of endpoints) {
        const before = captureEndpointStages ? { database: await targetSnapshot(database),
          filesystem: await metadataSnapshot(path.join(programDataDirectory, 'metadata')),
          ...(trackUserData ? { userData: stableRows(await database.rows('UserData')) } : {}),
          ...(captureFilesystemDomains ? { filesystemDomains: await instanceFilesystemSnapshot(programDataDirectory, extraFilesystemDomains) } : {}) } : null;
        const token = testCase.auth === 'apiKey' ? apiKey : userToken;
        const runtimeErrorStart = runtimeErrors.length;
        const routes = testCase.parallelQueries
          ? testCase.parallelQueries.map(query => routeFor(endpoint, { ...testCase, query }, fixture, user.Id, fields))
          : Array.from({ length: testCase.parallelRequests ?? 1 },
            () => routeFor(endpoint, testCase, fixture, user.Id, fields));
        const requestDescription = { method: testCase.method ?? 'GET', ...(Object.hasOwn(testCase, 'body')
          ? { body: JSON.parse(JSON.stringify(testCase.body).replaceAll(fixture.userId, user.Id)) } : {}) };
        const responses = await Promise.all(routes.map(route => request(route, { token, ...requestDescription })));
        if (afterEndpoint) await afterEndpoint({ testCase, endpoint, responses, runtime, database, user });
        for (const response of responses) {
          if (endpoint === 'detail' && testCase.detailExpectedStatus !== undefined
            && response.status !== testCase.detailExpectedStatus) {
            throw new Error(`${testCase.name}:detail returned ${response.status}, expected ${testCase.detailExpectedStatus}.`);
          }
          if (!captureCaseRuntimeErrors && endpoint !== 'detail' && (testCase.expectedStatus ?? 200) >= 400) {
            const emitted = runtimeErrors.splice(runtimeErrorStart);
            const expectedRuntimeError = testCase.expectRuntimeError === false
              ? []
              : [{ name: 'Error', message: testCase.expectedRuntimeError ?? 'Error processing request.' }];
            if (JSON.stringify(emitted) !== JSON.stringify(expectedRuntimeError)) {
              throw new Error(`${testCase.name}:${endpoint} emitted an unexpected runtime error sequence: ${JSON.stringify(emitted)}`);
            }
            if (emitted.length) handledExpectedRuntimeErrors.push({ caseName: testCase.name, endpoint, error: emitted[0] });
          }
          endpointContracts.push({
            endpoint,
            ...(testCase.action?.startsWith('live-tv-program') || testCase.action?.startsWith('live-tv-channel') || testCase.action === 'shows-episodes'
              ? { request: requestDescription } : {}),
            ...(captureResponseBodies ? { response } : {}),
            ...(captureCaseRuntimeErrors ? { runtimeErrors: runtimeErrors.splice(runtimeErrorStart) } : {}),
            contract: responseContract(response, keyById, {
              assertOrder: testCase.assertOrder === true,
              captureOrder,
              captureItems,
              captureParentItems,
              captureStartIndex,
              captureTags,
              captureOfficialRatings,
              captureSortNames: captureSortNames && (testCase.fields ?? fields).split(',').includes('SortName'),
              captureErrorText,
              detail: endpoint === 'detail',
            }),
          });
          if (testCase.name === trackSideEffectCase) {
            const stage = endpointContracts.length === 1 ? 'afterFirst' : 'afterRepeat';
            sideEffect[stage] = await targetSnapshot(database);
            sideEffect[`filesystem${stage[0].toUpperCase()}${stage.slice(1)}`]
              = await metadataSnapshot(path.join(programDataDirectory, 'metadata'));
          }
          httpCases++;
        }
        if (captureEndpointStages) caseStages.push({ name: testCase.name, endpoint, before,
          after: { database: await targetSnapshot(database),
            filesystem: await metadataSnapshot(path.join(programDataDirectory, 'metadata')),
            ...(trackUserData ? { userData: stableRows(await database.rows('UserData')) } : {}),
            ...(captureFilesystemDomains ? { filesystemDomains: await instanceFilesystemSnapshot(programDataDirectory, extraFilesystemDomains) } : {}) } });
      }
      cases.push({ name: testCase.name, query: testCase.query, scope: testCase.scope,
        ...(policyReadback ? { policyReadback } : {}),
        ...(testCase.policy ? { policy: testCase.policy } : {}),
        ...(testCase.configuration ? { configuration: testCase.configuration } : {}),
        ...(testCase.serverConfiguration ? { serverConfiguration: testCase.serverConfiguration } : {}),
        ...(testCase.detailKey ? { detailKey: testCase.detailKey } : {}),
        ...(testCase.parentKey ? { parentKey: testCase.parentKey } : {}),
        ...(testCase.omitScope ? { omitScope: true } : {}),
        ...(testCase.omitParentId ? { omitParentId: true } : {}),
        ...(testCase.omitIds ? { omitIds: true } : {}),
        ...(Object.hasOwn(testCase, 'recursive') ? { recursive: testCase.recursive } : {}),
        ...(testCase.omitSortBy ? { omitSortBy: true } : {}),
        ...(testCase.assertOrder ? { assertOrder: true } : {}),
        ...(testCase.parallelRequests ? { parallelRequests: testCase.parallelRequests } : {}),
        ...(testCase.parallelQueries ? { parallelQueries: testCase.parallelQueries } : {}),
        ...(Object.hasOwn(testCase, 'expectedStatus') ? { expectedStatus: testCase.expectedStatus } : {}),
        ...(Object.hasOwn(testCase, 'detailExpectedStatus') ? { detailExpectedStatus: testCase.detailExpectedStatus } : {}),
        auth: testCase.auth ?? 'user', endpoints: endpointContracts });
      if (captureCaseStages) caseStages.push({ name: testCase.name,
        database: await targetSnapshot(database),
        filesystem: await metadataSnapshot(path.join(programDataDirectory, 'metadata')) });
    }
    const afterReads = await targetSnapshot(database);
    const stateAfterReads = captureStateKeys.length ? await snapshotState(database) : null;
    const userDataAfterReads = trackUserData ? stableRows(await database.rows('UserData')) : null;
    const filesystemAfterReads = trackFilesystem
      ? await metadataSnapshot(path.join(programDataDirectory, 'metadata')) : null;
    const filesystemDomainsAfterReads = captureFilesystemDomains ? await instanceFilesystemSnapshot(programDataDirectory, extraFilesystemDomains) : null;
    if (sideEffect && !sideEffect.afterFirst) throw new Error(`Side-effect case not run: ${trackSideEffectCase}.`);
    result = { dialect, schema: dialect === 'postgres' ? schema : null, programDataDirectory, userId: user.Id, rootPreparation, cases, httpCases,
      beforeReads, afterReads, filesystemBeforeReads, filesystemAfterReads,
      ...(captureStateKeys.length ? { stateBeforeReads, stateAfterReads } : {}),
      ...(warmUserViews ? { warmUserViews } : {}),
      ...(trackUserData ? { userDataBeforeReads, userDataAfterReads } : {}),
      ...(captureFilesystemDomains ? { filesystemDomainsBeforeReads, filesystemDomainsAfterReads } : {}),
      sideEffect, caseStages, runtimeErrors, handledExpectedRuntimeErrors, cleanup };
  } catch (error) {
    scenarioError = error;
    await preserveFailure('operation-failed');
  } finally {
    try {
      if (runtime) await runtime.close();
      else if (!databaseClosed) await database.close();
      cleanup.runtimeClosed = runtime ? runtime.server.listening === false : true;
    } catch (error) {
      scenarioError ??= error;
    }
    try { cleanup.databaseClosed = await assertDatabaseClosed(database); }
    catch (error) { scenarioError ??= error; }
    if (port !== undefined) cleanup.portReleased = await portAvailable(port);
    if (dialect === 'postgres') {
      try { cleanup.postgresSchemasRemoved = await dropAndVerifyPostgresSchemas(connectionString, schema); }
      catch (error) { scenarioError ??= error; }
    }
    if (programDataDirectory) {
      try {
        result && (result.filesystemAfterShutdown = await metadataSnapshot(path.join(programDataDirectory, 'metadata')));
        if (result && captureFilesystemDomains) result.filesystemDomainsAfterShutdown = await instanceFilesystemSnapshot(programDataDirectory, extraFilesystemDomains);
        const parent = path.resolve(tmpdir());
        const target = path.resolve(programDataDirectory);
        if (!target.startsWith(parent + path.sep) || !path.basename(target).startsWith('mm-item-filter-')) {
          throw new Error('The isolated item-filter directory escaped the system temporary directory.');
        }
        await rm(target, { recursive: true, force: false });
        cleanup.programDataDirectoryRemoved = await stat(target).then(() => false, error => error.code === 'ENOENT');
      } catch (error) { scenarioError ??= error; }
    }
  }
  if (scenarioError) { await preserveFailure('cleanup-finished'); throw scenarioError; }
  return result;
}

export function recordResolutionFilterCandidate(options) {
  return recordItemFilterCandidate({ ...options, scenarioName: 'resolution-filter' });
}
