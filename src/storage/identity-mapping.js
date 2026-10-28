import { StorageError } from './errors.js';
import { isWithin, joinPath, normalizePath } from './paths.js';
import { ordinalIgnoreCaseKey } from './ordinal-comparer.js';
import { identityPathStyle, parseSourceUri, sourceUriWithin, sourceUriPath, sourceUriFromPath } from './uri.js';

function bindingKey(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('An item ID is required.');
  return /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.test(value) ? value.replaceAll('-', '').toLowerCase() : value;
}

function validateIdentity(path, style) {
  if (style === 'uri') return parseSourceUri(path, { prefix: true }).canonical;
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new StorageError('invalid-path', 'The identity path is invalid.');
  const canonical = style === 'windows' ? path.replaceAll('\\', '/')
    .replace(/^\/\/\?\/UNC\//iu, '//').replace(/^\/\/\?\/(?=[A-Za-z]:\/)/u, '') : path;
  if (canonical.split('/').some((part) => part === '.' || part === '..')) throw new StorageError('invalid-path', 'Identity paths cannot contain relative segments.');
  if (style === 'windows' ? !/^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+)/u.test(canonical) : !canonical.startsWith('/')) {
    throw new StorageError('invalid-path', 'The identity path must be absolute in its declared path style.');
  }
  return canonical.replace(/\/+$/u, '') || '/';
}

// This maps access only. It never changes the original media ID or identity Path.
export class IdentityAccessMap {
  #bindings = new Map();
  #prefixes = [];

  bind(itemId, virtualPath) {
    this.#bindings.set(bindingKey(itemId), normalizePath(virtualPath));
  }

  addPrefix({ identityRoot, accessRoot, style = 'posix', caseSensitive = true, returnAccess }) {
    if (!['posix', 'windows', 'uri'].includes(style)) throw new TypeError('An explicit supported path style is required.');
    if (typeof caseSensitive !== 'boolean') throw new TypeError('Identity caseSensitive must be a boolean.');
    const canonicalRoot = validateIdentity(identityRoot, style);
    accessRoot = normalizePath(accessRoot);
    if (typeof returnAccess !== 'string' || !returnAccess.trim()) {
      throw new TypeError('A return-migration access plan must be recorded.');
    }
    if (this.#prefixes.some((mapping) => mapping.style === style && (mapping.caseSensitive && caseSensitive ? mapping.canonicalRoot === canonicalRoot : ordinalIgnoreCaseKey(mapping.canonicalRoot) === ordinalIgnoreCaseKey(canonicalRoot)))) {
      throw new StorageError('already-exists', 'The identity root is already mapped.');
    }
    if (this.#prefixes.some((mapping) => isWithin(accessRoot, mapping.accessRoot) || isWithin(mapping.accessRoot, accessRoot))) {
      throw new StorageError('already-exists', 'Overlapping access roots would make reverse identity mapping ambiguous.');
    }
    this.#prefixes.push(Object.freeze({ identityRoot, accessRoot, style, caseSensitive, canonicalRoot, returnAccess }));
  }

  resolve({ itemId, identityPath, style = identityPathStyle(identityPath) }) {
    if (itemId && this.#bindings.has(bindingKey(itemId))) return this.#bindings.get(bindingKey(itemId));
    if (style === 'uri') {
      parseSourceUri(identityPath);
      const mapping = this.#prefixes.filter(item => item.style === 'uri' && sourceUriWithin(identityPath, item.identityRoot, item.caseSensitive))
        .sort((left, right) => right.canonicalRoot.length - left.canonicalRoot.length)[0];
      if (!mapping) throw new StorageError('not-found', 'No access mapping resolves the source URI.');
      return joinPath(mapping.accessRoot, sourceUriPath(identityPath));
    }
    const canonical = validateIdentity(identityPath, style);
    const mapping = this.#prefixes.filter((item) => item.style === style && isWithin(item.caseSensitive ? canonical : ordinalIgnoreCaseKey(canonical), item.caseSensitive ? item.canonicalRoot : ordinalIgnoreCaseKey(item.canonicalRoot)))
      .sort((left, right) => right.canonicalRoot.length - left.canonicalRoot.length)[0];
    if (!mapping) throw new StorageError('not-found', 'No access mapping resolves the identity path.');
    return joinPath(mapping.accessRoot, canonical.slice(mapping.canonicalRoot.length));
  }

  identityFor(virtualPath) {
    virtualPath = normalizePath(virtualPath);
    const mapping = this.#prefixes.find((item) => isWithin(virtualPath, item.accessRoot));
    if (!mapping) throw new StorageError('not-found', 'No reversible identity mapping resolves the virtual path.');
    const suffix = virtualPath.slice(mapping.accessRoot === '/' ? 1 : mapping.accessRoot.length + 1);
    if (mapping.style === 'uri') {
      const identityPath = sourceUriFromPath('/' + suffix);
      if (!sourceUriWithin(identityPath, mapping.identityRoot, mapping.caseSensitive)) throw new StorageError('not-found', 'The source URI is outside its access mapping.');
      return { identityPath, style: 'uri', returnAccess: mapping.returnAccess };
    }
    const separator = mapping.style === 'windows' && mapping.identityRoot.includes('\\') ? '\\' : '/';
    const root = mapping.identityRoot.replace(/[\\/]+$/u, '');
    return { identityPath: suffix ? `${root}${separator}${suffix.replaceAll('/', separator)}` : mapping.identityRoot,
      style: mapping.style, returnAccess: mapping.returnAccess };
  }

  exportState() {
    return { bindings: [...this.#bindings].map(([itemId, accessPath]) => ({ itemId, accessPath })),
      prefixes: this.#prefixes.map(({ canonicalRoot, ...mapping }) => mapping) };
  }
}
