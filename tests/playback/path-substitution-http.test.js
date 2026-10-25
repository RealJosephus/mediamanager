import test from 'node:test';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { dateText, idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate, validateFixture } from '../library/item-filter-http-scenario.js';
import { currentUserViewScenario, userViewEvidenceJson as json } from '../helpers/current-user-view-scenario.js';
import { projectSingleSourceName } from '../helpers/single-source-name-projection.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE) });

const bytes = await readFile(new URL('./fixtures/path-substitution-http/input.json', import.meta.url));
const fixture = JSON.parse(bytes);
validateFixture(fixture);
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'PlaySessionId' ? '$play-session' : key === 'ServerId' ? '$server'
    : ['DateCreated', 'DateLastSaved', 'DateLastMediaAdded'].includes(key) && typeof entry === 'string'
      ? dateText(entry) : normalize(entry)])) : value;

test('PlaybackInfo publishes native client paths while retaining internal storage identities', {
  skip: !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE || !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 300000,
}, nativeCallback(async t => {
  const { http, stages, root } = await currentUserViewScenario('playback-path-substitution-http', bytes, { signal: t.signal });
  assert.equal(http.records.length, 12);
  const body = name => http.records.find(record => record.name === name)?.response.bodyJson;
  assert.equal(body('mapped movie').MediaSources[0].Path, '/client/media\\Film.mkv');
  assert.equal(body('mapped audio').MediaSources[0].Path, '/client/media\\music.flac');
  assert.equal(body('mapped remote').MediaSources[0].Path, 'https://media.invalid/video.mkv');
  assert.equal(body('remote protocol ignored').MediaSources[0].Path, 'https://media.invalid/video.mkv');
  assert.deepEqual(body('mapped empty'), { MediaSources: [], ErrorCode: 'NoCompatibleStream' });
  assert.equal(body('unbound playback selectors ignored').MediaSources[0].Path, '/client/media\\Film.mkv');
  const sessionIds = new Set();
  const validateSession = (body, ids) => {
    if (body.MediaSources.length === 0) { assert.equal(body.PlaySessionId, undefined); return; }
    assert.match(body.PlaySessionId, /^[a-f0-9]{32}$/u);
    assert.ok(!ids.has(body.PlaySessionId)); ids.add(body.PlaySessionId);
  };
  for (const record of http.records) validateSession(record.response.bodyJson, sessionIds);
  const internalSources = [];
  const actual = await recordItemFilterCandidate({ dialect: 'postgres', fixture,
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, scenarioName: 'playback-path-substitution-http',
    captureResponseBodies: true, captureErrorText: true, captureCaseRuntimeErrors: true,
    trackUserData: true, trackFilesystem: true, captureShutdownState: true,
    configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false, PathSubstitutions: [] },
    prepareScenario: async ({ database, programDataPath }) => {
      const locations = { aggregate: path.join(programDataPath, 'root'), userRoot: path.join(programDataPath, 'root/default') };
      for (const letter of ['A', 'B', 'T', 'K', 'M']) {
        locations['physical' + letter] = path.join(programDataPath, 'library-content', letter);
        locations['library' + letter] = path.join(programDataPath, 'root/default', 'Library ' + letter);
      }
      for (const item of fixture.items) {
        const row = stages.before.database.baseItems.find(row => idKey(row.Id) === idKey(item.id));
        assert.ok(row, item.key);
        const values = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => column.name !== 'Id').map(column =>
          [column.name, column.clrType.replace('?', '') === 'long' && row[column.name] != null ? BigInt(row[column.name]) : row[column.name]]));
        if (item.pathKind) {
          const data = JSON.parse(row.Data ?? '{}');
          if (item.type === 'CollectionFolder') data.PhysicalLocationsList = data.PhysicalFolderIds.map(id =>
            locations[fixture.items.find(item => idKey(item.id) === idKey(id)).pathKind]);
          await mkdir(locations[item.pathKind], { recursive: true });
          if (item.type === 'CollectionFolder' && item.data.CollectionType) await writeFile(path.join(locations[item.pathKind], item.data.CollectionType + '.collection'), '');
          Object.assign(values, { Path: locations[item.pathKind], Data: JSON.stringify(data) });
        }
        await database.update('BaseItems', { Id: item.id.toUpperCase() }, values);
      }
      for (const row of stages.before.database.mediaStreamInfos) {
        const values = Object.fromEntries(tableDefinition('MediaStreamInfos').columns.filter(column => !['ItemId', 'StreamIndex'].includes(column.name))
          .map(column => [column.name, column.clrType.replace('?', '') === 'long' && row[column.name] != null ? BigInt(row[column.name]) : row[column.name]]));
        await database.update('MediaStreamInfos', { ItemId: row.ItemId, StreamIndex: row.StreamIndex }, values);
      }
    },
    prepareCase: async ({ testCase, runtime }) => {
      Object.assign(runtime.configuration, testCase.serverConfiguration);
    },
    afterEndpoint: async ({ testCase, endpoint, runtime }) => {
      const item = fixture.items.find(item => item.key === testCase.detailKey);
      const sources = await runtime.library.getMediaSources(item.id);
      for (const source of sources) assert.equal(source.Path ?? null, item.path, testCase.name);
      internalSources.push({ name: testCase.name, endpoint, sources });
    },
  });
  await writeFile(path.join(root, 'postgres.json'), json(actual), { flag: 'wx' });
  const differences = [], nodeSessions = new Set(), sourceNames = [];
  for (const item of actual.cases) for (const endpoint of item.endpoints) {
    const reference = http.records.find(record => record.name === item.name && record.endpoint === endpoint.endpoint);
    try {
      assert.equal(endpoint.response.status, reference.response.status);
      assert.equal(endpoint.response.contentType, reference.response.contentType);
      validateSession(endpoint.response.body, nodeSessions);
      assert.deepEqual(normalize(projectSingleSourceName(endpoint.response.body, fixture.items, false, sourceNames, item.name)),
        normalize(projectSingleSourceName(reference.response.bodyJson, fixture.items, true, sourceNames, item.name)));
      assert.deepEqual(endpoint.runtimeErrors, []);
    } catch (error) { differences.push({ name: item.name, endpoint: endpoint.endpoint, message: error.message }); }
  }
  await writeFile(path.join(root, 'postgres-comparison.json'), json({ passed: differences.length === 0, phaseAcceptance: false,
    responses: http.records.length, internalSources, sourceNames,
    boundary: 'Complete default GET PlaybackInfo responses and internal sources. Each session identity is validated and unique; single-file display names are independently bound to the persistent identity before projection. No device profile, remux or media delivery is claimed.', differences }), { flag: 'wx' });
  assert.deepEqual(actual.beforeReads, actual.afterReads);
  assert.deepEqual(actual.beforeReads, actual.afterShutdown);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterReads);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterShutdown);
  assert.deepEqual(actual.filesystemBeforeReads, actual.filesystemAfterReads);
  assert.deepEqual(actual.filesystemBeforeReads, actual.filesystemAfterShutdown);
  assert.deepEqual(actual.runtimeErrors, []);
  assert.ok(Object.values(actual.cleanup).every(Boolean));
  assert.deepEqual(differences, []);
}));
