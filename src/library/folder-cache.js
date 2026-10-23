const caches = new WeakMap();
const invalidationListeners = new WeakMap();
const idInvalidationListeners = new WeakMap();
const assignmentListeners = new WeakMap();
const hasIds = item => ['AggregateFolder', 'UserRootFolder'].includes(item.Type);
const entryFor = item => { let entry = caches.get(item); if (!entry) caches.set(item, entry = {}); return entry; };

// An existing live Children value is authoritative even for subclasses whose
// cold LoadChildren is empty. Reading it must neither load nor copy members.
export function cachedFolderChildrenSnapshot(item) { return caches.get(item)?.children ?? undefined; }

function observe(mapping, item, listener, message) {
  if (typeof listener !== 'function') throw new TypeError(message);
  let listeners = mapping.get(item);
  if (!listeners) mapping.set(item, listeners = new Set());
  listeners.add(listener);
  const reference = new WeakRef(item);
  let released = false;
  return Object.freeze({ release() {
    if (released) return;
    released = true;
    listeners.delete(listener);
    const current = reference.deref();
    if (current && !listeners.size && mapping.get(current) === listeners) mapping.delete(current);
  } });
}

export function observeFolderChildrenAssignment(item, listener) {
  return observe(assignmentListeners, item, listener, 'A Folder Children assignment listener is required.');
}

function assigned(item) {
  for (const listener of assignmentListeners.get(item) ?? []) listener();
}

export function observeFolderChildrenInvalidation(item, listener) {
  return observe(invalidationListeners, item, listener, 'A Folder cache invalidation listener is required.');
}

function invalidate(item) {
  for (const listener of invalidationListeners.get(item) ?? []) listener();
}

export function clearFolderChildIds(item) {
  if (!hasIds(item)) return;
  for (const listener of idInvalidationListeners.get(item) ?? []) listener();
}

export function observeFolderChildIdsInvalidation(item, listener) {
  return observe(idInvalidationListeners, item, listener, 'A Folder ID cache invalidation listener is required.');
}

export function readCachedFolderChildren(item, _state, query) {
  const entry = entryFor(item);
  if (entry.children != null) { assigned(item); return entry.children; }
  entry.children = query();
  assigned(item);
  return entry.children;
}

export function setFolderChildren(item, children) {
  invalidate(item);
  if (children == null && item.Type === 'AggregateFolder') clearFolderChildIds(item);
  entryFor(item).children = children;
  assigned(item);
}

export function releaseCachedFolderChildren(item) {
  invalidate(item);
  const entry = caches.get(item), children = entry?.children;
  if (entry) delete entry.children;
  assigned(item);
  for (const child of children ?? []) if (child.IsFolder) releaseCachedFolderChildren(child);
}
