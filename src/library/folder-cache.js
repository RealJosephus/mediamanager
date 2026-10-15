const caches = new WeakMap();
const key = value => String(value ?? '').replaceAll('-', '').toLowerCase();
const hasIds = item => ['AggregateFolder', 'UserRootFolder'].includes(item.Type);
const entryFor = item => { let entry = caches.get(item); if (!entry) caches.set(item, entry = {}); return entry; };

export function folderChildIds(item) { return hasIds(item) ? caches.get(item)?.ids ?? null : null; }

// An existing live Children value is authoritative even for subclasses whose
// cold LoadChildren is empty. Reading it must neither load nor copy members.
export function cachedFolderChildrenSnapshot(item) { return caches.get(item)?.children ?? undefined; }

export function clearFolderChildIds(item) {
  if (hasIds(item)) delete entryFor(item).ids;
}

export function readCachedFolderChildren(item, state, query) {
  const entry = entryFor(item);
  if (entry.children != null) return entry.children;
  if (hasIds(item)) {
    if (entry.ids == null || item.Type === 'AggregateFolder' && entry.ids.length === 0) {
      entry.children = query(); entry.ids = entry.children.map(child => child.Id);
    } else entry.children = entry.ids.map(id => state.byId.get(key(id))).filter(Boolean);
  } else entry.children = query();
  return entry.children;
}

export function setFolderChildren(item, children) {
  if (children == null && item.Type === 'AggregateFolder') clearFolderChildIds(item);
  entryFor(item).children = children;
}

export function releaseCachedFolderChildren(item) {
  const entry = caches.get(item), children = entry?.children;
  if (entry) delete entry.children;
  for (const child of children ?? []) if (child.IsFolder) releaseCachedFolderChildren(child);
}
