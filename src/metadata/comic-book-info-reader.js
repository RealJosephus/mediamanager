import { newNativeItemEntity } from '../library/native-item-entity.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { tryParseClrInt32Enum } from './clr-enum.js';
import { clrTrim } from './whitespace.js';
import { addComicGenre, addComicPerson, comicDate, comicHasText, comicLanguage } from './comic-info-reader.js';

const personKinds = ['Unknown', 'Actor', 'Director', 'Composer', 'Writer', 'GuestStar', 'Producer', 'Conductor', 'Lyricist',
  'Arranger', 'Engineer', 'Mixer', 'Remixer', 'Creator', 'Artist', 'AlbumArtist', 'Author', 'Illustrator', 'Penciller',
  'Inker', 'Colorist', 'Letterer', 'CoverArtist', 'Editor', 'Translator', 'Narrator'];
const invalid = message => { throw new SyntaxError(message); };

// Keep duplicate properties and number token spelling: the native string
// converter consumes raw scalar text, and earlier invalid assignments fail.
function jsonTree(text) {
  try { JSON.parse(text); } catch (error) { invalid(error.message); }
  let position = 0;
  const space = () => { while (/[\u0009\u000a\u000d\u0020]/u.test(text[position] ?? 'x')) position++; };
  const parse = (depth = 0) => {
    space(); if (depth > 64) invalid('Comic JSON exceeds the native maximum depth.');
    const start = position, first = text[position++];
    if (first === '{') {
      const entries = []; space();
      while (text[position] !== '}') {
        const key = parse(depth + 1); space(); position++;
        entries.push([key.value, parse(depth + 1)]); space();
        if (text[position] === ',') { position++; continue; } break;
      }
      position++; return { type: 'object', entries };
    }
    if (first === '[') {
      const values = []; space();
      while (text[position] !== ']') { values.push(parse(depth + 1)); space(); if (text[position] === ',') { position++; continue; } break; }
      position++; return { type: 'array', values };
    }
    if (first === '"') {
      while (text[position] !== '"') { if (text[position] === '\\') position++; position++; }
      position++; return { type: 'string', value: JSON.parse(text.slice(start, position)) };
    }
    while (position < text.length && !/[\u0009\u000a\u000d\u0020,\]}]/u.test(text[position])) position++;
    const raw = text.slice(start, position);
    return { type: raw === 'null' ? 'null' : raw === 'true' || raw === 'false' ? 'boolean' : 'number', raw };
  };
  return parse();
}
function string(node) {
  if (node.type === 'null') return null;
  if (node.type === 'string') return node.value;
  if (['number', 'boolean'].includes(node.type)) return node.raw;
  return invalid('A comic string member cannot contain an object or array.');
}
function integer(node) {
  if (node.type === 'null') return null;
  const raw = node.type === 'string' ? node.value : node.type === 'number' ? node.raw : '';
  if (!/^[+-]?\d+$/u.test(raw) || Number(raw) < -2147483648 || Number(raw) > 2147483647) return invalid('Invalid comic Int32 member.');
  return Number(raw);
}
function list(node, decode) {
  if (node.type === 'null') return null;
  if (node.type !== 'array') return invalid('Comic list members require an array.');
  return node.values.map(decode);
}
function credit(node) {
  if (node.type === 'null') return null;
  if (node.type !== 'object') return invalid('Comic credits require objects.');
  const result = { person: null, role: null };
  for (const [name, value] of node.entries) if (['person', 'role'].includes(name)) result[name] = string(value);
  return result;
}
function metadata(node) {
  if (node.type === 'null') return null;
  if (node.type !== 'object') return invalid('ComicBookInfo metadata requires an object.');
  const result = { tags: [], credits: [] };
  const strings = new Set(['series', 'title', 'publisher', 'language', 'genre', 'comments', 'country']);
  const integers = new Set(['publicationMonth', 'publicationYear', 'issue', 'numberOfIssues', 'volume', 'numberOfVolumes', 'rating']);
  for (const [name, value] of node.entries) {
    if (strings.has(name)) result[name] = string(value);
    else if (integers.has(name)) result[name] = integer(value);
    else if (name === 'credits') result.credits = list(value, credit);
    else if (name === 'tags') result.tags = list(value, string);
  }
  return result;
}

export function readComicBookInfo(comment) {
  const root = jsonTree(typeof comment === 'string' ? comment : Buffer.from(comment).toString('utf8'));
  if (root.type === 'null') throw new TypeError('ComicBookInfo deserialization returned null.');
  if (root.type !== 'object') return invalid('ComicBookInfo requires a JSON object.');
  let comic = null;
  for (const [name, value] of root.entries) {
    if (name === 'ComicBookInfo/1.0') comic = metadata(value);
    else if (name === 'appID' || name === 'lastModified') string(value);
  }
  if (comic == null) return { HasMetadata: false };
  const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Book');
  const result = { HasMetadata: false, Item: item, People: null, ResultLanguage: null };
  let found = false;
  for (const [name, field] of [['title', 'Name'], ['series', 'SeriesName'], ['comments', 'Overview']])
    if (comicHasText(comic[name])) { item[field] = comic[name]; found = true; }
  if (comicHasText(comic.genre)) { addComicGenre(item, comic.genre); found = true; }
  if (comicHasText(comic.publisher)) { item.Studios = [clrTrim(comic.publisher)]; found = true; }
  if (comic.publicationYear != null) { item.ProductionYear = comic.publicationYear; found = true; }
  if (comic.issue != null) { item.IndexNumber = comic.issue; found = true; }
  if (comic.tags == null) throw new TypeError('Comic tags are null.');
  if (comic.tags.length) { item.Tags = [...comic.tags]; found = true; }
  if (comic.publicationYear != null && comic.publicationMonth != null) {
    item.PremiereDate = comicDate(comic.publicationYear, comic.publicationMonth, 1); found = true;
  }
  if (!found) return { HasMetadata: false };
  result.HasMetadata = true;
  if (comic.language != null) try { result.ResultLanguage = comicLanguage(comic.language); } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  if (comic.credits == null) throw new TypeError('Comic credits are null.');
  for (const person of comic.credits) {
    if (person == null) throw new TypeError('A comic credit is null.');
    if (person.person == null || person.role == null) continue;
    let name = person.person;
    if (name.includes(',')) { const parts = name.split(','); name = parts[1].replace(/^ +| +$/gu, '') + ' ' + parts[0].replace(/^ +| +$/gu, ''); }
    const type = ordinalIgnoreCaseEquals(person.role, 'Colorer') ? 'Colorist' : tryParseClrInt32Enum(person.role, personKinds) ?? 'Unknown';
    addComicPerson(result, name, type);
  }
  return result;
}
