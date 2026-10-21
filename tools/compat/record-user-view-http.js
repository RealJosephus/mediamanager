// Record the UserView query matrices against a prepared, stopped Jellyfin instance.
// The recorder never reads candidate expectations; all wire and persistence evidence
// comes from the native process and its copied SQLite database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { tableDefinition } from '../../src/database/model.js';
import { assertValidationOutputChild } from '../validation/paths.js';
import { currentNativeReference } from './current-native-reference.js';
import { createPrivateFilterOutput } from './filter-reference-output.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scenarios = {
  'user-root-visibility': {
    fixture: 'tests/library/fixtures/user-root-visibility/input.json',
    expectedCases: 256,
    menuLifecycle: false,
  },
  'user-view-menu': {
    fixture: 'tests/library/fixtures/user-view-menu/input.json',
    expectedCases: 196,
    expectedDynamicMenuViews: 28,
    menuLifecycle: true,
  },
  'user-view-query': {
    fixture: 'tests/library/fixtures/user-view-query/input.json',
    expectedCases: 260,
    menuLifecycle: false,
  },
  'latest-media': {
    fixture: 'tests/library/fixtures/latest-media/input.json',
    expectedCases: 130,
    responseArray: true,
    libraryTypeMarkers: true,
    menuLifecycle: false,
  },
  'studios-http': {
    fixture: 'tests/library/fixtures/studios-http/input.json',
    expectedCases: 44,
    libraryTypeMarkers: true,
    menuLifecycle: false,
  },
  'item-filters-http': {
    fixture: 'tests/library/fixtures/item-filters-http/input.json',
    expectedCases: 81,
    responseFacets: true,
    libraryTypeMarkers: true,
    menuLifecycle: false,
  },
  'named-items-http': {
    fixture: 'tests/library/fixtures/named-items-http/input.json',
    expectedCases: 153,
    namedMetadataPaths: true,
    libraryTypeMarkers: true,
    menuLifecycle: false,
  },
  'dto-item-counts-http': {
    fixture: 'tests/library/fixtures/dto-item-counts-http/input.json',
    expectedCases: 114,
    namedMetadataPaths: true,
    libraryTypeMarkers: true,
    menuLifecycle: false,
  },
  'theme-media-http': {
    fixture: 'tests/library/fixtures/theme-media-http/input.json',
    expectedCases: 138,
    includeAggregateSnapshot: true,
    libraryTypeMarkers: true,
    menuLifecycle: false,
  },
  'intros-http': {
    fixture: 'tests/library/fixtures/intros-http/input.json',
    expectedCases: 26,
    libraryTypeMarkers: true,
    menuLifecycle: false,
  },
  'named-item-lifecycle-http': {
    fixture: 'tests/library/fixtures/named-item-lifecycle-http/input.json',
    expectedCases: 26,
    namedLifecycle: true,
    libraryTypeMarkers: true,
    menuLifecycle: false,
  },
  'dto-path-substitution-http': {
    fixture: 'tests/library/fixtures/dto-path-substitution-http/input.json',
    expectedCases: 48,
    includeAggregateSnapshot: true,
    libraryTypeMarkers: true,
    menuLifecycle: false,
  },
  'playback-path-substitution-http': {
    fixture: 'tests/playback/fixtures/path-substitution-http/input.json',
    expectedCases: 12,
    includeAggregateSnapshot: true,
    libraryTypeMarkers: true,
    menuLifecycle: false,
  },
};

export async function recordUserViewHttp(scenarioName, outputArgument, portArgument) {
const scenario = scenarios[scenarioName];
if (!scenario || !outputArgument || !portArgument) {
  throw new Error('Usage: node tools/compat/record-user-view-http.js <user-root-visibility|user-view-menu|user-view-query> <new-evidence-root> <loopback-port>');
}
const publicOutputRoot = assertValidationOutputChild(path.resolve(repoRoot, outputArgument));
if (existsSync(publicOutputRoot)) {
  throw new Error('Evidence root must be a new child of the configured validation output root.');
}
const port = Number(portArgument);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback port.');

const privateOutput = await createPrivateFilterOutput(publicOutputRoot);
const outputRoot = privateOutput.root, runRoot = outputRoot;
let failure;
try {
const referenceRoot = path.join(runRoot, 'reference');
const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
const bundledSourceDatabase = path.join(outputRoot, 'source-initial.db');
const fixturePath = path.join(repoRoot, scenario.fixture);
const origin = `http://127.0.0.1:${port}`;
const recorderPath = fileURLToPath(import.meta.url);
const recorderBytes = await readFile(recorderPath);
const sourceFixtureBytes = await readFile(fixturePath);
const recordedFixtureBytes = sourceFixtureBytes;
let fixture = JSON.parse(sourceFixtureBytes.toString('utf8'));
const current = await currentNativeReference({ fixtureUserId: fixture.userId });
privateOutput.addSecret(current.accessToken);
const { sourceRoot, sourceDatabase, jellyfinDll, dotnet: dotnetPath, ffmpeg: ffmpegPath } = current;
const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const upperId = value => {
  const id = idKey(value);
  assert.match(id, /^[a-f0-9]{32}$/u);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`.toUpperCase();
};
let itemByKey, itemById, valueByKey, fixtureItemIds, visibleFixtureItemIds, fixtureValueIds;
function indexFixture() {
  itemByKey = new Map(fixture.items.map(item => [item.key, item]));
  itemById = new Map(fixture.items.map(item => [idKey(item.id), item]));
  valueByKey = new Map(fixture.itemValues.map(item => [item.key, item]));
  fixtureItemIds = new Set(fixture.items.map(item => idKey(item.id)));
  visibleFixtureItemIds = new Set(fixture.items.filter(item => item.type !== 'AggregateFolder').map(item => idKey(item.id)));
  fixtureValueIds = new Set(fixture.itemValues.map(item => idKey(item.id)));
}
const collectionsPath = path.join(referenceRoot, 'data/data/collections');
const paths = {
  aggregate: path.join(referenceRoot, 'data/root'),
  physicalA: path.join(referenceRoot, 'library-content/A'),
  physicalB: path.join(referenceRoot, 'library-content/B'),
  physicalT: path.join(referenceRoot, 'library-content/T'),
  physicalK: path.join(referenceRoot, 'library-content/K'),
  physicalM: path.join(referenceRoot, 'library-content/M'),
  libraryA: path.join(referenceRoot, 'data/root/default/Library A'),
  libraryB: path.join(referenceRoot, 'data/root/default/Library B'),
  libraryT: path.join(referenceRoot, 'data/root/default/Library T'),
  libraryK: path.join(referenceRoot, 'data/root/default/Library K'),
  libraryM: path.join(referenceRoot, 'data/root/default/Library M'),
  userRoot: path.join(referenceRoot, 'data/root/default'),
  playlists: scenario.menuLifecycle
    ? path.join(referenceRoot, 'data/playlists') : path.join(referenceRoot, 'data/data/playlists'),
  collections: collectionsPath,
  collectionLibrary: path.join(referenceRoot, 'data/root/default/Collection Library'),
};
const dataRoot = path.join(referenceRoot, 'data/data');
const nativeTypes = {
  AggregateFolder: 'MediaBrowser.Controller.Entities.AggregateFolder',
  Audio: 'MediaBrowser.Controller.Entities.Audio.Audio',
  AudioBook: 'MediaBrowser.Controller.Entities.AudioBook',
  Book: 'MediaBrowser.Controller.Entities.Book',
  CollectionFolder: 'MediaBrowser.Controller.Entities.CollectionFolder',
  Episode: 'MediaBrowser.Controller.Entities.TV.Episode',
  Folder: 'MediaBrowser.Controller.Entities.Folder',
  Genre: 'MediaBrowser.Controller.Entities.Genre',
  Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
  Video: 'MediaBrowser.Controller.Entities.Video',
  MusicAlbum: 'MediaBrowser.Controller.Entities.Audio.MusicAlbum',
  MusicArtist: 'MediaBrowser.Controller.Entities.Audio.MusicArtist',
  MusicGenre: 'MediaBrowser.Controller.Entities.Audio.MusicGenre',
  Person: 'MediaBrowser.Controller.Entities.Person',
  Year: 'MediaBrowser.Controller.Entities.Year',
  Studio: 'MediaBrowser.Controller.Entities.Studio',
  PlaylistsFolder: 'Emby.Server.Implementations.Playlists.PlaylistsFolder',
  Season: 'MediaBrowser.Controller.Entities.TV.Season',
  Series: 'MediaBrowser.Controller.Entities.TV.Series',
  UserRootFolder: 'MediaBrowser.Controller.Entities.UserRootFolder',
  UserView: 'MediaBrowser.Controller.Entities.UserView',
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
const stable = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const quote = name => `"${String(name).replaceAll('"', '""')}"`;
let seedClock;

function itemPath(item) {
  if (Object.hasOwn(item, 'path')) return item.path;
  if (item.pathKind === 'owned') return path.join(path.dirname(itemPath(itemById.get(idKey(item.ownerId)))),
    'theme-media', item.key + (item.type === 'Audio' ? '.mp3' : '.mkv'));
  if (item.pathKind === 'named') return path.join(referenceRoot, 'data/metadata',
    item.type === 'MusicArtist' ? 'artists' : item.type, item.metadataFolder ?? item.name);
  if (item.pathKind === 'studio') return path.join(referenceRoot, 'data/metadata/Studio', item.name);
  if (paths[item.pathKind]) return paths[item.pathKind];
  if (item.pathKind === 'view') return path.join(referenceRoot, 'data/metadata/views', idKey(item.id));
  if (item.pathKind === 'noPath') return null;
  if (item.pathKind === 'dataExact') return dataRoot;
  if (item.pathKind === 'dataTrailing') return dataRoot + path.sep;
  if (item.pathKind === 'dataEscape') return path.join(dataRoot, '..', item.key);
  if (item.pathKind === 'dataUpper') return path.join(dataRoot.toUpperCase(), item.key);
  if (item.pathKind === 'dataSibling') return path.join(dataRoot + '-sibling', item.key);
  if (item.pathKind === 'boxset') return path.join(collectionsPath, item.key);
  if (item.fileName) return path.join(paths.physicalT, item.fileName);
  if (item.pathKind === 'child') {
    const parent = itemById.get(idKey(item.parentId));
    return path.join(itemPath(parent) ?? paths.physicalA, item.key + (item.type === 'Movie' ? '.mkv' : ''));
  }
  return path.join(paths.physicalA, item.key);
}

function itemData(item) {
  const data = { ...(item.data ?? {}) };
  if (item.type === 'CollectionFolder') {
    data.PhysicalLocationsList = (data.PhysicalFolderIds ?? []).map(id => itemPath(itemById.get(idKey(id))));
  }
  return data;
}

async function portAvailable() {
  return await new Promise(resolve => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function filesystemSnapshot() {
  const domains = {
    userViews: paths.userRoot,
    metadata: path.join(referenceRoot, 'data/metadata'),
    libraries: path.join(referenceRoot, 'library-content'),
    collections: collectionsPath,
  };
  const result = {};
  for (const [name, directory] of Object.entries(domains)) {
    const entries = [];
    async function visit(current) {
      let children;
      try { children = await readdir(current, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of children) {
        const target = path.join(current, entry.name);
        const times = scenario.namedLifecycle && name === 'metadata' && entry.isDirectory()
          ? await stat(target, { bigint: true }) : null;
        entries.push({ path: path.relative(directory, target).replaceAll('\\', '/'),
          type: entry.isDirectory() ? 'directory' : 'file',
          ...(times ? { birthtimeNs: String(times.birthtimeNs), mtimeNs: String(times.mtimeNs) } : {}) });
        if (entry.isDirectory()) await visit(target);
      }
    }
    await visit(directory);
    result[name] = { exists: existsSync(directory), entries: entries.sort((left, right) => left.path.localeCompare(right.path, 'en')) };
  }
  return result;
}

function sortedRows(rows) {
  return [...rows].map(row => ({ ...row })).sort((left, right) => stable(left).localeCompare(stable(right), 'en'));
}

function dynamicUserView(row) {
  if (row.Type !== nativeTypes.UserView) return false;
  try { return Boolean(JSON.parse(row.Data ?? '{}').UserId); }
  catch { return false; }
}

function databaseSnapshot() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('PRAGMA busy_timeout=5000');
  try {
    const allBaseItems = database.prepare('SELECT * FROM "BaseItems"').all();
    const baseItems = scenario.menuLifecycle || scenario.namedLifecycle
      ? allBaseItems
      : allBaseItems.filter(row => visibleFixtureItemIds.has(idKey(row.Id)) || dynamicUserView(row)
        || scenario.includeAggregateSnapshot && row.Type === nativeTypes.AggregateFolder);
    const dynamicIds = new Set(baseItems.filter(dynamicUserView).map(row => idKey(row.Id)));
    const targetIds = new Set([...fixtureItemIds, ...dynamicIds]);
    const targetRows = table => sortedRows(database.prepare(`SELECT * FROM ${quote(table)}`).all().filter(row => {
      if (table === 'AncestorIds') return targetIds.has(idKey(row.ItemId));
      if (table === 'LinkedChildren') return targetIds.has(idKey(row.ParentId)) || targetIds.has(idKey(row.ChildId));
      if (table === 'ItemValuesMap') return targetIds.has(idKey(row.ItemId)) || fixtureValueIds.has(idKey(row.ItemValueId));
      if (['MediaStreamInfos', 'BaseItemImageInfos', 'BaseItemProviders', 'BaseItemMetadataFields'].includes(table)) {
        return targetIds.has(idKey(row.ItemId));
      }
      if (table === 'PeopleBaseItemMap') return targetIds.has(idKey(row.ItemId));
      return true;
    }));
    return {
      baseItems: sortedRows(baseItems),
      ancestorIds: targetRows('AncestorIds'),
      linkedChildren: targetRows('LinkedChildren'),
      itemValues: sortedRows(database.prepare('SELECT * FROM "ItemValues"').all()
        .filter(row => fixtureValueIds.has(idKey(row.ItemValueId)))),
      itemValueLinks: targetRows('ItemValuesMap'),
      userData: sortedRows(database.prepare('SELECT * FROM "UserData"').all()
        .filter(row => targetIds.has(idKey(row.ItemId)) && idKey(row.UserId) === idKey(fixture.userId))),
      mediaStreamInfos: targetRows('MediaStreamInfos'),
      peoples: targetRows('Peoples'),
      peopleBaseItemMap: targetRows('PeopleBaseItemMap'),
      baseItemImageInfos: targetRows('BaseItemImageInfos'),
      baseItemProviders: targetRows('BaseItemProviders'),
      baseItemMetadataFields: targetRows('BaseItemMetadataFields'),
      foreignKeyCheck: database.prepare('PRAGMA foreign_key_check').all().map(row => ({ ...row })),
    };
  } finally {
    database.close();
  }
}

function upsertBaseItem(database, template, item) {
  const existing = database.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?').get(upperId(item.id));
  const isFolder = item.isFolder ?? !['Movie', 'Video', 'Audio', 'AudioBook', 'Book', 'Episode', 'Studio', 'Genre', 'MusicGenre', 'Person', 'Year'].includes(item.type);
  const row = {
    ...(existing ?? template),
    Id: upperId(item.id),
    Type: nativeTypes[item.type],
    ParentId: item.parentId == null ? null : upperId(item.parentId),
    TopParentId: item.topParentId == null ? null : upperId(item.topParentId),
    Name: item.name,
    CleanName: Object.hasOwn(item, 'cleanName') ? item.cleanName : item.name?.toLowerCase() ?? null,
    SortName: item.sortName,
    Path: itemPath(item),
    IsFolder: isFolder ? 1 : 0,
    IsMovie: item.type === 'Movie' ? 1 : 0,
    IsSeries: item.type === 'Series' ? 1 : 0,
    Overview: item.overview ?? null,
    ...(Object.hasOwn(item, 'communityRating') ? { CommunityRating: item.communityRating } : {}),
    Genres: item.genresText ?? null,
    PrimaryVersionId: item.primaryVersionId == null ? null : upperId(item.primaryVersionId),
    IsVirtualItem: item.isVirtualItem ? 1 : 0,
    RunTimeTicks: item.runTimeTicks == null ? null : Number(item.runTimeTicks),
    IndexNumber: item.indexNumber ?? null,
    ParentIndexNumber: item.parentIndexNumber ?? null,
    SeriesId: item.seriesId == null ? null : upperId(item.seriesId),
    ...(Object.hasOwn(item, 'seasonId') ? { SeasonId: item.seasonId == null ? null : upperId(item.seasonId) } : {}),
    ...(Object.hasOwn(item, 'seriesName') ? { SeriesName: item.seriesName } : {}),
    SeriesPresentationUniqueKey: item.seriesPresentationUniqueKey ?? null,
    OwnerId: item.ownerId == null ? null : upperId(item.ownerId),
    ExtraType: item.extraType ?? null,
    Tags: item.tagsText ?? null,
    OfficialRating: item.officialRating ?? null,
    CustomRating: item.customRating ?? null,
    InheritedParentalRatingValue: item.inheritedParentalRatingValue ?? null,
    InheritedParentalRatingSubValue: item.inheritedParentalRatingSubValue ?? null,
    MediaType: item.mediaType ?? (item.type === 'Movie' ? 'Video' : item.type === 'Audio' ? 'Audio' : 'Unknown'),
    UnratedType: item.type === 'Movie' ? 'Movie'
      : ['Series', 'Season', 'Episode'].includes(item.type) ? 'Series'
        : ['Audio', 'AudioBook'].includes(item.type) ? 'Music' : item.type === 'Book' ? 'Book' : 'Other',
    PresentationUniqueKey: ['studios-http', 'item-filters-http', 'named-items-http', 'dto-item-counts-http'].includes(scenarioName) && Object.hasOwn(item, 'presentationUniqueKey')
      ? item.presentationUniqueKey : item.presentationUniqueKey ?? idKey(item.id),
    PremiereDate: item.premiereDate ?? null,
    ProductionYear: item.productionYear ?? null,
    ...(Object.hasOwn(item, 'dateLastRefreshed') ? {
      DateLastRefreshed: item.dateLastRefreshed === '$seed-clock' ? seedClock : item.dateLastRefreshed,
    } : {}),
    ...(Object.hasOwn(item, 'startDate') ? { StartDate: item.startDate } : {}),
    ...(Object.hasOwn(item, 'endDate') ? { EndDate: item.endDate } : {}),
    DateCreated: item.dateCreated ?? '2026-09-29 12:00:00',
    DateModified: '2026-09-29 12:00:00',
    DateLastSaved: '2026-09-29 12:00:00',
    Data: JSON.stringify(itemData(item)),
  };
  const columns = Object.keys(row);
  if (existing) {
    const updates = columns.filter(name => name !== 'Id');
    database.prepare(`UPDATE "BaseItems" SET ${updates.map(name => `${quote(name)} = ?`).join(', ')} WHERE "Id" = ?`)
      .run(...updates.map(name => row[name]), row.Id);
  } else {
    database.prepare(`INSERT INTO "BaseItems" (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...columns.map(name => row[name]));
  }
}

function seedDatabase() {
  if (fixture.items.some(item => item.dateLastRefreshed === '$seed-clock')) {
    seedClock = new Date().toISOString().replace('T', ' ').replace('Z', '');
  }
  const database = new DatabaseSync(databasePath);
  const templateDatabase = new DatabaseSync(bundledSourceDatabase, { readOnly: true });
  database.exec('PRAGMA busy_timeout=5000');
  try {
    const folderTemplate = templateDatabase.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?')
      .get('11111111-1111-1111-1111-111111111111');
    const movieTemplate = templateDatabase.prepare('SELECT * FROM "BaseItems" WHERE "Id" = ?')
      .get('22222222-2222-2222-2222-222222222222');
    assert.ok(folderTemplate && movieTemplate, 'Prepared reference folder and movie templates are required.');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM "BaseItems" WHERE "Id" LIKE ?').get('80200000-%').count, 0);
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const item of fixture.items) {
        const existing = database.prepare('SELECT "Type" FROM "BaseItems" WHERE "Id" = ?').get(upperId(item.id));
        if (item.type === 'AggregateFolder') {
          assert.equal(existing?.Type, nativeTypes.AggregateFolder);
        }
        upsertBaseItem(database,
          !['Movie', 'Audio', 'AudioBook', 'Book', 'Episode'].includes(item.type) ? folderTemplate : movieTemplate, item);
      }
      if (scenario.menuLifecycle) {
        // Keep one stopped-reference control folder outside every fixture scope.
        // It proves the recorder is observing a prepared native database rather
        // than serializing only fixture rows, while remaining inert for all menu
        // parent and Id filters.
        const anchorId = '33333333-3333-3333-3333-333333333333';
        const aggregateId = upperId(itemByKey.get('aggregate').id);
        const anchor = {
          ...folderTemplate,
          Id: anchorId,
          Type: nativeTypes.Folder,
          ParentId: aggregateId,
          TopParentId: anchorId,
          Name: 'User View Native Reference Anchor',
          CleanName: 'user view native reference anchor',
          SortName: 'user view native reference anchor',
          Path: 'Z:\\UserViewNativeReference\\Anchor',
          IsFolder: 1,
          IsMovie: 0,
          IsSeries: 0,
          MediaType: 'Unknown',
          UnratedType: 'Other',
          PresentationUniqueKey: idKey(anchorId),
          DateCreated: '2026-09-29 12:00:00',
          DateModified: '2026-09-29 12:00:00',
          DateLastSaved: '2026-09-29 12:00:00',
          Data: '{}',
        };
        const columns = Object.keys(anchor);
        database.prepare(`INSERT INTO "BaseItems" (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
          .run(...columns.map(name => anchor[name]));
        database.prepare('INSERT INTO "AncestorIds" ("ItemId", "ParentItemId") VALUES (?, ?)')
          .run(anchorId, aggregateId);
      }
      for (const item of fixture.items) {
        database.prepare('DELETE FROM "AncestorIds" WHERE "ItemId" = ?').run(upperId(item.id));
        for (const ancestorId of item.ancestorIds ?? []) {
          database.prepare('INSERT INTO "AncestorIds" ("ItemId", "ParentItemId") VALUES (?, ?)')
            .run(upperId(item.id), upperId(ancestorId));
        }
      }
      for (const link of fixture.links) {
        database.prepare('INSERT INTO "LinkedChildren" ("ParentId", "SortOrder", "ChildId", "ChildType") VALUES (?, ?, ?, ?)')
          .run(upperId(link.parentId), link.sortOrder, upperId(link.childId), link.childType);
      }
      for (const value of fixture.itemValues) {
        database.prepare('INSERT INTO "ItemValues" ("ItemValueId", "Type", "Value", "CleanValue") VALUES (?, ?, ?, ?)')
          .run(upperId(value.id), value.type, value.value, value.cleanValue);
      }
      for (const link of fixture.itemValueLinks) {
        database.prepare('INSERT INTO "ItemValuesMap" ("ItemId", "ItemValueId") VALUES (?, ?)')
          .run(upperId(itemByKey.get(link.itemKey).id), upperId(valueByKey.get(link.valueKey).id));
      }
      const personByKey = new Map((fixture.people ?? []).map(person => [person.key, person]));
      for (const person of fixture.people ?? []) {
        database.prepare('INSERT INTO "Peoples" ("Id", "Name", "PersonType") VALUES (?, ?, ?)')
          .run(upperId(person.id), person.name, person.personType ?? null);
      }
      for (const [index, link] of (fixture.peopleLinks ?? []).entries()) {
        database.prepare('INSERT INTO "PeopleBaseItemMap" ("ItemId", "PeopleId", "Role", "ListOrder", "SortOrder") VALUES (?, ?, ?, ?, ?)')
          .run(upperId(itemByKey.get(link.itemKey).id), upperId(personByKey.get(link.personKey).id),
            link.role ?? '', link.listOrder ?? index, link.sortOrder ?? null);
      }
      for (const stream of fixture.mediaStreams ?? []) {
        const row = Object.fromEntries(tableDefinition('MediaStreamInfos').columns.map(column => [column.name,
          column.clrType.replace('?', '') === 'bool' ? 0 : null]));
        Object.assign(row, {
          ItemId: upperId(stream.itemId ?? itemByKey.get(stream.itemKey).id),
          StreamIndex: stream.index ?? 0,
          StreamType: typeof (stream.streamType ?? stream.type) === 'string'
            ? ['Audio', 'Video', 'Subtitle'].indexOf(stream.streamType ?? stream.type) : stream.streamType ?? stream.type,
          Language: stream.language ?? null,
          Width: stream.width ?? null,
        });
        const columns = Object.keys(row);
        database.prepare(`INSERT INTO "MediaStreamInfos" (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
          .run(...columns.map(name => row[name]));
      }
      for (const image of fixture.images ?? []) {
        const row = {
          Id: upperId(image.id), ItemId: upperId(itemByKey.get(image.itemKey).id), ImageType: image.imageType,
          Path: path.join(referenceRoot, 'data/metadata/theme-images', image.id + '.png'),
          DateModified: image.dateModified ?? '2026-09-27 12:00:00', Width: image.width ?? 100, Height: image.height ?? 100,
          Blurhash: image.blurHash == null ? null : Buffer.from(image.blurHash),
        };
        const columns = Object.keys(row);
        database.prepare(`INSERT INTO "BaseItemImageInfos" (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
          .run(...columns.map(column => row[column]));
      }
      for (const data of fixture.userData) {
        const item = itemByKey.get(data.itemKey);
        database.prepare(`INSERT INTO "UserData" ("ItemId", "UserId", "CustomDataKey", "AudioStreamIndex", "IsFavorite",
          "LastPlayedDate", "Likes", "PlayCount", "PlaybackPositionTicks", "Played", "Rating", "RetentionDate", "SubtitleStreamIndex")
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          upperId(item.id), upperId(fixture.userId), item.id, null, data.isFavorite ? 1 : 0,
          data.lastPlayedDate, data.likes == null ? null : data.likes ? 1 : 0,
          data.played ? 1 : 0, Number(data.positionTicks), data.played ? 1 : 0, null, null, null);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    templateDatabase.close();
    database.close();
  }
}

async function prepareReference() {
  await mkdir(outputRoot);
  await writeFile(path.join(runRoot, 'input.json'), recordedFixtureBytes, { flag: 'wx' });
  await cp(sourceDatabase, bundledSourceDatabase, { force: false, errorOnExist: true });
  const bundledSourceDatabaseSha256 = sha256(await readFile(bundledSourceDatabase));
  assert.equal(bundledSourceDatabaseSha256, inputHashes.sourceDatabaseSha256,
    'The bundled source database must be an exact copy of the stopped source database.');
  await cp(sourceRoot, referenceRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source).replaceAll('\\', '/');
      return !relative.startsWith('log/') && !/^data\/data\/jellyfin\.db(?:-wal|-shm)?$/u.test(relative);
    },
  });
  await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
  await cp(bundledSourceDatabase, databasePath, { force: false, errorOnExist: true });
  const databaseBeforeSeedSha256 = sha256(await readFile(databasePath));
  assert.equal(databaseBeforeSeedSha256, inputHashes.sourceDatabaseSha256,
    'The working database must begin as an exact source-database copy.');
  await current.prepareClone(referenceRoot, port);
  // Resolve the real UserRoot through HTTP before introducing synthetic rows.
  // Startup scanning must never be allowed to remove the controlled graph.
  const discovery = current.start({ referenceRoot, outputRoot, label: 'discovery', origin });
  let rootResponse, discoveryOutcome;
  try {
    await discovery.ready();
    rootResponse = await request('/Items/Root', { token: current.accessToken });
    assert.equal(rootResponse.status, 200, rootResponse.bodyText);
    assert.equal(rootResponse.bodyJson.Type, 'UserRootFolder');
  } finally {
    discoveryOutcome = await discovery.stop(async () => (await request('/System/Shutdown',
      { method: 'POST', token: current.accessToken })).status, portAvailable);
    assert.equal(discoveryOutcome.cleanShutdown, true);
    assert.equal(discoveryOutcome.code, 0);
    assert.equal(discoveryOutcome.pidGone, true);
    assert.equal(discoveryOutcome.portAvailable, true);
  }
  const stopped = new DatabaseSync(databasePath, { readOnly: true });
  let aggregate;
  try {
    const rows = stopped.prepare('SELECT "Id" FROM "BaseItems" WHERE "Type" = ?').all(nativeTypes.AggregateFolder);
    assert.equal(rows.length, 1);
    aggregate = rows[0];
  } finally { stopped.close(); }
  const bindings = [
    { kind: 'user', fixtureId: fixture.userId, actualId: upperId(current.userId) },
    { kind: 'AggregateFolder', fixtureId: fixture.items.find(item => item.type === 'AggregateFolder').id, actualId: aggregate.Id },
    { kind: 'UserRootFolder', fixtureId: fixture.items.find(item => item.type === 'UserRootFolder').id, actualId: upperId(rootResponse.bodyJson.Id) },
  ];
  const replaceIdentity = value => {
    if (Array.isArray(value)) return value.map(replaceIdentity);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceIdentity(child)]));
    if (typeof value !== 'string') return value;
    for (const binding of bindings) value = value.replaceAll(binding.fixtureId, binding.actualId);
    return value;
  };
  const rootId = fixture.rootId;
  fixture = replaceIdentity(fixture);
  assert.equal(fixture.rootId, rootId, 'Library A remains the query root; only actual instance identities are rebound.');
  indexFixture();
  for (const directory of Object.values(paths)) await mkdir(directory, { recursive: true });
  if (scenario.libraryTypeMarkers) {
    for (const item of fixture.items.filter(item => item.type === 'CollectionFolder')) {
      const type = item.data?.CollectionType;
      if (type == null) continue;
      assert.match(type, /^[a-z]+$/u);
      // CollectionFolder is resolved from the real native .collection marker;
      // a Data member alone is replaced by that resolver at startup.
      await writeFile(path.join(itemPath(item), `${type}.collection`), '', { flag: 'wx' });
    }
  }
  if (scenario.namedMetadataPaths) for (const item of fixture.items.filter(item => item.pathKind === 'named')) {
    await mkdir(itemPath(item), { recursive: true });
  }
  seedDatabase();
  const seededDatabase = new DatabaseSync(databasePath, { readOnly: true });
  let seededUserRoot;
  try {
    const rows = seededDatabase.prepare('SELECT "Id", "Path", "Type" FROM "BaseItems" WHERE "Type" = ?').all(nativeTypes.UserRootFolder);
    const matching = rows.filter(row => path.resolve(row.Path ?? '') === path.resolve(paths.userRoot));
    assert.equal(matching.length, 1, 'The seeded native database must expose exactly one UserRootFolder at the prepared path.');
    seededUserRoot = matching[0];
    assert.equal(idKey(seededUserRoot.Id), idKey(itemByKey.get('userRoot').id),
      'The tracked root ID must bind to the persisted native UserRootFolder discovered by type and path.');
  } finally {
    seededDatabase.close();
  }
  const copyBindings = {
    recorderSha256: sha256(recorderBytes),
    fixtureSha256: sha256(await readFile(path.join(runRoot, 'input.json'))),
    sourceDatabase: { path: 'source-initial.db', sha256: bundledSourceDatabaseSha256 },
    databaseBeforeSeedSha256,
    seededUserRoot,
  };
  assert.equal(copyBindings.recorderSha256, inputHashes.recorderSha256);
  assert.equal(copyBindings.fixtureSha256, inputHashes.fixtureSha256);
  const result = { ...current.preparation, copyBindings, bindings, ...(seedClock ? { seedClock } : {}),
    userRootDiscovery: { route: '/Items/Root', response: rootResponse, process: discoveryOutcome } };
  await writeFile(path.join(runRoot, 'reference-preparation.json'), json(result), { flag: 'wx' });
  return result;
}

function authorization(token) {
  return `MediaBrowser Client="UserViewNativeOracle", Device="Isolated", DeviceId="user-view-native-oracle", Version="1"${token ? `, Token="${token}"` : ''}`;
}

async function request(route, { method = 'GET', token, body } = {}) {
  const response = await fetch(origin + route, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: authorization(token),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const bodyText = await response.text();
  let bodyJson;
  try { bodyJson = bodyText === '' ? null : JSON.parse(bodyText); }
  catch { bodyJson = undefined; }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    bodyText,
    ...(bodyJson === undefined ? {} : { bodyJson }),
  };
}

function startReference() {
  const instance = current.start({ referenceRoot, outputRoot, label: 'reference', origin });
  return { ...instance, command: [dotnetPath, ...instance.arguments] };
}

async function waitForReady(instance) { await instance.ready(); }

async function stopReference(instance, token) {
  const result = await instance.stop(async () => (await request('/System/Shutdown', { method: 'POST', token })).status, portAvailable);
  return { result: { code: result.code, signal: result.signal }, shutdownStatus: result.cleanShutdown ? 204 : null,
    pidGone: result.pidGone, portAvailable: result.portAvailable };
}
function routeFor(endpoint, testCase, userId) {
  if (testCase.action === 'playback-info') return `/Items/${itemByKey.get(testCase.detailKey).id}/PlaybackInfo?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'intros') return `${endpoint === 'legacy' ? '/Users/' + (testCase.introUserId ?? userId) : ''}/Items/${testCase.introItemId ?? itemByKey.get(testCase.detailKey).id}/Intros?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'theme') return `/Items/${testCase.themeItemId ?? itemByKey.get(testCase.detailKey).id}/${testCase.themeRoute}?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'dto-detail') return `${endpoint === 'legacy' ? '/Users/' + userId : ''}/Items/${itemByKey.get(testCase.detailKey).id}?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'named-list' || testCase.action === 'named-detail') return `/${testCase.namedRoute}${testCase.action === 'named-detail' ? '/' + encodeURIComponent(testCase.itemName) : ''}?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (['filters', 'filters2'].includes(testCase.action)) return `/Items/${testCase.action === 'filters' ? 'Filters' : 'Filters2'}?${testCase.query.replaceAll(fixture.userId, userId)}`;
  if (testCase.action === 'studio-name') return `/Studios/${encodeURIComponent(testCase.studioName)}?${testCase.query}`;
  if (endpoint === 'detail') return `/Items/${itemByKey.get(testCase.detailKey).id}`;
  const common = [];
  const omitParentId = testCase.omitScope === true || testCase.omitParentId === true;
  const omitIds = testCase.omitScope === true || testCase.omitIds === true;
  if (!omitParentId) {
    const parentId = testCase.parentKey ? itemByKey.get(testCase.parentKey).id : fixture.rootId;
    common.push(`ParentId=${encodeURIComponent(parentId)}`);
  }
  const recursive = testCase.omitScope === true ? null
    : Object.hasOwn(testCase, 'recursive') ? testCase.recursive : true;
  if (recursive !== null) common.push(`Recursive=${recursive ? 'true' : 'false'}`);
  if (!omitIds) common.push(`Ids=${encodeURIComponent(testCase.scope.map(key => itemByKey.get(key).id).join(','))}`);
  if (!testCase.omitSortBy) common.push(`SortBy=${encodeURIComponent(testCase.sortBy ?? 'SortName')}`);
  common.push(`Fields=${encodeURIComponent(testCase.fields ?? 'SortName')}`, 'EnableImages=false',
    `EnableUserData=${testCase.enableUserData === true ? 'true' : 'false'}`,
    testCase.query.replaceAll(fixture.userId, userId));
  const prefix = (testCase.action === 'studios' ? '/Studios' : endpoint === 'items' ? '/Items' : `/Users/${userId}/Items`)
    + (testCase.action === 'latest' ? '/Latest' : '');
  return `${prefix}?${common.join('&')}`;
}

const databaseSnapshotTables = [
  'baseItems', 'ancestorIds', 'linkedChildren', 'itemValues', 'itemValueLinks', 'userData',
  'mediaStreamInfos', 'peoples', 'peopleBaseItemMap', 'baseItemImageInfos', 'baseItemProviders',
  'baseItemMetadataFields', 'foreignKeyCheck',
];
const filesystemSnapshotDomains = ['userViews', 'metadata', 'libraries', 'collections'];

function snapshotShapeValid(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.database || !snapshot.filesystem) return false;
  if (!databaseSnapshotTables.every(name => Array.isArray(snapshot.database[name]))) return false;
  return filesystemSnapshotDomains.every(name => {
    const domain = snapshot.filesystem[name];
    return domain && typeof domain.exists === 'boolean' && Array.isArray(domain.entries)
      && domain.entries.every(entry => typeof entry?.path === 'string'
        && ['directory', 'file'].includes(entry.type));
  });
}

function expectedSetupRecords() {
  const expected = [{
    kind: 'server-configuration',
    values: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
  }];
  if (fixture.warmUserViews) for (const [field, kind] of [
    ['configuration', 'warm-user-configuration'], ['policy', 'warm-policy'],
  ]) expected.push({ kind, values: fixture.warmUserViews[field] });
  for (const testCase of fixture.cases) {
    if (testCase.serverConfiguration) expected.push({
      kind: 'case-server-configuration', name: testCase.name, values: testCase.serverConfiguration,
    });
    if (testCase.configuration) expected.push({
      kind: 'user-configuration', name: testCase.name, values: testCase.configuration,
    });
    if (testCase.policy) expected.push({ kind: 'policy', name: testCase.name, values: testCase.policy });
  }
  return expected;
}

function responseContractFailures(records) {
  const failures = [];
  const expected = fixture.cases.flatMap(testCase => (testCase.endpoints ?? ['items', 'legacy'])
    .map(endpoint => ({ testCase, endpoint })));
  if (records.length !== expected.length) failures.push(`response count ${records.length}, expected ${expected.length}`);
  for (let index = 0; index < Math.max(records.length, expected.length); index++) {
    const record = records[index], contract = expected[index];
    if (!record || !contract) {
      failures.push(`response[${index}] is ${record ? 'unexpected' : 'missing'}`);
      continue;
    }
    const { testCase, endpoint } = contract;
    const label = `${testCase.name}:${endpoint}`;
    if (record.name !== testCase.name || record.endpoint !== endpoint
      || record.query !== testCase.query || stable(record.scope) !== stable(testCase.scope)) {
      failures.push(`${label} identity/order mismatch`);
    }
    const expectedStatus = testCase.expectedStatus ?? 200;
    if (record.response?.status !== expectedStatus) {
      failures.push(`${label} status ${record.response?.status}, expected ${expectedStatus}`);
      continue;
    }
    const response = record.response;
    if (typeof response.bodyText !== 'string') {
      failures.push(`${label} has no complete text body`);
      continue;
    }
    if (expectedStatus === 200) {
      const body = response.bodyJson;
      if (scenario.responseFacets) {
        const fields = testCase.action === 'filters' ? ['Genres', 'Tags', 'OfficialRatings', 'Years']
          : ['Genres', 'Tags', 'AudioLanguages', 'SubtitleLanguages'];
        if (response.contentType !== 'application/json; charset=utf-8' || !body
          || stable(Object.keys(body).sort()) !== stable(fields.sort())
          || fields.some(field => !Array.isArray(body[field]))) failures.push(`${label} facet JSON shape is invalid`);
      } else if (testCase.action === 'theme') {
        const themes = testCase.themeRoute === 'ThemeMedia'
          ? [body?.ThemeSongsResult, body?.ThemeVideosResult, body?.SoundtrackSongsResult] : [body];
        if (response.contentType !== 'application/json; charset=utf-8' || themes.some(theme => !theme
          || !Array.isArray(theme.Items) || theme.TotalRecordCount !== theme.Items.length || theme.StartIndex !== 0
          || typeof theme.OwnerId !== 'string' || theme.Items.some(item => typeof item.Id !== 'string' || typeof item.Type !== 'string'))) {
          failures.push(`${label} successful theme JSON shape is invalid`);
        }
      } else if (testCase.action === 'playback-info') {
        if (response.contentType !== 'application/json; charset=utf-8' || !body || !Array.isArray(body.MediaSources)
          || body.MediaSources.some(source => typeof source.Id !== 'string' || typeof source.Protocol !== 'string')
          || (body.MediaSources.length > 0 ? !/^[a-f0-9]{32}$/u.test(body.PlaySessionId ?? '')
            : body.ErrorCode !== 'NoCompatibleStream' || body.PlaySessionId != null)) failures.push(`${label} playback info JSON shape is invalid`);
      } else if (testCase.action === 'named-detail' || testCase.action === 'dto-detail') {
        if (response.contentType !== 'application/json; charset=utf-8' || !body
          || typeof body.Id !== 'string' || body.Type !== testCase.itemType) failures.push(`${label} named detail JSON shape is invalid`);
      } else if (testCase.action === 'studio-name') {
        if (response.contentType !== 'application/json; charset=utf-8' || !body
          || typeof body.Id !== 'string' || body.Type !== 'Studio') failures.push(`${label} studio JSON shape is invalid`);
      } else if (scenario.responseArray) {
        if (response.contentType !== 'application/json; charset=utf-8' || !Array.isArray(body)
          || body.some(item => !item || typeof item.Id !== 'string' || typeof item.Type !== 'string')) {
          failures.push(`${label} successful array JSON shape is invalid`);
        }
      } else if (response.contentType !== 'application/json; charset=utf-8'
        || !body || typeof body !== 'object' || Array.isArray(body)
        || stable(Object.keys(body).sort()) !== stable(['Items', 'StartIndex', 'TotalRecordCount'].sort())
        || !Array.isArray(body.Items) || !Number.isInteger(body.StartIndex)
        || body.StartIndex < 0 && !['studios-http', 'named-items-http'].includes(scenarioName)
        || !Number.isInteger(body.TotalRecordCount) || body.TotalRecordCount < 0) {
        failures.push(`${label} successful list JSON shape is invalid`);
      }
    } else if (expectedStatus === 404) {
      if (response.contentType !== 'application/json; charset=utf-8' || response.bodyJson?.status !== 404) {
        failures.push(`${label} not-found JSON shape is invalid`);
      }
    } else if (expectedStatus === 401) {
      if (response.contentType !== 'application/json; charset=utf-8'
        || typeof response.bodyJson !== 'string' || response.bodyJson.length === 0) {
        failures.push(`${label} authorization error JSON shape is invalid`);
      }
    } else if (expectedStatus === 400 && testCase.bindingError) {
      if (response.contentType !== 'application/json; charset=utf-8'
        || response.bodyJson?.status !== 400 || !response.bodyJson.errors) {
        failures.push(`${label} native binding-error shape is invalid`);
      }
    } else if ([400, 500].includes(expectedStatus)) {
      if (response.contentType !== 'text/plain' || Object.hasOwn(response, 'bodyJson')
        || response.bodyText !== 'Error processing request.') {
        failures.push(`${label} native request-error shape is invalid`);
      }
    } else {
      failures.push(`${label} has no declared response-shape contract for ${expectedStatus}`);
    }
  }
  return failures;
}

function captureContract(records, setupRecords, caseStages, stages) {
  const responseFailures = responseContractFailures(records);
  const expectedStages = fixture.cases.flatMap(testCase => (testCase.endpoints ?? ['items', 'legacy'])
    .map(endpoint => [testCase.name, endpoint]));
  const endpointsComplete = responseFailures.every(message => !message.includes('identity/order')
    && !message.startsWith('response count') && !message.includes('missing') && !message.includes('unexpected'));
  const expectedSetup = expectedSetupRecords();
  const setupContractValid = setupRecords.length === expectedSetup.length
    && setupRecords.every((record, index) => record.status === 204
      && record.kind === expectedSetup[index].kind && record.name === expectedSetup[index].name
      && stable(record.values) === stable(expectedSetup[index].values));
  const caseStagesComplete = caseStages.length === expectedStages.length
    && caseStages.every((stage, index) => stable([stage.name, stage.endpoint]) === stable(expectedStages[index]));
  const topStages = [stages.before, stages.afterReads, stages.afterShutdown];
  const mutableScenario = scenario.menuLifecycle || scenario.namedLifecycle;
  const caseSnapshotStates = mutableScenario
    ? caseStages.flatMap(stage => [stage.before, stage.after]) : [];
  const allSnapshotStates = [...topStages, ...caseSnapshotStates];
  const stageStructureValid = topStages.every(snapshotShapeValid)
    && (!mutableScenario || caseSnapshotStates.every(snapshotShapeValid));
  const foreignKeysValid = stageStructureValid
    && allSnapshotStates.every(stage => stage.database.foreignKeyCheck.length === 0);
  const immutableScenario = !mutableScenario;
  const stateContractValid = stageStructureValid && (immutableScenario
    ? stable(stages.before) === stable(stages.afterReads) && stable(stages.before) === stable(stages.afterShutdown)
    : stable(stages.afterReads) === stable(stages.afterShutdown));

  let menuLifecycleValid = !scenario.menuLifecycle;
  if (scenario.menuLifecycle && stageStructureValid && caseStagesComplete && caseStages.length > 0) {
    // Background metadata refreshes can legitimately settle between an
    // endpoint's after snapshot and the next endpoint's before snapshot.  Bind
    // the endpoints to the outer lifecycle and validate every observed state,
    // without pretending those unobserved gaps are atomic.
    const endpointsBounded = stable(caseStages[0].before) === stable(stages.before)
      && stable(caseStages.at(-1).after) === stable(stages.afterReads);
    const originalIds = new Set(stages.before.database.baseItems.map(row => idKey(row.Id)));
    const statePreservesContract = state => {
      const originalRowsUnchanged = stable(state.database.baseItems
        .filter(row => originalIds.has(idKey(row.Id)))) === stable(stages.before.database.baseItems);
      const newRows = state.database.baseItems.filter(row => !originalIds.has(idKey(row.Id)));
      const dynamicViewsValid = newRows.length <= scenario.expectedDynamicMenuViews
        && newRows.every(row => row.Type === nativeTypes.UserView && (() => {
          try {
            const data = JSON.parse(row.Data);
            return !data.UserId || idKey(data.UserId) === idKey(fixture.userId);
          }
          catch { return false; }
        })());
      const otherTablesUnchanged = databaseSnapshotTables
        .filter(name => !['baseItems', 'foreignKeyCheck'].includes(name))
        .every(name => stable(stages.before.database[name]) === stable(state.database[name]));
      const inertFilesystemUnchanged = ['userViews', 'libraries', 'collections']
        .every(name => stable(stages.before.filesystem[name]) === stable(state.filesystem[name]));
      return originalRowsUnchanged && dynamicViewsValid && otherTablesUnchanged && inertFilesystemUnchanged;
    };
    const finalNewRows = stages.afterReads.database.baseItems.filter(row => !originalIds.has(idKey(row.Id)));
    menuLifecycleValid = endpointsBounded && finalNewRows.length === scenario.expectedDynamicMenuViews
      && allSnapshotStates.every(statePreservesContract);
  }
  let namedLifecycleValid = !scenario.namedLifecycle;
  if (scenario.namedLifecycle && stageStructureValid && caseStagesComplete && caseStages.length > 0) {
    const original = stages.before.database.baseItems;
    const originalIds = new Set(original.map(row => idKey(row.Id)));
    const names = new Set(fixture.cases.filter(value => !value.bindingError).map(value => value.itemName));
    const types = new Set(['MediaBrowser.Controller.Entities.Genre', 'MediaBrowser.Controller.Entities.Studio',
      'MediaBrowser.Controller.Entities.Audio.MusicGenre', 'MediaBrowser.Controller.Entities.Audio.MusicArtist']);
    const returned = new Set(records.filter(record => record.response.status === 200)
      .map(record => idKey(record.response.bodyJson?.Id)).filter(id => id && !/^0{32}$/u.test(id)));
    namedLifecycleValid = stable(caseStages[0].before) === stable(stages.before)
      && stable(caseStages.at(-1).after) === stable(stages.afterReads)
      && allSnapshotStates.every(state => {
        const rows = state.database.baseItems;
        return stable(rows.filter(row => originalIds.has(idKey(row.Id)))) === stable(original)
          && rows.filter(row => !originalIds.has(idKey(row.Id)))
            .every(row => types.has(row.Type) && names.has(row.Name) && returned.has(idKey(row.Id)));
      })
      && stages.afterReads.database.baseItems.some(row => !originalIds.has(idKey(row.Id)));
  }
  return {
    endpointsComplete,
    responseContractValid: responseFailures.length === 0,
    setupContractValid,
    caseStagesComplete,
    stageStructureValid,
    foreignKeysValid,
    stateContractValid,
    menuLifecycleValid,
    namedLifecycleValid,
    responseFailures: responseFailures.slice(0, 20),
  };
}

assert.equal(await portAvailable(), true, 'Loopback port is occupied.');
const inputHashes = {
  recorderSha256: sha256(recorderBytes),
  fixtureSha256: sha256(recordedFixtureBytes),
  sourceDatabaseSha256: sha256(await readFile(sourceDatabase)),
  dllSha256: sha256(await readFile(jellyfinDll)),
  dotnetSha256: sha256(await readFile(dotnetPath)),
  ffmpegSha256: sha256(await readFile(ffmpegPath)),
};
const expectedMatrixCount = fixture.cases.reduce((count, item) => count + (item.endpoints?.length ?? 2), 0);
assert.equal(expectedMatrixCount, scenario.expectedCases, 'Fixture endpoint matrix changed.');

const preparation = await prepareReference();
const stages = {}, records = [], setupRecords = [], caseStages = [];
let instance, userToken = current.accessToken, apiKey, outcomeError;
let lifecycle = { result: { code: null, signal: null }, shutdownStatus: null, pidGone: false, portAvailable: false };
try {
  instance = startReference();
  await waitForReady(instance);
  const login = await request('/Users/Me', { token: userToken });
  assert.equal(login.status, 200, login.bodyText);
  preparation.actualUserName = login.bodyJson.Name;
  const userId = login.bodyJson.Id;
  assert.equal(idKey(userId), idKey(fixture.userId));
  const appName = scenarioName + ' HTTP Oracle';
  const createKey = await request('/Auth/Keys?app=' + encodeURIComponent(appName), { method: 'POST', token: userToken });
  assert.equal(createKey.status, 204, createKey.bodyText);
  const keys = await request('/Auth/Keys', { token: userToken });
  assert.equal(keys.status, 200, keys.bodyText);
  apiKey = keys.bodyJson.Items.find(item => item.AppName === appName)?.AccessToken;
  assert.ok(apiKey);
  privateOutput.addSecret(apiKey);
  // Demotion scenarios retain a separate administrator, just as the historical seed did.
  const control = await request('/Users/New', { method: 'POST', token: apiKey, body: { Name: 'OracleControlAdmin' } });
  assert.equal(control.status, 200, control.bodyText);
  const controlPolicy = await request('/Users/' + control.bodyJson.Id + '/Policy', {
    method: 'POST', token: apiKey, body: { ...control.bodyJson.Policy, IsAdministrator: true },
  });
  assert.equal(controlPolicy.status, 204, controlPolicy.bodyText);
  const serverConfiguration = await request('/System/Configuration', { token: apiKey });
  assert.equal(serverConfiguration.status, 200, serverConfiguration.bodyText);
  const stableServerConfiguration = { ...serverConfiguration.bodyJson,
    EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false };
  const configure = await request('/System/Configuration', { method: 'POST', token: apiKey, body: stableServerConfiguration });
  assert.equal(configure.status, 204, configure.bodyText);
  setupRecords.push({ kind: 'server-configuration', status: configure.status,
    values: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false } });
  if (fixture.warmUserViews) {
    for (const [field, suffix, kind] of [['configuration', 'Configuration', 'warm-user-configuration'],
      ['policy', 'Policy', 'warm-policy']]) {
      const values = fixture.warmUserViews[field];
      const update = await request('/Users/' + userId + '/' + suffix, {
        method: 'POST', token: apiKey, body: { ...login.bodyJson[suffix], ...values },
      });
      assert.equal(update.status, 204, update.bodyText);
      setupRecords.push({ kind, values, status: update.status });
    }
    // GetUserViews creates persistent grouped views on its first use. Keep
    // that declared setup observation, then assert steady-state facet reads.
    const route = '/UserViews?UserId=' + userId + '&IncludeHidden=true';
    const response = await request(route, { token: userToken });
    assert.equal(response.status, 200, response.bodyText);
    assert.ok(Array.isArray(response.bodyJson?.Items));
    preparation.warmUserViews = { route, response };
  }
  stages.before = { database: databaseSnapshot(), filesystem: await filesystemSnapshot() };

  for (const testCase of fixture.cases) {
    if (testCase.serverConfiguration) {
      const update = await request('/System/Configuration', {
        method: 'POST', token: apiKey, body: { ...stableServerConfiguration, ...testCase.serverConfiguration },
      });
      assert.equal(update.status, 204, testCase.name + ': ' + update.bodyText);
      setupRecords.push({ kind: 'case-server-configuration', name: testCase.name,
        values: testCase.serverConfiguration, status: update.status });
    }
    for (const [field, suffix, kind] of [['configuration', 'Configuration', 'user-configuration'], ['policy', 'Policy', 'policy']]) {
      if (!testCase[field]) continue;
      const update = await request('/Users/' + userId + '/' + suffix, {
        method: 'POST', token: apiKey, body: { ...login.bodyJson[suffix], ...testCase[field] },
      });
      assert.equal(update.status, 204, testCase.name + ': ' + update.bodyText);
      setupRecords.push({ kind, name: testCase.name, values: testCase[field], status: update.status });
    }
    for (const endpoint of testCase.endpoints ?? ['items', 'legacy']) {
      const before = scenario.menuLifecycle || scenario.namedLifecycle ? { database: databaseSnapshot(), filesystem: await filesystemSnapshot() } : null;
      const route = routeFor(endpoint, testCase, userId);
      const response = await request(route, { token: testCase.auth === 'apiKey' ? apiKey : userToken });
      records.push({ name: testCase.name, query: testCase.query, scope: testCase.scope, endpoint, route, response });
      caseStages.push(scenario.menuLifecycle || scenario.namedLifecycle ? { name: testCase.name, endpoint, before,
        after: { database: databaseSnapshot(), filesystem: await filesystemSnapshot() } } : { name: testCase.name, endpoint });
      if (records.length % 50 === 0) console.log(JSON.stringify({ scenario: scenarioName, recorded: records.length, total: expectedMatrixCount }));
    }
  }
  stages.afterReads = { database: databaseSnapshot(), filesystem: await filesystemSnapshot() };
} catch (error) { outcomeError = error; }
finally {
  if (instance) lifecycle = await stopReference(instance, apiKey ?? userToken);
  try { stages.afterShutdown = { database: databaseSnapshot(), filesystem: await filesystemSnapshot() }; }
  catch (error) { outcomeError ??= error; }
}

await writeFile(path.join(outputRoot, 'native-http.json'), json({ origin, records }), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'setup-http.json'), json({ origin, records: setupRecords }), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'stages.json'), json(stages), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'case-stages.json'), json(caseStages), { flag: 'wx' });
const contract = captureContract(records, setupRecords, caseStages, stages);
const checks = Object.fromEntries(Object.entries(contract).filter(([, value]) => typeof value === 'boolean'));
await current.finish();
const passed = !outcomeError && Object.values(checks).every(Boolean)
  && lifecycle.shutdownStatus === 204 && lifecycle.result.code === 0 && lifecycle.result.signal === null
  && lifecycle.pidGone && lifecycle.portAvailable;
const summary = { passed, candidateVerified: false, cases: records.length, snapshots: caseStages.length,
  processResult: lifecycle.result, portAvailable: lifecycle.portAvailable, pidGone: lifecycle.pidGone,
  cleanShutdown: lifecycle.shutdownStatus === 204, ...inputHashes, checks, contractFailures: contract.responseFailures,
  error: outcomeError ? { name: outcomeError.name, message: outcomeError.message, stack: outcomeError.stack } : null };
await writeFile(path.join(outputRoot, 'summary.json'), json(summary), { flag: 'wx' });
await writeFile(path.join(outputRoot, 'provenance.json'), json({ scenario: scenarioName, preparation,
  historicalEvidenceReplaced: false, inputs: inputHashes, artifacts: [] }), { flag: 'wx' });
if (!passed) throw new Error('Native ' + scenarioName + ' recording failed: ' + JSON.stringify(summary.error ?? summary.checks));
return { outputRoot: publicOutputRoot, summary };
} catch (error) { failure = error; }
finally { await privateOutput.publishAndClose(); }
throw privateOutput.publicError(failure);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await recordUserViewHttp(...process.argv.slice(2));
}
