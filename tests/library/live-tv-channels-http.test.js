import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dateText, idKey } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { tableDefinition } from '../../src/database/model.js';
import { nativeRootUserViewIdentity } from '../../src/library/identity.js';
import { recordItemFilterCandidate, validateFixture } from './item-filter-http-scenario.js';
import { currentUserViewScenario, userViewEvidenceJson as json } from '../helpers/current-user-view-scenario.js';

const bytes = await readFile(new URL('./fixtures/live-tv-channels-http/input.json', import.meta.url));
const fixture = JSON.parse(bytes);
validateFixture(fixture);

const normalize = (value, programRoot) => Array.isArray(value) ? value.map(entry => normalize(entry, programRoot)) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId').map(([key, entry]) => [key,
    key === 'ServerId' ? '$server' : ['DateCreated', 'DateLastSaved', 'StartDate', 'EndDate'].includes(key)
      && typeof entry === 'string' ? dateText(entry) : key === 'Path' && typeof entry === 'string'
        && entry.replaceAll('\\', '/').startsWith(programRoot + '/')
        ? '$program/' + entry.replaceAll('\\', '/').slice(programRoot.length + 1) : normalize(entry, programRoot)])) : value;
const boundRequest = (request, userId) => ({ ...request, ...(Object.hasOwn(request, 'body') ? {
  body: request.body && Object.fromEntries(Object.entries(request.body).map(([key, value]) => [key,
    key.toLowerCase() === 'userid' && typeof value === 'string' && idKey(value) === idKey(userId) ? '$user' : value])),
} : {}) });

test('channel lists, details and global current-program windows match full native HTTP', {
  skip: !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE || !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 300000,
}, async () => {
  const { http, stages, root } = await currentUserViewScenario('live-tv-channels-http', bytes);
  assert.equal(http.records.length, 57);
  const body = name => http.records.find(record => record.name === name)?.response.bodyJson;
  assert.equal(body('all channels').TotalRecordCount, 4);
  const all = body('all channels').Items;
  assert.equal(all.find(item => item.Name === 'Neutral channel').CurrentProgram.Name, 'Neutral opening');
  assert.equal(all.filter(item => item.CurrentProgram).length, 2);
  assert.equal(body('detail radio').CurrentProgram.Name, 'Repeat series');
  assert.equal(body('detail late').CurrentProgram.Name, 'Late channel current');
  assert.ok(body('no current program').Items.every(item => !Object.hasOwn(item, 'CurrentProgram')));
  assert.equal(body('favorite sorting').Items[0].Name, 'Late channel');
  assert.equal(body('play count sorting').Items[0].Name, 'Disliked channel');
  assert.deepEqual(body('radio filter ignored'), body('all channels'));
  assert.deepEqual(body('disliked filter ignored'), body('all channels'));
  assert.deepEqual(body('bad type'), body('all channels'));
  assert.deepEqual(body('bad sort order'), body('all channels'));
  assert.deepEqual(body('shows invalid nullable sort'), body('shows default sort'));
  assert.deepEqual(body('shows default sort'), { Items: [], TotalRecordCount: 0, StartIndex: 0 });
  for (const name of ['list api key no user', 'list api key zero user']) {
    assert.ok(body(name).Items.every(item => !Object.hasOwn(item, 'UserData')));
  }
  const sources = body('current full fields').Items;
  for (const [name, protocol] of [['Neutral channel', 'File'], ['Favorite channel', 'Http'],
    ['Disliked channel', 'Rtsp'], ['Late channel', 'Http']]) {
    assert.equal(sources.find(item => item.Name === name).MediaSources[0].Protocol, protocol);
  }
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
  assert.equal(programs.length, 15);
  assert.equal(programs.filter(item => idKey(item.TopParentId) === idKey(live.actualId)).length, 14);
  assert.deepEqual(stages.before, stages.afterReads);
  assert.deepEqual(stages.before, stages.afterShutdown);

  // The native manager creates this global view during preparation. Bind its
  // observed identity as an input; synthetic program and channel ids stay literal.
  assert.equal(preparation.liveTvDocuments.length, 2);
  let nativeState;
  const rebound = JSON.parse(JSON.stringify(fixture).replaceAll(live.fixtureId, live.actualId.toLowerCase()));
  const actual = await recordItemFilterCandidate({ dialect: 'postgres', fixture: rebound,
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, scenarioName: 'live-tv-channels-http',
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
        if (Object.hasOwn(item, 'path')) values.Path = item.path;
        else if (item.pathKind === 'noPath') values.Path = null;
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
      assert.deepEqual(normalize(endpoint.response.body ?? endpoint.response.bodyText, actual.programDataDirectory.replaceAll('\\', '/')),
        normalize(reference.response.bodyJson ?? reference.response.bodyText, nativeProgramRoot));
      const expected = rebound.cases.find(testCase => testCase.name === item.name);
      assert.deepEqual(endpoint.runtimeErrors, expected.expectedRuntimeError ? [{ name: 'Error', message: expected.expectedRuntimeError }] : []);
    } catch (error) { differences.push({ name: item.name, message: error.message }); }
  }
  await writeFile(path.join(root, 'postgres-comparison.json'), json({ passed: differences.length === 0, phaseAcceptance: false,
    responses: http.records.length, differences,
    boundary: 'Complete channel GET/detail HTTP and global-window current programs, first-custom-key sorts and native ignored selectors. Controlled future timers; no recording execution or complete Live TV acceptance.' }), { flag: 'wx' });
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
  assert.deepEqual(actual.runtimeErrors, []);
  assert.ok(Object.values(actual.cleanup).every(Boolean));
  assert.deepEqual(differences, []);
});
