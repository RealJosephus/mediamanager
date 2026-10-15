import { collectionTypeNames } from '../library/user-view-query.js';
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';

function collectionEnum(text) {
  let value = 0;
  for (const part of text.split(',')) {
    const token = clrTrim(part);
    let number;
    if (/^[+-]?\d+$/.test(token)) number = Number(token);
    else number = collectionTypeNames.findIndex(name => name != null && ordinalIgnoreCaseEquals(name, token));
    if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647 || number === -1 && !/^[+-]?\d+$/.test(token)) throw new TypeError('Invalid collection enum.');
    value |= number;
  }
  return collectionTypeNames[value] ?? value;
}

export function bindUserViewPresets(query) {
  const values = [...query].filter(([name]) => name.toLowerCase() === 'presetviews').map(([, value]) => value);
  const entries = values.length > 1 ? values : values[0]?.split(',').filter(Boolean) ?? [];
  return entries.flatMap(value => {
    const text = clrTrim(value);
    if (text === '') return [null];
    try { return [collectionEnum(text)]; }
    catch { return []; }
  });
}
