import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tableDefinition } from '../../src/database/model.js';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';

const fixtureBytes = await readFile(new URL('./fixtures/boxset-display-order/input.json', import.meta.url));
const nativeBytes = await readFile(new URL('./fixtures/boxset-display-order/native.json', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(nativeBytes), '33b12c5bd92af5471266b6e15ed7a2be7d05743596f538032274ff993a94f0e4');
const fixture = JSON.parse(fixtureBytes.toString('utf8')), native = JSON.parse(nativeBytes.toString('utf8'));
assert.equal(native.format, 1);
assert.equal(native.frozenJellyfin, true);
assert.equal(native.fixtureInputSha256, sha256(fixtureBytes));
assert.equal(native.summary.passed, true);
assert.equal(native.summary.cases, 169);
assert.equal(native.summary.portAvailable, true);
assert.deepEqual(native.summary.processResult, { code: 0, signal: null });
assert.equal(native.nativeStateInvariant.beforeEqualsAfterReadsEqualsAfterShutdown, true);
assert.equal(native.nativeStateInvariant.tableCounts.userData, 91);
assert.equal(native.seedBaseItems.length, 124);
assert.equal(native.http.records.length, 169);
assert.deepEqual(native.http.records.map(row => [row.name, row.endpoint]), fixture.cases
  .flatMap(item => (item.endpoints ?? ['items', 'legacy']).map(endpoint => [item.name, endpoint])));
assert.ok(native.http.records.every(row => row.response.status === 200));
const columns = tableDefinition('BaseItems').columns;
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'ServerId' ? '$server' : normalize(entry)])) : value;

for (const dialect of ['postgres']) {
  test(`${dialect}: 13 BoxSet display orders and request overrides match 169 complete frozen responses`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const actual = await recordItemFilterCandidate({ dialect, fixture, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'boxset-display-order', fields: 'SortName', captureOrder: true, captureStartIndex: true,
      captureSortNames: true, captureResponseBodies: true, captureEndpointStages: true,
      captureFilesystemDomains: true, trackFilesystem: true, trackUserData: true,
      configuration: { EnableGroupingMoviesIntoCollections: false, EnableGroupingShowsIntoCollections: false },
      prepareScenario: async ({ database, programDataPath, user }) => {
        const paths = { userRoot: path.join(programDataPath, 'root/default'), physicalA: path.join(programDataPath, 'library-content/A'),
          physicalB: path.join(programDataPath, 'library-content/B'), collections: path.join(programDataPath, 'data/collections'),
          libraryA: path.join(programDataPath, 'root/default/Library A'), libraryB: path.join(programDataPath, 'root/default/Library B'),
          collectionLibrary: path.join(programDataPath, 'root/default/Collection Library') };
        for (const value of Object.values(paths)) await mkdir(value, { recursive: true });
        const itemPath = item => paths[item.pathKind] ?? (item.pathKind === 'child'
          ? path.join(itemPath(fixture.items.find(row => row.id === item.parentId)), item.key + (item.type === 'Movie' ? '.mkv' : ''))
          : path.join(paths.physicalA, item.key));
        for (const item of fixture.items) {
          if (item.type === 'AggregateFolder') continue;
          const row = native.seedBaseItems.find(value => idKey(value.Id) === idKey(item.id));
          assert.ok(row, item.key);
          const values = Object.fromEntries(columns.filter(column => !['Id', 'ParentId', 'TopParentId', 'Path', 'Data'].includes(column.name))
            .map(column => [column.name, column.clrType.replace('?', '') === 'long' && row[column.name] != null
              ? BigInt(row[column.name]) : row[column.name]]));
          const data = { ...(item.data ?? {}) };
          if (item.type === 'CollectionFolder') data.PhysicalLocationsList = data.PhysicalFolderIds.map(id => itemPath(fixture.items.find(value => value.id === id)));
          assert.equal(await database.update('BaseItems', { Id: item.id.toUpperCase() },
            { ...values, Path: itemPath(item), Data: JSON.stringify(data) }), 1n, item.key);
        }
        for (const data of fixture.userData) {
          const item = fixture.items.find(row => row.key === data.itemKey);
          await database.insert('UserData', { ItemId: item.id, UserId: user.Id, CustomDataKey: item.id,
            AudioStreamIndex: null, IsFavorite: data.isFavorite, LastPlayedDate: data.lastPlayedDate,
            Likes: null, PlayCount: data.playCount, PlaybackPositionTicks: BigInt(data.positionTicks), Played: data.played,
            Rating: null, RetentionDate: null, SubtitleStreamIndex: null });
        }
      },
    });
    const differences = [];
    const check = (name, scope, operation) => { try { operation(); } catch (error) { differences.push({ name, scope, message: error.message }); } };
    check('matrix', 'response/snapshot counts', () => {
      assert.equal(actual.httpCases, 169); assert.equal(actual.caseStages.length, 169);
    });
    const flattened = actual.cases.flatMap(item => item.endpoints.map(endpoint => ({ name: item.name, ...endpoint })));
    for (const [index, endpoint] of flattened.entries()) check(endpoint.name, endpoint.endpoint + ': complete HTTP', () => {
      const expected = native.http.records[index];
      assert.deepEqual([endpoint.name, endpoint.endpoint], [expected.name, expected.endpoint]);
      assert.equal(endpoint.response.status, expected.response.status);
      assert.equal(endpoint.response.contentType, expected.response.contentType);
      assert.deepEqual(normalize(endpoint.response.body), normalize(expected.response.bodyJson));
    });
    for (const stage of actual.caseStages) for (const timing of ['before', 'after']) {
      check(stage.name + ':' + stage.endpoint + ':' + timing, 'candidate recorded media state', () => assert.deepEqual(stage[timing].database, actual.beforeReads));
      check(stage.name + ':' + stage.endpoint + ':' + timing, 'UserData', () => assert.deepEqual(stage[timing].userData, actual.userDataBeforeReads));
      check(stage.name + ':' + stage.endpoint + ':' + timing, 'four filesystem domains', () => assert.deepEqual(stage[timing].filesystemDomains, actual.filesystemDomainsBeforeReads));
    }
    check('shutdown', 'complete candidate state after all hosts stopped', () => {
      assert.deepEqual(actual.afterReads, actual.beforeReads); assert.deepEqual(actual.afterShutdown, actual.beforeReads);
      assert.deepEqual(actual.userDataAfterShutdown, actual.userDataBeforeReads);
      assert.deepEqual(actual.filesystemDomainsAfterShutdown, actual.filesystemDomainsBeforeReads);
    });
    check('runtime', 'errors', () => { assert.deepEqual(actual.runtimeErrors, []); assert.deepEqual(actual.handledExpectedRuntimeErrors, []); });
    check('cleanup', 'resource ownership', () => assert.deepEqual(actual.cleanup, { runtimeClosed: true, databaseClosed: true,
      portReleased: true, postgresSchemasRemoved: dialect === 'postgres' ? true : null, programDataDirectoryRemoved: true }));
    if (process.env.MEDIAMANAGER_BOXSET_DISPLAY_ORDER_EVIDENCE) {
      const output = path.resolve(process.env.MEDIAMANAGER_BOXSET_DISPLAY_ORDER_EVIDENCE);
      await mkdir(output, { recursive: true });
      const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
      await writeFile(path.join(output, `${dialect}.json`), json(actual), { flag: 'wx' });
      await writeFile(path.join(output, `${dialect}-comparison.json`), json({ passed: differences.length === 0,
        phaseAcceptance: false, dialect, responses: 169, endpointSnapshots: 169, nativeProjectionSha256: sha256(nativeBytes),
        fixtureSha256: sha256(fixtureBytes), testSha256: sha256(await readFile(new URL(import.meta.url))),
        comparedFields: 'Complete HTTP JSON/status/contentType with isolated ServerId normalization only; candidate per-endpoint recorded media tables/UserData/four filesystem domains unchanged, final post-host state and resource cleanup. Original native evidence has three unchanged state windows, not per-endpoint snapshots or complete database coverage.', differences }), { flag: 'wx' });
    }
    assert.deepEqual(differences, []);
  });
}
