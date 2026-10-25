import { XmlError } from '@mediamanager/plugin-sdk/core/xml';
import { XmlTokenCursor } from '@mediamanager/plugin-sdk/core/xml-stream';
import { clrTrim, clrWhitespace } from '@mediamanager/plugin-sdk/metadata/whitespace';
import { ordinalIgnoreCaseEquals } from '@mediamanager/plugin-sdk/storage/ordinal-comparer';
import { tryParseClrInt32Enum } from '@mediamanager/plugin-sdk/metadata/clr-enum';
import { dateTicks, MIN_DATE } from '@mediamanager/plugin-sdk/library/records';

const int = value => /^[+-]?\d+$/u.test(clrTrim(value)) && Number(value) >= -2147483648 && Number(value) <= 2147483647 ? Number(value) : null;
const emptyOffset = { utc: MIN_DATE, offsetDate: MIN_DATE.replace('Z', '+00:00') };
const whitespace = new RegExp(`^[${clrWhitespace}]*$`, 'u');
// CLR's end anchor also matches immediately before one final line feed.
const dateExpression = new RegExp(`^([0-9]{4,14})(?:[${clrWhitespace}]([+-]*[0-9]{1,4}))?\\n?$`, 'u');

/** The pinned reader pads a partial XMLTV timestamp, preserving its offset. */
export function parseXmlTvDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const match = dateExpression.exec(value); if (!match) return null;
  const digits = match[1] + '20000101000000'.slice(match[1].length);
  const [year, month, day, hour, minute, second] = [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8),
    digits.slice(8, 10), digits.slice(10, 12), digits.slice(12, 14)].map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  let zone = '+00:00', offset = 0;
  if (match[2]?.length === 5) {
    const raw = match[2]; if (!/^[+-]\d{4}$/u.test(raw)) return null;
    const hours = Number(raw.slice(1, 3)), minutes = Number(raw.slice(3));
    if (hours > 14 || minutes > 59 || hours === 14 && minutes !== 0) return null;
    offset = (hours * 60 + minutes) * (raw[0] === '-' ? -1 : 1);
    zone = offset === 0 ? '+00:00' : raw.slice(0, 3) + ':' + raw.slice(3);
  }
  const wall = date.toISOString().replace('.000Z', '.0000000'); date.setTime(date.getTime() - offset * 60000);
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return null;
  return { utc: date.toISOString().replace('.000Z', '.0000000Z'), offsetDate: wall + zone };
}

// DtdProcessing.Ignore discards declarations without loading their external
// resources or defining entities. Literal/attribute EOL normalization happens
// before the shared cursor decodes numeric character references.
function normalizedXml(source) {
  const xml = String(source).replace(/\r\n?/gu, '\n');
  let result = '', index = 0, rootStarted = false, doctypeSeen = false;
  while (index < xml.length) {
    if (xml.startsWith('<!--', index) || xml.startsWith('<![CDATA[', index)) {
      const ending = xml.startsWith('<!--', index) ? '-->' : ']]>', end = xml.indexOf(ending, index);
      if (end < 0) throw new XmlError('An XML comment or CDATA section was not closed.');
      result += xml.slice(index, end + ending.length); index = end + ending.length; continue;
    }
    if (xml.startsWith('<!DOCTYPE', index)) {
      const declaration = xml.slice(index + 9);
      if (rootStarted || doctypeSeen || !/^[\t\n ]+/u.test(declaration) || !clrTrim(declaration)
        || ['>', '[', ']'].includes(clrTrim(declaration)[0])) throw new XmlError('The document type declaration is invalid.');
      doctypeSeen = true;
      let quote, depth = 0, end = index + 9;
      for (; end < xml.length; end++) {
        const char = xml[end];
        if (quote) { if (char === quote) quote = undefined; continue; }
        if (xml.startsWith('<!--', end)) {
          const commentEnd = xml.indexOf('-->', end + 4);
          if (commentEnd < 0) throw new XmlError('A document type comment was not closed.');
          end = commentEnd + 2; continue;
        }
        if (char === '"' || char === "'") quote = char;
        else if (char === '[') depth++;
        else if (char === ']') { if (--depth < 0) throw new XmlError('A document type subset is invalid.'); }
        else if (char === '>' && depth === 0) break;
      }
      if (end >= xml.length || depth !== 0) throw new XmlError('A document type declaration was not closed.');
      index = end + 1; continue;
    }
    if (xml[index] === '<') {
      if (!xml.startsWith('<?', index) && !xml.startsWith('</', index)) rootStarted = true;
      let quote;
      do {
        const char = xml[index++];
        if (quote) {
          result += /[\t\n]/u.test(char) ? ' ' : char;
          if (char === quote) quote = undefined;
        } else {
          result += char;
          if (char === '"' || char === "'") quote = char;
          if (char === '>') break;
        }
      } while (index < xml.length);
    } else result += xml[index++];
  }
  return result;
}

function document(source) {
  const cursor = new XmlTokenCursor(normalizedXml(source)), roots = [];
  while (true) {
    const token = cursor.readToken();
    if (token.type === 'eof') break;
    if (token.type === 'start') roots.push(cursor.readNode(token));
    else if (token.type === 'end' || token.type === 'text' && !whitespace.test(token.value)) throw new XmlError('Invalid content outside the document element.');
  }
  if (roots.length !== 1) throw new XmlError('An XML document must have exactly one root element.');
  const nodes = [];
  const flatten = node => {
    const entry = { node, end: 0 }, index = nodes.push(entry) - 1;
    for (const child of node.children) flatten(child);
    nodes[index].end = nodes.length;
  };
  flatten(roots[0]); return nodes;
}
const scalar = node => {
  if (node.children.length) throw new XmlError('ReadElementContentAsString cannot read an element with child elements.');
  return node.text;
};
const icon = node => {
  const { src, width, height } = node.attributes;
  if (src || width !== undefined && int(width) !== null || height !== undefined && int(height) !== null) return { Source: src || null };
  return null;
};
const systemNames = new Set(['tmdb', 'themoviedb', 'themoviedb.org', 'moviedb', 'tvdb', 'thetvdb', 'thetvdb.com', 'imdb', 'imdb.com']);
const imageTypes = ['Poster', 'Backdrop', 'Still', 'Person', 'Character'];
function image(node) {
  const path = scalar(node), attributes = node.attributes;
  const type = tryParseClrInt32Enum(attributes.type, imageTypes, { ignoreCase: true });
  const populated = type !== null || tryParseClrInt32Enum(attributes.size, ['Small', 'Medium', 'Large'], { ignoreCase: true }) !== null
    || tryParseClrInt32Enum(attributes.orient, ['Portrait', 'Landscape'], { ignoreCase: true }) !== null || systemNames.has(attributes.system) || !!path;
  return populated ? { Type: type ?? 'Poster', Path: path || null } : null;
}

function group(content, start, language, multiple = false, all = () => {}) {
  const name = content[start].name, values = [];
  let index = start;
  for (; index < content.length; index++) {
    const node = content[index]; if (typeof node === 'string') continue;
    if (node.name !== name) break;
    const value = scalar(node); all(value); values.push({ value, language: node.attributes.lang ?? null });
  }
  if (multiple) {
    const matching = values.some(entry => entry.language === language);
    return { next: index, values: values.filter(entry => !matching || entry.language === language).map(entry => entry.value) };
  }
  const chosen = values.find(entry => entry.language === language || ordinalIgnoreCaseEquals(entry.language, language))
    ?? values.find(entry => entry.language == null || !clrTrim(entry.language)) ?? values[0];
  return { next: index, value: chosen?.value ?? null };
}
function firstPosition(nodes, name) {
  const tv = nodes.findIndex(entry => entry.node.name === 'tv'); if (tv < 0) return -1;
  const first = nodes.findIndex((entry, index) => index > tv && index < nodes[tv].end && entry.node.name === name);
  return first;
}
function following(nodes, start, name) { return nodes.findIndex((entry, index) => index >= start && entry.node.name === name); }
function numericChannel(value) {
  const converted = value.replaceAll('-', '.').replaceAll('_', '.');
  let text = clrTrim(converted);
  if (text.startsWith('(') && text.endsWith(')')) text = clrTrim(text.slice(1, -1));
  text = text.replaceAll('¤', '').replaceAll(',', '');
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text) || /^[+-]?(?:NaN|Infinity)$/iu.test(text)) return converted;
  return null;
}

export function readXmlTvChannels(xml, language = null) {
  const nodes = document(xml), result = [];
  for (let position = firstPosition(nodes, 'channel'); position >= 0; position = following(nodes, nodes[position].end, 'channel')) {
    const node = nodes[position].node, Id = node.attributes.id;
    if (!Id) continue;
    const channel = { Id, DisplayName: null, Number: null, Icons: null };
    for (let index = 0; index < node.content.length;) {
      const child = node.content[index]; if (typeof child === 'string') { index++; continue; }
      if (child.name === 'display-name') {
        const value = group(node.content, index, language, false, text => { const number = numericChannel(text); if (number !== null) channel.Number = number; });
        channel.DisplayName = value.value; index = value.next;
      } else if (child.name === 'icon') {
        const value = icon(child); if (value) (channel.Icons ??= []).push(value); index++;
      } else if (child.name === 'url') { scalar(child); index += 2; }
      else index++;
    }
    if (channel.DisplayName) result.push(channel);
  }
  return result;
}

function episodeNumber(node, result) {
  result.Episode ??= { Title: null, Series: null, Episode: null };
  const system = node.attributes.system;
  if (system === 'onscreen' || !['dd_progid', 'icetv', 'xmltv_ns', 'thetvdb.com', 'imdb.com', 'themoviedb.org', 'SxxExx'].includes(system)) return;
  const value = scalar(node);
  if (system === 'dd_progid') { if (clrTrim(value)) result.ProgramId = value; }
  else if (system === 'xmltv_ns') {
    const pieces = value.replaceAll(' ', '').split('.');
    for (const [index, field] of [[0, 'Series'], [1, 'Episode']]) {
      const number = pieces[index] == null ? null : int(pieces[index].split('/')[0]);
      if (number !== null) result.Episode[field] = number + 1 | 0;
    }
  } else if (system === 'SxxExx') {
    const match = /s([0-9]+)e([0-9]+)/iu.exec(value);
    if (match) for (const [index, field] of [[1, 'Series'], [2, 'Episode']]) {
      const number = int(match[index]); if (number !== null) result.Episode[field] = number;
    }
  } else if (system === 'themoviedb.org') {
    const pieces = value.split('/').filter(Boolean);
    if (!pieces.length || ordinalIgnoreCaseEquals(pieces[0], 'series') && pieces.length < 2) throw new RangeError('Invalid XMLTV movie database episode number.');
  }
}
function rating(node, star) {
  const result = { Value: null, StarRating: null };
  for (let index = 0; index < node.content.length; index++) {
    const child = node.content[index]; if (typeof child === 'string') continue;
    if (ordinalIgnoreCaseEquals(child.name, 'value')) {
      const value = scalar(child);
      if (star) { if (value.includes('/')) return null; }
      else { if (!value) return null; result.Value = value; }
      // The pinned reader accesses the underlying reader while a subtree is
      // open, then Skip advances its current sibling once more.
      index++;
    } else if (ordinalIgnoreCaseEquals(child.name, 'icon')) icon(child);
  }
  return result;
}

function credits(node) {
  const types = new Set(['director', 'actor', 'writer', 'adapter', 'producer', 'composer', 'editor', 'presenter', 'commentator', 'guest']);
  for (const credit of node.children) {
    if (!types.has(credit.name)) continue;
    for (let index = 0; index < credit.content.length; index++) {
      const child = credit.content[index]; if (typeof child === 'string') continue;
      if (ordinalIgnoreCaseEquals(child.name, 'image')) { image(child); index++; }
      else if (ordinalIgnoreCaseEquals(child.name, 'url')) { scalar(child); index++; }
    }
  }
}

export function readXmlTvPrograms(xml, { channelId, startDateUtc, endDateUtc, language = null, signal } = {}) {
  const nodes = document(xml), result = [], start = dateTicks(startDateUtc), end = dateTicks(endDateUtc);
  for (let position = firstPosition(nodes, 'programme'); position >= 0;) {
    const entry = nodes[position], node = entry.node, ChannelId = node.attributes.channel;
    if (!ChannelId || !ordinalIgnoreCaseEquals(ChannelId, channelId) || signal?.aborted) {
      position = following(nodes, position + 1, 'programme'); continue;
    }
    const StartDate = parseXmlTvDate(node.attributes.start) ?? emptyOffset, EndDate = parseXmlTvDate(node.attributes.stop) ?? emptyOffset;
    if (dateTicks(EndDate.utc) < start || dateTicks(StartDate.utc) >= end) { position = following(nodes, position + 1, 'programme'); continue; }
    const program = { ChannelId, StartDate, EndDate, Title: null, Description: null, ProgramId: null, Categories: [],
      Episode: null, Icons: null, Images: null, Ratings: null, StarRatings: null, CopyrightDate: null,
      IsPreviouslyShown: false, IsNew: false, IsLive: false, Premiere: null };
    for (let index = 0; index < node.content.length;) {
      const child = node.content[index]; if (typeof child === 'string') { index++; continue; }
      const name = child.name.toLowerCase();
      if (['title', 'desc', 'sub-title', 'premiere', 'category', 'keyword', 'country'].includes(name)) {
        const value = group(node.content, index, language, name === 'category' || name === 'keyword'); index = value.next;
        if (name === 'category') program.Categories.push(...value.values);
        else if (name === 'title') program.Title = value.value;
        else if (name === 'desc') program.Description = value.value;
        else if (name === 'sub-title') { program.Episode ??= { Title: null, Series: null, Episode: null }; program.Episode.Title = value.value; }
        else if (name === 'premiere') program.Premiere = value.value;
      } else if (name === 'icon') { const value = icon(child); if (value) (program.Icons ??= []).push(value); index++; }
      else if (name === 'image') { const value = image(child); if (value) (program.Images ??= []).push(value); index += 2; }
      else if (name === 'url' || name === 'language' || name === 'orig-language') { scalar(child); index += 2; }
      else if (name === 'episode-num') { episodeNumber(child, program); index++; }
      else if (name === 'new' || name === 'live') { program[name === 'new' ? 'IsNew' : 'IsLive'] = true; index++; }
      else if (name === 'previously-shown') {
        const previous = child.attributes.start ? parseXmlTvDate(child.attributes.start) : null;
        if (!child.attributes.start || previous === null || dateTicks(previous.utc) !== dateTicks(StartDate.utc)) program.IsPreviouslyShown = true;
        index++;
      } else if (name === 'date') { const value = scalar(child); if (!value) program.CopyrightDate = null; else program.CopyrightDate = parseXmlTvDate(value) ?? program.CopyrightDate; index++; }
      else if (name === 'rating' || name === 'star-rating') {
        const value = rating(child, name === 'star-rating'); if (value) (program[name === 'rating' ? 'Ratings' : 'StarRatings'] ??= []).push(value); index++;
      } else if (name === 'quality') { scalar(child); index++; }
      else if (name === 'credits') { credits(child); index++; }
      else index++;
    }
    result.push(program); position = following(nodes, entry.end, 'programme');
  }
  return result;
}
