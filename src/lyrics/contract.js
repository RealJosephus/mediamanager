const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const metadataStrings = ['Artist', 'Album', 'Title', 'Author', 'By', 'Creator', 'Version'];
const int64 = value => (typeof value === 'bigint' || Number.isSafeInteger(value))
  && BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n;

export const lyricSignalPositions = Object.freeze({ search: 1, getLyrics: 1 });

export function validateLyricExtension(value) {
  if (!object(value) || !text(value.name) || typeof value.search !== 'function' || typeof value.getLyrics !== 'function') {
    throw new TypeError('A lyric extension requires name, search and getLyrics.');
  }
  if (value.order !== undefined && (!Number.isInteger(value.order) || value.order < -2147483648 || value.order > 2147483647)) {
    throw new TypeError('A lyric provider order must be an Int32.');
  }
}

function response(value) {
  if (!object(value) || typeof value.format !== 'string' || !(value.bytes instanceof Uint8Array)) {
    throw new TypeError('A lyric response requires a format string and detached bytes.');
  }
  return { format: value.format, bytes: Buffer.from(value.bytes) };
}

function metadata(value) {
  if (value === null) return null;
  if (!object(value)) throw new TypeError('Lyric search metadata must be an object or null.');
  const result = {};
  for (const key of metadataStrings) if (value[key] !== undefined) {
    if (value[key] !== null && typeof value[key] !== 'string') throw new TypeError(`Lyric metadata ${key} must be text or null.`);
    result[key] = value[key];
  }
  for (const key of ['Length', 'Offset']) if (value[key] !== undefined) {
    if (value[key] !== null && !int64(value[key])) throw new TypeError(`Lyric metadata ${key} requires exact Int64 ticks or null.`);
    result[key] = value[key] === null ? null : BigInt(value[key]);
  }
  if (value.IsSynced !== undefined) {
    if (value.IsSynced !== null && typeof value.IsSynced !== 'boolean') throw new TypeError('Lyric metadata IsSynced must be boolean or null.');
    result.IsSynced = value.IsSynced;
  }
  return result;
}

/** Transfer Node-owned values out of the plugin call before it settles. The
 * provider owns and closes upstream readers inside search/getLyrics. */
export function copyLyricProviderResult(method, value) {
  if (method === 'getLyrics') return value === null ? null : response(value);
  if (!Array.isArray(value)) throw new TypeError('Lyric search must return an array.');
  return value.map(entry => {
    if (!object(entry) || typeof entry.id !== 'string' || typeof entry.providerName !== 'string') {
      throw new TypeError('A lyric search entry requires id and providerName strings.');
    }
    return { id: entry.id, providerName: entry.providerName, metadata: metadata(entry.metadata), lyrics: response(entry.lyrics) };
  });
}
