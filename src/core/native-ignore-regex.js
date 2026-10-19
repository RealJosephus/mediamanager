// UTF-16 regex semantics used by the frozen Ignore 0.2.1 rules.
// Character facts come from the bound .NET runtime; see the sealed ignore fixture.
import { compileNativeBackreferences } from './native-ignore-backreferences.js';
import native from './resources/native-ignore-regex.json' with { type: 'json' };
const caseMap = native.caseEquivalences;
const canonicalCodes = Uint16Array.from({ length: 65536 }, (_, code) => code);
for (const [character, values] of Object.entries(caseMap)) canonicalCodes[character.charCodeAt(0)] = values[0];
const equivalentGroups = [...new Map(Object.values(caseMap).map(values => [values.join(','), values])).values()];
export const foldNativeIgnoreCase = value => value.split('').map(character => String.fromCharCode(canonicalCodes[character.charCodeAt(0)])).join('');
const categoryAliases = {
  Lu: ['UppercaseLetter', 'LowercaseLetter', 'TitlecaseLetter'], Ll: ['UppercaseLetter', 'LowercaseLetter', 'TitlecaseLetter'],
  Lt: ['UppercaseLetter', 'LowercaseLetter', 'TitlecaseLetter'], Lm: ['ModifierLetter'], Lo: ['OtherLetter'],
  L: ['UppercaseLetter', 'LowercaseLetter', 'TitlecaseLetter', 'ModifierLetter', 'OtherLetter'],
  Mn: ['NonSpacingMark'], Mc: ['SpacingCombiningMark'], Me: ['EnclosingMark'], M: ['NonSpacingMark', 'SpacingCombiningMark', 'EnclosingMark'],
  Nd: ['DecimalDigitNumber'], Nl: ['LetterNumber'], No: ['OtherNumber'], N: ['DecimalDigitNumber', 'LetterNumber', 'OtherNumber'],
  Pc: ['ConnectorPunctuation'], Pd: ['DashPunctuation'], Ps: ['OpenPunctuation'], Pe: ['ClosePunctuation'], Pi: ['InitialQuotePunctuation'],
  Pf: ['FinalQuotePunctuation'], Po: ['OtherPunctuation'], P: ['ConnectorPunctuation', 'DashPunctuation', 'OpenPunctuation', 'ClosePunctuation', 'InitialQuotePunctuation', 'FinalQuotePunctuation', 'OtherPunctuation'],
  Sm: ['MathSymbol'], Sc: ['CurrencySymbol'], Sk: ['ModifierSymbol'], So: ['OtherSymbol'], S: ['MathSymbol', 'CurrencySymbol', 'ModifierSymbol', 'OtherSymbol'],
  Zs: ['SpaceSeparator'], Zl: ['LineSeparator'], Zp: ['ParagraphSeparator'], Z: ['SpaceSeparator', 'LineSeparator', 'ParagraphSeparator'],
  Cc: ['Control'], Cf: ['Format'], Cs: ['Surrogate'], Co: ['PrivateUse'], Cn: ['OtherNotAssigned'], C: ['Control', 'Format', 'Surrogate', 'PrivateUse', 'OtherNotAssigned']
};
const bitmap = () => new Uint8Array(65536);
const range = (set, from, to) => { if (from > to) throw new SyntaxError('Reversed CLR character range'); set.fill(1, from, to + 1); };
const invert = set => { for (let i = 0; i < set.length; i++) set[i] ^= 1; return set; };
const union = (left, right) => { for (let i = 0; i < left.length; i++) left[i] |= right[i]; return left; };
const expand = set => {
  for (const values of equivalentGroups) if (values.some(value => set[value])) for (const value of values) set[value] = 1;
  return set;
};
const categoryCache = new Map();
function category(name) {
  if (categoryCache.has(name)) return categoryCache.get(name);
  const set = bitmap();
  const blocks = native.unicodeBlocks[name];
  if (blocks) for (let i = 0; i < blocks.length; i += 2) range(set, blocks[i], (blocks[i + 1] ?? 65536) - 1);
  else {
    const values = categoryAliases[name]; if (!values) throw new SyntaxError('Unknown CLR Unicode category');
    for (const value of values) {
      const source = native.categories[value];
      for (const match of source.matchAll(/\\u([0-9a-f]{4})(?:-\\u([0-9a-f]{4}))?/g)) range(set, parseInt(match[1], 16), parseInt(match[2] ?? match[1], 16));
    }
  }
  expand(set); categoryCache.set(name, set); return set;
}
const word = category('L').slice(); union(word, category('Mn')); union(word, category('Nd')); union(word, category('Pc'));
const whitespace = bitmap(); for (const value of [9, 10, 11, 12, 13, 0x85, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]) whitespace[value] = 1; range(whitespace, 0x2000, 0x200a);
const escapeLiteral = value => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
function encodedClass(set) {
  const canonical = bitmap();
  for (let i = 0; i < set.length; i++) if (set[i]) canonical[canonicalCodes[i]] = 1;
  let result = '';
  const code = n => '\\u' + n.toString(16).padStart(4, '0');
  for (let i = 0; i < canonical.length; i++) if (canonical[i]) {
    const first = i; while (i + 1 < canonical.length && canonical[i + 1]) i++;
    result += code(first) + (i === first ? '' : '-' + code(i));
  }
  return result ? '[' + result + ']' : '(?!)';
}
const boundaryWord = word.slice(); boundaryWord[0x200c] = 1; boundaryWord[0x200d] = 1;
const boundaryClass = encodedClass(boundaryWord);
const boundary = `(?:(?<=${boundaryClass})(?!${boundaryClass})|(?<!${boundaryClass})(?=${boundaryClass}))`;
function countCaptures(source) {
  const classes = []; let result = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '\\') {
      if (source[++index] === 'c') index++;
      if (classes.length) classes[classes.length - 1] = false;
      continue;
    }
    if (classes.length) {
      if (character === ']' && !classes.at(-1)) classes.pop();
      else if (character === '[' && source[index - 1] === '-') classes.push(true);
      else if (character !== '^' || !classes.at(-1)) classes[classes.length - 1] = false;
      continue;
    }
    if (character === '[') classes.push(true);
    else if (character === '(' && source[index + 1] !== '?') result++;
  }
  return result;
}
export function compileNativeIgnoreRegex(source) {
  let index = 0, result = '', hasBackreferences = false;
  const captureCount = countCaptures(source);
  const octal = first => {
    if (!/[0-7]/.test(first)) throw new SyntaxError('Unknown CLR numeric escape');
    let value = first;
    while (value.length < 3 && /[0-7]/.test(source[index] ?? '')) value += source[index++];
    return { code: parseInt(value, 8) & 255 };
  };
  const token = inClass => {
    const c = source[index++];
    if (c !== '\\') return { code: c.charCodeAt(0) };
    const escaped = source[index++]; if (escaped == null) throw new SyntaxError('Missing CLR escape');
    if ('dDwWsS'.includes(escaped)) {
      const set = (escaped.toLowerCase() === 'd' ? category('Nd') : escaped.toLowerCase() === 'w' ? word : whitespace).slice();
      return { set: escaped === escaped.toUpperCase() ? invert(set) : set };
    }
    if ('pP'.includes(escaped)) {
      if (source[index++] !== '{') throw new SyntaxError('Invalid CLR category escape');
      const end = source.indexOf('}', index); if (end < 0) throw new SyntaxError('Invalid CLR category escape');
      const set = category(source.slice(index, end)).slice(); index = end + 1;
      return { set: escaped === 'P' ? invert(set) : set };
    }
    if ('ux'.includes(escaped)) {
      const length = escaped === 'u' ? 4 : 2, value = source.slice(index, index + length);
      if (value.length !== length || !/^[0-9a-f]+$/i.test(value)) throw new SyntaxError('Invalid CLR hex escape');
      index += length; return { code: parseInt(value, 16) };
    }
    const controls = { a: 7, e: 27, f: 12, n: 10, r: 13, t: 9, v: 11, ...(inClass ? { b: 8 } : {}) };
    if (Object.hasOwn(controls, escaped)) return { code: controls[escaped] };
    if (/[0-9]/.test(escaped)) {
      if (inClass || escaped === '0') return octal(escaped);
      const start = index;
      let value = escaped; while (/[0-9]/.test(source[index] ?? '')) value += source[index++];
      if (Number(value) <= captureCount) { hasBackreferences = true; return { expression: '\\' + value }; }
      if (Number(value) <= 9) throw new SyntaxError('Undefined CLR backreference');
      index = start; return octal(escaped);
    }
    if (!inClass && ['A', 'G', 'z', 'Z', 'b', 'B'].includes(escaped)) return { expression: {
      A: '^', G: '^', z: '(?![^])', Z: '(?=\\n?(?![^]))', b: boundary, B: '(?!' + boundary + ')'
    }[escaped] };
    if (escaped === 'k' && !inClass) {
      const delimiter = source[index++], close = delimiter === '<' ? '>' : delimiter === "'" ? "'" : null;
      const end = close ? source.indexOf(close, index) : -1;
      const number = source.slice(index, end);
      if (end < 0 || !/^\d+$/.test(number) || Number(number) > captureCount) throw new SyntaxError('Invalid CLR named reference');
      index = end + 1; hasBackreferences = true;
      return { expression: '\\' + Number(number) };
    }
    if (escaped === 'c') {
      const letter = source[index++]; let code = letter?.charCodeAt(0);
      if (code >= 97 && code <= 122) code -= 32;
      if (!letter || code < 64 || code > 95) throw new SyntaxError('Invalid CLR control escape');
      return { code: code - 64 };
    }
    if (/[A-Za-z0-9]/.test(escaped)) throw new SyntaxError('Unknown CLR escape');
    return { code: escaped.charCodeAt(0) };
  };
  const characterClass = () => {
    index++; let negate = false;
    if (source[index] === '^') { negate = true; index++; }
    const set = bitmap(); let count = 0, subtract;
    while (index < source.length) {
      if (source[index] === ']' && count > 0) {
        index++; expand(set); if (negate) invert(set);
        if (subtract) for (let code = 0; code < set.length; code++) if (subtract[code]) set[code] = 0;
        return set;
      }
      if (source[index] === '-' && source[index + 1] === '[' && count > 0) {
        index++; subtract = characterClass();
        if (source[index] !== ']') throw new SyntaxError('CLR subtraction must end its class');
        continue;
      }
      const first = token(true); count++;
      if (first.set) union(set, first.set);
      else if (source[index] === '-' && ![']', '['].includes(source[index + 1])) {
        index++; const last = token(true); if (last.code == null) throw new SyntaxError('Invalid CLR range endpoint');
        range(set, first.code, last.code);
      } else set[first.code] = 1;
    }
    throw new SyntaxError('Unterminated CLR character class');
  };
  while (index < source.length) {
    const c = source[index];
    if (c === '[') result += encodedClass(characterClass());
    else if (c === '\\') {
      const value = token(false);
      result += value.set ? encodedClass(value.set) : value.expression ?? escapeLiteral(foldNativeIgnoreCase(String.fromCharCode(value.code)));
    } else {
      index++;
      if (c === '.') result += '[^\\n]';
      else if (c === '$') result += '(?=\\n?(?![^]))';
      else result += '|()^*+?{}'.includes(c) ? c : escapeLiteral(foldNativeIgnoreCase(c));
    }
  }
  return hasBackreferences ? compileNativeBackreferences(result) : new RegExp(result);
}
