// TagLibSharp image-reader attribution and license: resources/photo-tags-notice.txt.
import { inflateSync } from 'node:zlib';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { calendarDateToUtc } from './calendar-date.js';
import { clrTrim } from './whitespace.js';
import { dateTicks } from '../library/records.js';
import { epochTicks, formatUtcTicks } from '../syncplay/time.js';

const namespaces = { rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', dc: 'http://purl.org/dc/elements/1.1/',
  xmp: 'http://ns.adobe.com/xap/1.0/', tiff: 'http://ns.adobe.com/tiff/1.0/', exif: 'http://ns.adobe.com/exif/1.0/' };
const fail = message => { throw Object.assign(new Error(message), { code: 'invalid-photo-tags' }); };
const terminated = value => value.split('\0', 1)[0];
const uint = value => {
  if (value == null || !/^[+-]?\d+$/u.test(clrTrim(value))) return null;
  const number = Number(value); return Number.isSafeInteger(number) && number >= 0 && number <= 0xffffffff ? number : null;
};
const rationalText = value => {
  if (value == null || clrTrim(value) === '') return null;
  const parts = value.split('/'), parsed = parts.map(value => {
    const text = clrTrim(value).replaceAll(',', '');
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text)) return Number(text);
    return ['NaN', 'Infinity', '+Infinity', '-Infinity'].includes(text) ? Number(text) : null;
  });
  if (parts.length === 1) return parsed[0];
  return parts.length === 2 && parsed.every(value => value != null) && parsed[1] !== 0 ? parsed[0] / parsed[1] : null;
};

function calendarValid(year, month, day, hour, minute, second) {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
const wallTicks = (year, month, day, hour, minute, second, fraction = 0n) => {
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, 0);
  return epochTicks + BigInt(date.valueOf()) * 10000n + fraction;
};
function parseCaptureDate(value, exif = false) {
  if (!value) return null;
  const text = exif ? value : clrTrim(value);
  const match = exif ? /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)$/u.exec(text)
    : /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d)(?:\.(\d+))?)?)?(Z|[+-]\d\d:\d\d)?$/iu.exec(text);
  if (match) {
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(value => Number(value ?? 0));
    if (!calendarValid(year, month, day, hour, minute, second)) return null;
    const fraction = BigInt((match[7] ?? '').slice(0, 7).padEnd(7, '0'));
    const localTicks = wallTicks(year, month, day, hour, minute, second, fraction);
    if (!exif && match[8]) {
      const zone = match[8];
      const offset = zone.toUpperCase() === 'Z' ? 0 : (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4))) * (zone[0] === '-' ? -1 : 1);
      if (Math.abs(offset) > 840 || Number(zone.slice(4)) > 59) return null;
      const instant = localTicks - BigInt(offset) * 600000000n;
      const date = new Date(Number((instant - epochTicks) / 10000n));
      const premiere = wallTicks(date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), fraction);
      return { DateCreated: formatUtcTicks(instant), PremiereDate: formatUtcTicks(premiere), ProductionYear: date.getFullYear() };
    }
    const instant = dateTicks(calendarDateToUtc(year, month, day)) + BigInt(hour * 3600 + minute * 60 + second) * 10000000n + fraction;
    return { DateCreated: formatUtcTicks(instant), PremiereDate: formatUtcTicks(localTicks), ProductionYear: year };
  }
  if (exif) return null;
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds), instant = epochTicks + BigInt(milliseconds) * 10000n;
  return { DateCreated: formatUtcTicks(instant), PremiereDate: formatUtcTicks(wallTicks(date.getFullYear(), date.getMonth() + 1,
    date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), BigInt(date.getMilliseconds()) * 10000n)), ProductionYear: date.getFullYear() };
}
function captureDate(value, exif = false) {
  try { return parseCaptureDate(value, exif); }
  catch { return null; }
}

function xmpTags(text) {
  if (XMLValidator.validate(text) !== true) fail('Invalid embedded XMP document.');
  const parsed = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '',
    trimValues: false, parseTagValue: false, parseAttributeValue: false, ignoreDeclaration: true }).parse(text);
  const properties = new Map();
  const expanded = (name, scope) => { const colon = name.indexOf(':'); return colon < 0 ? [scope[''] ?? '', name] : [scope[name.slice(0, colon)] ?? '', name.slice(colon + 1)]; };
  const elements = (nodes, inherited) => nodes.flatMap(node => Object.entries(node).filter(([name]) => ![':@', '#text', '#comment'].includes(name) && !name.startsWith('?')).map(([name, children]) => {
    const attributes = node[':@'] ?? {}, scope = { ...inherited };
    for (const [key, value] of Object.entries(attributes)) if (key === 'xmlns') scope[''] = value; else if (key.startsWith('xmlns:')) scope[key.slice(6)] = value;
    const [ns, local] = expanded(name, scope);
    return { ns, local, attributes, scope, nodes: children, children: () => elements(children, scope),
      text: () => { const value = children.map(value => value['#text'] ?? '').join('');
        return /^[ \t\r\n]*$/u.test(value) ? '' : value; } };
  }));
  const property = node => {
    const children = node.children(), collection = children.find(child => child.ns === namespaces.rdf && ['Alt', 'Bag', 'Seq'].includes(child.local));
    if (collection) return { type: collection.local, values: collection.children().filter(child => child.ns === namespaces.rdf && child.local === 'li')
      .map(child => ({ value: child.text(), language: child.attributes['xml:lang'] })) };
    const qualified = children.find(child => child.ns === namespaces.rdf && child.local === 'value');
    if (qualified) return property(qualified);
    return children.length ? { type: 'Struct' } : { type: 'Simple', value: node.attributes['rdf:resource'] ?? node.text() };
  };
  function walk(nodes, scope = { xml: 'http://www.w3.org/XML/1998/namespace' }) {
    for (const node of elements(nodes, scope)) {
      if (node.ns === namespaces.rdf && node.local === 'Description') {
        for (const [name, value] of Object.entries(node.attributes)) {
          const [ns, local] = expanded(name, node.scope);
          if (ns && ![namespaces.rdf, 'http://www.w3.org/XML/1998/namespace'].includes(ns) && !name.startsWith('xmlns')) properties.set(ns + '|' + local, { type: 'Simple', value });
        }
        for (const child of node.children()) properties.set(child.ns + '|' + child.local, property(child));
      } else walk(node.nodes, node.scope);
    }
  }
  walk(parsed);
  const get = (ns, name) => properties.get(namespaces[ns] + '|' + name);
  const simple = (ns, name) => { const node = get(ns, name); return node?.type === 'Simple' ? node.value : null; };
  const alt = (ns, name) => { const node = get(ns, name); return node?.type === 'Simple' ? node.value
    : node?.type === 'Alt' ? (node.values.find(value => value.language === 'x-default') ?? node.values[0])?.value ?? null : null; };
  const collection = (ns, name) => { const node = get(ns, name); return node ? node.values?.map(value => value.value) ?? [] : null; };
  return { Title: alt('dc', 'title'), Comment: alt('dc', 'description') ?? alt('exif', 'UserComment'), Keywords: collection('dc', 'subject') ?? [],
    Make: simple('tiff', 'Make'), Model: simple('tiff', 'Model'), Software: simple('xmp', 'CreatorTool'), Rating: uint(simple('xmp', 'Rating')),
    DateTime: captureDate(simple('xmp', 'CreateDate')), Orientation: uint(simple('tiff', 'Orientation')),
    ExposureTime: rationalText(simple('exif', 'ExposureTime')), FocalLength: rationalText(simple('exif', 'FocalLength')),
    ISOSpeedRatings: uint(collection('exif', 'ISOSpeedRatings')?.[0]) ?? uint(simple('exif', 'ISOSpeedRating')) };
}

function tiffTags(bytes, cr2 = false) {
  if (bytes.length < 8 || !['II', 'MM'].includes(bytes.toString('ascii', 0, 2))) fail('Invalid TIFF byte order.');
  const little = bytes[0] === 73;
  const check = (offset, length) => { if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > bytes.length) fail('Truncated TIFF entry.'); };
  const u16 = offset => { check(offset, 2); return little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset); };
  const u32 = offset => { check(offset, 4); return little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset); };
  const i32 = offset => { check(offset, 4); return little ? bytes.readInt32LE(offset) : bytes.readInt32BE(offset); };
  if (u16(2) !== 42) fail('Invalid TIFF header.');
  if (cr2 && (bytes.length < 16 || !bytes.subarray(8, 12).equals(Buffer.from([67, 82, 2, 0])))) fail('Invalid CR2 header.');
  const sizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8], visited = new Set();
  function directory(offset) {
    const entries = new Map(); if (!offset) return entries;
    if (visited.has(offset)) fail('Cyclic TIFF directories.'); visited.add(offset);
    const count = u16(offset); check(offset + 2, count * 12 + 4);
    for (let index = 0; index < count; index++) {
      const base = offset + 2 + 12 * index, tag = u16(base), type = u16(base + 2), count = u32(base + 4), length = (sizes[type] ?? 0) * count;
      if (!sizes[type] || count > 0x10000000) continue;
      const start = length <= 4 ? base + 8 : u32(base + 8);
      // TagLib records an out-of-file data pointer as an undefined entry;
      // other fields in the same directory remain readable.
      if (start > bytes.length) continue;
      check(start, length);
      const data = bytes.subarray(start, start + length);
      let value;
      if (type === 2) value = terminated(data.toString('utf8'));
      else if ([5, 10].includes(type)) value = Array.from({ length: count }, (_, index) => {
        const numerator = type === 10 ? i32(start + index * 8) : u32(start + index * 8);
        const denominator = type === 10 ? i32(start + index * 8 + 4) : u32(start + index * 8 + 4);
        return denominator === 0 ? 0 : numerator / denominator;
      });
      else if (type === 3) value = Array.from({ length: count }, (_, index) => u16(start + index * 2));
      else if (type === 4) value = Array.from({ length: count }, (_, index) => u32(start + index * 4));
      else value = data;
      entries.set(tag, { type, count, value, data });
    }
    return entries;
  }
  const first = directory(u32(4));
  const number = (entries, tag) => { const entry = entries.get(tag); return entry?.count === 1 && [3, 4].includes(entry.type) ? entry.value[0] : null; };
  const exif = directory(number(first, 0x8769) ?? 0), gps = directory(number(first, 0x8825) ?? 0);
  const string = (entries, tag) => entries.get(tag)?.type === 2 ? entries.get(tag).value : null;
  const rational = (entries, tag, unsigned = false) => { const entry = entries.get(tag); return entry?.count === 1 && (unsigned ? entry.type === 5 : [5, 10].includes(entry.type)) ? entry.value[0] : null; };
  const coordinate = (tag, reference, maximum, negative) => {
    const entry = gps.get(tag), direction = string(gps, reference);
    if (entry?.type !== 5 || entry.count !== 3 || direction == null) return null;
    const value = (entry.value[0] + entry.value[1] / 60 + entry.value[2] / 3600) * (direction === negative ? -1 : 1);
    return Math.max(-maximum, Math.min(value, maximum));
  };
  let comment = string(first, 0x10e);
  const user = exif.get(0x9286);
  if (user && user.count > 4 && user.type !== 2 && ![3, 4, 5, 10].includes(user.type)) {
    const data = user.data, prefix = data.subarray(0, 8).toString('latin1');
    if (prefix === 'ASCII\0\0\0') comment = terminated(data.subarray(8).toString('latin1'));
    else if (prefix === 'UNICODE\0' || prefix === 'Unicode\0') comment = terminated(data.subarray(8).toString('utf8'));
    else if (data[0] === 0 && data.length >= 8) comment = terminated(data.subarray(8).toString('latin1'));
    else comment = terminated(data.toString('utf8'));
  }
  const altitude = rational(gps, 6), altitudeRef = gps.get(5);
  return { Width: number(cr2 ? exif : first, cr2 ? 0xa002 : 0x100) ?? 0, Height: number(cr2 ? exif : first, cr2 ? 0xa003 : 0x101) ?? 0,
    xmp: first.get(700)?.data.toString('utf8'), Aperture: rational(exif, 0x9202, true), ShutterSpeed: rational(exif, 0x9201, true),
    tags: { Make: string(first, 0x10f), Model: string(first, 0x110), Software: string(first, 0x131), Comment: comment,
      Orientation: number(first, 0x112), DateTime: captureDate(string(exif, 0x9003), true), ExposureTime: rational(exif, 0x829a),
      FocalLength: rational(exif, 0x920a), ISOSpeedRatings: number(exif, 0x8827), Latitude: coordinate(2, 1, 90, 'S'),
      Longitude: coordinate(4, 3, 180, 'W'), Altitude: altitude == null ? null : altitude * (altitudeRef?.type === 1 && altitudeRef.count === 1 && altitudeRef.data[0] === 1 ? -1 : 1) } };
}

function iimTags(bytes) {
  if (!bytes.subarray(0, 20).equals(Buffer.from('Photoshop 3.0\0' + '8BIM\x04\x04', 'latin1'))) return null;
  const length = bytes[20] ?? 0, start = 20 + (length > 0 ? 1 + length + 4 : 6);
  const result = { Keywords: [] }; let found = false;
  for (let offset = start; offset + 5 <= bytes.length;) {
    const next = bytes.indexOf(Buffer.from([28, 2]), offset); if (next < 0 || next + 5 > bytes.length) break;
    const tag = bytes[next + 2], size = bytes.readUInt16BE(next + 3), value = bytes.subarray(next + 5, next + 5 + size).toString('latin1');
    if (tag === 5) result.Title = value; else if (tag === 120) result.Comment = value; else if (tag === 25) result.Keywords.push(value);
    found = true; offset = next + 5 + size;
  }
  return found ? result : null;
}
function jpegTags(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) fail('Invalid JPEG header.');
  let Width = 0, Height = 0, exif, xmp, iim, comment;
  for (let offset = 2; offset < bytes.length;) {
    if (bytes[offset++] !== 255) fail('Invalid JPEG marker.');
    while (bytes[offset] === 255) offset++;
    const code = bytes[offset++]; if ([0xda, 0xd9].includes(code)) break;
    if (code === 0x01 || code >= 0xd0 && code <= 0xd7) continue;
    if (offset + 2 > bytes.length) fail('Truncated JPEG segment.');
    const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) fail('Truncated JPEG segment.');
    const data = bytes.subarray(offset + 2, offset + length); offset += length;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(code) && data.length >= 5) { Height = data.readUInt16BE(1); Width = data.readUInt16BE(3); }
    else if (code === 0xe1 && data.subarray(0, 6).equals(Buffer.from('Exif\0\0'))) exif = tiffTags(data.subarray(6));
    else if (code === 0xe1 && data.subarray(0, 29).equals(Buffer.from('http://ns.adobe.com/xap/1.0/\0'))) xmp = xmpTags(data.subarray(29).toString('utf8'));
    else if (code === 0xed) { const tag = iimTags(data); if (tag) iim = tag; }
    else if (code === 0xfe && comment == null) comment = data.toString('utf8');
  }
  return { Width, Height, exif, xmp, iim, other: comment == null ? [] : [{ Comment: comment }] };
}
function crc(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let index = 0; index < 8; index++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; } return (value ^ 0xffffffff) >>> 0; }
function pngTags(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('Invalid PNG header.');
  let Width = 0, Height = 0, xmp, ended = false; const texts = new Map();
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + 12 + length > bytes.length) fail('Truncated PNG chunk.');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (['IHDR', 'iTXt', 'tEXt', 'zTXt', 'IEND'].includes(type)
      && crc(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) fail('Invalid PNG checksum.');
    offset += 12 + length;
    if (type === 'IHDR') { if (data.length !== 13) fail('Invalid PNG dimensions.'); Width = data.readUInt32BE(0); Height = data.readUInt32BE(4); }
    else if (type === 'IEND') { ended = true; break; }
    else if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
      const separator = data.indexOf(0); if (separator < 1 || separator > 79) fail('Invalid PNG keyword.');
      const keyword = data.toString('utf8', 0, separator); let value = data.subarray(separator + 1);
      if (type === 'iTXt' && data.subarray(0, 22).equals(Buffer.from('XML:com.adobe.xmp\0\0\0\0\0'))) { xmp = xmpTags(data.subarray(22).toString('utf8')); continue; }
      if (type === 'zTXt') {
        if (!value.length) fail('Missing PNG compression method.'); if (value[0] !== 0) continue;
        try { value = inflateSync(value.subarray(1), { maxOutputLength: 64 * 1024 * 1024 }); } catch { fail('Invalid compressed PNG metadata.'); }
        if (keyword === 'xmp') fail('An unprofiled PNG xmp text chunk cannot be read by the native tag reader.');
        if (keyword.startsWith('Raw profile type')) {
          const parts = value.toString('utf8').split('\n');
          if (parts.length < 4) fail('Invalid PNG raw profile.');
          if (parts[1].toLowerCase() === 'xmp') { xmp = xmpTags(parts.slice(3).map(line => Buffer.from(line, 'hex').toString('utf8').replace(/^\0+|\0+$/gu, '')).join('')); continue; }
        }
      } else if (type === 'iTXt') {
        if (value.length < 2) fail('Missing PNG compression bytes.');
        if (value[0] !== 0) { if (value[1] !== 0) continue; try { value = inflateSync(value, { maxOutputLength: 64 * 1024 * 1024 }); } catch { fail('Invalid compressed PNG metadata.'); } }
      }
      if (!texts.has(keyword)) texts.set(keyword, value.toString('utf8'));
    }
  }
  if (!ended) fail('PNG has no end marker.');
  return { Width, Height, xmp, other: [{ Title: texts.get('Title'), Comment: texts.get('Description') || texts.get('Comment'),
    Software: texts.get('Software'), DateTime: captureDate(texts.get('Creation Time')) }] };
}

/** Decode the image-tag semantics of the pinned TagLibSharp 2.3 reader.
 * Static original-file bytes enter through the caller's storage asset scope. */
export function readPhotoTags(bytes, extension) {
  let parsed;
  if (['.jpg', '.jpeg'].includes(extension)) parsed = jpegTags(bytes);
  else if (extension === '.png') parsed = pngTags(bytes);
  else if (['.tiff', '.cr2'].includes(extension)) {
    const exif = tiffTags(bytes, extension === '.cr2'); parsed = { Width: exif.Width, Height: exif.Height, exif,
      xmp: exif.xmp ? xmpTags(exif.xmp) : null };
  } else throw Object.assign(new Error('The native tag reader does not support this photo format.'), { code: 'unsupported-photo-tags' });
  let xmp = parsed.xmp ?? parsed.iim;
  if (parsed.xmp && parsed.iim) {
    xmp = { ...parsed.xmp }; for (const field of ['Title', 'Comment']) if (!xmp[field]) xmp[field] = parsed.iim[field];
  }
  const groups = [xmp, parsed.exif?.tags, ...parsed.other ?? []].filter(Boolean);
  const first = (name, predicate) => groups.map(group => group[name]).find(value => value != null && predicate(value));
  const value = name => first(name, () => true) ?? null;
  const text = name => first(name, value => value !== '') ?? null;
  return { Width: parsed.Width, Height: parsed.Height, Aperture: parsed.exif?.Aperture, ShutterSpeed: parsed.exif?.ShutterSpeed,
    Make: text('Make'), Model: text('Model'), Software: text('Software'), Title: text('Title'), Comment: text('Comment') ?? '',
    Keywords: first('Keywords', value => value.length > 0) ?? [], Genres: [], Rating: value('Rating'), DateTime: value('DateTime'),
    Orientation: first('Orientation', value => value >= 1 && value <= 8) ?? 0,
    ExposureTime: value('ExposureTime'), FocalLength: value('FocalLength'), ISOSpeedRatings: value('ISOSpeedRatings'),
    Latitude: value('Latitude'), Longitude: value('Longitude'), Altitude: value('Altitude') };
}
