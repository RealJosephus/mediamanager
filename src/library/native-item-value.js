/** Copy native DTO values through observable properties, including proxy-backed
 * dictionaries and arrays. Relationship handles belong to entity ownership. */
export function cloneNativeItemValue(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return value instanceof DataView
    ? new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength) : value.slice();
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (value instanceof Map) { const copy = new Map(); seen.set(value, copy);
    for (const [key, entry] of value) copy.set(cloneNativeItemValue(key, seen), cloneNativeItemValue(entry, seen)); return copy; }
  if (value instanceof Set) { const copy = new Set(); seen.set(value, copy);
    for (const entry of value) copy.add(cloneNativeItemValue(entry, seen)); return copy; }
  const copy = Array.isArray(value) ? [] : {}; seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) Object.defineProperty(copy, key, {
    value: cloneNativeItemValue(entry, seen), enumerable: true, writable: true, configurable: true
  });
  return copy;
}
