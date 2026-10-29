import { projectItemBody } from './http-body-projection.js';
import { parseLosslessJson } from '../../src/core/json.js';

export function projectChannelPath(value, root) {
  if (typeof value !== 'string') return value;
  for (const scope of new Set([root, root.replaceAll('\\', '/')])) {
    if (value === scope || value.startsWith(scope + '/') || value.startsWith(scope + '\\')) return '<ROOT>' + value.slice(scope.length);
  }
  return value;
}

// An action carries a complete DTO result. Descriptive strings and opaque
// dictionaries are business values even when they equal an instance path.
export function projectChannelAction(action, root) {
  if (!action || typeof action !== 'object' || !Object.hasOwn(action, 'value')) return action;
  return { ...action, value: projectItemBody(action.value, { date: value => value, path: value => projectChannelPath(value, root) }) };
}

// Persisted/warm observations are the producer's explicit entity subset;
// their lowercase `type` records the runtime type, rather than a DTO role.
export function projectChannelEntitySummaries(rows, root) {
  return rows.map(row => typeof row?.Path === 'string' ? { ...row, Path: projectChannelPath(row.Path, root) } : row);
}

export function projectChannelCacheFiles(files) {
  return files.map(file => {
    let value;
    try { value = parseLosslessJson(file.text); } catch { value = file.text; }
    return { path: file.path, value };
  });
}
