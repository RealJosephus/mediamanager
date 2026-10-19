import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const lowerMap = JSON.parse(readFileSync(new URL('./resources/invariant-lower.json', import.meta.url), 'utf8'));

export function lowerInvariant(value) {
  return [...value].map(character => lowerMap[character] ?? character).join('');
}

export function md5Guid(value) {
  // Encoding.Unicode uses U+FFFD for unpaired UTF-16 surrogates.
  const bytes = createHash('md5').update(Buffer.from(value.toWellFormed(), 'utf16le')).digest();
  const swapped = Buffer.from(bytes);
  swapped.writeUInt32BE(bytes.readUInt32LE(0), 0);
  swapped.writeUInt16BE(bytes.readUInt16LE(4), 4);
  swapped.writeUInt16BE(bytes.readUInt16LE(6), 6);
  return swapped.toString('hex');
}

export function getNewItemId(key, typeName, { programDataPath, enableCaseSensitiveItemIds = false, forceCaseInsensitive = false } = {}) {
  if (typeof key !== 'string' || !key) throw new TypeError('The identity key must be a nonempty string.');
  if (typeof typeName !== 'string' || !typeName) throw new TypeError('The native full type name is required.');
  if (typeof programDataPath !== 'string' || !programDataPath) throw new TypeError('The native program data path is required.');
  // Preserve the baseline ordinal prefix behavior, including non-segment prefixes.
  if (key.startsWith(programDataPath)) key = key.slice(programDataPath.length).replace(/^[/\\]+/, '').replaceAll('/', '\\');
  if (forceCaseInsensitive || !enableCaseSensitiveItemIds) key = lowerInvariant(key);
  return md5Guid(typeName + key);
}
