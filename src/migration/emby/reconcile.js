import { same } from './format.js';

// Compare each endpoint with its own last projection. The target can legitimately
// have lower precision or a different set of expressible fields.
export function changesBetween(source, target, baseSource, baseTarget, report) {
  const changes = [];
  for (const key of new Set([...source.keys(), ...baseSource.keys()])) {
    const value = source.get(key),
      before = baseSource.get(key),
      current = target.get(key),
      previous = baseTarget.get(key);
    if (same(value, before)) continue;
    const [kind, id] = key.split('/');
    if (!value) {
      if (!current) continue;
      if (!same(current, previous)) {
        report('conflict', kind, id, 'deletion', 'target has edits');
        continue;
      }
      changes.push({ key, value: null, fields: [] });
      continue;
    }
    if (!current) {
      if (previous) {
        report('conflict', kind, id, 'deletion', 'target removed a source-edited object');
        continue;
      }
      changes.push({ key, value, fields: Object.keys(value) });
      continue;
    }
    const changed = [];
    for (const name of Object.keys(value)) {
      if (same(value[name], before?.[name]) || same(value[name], current[name])) continue;
      if (previous && !same(previous[name], current[name])) {
        report('conflict', kind, id, name, 'both endpoints edited');
        continue;
      }
      if (!before && !previous) {
        report('conflict', kind, id, name, 'identity already exists on the target');
        continue;
      }
      changed.push(name);
    }
    if (changed.length) changes.push({ key, value, fields: changed });
  }
  return changes;
}
