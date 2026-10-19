import path from 'node:path';

export const fixturePathStyle = process.platform === 'win32' ? 'windows' : 'posix';
const stateSeparator = root => /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(root) ? '\\' : path.sep;

// These recordings relocate their isolated state root. Preserve the recorded
// Windows separators only in that path's suffix, never in unrelated text or
// externally supplied identities.
export function projectStatePath(value, root, placeholder = '$STATE') {
  if (typeof value !== 'string' || value !== root && !value.startsWith(root + '/') && !value.startsWith(root + '\\')) return value;
  const separator = stateSeparator(root);
  return placeholder + value.slice(root.length).split(separator).join('\\');
}

export function projectStateMacroPath(value, root) {
  for (const macro of ['%AppDataPath%', '%MetadataPath%']) {
    if (typeof value === 'string' && (value === macro || value.startsWith(macro + '/') || value.startsWith(macro + '\\'))) {
      return macro + value.slice(macro.length).split(stateSeparator(root)).join('\\');
    }
  }
  return value;
}

export function expandStatePath(value, recordedRoot, root) {
  if (typeof value !== 'string' || value !== recordedRoot
    && !value.startsWith(recordedRoot + '\\') && !value.startsWith(recordedRoot + '/')) return value;
  // Keep the suffix verbatim apart from the explicitly relocated separators;
  // path.join would also normalize dot segments and change the fixture input.
  return root + value.slice(recordedRoot.length).replaceAll('\\', path.sep).replaceAll('/', path.sep);
}
