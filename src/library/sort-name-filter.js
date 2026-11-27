import { removeDiacritics } from '../sessions/user-data.js';
import { transliterateSortName } from './transliteration.js';

const nativeDigit = /\p{Nd}/u;

function padSortDigitChunks(value) {
  if (!value.length) return value;
  const chunks = [];
  let start = 0;
  let isDigit = nativeDigit.test(value[0]);
  for (let index = 1; index < value.length; index++) {
    // BaseItem.ModifySortChunks calls char.IsDigit on each UTF-16 code unit.
    const nextIsDigit = nativeDigit.test(value[index]);
    if (nextIsDigit === isDigit) continue;
    const chunk = value.slice(start, index);
    chunks.push(isDigit && chunk.length < 10 ? chunk.padStart(10, '0') : chunk);
    start = index;
    isDigit = nextIsDigit;
  }
  const chunk = value.slice(start);
  chunks.push(isDigit && chunk.length < 10 ? chunk.padStart(10, '0') : chunk);
  return chunks.join('');
}

// Prefixes use the title's character and numeric rules, retaining leading articles.
export function normalizeSortNameFilter(value, configuration = {}) {
  for (const character of configuration.SortRemoveCharacters ?? [',', '&', '-', '{', '}', "'"]) value = value.replaceAll(character, '');
  for (const character of configuration.SortReplaceCharacters ?? ['.', '+', '%']) value = value.replaceAll(character, ' ');
  value = removeDiacritics(padSortDigitChunks(value));
  return /[^\x00-\x7f]/.test(value) ? transliterateSortName(value) : value;
}
