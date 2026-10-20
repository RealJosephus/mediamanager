import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { getNewItemId } from '../../src/core/identity.js';
import { tableDefinition } from '../../src/database/model.js';
import { dateText, dateTicks, idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';

import { currentUserViewScenario, candidateCasesFromTrackedInput, userViewEvidenceJson } from '../helpers/current-user-view-scenario.js';

const fixtureBytes = await readFile(new URL('./fixtures/user-view-menu/input.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const dialects = process.env.MEDIAMANAGER_USER_VIEW_MENU_DIALECT
  ? [process.env.MEDIAMANAGER_USER_VIEW_MENU_DIALECT] : ['postgres'];
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
const dynamicDates = new Set(['DateCreated', 'DateLastRefreshed', 'DateLastSaved']);

function rowContract(row, userId, userViewIds, final) {
  const mappedId = value => userViewIds.get(idKey(value)) ?? idKey(value);
  const data = JSON.parse(row.Data);
  delete data.DateLastSaved;
  if (data.UserId) {
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
  test(`${dialect}: nonrecursive movie/TV menus match 196 full HTTP responses and 28 persisted view lifecycles`, {
    skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE, timeout: 300000,
  }, async () => {
    const { http, stages, caseStages: nativeCaseStages, summary, root: nativeEvidenceRoot } = await currentUserViewScenario('user-view-menu', fixtureBytes);
    const nativeOriginalIds = new Set(stages.before.database.baseItems.map(row => idKey(row.Id)));
    const nativeNewRows = rows => rows.filter(row => !nativeOriginalIds.has(idKey(row.Id)));
    assert.equal(nativeNewRows(stages.afterReads.database.baseItems).length, 28);

    let actual;
    try {
      actual = await recordItemFilterCandidate({
        dialect, fixture: { ...fixture, cases: candidateCasesFromTrackedInput(fixture) },
        connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
        scenarioName: 'user-view-menu', fields: 'SortName', captureOrder: true, captureStartIndex: true,
        captureSortNames: true, captureResponseBodies: true, captureCaseRuntimeErrors: true,
        trackUserData: true, trackFilesystem: true, captureEndpointStages: true, captureFilesystemDomains: true,
        configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
        prepareScenario: async ({ database, programDataPath, user, users }) => {
          const control = await users.createUser({ Name: 'OracleControlAdmin', Password: 'control password' });
          const controlState = await users.getUser(control.Id);
          await users.updatePolicy(control.Id, { ...controlState.Policy, IsAdministrator: true });
          assert.equal((await database.rows('Permissions')).filter(row => row.Kind === 0 && row.Value).length, 2);
          const paths = { userRoot: path.join(programDataPath, 'root/default'), playlists: path.join(programDataPath, 'playlists') };
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
            const native = stages.before.database.baseItems.find(row => idKey(row.Id) === idKey(item.id));
            assert.ok(native, item.key);
            const values = Object.fromEntries(columns.filter(column => !['Id', 'ParentId', 'TopParentId', 'Path', 'Data'].includes(column.name))
              .map(column => [column.name, column.clrType.replace('?', '') === 'long' && native[column.name] != null
                ? BigInt(native[column.name]) : native[column.name]]));
            const data = { ...(item.data ?? {}) };
            if (item.type === 'CollectionFolder') data.PhysicalLocationsList = data.PhysicalFolderIds
              .map(id => itemPath(fixture.items.find(child => child.id === id)));
            await database.update('BaseItems', { Id: item.id.toUpperCase() }, { ...values, Path: itemPath(item), Data: JSON.stringify(data) });
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
      if (nativeEvidenceRoot) {
        const output = process.env.MEDIAMANAGER_USER_VIEW_MENU_EVIDENCE ? path.resolve(process.env.MEDIAMANAGER_USER_VIEW_MENU_EVIDENCE) : nativeEvidenceRoot;
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
    for (const row of nativeNewRows(stages.afterReads.database.baseItems).filter(row => JSON.parse(row.Data).UserId)) {
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
        for (const key of dynamicDates) assert.ok(row[key], key);
        assert.ok(dateTicks(row.DateCreated) <= dateTicks(row.DateLastRefreshed));
        assert.ok(dateTicks(row.DateLastRefreshed) <= dateTicks(row.DateLastSaved));
        assert.equal(dateText(JSON.parse(row.Data).DateLastSaved), dateText(row.DateLastSaved));
      });
    };
    check('matrix', 'response and snapshot counts', () => {
      assert.equal(actual.httpCases, 196);
      assert.equal(actual.caseStages.length, 196);
      assert.equal(actual.cases.filter(item => item.policyReadback?.IsAdministrator === true).length, 54);
      assert.equal(actual.cases.filter(item => item.policyReadback?.IsAdministrator === false).length, 46);
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
        assert.deepEqual(endpoint.runtimeErrors, []);
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
    if (nativeEvidenceRoot) {
      const output = process.env.MEDIAMANAGER_USER_VIEW_MENU_EVIDENCE ? path.resolve(process.env.MEDIAMANAGER_USER_VIEW_MENU_EVIDENCE) : nativeEvidenceRoot;
      await mkdir(output, { recursive: true });
      const json = userViewEvidenceJson;
      await writeFile(path.join(output, `${dialect}.json`), json(actual), { flag: 'wx' });
      await writeFile(path.join(output, `${dialect}-comparison.json`), json({
        passed: differences.length === 0, phaseAcceptance: false, dialect, responses: 196, endpointSnapshots: 196,
        newRows: newRows(actual.afterReads.BaseItems).length,
        fixtureSha256: summary.fixtureSha256,
        harnessSha256: sha256(await readFile(validationFileUrl('./item-filter-http-scenario.js', import.meta.url))),
        testSha256: sha256(await readFile(validationFileUrl(import.meta.url))),
        comparedFields: 'Full list JSON/status/content type/exact errors; per-endpoint creation and names in complete new BaseItems rows; original media tables including providers/locked fields, UserData and three directory domains unchanged; complete metadata tree; actual final date invariants; shutdown state after all hosts stopped before native connection close; cleanup.',
        normalization: 'Isolated ServerId/account name and two explicitly derived user-bound root identities only. GUID casing, native boolean representation and path separators follow storage contracts. Three new-row dates and Data.DateLastSaved retain raw observations but are compared by final validity/order/equality, not wall-clock equality. Intermediate DateModified and PresentationUniqueKey retain raw pending/refreshed observations and must satisfy the actual derived-key/refreshed invariants; final values are compared exactly. Shared menu IDs, other columns, names, order, count and paging are exact. Asynchronous refresh timing and metadata-provider failure/cancellation are not proven.',
        cultureSetup: 'Eight server-culture changes apply equivalent runtime configuration directly and verify readback; the unimplemented server configuration HTTP controller is not validated.',
        native: summary, differences,
      }), { flag: 'wx' });
    }
    assert.equal(differences.length, 0, JSON.stringify(differences.slice(0, 3)));
  });
}
