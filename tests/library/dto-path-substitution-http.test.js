import test from 'node:test';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tableDefinition } from '../../src/database/model.js';
import { dateText, idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate, validateFixture } from './item-filter-http-scenario.js';
import { currentUserViewScenario, userViewEvidenceJson as json } from '../helpers/current-user-view-scenario.js';
import { projectSingleSourceName } from '../helpers/single-source-name-projection.js';
import { projectItemBody } from '../helpers/http-body-projection.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE) });

const bytes = await readFile(new URL('./fixtures/dto-path-substitution-http/input.json', import.meta.url));
const fixture = JSON.parse(bytes);
validateFixture(fixture);
const normalize = (value, serverId, status) => projectItemBody(value, { serverId, status,
  date: (entry, { field }) => ['DateCreated', 'DateLastSaved', 'DateLastMediaAdded'].includes(field) ? dateText(entry) : entry });

test('file DTO and media source substitutions match current native HTTP without changing storage identities', {
  skip: !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE || !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 300000,
}, nativeCallback(async t => {
  const { http, stages, root, nativeServerId } = await currentUserViewScenario('dto-path-substitution-http', bytes, { signal: t.signal });
  assert.equal(http.records.length, 48);
  const body = name => http.records.find(record => record.name === name)?.response.bodyJson;
  assert.equal(body('mapped movie').Path, '/client/media\\Film.mkv');
  assert.equal(body('mapped movie').MediaSources[0].Path, '/client/media\\Film.mkv');
  assert.equal(body('mapped remote').Path, 'https://media.invalid/video.mkv');
  assert.equal(body('remote protocol ignored').Path, 'https://media.invalid/video.mkv');
  assert.equal(body('mapped videoShortcut').MediaSources[0].Path, 'https://media.invalid/video.mkv');
  assert.equal(body('mapped audioShortcut').MediaSources[0].Path, '/client/media\\audio.strm');
  assert.equal(body('mapped empty').MediaSources[0].Type, 'Placeholder');
  const internalSources = [];
  const actual = await recordItemFilterCandidate({ dialect: 'postgres', fixture,
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, scenarioName: 'dto-path-substitution-http',
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
    },
    prepareCase: async ({ testCase, runtime }) => {
      Object.assign(runtime.configuration, testCase.serverConfiguration);
    },
    afterEndpoint: async ({ testCase, endpoint, runtime }) => {
      const item = fixture.items.find(item => item.key === testCase.detailKey);
      const sources = await runtime.library.getMediaSources(item.id);
      for (const source of sources) assert.equal(source.Path ?? null, item.key === 'videoShortcut' ? item.data.ShortcutPath : item.path, testCase.name);
      internalSources.push({ name: testCase.name, endpoint, sources });
    },
  });
  await writeFile(path.join(root, 'postgres.json'), json(actual), { flag: 'wx' });
  const differences = [], sourceNames = [];
  for (const item of actual.cases) for (const endpoint of item.endpoints) {
    const reference = http.records.find(record => record.name === item.name && record.endpoint === endpoint.endpoint);
    try {
      assert.equal(endpoint.response.status, reference.response.status);
      assert.equal(endpoint.response.contentType, reference.response.contentType);
      assert.deepEqual(normalize(projectSingleSourceName(endpoint.response.body, fixture.items, false, sourceNames, item.name), actual.serverId, endpoint.response.status),
        normalize(projectSingleSourceName(reference.response.bodyJson, fixture.items, true, sourceNames, item.name), nativeServerId, reference.response.status));
    } catch (error) { differences.push({ name: item.name, endpoint: endpoint.endpoint, message: error.message }); }
  }
  await writeFile(path.join(root, 'postgres-comparison.json'), json({ passed: differences.length === 0, phaseAcceptance: false,
    responses: http.records.length, internalSources, sourceNames,
    boundary: 'Complete DTO responses and media sources. Single-file display names are bound to the persistent identity under each runtime path convention before projection; multi-source labels are not projected. No media delivery or PlaybackInfo negotiation is claimed.', differences }), { flag: 'wx' });
  assert.deepEqual(actual.beforeReads, actual.afterReads);
  assert.deepEqual(actual.beforeReads, actual.afterShutdown);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterReads);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterShutdown);
  assert.deepEqual(actual.filesystemBeforeReads, actual.filesystemAfterReads);
  assert.deepEqual(actual.filesystemBeforeReads, actual.filesystemAfterShutdown);
  assert.ok(Object.values(actual.cleanup).every(Boolean));
  assert.deepEqual(differences, []);
}));
