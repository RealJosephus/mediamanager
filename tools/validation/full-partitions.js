export const fullShardCount = 5;
export const scaleTestFiles = Object.freeze([
  'tests/migration/large-catalog-exchange.test.js',
  'tests/migration/production-instance-state-exchange.test.js',
]);

// Partition the discovered suite before execution. Availability and results
// never affect assignment; the scale consumers get an otherwise idle runner.
export function fullPartition(discovered, index, total = fullShardCount) {
  if (!Array.isArray(discovered) || !discovered.length
    || discovered.some(file => typeof file !== 'string' || !file.endsWith('.test.js'))
    || new Set(discovered).size !== discovered.length) throw new Error('A complete unique test manifest is required.');
  if (total !== fullShardCount || !Number.isInteger(index) || index < 1 || index > total) {
    throw new Error(`Full validation requires shards 1 through ${fullShardCount}.`);
  }
  const available = [...discovered].sort();
  const ordinary = available.filter(file => !scaleTestFiles.includes(file));
  const assigned = index === fullShardCount ? available.filter(file => scaleTestFiles.includes(file))
    : ordinary.filter((_, offset) => offset % (fullShardCount - 1) === index - 1);
  return { index, total, available, assigned };
}

export function fullPartitionScopeValid(scope) {
  try {
    const expected = fullPartition(scope.discovered, scope.sharding?.index, scope.sharding?.total);
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    return same(scope.sharding, expected) && same(scope.selected, expected.assigned)
      && same(scope.excluded.map(record => record.path).sort(), expected.available.filter(file => !expected.assigned.includes(file)))
      && scope.excluded.every(record => record.reasons.some(reason => reason.code === 'other-shard'));
  } catch { return false; }
}
