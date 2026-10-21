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

const bytes = await readFile(new URL('./fixtures/live-tv-recommended-http/input.json', import.meta.url));
const fixture = JSON.parse(bytes);
validateFixture(fixture);

const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId').map(([key, entry]) => [key,
    key === 'ServerId' ? '$server' : ['DateCreated', 'DateLastSaved', 'StartDate', 'EndDate'].includes(key)
      && typeof entry === 'string' ? dateText(entry) : normalize(entry)])) : value;

test('recommended guide HTTP matches native repository limits, scoring, fields and access in PostgreSQL', {
  skip: !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE || !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 300000,
}, async () => {
  const { http, stages, root } = await currentUserViewScenario('live-tv-recommended-http', bytes);
  assert.equal(http.records.length, 64);
  const body = name => http.records.find(record => record.name === name)?.response.bodyJson;
  assert.equal(body('airing limited').Items.length, 3);
  assert.equal(body('airing limited').TotalRecordCount, 200);
  assert.equal(body('airing no count').TotalRecordCount, 200);
  assert.equal(body('airing no count').Items.length, 24);
  assert.equal(body('airing no count').Items.find(item => item.Name === 'Repeat series').MediaType, 'Audio');
  assert.match(body('channel image').Items[0].ChannelPrimaryImageTag, /^[a-f0-9]{32}$/u);
  assert.equal(http.records.find(record => record.name === 'live tv forbidden').response.bodyText, '');
  assert.equal(body('ordinary no count').TotalRecordCount, 3);
  assert.deepEqual(body('airing limited').Items.map(item => item.Name), ['New series', 'Repeat series', 'Guide flags']);
  assert.equal(body('airing overflowing cap').TotalRecordCount, 200);
  assert.equal(body('airing overflowing cap').Items.length, 200);
  assert.equal(body('airing offset ignored').StartIndex, 2);
  assert.deepEqual(body('airing offset ignored').Items, body('airing limited').Items);
  assert.ok(body('airing no limit').TotalRecordCount > 200);
  assert.deepEqual(body('unknown genre').Items, []);
  for (const item of body('removed fields').Items) for (const field of ['CanDelete', 'CanDownload', 'DisplayPreferencesId', 'Etag']) {
    assert.ok(!Object.hasOwn(item, field), field);
  }
  const preparation = JSON.parse(await readFile(path.join(root, 'reference-preparation.json'), 'utf8'));
  const live = preparation.liveTvViewDiscovery;
  assert.ok(live);
  assert.match(idKey(live.actualId), /^[a-f0-9]{32}$/u);
  const view = stages.before.database.baseItems.find(item => idKey(item.Id) === idKey(live.actualId));
  assert.equal(JSON.parse(view.Data).ViewType, 'livetv');
  const programs = stages.before.database.baseItems.filter(item => item.Type === 'MediaBrowser.Controller.LiveTv.LiveTvProgram');
  assert.equal(programs.length, 217);
  assert.equal(programs.filter(item => idKey(item.TopParentId) === idKey(live.actualId)).length, 216);
  assert.deepEqual(stages.before, stages.afterReads);
  assert.deepEqual(stages.before, stages.afterShutdown);

  // The native manager creates this global view during preparation. Bind its
  // observed identity as an input; synthetic program and channel ids stay literal.
  const rebound = JSON.parse(JSON.stringify(fixture).replaceAll(live.fixtureId, live.actualId.toLowerCase()));
  const actual = await recordItemFilterCandidate({ dialect: 'postgres', fixture: rebound,
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES, scenarioName: 'live-tv-recommended-http',
    captureResponseBodies: true, captureErrorText: true, captureCaseRuntimeErrors: true,
    trackUserData: true, trackFilesystem: true, captureShutdownState: true,
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
    prepareCase: async ({ testCase, runtime }) => { Object.assign(runtime.configuration, testCase.serverConfiguration); },
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
      assert.deepEqual(normalize(endpoint.response.body ?? endpoint.response.bodyText),
        normalize(reference.response.bodyJson ?? reference.response.bodyText));
      assert.deepEqual(endpoint.runtimeErrors, ['airing no user', 'airing unknown user'].includes(item.name)
        ? [{ name: 'Error', message: 'Invalid recommendation user or channel data.' }] : []);
    } catch (error) { differences.push({ name: item.name, message: error.message }); }
  }
  await writeFile(path.join(root, 'postgres-comparison.json'), json({ passed: differences.length === 0, phaseAcceptance: false,
    responses: http.records.length, differences,
    boundary: 'Complete recommendation HTTP responses, literal media identities and unchanged read/shutdown state. No built-in recording, timer-state or complete Live TV API acceptance.' }), { flag: 'wx' });
  assert.deepEqual(actual.beforeReads, actual.afterReads);
  assert.deepEqual(actual.beforeReads, actual.afterShutdown);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterReads);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterShutdown);
  assert.deepEqual(actual.filesystemBeforeReads, actual.filesystemAfterReads);
  assert.deepEqual(actual.filesystemBeforeReads, actual.filesystemAfterShutdown);
  assert.deepEqual(actual.runtimeErrors, []);
  assert.ok(Object.values(actual.cleanup).every(Boolean));
  assert.deepEqual(differences, []);
});
