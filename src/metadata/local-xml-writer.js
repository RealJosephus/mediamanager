import { nativeGuid, wireGuid } from '../users/native.js';
import { escapeXml, XmlError } from '../core/xml.js';
import { clrTrim } from './whitespace.js';

export const localXmlPageSize = 128;
export const localXmlBufferSize = 8192;
const zeroGuid = '00000000-0000-0000-0000-000000000000';
const mediaTypes = ['Unknown', 'Video', 'Audio', 'Photo', 'Book'];
const values = value => Array.isArray(value) ? value : [];
const typeOf = item => String(item?.Type ?? item?.NativeType ?? '').split('.').at(-1);

function localDate(value, dateOnly = false) {
  const source = value instanceof Date ? value : new Date(String(value).replace(' ', 'T')
    + (/Z$|[+-]\d\d:\d\d$/u.test(String(value)) ? '' : 'Z'));
  if (!Number.isFinite(source.valueOf())) throw new RangeError(`Invalid local XML date: ${value}`);
  const two = entry => String(entry).padStart(2, '0');
  return dateOnly ? `${String(source.getFullYear()).padStart(4, '0')}-${two(source.getMonth() + 1)}-${two(source.getDate())}`
    : `${two(source.getMonth() + 1)}/${two(source.getDate())}/${String(source.getFullYear()).padStart(4, '0')} ${two(source.getHours())}:${two(source.getMinutes())}:${two(source.getSeconds())}`;
}

function invariantDate(value) {
  const match = /^(\d{4})-(\d\d)-(\d\d)/u.exec(String(value));
  if (!match) throw new RangeError(`Invalid local XML date: ${value}`);
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** A single bounded UTF-8 frame. Dispose closes open elements for repository
 * failures; lexical XML and sink failures leave the writer's committed prefix. */
class XmlWriter {
  constructor(sink, newLine) {
    if (typeof sink?.write !== 'function') throw new TypeError('XML writing requires an asynchronous byte sink.');
    this.sink = sink; this.newLine = newLine; this.stack = [];
    this.buffer = Buffer.alloc(localXmlBufferSize); this.used = 0;
    this.lexicalFailure = false; this.sinkFailure = false;
  }

  async flush() {
    if (!this.used || this.sinkFailure) return;
    const bytes = this.buffer.subarray(0, this.used);
    try { await this.sink.write(bytes); this.used = 0; }
    catch (error) { this.sinkFailure = true; throw error; }
  }

  async bytes(bytes) {
    for (let offset = 0; offset < bytes.length;) {
      if (this.used === this.buffer.length) await this.flush();
      const count = Math.min(bytes.length - offset, this.buffer.length - this.used);
      this.buffer.set(bytes.subarray(offset, offset + count), this.used);
      this.used += count; offset += count;
    }
  }

  async raw(value) {
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(value.length, offset + 2048);
      if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1])) end--;
      await this.bytes(Buffer.from(value.slice(offset, end), 'utf8')); offset = end;
    }
  }

  async begin() {
    await this.bytes(Buffer.from([0xef, 0xbb, 0xbf]));
    await this.raw('<?xml version="1.0" encoding="utf-8" standalone="yes"?>');
    await this.start('Item');
  }

  async start(name) {
    if (!/^[A-Za-z_][A-Za-z\d_.:-]*$/u.test(name)) {
      this.lexicalFailure = true; throw new XmlError(`Invalid XML element name: ${name}`);
    }
    const parent = this.stack.at(-1);
    if (parent?.pending) { await this.raw('>'); parent.pending = false; }
    if (!parent?.text) await this.raw(this.newLine + '  '.repeat(this.stack.length));
    if (parent) parent.children = true;
    await this.raw('<' + name); this.stack.push({ name, pending: true, children: false, text: false });
  }

  async escaped(value) {
    // NewLineHandling.Replace is the native XmlWriter default.
    await this.raw(escapeXml(value).replaceAll('&quot;', '"').replace(/\r\n|\r|\n/gu, this.newLine));
  }

  async text(value) {
    const current = this.stack.at(-1);
    if (current.pending) { await this.raw('>'); current.pending = false; }
    current.text = true;
    // WriteStringAsync validates this whole scalar after opening its element,
    // before committing any of its text. Keep validation allocation-free.
    if (/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/u.test(value)) {
      this.lexicalFailure = true;
      throw new XmlError('The value contains an invalid XML character.');
    }
    let start = 0;
    for (let index = 0; index < value.length;) {
      const code = value.codePointAt(index), width = code > 0xffff ? 2 : 1;
      index += width;
      if (index - start >= 2048) {
        // Keep CR/LF together before normalizing this bounded text block.
        if (value[index - 1] === '\r' && value[index] === '\n') index++;
        await this.escaped(value.slice(start, index)); start = index;
      }
    }
    if (start < value.length) await this.escaped(value.slice(start));
  }

  async end() {
    const current = this.stack.at(-1);
    if (current.pending) await this.raw(' />');
    else {
      if (current.children && !current.text) await this.raw(this.newLine + '  '.repeat(this.stack.length - 1));
      await this.raw('</' + current.name + '>');
    }
    this.stack.pop();
  }

  async element(name, value, required = false) {
    if (value == null && !required) return;
    await this.start(name);
    if (value != null && String(value) !== '') await this.text(String(value));
    await this.end();
  }

  async list(plural, singular, entries, project = value => value) {
    if (!entries.length) return;
    await this.start(plural);
    for (const entry of entries) await this.element(singular, project(entry), true);
    await this.end();
  }

  async finish() {
    if (!this.lexicalFailure && !this.sinkFailure) while (this.stack.length) await this.end();
    await this.flush();
  }
}

async function linkedNodes(item, context, writer, type) {
  if (typeof context.prepareLinkedXmlItems !== 'function') {
    throw new TypeError('XML links require one relational path snapshot and bounded pages.');
  }
  // Preparation resolves the complete native batch before opening the plural
  // node. SQL stores IDs, duplicate order and resolved paths, not Node maps.
  const snapshot = await context.prepareLinkedXmlItems(item, { pageSize: localXmlPageSize });
  if (!snapshot || typeof snapshot.pages !== 'function' || typeof snapshot.close !== 'function') {
    throw new TypeError('A linked XML snapshot requires pages() and close().');
  }
  try {
    const count = BigInt(snapshot.manualCount);
    if (count < 0n) throw new TypeError('Manual XML link count cannot be negative.');
    if (!count) return;
    await writer.start(type === 'BoxSet' ? 'CollectionItems' : 'PlaylistItems');
    for await (const page of snapshot.pages({ limit: localXmlPageSize })) {
      if (!Array.isArray(page) || page.length > localXmlPageSize) throw new TypeError('Linked XML pages must contain at most 128 rows.');
      for (const row of page) {
        if (typeof row.Path !== 'string' || !clrTrim(row.Path)) continue;
        await writer.start(type === 'BoxSet' ? 'CollectionItem' : 'PlaylistItem');
        await writer.element('Path', row.Path, true); await writer.end();
      }
    }
    await writer.end();
  } finally { await snapshot.close(); }
}

/** The only serialization API writes to one asynchronous byte sink. It never
 * assembles a complete XML buffer, identifier list or linked-path map. */
export async function streamLocalXml(item, sink, context = {}) {
  const type = typeOf(item);
  if (!['BoxSet', 'Playlist'].includes(type)) throw new TypeError(`Unsupported local XML saver type: ${type}`);
  const writer = new XmlWriter(sink, context.newLine ?? '\r\n');
  try {
    await writer.begin();
    if (item.OfficialRating) await writer.element('ContentRating', item.OfficialRating);
    await writer.element('Added', localDate(item.DateCreated ?? '0001-01-01T00:00:00Z'));
    await writer.element('LockData', item.IsLocked === true ? 'true' : 'false');
    if (values(item.LockedFields).length) await writer.element('LockedFields', item.LockedFields.join('|'));
    if (item.CriticRating != null) await writer.element('CriticRating', item.CriticRating);
    if (item.Overview) await writer.element('Overview', item.Overview);
    if (item.OriginalTitle) await writer.element('OriginalTitle', item.OriginalTitle);
    if (item.CustomRating) await writer.element('CustomRating', item.CustomRating);
    if (item.Name) await writer.element('LocalTitle', item.Name);
    if (item.ForcedSortName) await writer.element('SortTitle', item.ForcedSortName);
    if (item.PremiereDate != null) await writer.element('PremiereDate', localDate(item.PremiereDate, true));
    if (item.EndDate != null) await writer.element('EndDate', invariantDate(item.EndDate));
    await writer.list('Trailers', 'Trailer', values(item.RemoteTrailers), trailer => trailer?.Url ?? trailer?.url ?? '');
    await writer.list('Countries', 'Country', values(item.ProductionLocations));
    if (item.DisplayOrder) await writer.element('DisplayOrder', item.DisplayOrder);
    if (item.CommunityRating != null) await writer.element('Rating', item.CommunityRating);
    if (item.ProductionYear != null) await writer.element('ProductionYear', item.ProductionYear);
    if (item.AspectRatio) await writer.element('AspectRatio', item.AspectRatio);
    if (item.PreferredMetadataLanguage) await writer.element('Language', item.PreferredMetadataLanguage);
    if (item.PreferredMetadataCountryCode) await writer.element('CountryCode', item.PreferredMetadataCountryCode);
    if (item.RunTimeTicks != null) await writer.element('RunningTime', BigInt(item.RunTimeTicks) / 600000000n);
    for (const [name, value] of item.ProviderIds instanceof Map ? item.ProviderIds.entries() : Object.entries(item.ProviderIds ?? {})) {
      if (value) await writer.element(name + 'Id', value);
    }
    if (typeof item.Tagline === 'string' && clrTrim(item.Tagline)) await writer.list('Taglines', 'Tagline', [item.Tagline]);
    await writer.list('Genres', 'Genre', values(item.Genres));
    await writer.list('Studios', 'Studio', values(item.Studios));
    await writer.list('Tags', 'Tag', values(item.Tags));
    const people = typeof context.getPeople === 'function' ? await context.getPeople(item) : context.people ?? [];
    if (people.length) {
      await writer.start('Persons');
      for (const person of people) {
        await writer.start('Person');
        await writer.element('Name', person?.Name, true); await writer.element('Type', person?.Type, true);
        await writer.element('Role', person?.Role, true);
        if (person?.SortOrder != null) await writer.element('SortOrder', person.SortOrder);
        await writer.end();
      }
      await writer.end();
    }
    if (type === 'BoxSet') await linkedNodes(item, context, writer, type);
    if (type === 'Playlist' && context.playlistFile !== true) {
      await writer.element('OwnerUserId', wireGuid(item.OwnerUserId ?? zeroGuid));
      await linkedNodes(item, context, writer, type);
    }
    if (type === 'Playlist') {
      await writer.start('Shares');
      for (const share of values(item.Shares)) {
        await writer.start('Share');
        await writer.element('UserId', nativeGuid(share.UserId).toLowerCase(), true);
        await writer.element('CanEdit', share.CanEdit === true ? 'true' : 'false', true); await writer.end();
      }
      await writer.end();
      const mediaType = Number.isInteger(item.PlaylistMediaType) ? mediaTypes[item.PlaylistMediaType] ?? String(item.PlaylistMediaType)
        : item.PlaylistMediaType == null ? 'Unknown' : String(item.PlaylistMediaType).split('.').at(-1);
      if (mediaType !== 'Unknown') await writer.element('PlaylistMediaType', mediaType);
    }
  } finally { await writer.finish(); }
}
