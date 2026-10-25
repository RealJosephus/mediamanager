import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionSelection } from '../../tools/ci/shards.js';
import { ciSummary } from '../../tools/ci/summary.js';
import { analyzeJavaScriptDependencies } from '../../tools/validation/inventory.js';

test('CI shards partition the complete frozen available scope exactly once and preserve dependency exclusions', () => {
  const records = ['f', 'b', 'e', 'a', 'd', 'c'].map(path => ({ path, selected: path !== 'e', reasons: path === 'e' ? [{ code: 'input-not-shipped' }] : [] }));
  const assigned = [];
  for (let index = 1; index <= 4; index++) {
    const classification = { records: structuredClone(records) };
    const shard = partitionSelection(classification, { MEDIAMANAGER_CI_SHARD: String(index), MEDIAMANAGER_CI_SHARDS: '4' }, 'ci-available');
    assert.deepEqual(shard.available, ['a', 'b', 'c', 'd', 'f']);
    assert.deepEqual(classification.records.filter(record => record.selected).map(record => record.path).sort(), shard.assigned);
    assert.deepEqual(classification.records.find(record => record.path === 'e').reasons, [{ code: 'input-not-shipped' }]);
    assigned.push(...shard.assigned);
  }
  assert.equal(new Set(assigned).size, assigned.length);
  assert.deepEqual(assigned.sort(), ['a', 'b', 'c', 'd', 'f']);
});

test('full and exact requests remain one complete run and malformed shard settings fail', () => {
  const fresh = () => ({ records: [{ path: 'a', selected: true, reasons: [] }] });
  assert.deepEqual(partitionSelection(fresh(), {}, 'full').assigned, ['a']);
  for (const value of ['0', '-1', '1.5', 'x', '17', '9007199254740992']) {
    assert.throws(() => partitionSelection(fresh(), { MEDIAMANAGER_CI_SHARDS: value }, 'ci-available'));
  }
  const environment = { MEDIAMANAGER_CI_SHARDS: '2' };
  assert.throws(() => partitionSelection(fresh(), environment, 'full'), /cannot be sharded/u);
  assert.throws(() => partitionSelection(fresh(), environment, 'ci-available', ['a']), /cannot be sharded/u);
  assert.throws(() => partitionSelection(fresh(), { MEDIAMANAGER_CI_SHARD: '2' }, 'ci-available'), /range/u);
});

test('Actions summary stays below the upload limit while full diagnostics stay in scope.json', () => {
  const scope = { platform: 'win32', profile: 'ci-available', discovered: Array(600), selected: [],
    impact: { mode: 'allavailable', fallbackReasons: Array(5000).fill({ code: 'global-change', detail: 'x'.repeat(1000) }) },
    excluded: Array.from({ length: 600 }, (_, index) => ({ path: `tests/${index}.test.js`,
      reasons: Array(100).fill({ code: 'input-not-shipped', filename: 'x'.repeat(1000) }) })),
    infrastructureErrors: Array(5000).fill({ code: 'input-unavailable', filename: 'x'.repeat(1000) }),
    currentReleaseInputReady: true, historicalArchiveComplete: false };
  const summary = ciSummary(scope, { outcome: 'incomplete' });
  assert.ok(Buffer.byteLength(summary) < 256 * 1024);
  assert.match(summary, /scope.json/u);
  assert.match(summary, /Historical archive complete: \*\*false\*\* \(diagnostic only/u);
});

test('native oracle declares its DLL dependency even when the environment is passed as a parameter', () => {
  const analysis = analyzeJavaScriptDependencies("export const requiredValidationServices = ['dotnet', 'jellyfinDll'];");
  assert.deepEqual(analysis.declaredServices, ['dotnet', 'jellyfinDll']);
  assert.throws(() => analyzeJavaScriptDependencies('export const requiredValidationServices = discover();'), /static array/u);
});
