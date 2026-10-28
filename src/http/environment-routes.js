import path from 'node:path';
import { BindingError, booleanValue, httpError, queryValue } from './binding.js';
import { clrTrim } from '../metadata/whitespace.js';

function bindDirectory(query) {
  const input = {}, errors = {};
  for (const name of ['path', 'includeFiles', 'includeDirectories']) {
    const value = queryValue(query, name);
    try {
      if (name === 'path') {
        if (value == null || clrTrim(value) === '') throw new BindingError(name, 'The path field is required.');
        input.path = value;
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

/** EnvironmentController directory browsing uses the configured storage namespace. */
export function registerEnvironmentRoutes(add, { fileSystem, localization }) {
  add('GET', '/Environment/DirectoryContents', async context => {
    const input = context.queryInput;
    // The designated controller treats a bare UNC server as an empty listing
    // before attempting filesystem enumeration, on every host platform.
    if (input.path.startsWith('\\\\') && input.path.lastIndexOf('\\') === 1) return [];
    if (!fileSystem) throw httpError(503, 'Storage is unavailable.');
    let entries;
    try { entries = await fileSystem.readdir(input.path, { withFileTypes: true, signal: context.signal }); }
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
    const api = /^[A-Za-z]:[\\/]|^\\\\/u.test(input.path) ? path.win32 : path.posix;
    const result = entries.filter(entry => entry.isDirectory() ? input.includeDirectories : input.includeFiles)
      .map(entry => ({ Name: entry.name, Path: api.resolve(input.path, entry.name), Type: entry.isDirectory() ? 'Directory' : 'File' }));
    const compare = new Intl.Collator(localization?.context?.culture || 'en-US').compare;
    return result.sort((left, right) => compare(left.Path, right.Path));
  }, { policy: 'FirstTimeSetupOrElevated', bindQuery: bindDirectory });
}
