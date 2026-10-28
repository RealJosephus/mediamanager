// LRC decoding follows LrcParser 2025.623.0, source commit
// ae8e5a182e7841a8150e852bb8cd6a9e01be3548, and Jellyfin's LrcLyricParser.
// Adapted portions: Copyright (c) karaoke.dev <contact@karaoke.dev>.
// MIT permission and warranty notice: ./LrcParser.LICENSE.
import { clrTrim, clrWhitespace } from '../metadata/whitespace.js';
import { nativeFileName } from '../library/native-path.js';

const blank = new RegExp(`^[${clrWhitespace}]*$`, 'u');
const white = new RegExp(`[${clrWhitespace}]`, 'u');
// CLR Regex classifies UTF-16 characters; astral Nd characters are not \d.
const lineTag = /\[((?:(?=[\u0000-\uffff])\p{Nd})+):((?:(?=[\u0000-\uffff])\p{Nd}){2})\.((?:(?=[\u0000-\uffff])\p{Nd}){2,3})\]/gu;
const wordTag = /<((?:(?=[\u0000-\uffff])\p{Nd})+):((?:(?=[\u0000-\uffff])\p{Nd}){2})\.((?:(?=[\u0000-\uffff])\p{Nd}){2,3})>/gu;
const ticks = milliseconds => BigInt(milliseconds) * 10000n;

function time(match) {
  const number = value => {
    // Regex \d accepts Unicode decimal digits; Int32.Parse does not.
    if (!/^[0-9]+$/u.test(value)) throw new Error('Invalid LRC time.');
    const result = Number(value);
    if (result > 2147483647) throw new Error('LRC time exceeds Int32.');
    return result;
  };
  const minutes = number(match[1]), seconds = number(match[2]), fraction = number(match[3]);
  // LrcParser's arithmetic is unchecked Int32, including overflow.
  return (Math.imul((Math.imul(minutes, 60) + seconds) | 0, 1000) + fraction * (match[3].length === 2 ? 10 : 1)) | 0;
}

function timedText(raw, start) {
  const matches = [...raw.matchAll(wordTag)];
  if (!matches.length || blank.test(raw)) return { text: raw, tags: [] };
  let text = '', lastTime = start, segmentStart = 0, insertSpace = false, lastWasStart = false;
  const entries = new Map(), add = (index, end, value) => {
    const key = index + ':' + Number(end);
    if (!entries.has(key)) entries.set(key, { index, end, time: value });
  };
  for (const match of matches) {
    const segment = raw.slice(segmentStart, match.index);
    segmentStart = match.index + match[0].length;
    if (blank.test(segment)) {
      if (lastWasStart) { add(text.length - 1, true, lastTime); lastWasStart = false; }
      lastTime = time(match);
      if (segment.length) insertSpace = true;
      continue;
    }
    if ((white.test(segment[0]) || insertSpace) && text.length) text += ' ';
    add(text.length, false, lastTime); lastWasStart = true;
    text += clrTrim(segment); lastTime = time(match);
    insertSpace = white.test(segment.at(-1));
  }
  const remaining = raw.slice(segmentStart);
  if (!blank.test(remaining)) {
    if ((white.test(remaining[0]) || insertSpace) && text.length) text += ' ';
    add(text.length, false, lastTime); text += clrTrim(remaining);
  } else add(text.length - 1, true, lastTime);
  return { text, tags: [...entries.values()].sort((a, b) => a.index - b.index || Number(a.end) - Number(b.end)) };
}

function lrc(content) {
  let lines;
  try {
    lines = content.split(/\r\n|\r|\n/u).filter(line => !blank.test(line)).flatMap(line => {
      const starts = [...line.matchAll(lineTag)].map(time), raw = clrTrim(line.replace(lineTag, ''));
      const value = starts.length === 1 ? timedText(raw, starts[0]) : { text: raw, tags: [] };
      return starts.map(start => ({ start, ...value }));
    }).sort((a, b) => a.start - b.start);
  } catch { return null; }
  if (!lines.length) return null;
  return { Metadata: {}, Lyrics: lines.map((line, index) => {
    const Cues = [];
    for (const [tagIndex, tag] of line.tags.entries()) {
      const next = line.tags[tagIndex + 1], Position = tag.index + Number(tag.end),
        EndPosition = next ? next.index + Number(next.end) : line.text.length;
      if (clrTrim(line.text.slice(Position, EndPosition)).length) Cues.push({ Position, EndPosition, Start: ticks(tag.time),
        End: next ? ticks(next.time) : index + 1 < lines.length ? ticks(lines[index + 1].start) : null });
    }
    return { Text: line.text, Start: ticks(line.start), Cues };
  }) };
}

/** Native always tries LRC before TXT. A recognized malformed/empty LRC still
 * produces a plain-text DTO; only unsupported extensions yield null. */
export function parseLyrics(filename, content) {
  // LyricFile.Name is a basename. A leading dot is an extension in Native,
  // including a file named .lrc; path.extname deliberately treats it otherwise.
  filename = nativeFileName(filename, { windows: process.platform === 'win32' });
  const dot = filename.lastIndexOf('.'), extension = dot < 0 || dot === filename.length - 1 ? '' : filename.slice(dot).toLowerCase();
  if (!['.lrc', '.elrc', '.txt'].includes(extension)) return null;
  if (extension !== '.txt') { const parsed = lrc(content); if (parsed !== null) return parsed; }
  return { Metadata: {}, Lyrics: content.split(/\r\n|\r|\n/u).map(line => ({ Text: clrTrim(line), Start: null, Cues: null })) };
}
