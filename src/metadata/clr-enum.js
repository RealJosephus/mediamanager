import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { clrTrim } from './whitespace.js';

const int32Minimum = -2147483648;
const int32Maximum = 2147483647;

/**
 * Mirrors Enum.TryParse for an Int32-backed enum: numeric input may name an
 * undefined value, while comma-separated input is a list of names combined
 * with bitwise OR. Numeric components inside a comma list are not names.
 */
export function tryParseClrInt32Enum(raw, names, { ignoreCase = false } = {}) {
  const value = clrTrim(String(raw ?? ''));
  if (!value) return null;
  const numeric = value.replace(/\0+$/u, '');
  if (/^[+-]?\d+$/u.test(numeric)) {
    const number = Number(numeric);
    if (!Number.isInteger(number) || number < int32Minimum || number > int32Maximum) return null;
    return names[number] ?? number;
  }
  let number = 0;
  for (const part of value.split(',')) {
    const name = clrTrim(part);
    const index = names.findIndex(candidate => ignoreCase ? ordinalIgnoreCaseEquals(candidate, name) : candidate === name);
    if (index < 0) return null;
    number |= index;
  }
  return names[number] ?? number;
}
