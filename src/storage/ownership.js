// Host-owned continuations retain only an already admitted adapter generation.
// Plugins implement the ordinary storage contract; the host supplies this lease.
export const storageOwnership = Symbol('storageOwnership');

export function ownStorageAdapter(adapter) {
  return adapter[storageOwnership]?.() ?? { adapter, close() {} };
}

export function ownStorageDirectory(fileSystem, root) {
  return fileSystem.retainDirectory?.(root) ?? { fileSystem, close() {} };
}

export function ownStorageDirectories(fileSystem, roots, options) {
  return fileSystem.retainDirectories?.(roots, options) ?? { fileSystem, close() {} };
}
