import path from 'node:path';
import { nativeFileName } from '../library/native-path.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { clrWhitespace, clrTrim } from './whitespace.js';

const keywords = '시즌|シーズン|сезон|season|sæson|saison|staffel|series|stagione|säsong|seizoen|seasong|sezon|sezona|sezóna|sezonul|série|séria|serie|seria|temporada|kausi';
const whitespace = `[${clrWhitespace}]`, digit = '\\p{Nd}';
const prefix = new RegExp(`[sS](${digit}{1,4})(?!${digit}|[eE]${digit})(?=\\.|_|-|\\[|\\]|${whitespace}|$)`, 'u');
// The negative digit lookahead preserves the native atomic digit group.
const pre = new RegExp(`^${whitespace}*(?<seasonnumber>${digit}+)(?!${digit})(?:st|nd|rd|th|\\.)*(?!${whitespace}*[Ee]${digit}+)${whitespace}*(?:${keywords})${whitespace}*(?<rightpart>.*)$`, 'iu');
const post = new RegExp(`^${whitespace}*(?:${keywords})${whitespace}*(?<seasonnumber>${digit}+?)(?=${digit}{3,4}p|[^${digit}]|$)(?!${whitespace}*[Ee]${digit})(?<rightpart>.*)$`, 'iu');
const keyword = new RegExp(keywords, 'iu');
const clean = value => value.replace(/[ ._\-\[\]]/gu, '');
const nativeError = (message, nativeException) => Object.assign(new Error(message), { nativeException });

function int32(value) {
  if (value == null || !/^[+-]?[0-9]+$/u.test(clrTrim(value))) return null;
  const number = Number(clrTrim(value));
  return Number.isInteger(number) && number >= -2147483648 && number <= 2147483647 ? number : null;
}

function directoryName(value) {
  if (!value || value.includes('\0')) throw nativeError('Invalid season parent directory.', 'ArgumentException');
  const api = process.platform === 'win32' || /^[A-Za-z]:|\\/u.test(value) ? path.win32 : path.posix;
  const full = api.resolve(value), root = api.parse(full).root;
  return full === root ? root : api.basename(full);
}

function removeParent(value, parent) {
  if (!parent) throw nativeError('The normalized parent name is empty.', 'ArgumentException');
  const parentKey = ordinalIgnoreCaseKey(parent);
  let result = '';
  for (let index = 0; index < value.length;) {
    if (ordinalIgnoreCaseKey(value.slice(index, index + parent.length)) === parentKey) index += parent.length;
    else result += value[index++];
  }
  return result;
}

export function parseSeasonPath(value, parentPath = null, { supportSpecialAliases = true, supportNumericSeasonFolders = true } = {}) {
  const parentName = parentPath == null ? null : directoryName(parentPath);
  const fileName = nativeFileName(value);
  // Native regex rejects null rather than treating it as an empty path.
  if (fileName == null) throw nativeError('Season path is null.', 'ArgumentNullException');
  const prefixNumber = int32(prefix.exec(fileName)?.[1]);
  if (prefixNumber != null) return { SeasonNumber: prefixNumber, Success: true, IsSeasonFolder: true };
  let name = clean(fileName);
  if (parentName != null) name = removeParent(name, clean(parentName));
  let number = supportSpecialAliases && ['SPECIALS', 'EXTRAS'].includes(ordinalIgnoreCaseKey(name)) ? 0 : null;
  if (number == null && supportNumericSeasonFolders) number = int32(name);
  if (number == null) {
    const match = pre.exec(name) ?? post.exec(name);
    if (match && (supportSpecialAliases || supportNumericSeasonFolders || keyword.test(fileName))) number = int32(match.groups.seasonnumber);
  }
  return { SeasonNumber: number, Success: number != null, IsSeasonFolder: number != null };
}
