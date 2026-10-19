import { NativeTextCell, nativeTextBytes, decodeNativeTextBytes } from './native-text.js';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

export function encodeValue(column, value, dialect = 'sqlite') {
  if (value === null) {
    if (!column.nullable) throw new TypeError(`${column.name} cannot be null`);
    return null;
  }
  if (value === undefined) throw new TypeError(`${column.name} cannot be undefined`);
  if (column.type === 'TEXT') return nativeTextBytes(value);
  if (column.type === 'BLOB') {
    if (!(value instanceof Uint8Array)) throw new TypeError(`${column.name} requires bytes`);
    return Buffer.from(value);
  }
  if (column.type === 'REAL') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${column.name} requires a finite floating-point value`);
    return value;
  }
  const type = column.clrType.replace('?', '');
  if (type === 'bool') {
    if (![true, false, 0, 1, 0n, 1n].includes(value)) throw new TypeError(`${column.name} requires boolean or exact 0/1`);
    const boolean = value === true || value === 1 || value === 1n;
    return dialect === 'postgres' ? boolean : boolean ? 1n : 0n;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${column.name} requires a safe integer or BigInt`);
    value = BigInt(value);
  }
  if (typeof value !== 'bigint') throw new TypeError(`${column.name} requires integer`);
  const [min, max] = type === 'int' ? [-2147483648n, 2147483647n] : type === 'uint' ? [0n, 4294967295n] : [INT64_MIN, INT64_MAX];
  if (value < min || value > max) throw new RangeError(`${column.name} exceeds ${type} range`);
  return dialect === 'postgres' ? value.toString() : value;
}

export function decodeValue(column, value, dialect = 'sqlite', consumer = 'runtime') {
  if (value === null) return null;
  if (column.type === 'TEXT') return decodeNativeTextBytes(value, consumer);
  if (column.type === 'BLOB') return Buffer.from(value);
  if (column.type !== 'INTEGER') return value;
  if (column.clrType.replace('?', '') === 'bool') {
    if (![true, false, 0, 1, 0n, 1n].includes(value)) throw new TypeError(`Invalid native boolean: ${column.name}`);
    return value === true || value === 1 || value === 1n;
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`Lossy integer result: ${column.name}`);
  const integer = BigInt(value);
  encodeValue(column, integer, dialect);
  return ['long', 'uint'].includes(column.clrType.replace('?', '')) ? integer : Number(integer);
}

export function encodeValueSet(column, values, dialect = 'sqlite') {
  if (!Array.isArray(values)) throw new TypeError('whereIn values must be arrays');
  const encoded = Array.from(values, value => encodeValue(column, value, dialect));
  // A single set parameter avoids SQLite/PostgreSQL parameter-count limits.
  // SQLite JSON stores integers as decimal strings so Int64 never crosses a
  // JavaScript Number. Its typed SQL projection restores the native affinity.
  return {
    includesNull: encoded.includes(null),
    values: encoded.filter(value => value !== null).map(value => dialect === 'sqlite'
      ? typeof value === 'bigint' ? value.toString() : Buffer.isBuffer(value) ? value.toString('hex') : value
      : value)
  };
}

export function canonicalCell(value) {
  if (value === null) return ['null'];
  if (value instanceof NativeTextCell) return value.canonical();
  if (typeof value === 'bigint') return ['integer', value.toString()];
  if (typeof value === 'boolean') return ['boolean', value];
  if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('base64')];
  if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
  if (typeof value === 'string') return ['text', value];
  throw new TypeError(`Unsupported value: ${typeof value}`);
}
