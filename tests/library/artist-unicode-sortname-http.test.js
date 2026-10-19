import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { nativeArtistIdentity } from '../../src/library/identity.js';
import { idKey } from '../../src/library/records.js';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';
import { writeCompleteIdentityHttpEvidence } from './full-identity-wire.js';
import { assertCandidateIdentityMatchesNative,
  verifyNativeIdentityEvidence,
  verifyIdentityMismatchNegativeControl } from './native-identity-evidence.js';

assert.equal(verifyIdentityMismatchNegativeControl(), true);

const evidenceRoot = validationFileUrl('../../.agent-docs/evidence/identity-inputs/artist-unicode-sortname-native-v1/', import.meta.url);
await verifyNativeIdentityEvidence({ evidenceRoot, kind: 'artist', evidenceName: 'artist-unicode-sortname-native-v1',
  expectedRunModes: { 'native-run': 'unicode' } });
const evidence = new URL('native-run/', evidenceRoot);
const nativeHttp = JSON.parse(await readFile(validationFileUrl('native-http.json', evidence), 'utf8'));
const nativeStages = JSON.parse(await readFile(validationFileUrl('stages.json', evidence), 'utf8'));
const nativeSummary = JSON.parse(await readFile(validationFileUrl('summary.json', evidence), 'utf8'));
assert.equal(nativeSummary.passed, true);
assert.equal(createHash('sha256').update(await readFile(validationFileUrl('../record-native.mjs', evidence))).digest('hex'),
  nativeSummary.recorderSha256);
assert.deepEqual(nativeHttp.records.map(record => record.name), ['create-1', 'create-2', 'list', 'followup']);
assert.deepEqual(nativeStages.watched.map(item => item.name), ['東京', 'ｶﾞ']);
assert.deepEqual(nativeStages.afterCreate2.database.watchedRows.map(item => item.row?.SortName), ['dong jing', 'ga']);

const fixture = {
  schemaVersion: 1,
  userId: '79000000-0000-0000-0000-000000000001',
  rootId: '79000000-0000-0000-0000-000000000100',
  items: [
    { key: 'root', id: '79000000-0000-0000-0000-000000000100', name: 'Artist Root', type: 'Folder' },
    { key: 'movie', id: '79000000-0000-0000-0000-000000000201', name: 'Uncredited Movie',
      type: 'Movie', parentId: '79000000-0000-0000-0000-000000000100' },
  ],
  cases: [
    ...nativeStages.watched.map((item, index) => ({
      name: `create-${index + 1}`, query: `Artists=${encodeURIComponent(item.name)}`, scope: ['movie'],
      omitParentId: true, recursive: null, omitSortBy: true, endpoints: ['items'],
    })),
    { name: 'list', query: 'IncludeItemTypes=MusicArtist', scope: [], omitScope: true,
      endpoints: ['items'] },
    { name: 'followup', query: `Artists=${encodeURIComponent(nativeStages.watched[0].name)}`,
      scope: ['movie'], omitParentId: true, recursive: null, omitSortBy: true, endpoints: ['items'] },
  ],
};

const nativeTree = stage => [{ path: 'artists', type: 'directory' },
  ...nativeStages[stage].artistTree.map(entry => ({ path: `artists/${entry.name}`, type: entry.type }))]
  .filter(entry => stage !== 'before' || entry.path !== 'artists')
  .sort((left, right) => left.path.localeCompare(right.path, 'en'));
const comparableRow = row => Object.fromEntries(Object.entries(row)
  .filter(([key]) => !['Id', 'DateCreated', 'DateModified'].includes(key))
  .map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : typeof value === 'boolean' ? Number(value) : value]));

for (const dialect of ['postgres']) {
  test(`${dialect}: Artist Unicode creation and repeat match the recorded native SortNames`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    let identities;
    const actual = await recordItemFilterCandidate({
      dialect, fixture, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'artist-unicode-sortname', fields: 'SortName', captureOrder: true,
      captureSortNames: true, captureItems: true, captureStartIndex: true,
      trackFilesystem: true, captureCaseStages: true, captureResponseBodies: true,
      prepareScenario({ programDataPath }) {
        identities = nativeStages.watched.map(item => nativeArtistIdentity(item.name, {
          programDataPath, metadataPath: path.join(programDataPath, 'metadata'),
        }));
      },
    });

    for (const [index, identity] of identities.entries()) {
      assertCandidateIdentityMatchesNative(identity.Id, nativeStages.watched[index].id,
        `${dialect}:${nativeStages.watched[index].name}`);
    }
    assert.equal(actual.httpCases, nativeHttp.records.length);
    await writeCompleteIdentityHttpEvidence(actual, nativeHttp, { scenarioName: 'artist-unicode-sortname' });
    assert.deepEqual(actual.filesystemBeforeReads, nativeTree('before'));
    for (const [index, record] of nativeHttp.records.entries()) {
      const observed = actual.cases[index].endpoints[0].contract;
      const expected = record.response.bodyJson;
      assert.equal(observed.status, record.response.status, record.name);
      assert.equal(observed.contentType, record.response.contentType, record.name);
      assert.equal(observed.totalRecordCount, expected.TotalRecordCount, record.name);
      assert.equal(observed.startIndex, expected.StartIndex, record.name);
      assert.deepEqual(observed.items.map(item => ({ Name: item.name, Type: item.type })),
        expected.Items.map(item => ({ Name: item.Name, Type: item.Type })), record.name);
      assert.deepEqual(observed.sortNames.map(item => item.value),
        expected.Items.map(item => item.SortName), `${record.name}:SortName`);

      const stage = actual.caseStages[index];
      const stageName = ['afterCreate1', 'afterCreate2', 'afterList', 'afterFollowup'][index];
      assert.equal(stage.database.BaseItems.length - actual.beforeReads.BaseItems.length,
        nativeStages[stageName].database.baseItemsCount - nativeStages.before.database.baseItemsCount,
        `${dialect}:${stageName}:row count`);
      assert.deepEqual(stage.filesystem, nativeTree(stageName), `${dialect}:${stageName}:tree`);
      for (const [watchIndex, item] of nativeStages.watched.entries()) {
        const row = stage.database.BaseItems.find(value => idKey(value.Id) === idKey(identities[watchIndex].Id));
        const nativeRow = nativeStages[stageName].database.watchedRows[watchIndex].row;
        assert.equal(Boolean(row), Boolean(nativeRow), `${dialect}:${stageName}:${item.name}:presence`);
        if (nativeRow) {
          assert.deepEqual(comparableRow(row), comparableRow(nativeRow),
            `${dialect}:${stageName}:${item.name}:row`);
        }
      }
    }
    assert.deepEqual(actual.filesystemAfterReads, nativeTree('afterFollowup'));
    assert.deepEqual(actual.filesystemAfterShutdown, actual.filesystemAfterReads);
    for (const table of Object.keys(actual.beforeReads).filter(name => name !== 'BaseItems')) {
      assert.deepEqual(actual.afterReads[table], actual.beforeReads[table], `${dialect}:${table}`);
    }
    assert.deepEqual(actual.runtimeErrors, []);
    assert.deepEqual(actual.handledExpectedRuntimeErrors, []);
    assert.deepEqual(actual.cleanup, {
      runtimeClosed: true, databaseClosed: true, portReleased: true,
      postgresSchemasRemoved: dialect === 'postgres' ? true : null,
      programDataDirectoryRemoved: true,
    });
  });
}
