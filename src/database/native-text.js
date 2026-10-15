import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { nativePathKey } from '../library/native-path.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A raw native SQLite TEXT cell. Its bytes remain authoritative even when
 * they are not valid Unicode or JSON. Runtime strings are separate views. */
export class NativeTextCell {
  #bytes;
  constructor(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('Native TEXT cells require bytes.');
    this.#bytes = Buffer.from(bytes);
    Object.freeze(this);
  }
  bytes() { return Buffer.from(this.#bytes); }
  string() { return decoder.decode(this.#bytes); }
  equals(other) { return other instanceof NativeTextCell && this.#bytes.equals(other.#bytes); }
  canonical() { return ['text-bytes', this.#bytes.toString('base64')]; }
}

export function nativeTextCell(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) throw new TypeError('Runtime TEXT must be a well-formed string.');
  return new NativeTextCell(Buffer.from(value, 'utf8'));
}

export function nativeTextBytes(value) {
  if (value instanceof NativeTextCell) return value.bytes();
  return nativeTextCell(value).bytes();
}

export function decodeNativeTextBytes(value, consumer = 'runtime') {
  if (!['runtime', 'exchange'].includes(consumer)) throw new TypeError('Unknown native TEXT consumer.');
  const cell = new NativeTextCell(value);
  return consumer === 'exchange' ? cell : cell.string();
}

const runtimeString = value => value instanceof NativeTextCell ? value.string() : nativeTextCell(value).string();

/** SQL projections are derived views; NUL and literal SOH have distinct escapes. */
export function nativeTextProjection(value) {
  return runtimeString(value).replaceAll('\u0001', '\u00011').replaceAll('\0', '\u00010');
}

export function nativeTextFromProjection(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) {
    throw new TypeError('A canonical native TEXT projection is required.');
  }
  let result = '';
  for (let position = 0; position < value.length; position++) {
    if (value[position] !== '\u0001') { result += value[position]; continue; }
    const escape = value[++position];
    if (escape === '0') result += '\0';
    else if (escape === '1') result += '\u0001';
    else throw new TypeError('Non-canonical native TEXT escape.');
  }
  return result;
}

export function nativeTextOrdinalKey(value) {
  return Buffer.from(runtimeString(value), 'utf16le').swap16();
}

export function nativeTextOrdinalIgnoreCaseKey(value) {
  return nativeTextOrdinalKey(ordinalIgnoreCaseKey(runtimeString(value)));
}

export function nativeTextPathKey(value) {
  if (value == null) return null;
  const key = nativePathKey(runtimeString(value));
  return key === null ? null : nativeTextOrdinalKey(key);
}

export function nativeRatingCountryContext(country, defaultCountry) {
  return JSON.stringify([country, defaultCountry].map(value => value == null ? null : nativeTextProjection(value)));
}
