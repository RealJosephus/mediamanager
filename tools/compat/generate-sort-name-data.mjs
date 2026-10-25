import { createHash } from 'node:crypto';
import pinned from '../../src/library/resources/sort-name-sources.json' with { type: 'json' };

const root = 'https://raw.githubusercontent.com/unicode-org/icu/release-60-1/';
const sources = {
  han: root + 'icu4c/source/data/translit/Hani_Latn.txt',
  spacing: root + 'icu4c/source/data/translit/Han_Spacedhan.txt',
  latin: root + 'icu4c/source/data/translit/Latin_ASCII.txt',
  cyrillic: root + 'icu4c/source/data/translit/Cyrl_Latn.txt',
  arabic: root + 'icu4c/source/data/translit/Arab_Latn.txt',
  armenian: root + 'icu4c/source/data/translit/Latn_Armn.txt',
  georgian: root + 'icu4c/source/data/translit/Geor_Latn.txt',
  thaana: root + 'icu4c/source/data/translit/Latn_Thaa.txt',
  hebrew: root + 'icu4c/source/data/translit/Hebr_Latn.txt',
  greek: root + 'icu4c/source/data/translit/Grek_Latn.txt',
  kana: root + 'icu4c/source/data/translit/Latn_Kana.txt',
  hiragana: root + 'icu4c/source/data/translit/Hira_Kana.txt',
  hiraganaFilter: root + 'icu4c/source/data/translit/Hira_Latn.txt',
  hangul: root + 'icu4c/source/data/translit/Latin_ConjoiningJamo.txt',
  hangulFilter: root + 'icu4c/source/data/translit/Hang_Latn.txt',
  scriptRuns: root + 'icu4j/main/classes/translit/src/com/ibm/icu/text/AnyTransliterator.java',
  characters: root + 'icu4c/source/data/unidata/UnicodeData.txt',
  scripts: 'https://raw.githubusercontent.com/unicode-org/unicodetools/main/unicodetools/data/ucd/10.0.0-Update/Scripts.txt',
  properties: 'https://raw.githubusercontent.com/unicode-org/unicodetools/main/unicodetools/data/ucd/10.0.0-Update/PropList.txt',
  license: root + 'icu4c/LICENSE',
};

function literal(text, variables = {}) {
  let result = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch === "'") {
      if (text[index + 1] === "'") { result += "'"; index++; }
      else quoted = !quoted;
    } else if (quoted) result += ch;
    else if (/[\s\u0085\u200e\u200f]/u.test(ch)) continue;
    else if (ch === '\\') {
      const escaped = /^\\(?:u([\da-f]{4})|U([\da-f]{8}))/iu.exec(text.slice(index));
      if (escaped) { result += String.fromCodePoint(parseInt(escaped[1] ?? escaped[2], 16)); index += escaped[0].length - 1; }
      else result += text[++index];
    } else if (ch === '$') {
      const name = /^\$\w+/u.exec(text.slice(index))?.[0];
      if (!Object.hasOwn(variables, name)) return null;
      result += variables[name]; index += name.length - 1;
    } else if (/[{}[\]|()*+?=]/u.test(ch)) return null;
    else result += ch;
  }
  return quoted ? null : result;
}

function statements(source) {
  return source.split('\n').flatMap(line => {
    if (/^\s*(?:#|::|$)/u.test(line)) return [];
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\' && !quoted) { i++; continue; }
      if (line[i] === "'") quoted = !quoted;
      if (!quoted && line[i] === ';') return [line.slice(0, i).trim()];
    }
    return [];
  });
}

function mappings(source, reverse = false) {
  const variables = {}, result = {};
  for (const statement of statements(source)) {
    const variable = /^(\$\w+)\s*=\s*(.*)$/u.exec(statement);
    if (variable) {
      const value = literal(variable[2], variables);
      if (value !== null) variables[variable[1]] = value;
      continue;
    }
    const pair = /^(.*?)\s*([→↔←])\s*(.*?)$/u.exec(statement);
    if (!pair || (reverse ? pair[2] === '→' : pair[2] === '←')) continue;
    const from = literal(reverse ? pair[3] : pair[1], variables);
    // Ante/post-context on the output side of a bidirectional rule constrains
    // only its inverse, not this direction's replacement text.
    const output = (reverse ? pair[1] : pair[3]).replace(/\s*\}.*$/u, '');
    const to = literal(output, variables);
    if (from !== null && from.length && to !== null && !Object.hasOwn(result, from)) result[from] = to;
  }
  return result;
}

function ranges(source, wanted) {
  return source.split('\n').flatMap(line => {
    const m = /^([\dA-F]+)(?:\.\.([\dA-F]+))?\s*;\s*(\w+)/u.exec(line);
    return m && (!wanted || wanted === m[3]) ? [[parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16), m[3]]] : [];
  }).sort((a, b) => a[0] - b[0]);
}

const downloaded = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([name, url]) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const source = await response.text();
  const expected = pinned.sources.find(entry => entry.name === name && entry.url === url)?.sha256;
  if (!expected || createHash('sha256').update(source).digest('hex') !== expected) throw new Error(`Source digest mismatch: ${name}`);
  return [name, source];
})));
const hanGroups = new Map();
for (const match of downloaded.han.matchAll(/^\[([^\]]+)\]→([^;]+);$/gmu)) {
  if (/[\\\[]/u.test(match[1])) throw new Error('Unexpected Han set syntax');
  const chars = [...match[1]], expanded = [];
  for (let index = 0; index < chars.length; index++) {
    if (chars[index + 1] !== '-') expanded.push(chars[index]);
    else {
      const first = chars[index].codePointAt(0), last = chars[index + 2]?.codePointAt(0);
      if (!last || first >= last) throw new Error('Invalid Han range');
      for (let point = first; point <= last; point++) expanded.push(String.fromCodePoint(point));
      index += 2;
    }
  }
  const reading = match[2].normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase();
  hanGroups.set(reading, (hanGroups.get(reading) ?? '') + expanded.join(''));
}
const categories = [], width = {};
for (const line of downloaded.characters.split('\n')) {
  const fields = line.split(';');
  if (fields.length < 6) continue;
  const point = parseInt(fields[0], 16), category = fields[2];
  if (/^[LP]/u.test(category) || category === 'Mn' || category === 'Mc' || category === 'Me') {
    const prior = categories.at(-1);
    if (fields[1].endsWith(', Last>')) prior[1] = point;
    else if (prior && prior[1] + 1 === point && prior[2] === category) prior[1] = point;
    else categories.push([point, point, category]);
  }
  const decomposition = /^<(wide|narrow)> (.*)$/u.exec(fields[5]);
  if (decomposition) {
    const character = String.fromCodePoint(point);
    width[character] = character.normalize('NFKD');
  }
}
const data = {
  unicodeVersion: '10.0.0',
  han: [...hanGroups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  latin: mappings(downloaded.latin), cyrillic: mappings(downloaded.cyrillic),
  arabic: mappings(downloaded.arabic), kana: mappings(downloaded.kana, true),
  armenian: mappings(downloaded.armenian, true), georgian: mappings(downloaded.georgian),
  thaana: mappings(downloaded.thaana, true), width,
  hebrew: mappings(downloaded.hebrew),
  scripts: ranges(downloaded.scripts), categories,
  ideographic: ranges(downloaded.properties, 'Ideographic').map(([first, last]) => [first, last]),
};
if (data.han.length < 400 || Object.keys(data.latin).length < 600 || data.scripts.length < 1000) throw new Error('Incomplete sources');
const files = {
  'sort-name-data.json': '{\n' + Object.entries(data).map(([key, value]) => {
    if (Array.isArray(value)) return `  ${JSON.stringify(key)}: [\n${value.map(row => '    ' + JSON.stringify(row)).join(',\n')}\n  ]`;
    return `  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replaceAll('\n', '\n  ')}`;
  }).join(',\n') + '\n}\n',
  'sort-name-unicode-license.txt': downloaded.license.slice(0, downloaded.license.indexOf('---------------------')).trimEnd() + '\n',
  'sort-name-sources.json': JSON.stringify({
    generator: 'tools/compat/generate-sort-name-data.mjs', unicodeVersion: data.unicodeVersion,
    sources: Object.entries(sources).map(([name, url]) => ({ name, url,
      sha256: createHash('sha256').update(downloaded[name]).digest('hex') })),
    limitations: ['Static mappings are not a complete rule interpreter.', 'Context rules are implemented and tested in transliteration.js.'],
  }, null, 2) + '\n',
};
// stdout is intentional: review and apply the generated text, without overwriting files.
console.log(JSON.stringify(files));
