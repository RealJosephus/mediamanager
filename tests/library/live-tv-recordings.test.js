import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { LibraryService } from '../../src/library/library-service.js';
import { LiveTvService } from '../../src/library/live-tv-service.js';
import { LiveTvRecordingsService } from '../../src/library/live-tv-recordings-service.js';
import { createPostgresRecordingQuery } from '../../src/library/postgres-live-tv-recordings-query.js';
import { MetadataImageAssets } from '../../src/metadata/image-assets.js';
import { idKey, guid, mapRecord, loadLibrary, repositoryValue } from '../../src/library/records.js';
import { setFolderChildren } from '../../src/library/folder-cache.js';
import { newNativeItemEntity, cloneNativeItemEntity, captureNativeItemState, restoreNativeItemState } from '../../src/library/native-item-entity.js';
import { dtoOptions, projectItem } from '../../src/library/dto.js';
import { tableDefinition } from '../../src/database/model.js';
import { nativeItemJsonContract, serializeNativeItemData } from '../../src/library/native-item-data.js';
import { canDeleteItem } from '../../src/library/delete-permission.js';
import { nativeTextBytes } from '../../src/database/native-text.js';
import { nativeTextSql } from '../../src/database/native-text-sql.js';
import { testFileSystem } from '../storage/plugin-files.js';
import { nativeGuid } from '../../src/users/native.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = index => `a9300000-0000-0000-0000-${String(index).padStart(12, '0')}`;
const tables = ['BaseItems', 'AncestorIds', 'ItemValues', 'ItemValuesMap'];
const channelType = 'MediaBrowser.Controller.Channels.Channel';
const channelProjection = item => Object.fromEntries(Object.entries({
  type: item.NativeType, sourceType: item.SourceType, mediaType: item.MediaType, unratedType: item.UnratedType,
  IsFolder: item.IsFolder, IsHidden: item.IsHidden, IsDisplayedAsFolder: item.IsDisplayedAsFolder,
  SupportsPlayedStatus: item.SupportsPlayedStatus, SupportsPositionTicksResume: item.SupportsPositionTicksResume,
  canDelete: canDeleteItem(item), IsRoot: item.IsRoot, Container: item.Container, Width: item.Width, Height: item.Height,
  Size: item.Size == null ? null : Number(item.Size), id: idKey(item.Id), channelId: idKey(item.ChannelId), Name: item.Name, Path: item.Path,
  serialized: serializeNativeItemData(item),
}).filter(([_name, value]) => value != null));
const stable = rows => rows.map(row => JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? String(value) : value)).sort();
const projection = value => ({ Items: value.Items.map(item => ({ Id: idKey(item.Id), Name: item.Name, Type: item.Type,
  ...Object.fromEntries(['Tags', 'CanDelete', 'CanDownload', 'DisplayPreferencesId', 'Etag']
    .filter(name => item[name] != null).map(name => [name, item[name]])) })), TotalRecordCount: value.TotalRecordCount, StartIndex: value.StartIndex });

function inputFixture() {
  const item = (index, type, name, location, parent, extra = {}) => ({ id: id(index), type, name, path: '{root}/' + location,
    sortName: name.toLowerCase(), ...(parent && { parentId: id(parent) }), ...extra });
  const video = (index, type, name, extra = {}) => item(index, type, name, 'media/' + name + '.mkv', 3,
    { mediaType: 'Video', ancestors: [id(4)], ...extra });
  const items = [
    item(1, 'AggregateFolder', 'Aggregate', 'aggregate'), item(2, 'UserRootFolder', 'Root', 'user'),
    item(3, 'Folder', 'Physical', 'media', 1),
    item(4, 'CollectionFolder', 'Recording 2', 'user/recordings', 2, { physicalLocations: ['{root}/media'] }),
    item(5, 'Folder', 'Movies', 'movies', 1),
    item(6, 'CollectionFolder', 'Recording 10', 'user/movies', 2, { physicalLocations: ['{root}/movies'] }),
    item(7, 'Folder', 'Old physical', 'media', 1, { dateCreated: '2024-01-01T00:00:00Z' }),
    item(8, 'Folder', 'Owned newer source', 'media', 5, { ownerId: id(3), dateCreated: '2028-01-01T00:00:00Z' }),
    item(9, 'Folder', 'Alternate newer source', 'media', 5, { primaryVersionId: id(3), dateCreated: '2029-01-01T00:00:00Z' }),
    item(21, 'Folder', 'Unselected ancestor', 'elsewhere', 1),
    video(10, 'Movie', 'Feature', { genres: ['Sports'], tags: ['retained'] }),
    video(11, 'Episode', 'Episode', { genres: ['Children'], dateCreated: '2025-01-02T00:00:00Z' }),
    video(12, 'Video', 'Home video', { genres: ['Family'] }),
    video(13, 'Movie', 'Duplicate low', { presentation: 'shared-feature', dateCreated: '2025-01-03T00:00:00Z' }),
    video(14, 'Movie', 'Duplicate high', { presentation: 'shared-feature', dateCreated: '2025-01-04T00:00:00Z' }),
    video(15, 'Movie', 'Virtual', { isVirtualItem: true }),
    video(16, 'Movie', 'Owned extra', { ownerId: id(10) }),
    video(17, 'Movie', 'Alternate', { primaryVersionId: id(10) }),
    item(18, 'Audio', 'Audio', 'media/audio.flac', 3, { mediaType: 'Audio', ancestors: [id(4)] }),
    video(19, 'Movie', 'Wrong ancestor', { ancestors: [id(21)] }),
    video(20, 'Movie', 'No ancestor', { ancestors: [] }),
    ...Array.from({ length: 131 }, (_, index) => video(100 + index, index % 2 ? 'Episode' : 'Movie', 'Batch ' + String(index).padStart(3, '0'),
      { dateCreated: '2025-01-05T00:00:00Z' })),
  ];
  const request = (name, query = {}, extra = {}) => ({ name, query: { Fields: ['Tags', 'CanDelete', 'CanDownload', 'DisplayPreferencesId', 'Etag'], ...query }, ...extra });
  return { userId: id(900), folderFailureTargetId: id(3), configuration: { RecordingPath: '{root}/media', MovieRecordingPath: '{root}/movies', SeriesRecordingPath: '{root}/movies' },
    folderFailureCases: [
      { name: 'null recording path and no default directory', path: null },
      { name: 'empty recording path and no default directory', path: '' },
      { name: 'missing recording directory', path: '{root}/nullable/missing', directory: false },
      { name: 'existing empty directory without a persisted physical source', path: '{root}/nullable/empty', directory: true },
      ...['Folder', 'UserRootFolder', 'UserView', 'BoxSet', 'Channel', 'CollectionFolder', 'Playlist'].map(type =>
        ({ name: 'null user with actual ' + type + ' source', path: '{root}/nullable/' + type, type, directory: true })),
      { name: 'disabled collection skips visibility then dereferences provider user', path: '{root}/nullable/disabled', type: 'CollectionFolder', disabled: true, directory: true },
      { name: 'disabled collection continues to next physical source', path: '{root}/nullable/disabled-next', type: 'CollectionFolder', disabled: true, nextPhysical: true, directory: true },
      { name: 'shared closed playlist dereferences user', path: '{root}/data/nullable/closed-playlist', type: 'Playlist', directory: true },
      { name: 'shared open playlist still dereferences user in parental child check', path: '{root}/data/nullable/open-playlist', type: 'Playlist', openAccess: true, directory: true },
      { name: 'managed modern boxset still validates parental user before links', path: '{root}/data/nullable/boxset', type: 'BoxSet', directory: true },
    ],
    channelCases: [
      ['null SQL', null, false, false], ['null JSON', 'null', false, false],
      ['folder and base JSON', '{"IsRoot":true,"Container":"first","Width":999,"Height":1080,"Size":4,"OriginalChannelName":"ignored","SourceType":"Library"}', false, true],
      ['duplicate fields retain last value', '{"IsRoot":false,"IsRoot":true,"Container":"first","Container":"last"}', false, true],
      ['malformed known field resets whole JSON', '{"IsRoot":true,"Container":"first","Height":"bad"}', false, false],
      ['malformed root resets constructor', '[]', false, false],
      ['basic skip ignores valid JSON', '{"IsRoot":true,"Container":"first"}', true, true],
      ['basic skip ignores malformed JSON', '{"IsRoot":true,"Height":"bad"}', true, false],
    ].map(([name, data, skipBasic, validData], index) => ({ name, data, skipBasic, validData, id: id(950 + index) })),
    directories: ['{root}/media', '{root}/movies'], items, requests: [
      request('all retained recordings span bounded pages'), request('page', { StartIndex: 1, Limit: 3 }),
      request('uncounted page', { StartIndex: 3, Limit: 2, EnableTotalRecordCount: false }),
      request('negative offset', { StartIndex: -7, Limit: 2 }), request('zero limit', { Limit: 0 }),
      request('negative limit', { Limit: -1 }), request('offset after result', { StartIndex: 1000 }),
      request('movies only', { IsMovie: true, Limit: 5 }), request('episodes only', { IsSeries: true, Limit: 4 }),
      request('exclude movies and episodes', { IsMovie: false, IsSeries: false }),
      request('include takes precedence over exclude', { IsMovie: true, IsSeries: false, Limit: 3 }),
      request('sports genre', { IsSports: true }), request('kids genre alternatives', { IsKids: true }),
      request('genre selectors are unioned', { IsKids: true, IsSports: true }),
      request('false progress is ignored', { IsInProgress: false, Limit: 2 }),
      request('no built-in active recordings', { IsInProgress: true, StartIndex: 2, Limit: 1 }),
      request('other bound selectors are ignored', { ChannelId: 'opaque-channel', Status: 'Error', SeriesTimerId: 'opaque-series', IsNews: true, IsLibraryItem: false, Limit: 2 }),
      request('userless result retains requested offset', { StartIndex: -4, Limit: 1 }, { userless: true }),
    ] };
}

test('existing recordings match actual native manager and EF queries through PostgreSQL and library DTO projection', {
  skip: !enabled, timeout: 240000,
}, async () => {
  const input = inputFixture(), inputBytes = Buffer.from(JSON.stringify(input));
  const output = path.join(validationOutputRoot(), 'live-tv-recordings-' + randomUUID());
  await mkdir(output);
  const inputFile = path.join(output, 'input.json'); await writeFile(inputFile, inputBytes, { flag: 'wx' });
  const report = { comparisons: [], cleanup: {}, evidenceScope: 'Existing directory roots, actual native EF selection and Node library DTO subset; generic native DTO projection and Channel providers are controlled.' };
  let database, store, library, liveTv, source, current, failure;
  const privateRoot = path.join(output, 'private-native');
  try {
    current = await currentNativeReference();
    report.preparation = current.preparation;
    report.sourceBindings = await current.sourceBindings(['src/Jellyfin.LiveTv/LiveTvManager.cs',
      'src/Jellyfin.LiveTv/Recordings/RecordingsManager.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.TranslateQuery.cs',
      'MediaBrowser.Controller/Dto/DtoOptions.cs', 'MediaBrowser.Controller/Entities/Video.cs',
      'MediaBrowser.Controller/Channels/Channel.cs', 'MediaBrowser.Controller/Entities/Folder.cs',
      'MediaBrowser.Controller/Entities/BaseItem.cs', 'MediaBrowser.Controller/Entities/UserRootFolder.cs',
      'MediaBrowser.Controller/Entities/UserView.cs', 'MediaBrowser.Controller/Entities/CollectionFolder.cs',
      'MediaBrowser.Controller/Entities/Movies/BoxSet.cs', 'MediaBrowser.Controller/Playlists/Playlist.cs',
      'src/Jellyfin.LiveTv/Channels/ChannelManager.cs', 'Emby.Server.Implementations/Dto/DtoService.cs', 'Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemMapper.cs']);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/live-tv-recordings/Oracle.csproj',
      output: path.join(output, 'native'), args: [inputFile, '{output}/native.json', privateRoot, current.sourceDatabase] });
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.ok(receipt.passed && native.actualLiveTvManager && native.actualRecordingDirectoryEnumeration && native.actualLibraryManagerAndEfRepository);
    assert.ok(native.controlledDtoProjection && native.emptyChannelProviderControl);
    assert.equal(native.recordingExecutorsStarted, false);
    assert.equal(native.inputSha256, hash(inputBytes));
    assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    for (const image of native.nativeLibraries) {
      const bytes = await readFile(image.filename);
      assert.equal(image.requiredPackagedImage, true); assert.equal(bytes.length, image.bytes); assert.equal(hash(bytes), image.sha256);
    }
    report.databasePreparation = native.databasePreparation;
    assert.equal(native.databasePreparation.sourceFilename, path.resolve(current.sourceDatabase));
    assert.equal(native.databasePreparation.sourceSha256, hash(await readFile(current.sourceDatabase)));
    assert.equal(native.databasePreparation.copiedSha256, native.databasePreparation.sourceSha256);
    assert.equal(native.databasePreparation.retainedSchemaAndMigrationHistory, true);
    assert.equal(native.databasePreparation.schemaCreated, false); assert.equal(native.databasePreparation.migrationsApplied, false);
    assert.ok(native.databasePreparation.schemaAndMigrationHistory.migrations.length > 0);
    assert.ok(native.providerCalls.some(value => value.RefreshLatestChannelItems === true));
    assert.ok(native.providerCalls.some(value => value.RefreshLatestChannelItems === false));
    database = await createPostgresTestDatabase(null, 'recording_reads'); store = new DomainStore(database);
    source = new SqliteDatabase(native.databaseFilename, { readOnly: true, requireMigrationHistory: true });
    report.pinnedSchemaPreflight = true;
    const nativeRows = Object.fromEntries(tables.map(table => [table, source.rows(table)]));
    source.close(); source = null;
    for (const table of tables) for (const row of nativeRows[table]) {
      if (table === 'BaseItems' && (await database.rows(table, { where: { Id: row.Id }, limit: 1 })).length) continue;
      await database.insert(table, row);
    }
    assert.equal(native.channelContract.requiresJson, true);
    assert.deepEqual(nativeItemJsonContract(channelType).map(field => ({ name: field.name, getterOnly: field.readOnly })),
      native.channelContract.properties.map(field => ({ name: field.name, getterOnly: field.getterOnly })));
    assert.deepEqual(channelProjection(newNativeItemEntity(channelType)), native.channelContract.constructor);
    report.channelComparisons = [];
    for (const sample of input.channelCases) {
      const expected = native.channelContract.cases.find(value => value.name === sample.name), errors = [];
      const row = { ...expected.row, Size: expected.row.Size == null ? null : BigInt(expected.row.Size) };
      const actual = mapRecord(row, { onJsonError: error => errors.push(error) });
      assert.deepEqual(channelProjection(actual), expected.value, sample.name);
      assert.equal(errors.length, expected.jsonErrors, sample.name);
      const state = await loadLibrary(database, { configuration: { SkipDeserializationForBasicTypes: sample.skipBasic } },
        { baseRows: [row], includeLinkGraph: false });
      try { assert.deepEqual(channelProjection(state.items[0]), expected.repositoryValue, sample.name + ' repository basic-type configuration'); }
      finally { await state.dispose(); }
      const safe = (await database.client.query(`SELECT ${nativeTextSql(database.schemaName).safeItemData('$1::bytea', '$2::bytea')} AS value`,
        [nativeTextBytes(channelType), sample.data == null ? null : nativeTextBytes(sample.data)])).rows[0].value;
      assert.deepEqual(safe, sample.data == null ? null : sample.validData ? JSON.parse(sample.data) : {}, sample.name + ' PostgreSQL Data gate');
      report.channelComparisons.push({ name: sample.name, jsonErrors: errors.length, actual: channelProjection(actual),
        repositoryValue: expected.repositoryValue, safeData: safe });
    }
    const baseline = Object.fromEntries(await Promise.all(tables.map(async table => [table, stable(await database.rows(table))])));
    const configurationDirectoryPath = path.join(output, 'config'); await mkdir(configurationDirectoryPath);
    liveTv = new LiveTvService({ configurationDirectoryPath }); await liveTv.saveConfiguration(native.configuration);
    const user = { Id: input.userId, Policy: { EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [],
      BlockedTags: [], AllowedTags: [], BlockUnratedItems: [], EnableContentDeletion: false, EnableContentDeletionFromFolders: [] } };
    library = new LibraryService({ store, fileSystem: testFileSystem, serverId: 'recording-components',
      dataPath: path.join(privateRoot, 'data'), userRoot: nativeRows.BaseItems.find(row => idKey(row.Id) === idKey(id(2))), configuration: {} });
    const service = new LiveTvRecordingsService({ liveTv, library, dataPath: path.join(privateRoot, 'data'),
      mediaAssets: new MetadataImageAssets({ fileSystem: testFileSystem, stateRoots: [privateRoot] }) });
    const paths = [native.configuration.RecordingPath, native.configuration.MovieRecordingPath];
    assert.equal(native.actualColdUserRootChildRepositoryHydration, true);
    const inputById = new Map(input.items.map(item => [idKey(item.id), item]));
    const load = library.load.bind(library), folderStates = { cold: [], warm: [] };
    let lane = 'cold';
    // This declared warm preparation uses the real typed load and authoritative
    // Children cache, matching the native array above. The resolver and SQL sort
    // remain the production consumers in both lanes.
    library.load = async (...args) => {
      const state = await load(...args);
      try {
        const root = state.items.find(item => item.Type === 'UserRootFolder');
        if (root) {
          const children = state.items.filter(item => idKey(item.ParentId) === idKey(root.Id));
          if (lane === 'warm') {
            for (const child of children) child.SortName = inputById.get(idKey(child.Id)).sortName;
            setFolderChildren(root, children);
          }
          folderStates[lane].push(children.map(item => ({ id: idKey(item.Id),
            storedSortName: repositoryValue(item, 'SortName'), liveSortName: item.SortName })));
        }
        return state;
      } catch (error) { await state.dispose(); throw error; }
    };
    let folders;
    try {
      folders = await library.resolveLiveTvRecordingFolders(paths, { user });
      assert.deepEqual(folders.folderIds.map(idKey), native.coldFolderIds);
      lane = 'warm';
      const warm = await library.resolveLiveTvRecordingFolders(paths, { user });
      assert.deepEqual(warm.folderIds.map(idKey), native.warmFolderIds);
      for (const name of ['cold', 'warm']) {
        const expected = native[name + 'FolderSortNames'];
        assert.ok(folderStates[name].length > 0);
        for (const observed of folderStates[name]) for (const sort of expected) {
          assert.deepEqual(observed.find(item => item.id === sort.id), sort, name + ' typed child sort state');
        }
      }
      assert.deepEqual([...new Set(folderStates.cold.flat().map(item => item.id))].sort(), [...native.coldChildIds].sort());
      assert.notDeepEqual(native.warmFolderIds, native.coldFolderIds, 'The input must distinguish explicit warm SortName from real cold hydration.');
      report.recordingFolders = { cold: { ids: folders.folderIds.map(idKey), sortStates: folderStates.cold,
        nativeSortNames: native.coldFolderSortNames, actualNativeRepositoryChildren: true },
      warm: { ids: warm.folderIds.map(idKey), sortStates: folderStates.warm, nativeSortNames: native.warmFolderSortNames,
        controlledTypedChildrenCache: true } };
      assert.deepEqual(Object.fromEntries(await Promise.all(tables.map(async table => [table, stable(await database.rows(table))]))), baseline);
    } finally { library.load = load; }
    for (const request of input.requests) {
      const query = Object.fromEntries(Object.entries(request.query).map(([key, value]) => [key.toLowerCase(), value]));
      const actual = await service.getRecordings(query, { user: request.userless ? null : user });
      const expected = native.results.find(value => value.name === request.name);
      report.comparisons.push({ name: request.name, actual: projection(actual), expected: projection(expected.value), fields: expected.fields });
      assert.deepEqual(projection(actual), projection(expected.value), request.name);
      assert.ok(expected.fields.every(field => !['CanDelete', 'CanDownload', 'DisplayPreferencesId', 'Etag'].includes(field)));
      assert.deepEqual(Object.fromEntries(await Promise.all(tables.map(async table => [table, stable(await database.rows(table))]))), baseline);
    }
    await assert.rejects(service.getFolders(), { status: native.userlessFoldersStatus, nativeException: native.userlessFoldersError });
    assert.equal(native.userlessFoldersStatus, 400); assert.equal(native.userlessFoldersError, 'ArgumentNullException');
    report.folderFailures = [];
    const sourceId = input.folderFailureTargetId, originalSource = nativeRows.BaseItems.find(row => idKey(row.Id) === idKey(sourceId));
    const originalLibraryOptions = library.options.libraryOptions;
    const sourceColumns = new Map(tableDefinition('BaseItems').columns.map(column => [column.name, column]));
    try {
      for (const expected of native.folderFailures) {
        assert.equal(expected.actualManagerAndTypedRepository, true); assert.equal(expected.actualExceptionMiddlewareStatus, true);
        await database.update('BaseItems', { Id: originalSource.Id }, Object.fromEntries(Object.entries(expected.sourceRow)
          .filter(([name]) => sourceColumns.has(name) && name !== 'Id')
          .map(([name, value]) => [name, value != null && sourceColumns.get(name).clrType.replace('?', '') === 'Guid' ? nativeGuid(value) : value])));
        library.options.libraryOptions = { ...originalLibraryOptions, [idKey(sourceId)]: { Enabled: !expected.disabled } };
        await liveTv.saveConfiguration(expected.configuration);
        const prepared = Object.fromEntries(await Promise.all(tables.map(async table => [table, stable(await database.rows(table))])));
        let actual;
        try { await service.getFolders(); assert.fail('A null recording-folder user must fail.'); }
        catch (error) { actual = { type: error.nativeException, status: error.status, Message: error.message, stack: error.stack }; }
        report.folderFailures.push({ name: expected.name, actual, native: expected.failure });
        assert.deepEqual({ type: actual.type, status: actual.status, Message: actual.Message },
          { type: expected.failure.type, status: expected.failure.status, Message: expected.failure.Message }, expected.name);
        assert.match(expected.failure.StackTrace, /LiveTvManager\.GetRecordingFoldersAsync/u);
        assert.deepEqual(Object.fromEntries(await Promise.all(tables.map(async table => [table, stable(await database.rows(table))]))), prepared);
      }
      assert.equal(report.folderFailures.length, input.folderFailureCases.length);
    } finally {
      await database.update('BaseItems', { Id: originalSource.Id }, Object.fromEntries(Object.entries(originalSource).filter(([name]) => name !== 'Id')));
      library.options.libraryOptions = originalLibraryOptions; await liveTv.saveConfiguration(native.configuration);
    }
    assert.deepEqual(Object.fromEntries(await Promise.all(tables.map(async table => [table, stable(await database.rows(table))]))), baseline);
    report.displayCases = [];
    for (const expected of native.displayCases) {
      const prepared = { Id: id(990), ChannelId: guid(expected.channelId), Name: 'Display control' };
      const item = Object.assign(newNativeItemEntity(expected.nativeType), prepared);
      assert.equal(item.Id, prepared.Id); assert.equal(item.ChannelId, prepared.ChannelId);
      assert.equal(item.SourceType, expected.sourceType);
      const observed = { name: expected.name, prepared, nativeChannelId: expected.channelId, copies: [] };
      const copies = [['original', item], ['clone', cloneNativeItemEntity(item)], ['capture/restore', await restoreNativeItemState(await captureNativeItemState(item))]];
      for (const [kind, candidate] of copies) {
        assert.equal(candidate.Id, prepared.Id, expected.name + ': ' + kind + ' must consume the prepared identity.');
        assert.equal(idKey(candidate.ChannelId), expected.channelId, expected.name + ': ' + kind + ' must consume the actual native ChannelId.');
        assert.equal(candidate.SourceType, expected.sourceType, expected.name + ': ' + kind + ' source type');
        assert.equal(Object.hasOwn({ ...candidate }, 'EnableMediaSourceDisplay'), false, 'Spreading a typed entity must not evaluate this lazy virtual getter.');
        let actual;
        try { actual = { value: candidate.EnableMediaSourceDisplay }; }
        catch (error) { actual = { failure: { type: error.nativeException, status: error.status, Message: error.message } }; }
        assert.deepEqual(actual, expected.failure ? { failure: { type: expected.failure.type, status: expected.failure.status, Message: expected.failure.Message } } : { value: expected.value }, expected.name);
        observed.copies.push({ kind, Id: candidate.Id, ChannelId: candidate.ChannelId, sourceType: candidate.SourceType, actual });
        const state = await store.run(db => library.load(db, null, { baseRows: [] }));
        try {
          state.items.push(candidate); state.byId.set(idKey(candidate.Id), candidate);
          const unselectedOptions = dtoOptions({ enableimages: false, enableuserdata: false });
          if (candidate.SourceType === 'Channel' && idKey(candidate.ChannelId) === '0'.repeat(32)) {
            // DtoService's separate final ChannelName lookup still resolves
            // ChannelId, even when the display getter is not selected.
            await assert.rejects(projectItem(candidate, state, null, unselectedOptions, library.options), { nativeException: 'ArgumentException', status: 400 });
          } else {
            const unselected = await projectItem(candidate, state, null, unselectedOptions, library.options);
            assert.equal(Object.hasOwn(unselected, 'EnableMediaSourceDisplay'), false);
          }
          const selectedOptions = dtoOptions({ fields: ['EnableMediaSourceDisplay'], enableimages: false, enableuserdata: false });
          if (expected.failure) await assert.rejects(projectItem(candidate, state, null, selectedOptions, library.options),
            { status: expected.failure.status, nativeException: expected.failure.type });
          else assert.equal((await projectItem(candidate, state, null, selectedOptions, library.options)).EnableMediaSourceDisplay, expected.value);
        } finally { await state.dispose(); }
      }
      report.displayCases.push(observed);
    }
    report.deleteCases = [];
    assert.equal(native.actualDeleteDtoService, true);
    assert.equal(native.deleteCases.length, 5);
    for (const expected of native.deleteCases) {
      const prepared = { Id: guid(expected.id), ChannelId: guid(expected.channelId), Path: expected.path };
      const candidate = Object.assign(newNativeItemEntity(expected.nativeType), prepared);
      assert.equal(candidate.Id, prepared.Id); assert.equal(idKey(candidate.ChannelId), expected.channelId);
      assert.equal(candidate.Path, expected.path);
      assert.equal(candidate.SourceType, expected.sourceType);
      assert.equal(canDeleteItem(candidate), expected.value, expected.name);
      const state = await store.run(db => library.load(db, null, { baseRows: [] }));
      try {
        state.items.push(candidate); state.byId.set(idKey(candidate.Id), candidate);
        const selected = dtoOptions({ fields: ['CanDelete'], enableimages: false, enableuserdata: false });
        assert.equal(expected.dto.length, 2);
        const dto = [];
        for (const observation of expected.dto) {
          const observed = observation.result;
          if (expected.name === 'channel overrides provider deletion') {
            assert.equal(observed.failure?.type, 'ArgumentException'); assert.equal(observed.failure.status, 400);
            assert.equal(observed.failure.Message, "Guid can't be empty (Parameter 'id')");
            assert.ok(observed.failure.StackTrace.includes('AttachBasicFields'));
          } else {
            assert.equal(observed.failure, undefined, expected.name + ': every actual native readonly DTO dependency must be supplied');
            assert.equal(observed.value.CanDelete, expected.value);
          }
          let actual;
          try { actual = { value: { CanDelete: (await projectItem(candidate, state, observation.userless ? null : user, selected, library.options)).CanDelete } }; }
          catch (error) { actual = { failure: { type: error.nativeException ?? error.name, status: error.status ?? 500, Message: error.message, StackTrace: error.stack } }; }
          const comparable = result => result.failure ? { failure: { type: result.failure.type, status: result.failure.status, Message: result.failure.Message } } : result;
          assert.deepEqual(comparable(actual), comparable(observed), expected.name + ': userless=' + observation.userless + ' actual DTO result/error');
          dto.push({ userless: observation.userless, actual, native: observed });
        }
        report.deleteCases.push({ ...expected, actualInput: prepared, actualSourceType: candidate.SourceType, actualValue: canDeleteItem(candidate), dto });
      } finally { await state.dispose(); }
    }
    await store.run(async db => {
      const owner = await createPostgresRecordingQuery(db, {}, { folderIds: folders.folderIds, userId: user.Id });
      try {
        const first = await owner.page(); assert.equal(first.rows.length, 128);
        const target = nativeRows.BaseItems.find(row => idKey(row.Id) === idKey(id(10)));
        await db.update('BaseItems', { Id: target.Id }, { Name: 'Changed after capture' });
        const second = await owner.page({ offset: 128 });
        assert.ok(second.rows.length > 0 && second.rows.length < 128);
        assert.equal([...first.rows, ...second.rows].find(row => idKey(row.Id) === idKey(target.Id)).Name, target.Name);
        await db.update('BaseItems', { Id: target.Id }, { Name: target.Name });
        await assert.rejects(owner.page({ limit: 129 }), TypeError);
        report.capturedCohort = { firstRows: first.rows.length, secondRows: second.rows.length, total: owner.total, retainedCapturedName: true };
      } finally { await owner.close(); }
      const remaining = await db.client.query("SELECT count(*)::integer AS n FROM pg_catalog.pg_class WHERE relnamespace = pg_catalog.pg_my_temp_schema() AND relname LIKE 'mm_recordings_%'");
      assert.equal(remaining.rows[0].n, 0);
    });
  } catch (error) { failure = error; }
  finally {
    const errors = [];
    for (const [name, action] of [['sourceClosed', () => source?.close()], ['liveTvClosed', () => liveTv?.close()],
      ['libraryClosed', () => library?.close()], ['storeClosed', () => store?.close()], ['postgresRemoved', () => dropPostgresTestDatabase(database)],
      ['protectedInputsUnchanged', () => current?.finish()],
      ['privateNativeRemoved', async () => {
        assert.equal(path.dirname(privateRoot), output); assert.equal(path.basename(privateRoot), 'private-native');
        await rm(privateRoot, { recursive: true, force: true });
      }]]) {
      try { await action(); report.cleanup[name] = true; } catch (error) { errors.push(error); report.cleanup[name] = false; }
    }
    await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ ...report, passed: !failure && !errors.length,
      phaseAcceptance: false, releaseAcceptance: false, error: failure?.stack, cleanupErrors: errors.map(error => error.message) }, null, 2) + '\n');
    if (!failure && errors.length) failure = new AggregateError(errors, 'Recording component cleanup failed.');
  }
  if (failure) throw failure;
});
