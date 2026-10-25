export function parseLosslessJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && /^-?\d+$/.test(context.source)) return BigInt(context.source);
    return value;
  });
}

const nativeNullFields = Symbol('nativeNullFields');
const nativeFloatFields = Symbol('nativeFloatFields');

// Persisted entity Data keeps the native BasicLatin/HTML-safe string tokens.
// Public JSON uses JSON.stringify after applying the typed value policies.
export function quoteNativeJsonString(value) {
  let output = '"';
  const short = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' };
  for (let index = 0; index < value.length; index++) {
    let code = value.charCodeAt(index);
    const previous = value.charCodeAt(index - 1), next = value.charCodeAt(index + 1);
    if (code >= 0xD800 && code <= 0xDBFF && !(next >= 0xDC00 && next <= 0xDFFF)
      || code >= 0xDC00 && code <= 0xDFFF && !(previous >= 0xD800 && previous <= 0xDBFF)) code = 0xFFFD;
    if (short[code]) output += short[code];
    else if (code === 92) output += '\\\\';
    else if (code < 32 || code > 126 || [34, 38, 39, 43, 60, 62, 96].includes(code)) output += '\\u' + code.toString(16).toUpperCase().padStart(4, '0');
    else output += value[index];
  }
  return output + '"';
}

export function withNativeFloats(value, fields) {
  Object.defineProperty(value, nativeFloatFields, { value: new Set(fields), configurable: true });
  return value;
}

function floatJson(value) {
  const single = Math.fround(value);
  if (!Number.isFinite(single)) throw Object.assign(new TypeError('Non-finite JSON float.'), { status: 400 });
  if (Object.is(single, -0)) return JSON.rawJSON('-0');
  if (single === 0) return 0;
  const bits = new Uint32Array(new Float32Array([single]).buffer)[0];
  const exponent = ((bits >>> 23) & 255) - 127 - 23;
  const significand = BigInt((bits & 0x7fffff) | (exponent === -150 ? 0 : 0x800000));
  const binaryExponent = exponent === -150 ? -149 : exponent;
  const numerator = binaryExponent >= 0 ? significand << BigInt(binaryExponent) : significand;
  const denominator = binaryExponent < 0 ? 1n << BigInt(-binaryExponent) : 1n;
  // Choose the shortest decimal that round-trips to this IEEE-754 binary32.
  for (let precision = 1; precision <= 9; precision++) {
    const decimalExponent = Math.floor(Math.log10(Math.abs(single))) - precision + 1;
    const scaledNumerator = decimalExponent < 0 ? numerator * 10n ** BigInt(-decimalExponent) : numerator;
    const scaledDenominator = decimalExponent > 0 ? denominator * 10n ** BigInt(decimalExponent) : denominator;
    let digits = scaledNumerator / scaledDenominator;
    const remainder = scaledNumerator % scaledDenominator;
    if (remainder * 2n > scaledDenominator || remainder * 2n === scaledDenominator && digits % 2n !== 0n) digits++;
    const candidate = Number(`${single < 0 ? '-' : ''}${digits}e${decimalExponent}`);
    if (Math.fround(candidate) === single) return candidate;
  }
  return single;
}

// A non-null native value can serialize as JSON null, notably Guid.Empty.
// Such fields survive the serializer's ignore-null property policy.
export function withNativeNulls(value, fields) {
  Object.defineProperty(value, nativeNullFields, { value: new Set(fields), configurable: true });
  return value;
}

export function cloneNativeValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneNativeValue);
  if (value instanceof Map) return new Map([...value].map(([key, entry]) => [key, cloneNativeValue(entry)]));
  if (value instanceof Date) return new Date(value);
  const copy = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneNativeValue(entry)]));
  if (value[nativeNullFields]) withNativeNulls(copy, value[nativeNullFields]);
  if (value[nativeFloatFields]) withNativeFloats(copy, value[nativeFloatFields]);
  return copy;
}

function camelCase(name) {
  if (!/^[A-Z]/.test(name)) return name;
  const characters = [...name];
  for (let index = 0; index < characters.length; index++) {
    if (index === 1 && !/[A-Z]/.test(characters[index])) break;
    if (index > 0 && index + 1 < characters.length && !/[A-Z]/.test(characters[index + 1])) break;
    characters[index] = characters[index].toLowerCase();
  }
  return characters.join('');
}

export function stringifyNativeJson(value, { camel = false } = {}) {
  function encode(current, array = false) {
    if (current === null || current === undefined) return array ? null : undefined;
    if (typeof current === 'string') return current.toWellFormed();
    if (typeof current === 'bigint') return JSON.rawJSON(current.toString());
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw Object.assign(new TypeError('Non-finite JSON number.'), { status: 400 });
      return Object.is(current, -0) ? JSON.rawJSON('-0') : current;
    }
    if (Array.isArray(current)) return current.map(value => encode(value, true));
    // .NET DictionaryKeyPolicy is unset: dictionary keys and null entries are preserved.
    // DTO builders must represent native dictionaries as Map, including ProviderIds.
    if (current instanceof Map) return Object.fromEntries([...current].map(([key,value])=>[String(key).toWellFormed(),encode(value,true)]));
    if (typeof current === 'object') {
      if (current instanceof Date) throw new TypeError('Native DateTime values must retain their original precision.');
      return Object.fromEntries(Object.entries(current).filter(([key,value])=>value!==null && value!==undefined || current[nativeNullFields]?.has(key))
        .map(([key,value])=>[(camel ? camelCase(key) : key).toWellFormed(), current[nativeFloatFields]?.has(key) && value != null ? floatJson(value) : encode(value, current[nativeNullFields]?.has(key))]));
    }
    return current;
  }
  return JSON.stringify(encode(value, true));
}
