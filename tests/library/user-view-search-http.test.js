import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tableDefinition } from '../../src/database/model.js';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { projectItemBody } from '../helpers/http-body-projection.js';
import { projectItemDataIdentities } from '../helpers/fixture-identity-projection.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
const nativeBytes = await readFile(new URL('./fixtures/user-view-search/native.json', import.meta.url));
const inputBytes = await readFile(new URL('./fixtures/user-view-search/input.json', import.meta.url));
assert.equal(sha(nativeBytes), '48206d8766cc402423609a2ce197dccbb97a641b3f8dd5ebd758b52f14b9bd72');
assert.equal(sha(inputBytes), '2ad911ca07feaa382188196a58b144ddada15d6d50bf10e71b846f316d363da4');
const native = JSON.parse(nativeBytes), fixture = JSON.parse(inputBytes);
const observedNativeServerId = native.http.records.flatMap(record => record.response.bodyJson?.Items ?? [])
  .find(item => typeof item.Id === 'string' && typeof item.Type === 'string')?.ServerId;
assert.equal(typeof observedNativeServerId, 'string');
const nativeTables = ['BaseItems', 'AncestorIds', 'LinkedChildren', 'ItemValues', 'ItemValuesMap', 'Peoples',
  'PeopleBaseItemMap', 'BaseItemImageInfos', 'BaseItemProviders', 'BaseItemMetadataFields', 'MediaStreamInfos', 'UserData'];

test('UserView search contract retains 18 raw responses, complete recorded states and executable/source bindings', async () => {
  assert.equal(native.frozenJellyfin, true); assert.equal(native.audit.passed, true); assert.equal(native.audit.phaseAcceptance, false);
  assert.equal(native.inputSha256, sha(inputBytes));
  assert.equal(native.recorderSha256, sha(await readFile(new URL('./fixtures/user-view-search/NativeRecorder.mjs', import.meta.url))));
  assert.equal(native.sourceBindings.length, 8); assert.equal(native.nativeSourceBindings.length, 11);
  assert.equal(native.runtimeBindings.files.length, 230); assert.equal(native.runtimeBindings.copiedEveryFile, true);
  assert.equal(native.runtimeBindings.everySourceAndCopyShaEqual, true);
  assert.equal(native.runtimeBindings.files.find(entry => entry.path === 'jellyfin.dll').sha256, native.summary.dllSha256);
  assert.deepEqual(native.summary.processResult, { code: 0, signal: null });
  assert.equal(native.summary.portAvailable, true); assert.equal(native.audit.processReclaimed, true);
  assert.equal(native.audit.responses, 18); assert.equal(native.audit.endpointSnapshots, 18);
  assert.equal(native.audit.completeStageWindows, 3); assert.equal(native.audit.allRecordedStateEqual, true);
  assert.deepEqual(native.audit.tables, nativeTables); assert.deepEqual(Object.keys(native.nativeState.database.tables), nativeTables);
  assert.deepEqual(native.nativeState.database.foreignKeyCheck, []);
  assert.deepEqual(native.audit.filesystemDomains, ['userViews', 'metadata', 'libraries', 'collections']);
  assert.deepEqual(native.audit.statusCounts, { 200: 15, 500: 3 });
  assert.equal(fixture.cases.length, 18); assert.equal(native.http.records.length, 18);
  for (const [index, record] of native.http.records.entries()) {
    assert.deepEqual([record.name, record.endpoint], [fixture.cases[index].name, 'items']);
    const nohit = record.name.endsWith('-nohit'), anonymous = record.name.includes('-apiKey-');
    assert.equal(record.response.status, nohit && anonymous ? 500 : 200);
    if (record.response.status === 500) assert.equal(record.response.bodyText, 'Error processing request.');
    else {
      assert.equal(record.response.bodyJson.TotalRecordCount, nohit ? 0 : record.name.endsWith('-explicit-union') ? 4 : 3);
      assert.equal(record.response.bodyJson.Items.length, nohit ? 0 : 2);
      if (!nohit) assert.deepEqual(record.response.bodyJson.Items.map(item => item.Type), ['Movie', 'Audio']);
    }
  }
});

for (const dialect of ['postgres']) test(`${dialect}: 18 actual UserView SearchProvider/controller HTTP responses and full endpoint invariants`,
  { skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES }, async () => {
    const actual = await recordItemFilterCandidate({ dialect, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      fixture, scenarioName: 'user-view-search', fields: 'SortName', captureOrder: true, captureStartIndex: true, captureSortNames: true,
      captureResponseBodies: true, captureEndpointStages: true, captureCaseRuntimeErrors: true, captureFilesystemDomains: true,
      trackFilesystem: true, trackUserData: true,
      configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
      prepareScenario: async ({ database, programDataPath }) => {
        const paths = { userRoot: path.join(programDataPath, 'root/default'), physicalA: path.join(programDataPath, 'library-content/A'),
          physicalB: path.join(programDataPath, 'library-content/B'), collections: path.join(programDataPath, 'data/collections'),
          libraryA: path.join(programDataPath, 'root/default/Library A'), libraryB: path.join(programDataPath, 'root/default/Library B'),
          collectionLibrary: path.join(programDataPath, 'root/default/Collection Library') };
        for (const value of Object.values(paths)) await mkdir(value, { recursive: true });
        const itemPath = item => paths[item.pathKind] ?? (item.pathKind === 'child'
          ? path.join(itemPath(fixture.items.find(row => row.id === item.parentId)), item.key + (item.type === 'Movie' ? '.mkv' : ''))
          : path.join(paths.physicalA, item.key));
        const pathMappings = new Map(fixture.items.filter(item => item.type !== 'AggregateFolder').map(item => [
          native.nativeState.database.tables.BaseItems.find(row => idKey(row.Id) === idKey(item.id))?.Path, itemPath(item),
        ]));
        for (const item of fixture.items) {
          if (item.type === 'AggregateFolder') continue;
          const row = native.nativeState.database.tables.BaseItems.find(row => idKey(row.Id) === idKey(item.id));
          assert.ok(row, item.key);
          const values = Object.fromEntries(tableDefinition('BaseItems').columns
            .filter(column => !['Id', 'ParentId', 'TopParentId', 'Path', 'Data'].includes(column.name))
            .map(column => [column.name, column.clrType.replace('?', '') === 'long' && row[column.name] != null ? BigInt(row[column.name]) : row[column.name]]));
          assert.equal(await database.update('BaseItems', { Id: item.id.toUpperCase() },
            { ...values, Path: itemPath(item), Data: projectItemDataIdentities(row.Data, row.Type, new Map(), { paths: pathMappings }) }), 1n, item.key);
        }
        assert.deepEqual(fixture.userData, []);
      } });
    const differences = [];
    const check = (name, scope, assertion) => { try { assertion(); } catch (error) { differences.push({ name, scope, message: error.message }); } };
    check('matrix', 'response and endpoint state count', () => {
      assert.equal(actual.httpCases, 18); assert.equal(actual.caseStages.length, 18);
    });
    const endpoints = actual.cases.flatMap(entry => entry.endpoints.map(endpoint => ({ name: entry.name, ...endpoint })));
    for (const [index, endpoint] of endpoints.entries()) check(endpoint.name, 'complete response and diagnostics', () => {
      const expected = native.http.records[index];
      assert.deepEqual([endpoint.name, endpoint.endpoint], [expected.name, expected.endpoint]);
      assert.equal(endpoint.response.status, expected.response.status); assert.equal(endpoint.response.contentType, expected.response.contentType);
      if (expected.response.status === 500) assert.equal(endpoint.response.bodyText, expected.response.bodyText);
      else assert.deepEqual(projectItemBody(endpoint.response.body,
        { serverId: actual.serverId, serverToken: observedNativeServerId, date: value => value }), expected.response.bodyJson);
    });
    for (const [index, stage] of actual.caseStages.entries()) check(stage.name, 'complete media/UserData/four-domain endpoint state', () => {
      assert.deepEqual([stage.name, stage.endpoint], [native.http.records[index].name, native.http.records[index].endpoint]);
      for (const timing of ['before', 'after']) {
        assert.deepEqual(stage[timing].database, actual.beforeReads); assert.deepEqual(stage[timing].userData, actual.userDataBeforeReads);
        assert.deepEqual(stage[timing].filesystemDomains, actual.filesystemDomainsBeforeReads);
      }
    });
    check('shutdown', 'complete state after all hosts stopped', () => {
      assert.deepEqual(actual.afterReads, actual.beforeReads); assert.deepEqual(actual.afterShutdown, actual.beforeReads);
      assert.deepEqual(actual.userDataAfterReads, actual.userDataBeforeReads); assert.deepEqual(actual.userDataAfterShutdown, actual.userDataBeforeReads);
      assert.deepEqual(actual.filesystemDomainsAfterReads, actual.filesystemDomainsBeforeReads);
      assert.deepEqual(actual.filesystemDomainsAfterShutdown, actual.filesystemDomainsBeforeReads);
    });
    check('cleanup', 'all owned resources reclaimed', () => assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true,
      portReleased: true, postgresSchemasRemoved: dialect === 'postgres' ? true : null, programDataDirectoryRemoved: true }));
    const output = process.env.MEDIAMANAGER_USER_VIEW_SEARCH_EVIDENCE;
    if (output) {
      await mkdir(path.resolve(output), { recursive: true });
      await writeFile(path.join(output, dialect + '.json'), json(actual), { flag: 'wx' });
      await writeFile(path.join(output, dialect + '-comparison.json'), json({ passed: differences.length === 0, phaseAcceptance: false,
        dialect, responses: 18, endpointSnapshots: 18, nativeSha256: sha(nativeBytes), inputSha256: sha(inputBytes),
        testSha256: sha(await readFile(new URL(import.meta.url))), harnessSha256: sha(await readFile(new URL('./item-filter-http-scenario.js', import.meta.url))),
        normalization: 'Only the candidate DTO ServerId is bound to its actual instance and aligned to the literal historical Native observation. Opaque dictionaries and unknown fields remain literal; complete status, content type, ordered full DTO body or exact 500 text are compared. Replay Data preserves TEXT except declared physical path tokens.',
        scope: 'Three persisted UserViews, users/API keys, real provider hits, explicit-ID union and no-hit builder controls. Native full twelve-table/four-domain state is bound; complete candidate state is invariant at all endpoints and after shutdown. Authentication setup tables and native external providers/host cancellation are outside this contract.',
        differences, cleanup: actual.cleanup }), { flag: 'wx' });
    }
    assert.equal(differences.length, 0, JSON.stringify(differences.slice(0, 2)));
  });
