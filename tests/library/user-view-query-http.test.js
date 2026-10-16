import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { nativeQueryExecutables } from './native-query-default-inputs.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tableDefinition } from '../../src/database/model.js';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { assertUserViewEvidenceProvenance, assertUserViewNativeEvidence,
  candidateCasesFromTrackedInput } from './user-view-native-evidence.js';

const evidenceRoot = validationFileUrl('../../.agent-docs/evidence/user-view-inputs/user-view-query-native-v1/', import.meta.url);
const evidence = validationFileUrl('native-run-v4/', evidenceRoot);
const fixtureUrl = validationFileUrl('./fixtures/user-view-query/input.json', import.meta.url);
const fixtureBytes = await readFile(fixtureUrl);
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const http = JSON.parse(await readFile(validationFileUrl('native-http.json', evidence), 'utf8'));
const setup = JSON.parse(await readFile(validationFileUrl('setup-http.json', evidence), 'utf8'));
const stages = JSON.parse(await readFile(validationFileUrl('stages.json', evidence), 'utf8'));
const caseStages = JSON.parse(await readFile(validationFileUrl('case-stages.json', evidence), 'utf8'));
const summary = JSON.parse(await readFile(validationFileUrl('summary.json', evidence), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(summary.passed, true);
assert.equal(summary.cases, 260);
assert.deepEqual(summary.processResult, { code: 0, signal: null });
assert.equal(summary.portAvailable, true);
assert.equal(sha256(await readFile(validationFileUrl('../record-native.mjs', evidence))), summary.recorderSha256);
// The native input stays byte-exact. The tracked fixture removes only its
// extra terminal LF blank line, without changing any preceding byte or value.
const recordedFixtureBytes = await readFile(validationFileUrl('input.json', evidence));
assert.equal(sha256(recordedFixtureBytes), summary.fixtureSha256);
assert.equal(recordedFixtureBytes.length, fixtureBytes.length + 1);
assert.equal(recordedFixtureBytes.at(-1), 10);
assert.deepEqual(recordedFixtureBytes.subarray(0, -1), fixtureBytes);
assert.deepEqual(fixture, JSON.parse(recordedFixtureBytes.toString('utf8')));
assert.deepEqual(stages.before, stages.afterReads);
assert.deepEqual(stages.before, stages.afterShutdown);
assert.deepEqual(stages.before.database.foreignKeyCheck, []);
assert.equal(stages.before.database.userData.length, fixture.userData.length);
await assertUserViewEvidenceProvenance({
  evidence,
  scenario: 'user-view-query',
  sourceRecorder: validationFileUrl('../../tools/compat/record-user-view-http.js', import.meta.url),
  jellyfinDll: nativeQueryExecutables.jellyfinDll,
  fixtureUserId: fixture.userId,
});
assertUserViewNativeEvidence({ fixture, http, setup, stages, caseStages, menuLifecycle: false });

test('user-view-query evidence gate rejects corrupted status, body, and case controls', () => {
  const first = http.records[0];
  const status = first.response.status;
  first.response.status = 500;
  assert.throws(() => assertUserViewNativeEvidence({ fixture, http, setup, stages, caseStages, menuLifecycle: false }), /status comes from tracked input/u);
  first.response.status = status;
  const bodyText = first.response.bodyText;
  first.response.bodyText = '{}';
  assert.throws(() => assertUserViewNativeEvidence({ fixture, http, setup, stages, caseStages, menuLifecycle: false }), /parsed and raw bodies must agree/u);
  first.response.bodyText = bodyText;
  const endpoint = caseStages[0].endpoint;
  caseStages[0].endpoint = 'legacy';
  assert.throws(() => assertUserViewNativeEvidence({ fixture, http, setup, stages, caseStages, menuLifecycle: false }), /case stage identity/u);
  caseStages[0].endpoint = endpoint;
});

const dialects = process.env.MEDIAMANAGER_USER_VIEW_QUERY_DIALECT
  ? [process.env.MEDIAMANAGER_USER_VIEW_QUERY_DIALECT] : ['postgres'];
if (dialects.some(dialect => !['postgres'].includes(dialect))) throw new Error('Invalid UserView query dialect.');
const columns = tableDefinition('BaseItems').columns;
const normalizeBody = value => Array.isArray(value) ? value.map(normalizeBody)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'traceId').map(([key, entry]) => [key, key === 'ServerId' ? '$server' : normalizeBody(entry)])) : value;
const cases = candidateCasesFromTrackedInput(fixture);

for (const dialect of dialects) {
  test(`${dialect}: UserView query dispatch matches 260 frozen full HTTP list responses`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({
      dialect, fixture: { ...fixture, cases }, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'user-view-query', fields: 'SortName', captureOrder: true, captureStartIndex: true,
      captureSortNames: true, captureResponseBodies: true, captureCaseRuntimeErrors: true, trackUserData: true, trackFilesystem: true,
      configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
      prepareScenario: async ({ database, programDataPath, user }) => {
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
          if (native.response.status < 400) assert.deepEqual(normalizeBody(endpoint.response.body), normalizeBody(native.response.bodyJson));
          else assert.equal(endpoint.response.bodyText, native.response.bodyText);
          assert.deepEqual(endpoint.runtimeErrors, native.response.status >= 400
            ? [{ name: 'Error', message: 'Error processing request.' }] : []);
        } catch (error) { differences.push({ name: item.name, endpoint: endpoint.endpoint, message: error.message }); }
      }
    }
    if (process.env.MEDIAMANAGER_USER_VIEW_QUERY_EVIDENCE) {
      const output = path.resolve(process.env.MEDIAMANAGER_USER_VIEW_QUERY_EVIDENCE);
      await mkdir(output, { recursive: true });
      const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
      await writeFile(path.join(output, `${dialect}.json`), json(actual), { flag: 'wx' });
      await writeFile(path.join(output, `${dialect}-comparison.json`), json({
        passed: differences.length === 0, phaseAcceptance: false, dialect, responses: http.records.length,
        comparedFields: 'Complete successful list JSON, status, content type and exact error body; all target media tables, metadata tree and UserData rows unchanged.',
        normalization: 'ServerId maps isolated server identities; only ProblemDetails traceId is removed. No item identities, order, fields, counts, paging or business state are normalized.',
        native: summary, differences,
      }), { flag: 'wx' });
    }
    assert.deepEqual(actual.afterReads, actual.beforeReads);
    assert.deepEqual(actual.userDataAfterReads, actual.userDataBeforeReads);
    assert.deepEqual(actual.filesystemAfterReads, actual.filesystemBeforeReads);
    assert.deepEqual(actual.filesystemAfterShutdown, actual.filesystemBeforeReads);
    assert.deepEqual(actual.runtimeErrors, []);
    assert.deepEqual(actual.handledExpectedRuntimeErrors, []);
    assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true, portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null, programDataDirectoryRemoved: true });
    assert.deepEqual(differences, []);
  });
}
