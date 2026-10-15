import { isDeepStrictEqual } from 'node:util';

// Values are compared as observed; no implicit removal of IDs, time, or URLs.
export function compareObservations(reference, candidate, { rules = [] } = {}) {
  const left = structuredClone(reference);
  const right = structuredClone(candidate);
  for (const rule of rules) {
    if (!rule.reason || !Array.isArray(rule.path) || typeof rule.normalize !== 'function') {
      throw new TypeError('Normalization requires an explicit path, reason, and function.');
    }
    for (const root of [left, right]) {
      let parent = root;
      for (const key of rule.path.slice(0, -1)) {
        if (!Object.hasOwn(parent, key)) throw new Error(`Missing normalization path: ${rule.path.join('.')}`);
        parent = parent[key];
      }
      const key = rule.path.at(-1);
      if (!Object.hasOwn(parent, key)) throw new Error(`Missing normalization field: ${key}`);
      parent[key] = rule.normalize(parent[key]);
    }
  }
  const differences = [];
  function compare(a, b, path) {
    if (isDeepStrictEqual(a, b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object' &&
        Array.isArray(a) === Array.isArray(b) && !ArrayBuffer.isView(a) && !ArrayBuffer.isView(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) differences.push({ path: [...path, key], kind: 'missing', reference: a[key], candidate: b[key] });
        else compare(a[key], b[key], [...path, key]);
      }
    } else differences.push({ path, kind: 'value', reference: a, candidate: b });
  }
  compare(left, right, []);
  return { equal: differences.length === 0, differences, normalizations: rules.map(({ path, reason }) => ({ path, reason })) };
}
