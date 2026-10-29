import test from 'node:test';
import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { tableDefinition } from '../../src/database/model.js';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { projectItemBody } from '../helpers/http-body-projection.js';

import { currentUserViewScenario, candidateCasesFromTrackedInput, userViewEvidenceJson } from '../helpers/current-user-view-scenario.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE) });

const fixtureBytes = await readFile(new URL('./fixtures/user-root-visibility/input.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const dialects = process.env.MEDIAMANAGER_USER_ROOT_VISIBILITY_DIALECT
  ? [process.env.MEDIAMANAGER_USER_ROOT_VISIBILITY_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid Library-own visibility and ordinary-user query dialect.');
const columns = tableDefinition('BaseItems').columns;
const normalizeBody = (value, serverId) => projectItemBody(value, { serverId, date: value => value });
const cases = candidateCasesFromTrackedInput(fixture).map(item => {
  item = { ...item };
  // The native wire omits ParentId; its otherwise stored parentKey is inert.
  if (item.omitParentId) delete item.parentKey;
  return item;
});

for (const dialect of dialects) {
  test(`${dialect}: Library-own visibility and ordinary-user query dispatch matches 256 current native full HTTP list responses`, {
    skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE, timeout: 300000,
  }, nativeCallback(async t => {
    const { http, stages, caseStages: nativeCaseStages, summary, root: nativeEvidenceRoot, nativeServerId } = await currentUserViewScenario('user-root-visibility', fixtureBytes, { signal: t.signal });

    let actual;
    try { actual = await recordItemFilterCandidate({
      dialect, fixture: { ...fixture, cases }, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'user-root-visibility', fields: 'SortName', captureOrder: true, captureStartIndex: true,
      captureSortNames: true, captureResponseBodies: true, captureCaseRuntimeErrors: true, trackUserData: true, trackFilesystem: true,
      captureShutdownState: true,
      configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
      prepareScenario: async ({ database, programDataPath, user, users }) => {
        // The frozen seed has another administrator. Keep that invariant when
        // demoting the target account; do not bypass the last-admin guard.
        const control = await users.createUser({ Name: 'OracleControlAdmin', Password: 'control password' });
        const controlState = await users.getUser(control.Id);
        await users.updatePolicy(control.Id, { ...controlState.Policy, IsAdministrator: true });
        assert.equal((await database.rows('Permissions')).filter(row => row.Kind === 0 && row.Value).length, 2);
        const paths = { userRoot: path.join(programDataPath, 'root/default'), playlists: path.join(programDataPath, 'data/playlists') };
        for (const letter of ['A', 'B', 'T', 'K', 'M']) {
          paths['physical' + letter] = path.join(programDataPath, 'library-content', letter);
          paths['library' + letter] = path.join(programDataPath, 'root/default', 'Library ' + letter);
        }
        const itemPath = item => paths[item.pathKind] ?? (item.pathKind === 'view'
          ? path.join(programDataPath, 'metadata/views', idKey(item.id))
          : item.pathKind === 'child' ? path.join(itemPath(fixture.items.find(row => row.id === item.parentId)),
            item.key + (item.type === 'Movie' ? '.mkv' : '')) : path.join(paths.physicalA, item.key));
        for (const item of fixture.items) {
          if (item.type === 'AggregateFolder') continue;
          const native = stages.before.database.baseItems.find(row => idKey(row.Id) === idKey(item.id));
          assert.ok(native, item.key);
          // Import the frozen repository's complete column values, not inferred
          // DTO defaults. Only physical paths differ between isolated runtimes.
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
    });
    } catch (error) {
      if (nativeEvidenceRoot) {
        const output = process.env.MEDIAMANAGER_USER_ROOT_VISIBILITY_EVIDENCE ? path.resolve(process.env.MEDIAMANAGER_USER_ROOT_VISIBILITY_EVIDENCE) : nativeEvidenceRoot;
        await mkdir(output, { recursive: true });
        await writeFile(path.join(output, `${dialect}-failure.json`), JSON.stringify({
          passed: false, phaseAcceptance: false, completeResponsesCaptured: false, dialect,
          fixtureSha256: summary.fixtureSha256,
          harnessSha256: sha256(await readFile(validationFileUrl('./item-filter-http-scenario.js', import.meta.url))),
          testSha256: sha256(await readFile(validationFileUrl(import.meta.url))),
          error: { name: error.name, message: error.message, stack: error.stack },
        }, null, 2) + '\n', { flag: 'wx' });
      }
      throw error;
    }
    const differences = [];
    assert.equal(actual.cases.filter(item => item.policyReadback?.IsAdministrator === false).length, 63);
    assert.equal(actual.cases.filter(item => item.policyReadback?.IsAdministrator === true).length, 67);
    assert.equal(actual.httpCases, http.records.length);
    for (const item of actual.cases) {
      const records = http.records.filter(record => record.name === item.name);
      for (const [index, endpoint] of item.endpoints.entries()) {
        const native = records[index];
        try {
          assert.equal(endpoint.endpoint, native.endpoint);
          assert.equal(endpoint.response.status, native.response.status);
          assert.equal(endpoint.response.contentType, native.response.contentType);
          if (native.response.status < 400) assert.deepEqual(normalizeBody(endpoint.response.body, actual.serverId), normalizeBody(native.response.bodyJson, nativeServerId));
          else assert.equal(endpoint.response.bodyText, native.response.bodyText.replaceAll('CoreFlowAdmin', 'FilterAdmin'));
        } catch (error) { differences.push({ name: item.name, endpoint: endpoint.endpoint, message: error.message }); }
      }
    }
    if (nativeEvidenceRoot) {
      const output = process.env.MEDIAMANAGER_USER_ROOT_VISIBILITY_EVIDENCE ? path.resolve(process.env.MEDIAMANAGER_USER_ROOT_VISIBILITY_EVIDENCE) : nativeEvidenceRoot;
      await mkdir(output, { recursive: true });
      const json = userViewEvidenceJson;
      await writeFile(path.join(output, `${dialect}.json`), json(actual), { flag: 'wx' });
      await writeFile(path.join(output, `${dialect}-comparison.json`), json({
        passed: differences.length === 0, phaseAcceptance: false, dialect, responses: http.records.length,
        comparedFields: 'Complete successful list JSON, status, content type and exact error body; all target media tables, metadata tree and UserData rows unchanged.',
        normalization: 'Declared DTO ServerId is bound to each actual isolated server; known HTTP error account name CoreFlowAdmin maps to FilterAdmin. Opaque dictionaries and unknown fields stay literal. No item identities, order, counts, paging or business state are normalized.',
        native: summary, differences,
      }), { flag: 'wx' });
    }
    assert.deepEqual(actual.afterReads, actual.beforeReads);
    assert.deepEqual(actual.afterShutdown, actual.afterReads);
    assert.deepEqual(actual.userDataAfterReads, actual.userDataBeforeReads);
    assert.deepEqual(actual.userDataAfterShutdown, actual.userDataAfterReads);
    assert.deepEqual(actual.filesystemAfterReads, actual.filesystemBeforeReads);
    assert.deepEqual(actual.filesystemAfterShutdown, actual.filesystemBeforeReads);
    assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true, portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null, programDataDirectoryRemoved: true });
    assert.deepEqual(differences, []);
  }));
}
