import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

const roots = [
  ['.agent-docs/evidence/syncplay-date-impact-inputs', 'MEDIAMANAGER_SYNCPLAY_DATE_IMPACT_INPUT_ROOT'],
  ['.agent-docs/evidence/native-conflict-inputs', 'MEDIAMANAGER_NATIVE_CONFLICT_INPUT_ROOT'],
  ['.agent-docs/evidence/byname-filter-inputs', 'MEDIAMANAGER_BYNAME_FILTER_INPUT_ROOT'],
  ['.agent-docs/evidence/identity-inputs', 'MEDIAMANAGER_IDENTITY_INPUT_ROOT'],
  ['.agent-docs/evidence/item-filter-inputs', 'MEDIAMANAGER_ITEM_FILTER_INPUT_ROOT'],
  ['.agent-docs/evidence/user-view-inputs', 'MEDIAMANAGER_USER_VIEW_INPUT_ROOT'],
  ['.agent-docs/evidence/core-flow-20260926/reference', 'MEDIAMANAGER_VALIDATION_REFERENCE_ROOT'],
  ['.agent-docs/evidence/core-flow-20260926/initial.db', 'MEDIAMANAGER_TEST_NATIVE_SQLITE'],
  ['.agent-docs/baselines/jellyfin-current', 'MEDIAMANAGER_VALIDATION_JELLYFIN_ROOT'],
  ['.agent-docs/evidence', 'MEDIAMANAGER_VALIDATION_INPUT_ROOT'],
  ['.agent-docs/baselines', 'MEDIAMANAGER_VALIDATION_BASELINE_ROOT'],
  ['.agent-docs/oracle', 'MEDIAMANAGER_VALIDATION_ORACLE_ROOT'],
  ['.agent-docs/reference-instance', 'MEDIAMANAGER_TEST_NATIVE_INSTANCE'],
  ['.tools/dotnet', 'MEDIAMANAGER_DOTNET_ROOT'],
];

export function validationPath(value, base = repositoryRoot, environment = process.env) {
  const filename = value instanceof URL ? fileURLToPath(value) : String(value);
  const absolute = path.resolve(base, filename);
  for (const [relative, variable] of roots) {
    const original = path.resolve(repositoryRoot, relative);
    const suffix = path.relative(original, absolute);
    if (suffix === '' || (!suffix.startsWith('..' + path.sep) && suffix !== '..' && !path.isAbsolute(suffix))) {
      return path.resolve(environment[variable] || original, suffix);
    }
  }
  return absolute;
}

export function validationFileUrl(value, base = pathToFileURL(repositoryRoot)) {
  const url = typeof value === 'string' && /^[A-Za-z]:[\\/]/u.test(value) ? pathToFileURL(value) : new URL(value, base);
  if (url.protocol !== 'file:') throw new TypeError('Validation input URLs must use file:.');
  const result = pathToFileURL(validationPath(url));
  if (url.pathname.endsWith('/') && !result.pathname.endsWith('/')) result.pathname += '/';
  return result;
}

export function validationExecutable(name, environment = process.env) {
  const variable = `MEDIAMANAGER_${name.toUpperCase()}`;
  if (environment[variable]) return path.resolve(repositoryRoot, environment[variable]);
  const searchPath = environment.PATH || environment.Path || '';
  const suffixes = process.platform === 'win32' ? ['', ...(environment.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const filename = path.resolve(directory.replace(/^"|"$/gu, ''), name + suffix.toLowerCase());
      if (existsSync(filename)) return filename;
    }
  }
  return name;
}

export function validationOutputRoot(environment = process.env) {
  const root = path.resolve(repositoryRoot, environment.MEDIAMANAGER_VALIDATION_OUTPUT_ROOT || '.test-output/validation');
  assertIsolatedOutput(root, environment);
  return root;
}

function isWithin(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function isSameOrWithin(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// Recorders create new directories below the configured output root.  A
// lexical prefix check is insufficient because an existing child may be a
// junction or symlink to a reference/input directory (or anywhere else).
export function assertValidationOutputChild(filename, environment = process.env) {
  const root = validationOutputRoot(environment);
  const absolute = path.resolve(filename);
  if (!isWithin(root, absolute)
    || !isWithin(resolvedExistingAncestor(root), resolvedExistingAncestor(absolute))) {
    throw new Error('Validation output must be a child of the configured output root and cannot escape through links.');
  }
  return absolute;
}

function resolvedExistingAncestor(filename) {
  const suffix = [];
  let current = path.resolve(filename);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(existsSync(current) ? realpathSync(current) : current, ...suffix);
}

export function assertIsolatedOutput(filename, environment = process.env) {
  const output = resolvedExistingAncestor(filename);
  const protectedRoots = [
    environment.MEDIAMANAGER_JELLYFIN_SOURCE || 'D:/jellyfin',
    environment.MEDIAMANAGER_ALIST_SOURCE || 'D:/alist',
    environment.MEDIAMANAGER_VALIDATION_INPUT_ROOT,
    environment.MEDIAMANAGER_ITEM_FILTER_INPUT_ROOT,
    environment.MEDIAMANAGER_USER_VIEW_INPUT_ROOT,
    environment.MEDIAMANAGER_IDENTITY_INPUT_ROOT,
    environment.MEDIAMANAGER_BYNAME_FILTER_INPUT_ROOT,
    environment.MEDIAMANAGER_NATIVE_CONFLICT_INPUT_ROOT,
    environment.MEDIAMANAGER_SYNCPLAY_DATE_IMPACT_INPUT_ROOT,
    environment.MEDIAMANAGER_VALIDATION_JELLYFIN_ROOT,
    environment.MEDIAMANAGER_VALIDATION_BASELINE_ROOT,
    environment.MEDIAMANAGER_VALIDATION_ORACLE_ROOT,
    environment.MEDIAMANAGER_TEST_NATIVE_INSTANCE,
    environment.MEDIAMANAGER_TEST_NATIVE_SQLITE && path.dirname(environment.MEDIAMANAGER_TEST_NATIVE_SQLITE),
    environment.MEDIAMANAGER_VALIDATION_REFERENCE_ROOT,
    environment.MEDIAMANAGER_DOTNET_ROOT,
    environment.MEDIAMANAGER_JELLYFIN_DLL && path.dirname(environment.MEDIAMANAGER_JELLYFIN_DLL),
    environment.MEDIAMANAGER_DOTNET && path.dirname(environment.MEDIAMANAGER_DOTNET),
  ].filter(Boolean);
  for (const root of protectedRoots) {
    const protectedRoot = resolvedExistingAncestor(root);
    if (isSameOrWithin(protectedRoot, output) || isSameOrWithin(output, protectedRoot)) {
      throw new Error('Validation output must be outside reference, validation input, native input and runtime directories.');
    }
  }
}
