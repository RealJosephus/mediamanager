import { sortName } from '../library/dto.js';
import { clearNativeItemSortCache, configureNativeItemSort, isNativeItemEntity } from '../library/native-item-entity.js';

const caches = new WeakMap();

export function attachMetadataSortCache(item, options = {}) {
  if (isNativeItemEntity(item)) return configureNativeItemSort(item, options);
  if (caches.has(item)) return item;
  const state = { value: null, options };
  caches.set(item, state);
  for (const field of ['Name', 'ForcedSortName']) {
    let value = item[field];
    Object.defineProperty(item, field, { enumerable: true, configurable: true,
      get: () => value, set: next => { value = next; state.value = null; } });
  }
  Object.defineProperty(item, 'SortName', { enumerable: true, configurable: true,
    get: () => state.value ??= sortName(item, state.options), set: value => { state.value = value; } });
  return item;
}

export function metadataSortName(item, options = {}) {
  return attachMetadataSortCache(item, options).SortName;
}

export function clearMetadataSortCache(item) {
  if (isNativeItemEntity(item)) return clearNativeItemSortCache(item);
  const state = caches.get(item);
  if (state) state.value = null;
}
