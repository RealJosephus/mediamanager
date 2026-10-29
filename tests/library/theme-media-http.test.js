import test from 'node:test';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { dateText, idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate, validateFixture } from './item-filter-http-scenario.js';
import { currentUserViewScenario, candidateCasesFromTrackedInput, userViewEvidenceJson as json } from '../helpers/current-user-view-scenario.js';
import { projectItemBody } from '../helpers/http-body-projection.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE) });

const fixtureBytes = await readFile(new URL('./fixtures/theme-media-http/input.json', import.meta.url), 'utf8');
const fixture = JSON.parse(fixtureBytes);
validateFixture(fixture);
const normalize = (value, serverId, status) => {
  const project = body => projectItemBody(body, { serverId, status,
    date: (entry, { field }) => ['DateCreated', 'DateLastSaved', 'DateLastMediaAdded'].includes(field) ? dateText(entry) : entry });
  if (value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'ThemeSongsResult') && Object.hasOwn(value, 'ThemeVideosResult')) {
    return { ...value, ThemeSongsResult: project(value.ThemeSongsResult), ThemeVideosResult: project(value.ThemeVideosResult) };
  }
  return project(value);
};

test('theme media APIs match 138 current native full responses with inherited owners, versions and images', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE, timeout: 300000,
}, nativeCallback(async t => {
  const { http, stages, summary, root, nativeServerId } = await currentUserViewScenario('theme-media-http', fixtureBytes, { signal: t.signal });
  const body = name => http.records.find(record => record.name === name)?.response.bodyJson;
  const main = body('direct main ThemeMedia');
  assert.ok(main.ThemeSongsResult.Items.length >= 5);
  assert.ok(main.ThemeVideosResult.Items.length >= 3);
  assert.ok(main.ThemeSongsResult.Items.some(item => item.ParentLogoItemId || item.ImageTags?.Logo));
  const deep = body('inherit deep ThemeMedia');
  assert.notEqual(deep.ThemeSongsResult.OwnerId, deep.ThemeVideosResult.OwnerId);
  assert.equal(deep.ThemeSongsResult.OwnerId, idKey(fixture.items.find(item => item.key === 'mid').id));
  assert.equal(deep.ThemeVideosResult.OwnerId, idKey(fixture.items.find(item => item.key === 'ownerFolder').id));
  for (const key of ['nestedGroup-song-0', 'ignoredAudioGroup-song-0']) {
    assert.ok(!main.ThemeSongsResult.Items.some(item => item.Id === idKey(fixture.items.find(item => item.key === key).id)), key);
  }
  const blocked = body('blocked extra tags ThemeSongs');
  const id = key => idKey(fixture.items.find(item => item.key === key).id);
  assert.ok(blocked.Items.some(item => item.Id === id('grouped-song-0')), 'Repository visibility must honor the stored nonmatching CleanValue.');
  assert.ok(!blocked.Items.some(item => item.Id === id('main-song-1')), 'A matching type-4 CleanValue must be excluded by repository visibility.');
  assert.ok(blocked.Items.some(item => item.Id === id('local-song-0')), 'The cached type-6 value does not replace the type-4 repository tag relation.');
  const cases = candidateCasesFromTrackedInput(fixture);
  const actual = await recordItemFilterCandidate({ dialect: 'postgres', fixture: { ...fixture, cases },
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, scenarioName: 'theme-media-http',
    captureResponseBodies: true, captureErrorText: true, captureCaseRuntimeErrors: true,
    trackUserData: true, trackFilesystem: true, captureShutdownState: true,
    configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
    prepareScenario: async ({ database, programDataPath, user, storage }) => {
      const nativeRows = new Map(stages.before.database.baseItems.map(row => [idKey(row.Id), row]));
      const nativePath = key => nativeRows.get(idKey(fixture.items.find(item => item.key === key).id)).Path;
      const libraryRoot = path.dirname(nativePath('physicalA'));
      const metadataRoot = path.dirname(path.dirname(stages.before.database.baseItemImageInfos[0].Path));
      const mappings = [
        [libraryRoot, path.join(programDataPath, 'library-content')],
        [metadataRoot, path.join(programDataPath, 'metadata')],
        [nativePath('aggregate'), path.join(programDataPath, 'root')],
        [nativePath('userRoot'), path.join(programDataPath, 'root/default')],
      ];
      // Keep setup observers on the Node namespace while installing all
      // foreign identity mappings; the frozen complete rows are imported next.
      for (const item of fixture.items.filter(item => item.type === 'CollectionFolder')) {
        const directory = path.join(programDataPath, 'root/default', item.name);
        await mkdir(directory, { recursive: true });
        await database.update('BaseItems', { Id: item.id.toUpperCase() }, { Path: directory });
      }
      const definition = storage.configuration();
      for (const [index, [, localPath]] of mappings.entries()) {
        await mkdir(localPath, { recursive: true });
        definition.instances.push({ id: 'theme-copy-' + index, type: 'local', config: { root: localPath, createRoot: true, writable: true } });
      }
      await storage.configure(definition);
      const capabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true };
      for (const [index, [identityRoot]] of mappings.entries()) for (const purpose of ['library', 'metadata']) {
        await storage.bindPath({ identityRoot, instanceId: 'theme-copy-' + index, purpose,
          style: process.platform === 'win32' ? 'windows' : 'posix', caseSensitive: process.platform !== 'win32',
          returnAccess: 'Controlled native identities resolve inside the isolated Node copy.', capabilities });
      }
      for (const item of fixture.items) {
        const row = nativeRows.get(idKey(item.id));
        assert.ok(row, item.key);
        const values = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => column.name !== 'Id')
          .map(column => [column.name, column.clrType.replace('?', '') === 'long' && row[column.name] != null ? BigInt(row[column.name]) : row[column.name]]));
        await database.update('BaseItems', { Id: item.id.toUpperCase() }, values);
        const mapping = mappings.filter(([prefix]) => row.Path === prefix || row.Path?.startsWith(prefix + path.sep))
          .sort((a, b) => b[0].length - a[0].length)[0];
        if (mapping && item.type === 'CollectionFolder') {
          const localPath = path.join(mapping[1], path.relative(mapping[0], row.Path));
          await mkdir(localPath, { recursive: true });
          if (item.data.CollectionType) await writeFile(path.join(localPath, item.data.CollectionType + '.collection'), '', { flag: 'wx' });
        }
        if (item.pathKind?.startsWith('physical')) await mkdir(path.join(mappings[0][1], path.relative(libraryRoot, row.Path)), { recursive: true });
      }
      for (const image of fixture.images) {
        const row = stages.before.database.baseItemImageInfos.find(row => idKey(row.Id) === idKey(image.id));
        assert.ok(row, image.id);
        await database.update('BaseItemImageInfos', { Id: image.id.toUpperCase() }, { Path: row.Path,
          DateModified: row.DateModified, Width: image.width, Height: image.height, Blurhash: Buffer.from(image.blurHash) });
      }
      await storage.configure(storage.configuration());
      for (const data of fixture.userData) {
        const item = fixture.items.find(item => item.key === data.itemKey);
        await database.insert('UserData', { ItemId: item.id.toUpperCase(), UserId: user.Id, CustomDataKey: item.id,
          AudioStreamIndex: null, SubtitleStreamIndex: null, IsFavorite: data.isFavorite, LastPlayedDate: data.lastPlayedDate,
          Likes: data.likes, PlayCount: data.played ? 1 : 0, PlaybackPositionTicks: BigInt(data.positionTicks), Played: data.played,
          Rating: null, RetentionDate: null });
      }
    },
  });
  const differences = [];
  assert.equal(actual.httpCases, http.records.length);
  for (const item of actual.cases) for (const endpoint of item.endpoints) {
    const native = http.records.find(record => record.name === item.name && record.endpoint === endpoint.endpoint);
    try {
      assert.equal(endpoint.response.status, native.response.status);
      assert.equal(endpoint.response.contentType, native.response.contentType);
      if (native.response.status < 400 || native.response.bodyJson !== undefined) assert.deepEqual(normalize(endpoint.response.body, actual.serverId, endpoint.response.status), normalize(native.response.bodyJson, nativeServerId, native.response.status));
      else assert.equal(endpoint.response.bodyText, native.response.bodyText);
    } catch (error) { differences.push({ name: item.name, endpoint: endpoint.endpoint, message: error.message }); }
  }
  await writeFile(path.join(root, 'postgres.json'), json(actual), { flag: 'wx' });
  await writeFile(path.join(root, 'postgres-comparison.json'), json({ passed: differences.length === 0, phaseAcceptance: false,
    responses: http.records.length, comparedFields: 'Complete theme envelopes, all DTO fields/images/owners, user data, stable order and exact errors.',
    normalization: 'Declared DTO ServerId is bound to each actual isolated server; root ProblemDetails traceId retains presence and type, and declared dates retain equivalent full UTC 100ns values. Native item/image identity paths, opaque dictionaries and unknown fields remain literal.',
    differences }), { flag: 'wx' });
  assert.deepEqual(actual.beforeReads, actual.afterReads);
  assert.deepEqual(actual.beforeReads, actual.afterShutdown);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterReads);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterShutdown);
  assert.deepEqual(actual.filesystemBeforeReads, actual.filesystemAfterReads);
  assert.deepEqual(actual.filesystemBeforeReads, actual.filesystemAfterShutdown);
  assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true, portReleased: true,
    postgresSchemasRemoved: true, programDataDirectoryRemoved: true });
  assert.deepEqual(differences, []);
}));
