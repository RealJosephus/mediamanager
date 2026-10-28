import { StorageError } from './errors.js';

export function singleRange(value) {
  if (value === undefined) return undefined;
  const match = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(value);
  if (!match || !match[1] && !match[2]) throw new StorageError('not-supported', 'Only a single byte range is supported.');
  if (!match[1]) {
    if (BigInt(match[2]) === 0n) throw new StorageError('range-not-satisfiable', 'The suffix range is empty.');
    return { suffix: BigInt(match[2]) };
  }
  const result = { start: BigInt(match[1]) };
  if (match[2]) result.end = BigInt(match[2]);
  if (result.end !== undefined && result.end < result.start) throw new StorageError('range-not-satisfiable', 'The range is reversed.');
  return result;
}

export function unsignedInteger(value, label = 'value') {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/u.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be an exact nonnegative integer.`);
}

export function normalizeRange(range) {
  if (range == null) return null;
  if (range.suffix !== undefined) {
    if (range.start !== undefined || range.end !== undefined) throw new TypeError('Suffix and offset ranges cannot be combined.');
    const suffix = unsignedInteger(range.suffix, 'suffix');
    if (suffix === 0n) throw new TypeError('A suffix range must have positive length.');
    return { suffix };
  }
  const start = unsignedInteger(range.start, 'start');
  const end = range.end == null ? null : unsignedInteger(range.end, 'end');
  if (end !== null && end < start) throw new TypeError('The range end precedes its start.');
  return { start, end };
}

export function rangeHeader(range) {
  range = normalizeRange(range);
  if (!range) return undefined;
  return range.suffix !== undefined ? `bytes=-${range.suffix}` : `bytes=${range.start}-${range.end ?? ''}`;
}

export function resolveRange(range, size) {
  range = normalizeRange(range);
  size = unsignedInteger(size, 'size');
  if (!range) return size === 0n ? null : { start: 0n, end: size - 1n };
  if (size === 0n || (range.start !== undefined && range.start >= size)) {
    throw new StorageError('range-not-satisfiable', 'The requested range is outside the object.', { totalSize: size });
  }
  if (range.suffix !== undefined) return { start: range.suffix >= size ? 0n : size - range.suffix, end: size - 1n };
  return { start: range.start, end: range.end === null || range.end >= size ? size - 1n : range.end };
}

export function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(value ?? '');
  if (!match) throw new StorageError('invalid-response', 'The backend returned an invalid byte range.');
  const start = BigInt(match[1]);
  const end = BigInt(match[2]);
  const totalSize = match[3] === '*' ? null : BigInt(match[3]);
  if (end < start || (totalSize !== null && end >= totalSize)) {
    throw new StorageError('invalid-response', 'The backend returned an inconsistent byte range.');
  }
  return { start, end, totalSize };
}
