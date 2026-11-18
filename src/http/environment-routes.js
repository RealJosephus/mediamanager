import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BindingError, booleanValue, httpError, noContent, notFound, queryValue } from './binding.js';
import { bindJsonModel } from './json-model-binding.js';
import { withCleanup } from '../core/operation-failure.js';
import { nativeDirectoryName } from '../library/native-path.js';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';

const validatePathModel = { type: 'object', reference: 'ValidatePath', clrType: 'Jellyfin.Api.Models.EnvironmentDtos.ValidatePathDto' };
const validatePathSchema = { definitions: { ValidatePath: {
  defaults: { ValidateWritable: false, Path: null, IsFile: null },
  fields: {
    ValidateWritable: { type: 'boolean', clrType: 'System.Boolean' },
    Path: { type: 'string', clrType: 'System.String', nullable: true },
    IsFile: { type: 'boolean', clrType: 'System.Boolean', nullable: true },
  },
} } };
const absentPathCodes = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EINVAL', 'ENAMETOOLONG', 'invalid-path']);
const pathApi = value => /^[A-Za-z]:|^\\/u.test(value) ? path.win32 : path.posix;

function requiredPath(query) {
  const value = queryValue(query, 'path');
  if (value == null || clrTrim(value) === '') throw new BindingError('path', 'The path field is required.');
  return value;
}

function bindDirectory(query) {
  const input = {}, errors = {};
  for (const name of ['path', 'includeFiles', 'includeDirectories']) {
    const value = queryValue(query, name);
    try {
      if (name === 'path') {
        input.path = requiredPath(query);
      } else {
        if (value !== undefined && clrTrim(value) === '') throw new BindingError(name, `The value '${value}' is invalid.`);
        input[name] = booleanValue(value, name, false);
      }
    } catch (error) {
      if (!(error instanceof BindingError)) throw error;
      Object.assign(errors, error.errors);
    }
  }
  if (Object.keys(errors).length) {
    const error = new BindingError('', 'Directory request binding failed.'); error.errors = errors; throw error;
  }
  return input;
}

function browseRoots(fileSystem) {
  return fileSystem?.identityMap?.exportState().prefixes.filter(prefix => prefix.style !== 'uri') ?? [];
}

function parentPath(value, roots) {
  const api = pathApi(value);
  const normalizeRoot = name => api.normalize(name).replace(/[\\/]+$/u, '');
  const normalized = normalizeRoot(value);
  if (roots.some(({ identityRoot, caseSensitive }) => {
    if (api !== pathApi(identityRoot)) return false;
    const root = normalizeRoot(identityRoot);
    return caseSensitive ? normalized === root : ordinalIgnoreCaseEquals(normalized, root);
  })) return null;
  const parent = nativeDirectoryName(value, { windows: api === path.win32 });
  if (!parent && value.startsWith('\\')) {
    const candidate = value.slice(0, value.lastIndexOf('\\'));
    return clrTrim(candidate.replace(/^\\+/u, '')) ? candidate : null;
  }
  return api === path.posix && parent !== null ? parent.replace(/\/{2,}/gu, '/') : parent;
}

async function existingPath(fileSystem, identity, signal) {
  if (identity == null || identity === '') return null;
  try { return await fileSystem.stat(identity, { signal }); }
  catch (error) {
    if (!(error instanceof AggregateError) && error?.errors === undefined && absentPathCodes.has(error?.code)) return null;
    throw error;
  }
}

async function validateWritable(fileSystem, directory, signal) {
  const retained = fileSystem.retainDirectory(directory, { preserveMountRoots: true });
  const { fileSystem: owner } = retained;
  let target, published = false;
  await withCleanup(async () => {
    target = owner.accessPath(pathApi(directory).join(directory, randomUUID()));
    const atomic = owner.vfs.capabilities(target).atomicReplace === true;
    try {
      await owner.vfs.write(target, Buffer.alloc(0), { overwrite: false, atomic, size: 0n, signal });
      published = true;
    } catch (error) {
      published = error?.details?.publicationConfirmed === true;
      throw error;
    }
  }, [() => published && owner.vfs.delete(target), () => retained.close()], 'Path validation and cleanup failed.');
}

/** EnvironmentController directory browsing uses the configured storage namespace. */
export function registerEnvironmentRoutes(add, { fileSystem, localization }) {
  const policy = 'FirstTimeSetupOrElevated';
  const storage = () => {
    if (!fileSystem) throw httpError(503, 'Storage is unavailable.');
    return fileSystem;
  };
  add('GET', '/Environment/DirectoryContents', async context => {
    const input = context.queryInput;
    // The designated controller treats a bare UNC server as an empty listing
    // before attempting filesystem enumeration, on every host platform.
    if (input.path.startsWith('\\\\') && input.path.lastIndexOf('\\') === 1) return [];
    let entries;
    try { entries = await storage().readdir(input.path, { withFileTypes: true, signal: context.signal }); }
    catch (error) {
      const status = error?.status ?? error?.statusCode
        // DirectoryInfo enumeration raises IOException for a file on Windows,
        // which the designated ExceptionMiddleware leaves at 500. On Unix the
        // same operation raises DirectoryNotFoundException and returns 404.
        ?? (error?.code === 'ENOENT' ? 404 : error?.code === 'ENOTDIR' ? (process.platform === 'win32' ? 500 : 404)
          : error?.code === 'invalid-path' ? 400 : undefined);
      if (status !== undefined && error instanceof Error && !Array.isArray(error.errors)) {
        throw Object.assign(new Error(error.message, { cause: error }), { code: error.code, status });
      }
      throw error;
    }
    const api = pathApi(input.path);
    const result = entries.filter(entry => entry.isDirectory() ? input.includeDirectories : input.includeFiles)
      .map(entry => ({ Name: entry.name, Path: api.resolve(input.path, entry.name), Type: entry.isDirectory() ? 'Directory' : 'File' }));
    const compare = new Intl.Collator(localization?.context?.culture || 'en-US').compare;
    return result.sort((left, right) => compare(left.Path, right.Path));
  }, { policy, bindQuery: bindDirectory });

  add('POST', '/Environment/ValidatePath', async ({ body, signal }) => {
    const { Path: identity, IsFile, ValidateWritable } = body;
    const fileSystem = storage();
    const entry = await existingPath(fileSystem, identity, signal);
    if (!entry || (IsFile === true && !entry.isFile()) || (IsFile === false && !entry.isDirectory())) return notFound();
    if (IsFile == null && ValidateWritable) {
      if (!entry.isDirectory()) throw httpError(404, 'Path is not a directory.');
      await validateWritable(fileSystem, identity, signal);
    }
    return noContent();
  }, { policy, body: true, bodyParameter: 'validatePathDto', bodyType: validatePathModel.clrType,
    bindBody: (value, source) => {
      if (value === null) throw new BindingError('', 'A non-empty request body is required.');
      return bindJsonModel(value, { schema: validatePathSchema, root: validatePathModel, source });
    } });

  add('GET', '/Environment/Drives', async ({ signal }) => {
    const roots = new Set(browseRoots(storage()).map(prefix => prefix.identityRoot));
    const entries = [];
    for (const root of roots) if ((await existingPath(fileSystem, root, signal))?.isDirectory()) {
      entries.push({ Name: root, Path: root, Type: 'Directory' });
    }
    return entries;
  }, { policy });

  add('GET', '/Environment/ParentPath', ({ queryInput }) => {
    const parent = parentPath(queryInput, browseRoots(fileSystem));
    return parent === null ? noContent() : parent;
  }, { policy, bindQuery: requiredPath });

  add('GET', '/Environment/DefaultDirectoryBrowser', () => ({}), { policy });
}
