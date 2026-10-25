import { transliterate } from 'transliteration';
import { lowerInvariant } from '../core/identity.js';
import data from './resources/sort-name-data.json' with { type: 'json' };

// Selected Unicode 10 / ICU 60 text rules, not an ICU runtime or rule interpreter.
// Source versions and Unicode license are beside the generated JSON resource.
function property(character, ranges, fallback = '') {
  if (!character) return fallback;
  const point = character.codePointAt(0);
  let first = 0, last = ranges.length - 1;
  while (first <= last) {
    const middle = (first + last) >>> 1, row = ranges[middle];
    if (point < row[0]) last = middle - 1;
    else if (point > row[1]) first = middle + 1;
    else return row[2] ?? true;
  }
  return fallback;
}
const script = character => property(character, data.scripts, 'Unknown');
const category = character => property(character, data.categories);
const common = character => ['Common', 'Inherited'].includes(script(character));
const letter = character => category(character).startsWith('L');
const mark = character => category(character).startsWith('M');
const ideographic = character => property(character, data.ideographic, false);
const replaceCharacters = (value, map) => [...value].map(ch => Object.hasOwn(map, ch) ? map[ch] : ch).join('');
const han = new Map(data.han.flatMap(([reading, characters]) => [...characters].map(ch => [ch, reading])));

function normalizeFiltered(value, included, form) {
  let result = '', run = '';
  for (const ch of value) {
    if (included(ch)) run += ch;
    else { result += run.normalize(form) + ch; run = ''; }
  }
  return result + run.normalize(form);
}

function literalMapper(map) {
  const pattern = new RegExp(Object.keys(map).sort((a, b) => b.length - a.length)
    .map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gu');
  return value => value.replace(pattern, key => map[key]);
}
const cyrillicLatin = literalMapper(data.cyrillic), arabicLatin = literalMapper(data.arabic);
const armenianLatin = literalMapper(data.armenian), georgianLatin = literalMapper(data.georgian), thaanaLatin = literalMapper(data.thaana);
const hebrewLatin = literalMapper(data.hebrew);

function hanLatin(value, context) {
  // Han-Spacedhan normalizes only its explicit compatibility set, not all text.
  value = [...value].map(ch => ideographic(ch) || script(ch) === 'Han'
    || /[\u3192-\u319f\u3220-\u3247\u3280-\u32b0\u32c0-\u32cb\u3358-\u3370\u337b-\u337f\u33e0-\u33fe\u{1f210}-\u{1f212}\u{1f214}-\u{1f23a}\u{1f240}-\u{1f248}\u{1f250}\u{1f251}]/u.test(ch)
    ? ch.normalize('NFKC') : ch).join('');
  // The frozen Han-Spacedhan path retains these widths after Any-Latin's fix.
  value = value.replaceAll('｡', '.');
  // Only the preceding letter and its marks participate in the spacing rule.
  // Avoid repeatedly materializing a long prefix in mixed-script titles.
  let contextStart = context.length;
  while (contextStart && mark(characterAt(context, contextStart - 1))) contextStart -= characterAt(context, contextStart - 1).length;
  if (contextStart) contextStart -= characterAt(context, contextStart - 1).length;
  context = context.slice(contextStart);
  const characters = [...context, ...value], start = [...context].length;
  let spaced = '';
  for (let index = start; index < characters.length; index++) {
    const current = characters[index], previous = characters[index - 1];
    let priorLetter = index - 1;
    while (priorLetter >= 0 && mark(characters[priorLetter])) priorLetter--;
    const terminal = previous && (/[.,:;?!．，：？！｡、；]/u.test(previous) || ['Pe', 'Pf'].includes(category(previous)));
    const initial = ['Ps', 'Pi'].includes(category(current));
    if ((ideographic(previous) || terminal) && letter(current)
      || letter(characters[priorLetter]) && (ideographic(current) || initial)) spaced += ' ';
    spaced += current;
  }
  // The four contextual readings precede the general Han reading table.
  spaced = spaced.replace(/藏(?= ?文)/gu, 'zang').replace(/重(?= ?庆)/gu, 'chong')
    .replace(/沈(?= ?阳)/gu, 'shen').replace(/秘(?= ?鲁)/gu, 'bi');
  return [...spaced].map(ch => han.get(ch) ?? ch).join('');
}

const leadingJamo = ['g', 'kk', 'n', 'd', 'tt', 'l', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const medialJamo = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const finalJamo = ['g', 'kk', 'gs', 'n', 'nj', 'nh', 'd', 'l', 'lg', 'lm', 'lb', 'ls', 'lt', 'lp', 'lh', 'm', 'b', 'bs', 's', 'ss', 'ng', 'j', 'ch', 'k', 't', 'p', 'h'];
function hangulLatin(value) {
  return [...value].map(ch => /[\u1100-\u1112\u1161-\u1175\u11a8-\u11c2\u3131-\u313f\u3141-\u3143\u3145-\u3163\u3200-\u321c\u3260-\u327b\uac00-\ud7a3]/u.test(ch)
    ? ch.normalize('NFKD') : ch).join('').replace(/[\u1100-\u1112\u1161-\u1175\u11a8-\u11c2]/gu, ch => {
    const point = ch.codePointAt(0);
    return point <= 0x1112 ? leadingJamo[point - 0x1100]
      : point <= 0x1175 ? medialJamo[point - 0x1161] : finalJamo[point - 0x11a8];
  });
}

const kanaKeys = Object.keys(data.kana).sort((a, b) => b.length - a.length);
const smallY = { ャ: 'ya', ィ: 'yi', ュ: 'yu', ェ: 'ye', ョ: 'yo' };
function kanaLatin(value, context, following) {
  value = normalizeFiltered(value, ch => !mark(ch) || /[\u0304\u3099\u309a]/u.test(ch), 'NFD');
  value = [...value].map(ch => /[\u3041-\u3094\u309d\u309e]/u.test(ch)
    ? String.fromCodePoint(ch.codePointAt(0) + 0x60) : ch).join('');
  let output = '';
  for (let index = 0; index < value.length;) {
    let key = kanaKeys.find(key => value.startsWith(key, index));
    let latin = key === undefined ? String.fromCodePoint(value.codePointAt(index)) : data.kana[key];
    key ??= latin;
    if (/[キニヒミリ]/u.test(key) && /^[kgnbphmr]i$/u.test(latin) && smallY[value[index + key.length]]) {
      latin = latin[0] + smallY[value[index + key.length]];
      key += value[index + key.length];
    } else if (/[キニヒミリ]/u.test(key) && /^[kgnbphmr]i$/u.test(latin)
      && index + key.length === value.length && smallY[following[0]]) {
      latin = latin[0] + '~';
    } else if (key === 'ッ') {
      const ahead = value.slice(index + 1) + following;
      const next = /[\u3041-\u3094]/u.test(ahead[0] ?? '') ? String.fromCharCode(ahead.charCodeAt(0) + 0x60) : ahead[0];
      const voiced = ahead[1] === '\u3099', semivoiced = ahead[1] === '\u309a';
      if ('カキクケコ'.includes(next)) latin = voiced ? 'g' : 'k';
      else if ('サシスセソ'.includes(next)) latin = voiced ? next === 'シ' ? 'j' : 'z' : 's';
      else if ('タチツテト'.includes(next)) latin = voiced ? 'd' : 't';
      else if ('ハヒフヘホ'.includes(next)) latin = voiced ? 'b' : semivoiced ? 'p' : next === 'フ' ? 'f' : 'h';
      else if ('ナニヌネノン'.includes(next) && ahead[0] !== 'ん') latin = 'n';
      else if ('マミムメモ'.includes(next)) latin = 'm';
      else if ('ラリルレロ'.includes(next)) latin = 'r';
      else if ('ヤユヨ'.includes(next)) latin = 'y';
      else if ('ワヰヱヲ'.includes(next)) latin = voiced && ahead[0] === next ? 'v' : 'w';
    } else if (key === 'ヽ') {
      const before = context + output;
      latin = /[bcdfghjklmnpqrstvwxz]y*[aeiou]$/u.exec(before)?.[0] ?? [...before].at(-1) ?? '';
      if (/[\u3099\u309b]/u.test(value[index + 1] ?? '')) {
        const voiced = /(sh|ch|ts|[kstbw])(y*[aeiou])$/u.exec(before);
        if (voiced) latin = ({ sh: 'j', ch: 'dj', ts: 'dz', k: 'g', s: 'z', t: 'd', b: 'h', w: 'v' })[voiced[1]] + voiced[2];
        else latin = /(dz|j)y*[aeiou]$/u.exec(before)?.[0] ?? latin;
        key += value[index + 1];
      }
    }
    output += latin;
    index += key.length;
  }
  return output;
}

const greekAliases = { ϐ: 'β', ϑ: 'θ', ϒ: 'Υ', ϕ: 'φ', ϖ: 'π', ϰ: 'κ', ϱ: 'ρ', ϲ: 'σ', Ϲ: 'Σ', ϴ: 'Θ', ϵ: 'ε', µ: 'μ', ϳ: 'j', 'ͺ': 'i', Ϸ: 's', ϸ: 's', Ϻ: 's', ϻ: 's' };
const greekLetters = Object.fromEntries([...'αβγδεζηθικλμνξοπρσςτυφχψω'].map((ch, index) =>
  [ch, ['a', 'b', 'g', 'd', 'e', 'z', 'e\u0304', 'th', 'i', 'k', 'l', 'm', 'n', 'x', 'o', 'p', 'r', 's', 's', 't', 'y', 'ph', 'ch', 'ps', 'o\u0304'][index]]));
function greekLatin(value, context) {
  value = lowerInvariant(replaceCharacters(value.normalize('NFD'), greekAliases));
  value = value.replace(/α(?=[\u0300-\u0303\u0305-\u0344]*\u0345)/gu, 'α\u0304')
    .replace(/([αεηιουω]+[\u0304\u0308]?)\u0314/gu, 'h$1')
    .replaceAll('\u0314', 'h').replaceAll('\u0345', 'i');
  let output = '';
  const characters = [...value];
  for (const [index, ch] of characters.entries()) {
    let latin = greekLetters[ch] ?? ch;
    if (ch === 'γ' && /[γκξχ]/u.test(characters[index + 1] ?? '')) latin = 'n';
    if (ch === 'υ' && /[aeiouyαεηιουω]$/u.test(output || context)) latin = 'u';
    output += latin;
  }
  return output;
}

const libraryScripts = new Set(['Bengali', 'Bopomofo', 'Devanagari', 'Gujarati',
  'Gurmukhi', 'Kannada', 'Malayalam', 'Oriya', 'Tamil', 'Telugu', 'Thai']);
function translateRun(value, source, context, following) {
  // ICU4N's Any-Latin applies this width fix even when no script transform exists.
  value = replaceCharacters(value, data.width);
  if (source === 'Han') return hanLatin(value, context);
  if (source === 'Hangul') return hangulLatin(value);
  if (source === 'Katakana') return kanaLatin(value, context, following);
  if (source === 'Hiragana') {
    // The registered Hiragana-Latin alias has an outer filter. In particular,
    // a separately supplied handakuten is outside it, unlike a composed syllable.
    return value.replace(/[\u3041-\u3094\u3099\u309d\u309eガギグゲゴザジズゼゾダヂヅデドバビブベボヴヷ-ヺーヾ]+/gu,
      (run, offset) => kanaLatin(run, context + value.slice(0, offset), value.slice(offset + run.length) + following));
  }
  if (source === 'Greek') return greekLatin(value, context);
  if (source === 'Cyrillic') return cyrillicLatin(value.normalize('NFD'));
  if (source === 'Armenian') return armenianLatin(value.normalize('NFC'));
  if (source === 'Georgian') return georgianLatin(value);
  if (source === 'Thaana') return thaanaLatin(value);
  if (source === 'Hebrew') {
    value = normalizeFiltered(value, ch => script(ch) === 'Hebrew' || mark(ch) || /[ℵ-ℸ]/u.test(ch), 'NFKD');
    return hebrewLatin(value.replace(/[װױײ]/gu, ch => ({ װ: 'וו', ױ: 'וי', ײ: 'יי' })[ch]));
  }
  if (source === 'Arabic') return arabicLatin([...value].map(ch => script(ch) === 'Arabic'
    || /[\u0600-\u06ff]/u.test(ch) ? ch.normalize('NFKD') : ch).join(''));
  if (!libraryScripts.has(source)) return value;
  // Keep the portable library for remaining scripts; never drop unknown letters.
  return value.replace(/[\p{L}\p{M}]+/gu, letters => [...letters.normalize('NFC')]
    .map(ch => transliterate(ch, { unknown: ch, fixChineseSpacing: false })).join(''));
}

function characterAt(value, index) {
  if (index < 0 || index >= value.length) return '';
  const unit = value.charCodeAt(index);
  if (unit >= 0xdc00 && unit <= 0xdfff && index && /[\ud800-\udbff]/u.test(value[index - 1])) index--;
  return String.fromCodePoint(value.codePointAt(index));
}

export function transliterateSortName(value) {
  // Script runs overlap on Common/Inherited characters. Inspect the mutated text:
  // a width change in one run can affect the next run's script and context.
  let limit = 0;
  while (limit < value.length) {
    let start = limit, source;
    while (start && common(characterAt(value, start - 1))) start--;
    while (limit < value.length) {
      const ch = characterAt(value, limit), current = script(ch);
      if (!common(ch)) {
        if (source === undefined) source = current;
        else if (source !== current) break;
      }
      limit++;
    }
    const before = value.slice(start, limit);
    const after = translateRun(before, source, value.slice(0, start), value.slice(limit));
    value = value.slice(0, start) + after + value.slice(limit);
    limit += after.length - before.length;
  }
  // Latin-ASCII, Lower, NFD, Mn removal, then punctuation removal. In particular,
  // do not delete symbols wholesale, re-pad digits, trim or collapse added spaces.
  const latinFilter = ch => ['Latin', 'Common', 'Inherited'].includes(script(ch)) || ch === '〇';
  value = normalizeFiltered(value, latinFilter, 'NFD');
  let latinBase = false;
  value = [...value].filter(ch => {
    if (latinBase && category(ch) === 'Mn' && latinFilter(ch)) return false;
    latinBase = script(ch) === 'Latin' || /[0-9]/u.test(ch);
    return true;
  }).join('');
  value = normalizeFiltered(value, latinFilter, 'NFC');
  value = lowerInvariant(replaceCharacters(value, data.latin));
  // Node may know newer canonical decompositions than the frozen Unicode data.
  value = normalizeFiltered(value, ch => script(ch) !== 'Unknown', 'NFD');
  return [...value].filter(ch => category(ch) !== 'Mn' && !category(ch).startsWith('P')).join('');
}
