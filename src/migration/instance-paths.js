import path from 'node:path';

// Persisted source identities describe the producer's filesystem, even when
// the package is being read on a different operating system. Never resolve
// these identities against the consumer's working directory or drive.
export function instancePathApi(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError('An instance path must be an absolute path.');
  const api = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(value) ? path.win32 : path.posix;
  if (!api.isAbsolute(value)) throw new TypeError('An instance path must be an absolute path.');
  return api;
}

export function instancePathKey(value, api) {
  const normalized = api.normalize(value);
  const key = normalized.endsWith(api.sep) && normalized !== api.parse(normalized).root ? normalized.slice(0, -1) : normalized;
  return api === path.win32 ? key.toLowerCase() : key;
}

export function instancePathContains(root, value, api) {
  const relative = api.relative(root, value);
  return relative === '' || (!api.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${api.sep}`));
}
