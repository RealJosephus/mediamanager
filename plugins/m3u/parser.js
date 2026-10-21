import path from 'node:path';
import { md5Guid, lowerInvariant } from '@mediamanager/plugin-sdk/core/identity';
import { clrTrim } from '@mediamanager/plugin-sdk/metadata/whitespace';

// Behavioral port of the designated Jellyfin M3uParser.cs (GPL-2.0-only).

const blank = value => value == null || clrTrim(value) === '';
const floating = value => typeof value === 'string' && /^(?:[+-]?(?:NaN|Infinity)|[+-]?(?:(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?))[\0]*$/iu
  .test(value.replace(/^[\t-\r ]+|[\t-\r ]+$/gu, ''));
const validNumber = value => !blank(value) && value !== '-1' && value !== '0' && floating(value);
const parts = value => value.split(',').filter(value => value !== '');
const stripNumber = value => value.replace(/^[ .]+|[ .]+$/gu, '');

function attributes(text) {
  const values = new Map(); let remaining = text;
  for (const match of text.matchAll(/([a-z0-9\-_]+)="([^"]+)"/giu)) {
    const [, key, value] = match; values.set(lowerInvariant(key), value);
    const remove = lowerInvariant(key + '="' + value + '"'); let offset;
    while ((offset = lowerInvariant(remaining).indexOf(remove)) !== -1) remaining = remaining.slice(0, offset) + remaining.slice(offset + remove.length);
  }
  return { values, remaining };
}

function nameAndNumber(text, values, url) {
  const entries = parts(text), title = entries.length > 1 ? clrTrim(entries.at(-1)) : null;
  let name = title;
  if (!blank(name)) {
    const split = name.indexOf(' ');
    if (split > 0 && floating(stripNumber(name.slice(0, split)))) name = name.slice(split + 1).replace(/^[ -]+|[ -]+$/gu, '');
  }
  if (blank(name)) name = values.get('tvg-name');
  if (blank(name)) name = values.get('tvg-id');
  if (blank(name)) name = null;
  let number = floating(values.get('tvg-chno')) ? values.get('tvg-chno') : null;
  if (!validNumber(number)) {
    if (values.has('tvg-id')) {
      if (floating(values.get('tvg-id'))) number = values.get('tvg-id');
      else if (floating(values.get('channel-id'))) number = values.get('channel-id');
    }
    if (blank(number) && !blank(title)) {
      const split = title.indexOf(' ');
      if (split > 0 && floating(stripNumber(title.slice(0, split)))) number = stripNumber(title.slice(0, split));
    }
  }
  if (!validNumber(number)) number = null;
  if (!blank(number)) number = clrTrim(number);
  else {
    const tail = url.slice(url.lastIndexOf('/') + 1);
    // Native uses the literal URL tail, including its query, as a file name.
    number = path.parse(tail).name;
    if (!validNumber(number)) number = null;
  }
  return { Name: name, Number: number };
}

export function parseM3uText(text, { channelIdPrefix, tunerHostId }) {
  const channels = []; let extInf = '';
  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const line = clrTrim(raw);
    if (blank(line) || /^#EXTM3U/iu.test(line)) continue;
    if (/^#EXTINF:/iu.test(line)) { extInf = clrTrim(line.slice(8)); continue; }
    if (blank(extInf) || line.startsWith('#')) continue;
    let valid = false;
    try { valid = ['http:', 'https:', 'rtsp:', 'rtp:', 'udp:'].includes(new URL(line).protocol.toLowerCase()); } catch { /* Invalid channel URLs consume the pending EXTINF. */ }
    if (valid) {
      const { values, remaining } = attributes(clrTrim(extInf));
      const tvg = values.get('tvg-id'), channelId = values.get('channel-id');
      channels.push({ ...nameAndNumber(remaining, values, line), Id: channelIdPrefix + md5Guid(line), Path: line,
        TunerChannelId: blank(tvg) ? channelId ?? null : tvg, CallSign: null, TunerHostId: tunerHostId,
        ChannelType: 'TV', ChannelGroup: values.get('group-title') ?? null, ImagePath: null,
        ImageUrl: values.get('tvg-logo') ?? values.get('logo') ?? null, HasImage: null, IsFavorite: null,
        IsHD: null, AudioCodec: null, VideoCodec: null, Tags: null });
    }
    extInf = '';
  }
  return channels;
}

export async function decodeM3u(bytes, { signal } = {}) {
  const chunks = []; for await (const chunk of bytes) { signal?.throwIfAborted(); chunks.push(Buffer.from(chunk)); }
  const data = Buffer.concat(chunks); let encoding = 'utf-8', offset = 0;
  if (data.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0]))) { encoding = 'utf-32le'; offset = 4; }
  else if (data.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff]))) { encoding = 'utf-32be'; offset = 4; }
  else if (data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) offset = 3;
  else if (data.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) { encoding = 'utf-16le'; offset = 2; }
  else if (data.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) { encoding = 'utf-16be'; offset = 2; }
  if (!encoding.startsWith('utf-32')) return new TextDecoder(encoding, { ignoreBOM: true }).decode(data.subarray(offset));
  const output = []; for (; offset + 4 <= data.length; offset += 4) {
    const point = encoding === 'utf-32le' ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
    output.push(point > 0x10ffff || point >= 0xd800 && point <= 0xdfff ? '\ufffd' : String.fromCodePoint(point));
  }
  if (offset < data.length) output.push('\ufffd');
  return output.join('');
}
