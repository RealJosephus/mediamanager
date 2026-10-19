import assert from 'node:assert/strict';
import test from 'node:test';
import { recordItemFilterCandidate } from './item-filter-http-scenario.js';

const fixture = {
  schemaVersion: 1,
  userId: '77000000-0000-0000-0000-000000000001',
  rootId: '77000000-0000-0000-0000-000000000100',
  items: [
    { key: 'root', id: '77000000-0000-0000-0000-000000000100', name: 'Sort Root', type: 'Folder' },
    { key: 'chinese', id: '77000000-0000-0000-0000-000000000201', name: 'Alpha 中文',
      sortName: 'alpha zhong wen', type: 'Movie', parentId: '77000000-0000-0000-0000-000000000100' },
    { key: 'japanese', id: '77000000-0000-0000-0000-000000000202', name: 'ｶﾞ',
      sortName: 'ga', type: 'Movie', parentId: '77000000-0000-0000-0000-000000000100' },
    { key: 'fullwidth', id: '77000000-0000-0000-0000-000000000203', name: '￢',
      sortName: '¬', type: 'Movie', parentId: '77000000-0000-0000-0000-000000000100' },
    { key: 'punctuation', id: '77000000-0000-0000-0000-000000000204', name: '中文，東京！',
      sortName: 'zhong wen dong jing', type: 'Movie', parentId: '77000000-0000-0000-0000-000000000100' },
    { key: 'mixed', id: '77000000-0000-0000-0000-000000000205', name: 'A中B',
      sortName: 'a zhongb', type: 'Movie', parentId: '77000000-0000-0000-0000-000000000100' },
  ],
  cases: [
    { name: 'unicode-sort-list', query: 'IncludeItemTypes=Movie',
      scope: ['chinese', 'japanese', 'fullwidth', 'punctuation', 'mixed'], endpoints: ['items', 'legacy'] },
    { name: 'unicode-sort-page', query: 'IncludeItemTypes=Movie&StartIndex=1&Limit=1',
      scope: ['chinese', 'japanese', 'fullwidth', 'punctuation', 'mixed'], endpoints: ['items', 'legacy'] },
  ],
};

for (const dialect of ['postgres']) {
  test(`${dialect}: portable HTTP SortName leaves imported ordering keys unchanged`, {
    skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES,
  }, async () => {
    const result = await recordItemFilterCandidate({
      dialect, fixture, connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      scenarioName: 'sort-name-portable', fields: 'SortName', captureOrder: true,
      captureSortNames: true, captureStartIndex: true,
    });
    assert.equal(result.httpCases, 4);
    const expectedKeys = ['mixed', 'chinese', 'japanese', 'punctuation', 'fullwidth'];
    const expectedNames = [
      { key: 'mixed', value: 'a zhongb' },
      { key: 'chinese', value: 'alpha zhong wen' },
      { key: 'japanese', value: 'ga' },
      { key: 'punctuation', value: 'zhong wen dong jing' },
      { key: 'fullwidth', value: '¬' },
    ];
    for (const entry of result.cases) for (const response of entry.endpoints) {
      const expected = entry.name === 'unicode-sort-page' ? expectedKeys.slice(1, 2) : expectedKeys;
      assert.equal(response.contract.status, 200, `${entry.name}:${response.endpoint}`);
      assert.deepEqual(response.contract.orderedKeys, expected, `${entry.name}:${response.endpoint}`);
      assert.deepEqual(response.contract.sortNames, expectedNames.filter(value => expected.includes(value.key)),
        `${entry.name}:${response.endpoint}`);
      assert.equal(response.contract.totalRecordCount, 5);
    }
    assert.deepEqual(result.afterReads, result.beforeReads, `${dialect}: GET must not change stored sort keys`);
  });
}
