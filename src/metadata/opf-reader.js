import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { newNativeItemEntity } from '../library/native-item-entity.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { parseInvariantDate } from '../core/invariant-date-parse.js';
import { mimeToExtension } from '../http/mime-types.js';
import { addPerson } from './people.js';
import { clrTrim, clrWhitespace } from './whitespace.js';
import { roundEven } from '../images/options.js';

const dc = 'http://purl.org/dc/elements/1.1/';
const opf = 'http://www.idpf.org/2007/opf';
const containerNamespace = 'urn:oasis:names:tc:opendocument:xmlns:container';
const initialsWhitespace = new RegExp(`[${clrWhitespace}]`, 'u');
const xmlError = message => Object.assign(new Error(message), { code: 'invalid-book-xml', nativeException: 'XmlException' });
const validCharacter = value => value === 9 || value === 10 || value === 13 || value >= 32 && value <= 0xd7ff || value >= 0xe000 && value <= 0xfffd || value >= 0x10000 && value <= 0x10ffff;

export function decodeBookXml(input) {
  const bytes = Buffer.from(input), signature = bytes.subarray(0, 4).toString('hex');
  let encoding = 'utf-8', offset = 0;
  if (signature.startsWith('fffe0000')) { encoding = 'utf-32le'; offset = 4; }
  else if (signature.startsWith('0000feff')) { encoding = 'utf-32be'; offset = 4; }
  else if (signature.startsWith('efbbbf')) offset = 3;
  else if (signature.startsWith('fffe')) { encoding = 'utf-16le'; offset = 2; }
  else if (signature.startsWith('feff')) { encoding = 'utf-16be'; offset = 2; }
  else if (signature.startsWith('3c000000')) encoding = 'utf-32le';
  else if (signature.startsWith('0000003c')) encoding = 'utf-32be';
  else if (signature.startsWith('3c00')) encoding = 'utf-16le';
  else if (signature.startsWith('003c')) encoding = 'utf-16be';
  const decode = (value, name) => {
    if (name.startsWith('utf-32')) {
      if (value.length % 4) throw xmlError('Incomplete XML character.');
      let text = '';
      for (let index = 0; index < value.length; index += 4) {
        const point = name === 'utf-32be' ? value.readUInt32BE(index) : value.readUInt32LE(index);
        if (point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw xmlError('Invalid XML character.');
        text += String.fromCodePoint(point);
      }
      return text;
    }
    if (['iso-8859-1', 'latin1', 'latin-1'].includes(name)) return value.toString('latin1');
    return new TextDecoder(name, { fatal: true, ignoreBOM: true }).decode(value);
  };
  try {
    const unit = encoding.startsWith('utf-32') ? 4 : encoding.startsWith('utf-16') ? 2 : 1;
    const probeBytes = bytes.subarray(offset, offset + Math.floor((bytes.length - offset) / unit) * unit);
    const probe = unit === 1 ? probeBytes.toString('latin1') : encoding.startsWith('utf-32') ? decode(probeBytes, encoding)
      : new TextDecoder(encoding, { ignoreBOM: true }).decode(probeBytes);
    const declaration = /^<\?xml\s+[\s\S]*?\bencoding\s*=\s*(['"])([^'"]+)\1/u.exec(probe);
    if (declaration) {
      const name = declaration[2].toLowerCase();
      if (name === 'utf-16' || name === 'utf-32') {
        if (!encoding.startsWith(name)) throw xmlError('XML encoding requires a Unicode signature.');
        if (name === 'utf-32') encoding = 'utf-32le';
      } else encoding = name;
    }
    return decode(bytes.subarray(offset), encoding);
  } catch (error) { if (error.nativeException) throw error; throw xmlError(error.message); }
}

function readDocumentType(xml, consumeEntityCharacters) {
  let index = 0;
  while (index < xml.length) {
    if (/\s/u.test(xml[index])) { index++; continue; }
    const end = xml.startsWith('<!--', index) ? xml.indexOf('-->', index + 4) + 3
      : xml.startsWith('<?', index) ? xml.indexOf('?>', index + 2) + 2 : null;
    if (end != null) { if (end <= index) throw xmlError('Unclosed XML declaration.'); index = end; continue; }
    break;
  }
  if (!xml.startsWith('<!DOCTYPE', index)) return { xml, declarations: '', defaults: new Map(), entities: new Map() };
  const start = index;
  let quote = null, depth = 0, subset = -1, declarations = '';
  for (; index < xml.length; index++) {
    const value = xml[index];
    if (quote) { if (value === quote) quote = null; continue; }
    if (xml.startsWith('<!--', index)) { const end = xml.indexOf('-->', index + 4); if (end < 0) throw xmlError('Unclosed XML comment.'); index = end + 2; continue; }
    if (value === '"' || value === "'") quote = value;
    else if (value === '[') { if (depth++ === 0) subset = index + 1; }
    else if (value === ']') { if (--depth === 0) declarations = xml.slice(subset, index); }
    else if (value === '>' && depth === 0) break;
  }
  if (index === xml.length) throw xmlError('Unclosed XML document type.');
  const entities = new Map(), parameters = new Map(), defaults = new Map();
  const parseSubset = input => {
    const frames = [{ input, cursor: 0 }], active = new Set();
    while (frames.length) {
      const frame = frames.at(-1), input = frame.input;
      let cursor = frame.cursor;
      if (cursor >= input.length) { frames.pop(); active.delete(frame.name); continue; }
      if (/\s/u.test(input[cursor])) { frame.cursor++; continue; }
      if (input.startsWith('<!--', cursor)) { const end = input.indexOf('-->', cursor + 4); if (end < 0) throw xmlError('Unclosed XML comment.'); frame.cursor = end + 3; continue; }
      const parameter = /^%([A-Za-z_:][\w.:-]*);/u.exec(input.slice(cursor));
      if (parameter) {
        const name = parameter[1];
        if (!parameters.has(name) || active.has(name)) throw xmlError('Undeclared or recursive XML parameter entity.');
        frame.cursor += parameter[0].length;
        const replacement = parameters.get(name); consumeEntityCharacters(replacement.length);
        active.add(name); frames.push({ input: replacement, cursor: 0, name }); continue;
      }
      const entity = /^<!ENTITY\s+(%\s+)?([A-Za-z_:][\w.:-]*)\s+(?:(['"])([\s\S]*?)\3|(?:SYSTEM\s+(['"])[\s\S]*?\5|PUBLIC\s+(['"])[\s\S]*?\6\s+(['"])[\s\S]*?\7)(?:\s+NDATA\s+[\w.:-]+)?)\s*>/u.exec(input.slice(cursor));
      if (entity) {
        const table = entity[1] ? parameters : entities;
        if (!table.has(entity[2])) table.set(entity[2], entity[1] ? entity[4] ?? '' : { value: entity[4] ?? '', external: entity[4] == null });
        frame.cursor = cursor + entity[0].length; continue;
      }
      const declaration = /^<!(?:ELEMENT|ATTLIST|NOTATION)\s+/u.exec(input.slice(cursor));
      if (!declaration) throw xmlError('Invalid XML document type.');
      let end = cursor + declaration[0].length, quoted = null;
      for (; end < input.length; end++) {
        const value = input[end]; if (quoted) { if (value === quoted) quoted = null; }
        else if (value === '"' || value === "'") quoted = value;
        else if (value === '>') break;
      }
      if (end === input.length) throw xmlError('Unclosed XML declaration.');
      if (input.startsWith('<!ATTLIST', cursor)) {
        let body = input.slice(cursor + declaration[0].length, end);
        const element = /^([^\s]+)\s*/u.exec(body); if (!element) throw xmlError('Invalid XML attribute declaration.');
        body = body.slice(element[0].length);
        const attributes = defaults.get(element[1]) ?? new Map(); defaults.set(element[1], attributes);
        while (body.length) {
          const attribute = /^\s*([^\s]+)\s+(?:CDATA|IDREFS?|ID|ENTITIES|ENTITY|NMTOKENS?|(?:NOTATION\s+)?\([^)]*\))\s+(?:(?:#FIXED\s+)?(['"])([\s\S]*?)\2|#(?:IMPLIED|REQUIRED))\s*/u.exec(body);
          if (!attribute) throw xmlError('Invalid XML default attribute.');
          if (attribute[2] && !attributes.has(attribute[1])) attributes.set(attribute[1], attribute[3]);
          body = body.slice(attribute[0].length);
        }
      }
      cursor = end + 1;
      frame.cursor = cursor;
    }
  };
  parseSubset(declarations);
  return { xml: xml.slice(0, start) + xml.slice(index + 1), defaults, entities };
}

function expandDocumentEntities(xml, entities, consumeEntityCharacters, attributeOnly = false) {
  const output = [], frames = [{ input: xml, index: 0, attributeOnly, markup: false, quote: null }], active = new Set();
  while (frames.length) {
    const frame = frames.at(-1), input = frame.input;
    if (frame.index >= input.length) { frames.pop(); active.delete(frame.name); continue; }
    const index = frame.index;
    if (!frame.attributeOnly && !frame.markup && !frame.quote) {
      const terminator = input.startsWith('<![CDATA[', index) ? ']]>' : input.startsWith('<!--', index) ? '-->' : input.startsWith('<?', index) ? '?>' : null;
      if (terminator) {
        const end = input.indexOf(terminator, index + 2); if (end < 0) throw xmlError('Unclosed XML node.');
        output.push(input.slice(index, end + terminator.length)); frame.index = end + terminator.length; continue;
      }
    }
    const value = input[index];
    if (value === '&') {
      const reference = /^&([A-Za-z_:][\w.:-]*);/u.exec(input.slice(index));
      if (reference) {
        const name = reference[1]; frame.index += reference[0].length;
        if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(name)) { output.push(reference[0]); continue; }
        const entity = entities.get(name), attribute = frame.attributeOnly || Boolean(frame.quote);
        if (!entity || active.has(name)) throw xmlError('Undeclared or recursive XML entity.');
        if (attribute && (entity.external || entity.value.includes('<'))) throw xmlError('Invalid entity in XML attribute.');
        consumeEntityCharacters(entity.value.length); active.add(name);
        frames.push({ input: entity.value, index: 0, attributeOnly: attribute, name, markup: false, quote: null }); continue;
      }
    }
    if (!/[&<>"']/u.test(value)) {
      const special = /[&<>"']/gu; special.lastIndex = index;
      const end = special.exec(input)?.index ?? input.length;
      output.push(input.slice(index, end)); frame.index = end; continue;
    }
    output.push(frame.name && frame.attributeOnly && value === '"' ? '&quot;'
      : frame.name && frame.attributeOnly && value === "'" ? '&apos;' : value);
    if (!frame.attributeOnly) {
      if (frame.quote) { if (value === frame.quote) frame.quote = null; }
      else if (frame.markup) { if (value === '"' || value === "'") frame.quote = value; else if (value === '>') frame.markup = false; }
      else if (value === '<') frame.markup = true;
    }
    frame.index++;
  }
  return output.join('');
}

/** Raw XML documents select their encoding before parsing; a TextReader would
 * discard the declaration's encoding and has a different input contract. */
export function parseOpfDocument(input) {
  let xml = decodeBookXml(input);
  if (!xml.isWellFormed()) throw xmlError('Invalid XML character.');
  for (const value of xml) if (!validCharacter(value.codePointAt(0))) throw xmlError('Invalid XML character.');
  let entityCharacters = 0;
  const consumeEntityCharacters = count => {
    entityCharacters += count;
    if (entityCharacters > 10000000) throw xmlError('The XML document exceeds MaxCharactersFromEntities.');
  };
  const documentType = readDocumentType(xml, consumeEntityCharacters);
  for (const attributes of documentType.defaults.values()) for (const [key, value] of attributes) {
    attributes.set(key, expandDocumentEntities(value, documentType.entities, consumeEntityCharacters, true));
  }
  xml = expandDocumentEntities(documentType.xml, documentType.entities, consumeEntityCharacters);
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw xmlError(validation.err.msg);
  let marker = 0xe000;
  const used = new Set(xml);
  while (used.has(String.fromCodePoint(marker))) marker++;
  const carriageReturn = String.fromCodePoint(marker);
  const containsCarriageReturns = xml.includes('\r');
  let protectedXml = containsCarriageReturns ? '' : xml, markup = false, quote = null, subset = 0;
  for (let index = 0; containsCarriageReturns && index < xml.length; index++) {
    if (!markup && (xml.startsWith('<![CDATA[', index) || xml.startsWith('<!--', index))) {
      const cdata = xml.startsWith('<![CDATA[', index), end = xml.indexOf(cdata ? ']]>' : '-->', index + 4) + 3;
      const value = xml.slice(index, end);
      protectedXml += cdata ? value.replaceAll('\r', carriageReturn) : value; index = end - 1; continue;
    }
    const value = xml[index];
    if (quote) { protectedXml += value === '\r' ? carriageReturn : value; if (value === quote) quote = null; }
    else if (markup) {
      protectedXml += value;
      if (value === '"' || value === "'") quote = value;
      else if (value === '[') subset++;
      else if (value === ']') subset--;
      else if (value === '>' && subset === 0) markup = false;
    } else { protectedXml += value === '\r' ? carriageReturn : value; if (value === '<') markup = true; }
  }
  const restore = value => value.replaceAll(carriageReturn, '\r');
  let entities;
  const entityDecoder = {
    reset() { entities = new Map(Object.entries({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })); },
    setXmlVersion() {},
    addInputEntities(values) { for (const [name, value] of Object.entries(values)) if (!entities.has(name)) entities.set(name, value); },
    decode(value) {
      const expand = (input, active = new Set()) => input.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z_:][\w.:-]*);/gu, (_reference, name) => {
        if (name.startsWith('#')) {
          const point = Number.parseInt(name.slice(name[1] === 'x' ? 2 : 1), name[1] === 'x' ? 16 : 10);
          if (point <= 0xffff) return String.fromCharCode(point);
          const pair = point - 0x10000;
          return String.fromCharCode((pair >> 10) + 0xd800, (pair & 0x3ff) + 0xdc00);
        }
        if (!entities.has(name) || active.has(name)) throw xmlError('Undeclared or recursive XML entity.');
        if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(name)) return entities.get(name);
        return expand(entities.get(name), new Set([...active, name]));
      });
      return expand(value);
    }
  };
  let nodes;
  try { nodes = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false,
    parseAttributeValue: false, trimValues: false, ignoreDeclaration: true, ignorePiTags: true, processEntities: true,
    cdataPropName: '#cdata', maxNestedTags: Infinity, entityDecoder }).parse(protectedXml); }
  catch (error) { throw xmlError(error.message); }
  const build = (entry, inherited = { xml: 'http://www.w3.org/XML/1998/namespace' }, inheritedSpace = false) => {
    const name = Object.keys(entry).find(key => ![':@', '#text', '#comment'].includes(key));
    const attributes = Object.fromEntries(Object.entries(entry[':@'] ?? {}).map(([name, value]) => [name, restore(value)])), namespaces = { ...inherited };
    for (const [key, value] of documentType.defaults.get(name) ?? []) if (!Object.hasOwn(attributes, key)) {
      attributes[key] = entityDecoder.decode(value);
    }
    for (const [key, value] of Object.entries(attributes)) if (key === 'xmlns') namespaces[''] = value; else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value;
    if (namespaces.xml !== 'http://www.w3.org/XML/1998/namespace' || Object.hasOwn(namespaces, 'xmlns')
      || Object.entries(namespaces).some(([key, value]) => value === 'http://www.w3.org/2000/xmlns/' || key !== 'xml' && value === 'http://www.w3.org/XML/1998/namespace')) throw xmlError('Invalid XML namespace declaration.');
    const qualified = value => { const colon = value.indexOf(':'); return colon < 0 ? ['', value] : [value.slice(0, colon), value.slice(colon + 1)]; };
    const [prefix, localName] = qualified(name);
    if (prefix && !namespaces[prefix]) throw xmlError('Unbound XML prefix.');
    const expandedAttributes = new Set();
    for (const key of Object.keys(attributes)) {
      const [attributePrefix, attributeName] = qualified(key);
      if (attributePrefix && attributePrefix !== 'xmlns' && !namespaces[attributePrefix]) throw xmlError('Unbound XML attribute prefix.');
      const expanded = (attributePrefix ? namespaces[attributePrefix] : '') + '\0' + attributeName;
      if (expandedAttributes.has(expanded)) throw xmlError('Duplicate expanded XML attribute name.');
      expandedAttributes.add(expanded);
    }
    const preserveSpace = attributes['xml:space'] == null ? inheritedSpace : attributes['xml:space'] === 'preserve';
    const content = entry[name].filter(value => !Object.hasOwn(value, '#comment')
      && (!Object.hasOwn(value, '#text') || preserveSpace || !/^[ \t\r\n]*$/u.test(String(value['#text']))))
      .map(value => Object.hasOwn(value, '#text') ? restore(String(value['#text'])) : Object.hasOwn(value, '#cdata')
        ? restore(value['#cdata'].map(part => String(part['#text'] ?? '')).join('')) : build(value, namespaces, preserveSpace));
    return { localName, namespace: namespaces[prefix] ?? '', attributes, namespaces, content };
  };
  const roots = nodes.filter(entry => !Object.hasOwn(entry, '#text') && !Object.hasOwn(entry, '#comment'));
  if (roots.length !== 1 || nodes.some(entry => Object.hasOwn(entry, '#text') && clrTrim(String(entry['#text'])))) throw xmlError('XML must have one root element.');
  return build(roots[0]);
}

const text = node => node?.content.map(value => typeof value === 'string' ? value : text(value)).join('') ?? '';
const all = node => [node, ...node.content.filter(value => typeof value !== 'string').flatMap(all)];
const select = (document, namespace, name, predicate = () => true) => all(document).filter(node => node.namespace === namespace && node.localName === name && predicate(node));
const first = (...args) => select(...args)[0];
const nonblank = value => clrTrim(value) !== '';
const literal = value => {
  if (value.includes("'")) throw Object.assign(new Error('Invalid OPF XPath predicate.'), { nativeException: 'XPathException', code: 'invalid-book-xpath' });
  return value;
};
const attribute = (node, namespace, name) => Object.entries(node.attributes).find(([key]) => {
  const colon = key.indexOf(':'); return colon >= 0 && key.slice(colon + 1) === name && node.namespaces[key.slice(0, colon)] === namespace;
})?.[1];

function dateOnly(value) {
  const parsed = parseInvariantDate(value); if (parsed == null) return null;
  const date = new Date(parsed), wallclock = new Date(0);
  wallclock.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate()); wallclock.setUTCHours(0, 0, 0, 0);
  return { PremiereDate: wallclock.toISOString().replace('.000Z', '.0000000Z'), ProductionYear: date.getFullYear() };
}

export function readOpfMetadata(document, { signal, logger = { error() {} } } = {}) {
  signal?.throwIfAborted();
  const item = newNativeItemEntity('MediaBrowser.Controller.Entities.Book');
  let title = '';
  for (const node of select(document, opf, 'meta', node => node.attributes.property === 'title-type')) {
    const id = literal((node.attributes.refines ?? '').replace(/^#+/u, ''));
    const found = first(document, dc, 'title', node => node.attributes.id === id);
    if (found && text(node).toLowerCase() === 'main') title = text(found);
  }
  if (title === '') { const node = first(document, dc, 'title'); if (node && nonblank(text(node))) title = text(node); }
  item.Name = title;
  item.ForcedSortName = null;
  for (const node of select(document, opf, 'meta', node => node.attributes.property === 'file-as')) {
    const id = literal((node.attributes.refines ?? '').replace(/^#+/u, ''));
    if (first(document, dc, 'title', node => node.attributes.id === id)) { item.ForcedSortName = text(node); break; }
  }
  if (item.ForcedSortName == null) item.ForcedSortName = first(document, opf, 'meta', node => node.attributes.name === 'calibre:title_sort')?.attributes.content ?? null;
  const scalar = (name, apply, predicate) => { const node = first(document, dc, name, predicate); if (node && nonblank(text(node))) apply(text(node)); };
  scalar('description', value => { item.Overview = value; });
  scalar('publisher', value => { item.Studios = [value]; });
  for (const [scheme, key] of [['AMAZON', 'Amazon'], ['GOOGLE', 'GoogleBooks'], ['ISBN', 'ISBN']]) scalar('identifier', value => { item.ProviderIds = { ...item.ProviderIds, [key]: clrTrim(value) }; }, node => attribute(node, opf, 'scheme') === scheme);
  scalar('date', value => { const date = dateOnly(value); if (date) Object.assign(item, date); });
  const genres = [];
  for (const node of select(document, dc, 'subject')) for (const value of text(node).split(/\/|&|,|;| - /u).map(clrTrim).filter(Boolean)) {
    if (!genres.some(genre => ordinalIgnoreCaseKey(genre) === ordinalIgnoreCaseKey(value))) genres.push(value);
  }
  item.Genres = genres;
  for (const [name, field] of [['calibre:series_index', 'IndexNumber'], ['calibre:rating', 'CommunityRating']]) {
    const value = first(document, opf, 'meta', node => node.attributes.name === name)?.attributes.content;
    if (value == null || value === '') continue;
    try {
      const normalized = clrTrim(value), numeric = /^[+-]?(?:(?:\d+(?:,\d*)*)(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(normalized)
        ? Number(normalized.replaceAll(',', '')) : /^(?:[+-]?Infinity|NaN)$/iu.test(normalized) ? Number(normalized) : null;
      if (numeric == null) throw Object.assign(new Error('Invalid OPF number.'), { nativeException: 'FormatException' });
      const converted = roundEven(numeric);
      if (!Number.isFinite(converted) || converted < -2147483648 || converted > 2147483647) throw Object.assign(new Error('OPF number exceeds Int32.'), { nativeException: 'OverflowException' });
      item[field] = field === 'CommunityRating' ? Math.fround(converted) : converted;
    } catch (error) { logger.error(error, 'Error converting OPF number to Int32.'); }
  }
  const series = first(document, opf, 'meta', node => node.attributes.name === 'calibre:series')?.attributes.content;
  if (series != null && series !== '') item.SeriesName = series;
  let people = null;
  const roles = { arr: 'Arranger', art: 'Artist', edt: 'Editor', ill: 'Illustrator', lyr: 'Lyricist', mus: 'AlbumArtist', nrt: 'Narrator', oth: 'Unknown', trl: 'Translator' };
  for (const creator of select(document, dc, 'creator')) for (let name of text(creator).split(';').map(clrTrim).filter(Boolean)) {
    const comma = name.indexOf(','), parts = comma < 0 ? [] : [name.slice(0, comma), name.slice(comma + 1)].map(value => clrTrim(value.replace(/^,+/u, ''))).filter(Boolean);
    if (parts.length === 2) name = parts[1] + ' ' + parts[0];
    name = name.replace(/\./gu, (period, offset, source) => offset > 0 && /^\p{L}$/u.test(source[offset - 1]) && offset + 1 < source.length && !initialsWhitespace.test(source[offset + 1]) ? '. ' : period);
    addPerson(people ??= [], { Name: name, Type: roles[creator.attributes['opf:role']] ?? 'Author' });
  }
  let language = null; scalar('language', value => { language = value; });
  return { HasMetadata: true, Item: item, People: people, ResultLanguage: language };
}

// Path.Combine retains relative separators and dot segments; archive keys must
// not pass through a filesystem path normalizer before exact entry lookup.
export function combineOpfPath(directory, filename) {
  if (process.platform !== 'win32') {
    if (!directory || filename.startsWith('/')) return filename;
    return directory + (directory.endsWith('/') ? '' : '/') + filename;
  }
  if (!directory || /^[\\/]|^[A-Za-z]:/u.test(filename)) return filename;
  return directory + (/[\\/]$/u.test(directory) ? '' : '\\') + filename;
}

export function readOpfCoverPath(document, directory) {
  const manifest = node => {
    const href = node?.attributes.href, mimeType = node?.attributes['media-type'];
    if (!href || !mimeType || !mimeToExtension(mimeType)) return null;
    return { path: combineOpfPath(directory, href), mimeType };
  };
  for (const predicate of [node => node.attributes.properties === 'cover-image', node => node.attributes.id === 'cover' && node.attributes['media-type'] === 'image/*', node => node.attributes.id === '*cover-image']) {
    const result = manifest(first(document, opf, 'item', predicate)); if (result) return result;
  }
  const content = first(document, opf, 'meta', node => node.attributes.name === 'cover')?.attributes.content;
  if (!content) return null;
  const combined = literal(combineOpfPath('Images', content));
  const byHref = first(document, opf, 'item', node => node.attributes.href === combined);
  const mimeType = byHref?.attributes['media-type'];
  if (mimeType && mimeToExtension(mimeType)) return { path: combineOpfPath(directory, combined), mimeType };
  return manifest(first(document, opf, 'item', node => node.attributes.id === literal(content)));
}

export function readEpubContentPath(document) {
  return first(document, containerNamespace, 'rootfile')?.attributes['full-path'] ?? null;
}
