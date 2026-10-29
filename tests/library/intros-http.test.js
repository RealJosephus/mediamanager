import test from 'node:test';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recordItemFilterCandidate, validateFixture } from './item-filter-http-scenario.js';
import { currentUserViewScenario, candidateCasesFromTrackedInput, userViewEvidenceJson as json } from '../helpers/current-user-view-scenario.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { randomUUID } from 'node:crypto';
import { idKey } from '../../src/library/records.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE) });

const bytes = await readFile(new URL('./fixtures/intros-http/input.json', import.meta.url));
const fixture = JSON.parse(bytes);
validateFixture(fixture);

function assertReadOnly(actual) {
  assert.deepEqual(actual.beforeReads, actual.afterReads);
  assert.deepEqual(actual.beforeReads, actual.afterShutdown);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterReads);
  assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterShutdown);
  assert.deepEqual(actual.filesystemBeforeReads, actual.filesystemAfterReads);
  assert.deepEqual(actual.filesystemBeforeReads, actual.filesystemAfterShutdown);
  assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true, portReleased: true,
    postgresSchemasRemoved: true, programDataDirectoryRemoved: true });
}
const options = { dialect: 'postgres', connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
  captureResponseBodies: true, captureErrorText: true, captureCaseRuntimeErrors: true,
  trackUserData: true, trackFilesystem: true, captureShutdownState: true,
};

async function prepareNavigation({ programDataPath, database }) {
  const rows = await database.rows('BaseItems');
  for (const item of fixture.items.filter(item => item.type === 'CollectionFolder')) {
    const directory = path.join(programDataPath, 'root/default', item.name);
    await mkdir(directory, { recursive: true });
    if (item.data.CollectionType) await writeFile(path.join(directory, item.data.CollectionType + '.collection'), '');
    const data = { ...item.data, PhysicalLocationsList: item.data.PhysicalFolderIds
      .map(id => rows.find(row => idKey(row.Id) === idKey(id)).Path) };
    await database.update('BaseItems', { Id: item.id.toUpperCase() }, { Path: directory, Data: JSON.stringify(data) });
  }
}

test('intro HTTP routes match 26 current native user, root and binding responses', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE, timeout: 180000,
}, nativeCallback(async t => {
  const { http, root } = await currentUserViewScenario('intros-http', bytes, { signal: t.signal });
  assert.equal(http.records.length, 26);
  assert.deepEqual(http.records[0].response.bodyJson, { Items: [], TotalRecordCount: 0, StartIndex: 0 });
  const cases = candidateCasesFromTrackedInput(fixture);
  const actual = await recordItemFilterCandidate({ ...options, fixture: { ...fixture, cases }, scenarioName: 'intros-http',
    prepareScenario: prepareNavigation });
  const differences = [];
  for (const item of actual.cases) for (const endpoint of item.endpoints) {
    const native = http.records.find(record => record.name === item.name && record.endpoint === endpoint.endpoint);
    try {
      assert.equal(endpoint.response.status, native.response.status);
      assert.equal(endpoint.response.contentType, native.response.contentType);
      if (native.response.bodyJson !== undefined) assert.deepEqual(projectProblemTrace(endpoint.response.body, endpoint.response.status), projectProblemTrace(native.response.bodyJson, native.response.status));
      else assert.equal(endpoint.response.bodyText, native.response.bodyText);
    } catch (error) { differences.push({ name: item.name, endpoint: endpoint.endpoint, message: error.message }); }
  }
  await writeFile(path.join(root, 'postgres.json'), json(actual), { flag: 'wx' });
  await writeFile(path.join(root, 'postgres-comparison.json'), json({ passed: differences.length === 0,
    phaseAcceptance: false, responses: http.records.length, normalization: 'Only root ProblemDetails traceId, retaining presence/type and all nested values.', differences }), { flag: 'wx' });
  assert.equal(actual.httpCases, 26);
  assertReadOnly(actual);
  assert.deepEqual(differences, []);
}));

test('installed intro plugins return ordered DTOs through PostgreSQL HTTP and stop on disable', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES, timeout: 120000,
}, async () => {
  const main = fixture.items.find(item => item.key === 'main'), video = fixture.items.find(item => item.key === 'introVideo');
  const cases = ['active', 'disabled', 'enabled again'].map(name => ({ name, action: 'intros', detailKey: 'main', query: '',
    scope: [], omitScope: true, expectedStatus: 200, endpoints: ['items', 'legacy'] }));
  const actual = await recordItemFilterCandidate({ ...options, fixture: { ...fixture, cases }, scenarioName: 'intros-plugin-http',
    prepareScenario: async context => {
      await prepareNavigation(context);
      const { programDataPath, plugins } = context;
      const source = path.join(programDataPath, 'controlled-intro-package'); await mkdir(source);
      await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@test/intro', version: '0.1.0', type: 'module',
        mediamanager: { id: 'controlled-intros', name: 'Controlled intros', entry: 'index.js' } }));
      await writeFile(path.join(source, 'index.js'), `import { setTimeout } from 'node:timers/promises';
        export async function activate(context) {
          await context.register('intro', { async getIntros(item, { user, signal }) {
            if (!user?.Id || !signal || item.Id.replaceAll('-', '').toLowerCase() !== '${idKey(main.id)}') throw new Error('Invalid intro request context.');
            await setTimeout(20, undefined, { signal });
            return [{ ItemId: '${video.id}' }, { ItemId: '${main.id}' }, { ItemId: '${video.id}' }];
          }});
          await context.register('intro', { async getIntros() { throw new Error('Controlled intro provider failure.'); }});
          await context.register('intro', { async getIntros() { return [{ ItemId: '${main.id}' }]; }});
        }`);
      await plugins.install(source);
    },
    prepareCase: async ({ testCase, runtime }) => {
      if (testCase.name !== 'active') await runtime.plugins.setEnabled('controlled-intros', testCase.name !== 'disabled');
    },
  });
  const output = path.join(validationOutputRoot(), 'intros-plugin-http-' + randomUUID()); await mkdir(output);
  await writeFile(path.join(output, 'postgres.json'), json(actual), { flag: 'wx' });
  for (const item of actual.cases) for (const endpoint of item.endpoints) {
    assert.equal(endpoint.response.status, 200, endpoint.response.bodyText);
    const active = item.name !== 'disabled';
    assert.deepEqual(endpoint.response.body.Items.map(item => item.Id), active ? [video, main, video, main].map(item => idKey(item.id)) : []);
    assert.equal(endpoint.response.body.TotalRecordCount, active ? 4 : 0);
    assert.equal(endpoint.response.body.StartIndex, 0);
    for (const dto of endpoint.response.body.Items) {
      const source = idKey(dto.Id) === idKey(main.id) ? main : video;
      assert.equal(dto.Name, source.name); assert.equal(dto.Type, source.type); assert.equal(dto.MediaType, 'Video');
      assert.ok(dto.UserData); assert.ok(dto.ImageTags);
    }
    if (active) assert.ok(endpoint.runtimeErrors.some(error => error?.message === 'Controlled intro provider failure.'),
      'The installed failing provider ran before the later provider completed.');
  }
  assert.equal(actual.httpCases, 6);
  assertReadOnly(actual);
});
