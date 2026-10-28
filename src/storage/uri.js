import { StorageError } from './errors.js';
import { normalizePath } from './paths.js';
import { ordinalIgnoreCaseKey } from './ordinal-comparer.js';

const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

export function identityPathStyle(value) {
  return /^(?:[A-Za-z]:|\\\\)/u.test(value ?? '') ? 'windows'
    : scheme.test(value ?? '') ? 'uri' : 'posix';
}

export function parseSourceUri(value, { prefix = false } = {}) {
  if (typeof value !== 'string' || !scheme.test(value) || /[\0\r\n]/u.test(value)) {
    throw new StorageError('invalid-path', 'The source URI must be absolute.');
  }
  if (prefix && /^[A-Za-z][A-Za-z0-9+.-]*:$/u.test(value)) {
    return { scheme: value.toLowerCase(), origin: null, pathname: '', canonical: value.toLowerCase() };
  }
  let url;
  try { url = new URL(value); }
  catch { throw new StorageError('invalid-path', 'The source URI is invalid.'); }
  if (prefix && (url.search || url.hash || url.username || url.password)) {
    throw new StorageError('invalid-path', 'A source URI prefix cannot contain credentials, a query or a fragment.');
  }
  const origin = url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
  const pathname = prefix ? url.pathname.replace(/\/+$/u, '') : url.pathname;
  return { scheme: url.protocol, origin, pathname, canonical: origin + pathname };
}

export function sourceUriWithin(value, root, caseSensitive = true) {
  const uri = parseSourceUri(value), prefix = parseSourceUri(root, { prefix: true });
  if (uri.scheme !== prefix.scheme || prefix.origin !== null && uri.origin !== prefix.origin) return false;
  if (prefix.origin === null) return true;
  const pathname = caseSensitive ? uri.pathname : ordinalIgnoreCaseKey(uri.pathname);
  const rootPath = caseSensitive ? prefix.pathname : ordinalIgnoreCaseKey(prefix.pathname);
  return !rootPath || pathname === rootPath || pathname.startsWith(rootPath + '/');
}

// A URI is one opaque VFS name. Query spelling and the stored identity survive
// access mapping; VFS path normalization never interprets URI path segments.
export function sourceUriPath(value) {
  parseSourceUri(value);
  try { return '/' + encodeURIComponent(value); }
  catch { throw new StorageError('invalid-path', 'The source URI contains invalid text.'); }
}

export function sourceUriFromPath(value) {
  const path = normalizePath(value);
  if (path === '/' || path.slice(1).includes('/')) throw new StorageError('invalid-path', 'A source URI requires one storage name.');
  let uri;
  try { uri = decodeURIComponent(path.slice(1)); }
  catch { throw new StorageError('invalid-path', 'The encoded source URI is invalid.'); }
  parseSourceUri(uri);
  return uri;
}
