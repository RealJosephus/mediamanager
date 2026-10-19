import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition, nativeModel } from '../../src/database/model.js';
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
  bookNativeType,
  episodeNativeType,
  folderScanIncompleteReasonCodes,
  FolderScanService,
  ItemCreationService,
  ItemDeletionService,
  LibraryService,
  LinkedChildReferenceService,
  seasonNativeType,
  seriesNativeType,
  musicVideoNativeType,
  parseBookFileName,
  parseAudioBookName,
  photoAlbumNativeType,
  photoNativeType,
  isNativePhotoFileName,
  isNativeAudioFileName,
  videoNativeType
} from '../../src/library/index.js';
import { ProviderRefreshService } from '../../src/metadata/provider-refresh-service.js';
import { persistMetadata, reattachUserData } from '../../src/metadata/persistence.js';
import { IdentityAccessMap, StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { knownAncestorIgnoreRule } from './ignore-namespace-fixture.js';
import { createResolvedItemLifecycleFixture } from './resolved-item-lifecycle-fixture.js';
import { dateText, nonemptyId, repositoryTopParentId } from '../../src/library/records.js';
import { nativeTextSql } from '../../src/database/native-text-sql.js';
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
const FOREIGN_ID = 'D1000000-0000-0000-0000-000000000002';
const FIRST_COLLECTION_ID = 'D1000000-0000-0000-0000-000000000003';
const SECOND_COLLECTION_ID = 'D1000000-0000-0000-0000-000000000004';
const USER_ROOT_ID = 'D1000000-0000-0000-0000-000000000005';
const ROOT_PATH = 'Z:\\DirectoryItems';
const PROGRAM_DATA_PATH = 'C:\\ProgramData\\MediaManager';
const directoryNative = parseLosslessJson(await readFile(new URL('./fixtures/directory-video-resolution/native.json', import.meta.url), 'utf8'));
const directoryInput = parseLosslessJson(await readFile(new URL('./fixtures/directory-video-resolution/input.json', import.meta.url), 'utf8'));
const musicVideoNative = parseLosslessJson(await readFile(new URL('./fixtures/music-video-resolution/native.json', import.meta.url), 'utf8'));
const musicVideoInput = parseLosslessJson(await readFile(new URL('./fixtures/music-video-resolution/input.json', import.meta.url), 'utf8'));
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

function movieClaim(primary, consumedPaths = [primary]) {
  return {
    nativeType: MOVIE_TYPE,
    primary,
    consumedPaths,
    draft: {
      Name: primary.entry.name.replace(/\.mkv$/iu, ''),
      IsFolder: false,
      MediaType: 'Video',
      SourceType: 'Library',
      columns: { IsMovie: true, IsInMixedFolder: true },
      data: { VideoType: 'VideoFile' }
    }
  };
}

const fileResolver = {
  id: 'test-movie-file',
  priority: 20,
  nativeTypes: { [MOVIE_TYPE]: { isFolder: false } },
  resolveFile({ candidate }) {
    return candidate.entry.name.toLowerCase().endsWith('.mkv') ? movieClaim(candidate) : null;
  }
};

const bundleResolver = {
  id: 'test-movie-bundle',
  priority: 10,
  nativeTypes: { [MOVIE_TYPE]: { isFolder: false } },
  resolveMultiple({ available }) {
    const primary = available.find(candidate => candidate.entry.name === 'movie.mkv');
    const sidecar = available.find(candidate => candidate.entry.name === 'movie.en.srt');
    return primary && sidecar ? {
      items: [movieClaim(primary, [primary, sidecar])],
      extraFiles: available.filter(candidate => candidate !== primary && candidate !== sidecar)
    } : null;
  }
};

const suppressingBundleResolver = {
  id: 'test-suppressing-bundle',
  priority: 10,
  nativeTypes: { [MOVIE_TYPE]: { isFolder: false } },
  resolveMultiple({ available }) {
    const primary = available.find(candidate => candidate.entry.name === 'Film.mkv');
    return primary ? { items: [movieClaim(primary)], extraFiles: [] } : null;
  }
};

const discResolver = {
  id: 'test-disc-directory',
  priority: 30,
  nativeTypes: { [MOVIE_TYPE]: { isFolder: false } },
  async resolveDirectory({ candidate, peekDirectory }) {
    const snapshot = await peekDirectory(candidate);
    if (!snapshot.candidates.some(child => child.entry.name === 'disc.marker')) return null;
    return {
      nativeType: MOVIE_TYPE,
      primary: candidate,
      consumedPaths: [candidate],
      traversal: 'none',
      draft: {
        Name: candidate.entry.name,
        IsFolder: false,
        MediaType: 'Video',
        SourceType: 'Library',
        columns: { IsMovie: true },
        data: { VideoType: 'Dvd' }
      }
    };
  }
};

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
  configuration = {}, onResolverError = () => {}, nativeActions = false, reattach = reattachUserData
} = {}) {
  const { database, schema } = await databaseFor(dialect);
  const store = new DomainStore(database);
  const registry = new StorageRegistry();
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
  const library = new LibraryService({fileSystem: testFileSystem,  store, serverId: 'directory-item-scan', configuration });
  const refreshes = new ProviderRefreshService();
  const lifecycleFixture = await createResolvedItemLifecycleFixture({ store, library, vfs, identityMap, configuration,
    now: () => '2026-09-27T01:02:03.456Z' });
  let itemCreation = null, linkedChildReferences = null;
  if (nativeActions) {
    itemCreation = new ItemCreationService({ store, library, linkedChildren:lifecycleFixture.linkedChildren, loadContext: lifecycleFixture.loadContext });
    library.itemCreation = itemCreation;
    linkedChildReferences = new LinkedChildReferenceService({ store, itemCreation,
      loadContext: lifecycleFixture.loadContext, updates: lifecycleFixture.updates });
    library.itemDeletion = new ItemDeletionService({
      store, library, itemCreation, loadContext: lifecycleFixture.loadContext,
      updates: lifecycleFixture.updates, linkedChildReferences, vfs,
      externalData: { async deleteInternalItemFiles() {}, async deleteItemFiles() {} },
      now: () => '2026-09-27T01:02:03.456Z'
    });
  }
  const resolverPipeline = new DirectoryItemResolverPipeline({ resolvers, programDataPath: PROGRAM_DATA_PATH, configuration,
    onError: onResolverError });
  await database.insert('BaseItems', baseItem(ROOT_ID, FOLDER_TYPE, {
    Name: 'Library',
    CleanName: 'library',
    SortName: 'library',
    Path: ROOT_PATH,
    TopParentId: ROOT_ID
  }));
  const scanner = new FolderScanService({
    ignoreRule: await knownAncestorIgnoreRule({ registry, vfs, identityMap, identityRoots: [ROOT_PATH] }),
    store,
    library,
    vfs,
    identityMap,
    refreshes,
    resolvedItemLifecycle: lifecycleFixture.lifecycle,
    resolverPipeline,
    itemCreation,
    linkedChildReferences,
    reattach,
    programDataPath: PROGRAM_DATA_PATH,
    configuration,
    clock: () => new Date('2026-09-27T01:02:03.456Z')
  });
  const reference = await library.getItemRecord(ROOT_ID);
  t.after(async () => {
    await scanner.close();
    await itemCreation?.close();
    await lifecycleFixture.close();
    await registry.close();
    if (dialect === 'postgres') {
      await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    }
    await database.close();
  });
  return { database, store, library, adapter, vfs, scanner, reference, lifecycleFixture,
    itemCreation, linkedChildReferences };
}

const rowOrder = (left, right) => Object.values(left).map(String).join('\0')
  .localeCompare(Object.values(right).map(String).join('\0'), 'en');

async function snapshot(database) {
  return {
    items: (await database.rows('BaseItems')).toSorted(rowOrder),
    ancestors: (await database.rows('AncestorIds')).toSorted(rowOrder)
  };
}

async function completeSnapshot(database) {
  const snapshot = {};
  for (const table of nativeModel.tables) {
    snapshot[table.name] = await database.rows(table.name);
  }
  return snapshot;
}

async function insertFailureTrigger(database, Type) {
  await database.client.query(`CREATE FUNCTION fail_reclassification() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."Type" = '${Type}' THEN RAISE EXCEPTION 'Controlled reclassification failure'; END IF; RETURN NEW; END $$`);
  await database.client.query('CREATE TRIGGER fail_reclassification BEFORE INSERT ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION fail_reclassification()');
}

async function deleteFailureTrigger(database, Id) {
  const sql=nativeTextSql(database.schemaName);
  await database.client.query(`CREATE FUNCTION fail_primary_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF ${sql.guidKey('OLD."Id"')} = '${idKey(Id)}' THEN RAISE EXCEPTION 'Controlled primary deletion failure'; END IF; RETURN OLD; END $$`);
  await database.client.query('CREATE TRIGGER fail_primary_delete BEFORE DELETE ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION fail_primary_delete()');
  return async () => {
    await database.client.query('DROP TRIGGER fail_primary_delete ON "BaseItems"');
    await database.client.query('DROP FUNCTION fail_primary_delete()');
  };
}

async function updateFailureTrigger(database) {
  await database.client.query(`CREATE FUNCTION fail_disc_stack_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Controlled disc stack update failure'; END $$`);
  await database.client.query('CREATE TRIGGER fail_disc_stack_update BEFORE UPDATE ON "BaseItems" FOR EACH ROW EXECUTE FUNCTION fail_disc_stack_update()');
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
  unsupported = false, promotion = false, folderReclassification = false
} = {}) {
  const { database, store, library, adapter, scanner, reference, lifecycleFixture,
    itemCreation, linkedChildReferences } = await fixture(t, dialect,
    [createVideoFileResolver()], { nativeActions: promotion || folderReclassification });
  const aggregateId = 'D1000000-0000-0000-0000-000000000006';
  await database.insert('BaseItems', baseItem(aggregateId,
    'MediaBrowser.Controller.Entities.AggregateFolder', {
      Name: 'Aggregate', CleanName: 'aggregate', SortName: 'aggregate', IsFolder: true
    }));
  await database.update('BaseItems', { Id: ROOT_ID }, { ParentId: aggregateId });
  await insertCollection(database, sample.collectionType);
  await createDiscSample(adapter, sample);
  const warm = await scanner.scan(reference);
  assert.equal(warm.structurallyComplete, true);
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
  const retainedLive = await library.getItemRecord(movieId);
  const retainedLiveParts = [...retainedLive.AdditionalParts];
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
  const repositoryUpdate = lifecycleFixture.updates.updateRepository.bind(lifecycleFixture.updates);
  lifecycleFixture.updates.updateRepository = (loaded, result, reason, options = {}) => repositoryUpdate(
    loaded, result, reason, {
      ...options,
      saverOperation: async () => {
        calls.push({ action: 'saver', reason });
        if (sample.cancelFromSaver) controller.abort();
        if (sample.failSaver) throw Object.assign(new Error('Controlled metadata saver failure'), {
          code: 'invalid-operation'
        });
        return [];
      },
      persist: async (updated, lifecycleResult, persistOptions) => {
        calls.push({ action: 'save' });
        return persistMetadata(store, loaded, lifecycleResult, persistOptions);
      }
    });
  for (const [eventName, kind] of [['ItemAdded', 'added'], ['ItemUpdated', 'updated'], ['ItemRemoved', 'removed']]) {
    library.on(eventName, event => {
      calls.push({ action: 'event', kind, reason: event.UpdateReason ?? null });
      if (sample.failEvent && eventName === 'ItemUpdated') throw new Error('Controlled item-updated observer failure');
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
    const reroute = linkedChildReferences.reroute.bind(linkedChildReferences);
    linkedChildReferences.reroute = async (...args) => {
      calls.push({ action: 'reroute' });
      return reroute(...args);
    };
    scanner.reattach = async (...args) => {
      calls.push({ action: 'reattach' });
      return reattachUserData(...args);
    };
  }
  const before = await completeSnapshot(database);
  if (sample.failUpdate) await updateFailureTrigger(database);

  let result = null, failure = null;
  try {
    result = await scanner.scan(reference, {
      signal: sample.cancellable ? controller.signal : undefined
    });
  } catch (error) { failure = error; }

  assert.deepEqual(retainedLive.AdditionalParts, retainedLiveParts,
    'the lifecycle reload must not mutate an older caller-owned live object');
  if (unsupported) {
    assert.equal(failure?.code, 'unsupported/type-reclassification-required');
    assert.match(failure.message, /multi-disc directory stack/u);
    assert.deepEqual(calls, [], 'identity-changing controls must fail before saver, save or event effects');
    assert.deepEqual(await completeSnapshot(database), before,
      'identity-changing controls must fail before any database change');
    return;
  }

  const actionNames = promotion || folderReclassification
    ? ['delete', 'save', 'event', 'reattach'] : ['saver', 'save', 'event'];
  const expectedActions = expected.calls.filter(call => actionNames.includes(call.action))
    .map(call => ({ action: call.action, ...(call.action === 'saver' ? { reason: call.reason }
      : call.action === 'event' ? { kind: call.kind, reason: call.reason ?? null } : {}) }));
  assert.deepEqual(calls, expectedActions,
    `candidate lifecycle side-effect prefix must match the native recording${failure ? `: ${failure.stack}` : ''}`);
  const expectedMovie = expected.rows.find(row => row.type === MOVIE_TYPE);
  const expectedFolder = folderReclassification ? expected.rows.find(value => value.type === FOLDER_TYPE
    && value.path !== '$STATE\\media') : null;
  if (expected.exception == null) {
    assert.equal(failure, null);
    assert.equal(result.structurallyComplete, !sample.failNestedCreate);
    assert.deepEqual({ added: result.added, updated: result.updated, removed: result.removed },
      sample.failNestedCreate ? { added: 1, updated: 0, removed: 1 }
        : folderReclassification ? { added: 2, updated: 0, removed: 1 }
        : promotion ? { added: 1, updated: 0, removed: 1 }
          : { added: 0, updated: 1, removed: 0 });
    if (sample.failNestedCreate) {
      assert.deepEqual(result.incompleteReasons.map(reason => reason.code),
        [folderScanIncompleteReasonCodes.NESTED_VALIDATION_FAILED]);
      assert.equal((await database.rows('BaseItems', { where: { Id: movieId } })).length, 0);
      const folderPath = expectedFolder.path.replace('$STATE\\media', ROOT_PATH);
      assert.equal((await database.rows('BaseItems', { where: { Path: folderPath } })).length, 1);
      assert.equal((await database.rows('BaseItems', { where: { Path: identityFixturePath('Film/Film Disc 2') } })).length, 0);
      return;
    }
  } else {
    assert.ok(failure, `expected ${expected.exception}`);
    if (sample.failSaver) {
      assert.equal(failure.code, 'invalid-operation');
      assert.match(failure.message, /Controlled metadata saver failure/u);
    } else if (sample.failUpdate) assert.match(failure.message, /Controlled disc stack update failure/u);
    else if (sample.cancelFromSaver) assert.equal(failure, controller.signal.reason);
    if (folderReclassification) {
      assert.equal((await database.rows('BaseItems', { where: { Id: movieId } })).length, 0,
        'the native prefix has already deleted the old identity');
      const folderPath = `${ROOT_PATH}\\${sample.entries[0]}`;
      assert.equal((await database.rows('BaseItems', { where: { Path: folderPath } })).length,
        sample.failCreateAfterDelete ? 0 : 1);
      if (sample.cancelAfterOuterAdded) assert.equal(failure, controller.signal.reason);
      return;
    }
    assert.deepEqual(await completeSnapshot(database), before, 'failed lifecycle prefixes must not change repository rows');
  }

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
  } else {
    assert.equal(row.Name, sample.mutation.Name);
    assert.equal(row.Overview, sample.mutation.Overview);
    assert.equal(row.ProductionYear, sample.mutation.ProductionYear ?? null);
    assert.deepEqual((await library.getItemRecord(movieId)).AdditionalParts, expectedParts);
  }
}

async function assertDiscPromotionRejected(t, dialect, scenario) {
  const sample = discReclassificationInput[9];
  const { database, library, adapter, vfs, scanner, reference, itemCreation,
    linkedChildReferences } = await fixture(t, dialect, [createVideoFileResolver()], { nativeActions: true });
  const aggregateId = 'D1000000-0000-0000-0000-000000000006';
  await database.insert('BaseItems', baseItem(aggregateId,
    'MediaBrowser.Controller.Entities.AggregateFolder', {
      Name: 'Aggregate', CleanName: 'aggregate', SortName: 'aggregate', IsFolder: true
    }));
  await database.update('BaseItems', { Id: ROOT_ID }, { ParentId: aggregateId });
  await insertCollection(database, sample.collectionType);
  await createDiscSample(adapter, sample);
  assert.equal((await scanner.scan(reference)).structurallyComplete, true);
  const movieId = itemId(identityFixturePath(sample.mutationPath), MOVIE_TYPE);
  const secondPath = identityFixturePath('Film/Film Disc 2');
  const targetId = itemId(secondPath, MOVIE_TYPE);

  if (scenario === 'outgoing-child-type-2' || scenario === 'incoming-child-type-3') {
    await database.insert('BaseItems', baseItem(FOREIGN_ID, MOVIE_TYPE, {
      Path: `${ROOT_PATH}\\Foreign.mkv`, ParentId: aggregateId, TopParentId: ROOT_ID,
      IsFolder: false, MediaType: 'Video', Data: JSON.stringify({ SourceType: 'Library', VideoType: 'VideoFile' })
    }));
    await database.insert('LinkedChildren', scenario === 'outgoing-child-type-2'
      ? { ParentId: movieId, SortOrder: 0, ChildId: FOREIGN_ID, ChildType: 2 }
      : { ParentId: FOREIGN_ID, SortOrder: 0, ChildId: movieId, ChildType: 3 });
  } else if (scenario === 'owned-closure') {
    await database.insert('BaseItems', baseItem(FOREIGN_ID, videoNativeType, {
      Path: `${ROOT_PATH}\\Film\\owned.mkv`, ParentId: aggregateId, TopParentId: ROOT_ID,
      OwnerId: movieId, IsFolder: false, MediaType: 'Video',
      Data: JSON.stringify({ SourceType: 'Library', VideoType: 'VideoFile' })
    }));
  } else if (scenario === 'mixed-source') {
    await database.update('BaseItems', { Id: movieId }, { IsInMixedFolder: true });
  } else if (scenario === 'target-id-collision') {
    await database.insert('BaseItems', baseItem(targetId, MOVIE_TYPE, {
      Path: `${ROOT_PATH}\\Collision.mkv`, ParentId: aggregateId, TopParentId: ROOT_ID,
      IsFolder: false, MediaType: 'Video', Data: JSON.stringify({ SourceType: 'Library', VideoType: 'VideoFile' })
    }));
  } else if (scenario === 'malformed-old-family') {
    const [row] = await database.rows('BaseItems', { where: { Id: movieId } });
    const data = JSON.parse(row.Data);
    data.AdditionalParts = [secondPath, secondPath];
    await database.update('BaseItems', { Id: movieId }, { Data: JSON.stringify(data) });
  } else if (scenario === 'local-alternate') {
    const [row] = await database.rows('BaseItems', { where: { Id: movieId } });
    const data = JSON.parse(row.Data);
    data.LocalAlternateVersions = [`${ROOT_PATH}\\alternate.mkv`];
    await database.update('BaseItems', { Id: movieId }, { Data: JSON.stringify(data) });
  } else if (scenario === 'live-family-mutation') {
    const live = await itemCreation.getItemById(movieId);
    live.AdditionalParts.reverse();
  }

  await transitionDiscSample(adapter, sample);
  if (scenario === 'weak-root' || scenario === 'weak-outer') {
    const list = vfs.list.bind(vfs), weakPath = scenario === 'weak-root' ? '/library' : '/library/Film';
    vfs.list = async (requested, options) => {
      const listing = await list(requested, options);
      return requested === weakPath ? { ...listing, consistency: 'weak', snapshot: null, deletionSafe: false } : listing;
    };
  }

  const calls = [];
  const remove = library.deleteItem.bind(library);
  library.deleteItem = async (...args) => { calls.push('delete'); return remove(...args); };
  const saveItems = itemCreation.saveItems.bind(itemCreation);
  itemCreation.saveItems = async (...args) => { calls.push('save'); return saveItems(...args); };
  const reroute = linkedChildReferences.reroute.bind(linkedChildReferences);
  linkedChildReferences.reroute = async (...args) => { calls.push('reroute'); return reroute(...args); };
  scanner.reattach = async (...args) => { calls.push('reattach'); return reattachUserData(...args); };
  for (const event of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) library.on(event, () => calls.push(event));
  const before = await completeSnapshot(database);

  await assert.rejects(scanner.scan(reference), error => {
    assert.equal(error.code, 'unsupported/type-reclassification-required');
    assert.match(error.message, /primary-loss lifecycle/u);
    return true;
  });
  assert.deepEqual(calls, [], `${scenario} must fail before delete, save, reroute, reattach or events`);
  assert.deepEqual(await completeSnapshot(database), before, `${scenario} must not change repository rows`);
}

async function assertDiscFolderRejected(t, dialect, scenario) {
  const sample = discReclassificationInput[10];
  const { database, library, adapter, vfs, scanner, reference, itemCreation,
    linkedChildReferences } = await fixture(t, dialect, [createVideoFileResolver()], { nativeActions: true });
  const aggregateId = 'D1000000-0000-0000-0000-000000000006';
  await database.insert('BaseItems', baseItem(aggregateId,
    'MediaBrowser.Controller.Entities.AggregateFolder', {
      Name: 'Aggregate', CleanName: 'aggregate', SortName: 'aggregate', IsFolder: true
    }));
  await database.update('BaseItems', { Id: ROOT_ID }, { ParentId: aggregateId });
  await insertCollection(database, sample.collectionType);
  await createDiscSample(adapter, sample);
  assert.equal((await scanner.scan(reference)).structurallyComplete, true);
  const movieId = itemId(identityFixturePath(sample.mutationPath), MOVIE_TYPE);
  const containerPath = identityFixturePath('Film');
  const nestedPath = identityFixturePath('Film/Film Disc 2');
  const folderId = itemId(containerPath, FOLDER_TYPE);
  const nestedId = itemId(nestedPath, MOVIE_TYPE);

  if (scenario === 'owned-closure') {
    await database.insert('BaseItems', baseItem(FOREIGN_ID, videoNativeType, {
      Path: `${ROOT_PATH}\\Film\\owned.mkv`, ParentId: null, TopParentId: null,
      OwnerId: movieId, IsFolder: false, MediaType: 'Video',
      Data: JSON.stringify({ SourceType: 'Library', VideoType: 'VideoFile' })
    }));
  } else if (scenario === 'version-link') {
    await database.insert('BaseItems', baseItem(FOREIGN_ID, MOVIE_TYPE, {
      Path: `${ROOT_PATH}\\Foreign.mkv`, ParentId: aggregateId, TopParentId: ROOT_ID,
      IsFolder: false, MediaType: 'Video', Data: JSON.stringify({ SourceType: 'Library', VideoType: 'VideoFile' })
    }));
    await database.insert('LinkedChildren', { ParentId: movieId, SortOrder: 0, ChildId: FOREIGN_ID, ChildType: 2 });
  } else if (scenario === 'mixed-source') {
    await database.update('BaseItems', { Id: movieId }, { IsInMixedFolder: true });
  } else if (scenario === 'outer-id-collision' || scenario === 'nested-id-collision') {
    await database.insert('BaseItems', baseItem(scenario === 'outer-id-collision' ? folderId : nestedId, MOVIE_TYPE, {
      Path: `${ROOT_PATH}\\Collision-${scenario}.mkv`, ParentId: aggregateId, TopParentId: ROOT_ID,
      IsFolder: false, MediaType: 'Video', Data: JSON.stringify({ SourceType: 'Library', VideoType: 'VideoFile' })
    }));
  } else if (scenario === 'outer-path-collision' || scenario === 'nested-path-collision') {
    await database.insert('BaseItems', baseItem(FOREIGN_ID, MOVIE_TYPE, {
      Path: scenario === 'outer-path-collision' ? containerPath : nestedPath,
      ParentId: aggregateId, TopParentId: ROOT_ID, IsFolder: false, MediaType: 'Video',
      Data: JSON.stringify({ SourceType: 'Library', VideoType: 'VideoFile' })
    }));
  } else if (scenario === 'malformed-old-family') {
    const [row] = await database.rows('BaseItems', { where: { Id: movieId } });
    const data = JSON.parse(row.Data);
    data.AdditionalParts = [nestedPath, nestedPath];
    await database.update('BaseItems', { Id: movieId }, { Data: JSON.stringify(data) });
  } else if (scenario === 'local-alternate') {
    const [row] = await database.rows('BaseItems', { where: { Id: movieId } });
    const data = JSON.parse(row.Data);
    data.LocalAlternateVersions = [`${ROOT_PATH}\\alternate.mkv`];
    await database.update('BaseItems', { Id: movieId }, { Data: JSON.stringify(data) });
  } else if (scenario === 'nondeletable-source') {
    const live = await itemCreation.getItemById(movieId);
    live.CanDelete = false;
  }

  await transitionDiscSample(adapter, sample);
  if (scenario === 'extra-native-action') await adapter.write('/Other.mkv', Buffer.from('other'));
  if (scenario === 'weak-root' || scenario === 'weak-outer' || scenario === 'incomplete-nested') {
    const list = vfs.list.bind(vfs);
    const weakPath = scenario === 'weak-root' ? '/library'
      : scenario === 'weak-outer' ? '/library/Film' : '/library/Film/Film Disc 2';
    vfs.list = async (requested, options) => {
      const listing = await list(requested, options);
      return requested === weakPath ? { ...listing, consistency: 'weak', snapshot: null, deletionSafe: false } : listing;
    };
  }
  if (scenario === 'live-family-mutation') {
    const live = await itemCreation.getItemById(movieId);
    live.AdditionalParts = [];
  }

  const calls = [];
  const remove = library.deleteItem.bind(library);
  library.deleteItem = async (...args) => { calls.push('delete'); return remove(...args); };
  const saveItems = itemCreation.saveItems.bind(itemCreation);
  itemCreation.saveItems = async (...args) => { calls.push('save'); return saveItems(...args); };
  const reroute = linkedChildReferences.reroute.bind(linkedChildReferences);
  linkedChildReferences.reroute = async (...args) => { calls.push('reroute'); return reroute(...args); };
  scanner.reattach = async (...args) => { calls.push('reattach'); return reattachUserData(...args); };
  for (const event of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) library.on(event, () => calls.push(event));
  const before = await completeSnapshot(database);

  await assert.rejects(scanner.scan(reference), error => {
    assert.equal(error.code, 'unsupported/type-reclassification-required');
    assert.match(error.message, /multi-disc directory stack/u);
    return true;
  });
  assert.deepEqual(calls, [], `${scenario} must fail before delete, save, reroute, reattach or events`);
  assert.deepEqual(await completeSnapshot(database), before, `${scenario} must not change repository rows`);
}

for (const dialect of ['postgres']) {
  const options = { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES };

  test(`${dialect}: Book files and single-file directories preserve native identities and metadata`, options, async t => {
    const { database, adapter, scanner, reference } = await fixture(t, dialect, [createBookItemResolver()]);
    const collectionId = await insertCollection(database, 'books');
    await adapter.write('/The Novel (Saga, #2) (2024).epub', Buffer.from('novel'));
    await adapter.mkdir('/Chronicles #3');
    await adapter.write('/Chronicles #3/edition.pdf', Buffer.from('edition'));
    await adapter.mkdir('/Shelf');
    await adapter.write('/Shelf/01 - First (2020).pdf', Buffer.from('first'));
    await adapter.write('/Shelf/Second.mobi', Buffer.from('second'));

    const paths = {
      direct: `${ROOT_PATH}\\The Novel (Saga, #2) (2024).epub`,
      collapsedDirectory: `${ROOT_PATH}\\Chronicles #3`,
      collapsedFile: `${ROOT_PATH}\\Chronicles #3\\edition.pdf`,
      shelf: `${ROOT_PATH}\\Shelf`,
      first: `${ROOT_PATH}\\Shelf\\01 - First (2020).pdf`,
      second: `${ROOT_PATH}\\Shelf\\Second.mobi`
    };
    const ids = {
      direct: itemId(paths.direct, bookNativeType),
      collapsed: itemId(paths.collapsedFile, bookNativeType),
      shelf: itemId(paths.shelf, FOLDER_TYPE),
      first: itemId(paths.first, bookNativeType),
      second: itemId(paths.second, bookNativeType)
    };

    const result = await scanner.scan(reference);

    assert.equal(result.structurallyComplete, true);
    assert.deepEqual(scanner.capabilities.productionMediaScopes, ['book-files-and-single-file-directories']);
    const rows = {};
    for (const [name, Id] of Object.entries(ids)) {
      [rows[name]] = await database.rows('BaseItems', { where: { Id } });
    }
    assert.deepEqual({ type: rows.direct.Type, name: rows.direct.Name, path: rows.direct.Path,
      parent: rows.direct.ParentId, mediaType: rows.direct.MediaType, mixed: rows.direct.IsInMixedFolder,
      series: rows.direct.SeriesName, index: rows.direct.IndexNumber, parentIndex: rows.direct.ParentIndexNumber,
      year: rows.direct.ProductionYear },
    { type: bookNativeType, name: 'The Novel', path: paths.direct, parent: ROOT_ID, mediaType: 'Book', mixed: true,
      series: 'Saga', index: 2, parentIndex: null, year: 2024 });
    assert.deepEqual({ type: rows.collapsed.Type, name: rows.collapsed.Name, path: rows.collapsed.Path,
      parent: rows.collapsed.ParentId, mixed: rows.collapsed.IsInMixedFolder, series: rows.collapsed.SeriesName,
      index: rows.collapsed.IndexNumber },
    { type: bookNativeType, name: 'Chronicles #3', path: paths.collapsedFile,
      parent: ROOT_ID, mixed: false, series: 'Chronicles', index: 3 });
    assert.equal((await database.rows('BaseItems', { where: { Path: paths.collapsedDirectory } })).length, 0);
    assert.equal(rows.shelf.Type, FOLDER_TYPE);
    assert.equal(rows.shelf.ParentId, ROOT_ID);
    assert.deepEqual({ name: rows.first.Name, parent: rows.first.ParentId, series: rows.first.SeriesName,
      index: rows.first.IndexNumber, year: rows.first.ProductionYear, mixed: rows.first.IsInMixedFolder },
    { name: 'First', parent: ids.shelf, series: 'Shelf', index: 1, year: 2020, mixed: true });
    assert.deepEqual({ name: rows.second.Name, parent: rows.second.ParentId, series: rows.second.SeriesName },
      { name: 'Second', parent: ids.shelf, series: 'Shelf' });
    const ancestors = new Set((await database.rows('AncestorIds', { where: { ItemId: ids.first } }))
      .map(row => idKey(row.ParentItemId)));
    assert.deepEqual(ancestors, new Set([idKey(ids.shelf), idKey(ROOT_ID), idKey(collectionId)]));
    const repeated = await scanner.scan(reference);
    assert.deepEqual({ added: repeated.added, updated: repeated.updated, removed: repeated.removed },
      { added: 0, updated: 0, removed: 0 });
  });

  test(`${dialect}: AudioBook multi, file and collapsed-directory branches preserve native fields`, options, async t => {
    const { database, adapter, scanner, reference } = await fixture(t, dialect,
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

    const result = await scanner.scan(reference);

    assert.equal(result.structurallyComplete, true);
    assert.deepEqual(scanner.capabilities.productionMediaScopes,
      ['book-files-and-single-file-directories', 'audiobook-files-and-single-file-directories']);
    const rows = {};
    for (const [name, Id] of Object.entries(ids)) {
      [rows[name]] = await database.rows('BaseItems', { where: { Id } });
    }
    assert.deepEqual({ type: rows.narration.Type, name: rows.narration.Name, parent: rows.narration.ParentId,
      mediaType: rows.narration.MediaType, unrated: rows.narration.UnratedType,
      mixed: rows.narration.IsInMixedFolder, data: rows.narration.Data },
    { type: audioBookNativeType, name: 'Narration', parent: ROOT_ID, mediaType: 'Audio', unrated: 'Book',
      mixed: true, data: null });
    assert.deepEqual({ name: rows.remote.Name, mixed: rows.remote.IsInMixedFolder, data: rows.remote.Data },
      { name: 'Remote', mixed: true, data: null });
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
    new Set([idKey(ids.chapters), idKey(ROOT_ID), idKey(collectionId)]));
    const repeated = await scanner.scan(reference);
    assert.deepEqual({ added: repeated.added, updated: repeated.updated, removed: repeated.removed },
      { added: 0, updated: 0, removed: 0 });
  });

  test(`${dialect}: Photo albums retain videos while excluding artwork and video-owned images`, options, async t => {
    const { database, library, adapter, scanner, reference } = await fixture(t, dialect,
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

    const result = await scanner.scan(reference);

    assert.equal(result.structurallyComplete, true);
    assert.deepEqual(scanner.capabilities.productionMediaScopes,
      ['photos-and-homevideos-photo-albums', 'ordinary-movies-homevideos-and-musicvideos']);
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
    assert.deepEqual(ancestors, new Set([idKey(ids.album), idKey(ROOT_ID), idKey(collectionId)]));
    assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: ids.video } }))
      .map(row => idKey(row.ParentItemId))), ancestors);
    const repeated = await scanner.scan(reference);
    assert.deepEqual({ added: repeated.added, updated: repeated.updated, removed: repeated.removed },
      { added: 0, updated: 0, removed: 0 });
  });

  test(`${dialect}: a surviving Book identity moves across collapsed and Folder shapes`, options, async t => {
    const { database, adapter, scanner, reference } = await fixture(t, dialect, [createBookItemResolver()]);
    const collectionId = await insertCollection(database, 'books');
    await adapter.mkdir('/Dynamic');
    await adapter.write('/Dynamic/Story.pdf', Buffer.from('story'));
    const directoryPath = `${ROOT_PATH}\\Dynamic`;
    const storyPath = `${directoryPath}\\Story.pdf`;
    const secondPath = `${directoryPath}\\Second.epub`;
    const folderId = itemId(directoryPath, FOLDER_TYPE);
    const storyId = itemId(storyPath, bookNativeType);
    const secondId = itemId(secondPath, bookNativeType);

    await scanner.scan(reference);
    await database.update('BaseItems', { Id: storyId }, {
      Name: 'Provider Story', Overview: 'Preserved provider metadata'
    });
    await adapter.write('/Dynamic/Second.epub', Buffer.from('second'));
    const expanded = await scanner.scan(reference);

    assert.equal(expanded.structurallyComplete, true);
    const [folder] = await database.rows('BaseItems', { where: { Id: folderId } });
    const [expandedStory] = await database.rows('BaseItems', { where: { Id: storyId } });
    const [second] = await database.rows('BaseItems', { where: { Id: secondId } });
    assert.equal(folder.Type, FOLDER_TYPE);
    assert.deepEqual({ parent: expandedStory.ParentId, mixed: expandedStory.IsInMixedFolder,
      name: expandedStory.Name, overview: expandedStory.Overview },
    { parent: folderId, mixed: true, name: 'Provider Story', overview: 'Preserved provider metadata' });
    assert.equal(second.ParentId, folderId);
    assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: storyId } }))
      .map(row => idKey(row.ParentItemId))),
    new Set([idKey(folderId), idKey(ROOT_ID), idKey(collectionId)]));

    await adapter.delete('/Dynamic/Second.epub');
    const beforeFailedCollapse = await completeSnapshot(database);
    const dropFailure = await deleteFailureTrigger(database, folderId);
    await assert.rejects(scanner.scan(reference), /Controlled primary deletion failure/);
    assert.deepEqual(await completeSnapshot(database), beforeFailedCollapse,
      'a failed Folder deletion rolls the cross-parent Book move back');
    await dropFailure();
    const collapsed = await scanner.scan(reference);

    assert.equal(collapsed.structurallyComplete, true);
    assert.equal((await database.rows('BaseItems', { where: { Id: folderId } })).length, 0);
    assert.equal((await database.rows('BaseItems', { where: { Id: secondId } })).length, 0);
    const [collapsedStory] = await database.rows('BaseItems', { where: { Id: storyId } });
    assert.deepEqual({ parent: collapsedStory.ParentId, mixed: collapsedStory.IsInMixedFolder,
      name: collapsedStory.Name, overview: collapsedStory.Overview },
    { parent: ROOT_ID, mixed: false, name: 'Provider Story', overview: 'Preserved provider metadata' });
    assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: storyId } }))
      .map(row => idKey(row.ParentItemId))), new Set([idKey(ROOT_ID), idKey(collectionId)]));
  });

  test(`${dialect}: a surviving AudioBook identity moves across collapsed and Folder shapes`, options, async t => {
    const { database, adapter, scanner, reference } = await fixture(t, dialect, [createAudioBookItemResolver()]);
    const collectionId = await insertCollection(database, 'books');
    await adapter.mkdir('/Dynamic Audio');
    await adapter.write('/Dynamic Audio/Story.m4b', Buffer.from('story'));
    const directoryPath = `${ROOT_PATH}\\Dynamic Audio`;
    const storyPath = `${directoryPath}\\Story.m4b`;
    const secondPath = `${directoryPath}\\Second.mp3`;
    const folderId = itemId(directoryPath, FOLDER_TYPE);
    const storyId = itemId(storyPath, audioBookNativeType);
    const secondId = itemId(secondPath, audioBookNativeType);

    await scanner.scan(reference);
    await database.update('BaseItems', { Id: storyId }, {
      Name: 'Provider Narration', Overview: 'Preserved audiobook metadata'
    });
    await adapter.write('/Dynamic Audio/Second.mp3', Buffer.from('second'));
    const expanded = await scanner.scan(reference);

    assert.equal(expanded.structurallyComplete, true);
    const [folder] = await database.rows('BaseItems', { where: { Id: folderId } });
    const [expandedStory] = await database.rows('BaseItems', { where: { Id: storyId } });
    const [second] = await database.rows('BaseItems', { where: { Id: secondId } });
    assert.equal(folder.Type, FOLDER_TYPE);
    assert.deepEqual({ parent: expandedStory.ParentId, mixed: expandedStory.IsInMixedFolder,
      name: expandedStory.Name, overview: expandedStory.Overview },
    { parent: folderId, mixed: true, name: 'Provider Narration', overview: 'Preserved audiobook metadata' });
    assert.equal(second.ParentId, folderId);
    assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: storyId } }))
      .map(row => idKey(row.ParentItemId))),
    new Set([idKey(folderId), idKey(ROOT_ID), idKey(collectionId)]));

    await adapter.delete('/Dynamic Audio/Second.mp3');
    const beforeFailedCollapse = await completeSnapshot(database);
    const dropFailure = await deleteFailureTrigger(database, folderId);
    await assert.rejects(scanner.scan(reference), /Controlled primary deletion failure/);
    assert.deepEqual(await completeSnapshot(database), beforeFailedCollapse,
      'a failed Folder deletion rolls the cross-parent AudioBook move back');
    await dropFailure();
    const collapsed = await scanner.scan(reference);

    assert.equal(collapsed.structurallyComplete, true);
    assert.equal((await database.rows('BaseItems', { where: { Id: folderId } })).length, 0);
    assert.equal((await database.rows('BaseItems', { where: { Id: secondId } })).length, 0);
    const [collapsedStory] = await database.rows('BaseItems', { where: { Id: storyId } });
    assert.deepEqual({ parent: collapsedStory.ParentId, mixed: collapsedStory.IsInMixedFolder,
      name: collapsedStory.Name, overview: collapsedStory.Overview },
    { parent: ROOT_ID, mixed: false, name: 'Provider Narration', overview: 'Preserved audiobook metadata' });
    assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: storyId } }))
      .map(row => idKey(row.ParentItemId))), new Set([idKey(ROOT_ID), idKey(collectionId)]));
  });

  for (const sceneName of ['directory-single-raw-name', 'directory-qualified-raw-name', 'directory-versions-exact',
    'directory-versions-no-exact', 'directory-stack', 'directory-stack-versions', 'provider-directory-priority',
    'parent-lock', 'resolve-date-added', 'directory-version-formats', 'bracket-format-provider', 'unicode-version-prefix']) {
    test(`${dialect}: production scanner preserves native MusicVideo initialization ${sceneName}`, options, async t => {
      const name = `resolve-${sceneName}`, sample = musicVideoInput.find(value => value.name === name);
      const expected = musicVideoNative.results.find(value => value.name === name).resolved[0];
      const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [createVideoFileResolver()]);
      await insertCollection(database, 'musicvideos');
      scanner.metadataConfiguration = { UseFileCreationTimeForDateAdded: !sample.useResolveTime };
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
      const result = await scanner.scan(reference);
      assert.equal(result.structurallyComplete, true);
      const Path = expected.path.replace('$STATE\\media', ROOT_PATH);
      const [row] = await database.rows('BaseItems', { where: { Path } });
      assert.ok(row);
      const item = await library.getItemRecord(row.Id);
      assert.deepEqual({ type: row.Type, name: row.Name, mediaType: row.MediaType, mixed: row.IsInMixedFolder,
        locked: row.IsLocked, productionYear: row.ProductionYear, providerIds: item.ProviderIds,
        video3DFormat: item.Video3DFormat ?? null, parts: item.AdditionalParts.map(value => value.replace(ROOT_PATH, '$STATE\\media')),
        alternates: item.LocalAlternateVersions.map(value => value.replace(ROOT_PATH, '$STATE\\media')),
        dateCreated: dateText(row.DateCreated), dateModified: dateText(row.DateModified) },
      { type: expected.type, name: expected.name, mediaType: expected.mediaType, mixed: expected.mixed,
        locked: expected.locked, productionYear: expected.productionYear, providerIds: expected.providerIds,
        video3DFormat: expected.video3DFormat, parts: expected.parts, alternates: expected.alternates,
        dateCreated: expected.dateCreated === '$UTC_RESOLVE' ? '2026-09-27T01:02:03.4560000Z' : expected.dateCreated,
        dateModified: expected.dateModified });
      assert.equal(row.Type, musicVideoNativeType);
      assert.equal(row.UnratedType, 'Music');
      assert.equal(row.ParentId, ROOT_ID);
      assert.equal(row.TopParentId, ROOT_ID);
      assert.equal(row.IsMovie, false);
      const repeated = await scanner.scan(reference);
      assert.equal(repeated.added, 0);
      assert.equal(repeated.removed, 0);
      assert.equal(repeated.structurallyComplete, true);
    });
  }

  for (const [collectionType, nativeType] of [['musicvideos', musicVideoNativeType], ['movies', MOVIE_TYPE]]) {
    test(`${dialect}: ${collectionType} collapsed versions promote through native identities`, options, async t => {
      const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [createVideoFileResolver()]);
      await insertCollection(database, collectionType);
      await adapter.mkdir('/Concert');
      await adapter.write('/Concert/Concert.mkv', Buffer.from('original'));
      await adapter.write('/Concert/Concert - 1080p.hsbs.mkv', Buffer.from('alternate'));
      const primaryPath = `${ROOT_PATH}\\Concert\\Concert.mkv`;
      const alternatePath = `${ROOT_PATH}\\Concert\\Concert - 1080p.hsbs.mkv`;
      const primaryId = itemId(primaryPath, nativeType), alternateId = itemId(alternatePath, nativeType);
      const first = await scanner.scan(reference);
      assert.equal(first.structurallyComplete, true);
      assert.equal(first.added, 1);
      assert.equal((await database.rows('BaseItems', { where: { Type: nativeType } })).length, 2);
      let [alternate] = await database.rows('BaseItems', { where: { Id: alternateId } });
      assert.equal(alternate.OwnerId, primaryId);
      assert.equal(alternate.PrimaryVersionId, primaryId);
      assert.equal((await library.getItemRecord(alternateId)).Video3DFormat, 'HalfSideBySide');
      const alternateName = alternate.Name;
      const before = await completeSnapshot(database), events = [];
      for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
        library.on(name, event => events.push([name, event.Item.Id]));
      }
      await adapter.delete('/Concert/Concert.mkv');
      const dropFailure = await deleteFailureTrigger(database, primaryId);
      await assert.rejects(scanner.scan(reference), /Controlled primary deletion failure/);
      assert.deepEqual(await completeSnapshot(database), before,
        'a failed old-primary delete rolls back promotion, links and every relationship');
      assert.deepEqual(events, []);
      await dropFailure();
      const promoted = await scanner.scan(reference);
      assert.equal(promoted.structurallyComplete, true);
      assert.equal(promoted.removed, 1);
      assert.equal((await database.rows('BaseItems', { where: { Id: primaryId } })).length, 0);
      [alternate] = await database.rows('BaseItems', { where: { Id: alternateId } });
      assert.equal(alternate.OwnerId, null);
      assert.equal(alternate.PrimaryVersionId, null);
      assert.equal(alternate.ParentId, ROOT_ID);
      assert.equal((await library.getItemRecord(alternateId)).Name, alternateName);
      assert.deepEqual(await database.rows('LinkedChildren', { where: { ParentId: primaryId } }), []);
      const repeated = await scanner.scan(reference);
      assert.equal(repeated.structurallyComplete, true);
      assert.equal(repeated.added, 0);
      assert.equal(repeated.removed, 0);
    });
  }

  for (const sampleName of ['directory-folder-provider-id', 'directory-file-provider-id', 'directory-provider-short-aliases',
    'directory-inherited-parent-lock', 'directory-file-resolve-clock', 'directory-mixed-stack-tokens',
    'directory-numeric-stack', 'directory-local-versions', 'directory-two-stacked-versions']) {
    test(`${dialect}: scanner persists native resolver initial fields ${sampleName}`, options, async t => {
      const sample = directoryInput.find(value => value.name === sampleName), expected = directoryNative.results.find(value => value.name === sampleName).resolved[0];
      const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [createVideoFileResolver()]);
      await insertCollection(database, 'movies');
      scanner.metadataConfiguration = { UseFileCreationTimeForDateAdded: !sample.useResolveTime };
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
      const result = await scanner.scan(reference);
      assert.equal(result.structurallyComplete, true);
      const identityPath = expected.path.replace('$STATE\\media', ROOT_PATH);
      const [row] = await database.rows('BaseItems', { where: { Path: identityPath } });
      assert.ok(row);
      const item = await library.getItemRecord(row.Id);
      // This assertion covers initialization and real relation persistence.
      // Full CreateItems/SaveItems Data, owned dispatch and event equivalence
      // have a separate outstanding native scan contract.
      assert.deepEqual({ type: row.Type, name: row.Name, isFolder: row.IsFolder, mediaType: row.MediaType,
        mixed: row.IsInMixedFolder, locked: row.IsLocked, productionYear: row.ProductionYear,
        size: row.Size == null ? null : Number(row.Size), providerIds: item.ProviderIds,
        parts: item.IsFolder ? null : (item.AdditionalParts ?? []).map(value => value.replace(ROOT_PATH, '$STATE\\media')),
        alternates: item.IsFolder ? null : (item.LocalAlternateVersions ?? []).map(value => value.replace(ROOT_PATH, '$STATE\\media')),
        dateCreated: dateText(row.DateCreated), dateModified: dateText(row.DateModified) },
      { type: expected.type, name: expected.name, isFolder: expected.isFolder, mediaType: expected.mediaType,
        mixed: expected.mixed, locked: expected.locked, productionYear: expected.productionYear,
        size: expected.size, providerIds: expected.providerIds, parts: expected.parts, alternates: expected.alternates,
        dateCreated: expected.dateCreated === '$UTC_RESOLVE' ? '2026-09-27T01:02:03.4560000Z' : expected.dateCreated,
        dateModified: expected.dateModified });
    });
  }

  test(`${dialect}: sibling claims create media and folders, preserve file metadata on validation, then delete media`, options, async t => {
    const { database, store, library, adapter, scanner, reference } = await fixture(t, dialect,
      [bundleResolver, fileResolver]);
    await adapter.write('/movie.mkv', Buffer.from('one'), { modified: '2026-09-27T00:00:00.000Z' });
    await adapter.write('/movie.en.srt', Buffer.from('subtitle'));
    await adapter.mkdir('/Shelf');

    let transactionReturned = false;
    const transaction = store.transaction.bind(store);
    store.transaction = async (...args) => {
      const result = await transaction(...args);
      transactionReturned = true;
      return result;
    };
    const events = [];
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
      library.on(name, event => events.push({ name, id: idKey(event.Item.Id), afterCommit: transactionReturned,
        dataType: typeof event.Item.Data, sourceType: event.Item.SourceType }));
    }

    const movieId = itemId(`${ROOT_PATH}\\movie.mkv`, MOVIE_TYPE);
    const shelfId = itemId(`${ROOT_PATH}\\Shelf`, FOLDER_TYPE);
    await scanner.scan(reference);

    const movie = (await database.rows('BaseItems', { where: { Id: movieId } }))[0];
    const shelf = (await database.rows('BaseItems', { where: { Id: shelfId } }))[0];
    assert.equal(movie.Type, MOVIE_TYPE);
    assert.equal(movie.Size, 3n);
    assert.equal(movie.ParentId, ROOT_ID);
    assert.equal(shelf.Type, FOLDER_TYPE);
    assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: movieId } }))
      .map(row => idKey(row.ParentItemId))), new Set([idKey(ROOT_ID)]));
    assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: shelfId } }))
      .map(row => idKey(row.ParentItemId))), new Set([idKey(ROOT_ID)]));
    assert.deepEqual(events.map(event => [event.name, event.id]), [
      ['ItemAdded', idKey(movieId)],
      ['ItemAdded', idKey(shelfId)]
    ]);
    assert.ok(events.every(event => event.afterCommit), 'library changes publish only after the scan transaction returns');
    assert.equal((await database.rows('BaseItems', { where: { Path: `${ROOT_PATH}\\movie.en.srt` } })).length, 0,
      'the multi resolver consumes its sidecar without creating a second item');

    await database.update('BaseItems', { Id: movieId }, {
      Name: 'Provider title',
      Overview: 'Provider overview',
      Data: JSON.stringify({ ...JSON.parse(movie.Data), ProviderState: { imported: true } })
    });
    events.length = 0;
    transactionReturned = false;
    await scanner.scan(reference);
    assert.deepEqual(events, [], 'an unchanged second scan is idempotent');
    const preserved = (await database.rows('BaseItems', { where: { Id: movieId } }))[0];
    assert.equal(preserved.Name, 'Provider title');
    assert.equal(preserved.Overview, 'Provider overview');
    assert.deepEqual(JSON.parse(preserved.Data).ProviderState, { imported: true },
      'validation preserves provider state');

    const previousSaved = movie.DateLastSaved;
    await adapter.write('/movie.mkv', Buffer.from('expanded'), { modified: '2026-09-28T00:00:00.000Z' });
    transactionReturned = false;
    await scanner.scan(reference);
    const updated = (await database.rows('BaseItems', { where: { Id: movieId } }))[0];
    assert.equal(updated.Size, movie.Size);
    assert.equal(updated.DateModified, movie.DateModified);
    assert.equal(updated.DateLastSaved, previousSaved);
    assert.deepEqual(events, [], 'file changes are processed by metadata refresh, outside UpdateFromResolvedItem');

    events.length = 0;
    await adapter.delete('/movie.mkv');
    transactionReturned = false;
    await scanner.scan(reference);
    assert.equal((await database.rows('BaseItems', { where: { Id: movieId } })).length, 0);
    assert.equal((await database.rows('AncestorIds', { where: { ItemId: movieId } })).length, 0);
    assert.equal((await database.rows('BaseItems', { where: { Id: shelfId } })).length, 1);
    assert.deepEqual(events.map(event => [event.name, event.id]), [['ItemRemoved', idKey(movieId)]]);
    assert.ok(events.every(event => event.afterCommit));
  });

  test(`${dialect}: a directory media claim suppresses Folder fallback and recursion`, options, async t => {
    const { database, adapter, vfs, scanner, reference } = await fixture(t, dialect,
      [fileResolver, discResolver]);
    await adapter.mkdir('/Disc');
    await adapter.write('/Disc/disc.marker', Buffer.from('disc'));
    await adapter.write('/Disc/hidden.mkv', Buffer.from('must not be scanned'));
    const lists = [];
    const list = vfs.list.bind(vfs);
    vfs.list = async (...args) => { lists.push(args[0]); return list(...args); };

    await scanner.scan(reference);

    const discPath = `${ROOT_PATH}\\Disc`;
    const rows = await database.rows('BaseItems', { where: { Path: discPath } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Type, MOVIE_TYPE);
    assert.equal(rows[0].IsFolder, false);
    assert.equal(JSON.parse(rows[0].Data).VideoType, 'Dvd');
    assert.equal((await database.rows('BaseItems', { where: { Path: `${discPath}\\hidden.mkv` } })).length, 0);
    assert.equal(lists.filter(value => value === '/library/Disc').length, 1,
      'the resolver peek is cached and the claimed directory is not traversed as a Folder');
  });

  test(`${dialect}: directory resolver peeks expose only the native ignore-filtered child snapshot`, options, async t => {
    const inspectingResolver = {
      id: 'test-ignore-filtered-peek',
      nativeTypes: { [MOVIE_TYPE]: { isFolder: false } },
      async resolveDirectory({ candidate, peekDirectory }) {
        const snapshot = await peekDirectory(candidate);
        const leaked = snapshot.candidates.some(child => child.entry.name === 'small.jpg')
          || snapshot.listing.entries.some(entry => entry.name === 'small.jpg');
        return leaked ? movieClaim(candidate) : null;
      }
    };
    const { database, adapter, scanner, reference } = await fixture(t, dialect, [inspectingResolver]);
    await adapter.mkdir('/Peek');
    await adapter.write('/Peek/small.jpg', Buffer.from('ignored child'));

    await scanner.scan(reference);

    const path = `${ROOT_PATH}\\Peek`;
    const rows = await database.rows('BaseItems', { where: { Path: path } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Type, FOLDER_TYPE,
      'the ignored child cannot influence a directory resolver before Folder fallback');
    assert.equal((await database.rows('BaseItems', { where: { Path: `${path}\\small.jpg` } })).length, 0);
  });

  test(`${dialect}: Folder to directory Movie reclassification commits removal and creation atomically`, options, async t => {
    const { database, library, adapter, scanner, reference } = await fixture(t, dialect,
      [fileResolver, discResolver]);
    await adapter.mkdir('/Disc');
    await scanner.scan(reference);

    const discPath = `${ROOT_PATH}\\Disc`;
    const folderId = itemId(discPath, FOLDER_TYPE);
    assert.equal((await database.rows('BaseItems', { where: { Id: folderId } }))[0].Type, FOLDER_TYPE);
    const events = [];
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
      library.on(name, event => events.push([name, idKey(event.Item.Id)]));
    }
    await adapter.write('/a-good.mkv', Buffer.from('planned before the conflict'));
    await adapter.write('/Disc/disc.marker', Buffer.from('disc'));

    const result = await scanner.scan(reference);
    const discId = itemId(discPath, MOVIE_TYPE);
    assert.equal(result.added, 2);
    assert.equal(result.removed, 1);
    assert.equal(result.structurallyComplete, true);
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: folderId } }), []);
    assert.equal((await database.rows('BaseItems', { where: { Id: discId } }))[0].Type, MOVIE_TYPE);
    assert.deepEqual(events, [
      ['ItemRemoved', idKey(folderId)],
      ['ItemAdded', idKey(itemId(`${ROOT_PATH}\\a-good.mkv`, MOVIE_TYPE))],
      ['ItemAdded', idKey(discId)]
    ]);
    assert.equal((await database.rows('BaseItems', { where: {
      Id: itemId(`${ROOT_PATH}\\a-good.mkv`, MOVIE_TYPE)
    } })).length, 1);
    assert.equal(scanner.capabilities.typeReclassification, true);
    assert.equal(scanner.capabilities.secondaryOwnershipTransfer, false);
    assert.equal(scanner.capabilities.groupedOwnership, false);
    assert.equal(scanner.capabilities.relationshipRows, false);
    assert.equal(scanner.capabilities.completeLibraryScan, false);
    assert.equal(scanner.capabilities.scansMediaFiles, false);
  });

  test(`${dialect}: directory reclassification removes descendant state and can restore the Folder shape`, options, async t => {
    const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [fileResolver, discResolver]);
    await adapter.mkdir('/Disc');
    await adapter.write('/Disc/child.mkv', Buffer.from('original media'));
    await scanner.scan(reference);
    const path = `${ROOT_PATH}\\Disc`, folderId = itemId(path, FOLDER_TYPE), discId = itemId(path, MOVIE_TYPE);
    const childId = itemId(`${path}\\child.mkv`, MOVIE_TYPE);
    const userId = 'D1000000-0000-0000-0000-000000000006';
    const personId = 'D1000000-0000-0000-0000-000000000007';
    const valueId = 'D1000000-0000-0000-0000-000000000008';
    const orphanId = 'D1000000-0000-0000-0000-000000000009';
    await database.insert('Users', { ...blank('Users'), Id: userId, InternalId: 1,
      Username: 'Fixture', NormalizedUsername: 'FIXTURE' });
    await database.insert('Peoples', { ...blank('Peoples'), Id: personId, Name: 'Fixture credit' });
    await database.insert('PeopleBaseItemMap', { ...blank('PeopleBaseItemMap'), ItemId: childId, PeopleId: personId });
    await database.insert('ItemValues', { ...blank('ItemValues'), ItemValueId: valueId, Type: 99, Value: 'unknown-linked' });
    await database.insert('ItemValues', { ...blank('ItemValues'), ItemValueId: orphanId, Type: 99, Value: 'old-orphan' });
    await database.insert('ItemValuesMap', { ItemId: childId, ItemValueId: valueId });
    for (const [index, ItemId] of [childId, ROOT_ID].entries()) {
      await database.insert('CustomItemDisplayPreferences', { ...blank('CustomItemDisplayPreferences'), Id: index + 1,
        ItemId, UserId: userId, Client: 'Fixture', Key: 'Layout', Value: 'List' });
      await database.insert('ItemDisplayPreferences', { ...blank('ItemDisplayPreferences'), Id: index + 1,
        ItemId, UserId: userId, Client: 'Fixture', SortBy: 'Name' });
      await database.insert('MediaSegments', { ...blank('MediaSegments'), Id: ItemId, ItemId,
        SegmentProviderId: 'Fixture', StartTicks: 9007199254740993n, EndTicks: 9223372036854775807n, Type: 1 });
      await database.insert('TrickplayInfos', { ...blank('TrickplayInfos'), ItemId, Width: 320 });
    }
    const sentinels = {};
    for (const table of ['CustomItemDisplayPreferences', 'ItemDisplayPreferences', 'MediaSegments', 'TrickplayInfos']) {
      sentinels[table] = await database.rows(table, { where: { ItemId: ROOT_ID } });
    }
    const events = [];
    for (const name of ['ItemAdded', 'ItemRemoved']) library.on(name, event => events.push([name, idKey(event.Item.Id)]));
    await adapter.write('/Disc/disc.marker', Buffer.from('disc'));
    const result = await scanner.scan(reference);
    assert.equal(result.removed, 2);
    assert.equal(result.added, 1);
    assert.deepEqual(events, [['ItemRemoved', idKey(childId)], ['ItemRemoved', idKey(folderId)], ['ItemAdded', idKey(discId)]]);
    for (const Id of [folderId, childId]) assert.deepEqual(await database.rows('BaseItems', { where: { Id } }), []);
    for (const table of Object.keys(sentinels)) {
      assert.deepEqual(await database.rows(table, { where: { ItemId: childId } }), [], `${table} must not retain detached state`);
      assert.deepEqual(await database.rows(table, { where: { ItemId: ROOT_ID } }), sentinels[table], `${table} preserves another item's state`);
    }
    assert.deepEqual(await database.rows('Peoples', { where: { Id: personId } }), []);
    assert.equal((await database.rows('ItemValues', { where: { ItemValueId: valueId } })).length, 1,
      'native orphan cleanup runs before deleting the linked target');
    assert.deepEqual(await database.rows('ItemValues', { where: { ItemValueId: orphanId } }), []);
    assert.equal((await adapter.stat('/Disc/child.mkv')).size, 14n, 'database deletion keeps source media');

    events.length = 0;
    await adapter.delete('/Disc/disc.marker');
    await scanner.scan(reference);
    assert.deepEqual(await database.rows('BaseItems', { where: { Id: discId } }), []);
    assert.equal((await database.rows('BaseItems', { where: { Id: folderId } }))[0].IsFolder, true);
    assert.equal((await database.rows('BaseItems', { where: { Id: childId } })).length, 1);
    assert.deepEqual(events, [['ItemRemoved', idKey(discId)], ['ItemAdded', idKey(folderId)], ['ItemAdded', idKey(childId)]]);
  });

  test(`${dialect}: collection changes reclassify an ordinary Video to Movie and back`, options, async t => {
    const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [createVideoFileResolver()]);
    const collectionId = await insertCollection(database, 'homevideos');
    await adapter.write('/Film (2020).mkv', Buffer.from('source media'));
    await scanner.scan(reference);
    const path = `${ROOT_PATH}\\Film (2020).mkv`, videoId = itemId(path, videoNativeType), movieId = itemId(path, MOVIE_TYPE);
    assert.equal((await database.rows('BaseItems', { where: { Id: videoId } })).length, 1);
    const events = [];
    for (const name of ['ItemAdded', 'ItemRemoved']) library.on(name, event => events.push([name, idKey(event.Item.Id)]));
    for (const [type, removedId, addedId] of [['movies', videoId, movieId], ['homevideos', movieId, videoId]]) {
      await database.update('BaseItems', { Id: collectionId }, { Data: collectionData(type) });
      events.length = 0;
      const result = await scanner.scan(reference);
      assert.equal(result.removed, 1); assert.equal(result.added, 1);
      assert.deepEqual(await database.rows('BaseItems', { where: { Id: removedId } }), []);
      const [row] = await database.rows('BaseItems', { where: { Id: addedId } });
      assert.equal(row.Path, path); assert.equal(row.Size, 12n);
      assert.deepEqual(events, [['ItemRemoved', idKey(removedId)], ['ItemAdded', idKey(addedId)]]);
    }
  });

  test(`${dialect}: SQL insertion failure restores the removed type and every related table`, options, async t => {
    const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [fileResolver, discResolver]);
    await adapter.mkdir('/Disc');
    await adapter.write('/Disc/child.mkv', Buffer.from('media'));
    await scanner.scan(reference);
    const childId = itemId(`${ROOT_PATH}\\Disc\\child.mkv`, MOVIE_TYPE);
    await database.insert('MediaSegments', { ...blank('MediaSegments'), Id: childId, ItemId: childId,
      SegmentProviderId: 'Fixture', StartTicks: 9007199254740993n, EndTicks: 9007199254740995n, Type: 1 });
    await adapter.write('/Disc/disc.marker', Buffer.from('disc'));
    await insertFailureTrigger(database, MOVIE_TYPE);
    const before = await completeSnapshot(database), events = [];
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) library.on(name, event => events.push(name));
    await assert.rejects(scanner.scan(reference), /Controlled reclassification failure/);
    assert.deepEqual(await completeSnapshot(database), before);
    assert.deepEqual(events, []);
    assert.equal((await adapter.stat('/Disc/child.mkv')).size, 5n);
  });

  test(`${dialect}: weak snapshots and external ownership reject reclassification without mutations`, options, async t => {
    for (const conflict of ['weak', 'owned', 'linked', 'ancestor']) await t.test(conflict, async t => {
      const { database, library, adapter, vfs, scanner, reference } = await fixture(t, dialect, [fileResolver, discResolver]);
      await adapter.mkdir('/Disc'); await scanner.scan(reference);
      const folderId = itemId(`${ROOT_PATH}\\Disc`, FOLDER_TYPE);
      if (conflict !== 'weak') {
        await database.insert('BaseItems', baseItem(FOREIGN_ID, 'Plugin.Entities.Foreign', {
          Name: 'External', ...(conflict === 'owned' ? { OwnerId: folderId } : {})
        }));
        if (conflict === 'linked') await database.insert('LinkedChildren', { ParentId: FOREIGN_ID, ChildId: folderId, ChildType: 0, SortOrder: 0 });
        if (conflict === 'ancestor') await database.insert('AncestorIds', { ItemId: FOREIGN_ID, ParentItemId: folderId });
      } else {
        const list = vfs.list.bind(vfs);
        vfs.list = async (...args) => ({ ...await list(...args), consistency: 'weak', snapshot: null, deletionSafe: false });
      }
      await adapter.write('/Disc/disc.marker', Buffer.from('disc'));
      const before = await completeSnapshot(database), events = [];
      for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) library.on(name, event => events.push(name));
      await assert.rejects(scanner.scan(reference), { code: 'unsupported/type-reclassification-required' });
      assert.deepEqual(await completeSnapshot(database), before);
      assert.deepEqual(events, []);
    });
  });

  test(`${dialect}: Windows case-only paths fail closed even when item IDs are case-sensitive`, options, async t => {
    const configuration = { EnableCaseSensitiveItemIds: true };
    const { database, adapter, scanner, reference } = await fixture(t, dialect, [fileResolver], { configuration });
    await adapter.write('/Movie.mkv', Buffer.from('upper'));
    await adapter.write('/movie.mkv', Buffer.from('lower'));

    const before = await snapshot(database);
    await assert.rejects(scanner.scan(reference), error => {
      assert.equal(error.code, 'invalid-response');
      assert.match(error.message, /ambiguous native paths/u);
      return true;
    });
    assert.deepEqual(await snapshot(database), before);
  });

  test(`${dialect}: a foreign exact-path owner rolls back earlier desired media and emits nothing`, options, async t => {
    const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [fileResolver]);
    await adapter.write('/a-good.mkv', Buffer.from('good'));
    await adapter.write('/z-collision.mkv', Buffer.from('collision'));
    await database.insert('BaseItems', baseItem(FOREIGN_ID, MOVIE_TYPE, {
      Name: 'Foreign',
      Path: `${ROOT_PATH}\\z-collision.mkv`,
      ParentId: ROOT_ID,
      TopParentId: ROOT_ID,
      IsFolder: false
    }));
    const before = await snapshot(database);
    const events = [];
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) library.on(name, event => events.push([name, event.Item.Id]));

    await assert.rejects(scanner.scan(reference), { code: 'invalid-response' });

    assert.deepEqual(await snapshot(database), before,
      'the valid item inserted earlier in reconciliation is rolled back with the later collision');
    assert.deepEqual(events, []);
    assert.equal((await database.rows('BaseItems', { where: {
      Id: itemId(`${ROOT_PATH}\\a-good.mkv`, MOVIE_TYPE)
    } })).length, 0);
  });

  test(`${dialect}: weak absence and an owned secondary claim cannot destructively rewrite media`, options, async t => {
    const { database, library, adapter, vfs, scanner, reference } = await fixture(t, dialect,
      [bundleResolver, fileResolver]);
    await adapter.write('/movie.mkv', Buffer.from('movie'));
    await adapter.write('/movie.en.srt', Buffer.from('subtitle'));
    const movieId = itemId(`${ROOT_PATH}\\movie.mkv`, MOVIE_TYPE);
    await scanner.scan(reference);

    const events = [];
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) library.on(name, event => events.push([name, event.Item.Id]));
    await adapter.delete('/movie.mkv');
    await adapter.delete('/movie.en.srt');
    const list = vfs.list.bind(vfs);
    vfs.list = async (path, listOptions) => {
      const result = await list(path, listOptions);
      return path === '/library' ? { ...result, consistency: 'weak', snapshot: null, deletionSafe: false } : result;
    };
    await scanner.scan(reference);
    assert.equal((await database.rows('BaseItems', { where: { Id: movieId } })).length, 1,
      'a weak complete listing cannot authorize media deletion');
    assert.deepEqual(events, []);
    vfs.list = list;

    await adapter.write('/movie.mkv', Buffer.from('movie'));
    await adapter.write('/movie.en.srt', Buffer.from('subtitle'));
    await database.insert('BaseItems', baseItem(FOREIGN_ID, 'Plugin.Entities.Sidecar', {
      Name: 'Foreign sidecar owner',
      Path: `${ROOT_PATH}\\movie.en.srt`,
      ParentId: ROOT_ID,
      TopParentId: ROOT_ID,
      IsFolder: false
    }));
    const before = await snapshot(database);
    await assert.rejects(scanner.scan(reference), { code: 'invalid-response' });
    assert.deepEqual(await snapshot(database), before,
      'a claimed secondary path with a BaseItems owner fails closed');
    assert.deepEqual(events, []);
  });

  test(`${dialect}: production home-video resolution scans ordinary files, owns extras and removes ignored managed items`, options, async t => {
    const { database, adapter, scanner, reference } = await fixture(t, dialect, [createVideoFileResolver()]);
    await insertCollection(database, 'homevideos');
    await adapter.write('/root.mp4', Buffer.from('root video'));
    await adapter.write('/movie.sample.mp4', Buffer.from('ignored sample'));
    await adapter.write('/.hidden.mp4', Buffer.from('ignored hidden file'));
    await adapter.mkdir('/Albums');
    await adapter.write('/Albums/clip.mkv', Buffer.from('nested video'));
    await adapter.mkdir('/Albums/extras');
    await adapter.write('/Albums/extras/bonus.mp4', Buffer.from('ignored extra'));

    const hiddenPath = `${ROOT_PATH}\\.hidden.mp4`;
    const hiddenId = itemId(hiddenPath, videoNativeType);
    await database.insert('BaseItems', baseItem(hiddenId, videoNativeType, {
      Name: 'Previously managed hidden video',
      Path: hiddenPath,
      ParentId: ROOT_ID,
      TopParentId: ROOT_ID,
      IsFolder: false,
      MediaType: 'Video',
      Data: JSON.stringify({ SourceType: 'Library', VideoType: 'VideoFile' })
    }));
    await database.insert('AncestorIds', { ItemId: hiddenId, ParentItemId: ROOT_ID });

    await scanner.scan(reference);

    assert.equal(scanner.capabilities.scansMediaFiles, false,
      'the narrow production resolver must not advertise a complete media-file scan');
    assert.equal(scanner.capabilities.resolvesProductionMediaFiles, true);
    assert.deepEqual(scanner.capabilities.productionMediaScopes, ['ordinary-movies-homevideos-and-musicvideos']);
    assert.equal(Object.isFrozen(scanner.capabilities.productionMediaScopes), true);

    const rootVideo = (await database.rows('BaseItems', { where: {
      Id: itemId(`${ROOT_PATH}\\root.mp4`, videoNativeType)
    } }))[0];
    const nestedVideo = (await database.rows('BaseItems', { where: {
      Id: itemId(`${ROOT_PATH}\\Albums\\clip.mkv`, videoNativeType)
    } }))[0];
    assert.equal(rootVideo.Type, videoNativeType);
    assert.equal(rootVideo.Name, 'root');
    assert.equal(rootVideo.IsInMixedFolder, true);
    assert.equal(JSON.parse(rootVideo.Data).VideoType, 'VideoFile');
    assert.equal(nestedVideo.Type, videoNativeType);
    assert.equal(nestedVideo.Name, 'clip');
    assert.equal(nestedVideo.IsInMixedFolder, false);
    assert.equal(JSON.parse(nestedVideo.Data).VideoType, 'VideoFile');

    const nestedExtra = (await database.rows('BaseItems', { where: {
      Id: itemId(`${ROOT_PATH}\\Albums\\extras\\bonus.mp4`, videoNativeType)
    } }))[0];
    assert.equal(nestedExtra.Type, videoNativeType);
    assert.equal(nestedExtra.Name, 'bonus');
    assert.equal(nestedExtra.ExtraType, 0);
    assert.equal(idKey(nestedExtra.OwnerId), idKey(nestedVideo.Id));
    assert.equal(nestedExtra.ParentId, null);
    assert.equal(nestedExtra.TopParentId, null);

    for (const path of [
      hiddenPath,
      `${ROOT_PATH}\\movie.sample.mp4`,
      `${ROOT_PATH}\\Albums\\extras`
    ]) {
      assert.equal((await database.rows('BaseItems', { where: { Path: path } })).length, 0,
        `${path} is withheld by the native ignore stage`);
    }
    assert.equal((await database.rows('AncestorIds', { where: { ItemId: hiddenId } })).length, 0,
      'an ignored path is absent from observedPaths, so its prior managed row can be deleted');
  });

  test(`${dialect}: production movie resolution parses create-only metadata without marking IsMovie`, options, async t => {
    const { database, adapter, scanner, reference } = await fixture(t, dialect, [createVideoFileResolver()]);
    await insertCollection(database, 'movies');
    const filename = 'Example.Movie.2020.1080p.mkv';
    const identityPath = `${ROOT_PATH}\\${filename}`;
    const movieId = itemId(identityPath, MOVIE_TYPE);
    await adapter.write(`/${filename}`, Buffer.from('first'), { modified: '2026-09-27T00:00:00.000Z' });

    await scanner.scan(reference);

    let movie = (await database.rows('BaseItems', { where: { Id: movieId } }))[0];
    assert.equal(movie.Type, MOVIE_TYPE);
    assert.equal(movie.Name, 'Example.Movie');
    assert.equal(movie.ProductionYear, 2020);
    assert.equal(movie.IsMovie, false, 'native Movie identity does not imply the persisted IsMovie flag');
    assert.equal(movie.IsInMixedFolder, true);
    assert.equal(JSON.parse(movie.Data).VideoType, 'VideoFile');

    await database.update('BaseItems', { Id: movieId }, { ProductionYear: 1999 });
    await adapter.write(`/${filename}`, Buffer.from('second version'), { modified: '2026-09-28T00:00:00.000Z' });
    await scanner.scan(reference);

    movie = (await database.rows('BaseItems', { where: { Id: movieId } }))[0];
    assert.equal(movie.ProductionYear, 1999,
      'ProductionYear is supplied only while the scan-owned row is first created');
    assert.equal(movie.IsMovie, false);
    assert.equal(movie.Size, 5n, 'validation alone does not update file size');
  });

  test(`${dialect}: production movies collapse a strongly enumerated single-file directory`, options, async t => {
    const { database, library, adapter, vfs, scanner, reference } = await fixture(t, dialect,
      [createVideoFileResolver()]);
    await insertCollection(database, 'movies');
    await adapter.mkdir('/Film (2020)');
    await adapter.write('/Film (2020)/Film (2020).mkv', Buffer.from('movie'));
    const directoryPath = `${ROOT_PATH}\\Film (2020)`;
    const videoPath = `${directoryPath}\\Film (2020).mkv`;
    const directoryId = itemId(directoryPath, FOLDER_TYPE);
    const movieId = itemId(videoPath, MOVIE_TYPE);
    const lists = [];
    const events = [];
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
      library.on(name, event => events.push([name, idKey(event.Item.Id)]));
    }
    const list = vfs.list.bind(vfs);
    vfs.list = async (...args) => {
      lists.push(args[0]);
      return list(...args);
    };

    const result = await scanner.scan(reference);

    assert.equal(result.added, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.removed, 0);
    assert.equal((await database.rows('BaseItems', { where: { Id: directoryId } })).length, 0,
      'the physical container is not persisted as a generic Folder');
    assert.equal((await database.rows('BaseItems', { where: { Path: directoryPath } })).length, 0);
    const [movie] = await database.rows('BaseItems', { where: { Id: movieId } });
    assert.equal(movie.Path, videoPath);
    assert.equal(movie.ParentId, ROOT_ID);
    assert.equal(movie.TopParentId, ROOT_ID);
    assert.equal(movie.Type, MOVIE_TYPE);
    assert.equal(movie.Name, 'Film (2020)');
    assert.equal(movie.ProductionYear, 2020);
    assert.equal(movie.IsInMixedFolder, false);
    assert.equal(movie.Size, 5n);
    assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: movieId } }))
      .map(row => idKey(row.ParentItemId))), new Set([idKey(ROOT_ID), idKey(FIRST_COLLECTION_ID)]));
    assert.deepEqual(events, [['ItemAdded', idKey(movieId)]]);
    assert.equal(lists.filter(value => value === '/library/Film (2020)').length, 1,
      'the authoritative resolver peek is reused instead of traversing the collapsed directory');
  });

  test(`${dialect}: production movies persist a multi-disc directory stack as one first-disc identity`, options,
    async t => {
      const { database, library, adapter, scanner, reference } = await fixture(t, dialect,
        [createVideoFileResolver()], { nativeActions: true });
      const collectionId = await insertCollection(database, 'movies');
      await adapter.mkdir('/Film');
      await adapter.mkdir('/Film/Film Disc 2');
      await adapter.write('/Film/Film Disc 2/video_ts.ifo', Buffer.from('second'));
      await adapter.mkdir('/Film/Film Disc 1');
      await adapter.write('/Film/Film Disc 1/video_ts.ifo', Buffer.from('first'));
      const containerPath = `${ROOT_PATH}\\Film`;
      const primaryPath = `${containerPath}\\Film Disc 1`;
      const secondPath = `${containerPath}\\Film Disc 2`;
      const movieId = itemId(primaryPath, MOVIE_TYPE);
      const events = [];
      for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
        library.on(name, event => events.push([name, idKey(event.Item.Id)]));
      }

      const created = await scanner.scan(reference);

      assert.equal(created.structurallyComplete, true);
      assert.equal(created.added, 1);
      assert.equal(created.updated, 0);
      assert.equal(created.removed, 0);
      const [movie] = await database.rows('BaseItems', { where: { Id: movieId } });
      assert.equal(movie.Type, MOVIE_TYPE);
      assert.equal(movie.Name, 'Film');
      assert.equal(movie.Path, primaryPath);
      assert.equal(movie.ParentId, ROOT_ID);
      assert.equal(movie.TopParentId, ROOT_ID);
      assert.equal(movie.IsFolder, false);
      assert.equal(movie.IsInMixedFolder, false);
      assert.equal(movie.Size, null);
      assert.deepEqual(JSON.parse(movie.Data), {
        VideoType: 'Dvd',
        LocalAlternateVersions: [],
        AdditionalParts: [secondPath],
        SourceType: 'Library'
      });
      for (const path of [containerPath, secondPath]) {
        assert.equal((await database.rows('BaseItems', { where: { Path: path } })).length, 0,
          'the container and additional directory are metadata paths, not separate items');
      }
      assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: movieId } }))
        .map(row => idKey(row.ParentItemId))), new Set([idKey(ROOT_ID), idKey(collectionId)]));
      assert.deepEqual(events, [['ItemAdded', idKey(movieId)]]);

      events.length = 0;
      const stable = await scanner.scan(reference);
      assert.equal(stable.structurallyComplete, true);
      assert.equal(stable.added, 0);
      assert.equal(stable.updated, 0);
      assert.equal(stable.removed, 0);
      assert.deepEqual(events, []);
      assert.deepEqual(JSON.parse((await database.rows('BaseItems', { where: { Id: movieId } }))[0].Data),
        JSON.parse(movie.Data));

      await adapter.delete('/Film/Film Disc 1/video_ts.ifo');
      await adapter.delete('/Film/Film Disc 1');
      const reclassified = await scanner.scan(reference);
      const folderId = itemId(containerPath, FOLDER_TYPE);
      const nestedId = itemId(secondPath, MOVIE_TYPE);
      assert.equal(reclassified.structurallyComplete, true);
      assert.deepEqual({ added: reclassified.added, updated: reclassified.updated, removed: reclassified.removed },
        { added: 2, updated: 0, removed: 1 });
      assert.equal((await database.rows('BaseItems', { where: { Id: movieId } })).length, 0);
      const [folder] = await database.rows('BaseItems', { where: { Id: folderId } });
      const [nested] = await database.rows('BaseItems', { where: { Id: nestedId } });
      assert.equal(folder.Type, FOLDER_TYPE);
      assert.equal(folder.ParentId, ROOT_ID);
      assert.equal(folder.OwnerId, null);
      assert.equal(folder.PrimaryVersionId, null);
      assert.equal(nested.Type, MOVIE_TYPE);
      assert.equal(nested.Path, secondPath);
      assert.equal(nested.ParentId, folderId);
      assert.equal(nested.TopParentId, ROOT_ID);
      assert.equal(nested.OwnerId, null);
      assert.equal(nested.PrimaryVersionId, null);
      assert.deepEqual(events, [
        ['ItemRemoved', idKey(movieId)],
        ['ItemAdded', idKey(folderId)],
        ['ItemAdded', idKey(nestedId)]
      ]);
    });

  for (const survivors of [[2, 4], [4]]) test(
    `${dialect}: four-disc primary loss preserves ${survivors.length === 1 ? 'one nested survivor' : 'the noncontiguous surviving stack'}`,
    options, async t => {
      const { database, library, adapter, scanner, reference } = await fixture(t, dialect,
        [createVideoFileResolver()], { nativeActions: true });
      const aggregateId = 'D1000000-0000-0000-0000-000000000006';
      await database.insert('BaseItems', baseItem(aggregateId,
        'MediaBrowser.Controller.Entities.AggregateFolder', {
          Name: 'Aggregate', CleanName: 'aggregate', SortName: 'aggregate', IsFolder: true
        }));
      await database.update('BaseItems', { Id: ROOT_ID }, { ParentId: aggregateId });
      const collectionId = await insertCollection(database, 'movies');
      const containerPath = `${ROOT_PATH}\\Film`;
      const discPath = number => `${containerPath}\\Film Disc ${number}`;
      const accessPath = number => `/Film/Film Disc ${number}`;
      const sourceId = itemId(discPath(1), MOVIE_TYPE);
      const sourceFiles = new Map();
      await adapter.mkdir('/Film');
      for (const number of [4, 2, 3, 1]) {
        await adapter.mkdir(accessPath(number));
        const file = `${accessPath(number)}/video_ts.ifo`;
        await adapter.write(file, Buffer.from(`disc ${number}`));
        sourceFiles.set(number, await adapter.stat(file));
      }
      const created = await scanner.scan(reference);
      assert.equal(created.structurallyComplete, true);
      assert.equal(created.added, 1);
      assert.deepEqual((await library.getItemRecord(sourceId)).AdditionalParts, [2, 3, 4].map(discPath));

      const events = [];
      for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
        library.on(name, event => events.push([name, idKey(event.Item.Id)]));
      }
      for (const number of [1, 2, 3, 4].filter(number => !survivors.includes(number))) {
        await adapter.delete(`${accessPath(number)}/video_ts.ifo`);
        await adapter.delete(accessPath(number));
      }
      const result = await scanner.scan(reference);
      const becomesFolder = survivors.length === 1;
      const folderId = itemId(containerPath, FOLDER_TYPE);
      const targetId = itemId(discPath(survivors[0]), MOVIE_TYPE);
      const expectedParts = survivors.slice(1).map(discPath);
      assert.equal(result.structurallyComplete, true);
      assert.deepEqual({ added: result.added, updated: result.updated, removed: result.removed },
        { added: becomesFolder ? 2 : 1, updated: 0, removed: 1 });
      assert.equal((await database.rows('BaseItems', { where: { Id: sourceId } })).length, 0);
      const [target] = await database.rows('BaseItems', { where: { Id: targetId } });
      assert.equal(target.Type, MOVIE_TYPE);
      assert.equal(target.Path, discPath(survivors[0]));
      assert.equal(target.ParentId, becomesFolder ? folderId : ROOT_ID);
      assert.equal(target.TopParentId, ROOT_ID);
      assert.equal(target.OwnerId, null);
      assert.equal(target.PrimaryVersionId, null);
      assert.equal(JSON.parse(target.Data).VideoType, 'Dvd');
      assert.deepEqual(JSON.parse(target.Data).AdditionalParts, expectedParts);
      const cold = await library.getItemRecord(targetId);
      assert.equal(cold.ParentId, target.ParentId);
      assert.deepEqual(cold.AdditionalParts, expectedParts);
      const folderRows = await database.rows('BaseItems', { where: { Path: containerPath } });
      assert.equal(folderRows.length, becomesFolder ? 1 : 0);
      if (becomesFolder) {
        assert.equal(folderRows[0].Type, FOLDER_TYPE);
        assert.equal(folderRows[0].Id, folderId);
        assert.equal(folderRows[0].ParentId, ROOT_ID);
        assert.equal((await library.getItemRecord(folderId)).Type, 'Folder');
      }
      assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: targetId } }))
        .map(row => idKey(row.ParentItemId))),
        new Set([ROOT_ID, aggregateId, collectionId, ...(becomesFolder ? [folderId] : [])].map(idKey)));
      assert.deepEqual(events, [
        ['ItemRemoved', idKey(sourceId)],
        ...(becomesFolder ? [['ItemAdded', idKey(folderId)]] : []),
        ['ItemAdded', idKey(targetId)]
      ]);
      for (const number of survivors) {
        assert.deepEqual(await adapter.stat(`${accessPath(number)}/video_ts.ifo`), sourceFiles.get(number),
          'repository reclassification must preserve surviving source files');
      }
      const beforeRepeat = await snapshot(database);
      events.length = 0;
      const repeated = await scanner.scan(reference);
      assert.equal(repeated.structurallyComplete, true);
      assert.deepEqual({ added: repeated.added, updated: repeated.updated, removed: repeated.removed },
        { added: 0, updated: 0, removed: 0 });
      assert.deepEqual(await snapshot(database), beforeRepeat);
      assert.deepEqual(events, []);
    });

  for (const sample of discReclassificationInput.slice(0, 9)) test(
    `${dialect}: directory disc reclassification lifecycle ${sample.name}`,
    options,
    async t => assertDiscReclassificationScan(t, dialect, sample,
      discReclassificationNative.results.find(result => result.name === sample.name)));

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

  for (const scenario of ['outgoing-child-type-2', 'incoming-child-type-3', 'owned-closure',
    'weak-root', 'weak-outer', 'mixed-source', 'target-id-collision', 'malformed-old-family', 'local-alternate',
    'live-family-mutation']) test(
    `${dialect}: directory disc primary promotion rejects ${scenario} before side effects`,
    options,
    async t => assertDiscPromotionRejected(t, dialect, scenario));

  for (const scenario of ['owned-closure', 'version-link', 'mixed-source', 'outer-id-collision',
    'nested-id-collision', 'outer-path-collision', 'nested-path-collision', 'malformed-old-family',
    'local-alternate', 'nondeletable-source', 'weak-root', 'weak-outer', 'incomplete-nested',
    'extra-native-action', 'live-family-mutation']) test(
    `${dialect}: directory disc two-to-Folder rejects ${scenario} before side effects`,
    options,
    async t => assertDiscFolderRejected(t, dialect, scenario));

  test(`${dialect}: weak nested multi-disc evidence is withheld before any identity is persisted`, options, async t => {
    const { database, adapter, vfs, scanner, reference } = await fixture(t, dialect,
      [createVideoFileResolver()]);
    await insertCollection(database, 'movies');
    await adapter.mkdir('/Weak');
    await adapter.mkdir('/Weak/Weak Disc 1');
    await adapter.write('/Weak/Weak Disc 1/video_ts.ifo', Buffer.from('first'));
    await adapter.mkdir('/Weak/Weak Disc 2');
    await adapter.write('/Weak/Weak Disc 2/video_ts.ifo', Buffer.from('second'));
    const list = vfs.list.bind(vfs);
    vfs.list = async (requested, listOptions) => {
      const listing = await list(requested, listOptions);
      return requested === '/library/Weak/Weak Disc 1'
        ? { ...listing, consistency: 'weak', snapshot: null, deletionSafe: false }
        : listing;
    };

    const result = await scanner.scan(reference);

    assert.equal(result.structurallyComplete, false);
    assert.ok(result.incompleteReasons.some(reason =>
      reason.code === folderScanIncompleteReasonCodes.RESOLVER_PATH_WITHHELD
        && reason.path === `${ROOT_PATH}\\Weak`));
    assert.equal((await database.rows('BaseItems', { where: { Path: `${ROOT_PATH}\\Weak` } })).length, 0);
    assert.equal((await database.rows('BaseItems', { where: { Path: `${ROOT_PATH}\\Weak\\Weak Disc 1` } })).length, 0);
    assert.equal((await database.rows('BaseItems', { where: { Path: `${ROOT_PATH}\\Weak\\Weak Disc 2` } })).length, 0);
  });

  test(`${dialect}: a persisted Folder becomes a collapsed Movie atomically`, options, async t => {
    const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [createVideoFileResolver()]);
    await insertCollection(database, 'movies');
    await adapter.mkdir('/Film (2020)');
    const directoryPath = `${ROOT_PATH}\\Film (2020)`;
    const videoPath = `${directoryPath}\\Film (2020).mkv`;
    const directoryId = itemId(directoryPath, FOLDER_TYPE);
    const movieId = itemId(videoPath, MOVIE_TYPE);

    await scanner.scan(reference);
    assert.equal((await database.rows('BaseItems', { where: { Id: directoryId } }))[0].Type, FOLDER_TYPE);

    await adapter.write('/Film (2020)/Film (2020).mkv', Buffer.from('movie'));
    const events = [];
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
      library.on(name, event => events.push([name, idKey(event.Item.Id)]));
    }

    const result = await scanner.scan(reference);

    assert.equal(result.added, 1);
    assert.equal(result.removed, 1);
    assert.equal((await database.rows('BaseItems', { where: { Id: directoryId } })).length, 0);
    assert.equal((await database.rows('AncestorIds', { where: { ItemId: directoryId } })).length, 0);
    const [movie] = await database.rows('BaseItems', { where: { Id: movieId } });
    assert.equal(movie.Path, videoPath);
    assert.equal(movie.ParentId, ROOT_ID);
    assert.deepEqual(events, [
      ['ItemRemoved', idKey(directoryId)],
      ['ItemAdded', idKey(movieId)]
    ]);
  });

  for (const [collectionType, filename, videoType, shortcut, placeholder] of [
    ['movies', 'Story.mkv', 'VideoFile', false, false],
    [null, 'Story.mkv', 'VideoFile', false, false],
    ['movies', 'Story.iso', 'Iso', false, false],
    ['movies', 'Story.strm', 'VideoFile', true, false],
    ['movies', 'Story.dvd.disc', 'Dvd', false, true]
  ]) test(`${dialect}: ${filename} in ${collectionType ?? 'an untyped library'} moves between a single-film directory and a populated Folder`, options, async t => {
    const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [createVideoFileResolver()]);
    const collectionId = await insertCollection(database, collectionType);
    await adapter.mkdir('/Dynamic');
    const source = Buffer.from(shortcut ? 'https://example.invalid/story.mkv' : 'story');
    await adapter.write('/Dynamic/' + filename, source);
    const directoryPath = `${ROOT_PATH}\\Dynamic`, moviePath = `${directoryPath}\\${filename}`;
    const folderId = itemId(directoryPath, FOLDER_TYPE), movieId = itemId(moviePath, MOVIE_TYPE);
    const secondId = itemId(`${directoryPath}\\Second.mkv`, MOVIE_TYPE);
    await scanner.scan(reference);
    await database.update('BaseItems', { Id: movieId }, {
      Name: 'Provider Movie', Overview: 'Preserved movie metadata'
    });
    const userId = 'D1000000-0000-0000-0000-000000000021';
    await database.insert('Users', { ...blank('Users'), Id: userId, InternalId: 1701,
      Username: 'Movie Viewer', NormalizedUsername: 'MOVIE VIEWER' });
    await database.insert('UserData', { ...blank('UserData'), ItemId: movieId, UserId: userId,
      CustomDataKey: idKey(movieId), IsFavorite: true, Played: true, PlayCount: 7,
      PlaybackPositionTicks: 9007199254740993n });
    const userData = await database.rows('UserData');
    const assertMovie = async (parentId, mixed, ancestors) => {
      const movie = await library.getItemRecord(movieId);
      assert.deepEqual({ id: movie.Id, path: movie.Path, parent: movie.ParentId, mixed: movie.IsInMixedFolder,
        name: movie.Name, overview: movie.Overview },
      { id: movieId, path: moviePath, parent: parentId, mixed,
        name: 'Provider Movie', overview: 'Preserved movie metadata' });
      assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: movieId } }))
        .map(row => idKey(row.ParentItemId))), new Set(ancestors.map(idKey)));
      assert.deepEqual(await database.rows('UserData'), userData);
      assert.equal(movie.VideoType, videoType);
      assert.equal(Boolean(movie.IsShortcut), shortcut);
      assert.equal(Boolean(movie.IsPlaceHolder), placeholder);
      const media = await adapter.openRead('/Dynamic/' + filename);
      try {
        const chunks = [];
        for await (const chunk of media.stream) chunks.push(Buffer.from(chunk));
        assert.deepEqual(Buffer.concat(chunks), source);
      } finally { await media.close(); }
    };

    await adapter.write('/Dynamic/Second.mkv', Buffer.from('second'));
    assert.equal((await scanner.scan(reference)).structurallyComplete, true);
    assert.equal((await library.getItemRecord(folderId)).Type, 'Folder');
    assert.equal((await library.getItemRecord(secondId)).ParentId, folderId);
    await assertMovie(folderId, true, [folderId, ROOT_ID, collectionId]);
    const expanded = await completeSnapshot(database);
    assert.equal((await scanner.scan(reference)).structurallyComplete, true);
    assert.deepEqual(await completeSnapshot(database), expanded);

    await adapter.delete('/Dynamic/Second.mkv');
    const beforeFailedCollapse = await completeSnapshot(database), events = [];
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
      library.on(name, event => events.push([name, idKey(event.Item.Id)]));
    }
    const dropFailure = await deleteFailureTrigger(database, folderId);
    try {
      await assert.rejects(scanner.scan(reference), /Controlled primary deletion failure/u);
      assert.deepEqual(await completeSnapshot(database), beforeFailedCollapse,
        'a failed Folder deletion rolls back the Movie parent move and preserves its user data');
      assert.deepEqual(events, []);
    } finally { await dropFailure(); }

    assert.equal((await scanner.scan(reference)).structurallyComplete, true);
    assert.equal((await database.rows('BaseItems', { where: { Id: folderId } })).length, 0);
    assert.equal((await database.rows('BaseItems', { where: { Id: secondId } })).length, 0);
    await assertMovie(ROOT_ID, false, [ROOT_ID, collectionId]);
    const collapsed = await completeSnapshot(database);
    assert.equal((await scanner.scan(reference)).structurallyComplete, true);
    assert.deepEqual(await completeSnapshot(database), collapsed);
  });

  test(`${dialect}: a multi winner cannot silently preserve an omitted managed sibling`, options, async t => {
    const { database, library, adapter, scanner, reference } = await fixture(t, dialect,
      [suppressingBundleResolver]);
    await adapter.mkdir('/Ignored');
    const ignoredPath = `${ROOT_PATH}\\Ignored`;
    const ignoredId = itemId(ignoredPath, FOLDER_TYPE);

    await scanner.scan(reference);
    assert.equal((await database.rows('BaseItems', { where: { Id: ignoredId } }))[0].Type, FOLDER_TYPE);

    await adapter.write('/Film.mkv', Buffer.from('movie'));
    const before = await snapshot(database);
    const events = [];
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
      library.on(name, event => events.push([name, event.Item.Id]));
    }

    await assert.rejects(scanner.scan(reference), error => {
      assert.equal(error.code, 'unsupported/type-reclassification-required');
      assert.match(error.message, /withheld resolver path/u);
      return true;
    });

    assert.deepEqual(await snapshot(database), before,
      'suppressed siblings reach reconciliation and roll back the multi winner instead of retaining stale state');
    assert.deepEqual(events, []);
    assert.equal((await database.rows('BaseItems', { where: { Id: ignoredId } })).length, 1);
    assert.equal((await database.rows('BaseItems', { where: { Path: `${ROOT_PATH}\\Film.mkv` } })).length, 0);
  });

  test(`${dialect}: production movies refresh an existing deterministic collapsed Movie without adding its directory`, options,
    async t => {
      const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [createVideoFileResolver()]);
      const collectionId = await insertCollection(database, 'movies');
      await adapter.mkdir('/Film (2020)');
      await adapter.write('/Film (2020)/Film (2020).mkv', Buffer.from('movie'));
      const directoryPath = `${ROOT_PATH}\\Film (2020)`;
      const videoPath = `${directoryPath}\\Film (2020).mkv`;
      const directoryId = itemId(directoryPath, FOLDER_TYPE);
      const movieId = itemId(videoPath, MOVIE_TYPE);
      await database.insert('BaseItems', baseItem(movieId, MOVIE_TYPE, {
        Name: 'Provider Film',
        CleanName: 'provider film',
        SortName: 'provider film',
        Overview: 'Preserve the collapsed movie',
        Path: videoPath,
        ParentId: ROOT_ID,
        TopParentId: ROOT_ID,
        IsFolder: false,
        MediaType: 'Video',
        ProductionYear: 1999,
        Data: JSON.stringify({
          SourceType: 'Library',
          VideoType: 'VideoFile',
          ProviderState: { imported: true }
        })
      }));
      await database.insert('AncestorIds', { ItemId: movieId, ParentItemId: ROOT_ID });
      await database.insert('AncestorIds', { ItemId: movieId, ParentItemId: collectionId });
      const events = [];
      for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
        library.on(name, event => events.push([name, idKey(event.Item.Id)]));
      }

      const result = await scanner.scan(reference);

      assert.equal(result.added, 0);
      assert.equal(result.updated, 0);
      assert.equal(result.removed, 0);
      const [movie] = await database.rows('BaseItems', { where: { Id: movieId } });
      assert.equal(movie.ParentId, ROOT_ID);
      assert.equal(movie.Path, videoPath);
      assert.equal(movie.Name, 'Provider Film');
      assert.equal(movie.ProductionYear, 1999);
      assert.equal(movie.Size, null, 'file size is populated by metadata refresh rather than structural validation');
      assert.deepEqual(JSON.parse(movie.Data).ProviderState, { imported: true });
      assert.equal((await database.rows('BaseItems', { where: { Id: directoryId } })).length, 0,
        'withholding the already-collapsed movie directory suppresses Folder fallback');
      assert.deepEqual(events, []);
    });

  test(`${dialect}: a collection-context change during enumeration retries without committing the stale plan`, options, async t => {
    const { database, library, adapter, vfs, scanner, reference } = await fixture(t, dialect,
      [createVideoFileResolver()]);
    await insertCollection(database, 'homevideos');
    await adapter.write('/context-race.mkv', Buffer.from('race'));
    const videoId = itemId(`${ROOT_PATH}\\context-race.mkv`, videoNativeType);
    const events = [];
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
      library.on(name, event => events.push([name, event.Item.Id]));
    }
    let rootListings = 0;
    const list = vfs.list.bind(vfs);
    vfs.list = async (...args) => {
      const result = await list(...args);
      if (args[0] === '/library' && rootListings++ === 0) {
        await database.update('BaseItems', { Id: FIRST_COLLECTION_ID }, { Data: collectionData('music') });
      }
      return result;
    };

    const result = await scanner.scan(reference);

    assert.equal(rootListings, 2, 'the changed context invalidates and re-enumerates the first plan');
    assert.equal(result.added, 0);
    assert.equal((await database.rows('BaseItems', { where: { Id: videoId } })).length, 0,
      'the home-video claim from the stale attempt never commits');
    assert.equal((await database.rows('BaseItems', { where: { Path: `${ROOT_PATH}\\context-race.mkv` } })).length, 0);
    assert.deepEqual(events, []);
  });

  test(`${dialect}: collection types on one physical root follow native user-root child order`, options, async t => {
    const { database, adapter, scanner, reference } = await fixture(t, dialect, [createVideoFileResolver()]);
    await insertCollection(database, 'homevideos', FIRST_COLLECTION_ID);
    await insertCollection(database, 'movies', SECOND_COLLECTION_ID);
    await adapter.write('/ambiguous.mkv', Buffer.from('ambiguous'));

    const result = await scanner.scan(reference);

    assert.equal(result.added, 1);
    const [item] = await database.rows('BaseItems', { where: {
      Path: `${ROOT_PATH}\\ambiguous.mkv`
    } });
    assert.equal(item.Type, 'MediaBrowser.Controller.Entities.Video',
      'homevideos is first in the user-root child SortName order');
  });

  test(`${dialect}: a resolver cannot poison an existing managed row with foreign ownership`, options, async t => {
    let sourceType = 'Library';
    let canDelete;
    const sourceResolver = {
      id: 'test-source-file',
      nativeTypes: { [MOVIE_TYPE]: { isFolder: false } },
      resolveFile({ candidate }) {
        const claim = movieClaim(candidate);
        claim.draft.SourceType = sourceType;
        if (canDelete !== undefined) claim.draft.data.CanDelete = canDelete;
        return claim;
      }
    };
    const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [sourceResolver]);
    await adapter.write('/owned.mkv', Buffer.from('library'));
    await scanner.scan(reference);
    const before = await snapshot(database);
    const events = [];
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
      library.on(name, event => events.push([name, event.Item.Id]));
    }

    sourceType = 'Channel';
    await adapter.write('/owned.mkv', Buffer.from('poison attempt'));
    await assert.rejects(scanner.scan(reference), error => {
      assert.equal(error.code, 'invalid-response');
      assert.match(error.message, /unsupported item source type/u);
      return true;
    });

    assert.deepEqual(await snapshot(database), before);
    assert.deepEqual(events, []);

    sourceType = 'Library';
    canDelete = false;
    await assert.rejects(scanner.scan(reference), error => {
      assert.equal(error.code, 'invalid-response');
      assert.match(error.message, /CanDelete/u);
      return true;
    });
    assert.deepEqual(await snapshot(database), before);
    assert.deepEqual(events, []);
  });

  test(`${dialect}: conventional TV hierarchy persists deterministic relationships and ancestors atomically`, options,
    async t => {
      const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [createTvItemResolver()]);
      const collectionId = await insertCollection(database, 'tvshows');
      await adapter.mkdir('/Example Show (2024)');
      await adapter.mkdir('/Example Show (2024)/Empty');
      await adapter.mkdir('/Example Show (2024)/Season 01');
      await adapter.write('/Example Show (2024)/Season 01/Example.Show.S01E02.mkv', Buffer.from('episode'));
      await adapter.mkdir('/Example Show (2024)/Unnumbered');
      await adapter.write('/Example Show (2024)/Unnumbered/Unnumbered.mkv', Buffer.from('unnumbered episode'));
      await adapter.mkdir('/Example Show (2024)/Unnumbered/Nested');
      await adapter.write('/Example Show (2024)/Unnumbered/Nested/Unnumbered.mkv', Buffer.from('nested episode'));
      await adapter.mkdir('/Example Show (2024)/Example.Show.S01E05');
      await adapter.write('/Example Show (2024)/Example.Show.S01E05/video.mkv', Buffer.from('episode folder'));
      await adapter.write('/Example Show (2024)/Example.Show.S01E03.mkv', Buffer.from('flat episode'));
      await adapter.write('/Root.Show.S03E05.mkv', Buffer.from('root episode'));
      const seriesPath = `${ROOT_PATH}\\Example Show (2024)`;
      const seasonPath = `${seriesPath}\\Season 01`;
      const episodePath = `${seasonPath}\\Example.Show.S01E02.mkv`;
      const seriesId = itemId(seriesPath, seriesNativeType);
      const seasonId = itemId(seasonPath, seasonNativeType);
      const episodeId = itemId(episodePath, episodeNativeType);
      const flatId = itemId(`${seriesPath}\\Example.Show.S01E03.mkv`, episodeNativeType);
      const rootEpisodeId = itemId(`${ROOT_PATH}\\Root.Show.S03E05.mkv`, episodeNativeType);
      const unnumberedSeasonId = itemId(`${seriesPath}\\Unnumbered`, seasonNativeType);
      const unnumberedEpisodeId = itemId(`${seriesPath}\\Unnumbered\\Unnumbered.mkv`, episodeNativeType);
      const nestedFolders = [
        { folderPath: `${seriesPath}\\Unnumbered\\Nested`, parentId: unnumberedSeasonId,
          filename: 'Unnumbered.mkv', seasonId: unnumberedSeasonId, ancestors: [unnumberedSeasonId] },
        { folderPath: `${seriesPath}\\Example.Show.S01E05`, parentId: seriesId,
          filename: 'video.mkv', seasonId: null, ancestors: [] }
      ];

      const result = await scanner.scan(reference);

      assert.equal(result.structurallyComplete, true);
      assert.equal(scanner.capabilities.relationshipRows, false,
        'the narrow TV slice must not advertise the complete relationship stage');
      assert.equal(scanner.capabilities.completeLibraryScan, false);
      assert.deepEqual(scanner.capabilities.productionMediaScopes,
        ['tv-ordinary-video-files']);
      const [series] = await database.rows('BaseItems', { where: { Id: seriesId } });
      const [season] = await database.rows('BaseItems', { where: { Id: seasonId } });
      const [episode] = await database.rows('BaseItems', { where: { Id: episodeId } });
      const emptyFolder = await library.getItemRecord(itemId(`${seriesPath}\\Empty`, FOLDER_TYPE));
      assert.equal(emptyFolder.Type, 'Folder');
      assert.equal(emptyFolder.ParentId, seriesId);
      assert.equal(series.Type, seriesNativeType);
      assert.equal(series.Name, 'Example Show');
      assert.equal(series.ProductionYear, 2024);
      assert.equal(series.ParentId, ROOT_ID);
      assert.equal(series.TopParentId, ROOT_ID);
      assert.equal(series.SeriesId, null);
      assert.equal(series.SeasonId, null);
      assert.equal(season.Type, seasonNativeType);
      assert.equal(season.ParentId, seriesId);
      assert.equal(season.TopParentId, ROOT_ID);
      assert.equal(season.SeriesId, seriesId);
      assert.equal(season.SeasonId, null);
      assert.equal(season.IndexNumber, 1);
      assert.equal(season.SortName, '0001');
      assert.equal(episode.Type, episodeNativeType);
      assert.equal(episode.ParentId, seasonId);
      assert.equal(episode.TopParentId, ROOT_ID);
      assert.equal(episode.SeriesId, seriesId);
      assert.equal(episode.SeasonId, seasonId);
      assert.equal(episode.IndexNumber, null);
      assert.equal(episode.ParentIndexNumber, null);
      assert.equal(episode.SortName, 'Example.Show.S01E02');
      assert.equal(episode.MediaType, 'Video');
      assert.deepEqual(JSON.parse(episode.Data), { VideoType: 'VideoFile', SourceType: 'Library' });
      const [flat] = await database.rows('BaseItems', { where: { Id: flatId } });
      assert.equal(flat.ParentId, seriesId);
      assert.equal(flat.SeriesId, seriesId);
      assert.equal(flat.SeasonId, null);
      const [unnumberedSeason] = await database.rows('BaseItems', { where: { Id: unnumberedSeasonId } });
      assert.equal(unnumberedSeason.Type, seasonNativeType);
      assert.equal(unnumberedSeason.Path, `${seriesPath}\\Unnumbered`);
      assert.equal(unnumberedSeason.Name, 'Unnumbered');
      assert.equal(unnumberedSeason.IndexNumber, null);
      assert.equal(unnumberedSeason.ParentId, seriesId);
      assert.equal(unnumberedSeason.SeriesId, seriesId);
      const unnumberedEpisode = await library.getItemRecord(unnumberedEpisodeId);
      assert.equal(unnumberedEpisode.Type, 'Episode');
      assert.equal(unnumberedEpisode.ParentId, unnumberedSeasonId);
      assert.equal(unnumberedEpisode.SeriesId, seriesId);
      assert.equal(unnumberedEpisode.SeasonId, unnumberedSeasonId);
      assert.equal(unnumberedEpisode.ParentIndexNumber, null);
      assert.equal(unnumberedEpisode.IndexNumber, null);
      const rootEpisode = await library.getItemRecord(rootEpisodeId);
      assert.equal(rootEpisode.NativeType, episodeNativeType);
      assert.equal(rootEpisode.Type, 'Episode');
      assert.equal(rootEpisode.ParentId, ROOT_ID);
      assert.equal(repositoryTopParentId(rootEpisode), ROOT_ID);
      assert.equal(nonemptyId(rootEpisode.SeriesId), false);
      assert.equal(nonemptyId(rootEpisode.SeasonId), false);
      assert.equal(rootEpisode.IndexNumber, null);
      assert.equal(rootEpisode.ParentIndexNumber, null);
      const [rootEpisodeRow] = await database.rows('BaseItems', { where: { Id: rootEpisodeId } });
      assert.equal(rootEpisodeRow.SeriesId, null);
      assert.equal(rootEpisodeRow.SeasonId, null);
      const ancestors = async id => new Set((await database.rows('AncestorIds', { where: { ItemId: id } }))
        .map(row => idKey(row.ParentItemId)));
      assert.deepEqual(await ancestors(seriesId), new Set([idKey(ROOT_ID), idKey(collectionId)]));
      assert.deepEqual(await ancestors(seasonId), new Set([idKey(seriesId), idKey(ROOT_ID), idKey(collectionId)]));
      assert.deepEqual(await ancestors(episodeId),
        new Set([idKey(seasonId), idKey(seriesId), idKey(ROOT_ID), idKey(collectionId)]));
      assert.deepEqual(await ancestors(rootEpisodeId), new Set([idKey(ROOT_ID), idKey(collectionId)]));
      assert.deepEqual(await ancestors(unnumberedSeasonId), new Set([idKey(seriesId), idKey(ROOT_ID), idKey(collectionId)]));
      assert.deepEqual(await ancestors(unnumberedEpisodeId),
        new Set([idKey(unnumberedSeasonId), idKey(seriesId), idKey(ROOT_ID), idKey(collectionId)]));
      for (const { folderPath, parentId, filename, seasonId: expectedSeasonId, ancestors: extraAncestors } of nestedFolders) {
        const folderId = itemId(folderPath, FOLDER_TYPE);
        const nestedEpisodeId = itemId(`${folderPath}\\${filename}`, episodeNativeType);
        const folder = await library.getItemRecord(folderId), nested = await library.getItemRecord(nestedEpisodeId);
        assert.equal(folder.Type, 'Folder'); assert.equal(folder.ParentId, parentId);
        assert.equal(nested.Type, 'Episode'); assert.equal(nested.ParentId, folderId);
        assert.equal(nested.SeriesId, seriesId);
        if (expectedSeasonId) assert.equal(nested.SeasonId, expectedSeasonId);
        else assert.equal(nonemptyId(nested.SeasonId), false);
        assert.equal(nested.IndexNumber, null, 'structural scanning does not replace metadata numbering');
        assert.deepEqual(await ancestors(nestedEpisodeId),
          new Set([folderId, ...extraAncestors, seriesId, ROOT_ID, collectionId].map(idKey)));
      }

      // Repository metadata can change episode/season numbering independently
      // of their physical directory relationship.
      await database.update('BaseItems', { Id: seasonId }, { IndexNumber: 0 });
      await database.update('BaseItems', { Id: episodeId }, { IndexNumber: 8, ParentIndexNumber: 0 });
      await database.update('BaseItems', { Id: flatId }, { IndexNumber: 3, ParentIndexNumber: 1, SeasonId: seasonId });
      const before = await snapshot(database);
      const second = await scanner.scan(reference);
      assert.deepEqual({ added: second.added, updated: second.updated, removed: second.removed },
        { added: 0, updated: 0, removed: 0 });
      assert.deepEqual(await snapshot(database), before);
      const repeatedRootEpisode = await library.getItemRecord(rootEpisodeId);
      assert.equal(repeatedRootEpisode.ParentId, ROOT_ID);
      assert.equal(nonemptyId(repeatedRootEpisode.SeriesId), false);
      assert.equal(nonemptyId(repeatedRootEpisode.SeasonId), false);

      await database.update('BaseItems', { Id: seasonId }, { SeriesId: FOREIGN_ID });
      const mismatched = await snapshot(database);
      await assert.rejects(scanner.scan(reference), error => {
        assert.equal(error.code, 'unsupported/relationship-reclassification-required');
        return true;
      });
      assert.deepEqual(await snapshot(database), mismatched,
        'an existing nonempty relationship is never silently replaced by the scanner');
    });

  test(`${dialect}: TV versions and stacks keep Episode identities, physical parents and owned video parts`, options,
    async t => {
      const { database, library, adapter, scanner, reference, itemCreation } = await fixture(t, dialect,
        [createVideoFileResolver(), createTvItemResolver()], { nativeActions: true });
      const aggregateId = 'D1000000-0000-0000-0000-000000000006';
      await database.insert('BaseItems', baseItem(aggregateId,
        'MediaBrowser.Controller.Entities.AggregateFolder', {
          Name: 'Aggregate', CleanName: 'aggregate', SortName: 'aggregate', IsFolder: true
        }));
      await database.update('BaseItems', { Id: ROOT_ID }, { ParentId: aggregateId });
      const collectionId = await insertCollection(database, 'tvshows');
      await adapter.mkdir('/Version Show');
      await adapter.mkdir('/Version Show/Season 01');
      const names = ['Version.Show.S01E01 - 1080p cd1.mkv', 'Other.Title.S01E01 - 720p cd1.mkv',
        'Version.Show.S01E02 - 1080p.mkv', 'Version.Show.S01E03 - 1080p cd1.mkv', 'Version.Show.S01E03 - 1080p cd2.mkv',
        'Other.Title.S01E01 - 720p cd2.mkv', 'Version.Show.S01E01 - 1080p cd2.mkv',
        'Other.Title.S01E02 - 720p.mkv'];
      for (const name of names) await adapter.write(`/Version Show/Season 01/${name}`, Buffer.from(name));
      const seriesPath = `${ROOT_PATH}\\Version Show`, seasonPath = `${seriesPath}\\Season 01`;
      const seriesId = itemId(seriesPath, seriesNativeType), seasonId = itemId(seasonPath, seasonNativeType);
      const paths = names.map(name => `${seasonPath}\\${name}`);
      const identities = paths.map((identityPath, index) => itemId(identityPath,
        index >= 4 && index <= 6 ? videoNativeType : episodeNativeType));
      const [primaryId, alternateId, otherId, stackId, partId, alternatePartId, primaryPartId, otherAlternateId] = identities;

      const result = await scanner.scan(reference);
      assert.equal(result.structurallyComplete, true);
      assert.equal((await library.getItemRecord(seriesId)).Type, 'Series');
      assert.equal((await library.getItemRecord(seasonId)).Type, 'Season');
      for (const id of [primaryId, alternateId, otherId, stackId, otherAlternateId]) {
        const item = await library.getItemRecord(id);
        assert.equal(item.Type, 'Episode'); assert.equal(item.ParentId, seasonId);
        assert.equal(item.SeriesId, seriesId); assert.equal(item.SeasonId, seasonId);
        assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: id } })).map(row => idKey(row.ParentItemId))),
          new Set([seasonId, seriesId, ROOT_ID, aggregateId, collectionId].map(idKey)));
      }
      const primary = await library.getItemRecord(primaryId), alternate = await library.getItemRecord(alternateId);
      assert.deepEqual(primary.LocalAlternateVersions, [paths[1]]);
      assert.deepEqual(primary.AdditionalParts, [paths[6]]);
      const primaryPart = await library.getItemRecord(primaryPartId);
      assert.equal(primaryPart.NativeType, videoNativeType); assert.equal(primaryPart.OwnerId, primaryId);
      assert.equal(alternate.OwnerId, primaryId); assert.equal(alternate.PrimaryVersionId, primaryId);
      assert.deepEqual(alternate.AdditionalParts, [paths[5]]);
      const alternatePart = await library.getItemRecord(alternatePartId);
      assert.equal(alternatePart.NativeType, videoNativeType); assert.equal(alternatePart.OwnerId, alternateId);
      assert.equal(alternatePart.ParentId, seasonId); assert.ok(!nonemptyId(alternatePart.PrimaryVersionId));
      const versions = await database.rows('LinkedChildren', { where: { ParentId: primaryId, ChildType: 2 } });
      assert.deepEqual(versions.map(row => row.ChildId), [alternateId]);
      assert.ok(!nonemptyId((await library.getItemRecord(otherId)).OwnerId));
      const stack = await library.getItemRecord(stackId), part = await library.getItemRecord(partId);
      assert.deepEqual(stack.AdditionalParts, [paths[4]]);
      assert.equal(part.NativeType, videoNativeType); assert.equal(part.ParentId, seasonId);
      assert.equal(part.OwnerId, stackId); assert.ok(!nonemptyId(part.PrimaryVersionId));

      const before = await snapshot(database);
      const repeated = await scanner.scan(reference);
      assert.equal(repeated.structurallyComplete, true);
      assert.deepEqual({ added: repeated.added, updated: repeated.updated, removed: repeated.removed },
        { added: 0, updated: 0, removed: 0 });
      assert.deepEqual(await snapshot(database), before);

      await adapter.delete(`/Version Show/Season 01/${names[1]}`);
      await adapter.delete(`/Version Show/Season 01/${names[5]}`);
      await database.insert('BaseItems', baseItem(FOREIGN_ID, videoNativeType, {
        Name: 'Unmanaged owned video', Path: 'X:\\Unrelated\\part.mkv', MediaType: 'Video',
        ParentId: null, TopParentId: ROOT_ID, OwnerId: alternateId,
        Data: JSON.stringify({ SourceType: 'Library', VideoType: 'VideoFile' })
      }));
      const guarded = await snapshot(database);
      await assert.rejects(scanner.scan(reference), error => {
        assert.equal(error.code, 'unsupported/type-reclassification-required');
        assert.match(error.message, /missing local alternate.*still owns items/u);
        return true;
      });
      assert.deepEqual(await snapshot(database), guarded,
        'a missing alternate cannot delete an unrelated item merely because its OwnerId matches');
      await database.delete('BaseItems', { Id: FOREIGN_ID });
      const removed = await scanner.scan(reference);
      assert.equal(removed.structurallyComplete, true);
      assert.equal((await database.rows('BaseItems', { where: { Id: alternateId } })).length, 0);
      assert.equal((await database.rows('BaseItems', { where: { Id: alternatePartId } })).length, 0);
      assert.deepEqual((await library.getItemRecord(primaryId)).LocalAlternateVersions, []);
      assert.deepEqual(await database.rows('LinkedChildren', { where: { ParentId: primaryId, ChildType: 2 } }), []);
      assert.equal((await library.getItemRecord(primaryPartId)).OwnerId, primaryId);
      assert.deepEqual((await library.getItemRecord(stackId)).AdditionalParts, [paths[4]]);

      // Ordinary Episode versions use the same live DeleteItem promotion and
      // manual-reference rerouting as Movies when their primary disappears.
      await database.insert('LinkedChildren', { ParentId: ROOT_ID, ChildId: otherId, ChildType: 0, SortOrder: 0 });
      itemCreation.unregisterItem(ROOT_ID);
      const caller = await itemCreation.getItemById(ROOT_ID);
      const manualLinks = async () => (await itemCreation.linkedChildren.page(caller.LinkedChildren, { limit: 8 }))
        .map(link => idKey(link.ItemId));
      assert.deepEqual(await manualLinks(), [idKey(otherId)]);
      assert.deepEqual((await library.getItemRecord(otherId)).LocalAlternateVersions, [paths[7]]);
      await adapter.delete(`/Version Show/Season 01/${names[2]}`);
      const promoted = await scanner.scan(reference);
      assert.equal(promoted.structurallyComplete, true);
      assert.deepEqual(await database.rows('BaseItems', { where: { Id: otherId } }), []);
      assert.equal(await itemCreation.getItemById(otherId), null);
      assert.deepEqual((await database.rows('LinkedChildren', { where: { ParentId: ROOT_ID, ChildType: 0 } }))
        .map(link => idKey(link.ChildId)), [idKey(otherAlternateId)]);
      assert.deepEqual(await manualLinks(), [idKey(otherAlternateId)]);
      itemCreation.unregisterItem(otherAlternateId);
      const survivor = await itemCreation.getItemById(otherAlternateId);
      assert.equal(survivor.Type, 'Episode'); assert.equal(survivor.Path, paths[7]);
      assert.equal(survivor.ParentId, seasonId); assert.equal(survivor.SeriesId, seriesId); assert.equal(survivor.SeasonId, seasonId);
      assert.ok(!nonemptyId(survivor.OwnerId)); assert.ok(!nonemptyId(survivor.PrimaryVersionId));
      assert.deepEqual(survivor.LocalAlternateVersions, []);
      assert.equal((await adapter.stat(`/Version Show/Season 01/${names[7]}`)).kind, 'file');
      const afterPromotion = await snapshot(database);
      const afterPromotionLinks = await database.rows('LinkedChildren');
      const stablePromotion = await scanner.scan(reference);
      assert.equal(stablePromotion.structurallyComplete, true);
      assert.deepEqual({ added: stablePromotion.added, updated: stablePromotion.updated, removed: stablePromotion.removed },
        { added: 0, updated: 0, removed: 0 });
      assert.deepEqual(await snapshot(database), afterPromotion);
      assert.deepEqual(await database.rows('LinkedChildren'), afterPromotionLinks);
    });

  test(`${dialect}: Series and Season are direct structural scan roots within their physical library`, options,
    async t => {
      const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [createTvItemResolver()]);
      await insertCollection(database, 'tvshows');
      await adapter.mkdir('/Direct Show');
      await adapter.mkdir('/Direct Show/Season 01');
      await adapter.write('/Direct Show/Season 01/Direct.Show.S01E01.mkv', Buffer.from('one'));
      await adapter.mkdir('/Untouched Show');
      await adapter.mkdir('/Untouched Show/Season 01');
      await adapter.write('/Untouched Show/Season 01/Untouched.Show.S01E01.mkv', Buffer.from('untouched'));
      await scanner.scan(reference);

      const seriesPath = `${ROOT_PATH}\\Direct Show`;
      const seasonPath = `${seriesPath}\\Season 01`;
      const seriesId = itemId(seriesPath, seriesNativeType);
      const seasonId = itemId(seasonPath, seasonNativeType);
      const series = await library.getItemRecord(seriesId);
      const season = await library.getItemRecord(seasonId);
      assert.equal(scanner.supports(series), true);
      assert.equal(scanner.supports(season), true);
      assert.equal(scanner.capabilities.directStructuralRoots, true);

      await adapter.write('/Direct Show/Season 01/Direct.Show.S01E02.mkv', Buffer.from('two'));
      // An unsupported sibling outside the requested subtree must not poison a
      // direct Season scan.
      await adapter.mkdir('/Untouched Show/Season 01/Alternate.S01E01');
      await adapter.mkdir('/Untouched Show/Season 01/Alternate.S01E01/BDMV');
      const seasonResult = await scanner.scan(season);
      assert.equal(seasonResult.structurallyComplete, true);
      assert.equal(seasonResult.added, 1);
      const episodeTwoId = itemId(`${seasonPath}\\Direct.Show.S01E02.mkv`, episodeNativeType);
      const [episodeTwo] = await database.rows('BaseItems', { where: { Id: episodeTwoId } });
      assert.equal(episodeTwo.ParentId, seasonId);
      assert.equal(episodeTwo.TopParentId, ROOT_ID);
      assert.equal(episodeTwo.SeriesId, seriesId);
      assert.equal(episodeTwo.SeasonId, seasonId);

      await adapter.mkdir('/Direct Show/Season 02');
      await adapter.write('/Direct Show/Season 02/Direct.Show.S02E01.mkv', Buffer.from('season two'));
      const seriesResult = await scanner.scan(series);
      assert.equal(seriesResult.structurallyComplete, true);
      assert.equal(seriesResult.added, 2);
      const seasonTwoPath = `${seriesPath}\\Season 02`;
      const seasonTwoId = itemId(seasonTwoPath, seasonNativeType);
      const episodeId = itemId(`${seasonTwoPath}\\Direct.Show.S02E01.mkv`, episodeNativeType);
      const [episode] = await database.rows('BaseItems', { where: { Id: episodeId } });
      assert.equal(episode.ParentId, seasonTwoId);
      assert.equal(episode.TopParentId, ROOT_ID);
      assert.equal(episode.SeriesId, seriesId);
      assert.equal(episode.SeasonId, seasonTwoId);

      const stable = await snapshot(database);
      await database.update('BaseItems', { Id: seriesId }, { Path: `${ROOT_PATH}\\Detached Show` });
      await assert.rejects(scanner.scan(season), error => {
        assert.equal(error.code, 'invalid-response');
        assert.match(error.message, /physical (?:identity|parent chain)/u);
        return true;
      });
      await database.update('BaseItems', { Id: seriesId }, { Path: seriesPath });
      assert.deepEqual(await snapshot(database), stable,
        'a rejected direct root cannot mutate its subtree or ancestor state');
    });

  test(`${dialect}: TV disc episodes, shortcuts and unnumbered folders complete structural scanning`, options, async t => {
    const { database, adapter, scanner, reference } = await fixture(t, dialect, [createTvItemResolver()]);
    await insertCollection(database, 'tvshows');
    await adapter.mkdir('/Example Show');
    await adapter.mkdir('/Example Show/Unnumbered Season');
    await adapter.mkdir('/Example Show/Season 01');
    await adapter.mkdir('/Example Show/Season 01/Example.Show.S01E01');
    await adapter.mkdir('/Example Show/Season 01/Example.Show.S01E01/BDMV');
    await adapter.write('/Example Show/Season 01/Alternate.S01E01.strm', Buffer.from('shortcut'));

    const result = await scanner.scan(reference);

    assert.equal(result.structurallyComplete, true);
    const [ordinaryFolder] = await database.rows('BaseItems', { where: {
      Path: `${ROOT_PATH}\\Example Show\\Unnumbered Season`
    } });
    assert.equal(ordinaryFolder.Type, FOLDER_TYPE);
    const [disc] = await database.rows('BaseItems', { where: {
      Path: `${ROOT_PATH}\\Example Show\\Season 01\\Example.Show.S01E01`
    } });
    assert.equal(disc.Type, episodeNativeType);
    assert.equal(disc.IsFolder, false);
    assert.equal(JSON.parse(disc.Data).VideoType, 'BluRay');
    const [shortcut] = await database.rows('BaseItems', { where: {
      Path: `${ROOT_PATH}\\Example Show\\Season 01\\Alternate.S01E01.strm`
    } });
    assert.equal(shortcut.Type, episodeNativeType);
    assert.equal(JSON.parse(shortcut.Data).IsShortcut, true);
  });

  test(`${dialect}: a weak TV root snapshot writes no TV identities and carries an incomplete proof`, options, async t => {
    const { database, adapter, vfs, scanner, reference } = await fixture(t, dialect, [createTvItemResolver()]);
    await insertCollection(database, 'tvshows');
    await adapter.mkdir('/Weak Show');
    await adapter.mkdir('/Weak Show/Season 1');
    const list = vfs.list.bind(vfs);
    vfs.list = async (path, listOptions) => {
      const listing = await list(path, listOptions);
      return path === '/library' ? { ...listing, consistency: 'weak', snapshot: null, deletionSafe: false } : listing;
    };
    const weak = await scanner.scan(reference);
    assert.equal(weak.structurallyComplete, false);
    assert.ok(weak.incompleteReasons.some(reason => reason.code === folderScanIncompleteReasonCodes.WEAK_DIRECTORY_SNAPSHOT));
    assert.ok(weak.incompleteReasons.some(reason => reason.code === folderScanIncompleteReasonCodes.RESOLVER_PATH_WITHHELD));
    assert.equal((await database.rows('BaseItems', { where: { Path: `${ROOT_PATH}\\Weak Show` } })).length, 0);
  });

  test(`${dialect}: a late TV episode path collision rolls back Series, Season, relationships and events`, options,
    async t => {
      const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [createTvItemResolver()]);
      await insertCollection(database, 'tvshows');
      await adapter.mkdir('/Rollback Show');
      await adapter.mkdir('/Rollback Show/Season 1');
      await adapter.write('/Rollback Show/Season 1/Rollback.Show.S01E01.mkv', Buffer.from('episode'));
      const seriesPath = `${ROOT_PATH}\\Rollback Show`;
      const seasonPath = `${seriesPath}\\Season 1`;
      const episodePath = `${seasonPath}\\Rollback.Show.S01E01.mkv`;
      await database.insert('BaseItems', baseItem(FOREIGN_ID, 'Plugin.Entities.ForeignVideo', {
        Name: 'Foreign path owner',
        Path: episodePath,
        ParentId: ROOT_ID,
        TopParentId: ROOT_ID,
        IsFolder: false,
        MediaType: 'Video'
      }));
      const before = await snapshot(database);
      const events = [];
      for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) {
        library.on(name, event => events.push([name, event.Item.Id]));
      }

      await assert.rejects(scanner.scan(reference), { code: 'invalid-response' });

      assert.deepEqual(await snapshot(database), before);
      assert.deepEqual(events, []);
      assert.equal((await database.rows('BaseItems', { where: { Id: itemId(seriesPath, seriesNativeType) } })).length, 0);
      assert.equal((await database.rows('BaseItems', { where: { Id: itemId(seasonPath, seasonNativeType) } })).length, 0);
    });

  test(`${dialect}: TV subtree deletion preserves external references, then removes the complete hierarchy`, options,
    async t => {
      const { database, adapter, scanner, reference } = await fixture(t, dialect, [createTvItemResolver()]);
      await insertCollection(database, 'tvshows');
      await adapter.mkdir('/Delete Show');
      await adapter.mkdir('/Delete Show/Season 1');
      await adapter.write('/Delete Show/Season 1/Delete.Show.S01E01.mkv', Buffer.from('episode'));
      await adapter.mkdir('/Keep Show');
      await adapter.mkdir('/Keep Show/Season 1');
      await scanner.scan(reference);
      const seriesPath = `${ROOT_PATH}\\Delete Show`;
      const seasonPath = `${seriesPath}\\Season 1`;
      const episodePath = `${seasonPath}\\Delete.Show.S01E01.mkv`;
      const seriesId = itemId(seriesPath, seriesNativeType);
      const seasonId = itemId(seasonPath, seasonNativeType);
      const episodeId = itemId(episodePath, episodeNativeType);
      await database.insert('BaseItems', baseItem(FOREIGN_ID, 'Plugin.Entities.ExternalReference', {
        Name: 'External reference',
        Path: 'X:\\External\\Reference',
        SeriesId: seriesId,
        TopParentId: FOREIGN_ID,
        IsFolder: false
      }));
      await adapter.delete('/Delete Show/Season 1/Delete.Show.S01E01.mkv');
      await adapter.delete('/Delete Show/Season 1');
      await adapter.delete('/Delete Show');

      const protectedResult = await scanner.scan(reference);

      assert.equal(protectedResult.structurallyComplete, false);
      assert.ok(protectedResult.incompleteReasons.some(reason =>
        reason.code === folderScanIncompleteReasonCodes.EXTERNAL_REFERENCE_DELETION_SKIPPED
          && idKey(reason.itemId) === idKey(seriesId)));
      for (const id of [seriesId, seasonId, episodeId]) {
        assert.equal((await database.rows('BaseItems', { where: { Id: id } })).length, 1);
      }

      await database.delete('BaseItems', { Id: FOREIGN_ID });
      const removed = await scanner.scan(reference);
      assert.equal(removed.structurallyComplete, true);
      assert.equal(removed.removed, 3);
      for (const id of [seriesId, seasonId, episodeId]) {
        assert.equal((await database.rows('BaseItems', { where: { Id: id } })).length, 0);
        assert.equal((await database.rows('AncestorIds', { where: { ItemId: id } })).length, 0);
      }
    });

  test(`${dialect}: music tracks persist native parents, ancestors and create-only tag columns in albums, artists and roots`, options,
    async t => {
      const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [createAudioItemResolver()]);
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

      const result = await scanner.scan(reference);

      assert.equal(result.structurallyComplete, true);
      assert.equal(scanner.capabilities.completeLibraryScan, false);
      assert.deepEqual(scanner.capabilities.productionMediaScopes,
        ['music-ordinary-tracks-and-conventional-albums']);
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
      assert.deepEqual(JSON.parse(rows.firstTrack.Data), { SourceType: 'Library' });
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
        new Set([idKey(ids.directAlbum), idKey(ROOT_ID), idKey(collectionId)]));
      assert.deepEqual(await ancestors(ids.firstTrack),
        new Set([idKey(ids.firstAlbum), idKey(ids.artist), idKey(ROOT_ID), idKey(collectionId)]));
      assert.deepEqual(await ancestors(ids.rootTrack), new Set([idKey(ROOT_ID), idKey(collectionId)]));
      assert.deepEqual(await ancestors(ids.artistTrack), new Set([idKey(ids.artist), idKey(ROOT_ID), idKey(collectionId)]));
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
      const rescanned = await scanner.scan(reference);
      assert.equal(rescanned.updated, 0);
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
      const cueOnly = await scanner.scan(reference);
      assert.equal(cueOnly.structurallyComplete, true);
      assert.equal(cueOnly.removed, 1);
      const [cueAlbum] = await database.rows('BaseItems', { where: { Id: ids.directAlbum } });
      assert.equal(cueAlbum.Type, musicAlbumNativeType, 'CUE retains the Album identity without creating an Audio item');
      assert.equal(cueAlbum.Path, paths.directAlbum);
      assert.equal(cueAlbum.ParentId, ROOT_ID);
      assert.equal((await database.rows('BaseItems', { where: { Id: ids.directTrack } })).length, 0);
      assert.deepEqual(await database.rows('AncestorIds', { where: { ItemId: ids.directTrack } }), []);
      assert.equal((await database.rows('BaseItems', { where: { Path: `${paths.directAlbum}\\disc.cue` } })).length, 0);
      await adapter.delete('/Direct Album/disc.cue');
      await adapter.write('/Direct Album/Track.flac', Buffer.from('direct'));

      for (const target of [
        '/Loose.3gp', '/Artist/Loose.rm', '/Artist/Clip.mkv',
        '/Artist/First Album/One.mp3', '/Artist/First Album/Clip.mkv', '/Artist/Second Album/Two.nsv',
        '/Artist/First Album', '/Artist/Second Album', '/Artist'
      ]) await adapter.delete(target);
      const removed = await scanner.scan(reference);
      assert.equal(removed.structurallyComplete, true);
      assert.equal(removed.removed, 7);
      for (const key of ['rootTrack', 'artistTrack', 'artist', 'firstAlbum', 'firstTrack', 'secondAlbum', 'secondTrack']) {
        assert.equal((await database.rows('BaseItems', { where: { Id: ids[key] } })).length, 0);
        assert.equal((await database.rows('AncestorIds', { where: { ItemId: ids[key] } })).length, 0);
      }
      assert.equal((await database.rows('BaseItems', { where: { Id: ids.directAlbum } })).length, 1);
    });

  test(`${dialect}: an untyped library persists Audio and Movie files through ordinary Folders`, options, async t => {
    const { database, library, adapter, scanner, reference } = await fixture(t, dialect,
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
    const result = await scanner.scan(reference);
    assert.equal(result.structurallyComplete, true);
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
      new Set([ROOT_ID, collectionId, ...(entry.parentId === folderId ? [folderId] : [])].map(idKey)));
    }
    const before = await snapshot(database);
    const repeated = await scanner.scan(reference);
    assert.deepEqual({ added: repeated.added, updated: repeated.updated, removed: repeated.removed },
      { added: 0, updated: 0, removed: 0 });
    assert.deepEqual(await snapshot(database), before);
    await adapter.delete('/Song.flac');
    await adapter.delete('/Film (2020).mp4');
    const removed = await scanner.scan(reference);
    assert.equal(removed.structurallyComplete, true);
    assert.equal(removed.removed, 2);
    for (const entry of entries.slice(0, 2)) {
      assert.deepEqual(await database.rows('BaseItems', { where: { Id: entry.id } }), []);
      assert.deepEqual(await database.rows('AncestorIds', { where: { ItemId: entry.id } }), []);
    }
    for (const entry of entries.slice(2)) assert.equal((await library.getItemRecord(entry.id)).ParentId, entry.parentId);
  });

  test(`${dialect}: MusicArtist and MusicAlbum are direct structural scan roots within their physical library`, options,
    async t => {
      const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [createAudioItemResolver()]);
      await insertCollection(database, 'music');
      await adapter.mkdir('/Direct Album');
      await adapter.write('/Direct Album/One.flac', Buffer.from('one'));
      await adapter.mkdir('/Direct Artist');
      await adapter.mkdir('/Direct Artist/First Album');
      await adapter.write('/Direct Artist/First Album/One.mp3', Buffer.from('one'));
      await scanner.scan(reference);

      const albumPath = `${ROOT_PATH}\\Direct Album`;
      const artistPath = `${ROOT_PATH}\\Direct Artist`;
      const albumId = itemId(albumPath, musicAlbumNativeType);
      const artistId = itemId(artistPath, musicArtistNativeType);
      const album = await library.getItemRecord(albumId);
      const artist = await library.getItemRecord(artistId);
      assert.equal(scanner.supports(album), true);
      assert.equal(scanner.supports(artist), true);

      await adapter.write('/Direct Album/Two.wav', Buffer.from('two'));
      await adapter.write('/Loose.mp3', Buffer.from('outside requested subtree'));
      const albumResult = await scanner.scan(album);
      assert.equal(albumResult.structurallyComplete, true);
      assert.equal(albumResult.added, 1);
      const trackId = itemId(`${albumPath}\\Two.wav`, audioNativeType);
      const [track] = await database.rows('BaseItems', { where: { Id: trackId } });
      assert.equal(track.ParentId, albumId);
      assert.equal(track.TopParentId, ROOT_ID);

      await adapter.mkdir('/Direct Artist/Second Album');
      await adapter.write('/Direct Artist/Second Album/Two.ogg', Buffer.from('two'));
      const artistResult = await scanner.scan(artist);
      assert.equal(artistResult.structurallyComplete, true);
      assert.equal(artistResult.added, 2);
      const secondAlbumPath = `${artistPath}\\Second Album`;
      const secondAlbumId = itemId(secondAlbumPath, musicAlbumNativeType);
      const secondTrackId = itemId(`${secondAlbumPath}\\Two.ogg`, audioNativeType);
      const [secondTrack] = await database.rows('BaseItems', { where: { Id: secondTrackId } });
      assert.equal(secondTrack.ParentId, secondAlbumId);
      assert.equal(secondTrack.TopParentId, ROOT_ID);
    });

  for (const grouped of [false, true]) test(`${dialect}: multi-disc Albums ${grouped ? 'inside Artist groups' : 'at the library root'} retain physical parents and stable tracks through repeat and deletion`, options,
    async t => {
      const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [createAudioItemResolver()]);
      const collectionId = await insertCollection(database, 'music');
      const relativeAlbum = grouped ? '/Grouped Artist/Albums/Multi Disc' : '/Multi Disc';
      if (grouped) {
        await adapter.mkdir('/Grouped Artist');
        await adapter.mkdir('/Grouped Artist/Albums');
      }
      await adapter.mkdir(relativeAlbum);
      await adapter.mkdir(`${relativeAlbum}/Artwork`);
      const albumPath = ROOT_PATH + relativeAlbum.replaceAll('/', '\\'), albumId = itemId(albumPath, musicAlbumNativeType);
      const artistId = itemId(`${ROOT_PATH}\\Grouped Artist`, musicArtistNativeType);
      const groupId = itemId(`${ROOT_PATH}\\Grouped Artist\\Albums`, FOLDER_TYPE);
      const groupAncestors = grouped ? [groupId, artistId] : [];
      const discs = [];
      for (const name of ['CD1', 'CD2']) {
        await adapter.mkdir(`${relativeAlbum}/${name}`);
        await adapter.write(`${relativeAlbum}/${name}/01 Track.flac`, Buffer.from(name));
        const discPath = `${albumPath}\\${name}`, trackPath = `${discPath}\\01 Track.flac`;
        discs.push({ discPath, trackPath, folderParentId: albumId, extraAncestors: [],
          discId: itemId(discPath, FOLDER_TYPE), trackId: itemId(trackPath, audioNativeType) });
      }
      if (grouped) {
        await adapter.mkdir(`${relativeAlbum}/CD1/Archive`);
        await adapter.write(`${relativeAlbum}/CD1/Archive/Bonus.flac`, Buffer.from('nested album track'));
        const discPath = `${albumPath}\\CD1\\Archive`, trackPath = `${discPath}\\Bonus.flac`;
        discs.push({ discPath, trackPath, folderParentId: discs[0].discId, extraAncestors: [discs[0].discId],
          discId: itemId(discPath, FOLDER_TYPE), trackId: itemId(trackPath, audioNativeType) });
      }

      const result = await scanner.scan(reference);
      assert.equal(result.structurallyComplete, true);
      const albums = await database.rows('BaseItems', { where: { Type: musicAlbumNativeType } });
      assert.equal(albums.length, 1);
      assert.equal(albums[0].Id, albumId);
      assert.equal(albums[0].ParentId, grouped ? groupId : ROOT_ID);
      assert.equal((await database.rows('BaseItems', { where: { Type: musicArtistNativeType } })).length, grouped ? 1 : 0);
      if (grouped) {
        const group = await library.getItemRecord(groupId);
        assert.equal(group.Type, 'Folder');
        assert.equal(group.ParentId, artistId);
      }
      const [artwork] = await database.rows('BaseItems', { where: { Path: `${albumPath}\\Artwork` } });
      assert.equal(artwork.Type, FOLDER_TYPE);
      assert.equal(artwork.ParentId, albumId);
      for (const { discPath, trackPath, discId, trackId, folderParentId, extraAncestors } of discs) {
        const disc = await library.getItemRecord(discId), track = await library.getItemRecord(trackId);
        assert.equal(disc.NativeType, FOLDER_TYPE);
        assert.equal(disc.Path, discPath);
        assert.equal(disc.ParentId, folderParentId);
        assert.equal(track.NativeType, audioNativeType);
        assert.equal(track.Path, trackPath);
        assert.equal(track.ParentId, discId);
        assert.equal(repositoryTopParentId(track), ROOT_ID);
        assert.equal(track.ParentIndexNumber, null, 'a disc directory does not supply audio tag metadata');
        assert.deepEqual(new Set((await database.rows('AncestorIds', { where: { ItemId: trackId } }))
          .map(row => idKey(row.ParentItemId))), new Set([discId, ...extraAncestors, albumId, ...groupAncestors, ROOT_ID, collectionId].map(idKey)));
        const dto = await library.getItem(trackId, { EnableImages: false });
        assert.equal(idKey(dto.AlbumId), idKey(albumId));
      }

      const before = await snapshot(database);
      const repeated = await scanner.scan(reference);
      assert.equal(repeated.structurallyComplete, true);
      assert.deepEqual({ added: repeated.added, updated: repeated.updated, removed: repeated.removed },
        { added: 0, updated: 0, removed: 0 });
      assert.deepEqual(await snapshot(database), before);

      await adapter.delete(`${relativeAlbum}/CD2/01 Track.flac`);
      await adapter.delete(`${relativeAlbum}/CD2`);
      const removed = await scanner.scan(reference);
      assert.equal(removed.structurallyComplete, true, 'one remaining music-bearing disc still identifies the Album');
      assert.equal(removed.removed, 2);
      for (const Id of [discs[1].discId, discs[1].trackId]) {
        assert.equal((await database.rows('BaseItems', { where: { Id } })).length, 0);
        assert.equal((await database.rows('AncestorIds', { where: { ItemId: Id } })).length, 0);
      }
      assert.equal((await library.getItemRecord(discs[0].trackId)).ParentId, discs[0].discId);
      assert.equal(idKey((await library.getItem(discs[0].trackId, { EnableImages: false })).AlbumId), idKey(albumId));
    });

  test(`${dialect}: CUE albums, ordinary release names and empty music folders follow their physical hierarchy`, options,
    async t => {
      const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [createAudioItemResolver()]);
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

      const result = await scanner.scan(reference);

      assert.equal(result.structurallyComplete, true);
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
        new Set([albumId, artistId, ROOT_ID, collectionId].map(idKey)));
      assert.equal((await database.rows('BaseItems')).some(item => /\.cue$/iu.test(item.Path ?? '')), false);
      const [loose] = await database.rows('BaseItems', { where: { Path: `${ROOT_PATH}\\Loose.mp3` } });
      assert.equal(loose.Type, audioNativeType);
      assert.equal(loose.ParentId, ROOT_ID);
      const before = await snapshot(database);
      const repeated = await scanner.scan(reference);
      assert.equal(repeated.structurallyComplete, true);
      assert.deepEqual({ added: repeated.added, updated: repeated.updated, removed: repeated.removed },
        { added: 0, updated: 0, removed: 0 });
      assert.deepEqual(await snapshot(database), before);
    });

  test(`${dialect}: a single resolver failure is reported and later candidates still reconcile`, options, async t => {
    const failingResolver = {
      id: 'test-failing-file',
      nativeTypes: { [MOVIE_TYPE]: { isFolder: false } },
      resolveFile({ candidate }) {
        if (candidate.entry.name === 'b-fail.mkv') throw new Error('injected resolver failure');
        return candidate.entry.name.endsWith('.mkv') ? movieClaim(candidate) : null;
      }
    };
    const errors = [];
    const { database, library, adapter, scanner, reference } = await fixture(t, dialect, [failingResolver], {
      onResolverError: error => errors.push(error)
    });
    await adapter.write('/a-planned.mkv', Buffer.from('planned'));
    await adapter.write('/b-fail.mkv', Buffer.from('failure'));
    const events = [];
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) library.on(name, event => events.push([name, event.Item.Id]));

    await scanner.scan(reference);

    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /injected resolver failure/u);
    assert.equal((await database.rows('BaseItems', { where: { Path: `${ROOT_PATH}\\a-planned.mkv` } })).length, 1);
    assert.equal((await database.rows('BaseItems', { where: { Path: `${ROOT_PATH}\\b-fail.mkv` } })).length, 0);
    assert.equal(events.length, 1);
  });
}
