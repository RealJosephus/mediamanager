import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { newNativeItemEntity } from '../library/native-item-entity.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { addPerson } from './people.js';
import { clrTrim } from './whitespace.js';
import cultureLanguages from './resources/comic-culture-language.json' with { type: 'json' };
import { decodeBookXml } from './opf-reader.js';

export const comicError = (type, message) => Object.assign(new Error(message), { nativeException: type });
export const comicHasText = value => typeof value === 'string' && clrTrim(value) !== '';
export const comicInt32 = value => {
  const text = clrTrim(value);
  return /^[+-]?\d+$/u.test(text) && Number(text) >= -2147483648 && Number(text) <= 2147483647 ? Number(text) : null;
};
export function comicDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.0000000`;
}
export function comicLanguage(value) {
  if (value === '') return 'iv';
  const language = value.split('\0', 1)[0].replaceAll('_', '-').split('-', 1)[0].toLowerCase();
  if (language === 'x' && /^x-[a-z0-9]+(?:-[a-z0-9]+)*$/iu.test(value)) return '';
  try {
    if (!/^[a-z]{2,3}$/u.test(language)) throw new RangeError();
    new Intl.Locale(value.split('\0', 1)[0].replaceAll('_', '-'));
    return language === 'und' ? 'iv' : cultureLanguages.iso3[language] ?? language;
  }
  catch { throw comicError('CultureNotFoundException', `Invalid comic language: ${value}`); }
}
export function addComicPerson(result, name, type) {
  result.People ??= [];
  if (name == null || name === '') throw comicError(name == null ? 'ArgumentNullException' : 'ArgumentException', 'A comic credit must have a nonempty name.');
  addPerson(result.People, { Name: name, Type: type, Role: null, SortOrder: null, ImageUrl: null });
}
export function addComicGenre(item, value) {
  if (value == null || value === '') throw comicError(value == null ? 'ArgumentNullException' : 'ArgumentException', 'A comic genre must be nonempty.');
  if (!item.Genres.some(existing => ordinalIgnoreCaseEquals(existing, value))) item.Genres = [...item.Genres, value];
}

/** Parse separately because native XML load errors are swallowed, reader errors are not. */
export function parseComicInfoXml(bytes, { allowDtd = false, preserveWhitespace = true } = {}) {
  let text;
  try { text = (typeof bytes === 'string' ? bytes : decodeBookXml(bytes)).replaceAll('\r\n', '\n').replaceAll('\r', '\n'); }
  catch (error) { throw comicError('XmlException', error.message); }
  const validCharacter = value => value === 9 || value === 10 || value === 13 || value >= 32 && value <= 0xd7ff || value >= 0xe000 && value <= 0xfffd || value >= 0x10000 && value <= 0x10ffff;
  if (!text.isWellFormed() || [...text].some(value => !validCharacter(value.codePointAt(0)))) throw comicError('XmlException', 'Invalid XML character.');
  if (!allowDtd && /<!DOCTYPE\b/u.test(text.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/gu, ''))) throw comicError('XmlException', 'DTD declarations are prohibited.');
  text = text.replace(/<!ENTITY\s+([A-Za-z_:][\w.:-]*)\s+(?:SYSTEM\s+(['"])[\s\S]*?\2|PUBLIC\s+(['"])[\s\S]*?\3\s+(['"])[\s\S]*?\4)\s*>/gu,
    (_declaration, name) => `<!ENTITY ${name} "">`);
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw comicError('XmlException', valid.err.msg);
  let entities;
  const entityDecoder = {
    reset() { entities = new Map(Object.entries({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })); },
    setXmlVersion() {},
    addInputEntities(values) { for (const [name, value] of Object.entries(values)) if (!entities.has(name)) entities.set(name, value); },
    decode(value) {
      const expand = (input, active = new Set()) => input.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z_:][\w.:-]*);/gu, (_reference, name) => {
        if (name.startsWith('#')) {
          const point = Number.parseInt(name.slice(name[1] === 'x' ? 2 : 1), name[1] === 'x' ? 16 : 10);
          if (!validCharacter(point)) throw comicError('XmlException', 'Invalid XML character reference.');
          return String.fromCodePoint(point);
        }
        if (!entities.has(name) || active.has(name)) throw comicError('XmlException', 'Undeclared or recursive XML entity.');
        if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(name)) return entities.get(name);
        return expand(entities.get(name), new Set([...active, name]));
      });
      return expand(value);
    }
  };
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '',
    parseTagValue: false, parseAttributeValue: false, trimValues: false, ignoreDeclaration: true,
    ignorePiTags: true, processEntities: true, cdataPropName: '#cdata', entityDecoder });
  const convert = (entry, inherited = { xml: 'http://www.w3.org/XML/1998/namespace' }, inheritedSpace = false) => {
    const name = Object.keys(entry).find(key => key !== ':@');
    const attributes = entry[':@'] ?? {}, namespaces = { ...inherited };
    for (const [key, value] of Object.entries(attributes)) if (key === 'xmlns') namespaces[''] = value; else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value;
    const prefix = name.includes(':') ? name.slice(0, name.indexOf(':')) : '';
    for (const key of [name, ...Object.keys(attributes)]) if (key.includes(':') && !key.startsWith('xmlns:') && !namespaces[key.split(':', 1)[0]]) throw comicError('XmlException', 'Unbound XML namespace prefix.');
    const preserveSpace = attributes['xml:space'] == null ? inheritedSpace : attributes['xml:space'] === 'preserve';
    const content = entry[name].filter(part => !Object.hasOwn(part, '#text') || preserveWhitespace || preserveSpace || !/^[ \t\r\n]*$/u.test(String(part['#text'])))
      .map(part => Object.hasOwn(part, '#text') ? String(part['#text']) : Object.hasOwn(part, '#cdata') ? part['#cdata'].map(value => String(value['#text'] ?? '')).join('') : convert(part, namespaces, preserveSpace));
    return { name: name.includes(':') ? name.slice(name.indexOf(':') + 1) : name, namespace: namespaces[prefix] ?? '', content, children: content.filter(value => typeof value !== 'string') };
  };
  let roots;
  try {
    const entries = parser.parse(text);
    if (entries.some(entry => Object.hasOwn(entry, '#text') && comicHasText(String(entry['#text'])))) throw comicError('XmlException', 'Text cannot appear outside the XML root element.');
    roots = entries.filter(entry => !Object.hasOwn(entry, '#text') && !Object.keys(entry).some(key => key.startsWith('!'))).map(entry => convert(entry));
  }
  catch (error) { throw comicError('XmlException', error.message); }
  if (roots.length !== 1) throw comicError('XmlException', 'A comic XML document requires one root element.');
  return roots[0];
}

export function readComicInfo(document) {
  const root = document;
  const value = name => {
    if (root.name !== 'ComicInfo' || root.namespace !== '') return null;
    const selected = root.children.find(node => node.name === name && node.namespace === '');
    const inner = node => node.content.map(part => typeof part === 'string' ? part : inner(part)).join('');
    return selected ? inner(selected) : null;
  };
  const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Book');
  const result = { HasMetadata: false, Item: item, People: null, ResultLanguage: null };
  const string = (name, commit) => { const text = value(name); if (!comicHasText(text)) return false; commit(text); return true; };
  const integer = (name, commit) => { const text = value(name), number = comicHasText(text) ? comicInt32(text) : null;
    if (number == null) return false; commit(number); return true; };
  let found = false, manga = false;
  found = string('Title', text => { item.Name = text; }) || found;
  found = string('Manga', text => { manga = ordinalIgnoreCaseEquals(text, 'Yes'); }) || found;
  found = string('Series', text => { item.SeriesName = text; }) || found;
  found = integer('Number', number => { item.IndexNumber = number; }) || found;
  found = string('Summary', text => { item.Overview = text; }) || found;
  found = integer('Year', number => { item.ProductionYear = number; }) || found;
  const dateParts = ['Year', 'Month', 'Day'].map(name => { const text = value(name); return comicHasText(text) ? comicInt32(text) : null; });
  const date = comicDate(...dateParts);
  if (date != null) { item.PremiereDate = date; found = true; }
  found = string('Genre', text => { for (const genre of text.split(',').map(clrTrim)) addComicGenre(item, genre); }) || found;
  found = string('Publisher', text => { item.Studios = [clrTrim(text)]; }) || found;
  found = string('AlternateSeries', text => { if (manga) item.OriginalTitle = text; }) || found;
  if (!found) return { HasMetadata: false };
  result.HasMetadata = true;
  for (const [field, type] of [['Writer', 'Author'], ['Penciller', 'Penciller'], ['Inker', 'Inker'],
    ['Letterer', 'Letterer'], ['CoverArtist', 'CoverArtist'], ['Colourist', 'Colorist']]) {
    const names = value(field);
    if (comicHasText(names)) for (const name of names.split(',').map(clrTrim)) addComicPerson(result, name, type);
  }
  const language = value('LanguageISO');
  if (comicHasText(language)) result.ResultLanguage = comicLanguage(language);
  return result;
}
