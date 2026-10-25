import { StorageError } from './errors.js';

// Paths are already decoded at the caller boundary. Percent sequences are literal names.
export function normalizePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\\0]/u.test(value)) {
    throw new StorageError('invalid-path', 'A storage path must be absolute and use forward slashes.');
  }
  const parts = value.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new StorageError('invalid-path', 'Relative path segments are not allowed.');
  }
  return `/${parts.join('/')}`;
}

export function validateName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\0]/u.test(name)) {
    throw new StorageError('invalid-path', 'A storage name must be one nonempty path segment.');
  }
  return name;
}

export function isWithin(path, root) {
  return path === root || (root === '/' ? path.startsWith('/') : path.startsWith(`${root}/`));
}

export function joinPath(root, relative) {
  return normalizePath(`${root}/${relative}`);
}

export function parentPath(path) {
  path = normalizePath(path);
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

export function baseName(path) {
  return normalizePath(path).split('/').at(-1);
}
