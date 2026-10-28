import test from 'node:test';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dateText, idKey } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { tableDefinition } from '../../src/database/model.js';
import { nativeRootUserViewIdentity } from '../../src/library/identity.js';
import { recordItemFilterCandidate, validateFixture } from './item-filter-http-scenario.js';
import { bindFixtureInput } from '../helpers/fixture-input-binding.js';
import { currentUserViewScenario, userViewEvidenceJson as json } from '../helpers/current-user-view-scenario.js';
import { projectItemBody } from '../helpers/http-body-projection.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE) });

const bytes = await readFile(new URL('./fixtures/live-tv-recording-links-http/input.json', import.meta.url));
const fixture = JSON.parse(bytes);
validateFixture(fixture);

const normalize = (value, serverId, status) => projectItemBody(value, { serverId, status,
  date: (entry, { field }) => ['DateCreated', 'DateLastSaved', 'StartDate', 'EndDate'].includes(field) ? dateText(entry) : entry });

test('saved recording links match full native guide HTTP and unchanged PostgreSQL state', {
  skip: !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE || !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 300000,
}, nativeCallback(async t => {
  const { http, stages, root, nativeServerId } = await currentUserViewScenario('live-tv-recording-links-http', bytes, { signal: t.signal });
  assert.equal(http.records.length, 16);
  const body = name => http.records.find(record => record.name === name)?.response.bodyJson;
  const byName = new Map(body('ordinary programs').Items.map(item => [item.Name, item]));
  assert.equal(body('ordinary programs').TotalRecordCount, 11);
  assert.match(byName.get('Neutral opening').TimerId, /^[a-f0-9]{32}$/u);
  assert.equal(byName.get('Neutral opening').Status, 'New');
  assert.equal(Object.hasOwn(byName.get('Repeat series'), 'TimerId'), false);
  assert.match(byName.get('Repeat series').SeriesTimerId, /^[a-f0-9]{32}$/u);
  assert.equal(Object.hasOwn(byName.get('Guide movie'), 'TimerId'), false);
  assert.equal(byName.get('Guide movie').SeriesTimerId, byName.get('Next day favorite').SeriesTimerId);
  assert.equal(byName.get('Future show').Status, '7');
  assert.notEqual(byName.get('No end time').TimerId, byName.get('Orphan channel').TimerId);
  assert.deepEqual(body('empty').Items, []);
  const preparation = JSON.parse(await readFile(path.join(root, 'reference-preparation.json'), 'utf8'));
  const live = preparation.liveTvViewDiscovery;
  assert.ok(live);
  assert.match(idKey(live.actualId), /^[a-f0-9]{32}$/u);
  const view = stages.before.database.baseItems.find(item => idKey(item.Id) === idKey(live.actualId));
  assert.equal(JSON.parse(view.Data).ViewType, 'livetv');
  const programs = stages.before.database.baseItems.filter(item => item.Type === 'MediaBrowser.Controller.LiveTv.LiveTvProgram');
  assert.equal(programs.length, 12);
  assert.equal(programs.filter(item => idKey(item.TopParentId) === idKey(live.actualId)).length, 11);
  assert.deepEqual(stages.before, stages.afterReads);
  assert.deepEqual(stages.before, stages.afterShutdown);

  // The native manager creates this global view during preparation. Bind its
  // observed identity as an input; synthetic program and channel ids stay literal.
  assert.equal(preparation.liveTvDocuments.length, 2);
  let nativeState;
  const rebound = bindFixtureInput(fixture, { user: { fixtureId: fixture.userId, actualId: fixture.userId },
    items: [{ fixtureId: live.fixtureId, actualId: live.actualId.toLowerCase() }] });
  const actual = await recordItemFilterCandidate({ dialect: 'postgres', fixture: rebound,
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, scenarioName: 'live-tv-recording-links-http',
    captureResponseBodies: true, captureErrorText: true, captureCaseRuntimeErrors: true,
    trackUserData: true, trackFilesystem: true, captureShutdownState: true, captureFilesystemDomains: true,
    extraFilesystemDomains: { liveTvState: 'data/livetv' }, captureStateKeys: ['liveTvNativeState'],
    prepareInstance: async ({ programDataPath }) => {
      const directory = path.join(programDataPath, 'data/livetv');
      await mkdir(directory, { recursive: true });
      for (const document of preparation.liveTvDocuments) await writeFile(path.join(directory, document.filename), document.text);
    },
    configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false,
      DisableLiveTvChannelUserDataName: true },
    prepareScenario: async ({ database, programDataPath, user, users }) => {
      const control = await users.createUser({ Name: 'GuideAdminControl', Password: 'control password' });
      await users.updatePolicy(control.Id, { ...(await users.getUser(control.Id)).Policy, IsAdministrator: true });
      assert.equal(idKey(nativeRootUserViewIdentity('livetv', { programDataPath }).Id), idKey(live.actualId));
      const locations = { aggregate: path.join(programDataPath, 'root'), userRoot: path.join(programDataPath, 'root/default'),
        liveTvRoot: path.join(programDataPath, 'metadata/views/livetv') };
      for (const letter of ['A', 'B', 'T', 'K', 'M']) {
        locations['physical' + letter] = path.join(programDataPath, 'library-content', letter);
        locations['library' + letter] = path.join(programDataPath, 'root/default', 'Library ' + letter);
      }
      for (const item of rebound.items) {
        const row = stages.before.database.baseItems.find(row => idKey(row.Id) === idKey(item.id));
        assert.ok(row, item.key);
        const values = Object.fromEntries(tableDefinition('BaseItems').columns.filter(column => column.name !== 'Id').map(column =>
          [column.name, column.clrType.replace('?', '') === 'long' && row[column.name] != null ? BigInt(row[column.name]) : row[column.name]]));
        if (item.pathKind === 'noPath') values.Path = null;
        else if (item.pathKind) {
          const directory = item.pathKind === 'named' ? path.join(programDataPath, 'metadata', item.type, item.name) : locations[item.pathKind];
          assert.ok(directory, item.pathKind);
          const data = JSON.parse(row.Data ?? '{}');
          if (item.type === 'CollectionFolder') data.PhysicalLocationsList = data.PhysicalFolderIds.map(id =>
            locations[rebound.items.find(item => idKey(item.id) === idKey(id)).pathKind]);
          await mkdir(directory, { recursive: true });
          if (item.type === 'CollectionFolder' && item.data.CollectionType) await writeFile(path.join(directory, item.data.CollectionType + '.collection'), '');
          Object.assign(values, { Path: directory, Data: JSON.stringify(data) });
        }
        await database.update('BaseItems', { Id: item.id.toUpperCase() }, values);
      }
      for (const row of stages.before.database.userData) {
        const entry = { ...row, UserId: nativeGuid(user.Id) };
        for (const column of tableDefinition('UserData').columns) {
          if (column.clrType.replace('?', '') === 'long' && entry[column.name] != null) entry[column.name] = BigInt(entry[column.name]);
        }
        await database.insert('UserData', entry);
      }
    },
    prepareCase: async ({ testCase, runtime, database }) => {
      Object.assign(runtime.configuration, testCase.serverConfiguration);
      nativeState ??= await database.getState('liveTvNativeState');
      assert.equal(await database.getState('liveTvNativeState'), nativeState);
    },
    afterEndpoint: async ({ testCase, endpoint, responses }) => {
      await appendFile(path.join(root, 'postgres-http-progress.ndjson'), JSON.stringify({ name: testCase.name, endpoint, responses }) + '\n');
    },
  });
  await writeFile(path.join(root, 'postgres.json'), json(actual), { flag: 'wx' });
  const differences = [];
  for (const item of actual.cases) for (const endpoint of item.endpoints) {
    const reference = http.records.find(record => record.name === item.name && record.endpoint === endpoint.endpoint);
    try {
      assert.equal(endpoint.response.status, reference.response.status);
      assert.equal(endpoint.response.contentType, reference.response.contentType);
      assert.deepEqual(normalize(endpoint.response.body ?? endpoint.response.bodyText, actual.serverId, endpoint.response.status),
        normalize(reference.response.bodyJson ?? reference.response.bodyText, nativeServerId, reference.response.status));
    } catch (error) { differences.push({ name: item.name, message: error.message }); }
  }
  await writeFile(path.join(root, 'postgres-comparison.json'), json({ passed: differences.length === 0, phaseAcceptance: false,
    responses: http.records.length, differences,
    boundary: 'Complete recommendation HTTP with saved timer/series links and unchanged file/PG read/shutdown state. Controlled future reference timers; no recording execution, timer CRUD or complete Live TV acceptance.' }), { flag: 'wx' });
  assert.deepEqual(actual.beforeReads, actual.afterReads);
  assert.deepEqual(actual.beforeReads, actual.afterShutdown);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterReads);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterShutdown);
  assert.deepEqual(actual.filesystemBeforeReads, actual.filesystemAfterReads);
  assert.deepEqual(actual.filesystemBeforeReads, actual.filesystemAfterShutdown);
  assert.deepEqual(actual.filesystemDomainsBeforeReads, actual.filesystemDomainsAfterReads);
  assert.deepEqual(actual.filesystemDomainsBeforeReads, actual.filesystemDomainsAfterShutdown);
  assert.deepEqual(actual.stateBeforeReads, actual.stateAfterReads);
  assert.deepEqual(actual.stateBeforeReads, actual.stateAfterShutdown);
  assert.ok(Object.values(actual.cleanup).every(Boolean));
  assert.deepEqual(differences, []);
}));
