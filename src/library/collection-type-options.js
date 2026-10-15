import { clrTrim } from '../metadata/whitespace.js';

const names = ['movies', 'tvshows', 'music', 'musicvideos', 'homevideos', 'boxsets', 'books', 'mixed'];

/** CollectionTypeOptions is distinct from the larger internal query enum. */
export function parseCollectionTypeOption(value) {
  if (typeof value !== 'string') return null;
  const text = clrTrim(value);
  let number;
  if (/^[+-]?\d+$/u.test(text)) number = Number(text);
  else {
    number = 0;
    for (const part of text.split(',')) {
      const index = names.indexOf(clrTrim(part).toLowerCase());
      if (index < 0) return null;
      number |= index;
    }
  }
  return Number.isInteger(number) && number >= -2147483648 && number <= 2147483647 ? names[number] ?? number : null;
}
