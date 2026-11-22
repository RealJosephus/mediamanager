import { ordinalIgnoreCaseKey } from '../../storage/ordinal-comparer.js';
import { same } from './format.js';

function byProvider(rows) {
  const result = new Map();
  for (const pair of rows ?? []) {
    const key = ordinalIgnoreCaseKey(pair[0]);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(pair);
  }
  return result;
}

const values = pairs => pairs.map(([, value]) => value).sort();
const sameProvider = (left, right) => same(values(left), values(right));

export function mergeProviderIds(source, target, baseSource, baseTarget, {
  pending, owed, legacy, targetType, issue, rememberTargetEdit,
}) {
  const input = byProvider(source);
  const existing = byProvider(target);
  const beforeInput = byProvider(baseSource);
  const beforeTarget = byProvider(baseTarget);
  const result = new Map(existing);
  const keys = new Set([
    ...input.keys(), ...existing.keys(), ...beforeInput.keys(), ...beforeTarget.keys(),
    ...(pending?.keys() ?? []), ...(owed?.keys() ?? []),
  ]);
  for (const provider of keys) {
    const source = input.get(provider) ?? [], target = existing.get(provider) ?? [];
    const previousSource = beforeInput.get(provider) ?? [], previousTarget = beforeTarget.get(provider) ?? [];
    if (sameProvider(source, target)) continue;
    const conflict = reason => issue('conflict', reason, { provider, source, target, previousSource, previousTarget });
    if (pending?.has(provider)) {
      conflict('unresolved provider ID conflict');
      continue;
    }
    if (legacy && !sameProvider(previousSource, previousTarget)) {
      conflict('older exchange recorded a conflict for the provider list');
      continue;
    }
    const editedTarget = !sameProvider(target, previousTarget);
    if (!owed?.has(provider) && sameProvider(source, previousSource)) {
      // Keep an edit made on the destination eligible for the return trip, even
      // though the next receipt will already describe that destination value.
      if (baseTarget && editedTarget) rememberTargetEdit?.(provider);
      continue;
    }
    if (target.length > 1 || source.length > 1 || previousSource.length > 1 || previousTarget.length > 1) {
      conflict('provider key has multiple native entries');
      continue;
    }
    if (editedTarget) {
      conflict(baseTarget ? 'both endpoints edited the provider ID' : 'target already has a different provider ID');
      continue;
    }
    const [pair] = source;
    if (targetType === 'emby' && pair && (!pair[0] || /[=|]/u.test(pair[0]) || pair[1]?.includes('|'))) {
      issue('origin-only', 'provider ID contains an Emby delimiter: ' + provider);
      continue;
    }
    if (pair) result.set(provider, [[target[0]?.[0] ?? pair[0], pair[1]]]);
    else result.delete(provider);
  }
  return [...result.values()].flat().sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
