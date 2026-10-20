import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tableDefinition } from '../../src/database/model.js';
import { idKey, dateText } from '../../src/library/records.js';
import { recordItemFilterCandidate, validateFixture } from './item-filter-http-scenario.js';

import { currentUserViewScenario, candidateCasesFromTrackedInput, userViewEvidenceJson } from '../helpers/current-user-view-scenario.js';

const fixtureBytes = await readFile(new URL('./fixtures/studios-http/input.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes);
validateFixture(fixture);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const dialects = process.env.MEDIAMANAGER_USER_VIEW_QUERY_DIALECT
  ? [process.env.MEDIAMANAGER_USER_VIEW_QUERY_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid UserView query dialect.');
const columns = tableDefinition('BaseItems').columns;
const normalizeStudioPath = value => {
  assert.match(value, /[\\/]metadata[\\/]Studio[\\/]/u);
  return '$programData/metadata/Studio/' + value.split(/[\\/]metadata[\\/]Studio[\\/]/u)[1].replaceAll('\\', '/');
};
const normalizeBody = value => Array.isArray(value) ? value.map(normalizeBody)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'traceId').map(([key, entry]) => [key, key === 'ServerId' ? '$server' : key === 'Path' && typeof entry === 'string' ? normalizeStudioPath(entry) : ['DateCreated', 'DateLastSaved', 'DateLastRefreshed', 'DateLastMediaAdded'].includes(key) && typeof entry === 'string' ? dateText(entry) : normalizeBody(entry)])) : value;
const cases = candidateCasesFromTrackedInput(fixture);

for (const dialect of dialects) {
  test(`${dialect}: studio list and name APIs match 44 current native full HTTP responses`, {
    skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE, timeout: 300000,
  }, async () => {
    const { http, stages, caseStages: nativeCaseStages, summary, root: nativeEvidenceRoot } = await currentUserViewScenario('studios-http', fixtureBytes);

    const actual = await recordItemFilterCandidate({
      dialect, fixture: { ...fixture, cases }, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'studios-http', fields: 'SortName', captureOrder: true, captureStartIndex: true,
      captureSortNames: true, captureResponseBodies: true, captureCaseRuntimeErrors: true, trackUserData: true, trackFilesystem: true,
      captureShutdownState: true,
      configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
      prepareScenario: async ({ database, programDataPath, user }) => {
        const paths = { userRoot: path.join(programDataPath, 'root/default'), playlists: path.join(programDataPath, 'data/playlists') };
        for (const letter of ['A', 'B', 'T', 'K', 'M']) {
          paths['physical' + letter] = path.join(programDataPath, 'library-content', letter);
          paths['library' + letter] = path.join(programDataPath, 'root/default', 'Library ' + letter);
        }
        const itemPath = item => item.pathKind === 'studio' ? path.join(programDataPath, 'metadata/Studio', item.name) : paths[item.pathKind] ?? (item.pathKind === 'view'
          ? path.join(programDataPath, 'metadata/views', idKey(item.id))
          : item.pathKind === 'child' ? path.join(itemPath(fixture.items.find(row => row.id === item.parentId)),
            item.key + (item.type === 'Movie' ? '.mkv' : '')) : path.join(paths.physicalA, item.key));
        for (const item of fixture.items) {
          if (item.type === 'AggregateFolder') continue;
          const native = stages.before.database.baseItems.find(row => idKey(row.Id) === idKey(item.id));
          assert.ok(native, item.key);
          if (item.type === 'CollectionFolder') {
            assert.equal(JSON.parse(native.Data).CollectionType, item.data.CollectionType, item.key);
            await mkdir(itemPath(item), { recursive: true });
            if (item.data.CollectionType != null) {
              await writeFile(path.join(itemPath(item), `${item.data.CollectionType}.collection`), '', { flag: 'wx' });
            }
          }
          // Import the frozen repository's complete column values, not inferred
          // DTO defaults. Only physical paths differ between isolated runtimes.
          const values = Object.fromEntries(columns.filter(column => !['Id', 'ParentId', 'TopParentId', 'Path', 'Data'].includes(column.name))
            .map(column => [column.name, column.clrType.replace('?', '') === 'long' && native[column.name] != null
              ? BigInt(native[column.name]) : native[column.name]]));
          const data = { ...(item.data ?? {}) };
          if (item.type === 'Studio') await mkdir(itemPath(item), { recursive: true });
          if (item.type === 'CollectionFolder') data.PhysicalLocationsList = data.PhysicalFolderIds
            .map(id => itemPath(fixture.items.find(child => child.id === id)));
          await database.update('BaseItems', { Id: item.id.toUpperCase() }, { ...values, Path: itemPath(item), Data: JSON.stringify(data) });
        }
        for (const data of fixture.userData) {
          const item = fixture.items.find(row => row.key === data.itemKey);
          await database.insert('UserData', { ItemId: item.id.toUpperCase(), UserId: user.Id, CustomDataKey: item.id,
            AudioStreamIndex: null, IsFavorite: data.isFavorite, LastPlayedDate: data.lastPlayedDate,
            Likes: null, PlayCount: data.played ? 1 : 0, PlaybackPositionTicks: BigInt(data.positionTicks),
            Played: data.played, Rating: null, RetentionDate: null, SubtitleStreamIndex: null });
        }
      },
    });
    const differences = [];
    assert.equal(actual.httpCases, http.records.length);
    for (const item of actual.cases) {
      const records = http.records.filter(record => record.name === item.name);
      for (const [index, endpoint] of item.endpoints.entries()) {
        const native = records[index];
        try {
          assert.equal(endpoint.endpoint, native.endpoint);
          assert.equal(endpoint.response.status, native.response.status);
          assert.equal(endpoint.response.contentType, native.response.contentType);
          if (native.response.status < 400 || native.response.bodyJson !== undefined) assert.deepEqual(normalizeBody(endpoint.response.body), normalizeBody(native.response.bodyJson));
          else assert.equal(endpoint.response.bodyText, native.response.bodyText);
          assert.deepEqual(endpoint.runtimeErrors, native.response.status >= 400 && !fixture.cases.find(testCase => testCase.name === item.name).bindingError
            ? [{ name: 'Error', message: 'Error processing request.' }] : []);
        } catch (error) { differences.push({ name: item.name, endpoint: endpoint.endpoint, message: error.message }); }
      }
    }
    if (nativeEvidenceRoot) {
      const output = process.env.MEDIAMANAGER_USER_VIEW_QUERY_EVIDENCE ? path.resolve(process.env.MEDIAMANAGER_USER_VIEW_QUERY_EVIDENCE) : nativeEvidenceRoot;
      await mkdir(output, { recursive: true });
      const json = userViewEvidenceJson;
      await writeFile(path.join(output, `${dialect}.json`), json(actual), { flag: 'wx' });
      await writeFile(path.join(output, `${dialect}-comparison.json`), json({
        passed: differences.length === 0, phaseAcceptance: false, dialect, responses: http.records.length,
        comparedFields: 'Complete successful list/detail JSON, status, content type and exact error body; all target media tables, metadata tree and UserData rows unchanged.',
        normalization: 'ServerId maps isolated server identities; only ProblemDetails traceId is removed, declared date fields use their full UTC 100 ns values, and Studio Path retains its relative target under each owned program root. No item identities, order, fields, counts, paging or business state are normalized.',
        native: summary, differences,
      }), { flag: 'wx' });
    }
    assert.deepEqual(actual.afterReads, actual.beforeReads);
    assert.deepEqual(actual.afterShutdown, actual.beforeReads);
    assert.deepEqual(actual.userDataAfterReads, actual.userDataBeforeReads);
    assert.deepEqual(actual.userDataAfterShutdown, actual.userDataBeforeReads);
    assert.deepEqual(actual.filesystemAfterReads, actual.filesystemBeforeReads);
    assert.deepEqual(actual.filesystemAfterShutdown, actual.filesystemBeforeReads);
    assert.deepEqual(actual.runtimeErrors, []);
    assert.deepEqual(actual.handledExpectedRuntimeErrors, []);
    assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true, portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null, programDataDirectoryRemoved: true });
    assert.deepEqual(differences, []);
  });
}
