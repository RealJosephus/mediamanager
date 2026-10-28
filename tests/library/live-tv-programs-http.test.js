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
import { currentUserViewScenario, userViewEvidenceJson as json } from '../helpers/current-user-view-scenario.js';
import { projectItemBody } from '../helpers/http-body-projection.js';
import { bindFixtureInput } from '../helpers/fixture-input-binding.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE) });

const bytes = await readFile(new URL('./fixtures/live-tv-programs-http/input.json', import.meta.url));
const fixture = JSON.parse(bytes);
validateFixture(fixture);

const normalize = (value, programRoot, serverId, status) => projectItemBody(value, { serverId, status,
  date: (entry, { field }) => ['DateCreated', 'DateLastSaved', 'StartDate', 'EndDate'].includes(field) ? dateText(entry) : entry,
  path: entry => entry.replaceAll('\\', '/').startsWith(programRoot + '/')
    ? '$program/' + entry.replaceAll('\\', '/').slice(programRoot.length + 1) : entry });
const boundRequest = (request, userId) => ({ ...request, ...(Object.hasOwn(request, 'body') ? {
  body: request.body && Object.fromEntries(Object.entries(request.body).map(([key, value]) => [key,
    key.toLowerCase() === 'userid' && typeof value === 'string' && idKey(value) === idKey(userId) ? '$user' : value])),
} : {}) });

test('program list, POST and detail match full native HTTP and unchanged PostgreSQL state', {
  skip: !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE || !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 300000,
}, nativeCallback(async t => {
  const { http, stages, root, nativeServerId } = await currentUserViewScenario('live-tv-programs-http', bytes, { signal: t.signal });
  assert.equal(http.records.length, 70);
  const body = name => http.records.find(record => record.name === name)?.response.bodyJson;
  assert.equal(body('all programs').TotalRecordCount, 11);
  assert.equal(body('series filter').Items.length, 1);
  assert.equal(body('series filter').Items[0].Name, 'Next day favorite');
  assert.deepEqual(body('series filter'), body('duplicate timer identity winner'));
  assert.equal(body('empty series id').StartIndex, 0);
  assert.equal(body('empty series id').Items.length, 0);
  assert.equal(body('restricted post anonymous body').TotalRecordCount, 11);
  assert.equal(body('restricted post explicit user').TotalRecordCount, body('restricted get').TotalRecordCount);
  assert.equal(body('restricted get').TotalRecordCount, 10);
  const preparation = JSON.parse(await readFile(path.join(root, 'reference-preparation.json'), 'utf8'));
  const userRootPath = preparation.copyBindings.seededUserRoot.Path.replaceAll('\\', '/');
  assert.ok(userRootPath.endsWith('/root/default'));
  const nativeProgramRoot = userRootPath.slice(0, -'/root/default'.length);
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
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, scenarioName: 'live-tv-programs-http',
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
      assert.deepEqual(boundRequest(endpoint.request, actual.userId), boundRequest(reference.request, fixture.userId));
      assert.equal(endpoint.response.status, reference.response.status);
      assert.equal(endpoint.response.contentType, reference.response.contentType);
      assert.deepEqual(normalize(endpoint.response.body ?? endpoint.response.bodyText, actual.programDataDirectory.replaceAll('\\', '/'), actual.serverId, endpoint.response.status),
        normalize(reference.response.bodyJson ?? reference.response.bodyText, nativeProgramRoot, nativeServerId, reference.response.status));
    } catch (error) { differences.push({ name: item.name, message: error.message }); }
  }
  await writeFile(path.join(root, 'postgres-comparison.json'), json({ passed: differences.length === 0, phaseAcceptance: false,
    responses: http.records.length, differences,
    boundary: 'Complete Programs GET/POST/detail HTTP, native user selection and SQL filters/page, unchanged file/PG state. Controlled future timers; no recording execution or complete Live TV acceptance.' }), { flag: 'wx' });
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
