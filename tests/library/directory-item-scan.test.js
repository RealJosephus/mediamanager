import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import {
  createVideoFileResolver,
  createTvItemResolver,
  createBookItemResolver,
  createAudioBookItemResolver,
  createPhotoAlbumResolver,
  createPhotoItemResolver,
  DirectoryItemResolverPipeline,
  audioBookNativeType,
  episodeNativeType,
  LibraryService,
  seasonNativeType,
  seriesNativeType,
  parseBookFileName,
  parseAudioBookName,
  photoAlbumNativeType,
  photoNativeType,
  isNativePhotoFileName,
  isNativeAudioFileName,
  videoNativeType
} from '../../src/library/index.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import { reattachUserData } from '../../src/metadata/persistence.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreRule } from './ignore-namespace-fixture.js';
import { createResolvedItemLifecycleFixture } from './resolved-item-lifecycle-fixture.js';
import { createFolderValidationScanFixture } from '../helpers/folder-validation-scan-fixture.js';
import { dateText, EMPTY_ID, nonemptyId } from '../../src/library/records.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { guidD } from '../../src/sessions/user-data.js';
import {
  audioNativeType,
  createAudioItemResolver,
  musicAlbumNativeType,
  musicArtistNativeType
} from '../../src/library/audio-item-resolver.js';

const FOLDER_TYPE = 'MediaBrowser.Controller.Entities.Folder';
const MOVIE_TYPE = 'MediaBrowser.Controller.Entities.Movies.Movie';
const ROOT_ID = 'D1000000-0000-0000-0000-000000000001';
const FIRST_COLLECTION_ID = 'D1000000-0000-0000-0000-000000000003';
const USER_ROOT_ID = 'D1000000-0000-0000-0000-000000000005';
const AGGREGATE_ID = 'D1000000-0000-0000-0000-000000000006';
const ROOT_PATH = 'Z:\\DirectoryItems';
const PROGRAM_DATA_PATH = 'C:\\ProgramData\\MediaManager';
// Resolver grammar and complete MusicVideo initialization remain covered by
// their sealed resolver/validation files. This file keeps the additional
// persisted hierarchy and identity-changing lifecycle consumers. It invokes
// FolderValidationService directly; no retired whole-tree scan receipt exists.
const directoryNative = parseLosslessJson(await readFile(new URL('./fixtures/directory-video-resolution/native.json', import.meta.url), 'utf8'));
const directoryInput = parseLosslessJson(await readFile(new URL('./fixtures/directory-video-resolution/input.json', import.meta.url), 'utf8'));
const discReclassificationNative = parseLosslessJson(await readFile(
  new URL('./fixtures/directory-disc-reclassification/native.json', import.meta.url), 'utf8'));
const discReclassificationInput = parseLosslessJson(await readFile(
  new URL('./fixtures/directory-disc-reclassification/input.json', import.meta.url), 'utf8'));

const idKey = value => String(value).replaceAll('-', '').toLowerCase();
const itemId = (identityPath, nativeType, enableCaseSensitiveItemIds = false) => nativeGuid(getNewItemId(identityPath, nativeType, {
  programDataPath: PROGRAM_DATA_PATH,
  enableCaseSensitiveItemIds
}));

test('Book, AudioBook and Photo filename helpers preserve the pinned native resolver grammar', () => {
  assert.deepEqual(parseBookFileName('The Novel (Saga, #2) (2024)'), {
    name: 'The Novel', seriesName: 'Saga', index: 2, parentIndex: null, year: 2024
  });
  assert.deepEqual(parseBookFileName('Chronicles (1999) #3 (of 8) (2025)'), {
    name: null, seriesName: 'Chronicles', index: 3, parentIndex: null, year: 2025
  });
  assert.deepEqual(parseBookFileName('Issue v4 c12'), {
    name: 'Issue v4 c12', seriesName: null, index: 12, parentIndex: 4, year: null
  });
  assert.deepEqual(parseBookFileName(null), {
    name: null, seriesName: null, index: null, parentIndex: null, year: null
  });
  assert.equal(isNativePhotoFileName('Vacation.AVIF'), true);
  assert.equal(isNativePhotoFileName('poster-trip.jpg'), false);
  assert.equal(isNativePhotoFileName('portrait.svg'), false);
  assert.deepEqual(parseAudioBookName('Narrated Saga (2026)'), { name: 'Narrated Saga', year: 2026 });
  assert.deepEqual(parseAudioBookName('  Leading Space (2023)'), { name: '  Leading Space', year: 2023 });
  assert.equal(isNativeAudioFileName('chapter.M4B'), true);
  assert.equal(isNativeAudioFileName('chapter.txt'), false);
});

function blank(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    const value = type === 'DateTime' ? '2026-09-27 00:00:00'
      : column.nullable ? null
        : type === 'bool' ? false
          : column.type === 'TEXT' ? ''
            : type === 'long' || type === 'uint' ? 0n : 0;
    return [column.name, value];
  }));
}

function baseItem(Id, Type, values = {}) {
  return {
    ...blank('BaseItems'),
    Id,
    Type,
    Name: values.Name ?? 'Fixture',
    CleanName: values.CleanName ?? 'fixture',
    SortName: values.SortName ?? 'fixture',
    PresentationUniqueKey: Id,
    MediaType: Type === MOVIE_TYPE ? 'Video' : 'Unknown',
    IsFolder: Type === FOLDER_TYPE,
    Data: JSON.stringify({ SourceType: 'Library', ...(Type === MOVIE_TYPE ? { VideoType: 'VideoFile' } : {}) }),
    ...values
  };
}

function collectionData(collectionType) {
  return JSON.stringify({
    SourceType: 'Library',
    CollectionType: collectionType,
    PhysicalFolderIds: [ROOT_ID],
    PhysicalLocationsList: [ROOT_PATH]
  });
}

async function insertCollection(database, collectionType, Id = FIRST_COLLECTION_ID) {
  if (!(await database.rows('BaseItems', { where: { Id: USER_ROOT_ID } })).length) await database.insert('BaseItems',
    baseItem(USER_ROOT_ID, 'MediaBrowser.Controller.Entities.UserRootFolder', { IsFolder: true }));
  await database.insert('BaseItems', baseItem(Id, 'MediaBrowser.Controller.Entities.CollectionFolder', {
    Name: `${collectionType} collection`,
    CleanName: `${collectionType} collection`,
    SortName: `${collectionType} collection`,
    Path: `${PROGRAM_DATA_PATH}\\root\\collections\\${Id}`,
    ParentId: USER_ROOT_ID,
    IsFolder: true,
    Data: collectionData(collectionType)
  }));
  return Id;
}

async function databaseFor(dialect) {
  const schema = `directory_item_scan_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  return {
    database: await PostgresDatabase.open({
      connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      schema,
      create: true
    }),
    schema
  };
}

async function fixture(t, dialect, resolvers, {
  configuration = {}, onResolverError = () => {}, reattach = reattachUserData
} = {}) {
  const { database, schema } = await databaseFor(dialect);
  const store = new DomainStore(database);
  let registry, lifecycleFixture, host;
  t.after(async () => {
    const errors = [];
    const attempt = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
    await attempt(() => host?.close());
    await attempt(() => lifecycleFixture?.close());
    await attempt(() => registry?.close());
    await attempt(async () => {
      assert.match(schema, /^directory_item_scan_[a-f0-9]{16}$/u);
      await database.client.query(`DROP SCHEMA IF EXISTS "${schema}", "${schema}__mm" CASCADE`);
    });
    await attempt(() => database.close());
    if (errors.length) throw new AggregateError(errors, 'Directory validation fixture cleanup failed.');
  });
  registry = new StorageRegistry();
  registry.registerType('memory', options => new MemoryStorageAdapter(options));
  const adapter = await registry.createInstance('directory-items', 'memory', {});
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/library', instanceId: 'directory-items', capabilities: {} });
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({
    identityRoot: ROOT_PATH,
    accessRoot: '/library',
    style: 'windows',
    returnAccess: 'Directory item scan fixture'
  });
  const library = new LibraryService({fileSystem: testFileSystem, store, serverId: 'directory-item-scan',
    programDataPath: PROGRAM_DATA_PATH, configuration });
  const ignoreRule = await knownAncestorIgnoreRule({ registry, vfs, identityMap, identityRoots: [ROOT_PATH] });
  const refreshes = new ProviderRefreshService();
  lifecycleFixture = await createResolvedItemLifecycleFixture({ store, library, vfs, identityMap, ignoreRule, configuration,
    now: () => '2026-09-27T01:02:03.456Z' });
  const resolverPipeline = new DirectoryItemResolverPipeline({ resolvers, programDataPath: PROGRAM_DATA_PATH, configuration,
    onError: onResolverError });
  await database.insert('BaseItems', baseItem(AGGREGATE_ID, 'MediaBrowser.Controller.Entities.AggregateFolder', { IsFolder: true }));
  await database.insert('BaseItems', baseItem(ROOT_ID, FOLDER_TYPE, {
    Name: 'Library',
    CleanName: 'library',
    SortName: 'library',
    Path: ROOT_PATH,
    TopParentId: ROOT_ID, ParentId: AGGREGATE_ID
  }));
  host = createFolderValidationScanFixture({
    ignoreRule,
    store,
    library,
    vfs,
    identityMap,
    refreshes,
    lifecycleFixture,
    resolverPipeline,
    programDataPath: PROGRAM_DATA_PATH,
    configuration,
    clock: () => '2026-09-27T01:02:03.456Z'
  });
  host.validation.reattach = reattach;
  const errors = [];
  host.validation.onError = error => errors.push(error);
  const validate = (options = {}) => host.itemCreation.withItem(ROOT_ID, parent =>
    host.validation.validateChildren(parent, { recursive: true, refreshChildMetadata: false, ...options }));
  return { database, store, library, adapter, vfs, validate, validation: host.validation, lifecycleFixture, errors,
    itemCreation: host.itemCreation, linkedChildReferences: host.linkedChildReferences };
}

const rowOrder = (left, right) => Object.values(left).map(String).join('\0')
  .localeCompare(Object.values(right).map(String).join('\0'), 'en');

async function snapshot(database) {
  return {
    items: (await database.rows('BaseItems')).toSorted(rowOrder),
    ancestors: (await database.rows('AncestorIds')).toSorted(rowOrder)
  };
}

const fixturePath = value => '/' + value.replaceAll('\\', '/');
const identityFixturePath = value => `${ROOT_PATH}\\${value.replaceAll('/', '\\')}`;

async function createDiscSample(adapter, sample) {
  for (const directory of sample.directories) await adapter.mkdir(fixturePath(directory));
  for (const file of sample.files) await adapter.write(fixturePath(file), Buffer.from('media control'));
}

async function transitionDiscSample(adapter, sample) {
  const afterFiles = new Set(sample.afterFiles), afterDirectories = new Set(sample.afterDirectories);
  for (const file of sample.files) if (!afterFiles.has(file)) await adapter.delete(fixturePath(file));
  for (const directory of sample.directories.filter(value => !afterDirectories.has(value))
    .toSorted((left, right) => right.split('/').length - left.split('/').length)) {
    await adapter.delete(fixturePath(directory), { recursive: true });
  }
  for (const directory of sample.afterDirectories) if (!sample.directories.includes(directory)) {
    await adapter.mkdir(fixturePath(directory));
  }
  for (const file of sample.afterFiles) if (!sample.files.includes(file)) {
    await adapter.write(fixturePath(file), Buffer.from('media control'));
  }
}

async function assertDiscReclassificationScan(t, dialect, sample, expected, {
  promotion = false, folderReclassification = false
} = {}) {
  const { database, library, adapter, validate, validation, errors,
    itemCreation } = await fixture(t, dialect,
    [createVideoFileResolver()]);
  await insertCollection(database, sample.collectionType);
  await createDiscSample(adapter, sample);
  await validate();
  const primaryPath = identityFixturePath(sample.mutationPath);
  const movieId = itemId(primaryPath, MOVIE_TYPE);
  assert.equal((await database.rows('BaseItems', { where: { Id: movieId } })).length, 1,
    'the warm scan must establish the expected primary identity');
  const mutation = { ...sample.mutation };
  if (mutation.Name != null) Object.assign(mutation, {
    CleanName: mutation.Name.toLowerCase(),
    SortName: mutation.Name.toLowerCase()
  });
  await database.update('BaseItems', { Id: movieId }, mutation);
  itemCreation.unregisterItem(movieId);
  const placeholderId = '00000000-0000-0000-0000-000000000001';
  const userId = 'D1000000-0000-0000-0000-000000000007';
  const identityKey = guidD(movieId);
  if (sample.migrationEvidence) {
    const providers = await database.rows('BaseItemProviders', { where: { ItemId: movieId } });
    assert.deepEqual(providers.map(row => [row.ProviderId, row.ProviderValue]), [['Imdb', 'tt7654321']]);
    await database.insert('BaseItems', baseItem(placeholderId, 'PLACEHOLDER', {
      Name: 'This is a placeholder item for UserData that has been detached from its original item',
      Data: '{}'
    }));
    await database.insert('Users', {
      ...blank('Users'), Id: userId, InternalId: 1701,
      Username: 'Promotion User', NormalizedUsername: 'PROMOTION USER'
    });
    await database.insert('UserData', {
      ...blank('UserData'), ItemId: movieId, UserId: userId, CustomDataKey: 'tt7654321',
      IsFavorite: true, Played: true, PlayCount: 7, PlaybackPositionTicks: 9007199254740993n,
      LastPlayedDate: '2026-10-03 01:02:03.0000000', Rating: 8.5
    });
    await database.insert('UserData', {
      ...blank('UserData'), ItemId: movieId, UserId: userId, CustomDataKey: identityKey,
      PlayCount: 3, PlaybackPositionTicks: 33n
    });
    await database.insert('LinkedChildren', {
      ParentId: ROOT_ID, SortOrder: 0, ChildId: movieId, ChildType: 0
    });
  }
  await transitionDiscSample(adapter, sample);

  const calls = [];
  const controller = new AbortController();
  for (const [eventName, kind] of [['ItemAdded', 'added'], ['ItemUpdated', 'updated'], ['ItemRemoved', 'removed']]) {
    library.on(eventName, event => {
      calls.push({ action: 'event', kind, reason: event.UpdateReason ?? null });
      if (sample.cancelAfterOuterAdded && eventName === 'ItemAdded' && event.Item.NativeType === FOLDER_TYPE) {
        controller.abort();
      }
    });
  }
  if (promotion || folderReclassification) {
    const remove = library.deleteItem.bind(library);
    library.deleteItem = async (...args) => {
      calls.push({ action: 'delete' });
      return remove(...args);
    };
    const saveItems = itemCreation.saveItems.bind(itemCreation);
    itemCreation.saveItems = async (...args) => {
      calls.push({ action: 'save' });
      const items = args[0] ?? [];
      if (sample.failCreateAfterDelete && items.some(item => item.NativeType === FOLDER_TYPE)) {
        throw new Error('Controlled outer Folder creation failure');
      }
      if (sample.failNestedCreate && items.some(item => item.NativeType === MOVIE_TYPE)) {
        throw new Error('Controlled nested Movie creation failure');
      }
      return saveItems(...args);
    };
    validation.reattach = async (...args) => {
      calls.push({ action: 'reattach' });
      return reattachUserData(...args);
    };
  }
  let failure = null;
  try {
    await validate({
      signal: sample.cancellable ? controller.signal : undefined
    });
  } catch (error) { failure = error; }

  const actionNames = ['delete', 'save', 'event', 'reattach'];
  const expectedActions = expected.calls.filter(call => actionNames.includes(call.action))
    .map(call => ({ action: call.action,
      ...(call.action === 'event' ? { kind: call.kind, reason: call.reason ?? null } : {}) }));
  assert.deepEqual(calls, expectedActions,
    `candidate lifecycle side-effect prefix must match the native recording${failure ? `: ${failure.stack}` : ''}`);
  const expectedMovie = expected.rows.find(row => row.type === MOVIE_TYPE);
  const expectedFolder = folderReclassification ? expected.rows.find(value => value.type === FOLDER_TYPE
    && value.path !== '$STATE\\media') : null;
  if (expected.exception == null) {
    assert.equal(failure, null);
    if (sample.failNestedCreate) {
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /Controlled nested Movie creation failure/u);
      assert.equal((await database.rows('BaseItems', { where: { Id: movieId } })).length, 0);
      const folderPath = expectedFolder.path.replace('$STATE\\media', ROOT_PATH);
      assert.equal((await database.rows('BaseItems', { where: { Path: folderPath } })).length, 1);
      assert.equal((await database.rows('BaseItems', { where: { Path: identityFixturePath('Film/Film Disc 2') } })).length, 0);
      return;
    }
  } else {
    assert.ok(failure, `expected ${expected.exception}`);
    if (sample.failCreateAfterDelete) assert.match(failure.message, /Controlled outer Folder creation failure/u);
    if (folderReclassification) {
      assert.equal((await database.rows('BaseItems', { where: { Id: movieId } })).length, 0,
        'the native prefix has already deleted the old identity');
      const folderPath = `${ROOT_PATH}\\${sample.entries[0]}`;
      assert.equal((await database.rows('BaseItems', { where: { Path: folderPath } })).length,
        sample.failCreateAfterDelete ? 0 : 1);
      if (sample.cancelAfterOuterAdded) assert.equal(failure, controller.signal.reason);
      return;
    }
  }
  assert.deepEqual(errors, []);

  const expectedParts = expectedMovie.data.AdditionalParts.map(value => value.replace('$STATE\\media', ROOT_PATH));
  const expectedPath = expectedMovie.path.replace('$STATE\\media', ROOT_PATH);
  const [row] = await database.rows('BaseItems', {
    where: promotion || folderReclassification ? { Path: expectedPath } : { Id: movieId }
  });
  const data = JSON.parse(row.Data);
  assert.deepEqual(data.AdditionalParts, expectedParts);
  assert.equal(data.VideoType, expectedMovie.data.VideoType);
  if (promotion || folderReclassification) {
    assert.equal((await database.rows('BaseItems', { where: { Id: movieId } })).length, 0);
    assert.equal(row.Name, expectedMovie.name, 'fresh creation must not copy curated old metadata');
    assert.equal(row.Overview, null);
    assert.deepEqual((await library.getItemRecord(row.Id)).AdditionalParts, expectedParts);
    if (folderReclassification) {
      const folderPath = expectedFolder.path.replace('$STATE\\media', ROOT_PATH);
      const [folder] = await database.rows('BaseItems', { where: { Path: folderPath } });
      assert.equal(folder.Type, FOLDER_TYPE);
      assert.equal(folder.ParentId, ROOT_ID);
      assert.equal(folder.OwnerId, null);
      assert.equal(folder.PrimaryVersionId, null);
      assert.equal(row.ParentId, folder.Id);
      assert.equal(row.TopParentId, ROOT_ID);
      assert.equal(row.OwnerId, null);
      assert.equal(row.PrimaryVersionId, null);
      assert.equal(row.ProductionYear, null);
      assert.deepEqual(data.AdditionalParts, []);
    }
    if (sample.migrationEvidence) {
      assert.deepEqual(await database.rows('LinkedChildren'), [], 'manual links are deleted with the old identity');
      const shared = (await database.rows('UserData', { where: {
        UserId: userId, CustomDataKey: 'tt7654321'
      } }))[0];
      const identity = (await database.rows('UserData', { where: {
        UserId: userId, CustomDataKey: identityKey
      } }))[0];
      assert.equal(idKey(shared.ItemId), idKey(folderReclassification ? placeholderId : row.Id));
      if (folderReclassification) {
        assert.equal(dateText(shared.RetentionDate), '2026-09-27T01:02:03.4560000Z');
      } else assert.equal(shared.RetentionDate, null);
      assert.equal(shared.IsFavorite, true);
      assert.equal(shared.Played, true);
      assert.equal(shared.PlayCount, 7);
      assert.equal(shared.PlaybackPositionTicks, 9007199254740993n);
      assert.equal(idKey(identity.ItemId), idKey(placeholderId));
      assert.equal(dateText(identity.RetentionDate), '2026-09-27T01:02:03.4560000Z');
      assert.deepEqual((await database.rows('BaseItemProviders', { where: { ItemId: row.Id } }))
        .map(provider => [provider.ProviderId, provider.ProviderValue]), [['Imdb', 'tt7654321']]);
      if (folderReclassification) {
        assert.equal(calls.some(call => call.action === 'reattach'), false,
          'native checks the outer Folder keys before recursion and never reattaches the later nested Movie');
      }
    }
  }
}

for (const dialect of ['postgres']) {
  const options = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };

  test(`${dialect}: missing Episode primary promotes its physical version and reroutes a live manual reference`, options, async t => {
    const { database, library, adapter, validate, itemCreation, errors } = await fixture(t, dialect,
      [createVideoFileResolver(), createTvItemResolver()]);
    await insertCollection(database, 'tvshows');
    await adapter.mkdir('/Version Show');
    await adapter.mkdir('/Version Show/Season 01');
    const names = ['Version.Show.S01E01 - 1080p.mkv', 'Other.Title.S01E01 - 720p.mkv'];
    for (const name of names) await adapter.write('/Version Show/Season 01/' + name, Buffer.from(name));
    const seriesPath = ROOT_PATH + '\\Version Show', seasonPath = seriesPath + '\\Season 01';
    const seriesId = itemId(seriesPath, seriesNativeType), seasonId = itemId(seasonPath, seasonNativeType);
    const paths = names.map(name => seasonPath + '\\' + name);
    const [primaryId, alternateId] = paths.map(value => itemId(value, episodeNativeType));
    await validate();
    assert.deepEqual(errors, []);
    assert.deepEqual((await library.getItemRecord(primaryId)).LocalAlternateVersions, [paths[1]]);
    const originalAlternate = await library.getItemRecord(alternateId);
    assert.equal(originalAlternate.ParentId, seasonId);
    assert.equal(originalAlternate.OwnerId, primaryId); assert.equal(originalAlternate.PrimaryVersionId, primaryId);
    await database.insert('LinkedChildren', { ParentId: ROOT_ID, ChildId: primaryId, ChildType: 0, SortOrder: 0 });
    itemCreation.unregisterItem(ROOT_ID);
    await itemCreation.withItem(ROOT_ID, async caller => {
      const manualLinks = async () => (await itemCreation.linkedChildren.page(caller.LinkedChildren, { limit: 8 }))
        .map(link => idKey(link.ItemId));
      assert.deepEqual(await manualLinks(), [idKey(primaryId)]);
      await adapter.delete('/Version Show/Season 01/' + names[0]);
      await validate();
      assert.deepEqual(errors, []);
      assert.deepEqual(await database.rows('BaseItems', { where: { Id: primaryId } }), []);
      assert.equal(await itemCreation.getItemById(primaryId), null);
      assert.deepEqual((await database.rows('LinkedChildren', { where: { ParentId: ROOT_ID, ChildType: 0 } }))
        .map(link => idKey(link.ChildId)), [idKey(alternateId)]);
      assert.deepEqual(await manualLinks(), [idKey(alternateId)]);
      itemCreation.unregisterItem(alternateId);
      await itemCreation.withItem(alternateId, survivor => {
        assert.equal(survivor.Type, 'Episode'); assert.equal(survivor.Path, paths[1]);
        assert.equal(survivor.ParentId, seasonId); assert.equal(survivor.SeriesId, seriesId);
        assert.equal(survivor.SeasonId, seasonId);
        assert.ok(!nonemptyId(survivor.OwnerId)); assert.ok(!nonemptyId(survivor.PrimaryVersionId));
        assert.deepEqual(survivor.LocalAlternateVersions, []);
      });
      assert.equal((await adapter.stat('/Version Show/Season 01/' + names[1])).kind, 'file');
      const before = await snapshot(database), links = await database.rows('LinkedChildren');
      await validate();
      assert.deepEqual(await snapshot(database), before);
      assert.deepEqual(await database.rows('LinkedChildren'), links);
      assert.deepEqual(await manualLinks(), [idKey(alternateId)]);
    });
  });

  test(`${dialect}: AudioBook multi, file and collapsed-directory branches preserve native fields`, options, async t => {
    const { database, library, adapter, validate } = await fixture(t, dialect,
      [createBookItemResolver(), createAudioBookItemResolver()]);
    const collectionId = await insertCollection(database, 'books');
    await adapter.write('/Narration.m4b', Buffer.from('narration'));
    await adapter.write('/Remote.strm', Buffer.from('https://media.invalid/audiobook'));
    await adapter.write('/Ignored.cue', Buffer.from('FILE ignored.wav WAVE'));
    await adapter.mkdir('/Story (2021)');
    await adapter.write('/Story (2021)/chapter01.m4b', Buffer.from('story'));
    await adapter.mkdir('/Chapters');
    await adapter.write('/Chapters/ch01.m4b', Buffer.from('one'));
    await adapter.write('/Chapters/ch02.mp3', Buffer.from('two'));

    const paths = {
      narration: `${ROOT_PATH}\\Narration.m4b`,
      remote: `${ROOT_PATH}\\Remote.strm`,
      cue: `${ROOT_PATH}\\Ignored.cue`,
      storyDirectory: `${ROOT_PATH}\\Story (2021)`,
      story: `${ROOT_PATH}\\Story (2021)\\chapter01.m4b`,
      chapters: `${ROOT_PATH}\\Chapters`,
      first: `${ROOT_PATH}\\Chapters\\ch01.m4b`,
      second: `${ROOT_PATH}\\Chapters\\ch02.mp3`
    };
    const ids = {
      narration: itemId(paths.narration, audioBookNativeType),
      remote: itemId(paths.remote, audioBookNativeType),
      story: itemId(paths.story, audioBookNativeType),
      chapters: itemId(paths.chapters, FOLDER_TYPE),
      first: itemId(paths.first, audioBookNativeType),
      second: itemId(paths.second, audioBookNativeType)
    };

    await validate();
    const rows = {};
    for (const [name, Id] of Object.entries(ids)) {
      [rows[name]] = await database.rows('BaseItems', { where: { Id } });
    }
    assert.deepEqual({ type: rows.narration.Type, name: rows.narration.Name, parent: rows.narration.ParentId,
      mediaType: rows.narration.MediaType, unrated: rows.narration.UnratedType,
      mixed: rows.narration.IsInMixedFolder },
    { type: audioBookNativeType, name: 'Narration', parent: ROOT_ID, mediaType: 'Audio', unrated: 'Book',
      mixed: true });
    assert.deepEqual({ name: rows.remote.Name, mixed: rows.remote.IsInMixedFolder },
      { name: 'Remote', mixed: true });
    assert.equal((await database.rows('BaseItems', { where: { Path: paths.cue } })).length, 0);
    assert.deepEqual({ type: rows.story.Type, name: rows.story.Name, path: rows.story.Path,
      parent: rows.story.ParentId, mixed: rows.story.IsInMixedFolder, year: rows.story.ProductionYear },
    { type: audioBookNativeType, name: 'Story (2021)', path: paths.story,
      parent: ROOT_ID, mixed: false, year: 2021 });
    assert.equal((await database.rows('BaseItems', { where: { Path: paths.storyDirectory } })).length, 0);
    assert.equal(rows.chapters.Type, FOLDER_TYPE);
    assert.deepEqual({ name: rows.first.Name, parent: rows.first.ParentId, mixed: rows.first.IsInMixedFolder },
      { name: 'ch01', parent: ids.chapters, mixed: true });
    assert.deepEqual({ name: rows.second.Name, parent: rows.second.ParentId, mixed: rows.second.IsInMixedFolder },
      { name: 'ch02', parent: ids.chapters, mixed: true });
    assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: ids.first } }))
      .map(row => idKey(row.ParentItemId))),
    new Set([idKey(ids.chapters), idKey(ROOT_ID), idKey(AGGREGATE_ID), idKey(collectionId)]));
    const before = await snapshot(database);
    await validate();
    assert.deepEqual(await snapshot(database), before);
    await adapter.delete('/Narration.m4b');
    await validate();
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: ids.narration } }), []);
    assert.deepEqual(await database.rows('AncestorIds', { where: { ItemId: ids.narration } }), []);
    assert.equal((await library.getItemRecord(ids.story)).ParentId, ROOT_ID);
  });

  test(`${dialect}: Photo albums retain videos while excluding artwork and video-owned images`, options, async t => {
    const { database, library, adapter, validate } = await fixture(t, dialect,
      [createPhotoItemResolver(), createPhotoAlbumResolver(), createVideoFileResolver()]);
    const collectionId = await insertCollection(database, 'photos');
    await adapter.write('/standalone.JPG', Buffer.from('standalone'));
    await adapter.write('/cover-library.jpg', Buffer.from('cover'));
    await adapter.mkdir('/Album');
    await adapter.write('/Album/sunset.webp', Buffer.from('sunset'));
    await adapter.write('/Album/poster-art.jpg', Buffer.from('poster'));
    await adapter.write('/Album/clip.mp4', Buffer.from('video'));
    await adapter.write('/Album/clip-poster.jpg', Buffer.from('owned'));

    const paths = {
      standalone: `${ROOT_PATH}\\standalone.JPG`,
      cover: `${ROOT_PATH}\\cover-library.jpg`,
      album: `${ROOT_PATH}\\Album`,
      video: `${ROOT_PATH}\\Album\\clip.mp4`,
      sunset: `${ROOT_PATH}\\Album\\sunset.webp`,
      poster: `${ROOT_PATH}\\Album\\poster-art.jpg`,
      owned: `${ROOT_PATH}\\Album\\clip-poster.jpg`
    };
    const ids = {
      standalone: itemId(paths.standalone, photoNativeType),
      album: itemId(paths.album, photoAlbumNativeType),
      video: itemId(paths.video, videoNativeType),
      sunset: itemId(paths.sunset, photoNativeType)
    };

    await validate();
    const [standalone] = await database.rows('BaseItems', { where: { Id: ids.standalone } });
    const [album] = await database.rows('BaseItems', { where: { Id: ids.album } });
    const [sunset] = await database.rows('BaseItems', { where: { Id: ids.sunset } });
    assert.deepEqual({ type: standalone.Type, name: standalone.Name, path: standalone.Path,
      parent: standalone.ParentId, mediaType: standalone.MediaType },
    { type: photoNativeType, name: 'standalone', path: paths.standalone,
      parent: ROOT_ID, mediaType: 'Photo' });
    assert.deepEqual({ type: album.Type, name: album.Name, path: album.Path,
      parent: album.ParentId, isFolder: album.IsFolder },
    { type: photoAlbumNativeType, name: 'Album', path: paths.album, parent: ROOT_ID, isFolder: true });
    assert.deepEqual({ type: sunset.Type, name: sunset.Name, parent: sunset.ParentId, mediaType: sunset.MediaType },
      { type: photoNativeType, name: 'sunset', parent: ids.album, mediaType: 'Photo' });
    const [video] = await database.rows('BaseItems', { where: { Id: ids.video } });
    assert.deepEqual({ type: video.Type, path: video.Path, parent: video.ParentId, mediaType: video.MediaType },
      { type: videoNativeType, path: paths.video, parent: ids.album, mediaType: 'Video' });
    const coldVideo = await library.getItemRecord(ids.video);
    assert.equal(coldVideo.Type, 'Video');
    assert.equal(coldVideo.VideoType, 'VideoFile');
    assert.equal(coldVideo.ParentId, ids.album);
    for (const path of [paths.cover, paths.poster, paths.owned]) {
      assert.equal((await database.rows('BaseItems', { where: { Path: path } })).length, 0);
    }
    const ancestors = new Set((await database.rows('AncestorIds', { where: { ItemId: ids.sunset } }))
      .map(row => idKey(row.ParentItemId)));
    assert.deepEqual(ancestors, new Set([idKey(ids.album), idKey(ROOT_ID), idKey(AGGREGATE_ID), idKey(collectionId)]));
    assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: ids.video } }))
      .map(row => idKey(row.ParentItemId))), ancestors);
    const before = await snapshot(database);
    await validate();
    assert.deepEqual(await snapshot(database), before);
    await adapter.delete('/Album/clip.mp4');
    await validate();
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: ids.video } }), []);
    assert.equal((await library.getItemRecord(ids.sunset)).ParentId, ids.album);
  });

  for (const sampleName of ['directory-folder-provider-id', 'directory-file-provider-id', 'directory-provider-short-aliases',
    'directory-inherited-parent-lock', 'directory-file-resolve-clock', 'directory-mixed-stack-tokens',
    'directory-numeric-stack', 'directory-local-versions', 'directory-two-stacked-versions']) {
    test(`${dialect}: folder validation persists native resolver initial fields ${sampleName}`, options, async t => {
      const sample = directoryInput.find(value => value.name === sampleName), expected = directoryNative.results.find(value => value.name === sampleName).resolved[0];
      const { database, library, adapter, validate, validation } = await fixture(t, dialect, [createVideoFileResolver()]);
      await insertCollection(database, 'movies');
      validation.metadataConfiguration = { UseFileCreationTimeForDateAdded: !sample.useResolveTime };
      if (sample.parentLocked) await database.update('BaseItems', { Id: ROOT_ID }, { IsLocked: true });
      for (const name of sample.directories) await adapter.mkdir('/' + name);
      for (const name of sample.files) await adapter.write('/' + name,
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('media control')]), { modified: '2025-01-03T04:05:06.0000000Z' });
      const list = adapter.listPage.bind(adapter);
      adapter.listPage = async (...args) => {
        const result = await list(...args);
        return { ...result, entries: result.entries.map(entry => entry.kind === 'file'
          ? { ...entry, created: '2025-01-02T03:04:05.0000000Z' } : entry) };
      };
      await validate();
      const identityPath = expected.path.replace('$STATE\\media', ROOT_PATH);
      const [row] = await database.rows('BaseItems', { where: { Path: identityPath } });
      assert.ok(row);
      const item = await library.getItemRecord(row.Id);
      // Keep the original native initialization projection through actual
      // CreateItems and a cold repository read.
      assert.deepEqual({ type: row.Type, name: row.Name, isFolder: row.IsFolder, mediaType: row.MediaType,
        mixed: row.IsInMixedFolder, locked: row.IsLocked, productionYear: row.ProductionYear,
        size: row.Size == null ? null : Number(row.Size), providerIds: item.ProviderIds,
        parts: item.IsFolder ? null : (item.AdditionalParts ?? []).map(value => value.replace(ROOT_PATH, '$STATE\\media')),
        alternates: item.IsFolder ? null : (item.LocalAlternateVersions ?? []).map(value => value.replace(ROOT_PATH, '$STATE\\media')),
        dateCreated: dateText(row.DateCreated), dateModified: dateText(item.DateModified) },
      { type: expected.type, name: expected.name, isFolder: expected.isFolder, mediaType: expected.mediaType,
        mixed: expected.mixed, locked: expected.locked, productionYear: expected.productionYear,
        size: expected.size, providerIds: expected.providerIds, parts: expected.parts, alternates: expected.alternates,
        dateCreated: expected.dateCreated === '$UTC_RESOLVE' ? '2026-09-27T01:02:03.4560000Z' : expected.dateCreated,
        dateModified: expected.dateModified });
    });
  }

  for (const sample of discReclassificationInput.filter((_, index) => [9, 11, 12].includes(index))) test(
    `${dialect}: directory disc primary promotion ${sample.name}`,
    options,
    async t => assertDiscReclassificationScan(t, dialect, sample,
      discReclassificationNative.results.find(result => result.name === sample.name), { promotion: true }));

  for (const sample of discReclassificationInput.filter((_, index) => index >= 13)) test(
    `${dialect}: directory disc two-to-Folder reclassification ${sample.name}`,
    options,
    async t => assertDiscReclassificationScan(t, dialect, sample,
      discReclassificationNative.results.find(result => result.name === sample.name), { folderReclassification: true }));

  test(`${dialect}: music tracks persist native parents, ancestors and create-only tag columns in albums, artists and roots`, options,
    async t => {
      const { database, library, adapter, validate, itemCreation } = await fixture(t, dialect, [createAudioItemResolver()]);
      const collectionId = await insertCollection(database, 'music');
      await adapter.write('/Loose.3gp', Buffer.from('root track'));
      await adapter.mkdir('/Direct Album');
      await adapter.write('/Direct Album/Track.flac', Buffer.from('direct'));
      await adapter.write('/Direct Album/Clip.mkv', Buffer.from('unrelated video'));
      await adapter.mkdir('/Artist');
      await adapter.write('/Artist/Loose.rm', Buffer.from('artist track'));
      await adapter.write('/Artist/Clip.mkv', Buffer.from('unrelated video'));
      await adapter.mkdir('/Artist/First Album');
      await adapter.write('/Artist/First Album/One.mp3', Buffer.from('one'));
      await adapter.write('/Artist/First Album/Clip.mkv', Buffer.from('unrelated video'));
      await adapter.mkdir('/Artist/Second Album');
      await adapter.write('/Artist/Second Album/Two.nsv', Buffer.from('two'));

      const paths = {
        rootTrack: `${ROOT_PATH}\\Loose.3gp`,
        artistTrack: `${ROOT_PATH}\\Artist\\Loose.rm`,
        directAlbum: `${ROOT_PATH}\\Direct Album`,
        directTrack: `${ROOT_PATH}\\Direct Album\\Track.flac`,
        artist: `${ROOT_PATH}\\Artist`,
        firstAlbum: `${ROOT_PATH}\\Artist\\First Album`,
        firstTrack: `${ROOT_PATH}\\Artist\\First Album\\One.mp3`,
        secondAlbum: `${ROOT_PATH}\\Artist\\Second Album`,
        secondTrack: `${ROOT_PATH}\\Artist\\Second Album\\Two.nsv`
      };
      const ids = {
        rootTrack: itemId(paths.rootTrack, audioNativeType),
        artistTrack: itemId(paths.artistTrack, audioNativeType),
        directAlbum: itemId(paths.directAlbum, musicAlbumNativeType),
        directTrack: itemId(paths.directTrack, audioNativeType),
        artist: itemId(paths.artist, musicArtistNativeType),
        firstAlbum: itemId(paths.firstAlbum, musicAlbumNativeType),
        firstTrack: itemId(paths.firstTrack, audioNativeType),
        secondAlbum: itemId(paths.secondAlbum, musicAlbumNativeType),
        secondTrack: itemId(paths.secondTrack, audioNativeType)
      };

      await validate();
      const rows = {};
      for (const [name, Id] of Object.entries(ids)) {
        rows[name] = (await database.rows('BaseItems', { where: { Id } }))[0];
      }
      assert.equal(rows.directAlbum.Type, musicAlbumNativeType);
      assert.equal(rows.directAlbum.ParentId, ROOT_ID);
      assert.equal(rows.directAlbum.TopParentId, ROOT_ID);
      assert.equal(rows.directAlbum.MediaType, 'Unknown');
      assert.equal(rows.directAlbum.UnratedType, 'Music');
      assert.equal(rows.directAlbum.Artists, '');
      assert.equal(rows.directAlbum.AlbumArtists, '');
      assert.equal(rows.directAlbum.PresentationUniqueKey, null);
      assert.equal(rows.directTrack.Type, audioNativeType);
      assert.equal(rows.directTrack.ParentId, ids.directAlbum);
      assert.equal(rows.directTrack.TopParentId, ROOT_ID);
      assert.equal(rows.directTrack.MediaType, 'Audio');
      assert.equal(rows.directTrack.IsInMixedFolder, true);
      assert.equal(rows.directTrack.UnratedType, 'Music');
      assert.equal(rows.directTrack.SortName, 'Track');
      assert.equal(rows.directTrack.PresentationUniqueKey, null);
      assert.equal(rows.artist.Type, musicArtistNativeType);
      assert.equal(rows.artist.ParentId, ROOT_ID);
      assert.equal(rows.artist.PresentationUniqueKey, null);
      assert.equal(rows.firstAlbum.ParentId, ids.artist);
      assert.equal(rows.firstTrack.ParentId, ids.firstAlbum);
      assert.equal(rows.secondAlbum.ParentId, ids.artist);
      assert.equal(rows.secondTrack.ParentId, ids.secondAlbum);
      assert.equal((await library.getItemRecord(ids.firstTrack)).SourceType, 'Library');
      for (const [name, parent] of [['rootTrack', ROOT_ID], ['artistTrack', ids.artist]]) {
        assert.equal(rows[name].Type, audioNativeType);
        assert.equal(rows[name].ParentId, parent);
        assert.equal(rows[name].TopParentId, ROOT_ID);
        assert.equal(rows[name].IsInMixedFolder, true);
        const item = await library.getItemRecord(ids[name]);
        assert.equal(item.Type, 'Audio');
        assert.equal(item.ParentId, parent);
      }

      const ancestors = async Id => new Set((await database.rows('AncestorIds', { where: { ItemId: Id } }))
        .map(row => idKey(row.ParentItemId)));
      assert.deepEqual(await ancestors(ids.directTrack),
        new Set([idKey(ids.directAlbum), idKey(ROOT_ID), idKey(AGGREGATE_ID), idKey(collectionId)]));
      assert.deepEqual(await ancestors(ids.firstTrack),
        new Set([idKey(ids.firstAlbum), idKey(ids.artist), idKey(ROOT_ID), idKey(AGGREGATE_ID), idKey(collectionId)]));
      assert.deepEqual(await ancestors(ids.rootTrack), new Set([idKey(ROOT_ID), idKey(AGGREGATE_ID), idKey(collectionId)]));
      assert.deepEqual(await ancestors(ids.artistTrack), new Set([idKey(ids.artist), idKey(ROOT_ID), idKey(AGGREGATE_ID), idKey(collectionId)]));
      assert.equal((await database.rows('ItemValues')).length, 0);
      assert.equal((await database.rows('ItemValuesMap')).length, 0);
      for (const relative of ['Direct Album', 'Artist', 'Artist\\First Album']) {
        assert.deepEqual(await database.rows('BaseItems', { where: { Path: `${ROOT_PATH}\\${relative}\\Clip.mkv` } }), [],
          'unrelated videos do not prevent music discovery or become Audio items');
      }
      assert.equal((await library.getItemRecord(ids.secondTrack)).Type, 'Audio');

      await database.update('BaseItems', { Id: ids.firstTrack }, {
        Album: 'Imported Album', Artists: 'Imported Artist', AlbumArtists: 'Imported Album Artist',
        IndexNumber: 7, ParentIndexNumber: 2, PresentationUniqueKey: 'provider-key'
      });
      itemCreation.unregisterItem(ids.firstTrack);
      await validate();
      for (const name of ['rootTrack', 'artistTrack']) {
        assert.equal((await database.rows('BaseItems', { where: { Path: paths[name] } }))[0].Id, ids[name]);
      }
      const [preserved] = await database.rows('BaseItems', { where: { Id: ids.firstTrack } });
      assert.equal(preserved.Album, 'Imported Album');
      assert.equal(preserved.Artists, 'Imported Artist');
      assert.equal(preserved.AlbumArtists, 'Imported Album Artist');
      assert.equal(preserved.IndexNumber, 7);
      assert.equal(preserved.ParentIndexNumber, 2);
      assert.equal(preserved.PresentationUniqueKey, 'provider-key');

      await adapter.delete('/Direct Album/Track.flac');
      await adapter.write('/Direct Album/disc.cue', Buffer.from('cue'));
      await validate();
      const [cueAlbum] = await database.rows('BaseItems', { where: { Id: ids.directAlbum } });
      assert.equal(cueAlbum.Type, musicAlbumNativeType, 'CUE retains the Album identity without creating an Audio item');
      assert.equal(cueAlbum.Path, paths.directAlbum);
      assert.equal(cueAlbum.ParentId, ROOT_ID);
      assert.equal((await database.rows('BaseItems', { where: { Id: ids.directTrack } })).length, 0);
      assert.deepEqual(await database.rows('AncestorIds', { where: { ItemId: ids.directTrack } }), []);
      assert.equal((await database.rows('BaseItems', { where: { Path: `${paths.directAlbum}\\disc.cue` } })).length, 0);
      await adapter.delete('/Direct Album/disc.cue');
      await adapter.write('/Direct Album/Track.flac', Buffer.from('direct'));

      const artist = await itemCreation.getItemById(ids.artist);
      const parent = await itemCreation.getItemById(ROOT_ID);
      const otherParent = await itemCreation.getItemById(ids.firstAlbum);
      const beforeRejectedDeletion = await snapshot(database);
      artist.ParentId = EMPTY_ID;
      assert.equal(artist.IsFolder, false, 'clearing the physical parent changes the native Artist getter');
      try {
        for (const rejectedParent of [undefined, otherParent]) {
          await assert.rejects(library.deleteItem(artist, { DeleteFileLocation: false }, rejectedParent, false),
            /changed source shape/u);
        }
        await assert.rejects(library.deleteItem(artist, { DeleteFileLocation: true }, parent, false),
          /changed source shape/u);
        artist.IsInMixedFolder = true;
        try {
          await assert.rejects(library.deleteItem(artist, { DeleteFileLocation: false }, parent, false),
            /changed source shape/u);
        } finally { artist.IsInMixedFolder = false; }
        assert.deepEqual(await snapshot(database), beforeRejectedDeletion);
        assert.equal((await adapter.stat('/Artist')).kind, 'directory');
      } finally { artist.ParentId = ROOT_ID; }

      for (const target of [
        '/Loose.3gp', '/Artist/Loose.rm', '/Artist/Clip.mkv',
        '/Artist/First Album/One.mp3', '/Artist/First Album/Clip.mkv', '/Artist/Second Album/Two.nsv',
        '/Artist/First Album', '/Artist/Second Album', '/Artist'
      ]) await adapter.delete(target);
      await validate();
      for (const key of ['rootTrack', 'artistTrack', 'artist', 'firstAlbum', 'firstTrack', 'secondAlbum', 'secondTrack']) {
        assert.equal((await database.rows('BaseItems', { where: { Id: ids[key] } })).length, 0);
        assert.equal((await database.rows('AncestorIds', { where: { ItemId: ids[key] } })).length, 0);
      }
      assert.equal((await database.rows('BaseItems', { where: { Id: ids.directAlbum } })).length, 1);
    });

  test(`${dialect}: an untyped library persists Audio and Movie files through ordinary Folders`, options, async t => {
    const { database, library, adapter, validate } = await fixture(t, dialect,
      [createAudioItemResolver(), createVideoFileResolver()]);
    const collectionId = await insertCollection(database, null);
    await adapter.write('/Song.flac', Buffer.from('audio'));
    await adapter.write('/Film (2020).mp4', Buffer.from('video'));
    await adapter.write('/Recording.3gp', Buffer.from('overlapping extension'));
    await adapter.mkdir('/Mixed');
    await adapter.write('/Mixed/Second.flac', Buffer.from('nested audio'));
    await adapter.write('/Mixed/Another (2021).mkv', Buffer.from('nested video'));
    await adapter.write('/Mixed/Other.mkv', Buffer.from('another nested video'));
    const folderPath = `${ROOT_PATH}\\Mixed`, folderId = itemId(folderPath, FOLDER_TYPE);
    const entries = [
      ['Song.flac', audioNativeType, ROOT_ID, 'Song', null],
      ['Film (2020).mp4', MOVIE_TYPE, ROOT_ID, 'Film', 2020],
      ['Recording.3gp', MOVIE_TYPE, ROOT_ID, 'Recording', null],
      ['Mixed\\Second.flac', audioNativeType, folderId, 'Second', null],
      ['Mixed\\Another (2021).mkv', MOVIE_TYPE, folderId, 'Another', 2021],
      ['Mixed\\Other.mkv', MOVIE_TYPE, folderId, 'Other', null]
    ].map(([relative, type, parentId, name, year]) => ({ relative, type, parentId, name, year,
      path: `${ROOT_PATH}\\${relative}`, id: itemId(`${ROOT_PATH}\\${relative}`, type) }));
    await validate();
    const [folder] = await database.rows('BaseItems', { where: { Id: folderId } });
    assert.equal(folder.Type, FOLDER_TYPE);
    assert.equal(folder.ParentId, ROOT_ID);
    for (const entry of entries) {
      const [row] = await database.rows('BaseItems', { where: { Id: entry.id } });
      assert.deepEqual({ type: row.Type, path: row.Path, parent: row.ParentId, name: row.Name, year: row.ProductionYear },
        { type: entry.type, path: entry.path, parent: entry.parentId, name: entry.name, year: entry.year });
      const cold = await library.getItemRecord(entry.id);
      assert.equal(cold.NativeType, entry.type);
      assert.equal(cold.ParentId, entry.parentId);
      if (entry.type === MOVIE_TYPE) assert.equal(cold.VideoType, 'VideoFile');
      assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: entry.id } }))
        .map(value => idKey(value.ParentItemId))),
      new Set([ROOT_ID, AGGREGATE_ID, collectionId, ...(entry.parentId === folderId ? [folderId] : [])].map(idKey)));
    }
    const before = await snapshot(database);
    await validate();
    assert.deepEqual(await snapshot(database), before);
    await adapter.delete('/Song.flac');
    await adapter.delete('/Film (2020).mp4');
    await validate();
    for (const entry of entries.slice(0, 2)) {
      assert.deepEqual(await database.rows('BaseItems', { where: { Id: entry.id } }), []);
      assert.deepEqual(await database.rows('AncestorIds', { where: { ItemId: entry.id } }), []);
    }
    for (const entry of entries.slice(2)) assert.equal((await library.getItemRecord(entry.id)).ParentId, entry.parentId);
  });

  test(`${dialect}: CUE albums, ordinary release names and empty music folders follow their physical hierarchy`, options,
    async t => {
      const { database, library, adapter, validate } = await fixture(t, dialect, [createAudioItemResolver()]);
      const collectionId = await insertCollection(database, 'music');
      await adapter.mkdir('/Cue Album');
      await adapter.write('/Cue Album/disc.cue', Buffer.from('cue'));
      await adapter.write('/Ignored.CUE', Buffer.from('root cue'));
      await adapter.write('/Loose.mp3', Buffer.from('loose'));
      await adapter.mkdir('/Multi Disc');
      await adapter.mkdir('/Multi Disc/DVD A');
      await adapter.mkdir('/Multi Disc/Artwork');
      await adapter.write('/Multi Disc/DVD A/Track.flac', Buffer.from('track'));
      await adapter.mkdir('/Empty Music');
      await adapter.mkdir('/Empty Music/Archive');

      await validate();
      const artistId = itemId(`${ROOT_PATH}\\Multi Disc`, musicArtistNativeType);
      const albumId = itemId(`${ROOT_PATH}\\Multi Disc\\DVD A`, musicAlbumNativeType);
      const emptyId = itemId(`${ROOT_PATH}\\Empty Music`, FOLDER_TYPE);
      for (const [relative, nativeType, parentId] of [
        ['Cue Album', musicAlbumNativeType, ROOT_ID], ['Multi Disc', musicArtistNativeType, ROOT_ID],
        ['Multi Disc\\DVD A', musicAlbumNativeType, artistId], ['Multi Disc\\Artwork', FOLDER_TYPE, artistId],
        ['Empty Music', FOLDER_TYPE, ROOT_ID], ['Empty Music\\Archive', FOLDER_TYPE, emptyId]
      ]) {
        const identityPath = `${ROOT_PATH}\\${relative}`;
        const item = await library.getItemRecord(itemId(identityPath, nativeType));
        assert.equal(item.NativeType, nativeType); assert.equal(item.Path, identityPath);
        assert.equal(item.ParentId, parentId);
      }
      const trackId = itemId(`${ROOT_PATH}\\Multi Disc\\DVD A\\Track.flac`, audioNativeType);
      const track = await library.getItemRecord(trackId);
      assert.equal(track.ParentId, albumId);
      assert.equal(idKey((await library.getItem(trackId, { EnableImages: false })).AlbumId), idKey(albumId));
      assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: trackId } })).map(row => idKey(row.ParentItemId))),
        new Set([albumId, artistId, ROOT_ID, AGGREGATE_ID, collectionId].map(idKey)));
      assert.equal((await database.rows('BaseItems')).some(item => /\.cue$/iu.test(item.Path ?? '')), false);
      const [loose] = await database.rows('BaseItems', { where: { Path: `${ROOT_PATH}\\Loose.mp3` } });
      assert.equal(loose.Type, audioNativeType);
      assert.equal(loose.ParentId, ROOT_ID);
      const before = await snapshot(database);
      await validate();
      assert.deepEqual(await snapshot(database), before);
    });

}
