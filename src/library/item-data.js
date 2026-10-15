import { nativeItemDescriptor } from './native-item-entity.js';

export function itemRequiresJson(item) {
  const type = typeof item === 'string' ? item : item?.NativeType ?? item?.Type;
  return nativeItemDescriptor(type).requiresJson;
}
