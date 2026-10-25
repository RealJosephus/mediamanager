import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { getNewItemId } from '../../src/core/identity.js';
import { tableDefinition } from '../../src/database/model.js';
import { dateText, dateTicks, idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { writeHttpEndpointEvidence } from './http-endpoint-evidence.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
for (const scenario of [
  { name: 'main', input: 'input.json', native: 'native.json', responses: 224, errors: 8, newRows: 14,
    sha256: 'fcfd09247f02b7ea11300a2a2c8e7f12b7743d8952b89162ab9d535f400eecaa' },
  { name: 'lazy error-first', input: 'lazy-input.json', native: 'lazy-native.json', responses: 8, errors: 4, newRows: 10,
    sha256: 'fcab0bec9ddd41c3fa11220e44f097ac3bb9b668cf624a68da0f558dff57053f' },
]) {
const fixtureBytes = await readFile(new URL('./fixtures/user-view-genre-menu/' + scenario.input, import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const nativeBytes = await readFile(new URL('./fixtures/user-view-genre-menu/' + scenario.native, import.meta.url));
assert.equal(sha256(nativeBytes), scenario.sha256);
const contract = JSON.parse(nativeBytes.toString('utf8'));
assert.equal(contract.format, 1);
assert.equal(contract.frozenJellyfin, true);
assert.equal(contract.fixtureInputSha256, sha256(fixtureBytes));
assert.equal(contract.projection.immutableTablesAndOriginalRowsVerified, true);
const http = contract.http;
const nativeRequestErrors = contract.diagnostics;
const nativeErrorResponses = http.records.filter(record => record.response.status === 400);
assert.equal(nativeErrorResponses.length, scenario.errors);
assert.equal(nativeRequestErrors.length, nativeErrorResponses.length);
for (const [index, record] of nativeErrorResponses.entries()) {
  assert.ok(record.name.endsWith('-empty-guid'));
  assert.equal(record.response.bodyText, 'Error processing request.');
  assert.equal(nativeRequestErrors[index].requestPath, record.endpoint === 'items' ? '/Items' : `/Users/${idKey(fixture.userId)}/Items`);
}
const stages = Object.fromEntries(Object.entries(contract.stages).map(([name, index]) => [name, contract.states[index]]));
const nativeCaseStages = contract.caseStages.map(stage => ({ ...stage,
  before: contract.states[stage.before], after: contract.states[stage.after] }));
const summary = contract.summary;
assert.equal(summary.passed, true);
assert.equal(summary.candidateVerified, false);
assert.equal(summary.cases, scenario.responses);
assert.equal(summary.snapshots, scenario.responses);
assert.deepEqual(summary.processResult, { code: 0, signal: null });
assert.equal(summary.portAvailable, true);
assert.equal(contract.sourceBindings.find(binding => binding.path.endsWith('/record-native.mjs')).sha256, summary.recorderSha256);
assert.equal(sha256(fixtureBytes), summary.fixtureSha256);
assert.deepEqual(stages.afterReads, stages.afterShutdown);
assert.equal(contract.initial.immutableTableCounts.foreignKeyCheck, 0);
assert.equal(contract.initial.baseItems.length, 130);
assert.equal(contract.initial.userDataCount, 61);
assert.equal(nativeCaseStages.length, scenario.responses);
assert.deepEqual(contract.projection.immutableTables, ['ancestorIds', 'linkedChildren', 'itemValues', 'itemValueLinks',
  'userData', 'images', 'providers', 'lockedFields', 'people', 'peopleLinks', 'foreignKeyCheck']);
assert.equal(contract.sourceBindings.length, 7);
assert.ok(contract.sourceBindings.every(binding => /^[a-f0-9]{64}$/u.test(binding.sha256)));
const expectedEndpoints = fixture.cases.flatMap(item => (item.endpoints ?? ['items', 'legacy']).map(endpoint => [item.name, endpoint]));
assert.deepEqual(http.records.map(record => [record.name, record.endpoint]), expectedEndpoints);
assert.deepEqual(nativeCaseStages.map(stage => [stage.name, stage.endpoint]), expectedEndpoints);
for (const record of http.records) assert.equal(record.response.status,
  fixture.cases.find(item => item.name === record.name).expectedStatus ?? 200);
const nativeNewRows = rows => rows;
assert.equal(nativeNewRows(stages.afterReads.database.baseItems).length, scenario.newRows);
if (scenario.name === 'lazy error-first') {
  assert.deepEqual(nativeCaseStages.map(stage => stage.after.database.baseItems.length), [2, 2, 3, 3, 9, 9, 10, 10]);
}

const dialects = process.env.MEDIAMANAGER_USER_VIEW_GENRE_MENU_DIALECT
  ? [process.env.MEDIAMANAGER_USER_VIEW_GENRE_MENU_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid UserView menu dialect.');
const columns = tableDefinition('BaseItems').columns;
const normalizeBody = value => Array.isArray(value) ? value.map(normalizeBody)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'traceId').map(([key, entry]) => [key, key === 'ServerId' ? '$server' : normalizeBody(entry)])) : value;
const stable = rows => [...rows].sort((a, b) => idKey(a.Id).localeCompare(idKey(b.Id), 'en'));
// This reproduces the frozen library's externally defined user-specific key;
// it is deliberately independent of the candidate UserView identity helper.
const rootViewId = (userId, viewType) => idKey(getNewItemId(`38_namedview_${idKey(userId)}${viewType}`,
  'MediaBrowser.Controller.Entities.UserView', { programDataPath: 'Z:\\OracleUserViews' }));
const dynamicDates = new Set(['DateCreated', 'DateLastRefreshed', 'DateLastSaved', 'DateModified']);

function rowContract(row, userId, userViewIds, final) {
  const mappedId = value => userViewIds.get(idKey(value)) ?? idKey(value);
  const data = row.Data == null ? null : JSON.parse(row.Data);
  if (data) delete data.DateLastSaved;
  if (data?.UserId) {
    assert.equal(idKey(data.UserId), idKey(userId));
    data.UserId = '$user';
  }
  return Object.fromEntries(columns.filter(column => !dynamicDates.has(column.name)
    && (final || !['DateModified', 'PresentationUniqueKey'].includes(column.name))).map(column => {
    const value = row[column.name];
    if (column.name === 'Data') return ['Data', data];
    if (value == null) return [column.name, value];
    if (column.clrType.replace('?', '') === 'Guid') return [column.name, mappedId(value)];
    if (column.clrType.replace('?', '') === 'bool') return [column.name, Boolean(value)];
    if (column.name === 'PresentationUniqueKey') return [column.name, mappedId(value)];
    if (column.name === 'Path') return [column.name, value.replaceAll('\\', '/').replace(/views\/([a-f0-9]{32})$/iu,
      (_match, id) => 'views/' + mappedId(id))];
    return [column.name, value];
  }));
}

for (const dialect of dialects) {
  test(`${dialect}: Movie/TV Genre ${scenario.name} matches ${scenario.responses} complete HTTP responses and ${scenario.newRows} persisted entities`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    let actual;
    const output = path.resolve(process.env.MEDIAMANAGER_USER_VIEW_GENRE_MENU_EVIDENCE
      ?? path.join(validationOutputRoot(), 'user-view-genre-menu'), scenario.name === 'main' ? '.' : 'lazy');
    try {
      actual = await recordItemFilterCandidate({
        dialect, fixture, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
        scenarioName: 'user-view-genre-menu', fields: 'SortName', captureOrder: true, captureStartIndex: true,
        captureSortNames: true, captureResponseBodies: true, captureCaseRuntimeErrors: true,
        trackUserData: true, trackFilesystem: true, captureEndpointStages: true, captureFilesystemDomains: true,
        configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
        prepareScenario: async ({ database, programDataPath, user, users }) => {
          const control = await users.createUser({ Name: 'OracleControlAdmin', Password: 'control password' });
          const controlState = await users.getUser(control.Id);
          await users.updatePolicy(control.Id, { ...controlState.Policy, IsAdministrator: true });
          assert.equal((await database.rows('Permissions')).filter(row => row.Kind === 0 && row.Value).length, 2);
          const paths = { userRoot: path.join(programDataPath, 'root/default'), playlists: path.join(programDataPath, 'data/playlists') };
          for (const letter of ['A', 'B', 'T', 'K', 'M']) {
            paths['physical' + letter] = path.join(programDataPath, 'library-content', letter);
            paths['library' + letter] = path.join(programDataPath, 'root/default', 'Library ' + letter);
          }
          for (const directory of [path.join(programDataPath, 'metadata'), path.join(programDataPath, 'data/collections'),
            path.join(programDataPath, 'root/default/Collection Library'), ...Object.values(paths)]) await mkdir(directory, { recursive: true });
          const itemPath = item => paths[item.pathKind] ?? (item.pathKind === 'view'
            ? path.join(programDataPath, 'metadata/views', idKey(item.id))
            : item.pathKind === 'child' ? path.join(itemPath(fixture.items.find(row => row.id === item.parentId)),
              item.key + (item.type === 'Movie' ? '.mkv' : '')) : path.join(paths.physicalA, item.key));
          for (const item of fixture.items) {
            if (item.type === 'AggregateFolder') continue;
            const native = contract.initial.baseItems.find(row => idKey(row.Id) === idKey(item.id));
            assert.ok(native, item.key);
            const values = Object.fromEntries(columns.filter(column => !['Id', 'ParentId', 'TopParentId', 'Path', 'Data'].includes(column.name))
              .map(column => [column.name, column.clrType.replace('?', '') === 'long' && native[column.name] != null
                ? BigInt(native[column.name]) : native[column.name]]));
            const data = { ...(item.data ?? {}) };
            if (item.type === 'CollectionFolder') data.PhysicalLocationsList = data.PhysicalFolderIds
              .map(id => itemPath(fixture.items.find(child => child.id === id)));
            assert.equal(await database.update('BaseItems', { Id: item.id.toUpperCase() },
              { ...values, Path: itemPath(item), Data: JSON.stringify(data) }), 1n, item.key);
          }
          for (const data of fixture.userData) {
            const item = fixture.items.find(row => row.key === data.itemKey);
            await database.insert('UserData', { ItemId: item.id, UserId: user.Id, CustomDataKey: item.id,
              AudioStreamIndex: null, IsFavorite: data.isFavorite, LastPlayedDate: data.lastPlayedDate,
              Likes: null, PlayCount: data.played ? 1 : 0, PlaybackPositionTicks: BigInt(data.positionTicks),
              Played: data.played, Rating: null, RetentionDate: null, SubtitleStreamIndex: null });
          }
        },
        prepareCase: async ({ testCase, runtime }) => {
          if (!testCase.serverConfiguration) return;
          // The configuration HTTP controller is not implemented. Apply and
          // verify the same runtime input without claiming that setup API.
          Object.assign(runtime.configuration, testCase.serverConfiguration);
          runtime.localization.serverCulture = testCase.serverConfiguration.UICulture;
          assert.equal(runtime.configuration.UICulture, testCase.serverConfiguration.UICulture);
          assert.equal(runtime.localization.serverCulture, testCase.serverConfiguration.UICulture);
        },
      });
    } catch (error) {
      {
        await mkdir(output, { recursive: true });
        await writeFile(path.join(output, `${dialect}-failure.json`), JSON.stringify({
          passed: false, phaseAcceptance: false, completeResponsesCaptured: false, dialect,
          error: { name: error.name, message: error.message, stack: error.stack },
        }, null, 2) + '\n', { flag: 'wx' });
      }
      throw error;
    }
    const differences = [];
    const check = (name, scope, operation) => {
      try { operation(); } catch (error) { differences.push({ name, scope, message: error.message }); }
    };
    const mappedIds = new Map(['movies', 'tvshows'].map(type => [rootViewId(fixture.userId, type), rootViewId(actual.userId, type)]));
    for (const row of nativeNewRows(stages.afterReads.database.baseItems).filter(row => row.Data && JSON.parse(row.Data).UserId)) {
      assert.equal(rootViewId(fixture.userId, JSON.parse(row.Data).ViewType), idKey(row.Id));
    }
    const originalIds = new Set(actual.beforeReads.BaseItems.map(row => idKey(row.Id)));
    const newRows = rows => rows.filter(row => !originalIds.has(idKey(row.Id)));
    const compareStage = (name, candidate, native, { final = false } = {}) => {
      check(name, 'original media rows unchanged', () => assert.deepEqual(candidate.database.BaseItems
        .filter(row => originalIds.has(idKey(row.Id))), actual.beforeReads.BaseItems));
      for (const key of Object.keys(actual.beforeReads).filter(key => key !== 'BaseItems')) {
        check(name, `${key} unchanged`, () => assert.deepEqual(candidate.database[key], actual.beforeReads[key]));
      }
      check(name, 'UserData unchanged', () => assert.deepEqual(candidate.userData, actual.userDataBeforeReads));
      check(name, 'complete new view rows', () => assert.deepEqual(stable(newRows(candidate.database.BaseItems))
        .map(row => rowContract(row, actual.userId, new Map(), final)), stable(nativeNewRows(native.database.baseItems))
        .map(row => rowContract(row, fixture.userId, mappedIds, final)).sort((a, b) => a.Id.localeCompare(b.Id, 'en'))));
      for (const row of newRows(candidate.database.BaseItems)) check(name, `pending/derived refresh fields ${row.Id}`, () => {
        assert.ok(row.DateCreated);
        dateTicks(row.DateCreated);
        if (row.DateModified != null) dateTicks(row.DateModified);
        if (row.PresentationUniqueKey != null) assert.equal(row.PresentationUniqueKey, idKey(row.Id));
        if (row.DateLastRefreshed != null) {
          assert.equal(row.DateModified, null);
          assert.equal(row.PresentationUniqueKey, idKey(row.Id));
        }
      });
      for (const domain of ['userViews', 'libraries', 'collections']) {
        check(name, `${domain} unchanged`, () => assert.deepEqual(candidate.filesystemDomains[domain], actual.filesystemDomainsBeforeReads[domain]));
      }
      const normalizedFilesystem = native.filesystem.metadata.entries.map(entry => ({ ...entry,
        path: entry.path.replace(/views\/([a-f0-9]{32})$/iu, (_match, id) => 'views/' + (mappedIds.get(idKey(id)) ?? idKey(id))) }))
        .sort((a, b) => a.path.localeCompare(b.path, 'en'));
      check(name, 'complete metadata directory tree', () => assert.deepEqual(candidate.filesystem, normalizedFilesystem));
      if (final) for (const row of newRows(candidate.database.BaseItems)) check(name, `actual creation/refresh/save dates ${row.Id}`, () => {
        if (row.Type.endsWith('.Genre')) {
          assert.ok(row.DateCreated && row.DateModified);
          assert.ok(dateTicks(row.DateCreated) <= dateTicks(row.DateModified));
          assert.equal(row.DateLastRefreshed, null); assert.equal(row.DateLastSaved, null); assert.equal(row.Data, null);
          return;
        }
        assert.equal(row.DateModified, null);
        for (const key of ['DateCreated', 'DateLastRefreshed', 'DateLastSaved']) assert.ok(row[key], key);
        assert.ok(dateTicks(row.DateCreated) <= dateTicks(row.DateLastRefreshed));
        assert.ok(dateTicks(row.DateLastRefreshed) <= dateTicks(row.DateLastSaved));
        assert.equal(dateText(JSON.parse(row.Data).DateLastSaved), dateText(row.DateLastSaved));
      });
    };
    check('matrix', 'response and snapshot counts', () => {
      assert.equal(actual.httpCases, scenario.responses);
      assert.equal(actual.caseStages.length, scenario.responses);
      assert.equal(actual.cases.filter(item => item.policyReadback?.IsAdministrator === true).length, fixture.cases.filter(item => item.policy.IsAdministrator).length);
      assert.equal(actual.cases.filter(item => item.policyReadback?.IsAdministrator === false).length, fixture.cases.filter(item => !item.policy.IsAdministrator).length);
    });
    for (const item of actual.cases) {
      const records = http.records.filter(record => record.name === item.name);
      for (const [index, endpoint] of item.endpoints.entries()) check(item.name, endpoint.endpoint + ': complete HTTP response', () => {
        const native = records[index];
        assert.equal(endpoint.endpoint, native.endpoint);
        assert.equal(endpoint.response.status, native.response.status);
        assert.equal(endpoint.response.contentType, native.response.contentType);
        if (native.response.status < 400) assert.deepEqual(normalizeBody(endpoint.response.body), normalizeBody(native.response.bodyJson));
        else assert.equal(endpoint.response.bodyText, native.response.bodyText.replaceAll('CoreFlowAdmin', 'FilterAdmin'));
        // The frozen ExceptionMiddleware logs the eight empty GenreIds
        // failures. The candidate observer is recorded separately from the
        // exact HTTP body and must report one matching diagnostic per failure.
        assert.deepEqual(endpoint.runtimeErrors, native.response.status === 400
          ? [{ name: 'Error', message: 'Error processing request.' }] : []);
      });
    }
    for (const [index, item] of actual.caseStages.entries()) {
      const native = nativeCaseStages[index];
      check(item.name, 'endpoint stage identity', () => assert.deepEqual([item.name, item.endpoint], [native.name, native.endpoint]));
      for (const stage of ['before', 'after']) compareStage(`${item.name}:${item.endpoint}:${stage}`, item[stage], native[stage]);
    }
    compareStage('afterReads', { database: actual.afterReads, userData: actual.userDataAfterReads,
      filesystem: actual.filesystemAfterReads, filesystemDomains: actual.filesystemDomainsAfterReads }, stages.afterReads, { final: true });
    compareStage('afterShutdown', { database: actual.afterShutdown, userData: actual.userDataAfterShutdown,
      filesystem: actual.filesystemAfterShutdown, filesystemDomains: actual.filesystemDomainsAfterShutdown }, stages.afterShutdown, { final: true });
    check('shutdown', 'complete media and UserData state after all hosts stopped', () => {
      assert.deepEqual(actual.afterShutdown, actual.afterReads);
      assert.deepEqual(actual.userDataAfterShutdown, actual.userDataAfterReads);
    });
    check('shutdown', 'complete metadata tree and other directories', () => assert.deepEqual(actual.filesystemDomainsAfterShutdown, actual.filesystemDomainsAfterReads));
    check('cleanup', 'resource ownership', () => assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true,
      portReleased: true, postgresSchemasRemoved: dialect === 'postgres' ? true : null, programDataDirectoryRemoved: true }));
    check('runtime', 'unexpected errors', () => {
      assert.deepEqual(actual.runtimeErrors, []);
      assert.deepEqual(actual.handledExpectedRuntimeErrors, []);
    });
    {
      await writeHttpEndpointEvidence(output, dialect, actual, {
        passed: differences.length === 0, phaseAcceptance: false, dialect, responses: scenario.responses, endpointSnapshots: scenario.responses,
        newRows: newRows(actual.afterReads.BaseItems).length,
        fixtureSha256: summary.fixtureSha256,
        harnessSha256: sha256(await readFile(new URL('./item-filter-http-scenario.js', import.meta.url))),
        testSha256: sha256(await readFile(new URL(import.meta.url))),
        nativeProjectionSha256: scenario.sha256,
        nativeDiagnostics: { logSha256: contract.sourceBindings.find(binding => binding.path.endsWith('/reference-stdout.log')).sha256, events: nativeRequestErrors.length,
          source: 'ExceptionMiddleware logs ArgumentException from LibraryManager.GetItemById for empty GenreIds.',
          candidateObserver: 'One exact Error processing request diagnostic per confirmed HTTP 400; every other endpoint has none. Raw native log and candidate runtimeErrors are preserved.' },
        comparedFields: 'Full list JSON/status/content type/exact errors, including repeated shared Genre view identities; per-endpoint complete new Genre/UserView rows and metadata tree. Projector verified unchanged original native BaseItems, AncestorIds, LinkedChildren, ItemValues/Map, BaseItemImageInfos, BaseItemProviders, BaseItemMetadataFields, Peoples/PeopleBaseItemMap, UserData and userViews/libraries/collections at every raw state. Candidate additionally verifies unchanged MediaStreamInfos and ApiKeys. Actual final date invariants; shutdown state after all hosts stopped before connection close; cleanup.',
        normalization: 'Isolated ServerId/account name and two explicitly derived user-bound root identities only. GUID casing, native boolean representation and path separators follow storage contracts. New-row DateCreated, DateModified, DateLastRefreshed, DateLastSaved and Data.DateLastSaved retain raw observations. Genre creation/modification dates are checked for valid chronological order, and its Data/refreshed/saved fields remain exact null. UserView creation/refreshed/saved dates are checked for final validity/order/Data equality; final DateModified remains exact null. Intermediate PresentationUniqueKey retains raw pending/refreshed observations and must satisfy actual derived-key invariants; final value is exact. Shared menu IDs, all other fields, names, list duplicates/order/count and paging are exact. Refresh failure/cancellation/concurrency are not proven.',
        cultureSetup: 'Four server-culture changes apply equivalent runtime configuration directly and verify readback; the server configuration HTTP controller is not validated.',
        native: summary, differences,
      });
    }
    assert.equal(differences.length, 0, JSON.stringify(differences.slice(0, 3)));
  });
}
}
