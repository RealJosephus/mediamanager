// Record the UserView query matrices against a prepared, stopped Jellyfin instance.
// The recorder never reads candidate expectations; all wire and persistence evidence
// comes from the native process and its copied SQLite database.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { tableDefinition } from '../../src/database/model.js';
import { assertValidationOutputChild, validationExecutable, validationPath } from '../validation/paths.js';
import { captureFilterReferencePreparation } from './filter-reference-inputs.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scenarios = {
  'user-root-visibility': {
    evidenceName: 'user-root-visibility-native-v1',
    fixture: 'tests/library/fixtures/user-root-visibility/input.json',
    runName: 'native-run-v4',
    expectedCases: 256,
    queryInputExtraLf: false,
    menuLifecycle: false,
  },
  'user-view-menu': {
    evidenceName: 'user-view-menu-native-v1',
    fixture: 'tests/library/fixtures/user-view-menu/input.json',
    runName: 'native-run',
    expectedCases: 196,
    expectedDynamicMenuViews: 28,
    queryInputExtraLf: false,
    menuLifecycle: true,
  },
  'user-view-query': {
    evidenceName: 'user-view-query-native-v1',
    fixture: 'tests/library/fixtures/user-view-query/input.json',
    runName: 'native-run-v4',
    expectedCases: 260,
    queryInputExtraLf: true,
    menuLifecycle: false,
  },
};

const [scenarioName, outputArgument, portArgument] = process.argv.slice(2);
const scenario = scenarios[scenarioName];
if (!scenario || !outputArgument || !portArgument) {
  throw new Error('Usage: node tools/compat/record-user-view-http.js <user-root-visibility|user-view-menu|user-view-query> <new-evidence-root> <loopback-port>');
}
const outputRoot = assertValidationOutputChild(path.resolve(repoRoot, outputArgument));
if (existsSync(outputRoot)) {
  throw new Error('Evidence root must be a new child of the configured validation output root.');
}
assert.equal(path.basename(outputRoot), scenario.evidenceName,
  `Evidence root must be named ${scenario.evidenceName}.`);
const port = Number(portArgument);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback port.');

const runRoot = path.join(outputRoot, scenario.runName);
const referenceRoot = path.join(runRoot, 'reference');
const databasePath = path.join(referenceRoot, 'data/data/jellyfin.db');
const bundledSourceDatabase = path.join(outputRoot, 'source-initial.db');
const bundledSourceBootstrap = path.join(outputRoot, 'source-bootstrap.json');
const bundledSourceBootstrapLog = path.join(outputRoot, 'source-bootstrap.log');
const sourceRoot = validationPath(path.join(repoRoot, '.agent-docs/evidence/core-flow-20260926/reference'));
const sourceDatabase = validationPath(path.join(repoRoot, '.agent-docs/evidence/core-flow-20260926/initial.db'));
const fixturePath = path.join(repoRoot, scenario.fixture);
const jellyfinDll = validationPath(path.join(repoRoot,
  '.agent-docs/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/jellyfin.dll'));
const dotnetPath = validationExecutable('dotnet');
const ffmpegPath = validationExecutable('ffmpeg');
const origin = `http://127.0.0.1:${port}`;
const password = 'isolated-core-flow-password';
const recorderPath = fileURLToPath(import.meta.url);
const recorderBytes = await readFile(recorderPath);
const sourceFixtureBytes = await readFile(fixturePath);
const recordedFixtureBytes = scenario.queryInputExtraLf
  ? Buffer.concat([sourceFixtureBytes, Buffer.from('\n')]) : sourceFixtureBytes;
const fixture = JSON.parse(sourceFixtureBytes.toString('utf8'));
const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const upperId = value => String(value).toUpperCase();
const itemByKey = new Map(fixture.items.map(item => [item.key, item]));
const itemById = new Map(fixture.items.map(item => [idKey(item.id), item]));
const valueByKey = new Map(fixture.itemValues.map(item => [item.key, item]));
const fixtureItemIds = new Set(fixture.items.map(item => idKey(item.id)));
const visibleFixtureItemIds = new Set(fixture.items.filter(item => item.type !== 'AggregateFolder').map(item => idKey(item.id)));
const fixtureValueIds = new Set(fixture.itemValues.map(item => idKey(item.id)));
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
  Movie: 'MediaBrowser.Controller.Entities.Movies.Movie',
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

function itemPath(item) {
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

async function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else files.push(target);
  }
  return files;
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
        entries.push({ path: path.relative(directory, target).replaceAll('\\', '/'),
          type: entry.isDirectory() ? 'directory' : 'file' });
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
    const baseItems = scenario.menuLifecycle
      ? allBaseItems
      : allBaseItems.filter(row => visibleFixtureItemIds.has(idKey(row.Id)) || dynamicUserView(row));
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
  const isFolder = !['Movie', 'Audio', 'AudioBook', 'Book', 'Episode'].includes(item.type);
  const row = {
    ...(existing ?? template),
    Id: upperId(item.id),
    Type: nativeTypes[item.type],
    ParentId: item.parentId == null ? null : upperId(item.parentId),
    TopParentId: item.topParentId == null ? null : upperId(item.topParentId),
    Name: item.name,
    CleanName: item.cleanName ?? item.name.toLowerCase(),
    SortName: item.sortName,
    Path: itemPath(item),
    IsFolder: isFolder ? 1 : 0,
    IsMovie: item.type === 'Movie' ? 1 : 0,
    IsSeries: item.type === 'Series' ? 1 : 0,
    Overview: item.overview ?? null,
    Genres: item.genresText ?? null,
    PrimaryVersionId: item.primaryVersionId == null ? null : upperId(item.primaryVersionId),
    IsVirtualItem: item.isVirtualItem ? 1 : 0,
    RunTimeTicks: item.runTimeTicks == null ? null : Number(item.runTimeTicks),
    IndexNumber: item.indexNumber ?? null,
    ParentIndexNumber: item.parentIndexNumber ?? null,
    SeriesId: item.seriesId == null ? null : upperId(item.seriesId),
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
    PresentationUniqueKey: item.presentationUniqueKey ?? idKey(item.id),
    PremiereDate: item.premiereDate ?? null,
    ProductionYear: item.productionYear ?? null,
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
  const database = new DatabaseSync(databasePath);
  const templateDatabase = new DatabaseSync(sourceDatabase, { readOnly: true });
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
      for (const data of fixture.userData) {
        const item = itemByKey.get(data.itemKey);
        database.prepare(`INSERT INTO "UserData" ("ItemId", "UserId", "CustomDataKey", "AudioStreamIndex", "IsFavorite",
          "LastPlayedDate", "Likes", "PlayCount", "PlaybackPositionTicks", "Played", "Rating", "RetentionDate", "SubtitleStreamIndex")
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          upperId(item.id), upperId(fixture.userId), item.id, null, data.isFavorite ? 1 : 0,
          data.lastPlayedDate, null, data.played ? 1 : 0, Number(data.positionTicks), data.played ? 1 : 0, null, null, null);
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
  const preparation = await captureFilterReferencePreparation({
    sourceRoot,
    sourceDatabase,
    repoRoot,
    fixtureUserId: fixture.userId,
  });
  await mkdir(outputRoot);
  await mkdir(runRoot);
  await writeFile(path.join(outputRoot, 'record-native.mjs'), recorderBytes, { flag: 'wx' });
  await writeFile(path.join(runRoot, 'input.json'), recordedFixtureBytes, { flag: 'wx' });
  await cp(sourceDatabase, bundledSourceDatabase, { force: false, errorOnExist: true });
  await cp(path.join(sourceRoot, 'bootstrap.json'), bundledSourceBootstrap, { force: false, errorOnExist: true });
  await cp(path.join(sourceRoot, 'bootstrap.log'), bundledSourceBootstrapLog, { force: false, errorOnExist: true });
  const bundledSourceDatabaseSha256 = sha256(await readFile(bundledSourceDatabase));
  assert.equal(bundledSourceDatabaseSha256, preparation.sourceDatabaseSha256,
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
  assert.equal(databaseBeforeSeedSha256, preparation.sourceDatabaseSha256,
    'The working database must begin as an exact source-database copy.');
  const sourceForms = [sourceRoot, sourceRoot.replaceAll('\\', '/'), sourceRoot.replaceAll('\\', '\\\\')];
  for (const file of await walk(referenceRoot)) {
    if (!/\.(?:json|xml)$/u.test(file)) continue;
    let content = await readFile(file, 'utf8');
    for (const source of sourceForms) content = content.replaceAll(source, referenceRoot);
    if (path.basename(file).toLowerCase() === 'network.xml') {
      content = content.replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/gu,
        (_match, name) => `<${name}>${port}</${name}>`);
      content = content.replace(/<AutoDiscovery>true<\/AutoDiscovery>/gu, '<AutoDiscovery>false</AutoDiscovery>');
    }
    await writeFile(file, content);
  }
  for (const directory of Object.values(paths)) await mkdir(directory, { recursive: true });
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
    recorderSha256: sha256(await readFile(path.join(outputRoot, 'record-native.mjs'))),
    fixtureSha256: sha256(await readFile(path.join(runRoot, 'input.json'))),
    sourceDatabase: { path: 'source-initial.db', sha256: bundledSourceDatabaseSha256 },
    sourcePreparation: {
      bootstrap: { path: 'source-bootstrap.json', sha256: sha256(await readFile(bundledSourceBootstrap)) },
      log: { path: 'source-bootstrap.log', sha256: sha256(await readFile(bundledSourceBootstrapLog)) },
    },
    databaseBeforeSeedSha256,
    seededUserRoot,
  };
  assert.equal(copyBindings.recorderSha256, inputHashes.recorderSha256);
  assert.equal(copyBindings.fixtureSha256, inputHashes.fixtureSha256);
  assert.equal(copyBindings.sourcePreparation.bootstrap.sha256, preparation.inputs[0].sha256);
  assert.equal(copyBindings.sourcePreparation.log.sha256, preparation.inputs[5].sha256);
  const result = { ...preparation, copyBindings };
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
  const stdoutDescriptor = openSync(path.join(runRoot, 'reference-stdout.log'), 'wx');
  const stderrDescriptor = openSync(path.join(runRoot, 'reference-stderr.log'), 'wx');
  const args = [jellyfinDll,
    '--datadir', path.join(referenceRoot, 'data'), '--configdir', path.join(referenceRoot, 'config'),
    '--cachedir', path.join(referenceRoot, 'cache'), '--logdir', path.join(referenceRoot, 'log'),
    '--ffmpeg', ffmpegPath, '--nowebclient'];
  const child = spawn(dotnetPath, args, { cwd: repoRoot, windowsHide: true, stdio: ['ignore', stdoutDescriptor, stderrDescriptor] });
  let spawnError;
  const completion = new Promise(resolve => {
    child.once('error', error => {
      spawnError = error;
      resolve({ code: null, signal: null, error: { name: error.name, message: error.message } });
    });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, completion, command: [dotnetPath, ...args],
    get spawnError() { return spawnError; }, stdoutDescriptor, stderrDescriptor };
}

async function waitForReady(instance) {
  let consecutiveSuccesses = 0;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (instance.spawnError) throw instance.spawnError;
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
      throw new Error(`Frozen reference exited before readiness: ${instance.child.exitCode}/${instance.child.signalCode}.`);
    }
    try {
      const startupLog = await readFile(path.join(runRoot, 'reference-stdout.log'), 'utf8');
      const response = await fetch(origin + '/System/Info/Public', { signal: AbortSignal.timeout(1_000) });
      consecutiveSuccesses = response.ok && startupLog.includes('Main: Startup complete')
        ? consecutiveSuccesses + 1 : 0;
      await response.body?.cancel();
      if (consecutiveSuccesses >= 3) return;
    } catch {
      consecutiveSuccesses = 0;
    }
    await delay(500);
  }
  throw new Error('Frozen reference did not become ready within 60 seconds.');
}

function processIsGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

async function completionWithin(completion, milliseconds) {
  let timer;
  try {
    return await Promise.race([completion, new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCondition(operation, milliseconds) {
  const deadline = Date.now() + milliseconds;
  do {
    if (await operation()) return true;
    await delay(100);
  } while (Date.now() < deadline);
  return await operation();
}

async function stopReference(instance, token) {
  let shutdownStatus = null;
  let result;
  if (instance.child.exitCode === null && instance.child.signalCode === null && token) {
    try { shutdownStatus = (await request('/System/Shutdown', { method: 'POST', token })).status; }
    catch { shutdownStatus = null; }
  }
  if (instance.child.exitCode === null && instance.child.signalCode === null) {
    result = await completionWithin(instance.completion, 20_000);
    if (result === null) {
      instance.child.kill();
      result = await completionWithin(instance.completion, 10_000);
    }
    if (result === null && instance.child.pid) {
      spawnSync('taskkill', ['/PID', String(instance.child.pid), '/T', '/F'], {
        cwd: repoRoot, windowsHide: true, encoding: 'utf8', timeout: 10_000,
      });
      result = await completionWithin(instance.completion, 10_000);
    }
  } else {
    result = await instance.completion;
  }
  for (const descriptor of [instance.stdoutDescriptor, instance.stderrDescriptor]) {
    try { closeSync(descriptor); } catch { /* The process already released it. */ }
  }
  const pidGone = await waitForCondition(() => processIsGone(instance.child.pid), 10_000);
  const released = await waitForCondition(portAvailable, 10_000);
  return {
    result: result ?? { code: null, signal: null },
    shutdownStatus,
    pidGone,
    portAvailable: released,
  };
}

function routeFor(endpoint, testCase, userId) {
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
  const prefix = endpoint === 'items' ? '/Items' : `/Users/${userId}/Items`;
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
      if (response.contentType !== 'application/json; charset=utf-8'
        || !body || typeof body !== 'object' || Array.isArray(body)
        || stable(Object.keys(body).sort()) !== stable(['Items', 'StartIndex', 'TotalRecordCount'].sort())
        || !Array.isArray(body.Items) || !Number.isInteger(body.StartIndex) || body.StartIndex < 0
        || !Number.isInteger(body.TotalRecordCount) || body.TotalRecordCount < 0) {
        failures.push(`${label} successful list JSON shape is invalid`);
      }
    } else if (expectedStatus === 401) {
      if (response.contentType !== 'application/json; charset=utf-8'
        || typeof response.bodyJson !== 'string' || response.bodyJson.length === 0) {
        failures.push(`${label} authorization error JSON shape is invalid`);
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
  const caseSnapshotStates = scenario.menuLifecycle
    ? caseStages.flatMap(stage => [stage.before, stage.after]) : [];
  const allSnapshotStates = [...topStages, ...caseSnapshotStates];
  const stageStructureValid = topStages.every(snapshotShapeValid)
    && (!scenario.menuLifecycle || caseSnapshotStates.every(snapshotShapeValid));
  const foreignKeysValid = stageStructureValid
    && allSnapshotStates.every(stage => stage.database.foreignKeyCheck.length === 0);
  const immutableScenario = !scenario.menuLifecycle;
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
  return {
    endpointsComplete,
    responseContractValid: responseFailures.length === 0,
    setupContractValid,
    caseStagesComplete,
    stageStructureValid,
    foreignKeysValid,
    stateContractValid,
    menuLifecycleValid,
    responseFailures: responseFailures.slice(0, 20),
  };
}

assert.equal(await portAvailable(), true, 'Loopback port is occupied.');
const inputHashes = {
  recorderSha256: sha256(recorderBytes),
  fixtureSha256: sha256(recordedFixtureBytes),
  trackedFixtureSha256: sha256(sourceFixtureBytes),
  sourceDatabaseSha256: sha256(await readFile(sourceDatabase)),
  dllSha256: sha256(await readFile(jellyfinDll)),
  dotnetSha256: sha256(await readFile(dotnetPath)),
  ffmpegSha256: sha256(await readFile(ffmpegPath)),
  sourceBootstrapSha256: sha256(await readFile(path.join(sourceRoot, 'bootstrap.json'))),
  sourceBootstrapLogSha256: sha256(await readFile(path.join(sourceRoot, 'bootstrap.log'))),
};
const expectedMatrixCount = fixture.cases.reduce((count, item) => count + (item.endpoints?.length ?? 2), 0);
assert.equal(expectedMatrixCount, scenario.expectedCases, 'Fixture endpoint matrix changed.');

let preparation;
try {
  preparation = await prepareReference();
} catch (error) {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, 'preparation-failure.json'), json({
    passed: false,
    candidateVerified: false,
    ...inputHashes,
    error: { name: error.name, message: error.message, stack: error.stack },
  }), { flag: 'wx' });
  throw error;
}

const stages = {};
const records = [];
const setupRecords = [];
const caseStages = [];
let instance;
let userToken;
let apiKey;
let outcomeError;
let launchDllSha256 = null;
let launchBound = false;
let lifecycle = { result: { code: null, signal: null }, shutdownStatus: null, pidGone: false, portAvailable: false };
try {
  launchDllSha256 = sha256(await readFile(jellyfinDll));
  assert.equal(launchDllSha256, inputHashes.dllSha256,
    'The Jellyfin DLL changed between input capture and process launch.');
  instance = startReference();
  const ffmpegIndex = instance.command.indexOf('--ffmpeg');
  launchBound = path.resolve(instance.command[0]) === path.resolve(dotnetPath)
    && path.resolve(instance.command[1]) === path.resolve(jellyfinDll)
    && ffmpegIndex > 1 && path.resolve(instance.command[ffmpegIndex + 1]) === path.resolve(ffmpegPath);
  assert.equal(launchBound, true, 'The frozen process must launch the captured dotnet, Jellyfin DLL and ffmpeg.');
  await waitForReady(instance);
  const login = await request('/Users/AuthenticateByName', {
    method: 'POST', body: { Username: 'CoreFlowAdmin', Pw: password },
  });
  assert.equal(login.status, 200, `Frozen admin login failed: ${login.bodyText}`);
  userToken = login.bodyJson.AccessToken;
  const userId = login.bodyJson.User.Id;
  assert.equal(idKey(userId), idKey(fixture.userId));
  const appName = `${scenarioName} HTTP Oracle`;
  const createKey = await request(`/Auth/Keys?app=${encodeURIComponent(appName)}`, { method: 'POST', token: userToken });
  assert.equal(createKey.status, 204, `API key creation failed: ${createKey.bodyText}`);
  const keys = await request('/Auth/Keys', { token: userToken });
  assert.equal(keys.status, 200, `API key listing failed: ${keys.bodyText}`);
  apiKey = keys.bodyJson.Items.find(item => item.AppName === appName)?.AccessToken;
  assert.ok(apiKey, 'Native API key was not returned by /Auth/Keys.');
  const serverConfiguration = await request('/System/Configuration', { token: apiKey });
  assert.equal(serverConfiguration.status, 200, `Server configuration read failed: ${serverConfiguration.bodyText}`);
  const stableServerConfiguration = {
    ...serverConfiguration.bodyJson,
    EnableGroupingMoviesIntoCollections: false,
    EnableGroupingShowsIntoCollections: false,
  };
  const configure = await request('/System/Configuration', {
    method: 'POST', token: apiKey, body: stableServerConfiguration,
  });
  assert.equal(configure.status, 204, `Server configuration update failed: ${configure.bodyText}`);
  setupRecords.push({ kind: 'server-configuration', status: configure.status,
    values: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false } });
  stages.before = { database: databaseSnapshot(), filesystem: await filesystemSnapshot() };

  for (const testCase of fixture.cases) {
    if (testCase.serverConfiguration) {
      const update = await request('/System/Configuration', {
        method: 'POST', token: apiKey, body: { ...stableServerConfiguration, ...testCase.serverConfiguration },
      });
      assert.equal(update.status, 204, `Server configuration update failed for ${testCase.name}: ${update.bodyText}`);
      setupRecords.push({ kind: 'case-server-configuration', name: testCase.name,
        values: testCase.serverConfiguration, status: update.status });
    }
    if (testCase.configuration) {
      const update = await request(`/Users/${userId}/Configuration`, {
        method: 'POST', token: apiKey, body: { ...login.bodyJson.User.Configuration, ...testCase.configuration },
      });
      assert.equal(update.status, 204, `User configuration update failed for ${testCase.name}: ${update.bodyText}`);
      setupRecords.push({ kind: 'user-configuration', name: testCase.name,
        values: testCase.configuration, status: update.status });
    }
    if (testCase.policy) {
      const update = await request(`/Users/${userId}/Policy`, {
        method: 'POST', token: apiKey, body: { ...login.bodyJson.User.Policy, ...testCase.policy },
      });
      assert.equal(update.status, 204, `Policy update failed for ${testCase.name}: ${update.bodyText}`);
      setupRecords.push({ kind: 'policy', name: testCase.name, values: testCase.policy, status: update.status });
    }
    for (const endpoint of testCase.endpoints ?? ['items', 'legacy']) {
      const before = scenario.menuLifecycle
        ? { database: databaseSnapshot(), filesystem: await filesystemSnapshot() } : null;
      const route = routeFor(endpoint, testCase, userId);
      const response = await request(route, { token: testCase.auth === 'apiKey' ? apiKey : userToken });
      records.push({ name: testCase.name, query: testCase.query, scope: testCase.scope,
        endpoint, route, response });
      caseStages.push(scenario.menuLifecycle
        ? { name: testCase.name, endpoint, before,
          after: { database: databaseSnapshot(), filesystem: await filesystemSnapshot() } }
        : { name: testCase.name, endpoint });
      if (records.length % 50 === 0) {
        console.log(JSON.stringify({ scenario: scenarioName, recorded: records.length, total: expectedMatrixCount }));
      }
    }
  }
  stages.afterReads = { database: databaseSnapshot(), filesystem: await filesystemSnapshot() };
} catch (error) {
  outcomeError = error;
} finally {
  if (instance) lifecycle = await stopReference(instance, apiKey ?? userToken);
  try { stages.afterShutdown = { database: databaseSnapshot(), filesystem: await filesystemSnapshot() }; }
  catch (error) { outcomeError ??= error; }

  await writeFile(path.join(runRoot, 'native-http.json'), json({ origin, records }), { flag: 'wx' });
  await writeFile(path.join(runRoot, 'setup-http.json'), json({ origin, records: setupRecords }), { flag: 'wx' });
  await writeFile(path.join(runRoot, 'stages.json'), json({
    schemaVersion: 1,
    targetKeys: fixture.items.filter(item => item.type !== 'AggregateFolder').map(item => item.key),
    ...stages,
  }), { flag: 'wx' });
  await writeFile(path.join(runRoot, 'case-stages.json'), json(caseStages), { flag: 'wx' });

  const contract = captureContract(records, setupRecords, caseStages, stages);
  const contractChecks = Object.fromEntries(Object.entries(contract).filter(([, value]) => typeof value === 'boolean'));
  const sourceInputsAfter = {
    recorderSha256: sha256(await readFile(recorderPath)),
    sourceDatabaseSha256: sha256(await readFile(sourceDatabase)),
    dllSha256: sha256(await readFile(jellyfinDll)),
    dotnetSha256: sha256(await readFile(dotnetPath)),
    ffmpegSha256: sha256(await readFile(ffmpegPath)),
    sourceBootstrapSha256: sha256(await readFile(path.join(sourceRoot, 'bootstrap.json'))),
    sourceBootstrapLogSha256: sha256(await readFile(path.join(sourceRoot, 'bootstrap.log'))),
  };
  const sourceInputsUnchanged = sourceInputsAfter.recorderSha256 === inputHashes.recorderSha256
    && sourceInputsAfter.sourceDatabaseSha256 === inputHashes.sourceDatabaseSha256
    && sourceInputsAfter.dllSha256 === inputHashes.dllSha256
    && sourceInputsAfter.dotnetSha256 === inputHashes.dotnetSha256
    && sourceInputsAfter.ffmpegSha256 === inputHashes.ffmpegSha256
    && sourceInputsAfter.sourceBootstrapSha256 === inputHashes.sourceBootstrapSha256
    && sourceInputsAfter.sourceBootstrapLogSha256 === inputHashes.sourceBootstrapLogSha256;
  const copiesBound = preparation?.copyBindings?.recorderSha256 === inputHashes.recorderSha256
    && preparation?.copyBindings?.fixtureSha256 === inputHashes.fixtureSha256
    && preparation?.copyBindings?.sourceDatabase?.path === 'source-initial.db'
    && preparation?.copyBindings?.sourceDatabase?.sha256 === inputHashes.sourceDatabaseSha256
    && preparation?.copyBindings?.sourcePreparation?.bootstrap?.path === 'source-bootstrap.json'
    && preparation?.copyBindings?.sourcePreparation?.bootstrap?.sha256 === preparation?.inputs?.[0]?.sha256
    && preparation?.copyBindings?.sourcePreparation?.log?.path === 'source-bootstrap.log'
    && preparation?.copyBindings?.sourcePreparation?.log?.sha256 === preparation?.inputs?.[5]?.sha256
    && preparation?.copyBindings?.databaseBeforeSeedSha256 === inputHashes.sourceDatabaseSha256;
  const passed = !outcomeError && preparation?.initializedFromEmpty === true
    && Object.values(contractChecks).every(Boolean)
    && lifecycle.shutdownStatus === 204 && lifecycle.result?.code === 0 && lifecycle.result?.signal === null
    && lifecycle.pidGone && lifecycle.portAvailable && sourceInputsUnchanged && copiesBound && launchBound;
  const summary = {
    passed,
    candidateVerified: false,
    cases: records.length,
    snapshots: caseStages.length,
    processResult: { code: lifecycle.result?.code ?? null, signal: lifecycle.result?.signal ?? null },
    portAvailable: lifecycle.portAvailable,
    pidGone: lifecycle.pidGone,
    cleanShutdown: lifecycle.shutdownStatus === 204,
    ...inputHashes,
    checks: { ...contractChecks, preparedNativeInstance: preparation?.initializedFromEmpty === true,
      sourceInputsUnchanged, copiesBound, launchBound },
    contractFailures: contract.responseFailures,
    error: outcomeError ? { name: outcomeError.name, message: outcomeError.message, stack: outcomeError.stack } : null,
  };
  await writeFile(path.join(runRoot, 'summary.json'), json(summary), { flag: 'wx' });
  const oracleValidation = {
    passed,
    candidateVerified: false,
    scenario: scenarioName,
    nativeRun: scenario.runName,
    responses: records.length,
    snapshots: caseStages.length,
    source: 'Prepared empty-instance Jellyfin baseline copied while stopped; fixture rows seeded offline; all observations recorded from native HTTP and SQLite.',
    checks: summary.checks,
    recorderSha256: inputHashes.recorderSha256,
    fixtureSha256: inputHashes.fixtureSha256,
  };
  await writeFile(path.join(outputRoot, 'oracle-validation.json'), json(oracleValidation), { flag: 'wx' });
  const artifactNames = [
    'record-native.mjs',
    'source-initial.db',
    'source-bootstrap.json',
    'source-bootstrap.log',
    `${scenario.runName}/input.json`,
    `${scenario.runName}/reference-preparation.json`,
    `${scenario.runName}/native-http.json`,
    `${scenario.runName}/setup-http.json`,
    `${scenario.runName}/stages.json`,
    `${scenario.runName}/case-stages.json`,
    `${scenario.runName}/summary.json`,
    `${scenario.runName}/reference-stdout.log`,
    `${scenario.runName}/reference-stderr.log`,
    `${scenario.runName}/reference/data/data/jellyfin.db`,
    'oracle-validation.json',
  ];
  const artifacts = [];
  for (const name of artifactNames) {
    const bytes = await readFile(path.join(outputRoot, name));
    artifacts.push({ path: name.replaceAll('\\', '/'), bytes: bytes.length, sha256: sha256(bytes) });
  }
  await writeFile(path.join(outputRoot, 'provenance.json'), json({
    schemaVersion: 1,
    scenario: scenarioName,
    sourceInputs: {
      paths: { recorder: recorderPath, sourceDatabase, dll: jellyfinDll, dotnet: dotnetPath,
        ffmpeg: ffmpegPath, sourceBootstrap: path.join(sourceRoot, 'bootstrap.json'),
        sourceBootstrapLog: path.join(sourceRoot, 'bootstrap.log') },
      before: {
        recorderSha256: inputHashes.recorderSha256,
        sourceDatabaseSha256: inputHashes.sourceDatabaseSha256,
        dllSha256: inputHashes.dllSha256,
        dotnetSha256: inputHashes.dotnetSha256,
        ffmpegSha256: inputHashes.ffmpegSha256,
        sourceBootstrapSha256: inputHashes.sourceBootstrapSha256,
        sourceBootstrapLogSha256: inputHashes.sourceBootstrapLogSha256,
      },
      after: sourceInputsAfter,
      trackedFixtureSha256: inputHashes.trackedFixtureSha256,
      recordedFixtureSha256: inputHashes.fixtureSha256,
    },
    copies: preparation?.copyBindings ?? null,
    launch: { command: instance?.command ?? null, dllSha256: launchDllSha256,
      dotnetSha256: inputHashes.dotnetSha256, ffmpegSha256: inputHashes.ffmpegSha256 },
    checks: { sourceInputsUnchanged, copiesBound, launchBound },
    artifacts,
  }), { flag: 'wx' });
  if (!passed) throw new Error(`Native ${scenarioName} recording failed: ${JSON.stringify(summary.error ?? summary.checks)}`);
  console.log(JSON.stringify({ evidence: path.relative(repoRoot, outputRoot).replaceAll('\\', '/'),
    run: scenario.runName, cases: records.length, snapshots: caseStages.length,
    processResult: summary.processResult, portAvailable: summary.portAvailable }));
}
