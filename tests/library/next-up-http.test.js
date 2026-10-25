import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tableDefinition } from '../../src/database/model.js';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const fixtureBytes = await readFile(new URL('./fixtures/next-up/input.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes);
const reference = JSON.parse(await readFile(new URL('./fixtures/next-up/native.json', import.meta.url), 'utf8'));
const { http, summary } = reference;
const nativeCaseStages = reference.immutableState.caseStages;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(summary.passed, true);
assert.equal(summary.candidateVerified, false);
assert.equal(summary.phaseAcceptance, false);
assert.equal(summary.cases, 53);
assert.equal(summary.snapshots, 53);
assert.equal(summary.fixtureSha256, sha256(fixtureBytes));
assert.equal(reference.schemaVersion, 1);
assert.equal(summary.recorderSha256, reference.source.files['record-next-up.js'].sha256);
assert.equal(summary.fixtureSha256, reference.source.files['input.json'].sha256);
assert.deepEqual(summary.processResult, { code: 0, signal: null });
assert.equal(summary.portAvailable, true);
assert.equal(reference.immutableState.readStages.length, 3);
for (const stage of reference.immutableState.readStages) assert.equal(stage.sha256, reference.immutableState.readStages[0].sha256);
assert.equal(nativeCaseStages.length, 53);
for (const stage of nativeCaseStages) {
  assert.equal(stage.beforeSha256, stage.afterSha256);
  assert.equal(stage.beforeSha256, reference.immutableState.readStages[0].sha256);
}
const normalizeBody = value => Array.isArray(value) ? value.map(normalizeBody)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, key === 'ServerId' ? '$server' : normalizeBody(entry)])) : value;
const columns = tableDefinition('BaseItems').columns;
const dialects = process.env.MEDIAMANAGER_NEXT_UP_DIALECT ? [process.env.MEDIAMANAGER_NEXT_UP_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid NextUp dialect.');

for (const dialect of dialects) test(`${dialect}: tvnextup matches 53 complete native responses, immutable endpoint and shutdown state`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async t => {
  const evidenceRoot = path.resolve(process.env.MEDIAMANAGER_NEXT_UP_EVIDENCE ?? path.join(validationOutputRoot(), 'next-up'));
  const queryScope = new AsyncLocalStorage(), observedRuntimes = new WeakSet(), queryOperations = [];
  let requestScope;
  const recordDiagnostics = () => {
    const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
    const redact = value => typeof value === 'string' && connectionString ? value.replaceAll(connectionString, '[fixture-secret]') : value;
    const snapshot = error => JSON.parse(JSON.stringify(error, (_key, value) => value instanceof Error
      ? Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, value[key]])) : redact(value)));
    const operations = queryOperations.map(operation => ({ caseName: operation.caseName, endpoint: operation.endpoint,
      method: operation.method, failed: operation.failed, ...(operation.failed ? { requestOpen: operation.requestOpen, failure: { ...operation.values,
        raw: snapshot(operation.error),
        message: redact(operation.values.message), name: operation.error?.name, stack: redact(operation.error?.stack) } } : {}) }));
    t.diagnostic(JSON.stringify({ nativeErrorDiagnostics: reference.nativeErrors, nextUpQueryDiagnostics: operations }));
    return operations;
  };
  let actual;
  try {
    // Seed validation requires resolved version ids. The isolated native row
    // below restores its intentional dangling PrimaryVersionId before startup.
    const candidateFixture = structuredClone(fixture);
    const ids = new Set(candidateFixture.items.map(item => idKey(item.id)));
    for (const item of candidateFixture.items) if (item.primaryVersionId && !ids.has(idKey(item.primaryVersionId))) delete item.primaryVersionId;
    actual = await recordItemFilterCandidate({
      dialect, fixture: candidateFixture, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'next-up', fields: 'SortName', captureOrder: true, captureStartIndex: true,
      captureSortNames: true, captureResponseBodies: true, captureCaseRuntimeErrors: true,
      trackUserData: true, trackFilesystem: true, captureEndpointStages: true, captureFilesystemDomains: true,
      configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false, DisplaySpecialsWithinSeasons: true },
      prepareScenario: async ({ database, programDataPath, user }) => {
        const paths = { userRoot: path.join(programDataPath, 'root/default'), playlists: path.join(programDataPath, 'data/playlists') };
        for (const letter of ['A', 'B', 'T', 'K', 'M']) {
          paths['physical' + letter] = path.join(programDataPath, 'library-content', letter);
          paths['library' + letter] = path.join(programDataPath, 'root/default', 'Library ' + letter);
        }
        for (const directory of [path.join(programDataPath, 'metadata'), path.join(programDataPath, 'data/collections'),
          path.join(programDataPath, 'root/default/Collection Library'), ...Object.values(paths)]) await mkdir(directory, { recursive: true });
        const itemPath = item => item.fileName ? path.join(paths.physicalT, item.fileName) : paths[item.pathKind]
          ?? (item.pathKind === 'view' ? path.join(programDataPath, 'metadata/views', idKey(item.id))
            : item.pathKind === 'child' ? path.join(itemPath(fixture.items.find(row => row.id === item.parentId)) ?? paths.physicalA,
              item.key + (item.type === 'Movie' ? '.mkv' : '')) : path.join(paths.physicalA, item.key));
        for (const item of fixture.items) {
          if (item.type === 'AggregateFolder') continue;
          const native = reference.initialBaseItems.find(row => idKey(row.Id) === idKey(item.id));
          assert.ok(native, item.key);
          const values = Object.fromEntries(columns.filter(column => !['Id', 'ParentId', 'TopParentId', 'Path', 'Data'].includes(column.name))
            .map(column => [column.name, column.clrType.replace('?', '') === 'long' && native[column.name] != null
              ? BigInt(native[column.name]) : native[column.name]]));
          const data = { ...(item.data ?? {}) };
          if (data.UserId) data.UserId = user.Id;
          if (item.type === 'CollectionFolder') data.PhysicalLocationsList = data.PhysicalFolderIds
            .map(id => itemPath(fixture.items.find(child => child.id === id)));
          assert.equal(await database.update('BaseItems', { Id: item.id.toUpperCase() },
            { ...values, Path: itemPath(item), Data: JSON.stringify(data) }), 1n, item.key);
        }
        for (const stream of fixture.mediaStreams ?? []) {
          const item = fixture.items.find(row => row.key === stream.itemKey);
          assert.equal(await database.update('MediaStreamInfos', { ItemId: item.id.toUpperCase(), StreamIndex: stream.index ?? 0 },
            { Width: stream.width ?? null }), 1n, item.key);
        }
        for (const data of fixture.userData) {
          const item = fixture.items.find(row => row.key === data.itemKey);
          await database.insert('UserData', { ItemId: item.id, UserId: user.Id, CustomDataKey: data.customDataKey ?? item.id,
            AudioStreamIndex: null, IsFavorite: data.isFavorite, LastPlayedDate: data.lastPlayedDate, Likes: null,
            PlayCount: data.played ? 1 : 0, PlaybackPositionTicks: BigInt(data.positionTicks), Played: data.played,
            Rating: null, RetentionDate: null, SubtitleStreamIndex: null });
        }
        if (dialect === 'postgres') {
          const rows = database.rows.bind(database);
          database.rows = (name, options) => {
            const bounded = options?.where || options?.whereIn || options?.limit !== undefined;
            if (queryScope.getStore()?.active && !bounded && ['BaseItems', 'MediaStreamInfos'].includes(name)) {
              throw new Error(`Next Up attempted an unbounded PostgreSQL ${name} read.`);
            }
            return rows(name, options);
          };
        }
      },
      prepareCase: async ({ testCase, runtime }) => {
        requestScope = { name: testCase.name, endpoints: testCase.endpoints ?? ['items', 'legacy'], index: 0, active: true };
        if (!observedRuntimes.has(runtime)) {
          observedRuntimes.add(runtime);
          for (const method of ['queryItems', 'queryNextUpEpisodes']) {
            const query = runtime.library[method];
            runtime.library[method] = function (...args) {
              const request = requestScope, endpointIndex = request?.index;
              const operation = { caseName: request?.active ? request.name : null,
                endpoint: request?.active ? request.endpoints[endpointIndex] : null, method, failed: false };
              queryOperations.push(operation);
              const scope = { active: true };
              return queryScope.run(scope, async () => {
                try { return await query.apply(this, args); }
                catch (error) {
                  operation.failed = true; operation.error = error;
                  operation.requestOpen = request?.active === true && request.index === endpointIndex;
                  operation.values = { message: error?.message, status: error?.status ?? error?.statusCode ?? 500, code: error?.code ?? null };
                  throw error;
                } finally { scope.active = false; }
              });
            };
          }
        }
        if (testCase.serverConfiguration) {
          Object.assign(runtime.configuration, testCase.serverConfiguration);
          for (const [key, value] of Object.entries(testCase.serverConfiguration)) assert.equal(runtime.configuration[key], value);
        }
      },
      afterEndpoint: async () => {
        requestScope.index++;
        requestScope.active = requestScope.index < requestScope.endpoints.length;
      },
    });
  } catch (error) {
    recordDiagnostics();
    try {
      const output = evidenceRoot;
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, `${dialect}-failure.json`), JSON.stringify({ passed: false, phaseAcceptance: false, dialect,
        error }, (_key, value) => value instanceof Error
        ? Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, value[key]]))
        : typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { flag: 'wx' });
    } catch (evidenceError) {
      throw new AggregateError([error, evidenceError], error.message, { cause: error });
    }
    throw error;
  }
  actual.nextUpQueryDiagnostics = recordDiagnostics();
  const differences = [];
  const check = (name, operation) => { try { operation(); } catch (error) { differences.push({ name, message: error.message }); } };
  check('matrix count', () => { assert.equal(actual.httpCases, 53); assert.equal(actual.caseStages.length, 53); });
  for (const item of actual.cases) {
    const records = http.records.filter(record => record.name === item.name);
    for (const [index, endpoint] of item.endpoints.entries()) check(`${item.name}:${endpoint.endpoint}: full HTTP`, () => {
      const native = records[index];
      assert.equal(endpoint.endpoint, native.endpoint);
      assert.equal(endpoint.response.status, native.response.status);
      assert.equal(endpoint.response.contentType, native.response.contentType);
      if (native.response.status < 400) assert.deepEqual(normalizeBody(endpoint.response.body), normalizeBody(native.response.bodyJson));
      else assert.equal(endpoint.response.bodyText, native.response.bodyText);
      const failures = queryOperations.filter(operation => operation.failed && operation.caseName === item.name
        && operation.endpoint === endpoint.endpoint);
      if (native.response.status >= 400) {
        assert.ok(failures.some(operation => operation.values.status === endpoint.response.status),
          'The actual Next Up query must reject at the matching HTTP boundary.');
        for (const operation of failures) {
          assert.equal(operation.requestOpen, true, 'A completed HTTP request cannot absorb a later query failure.');
          assert.equal(operation.values.status, endpoint.response.status);
        }
        for (const error of endpoint.runtimeErrors) assert.ok(failures.some(operation =>
          operation.values.status === endpoint.response.status && operation.values.message === error.message),
        'Only the matching actual Next Up query failure may classify its diagnostic.');
      } else {
        assert.ok(!failures.length, 'Successful Next Up requests must not hide a query failure.');
        assert.deepEqual(endpoint.runtimeErrors, [], 'Successful requests must not report an unclassified runtime failure.');
      }
    });
  }
  for (const [index, stage] of actual.caseStages.entries()) check(`${stage.name}:${stage.endpoint}: immutable endpoint state`, () => {
    assert.deepEqual([stage.name, stage.endpoint], [nativeCaseStages[index].name, nativeCaseStages[index].endpoint]);
    assert.deepEqual(stage.before, stage.after);
    assert.deepEqual(stage.before.database, actual.beforeReads);
    assert.deepEqual(stage.before.userData, actual.userDataBeforeReads);
    assert.deepEqual(stage.before.filesystemDomains, actual.filesystemDomainsBeforeReads);
  });
  check('reads and actual shutdown state', () => {
    assert.deepEqual(actual.beforeReads, actual.afterReads);
    assert.deepEqual(actual.afterReads, actual.afterShutdown);
    assert.deepEqual(actual.userDataBeforeReads, actual.userDataAfterReads);
    assert.deepEqual(actual.userDataAfterReads, actual.userDataAfterShutdown);
    assert.deepEqual(actual.filesystemDomainsBeforeReads, actual.filesystemDomainsAfterReads);
    assert.deepEqual(actual.filesystemDomainsAfterReads, actual.filesystemDomainsAfterShutdown);
    assert.deepEqual(actual.runtimeErrors, []);
    assert.deepEqual(actual.handledExpectedRuntimeErrors, []);
    assert.ok(!queryOperations.some(operation => operation.failed && operation.endpoint == null),
      'A background or shutdown query failure cannot be assigned to an earlier HTTP response.');
  });
  check('cleanup', () => assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true, portReleased: true,
    postgresSchemasRemoved: dialect === 'postgres' ? true : null, programDataDirectoryRemoved: true }));
  {
    const output = evidenceRoot;
    await mkdir(output, { recursive: true });
    const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
    await writeFile(path.join(output, `${dialect}.json`), json(actual), { flag: 'wx' });
    await writeFile(path.join(output, `${dialect}-comparison.json`), json({ passed: differences.length === 0, phaseAcceptance: false,
      dialect, responses: 53, endpointSnapshots: 53, fixtureSha256: summary.fixtureSha256,
      testSha256: sha256(await readFile(new URL(import.meta.url))),
      harnessSha256: sha256(await readFile(new URL('./item-filter-http-scenario.js', import.meta.url))),
      selectorSha256: sha256(await readFile(new URL('../../src/library/next-up.js', import.meta.url))),
      comparedFields: 'Complete list JSON/status/content type/plaintext errors; every endpoint media/UserData/directory before and after; unchanged full read and actual shutdown snapshots; cleanup.',
      normalization: 'Only isolated ServerId in successful response JSON. Candidate fixture UserId and physical paths relocate to its isolated runtime; native stored columns restored before requests. No response item/count/order/paging normalization.',
      serverConfigurationSetup: 'Equivalent candidate runtime DisplaySpecialsWithinSeasons is assigned and read back; its configuration HTTP controller is not covered.',
      native: summary, differences }), { flag: 'wx' });
  }
  assert.equal(differences.length, 0, JSON.stringify(differences.slice(0, 4)));
});
