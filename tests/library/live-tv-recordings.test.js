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
import { idKey } from '../../src/library/records.js';
import { testFileSystem } from '../storage/plugin-files.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres', 'nativeInstance'];
const enabled = process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = index => `a9300000-0000-0000-0000-${String(index).padStart(12, '0')}`;
const tables = ['BaseItems', 'AncestorIds', 'ItemValues', 'ItemValuesMap'];
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
  return { userId: id(900), configuration: { RecordingPath: '{root}/media', MovieRecordingPath: '{root}/movies', SeriesRecordingPath: '{root}/movies' },
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
  let database, store, library, liveTv, source, failure;
  const privateRoot = path.join(output, 'private-native');
  try {
    const current = await currentNativeReference();
    report.sourceBindings = await current.sourceBindings(['src/Jellyfin.LiveTv/LiveTvManager.cs',
      'src/Jellyfin.LiveTv/Recordings/RecordingsManager.cs', 'Emby.Server.Implementations/Library/LibraryManager.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemRepository.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.Querying.cs',
      'Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs', 'Jellyfin.Server.Implementations/Item/BaseItemRepository.TranslateQuery.cs',
      'MediaBrowser.Controller/Dto/DtoOptions.cs', 'MediaBrowser.Controller/Entities/Video.cs']);
    const receipt = await recordOracle({ project: 'tests/library/fixtures/live-tv-recordings/Oracle.csproj',
      output: path.join(output, 'native'), args: [inputFile, '{output}/native.json', privateRoot] });
    const nativeBytes = await readFile(path.join(output, 'native/native.json')), native = JSON.parse(nativeBytes);
    assert.ok(receipt.passed && native.actualLiveTvManager && native.actualRecordingDirectoryEnumeration && native.actualLibraryManagerAndEfRepository);
    assert.ok(native.controlledDtoProjection && native.emptyChannelProviderControl);
    assert.equal(native.recordingExecutorsStarted, false);
    assert.equal(native.inputSha256, hash(inputBytes));
    assert.equal(receipt.outputs.find(value => path.basename(value.filename) === 'native.json').sha256, hash(nativeBytes));
    for (const assembly of native.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256);
    assert.ok(native.providerCalls.some(value => value.RefreshLatestChannelItems === true));
    assert.ok(native.providerCalls.some(value => value.RefreshLatestChannelItems === false));
    database = await createPostgresTestDatabase(null, 'recording_reads'); store = new DomainStore(database);
    source = new SqliteDatabase(native.databaseFilename, { readOnly: true });
    const nativeRows = Object.fromEntries(tables.map(table => [table, source.rows(table)]));
    source.close(); source = null;
    for (const table of tables) for (const row of nativeRows[table]) {
      if (table === 'BaseItems' && (await database.rows(table, { where: { Id: row.Id }, limit: 1 })).length) continue;
      await database.insert(table, row);
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
    const folders = await library.resolveLiveTvRecordingFolders([native.configuration.RecordingPath, native.configuration.MovieRecordingPath], { user });
    assert.deepEqual(folders.folderIds.map(idKey), native.folderIds);
    for (const request of input.requests) {
      const query = Object.fromEntries(Object.entries(request.query).map(([key, value]) => [key.toLowerCase(), value]));
      const actual = await service.getRecordings(query, { user: request.userless ? null : user });
      const expected = native.results.find(value => value.name === request.name);
      report.comparisons.push({ name: request.name, actual: projection(actual), expected: projection(expected.value), fields: expected.fields });
      assert.deepEqual(projection(actual), projection(expected.value), request.name);
      assert.ok(expected.fields.every(field => !['CanDelete', 'CanDownload', 'DisplayPreferencesId', 'Etag'].includes(field)));
      assert.deepEqual(Object.fromEntries(await Promise.all(tables.map(async table => [table, stable(await database.rows(table))]))), baseline);
    }
    await assert.rejects(service.getFolders(), { status: 500 });
    assert.ok(native.userlessFoldersError);
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
