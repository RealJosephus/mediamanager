import path from 'node:path';

export const fixturePathStyle = process.platform === 'win32' ? 'windows' : 'posix';

// These recordings relocate their isolated state root. Preserve the recorded
// Windows separators only in that path's suffix, never in unrelated text or
// externally supplied identities.
export function projectStatePath(value, root, placeholder = '$STATE') {
  if (typeof value !== 'string' || value !== root && !value.startsWith(root + path.sep)) return value;
  return placeholder + value.slice(root.length).split(path.sep).join('\\');
}

export function expandStatePath(value, recordedRoot, root) {
  if (typeof value !== 'string' || value !== recordedRoot
    && !value.startsWith(recordedRoot + '\\') && !value.startsWith(recordedRoot + '/')) return value;
  // Keep the suffix verbatim apart from the explicitly relocated separators;
  // path.join would also normalize dot segments and change the fixture input.
  return root + value.slice(recordedRoot.length).replaceAll('\\', path.sep).replaceAll('/', path.sep);
}
