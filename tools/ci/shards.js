import { fullPartition } from '../validation/full-partitions.js';

export function partitionSelection(classification, environment, profile, requested = []) {
  const read = name => {
    const raw = environment[name] ?? '1';
    if (!/^[1-9]\d*$/u.test(String(raw)) || !Number.isSafeInteger(Number(raw))) throw new Error(`${name} must be a positive integer.`);
    return Number(raw);
  };
  const index = read('MEDIAMANAGER_CI_SHARD'), total = read('MEDIAMANAGER_CI_SHARDS');
  if (index > total || total > 16) throw new Error('Invalid CI shard range.');
  const fullPair = profile === 'full' && environment.MEDIAMANAGER_CI_RELEASE_PAIR === 'true';
  if (total !== 1 && (profile === 'full' && !fullPair || requested.length)) throw new Error('Ordinary full and exact requests cannot be sharded.');
  const available = classification.records.filter(record => record.selected).map(record => record.path).sort();
  const assigned = fullPair ? fullPartition(available, index, total).assigned
    : available.filter((_, offset) => offset % total === index - 1);
  const selected = new Set(assigned);
  for (const record of classification.records) if (record.selected && !selected.has(record.path)) {
    record.selected = false;
    record.reasons.push({ code: 'other-shard' });
  }
  return { index, total, available, assigned };
}
