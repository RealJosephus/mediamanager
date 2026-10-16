// Font metadata follows the OpenType name, OS/2 and head table specifications:
// https://learn.microsoft.com/en-us/typography/opentype/spec/name
// https://learn.microsoft.com/en-us/typography/opentype/spec/os2
// https://learn.microsoft.com/en-us/typography/opentype/spec/head
import { readFontCmap } from './font-cmap.js';

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const unicodeName = new TextDecoder('utf-16be', { fatal: true });

function range(bytes, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new TypeError('Invalid collage font table range.');
  }
}

/** Read identity and nominal coverage from an actual standalone font face. */
export function readCollageFontFace(bytes) {
  const coverage = readFontCmap(bytes), tables = new Map();
  for (let index = 0; index < bytes.readUInt16BE(4); index++) {
    const record = 12 + index * 16, tag = bytes.toString('ascii', record, record + 4);
    if (!['name', 'OS/2', 'head'].includes(tag)) continue;
    const offset = bytes.readUInt32BE(record + 8), length = bytes.readUInt32BE(record + 12);
    range(bytes, offset, length);
    if (tables.has(tag)) throw new TypeError('Duplicate collage font identity table.');
    tables.set(tag, bytes.subarray(offset, offset + length));
  }
  const names = tables.get('name');
  if (!names) throw new TypeError('The collage font requires a name table.');
  range(names, 0, 6);
  if (![0, 1].includes(names.readUInt16BE(0))) throw new TypeError('Unsupported font name table version.');
  const count = names.readUInt16BE(2), storage = names.readUInt16BE(4), families = new Set();
  range(names, 6, count * 12); range(names, storage, 0);
  for (let index = 0; index < count; index++) {
    const record = 6 + index * 12, platform = names.readUInt16BE(record), encoding = names.readUInt16BE(record + 2);
    const identifier = names.readUInt16BE(record + 6), length = names.readUInt16BE(record + 8), offset = storage + names.readUInt16BE(record + 10);
    // Include localized family names as aliases, not just the filename or one
    // language's display name. The caller still has to resolve a system face;
    // this does not infer the operating system's MatchCharacter preference.
    if (![1, 16, 21].includes(identifier)) continue;
    range(names, offset, length);
    const value = names.subarray(offset, offset + length);
    if (platform === 0 || platform === 3 && [0, 1, 10].includes(encoding)) {
      if (length % 2) throw new TypeError('Invalid Unicode font family name.');
      families.add(unicodeName.decode(value));
    } else if (platform === 1 && encoding === 0 && value.every(byte => byte < 128)) {
      // Older Mac fonts also publish ASCII family names in Roman records.
      families.add(value.toString('ascii'));
    }
  }
  families.delete('');
  if (!families.size) throw new TypeError('The collage font has no supported family name.');
  const metrics = tables.get('OS/2'), head = tables.get('head');
  let weight, width, slant;
  if (metrics) {
    range(metrics, 0, 64);
    weight = metrics.readUInt16BE(4); width = metrics.readUInt16BE(6);
    const selection = metrics.readUInt16BE(62);
    slant = selection & 1 ? 1 : selection & 0x200 ? 2 : 0;
    if (weight < 1 || weight > 1000 || width < 1 || width > 9) throw new TypeError('Invalid collage font weight or width.');
  } else {
    if (!head) throw new TypeError('The collage font requires style metadata.');
    range(head, 0, 46);
    const style = head.readUInt16BE(44);
    weight = style & 1 ? 700 : 400; width = style & 0x20 ? 3 : style & 0x40 ? 7 : 5; slant = style & 2 ? 1 : 0;
  }
  return { families: [...families], weight, width, slant, ...coverage };
}

/** Use SkiaEncoder.InitializeTypefaces' probes with an actual system resolver. */
export function collageFallbackFaces(matchCharacter, defaultFace) {
  const faces = [];
  for (const codepoint of [0x9e21, 0x96de, 0x30ce, 0xac01, 0x1f4a9, 0x5d6, 0x64a]) {
    const face = matchCharacter(codepoint, { weight: 700, width: 5, slant: 0 });
    if (face !== null) faces.push(face);
  }
  faces.push(defaultFace);
  return faces;
}

/**
 * Split title draws using StripCollageBuilder.DrawText's grapheme recursion
 * (Jellyfin.Drawing.Skia, GPL-2.0-or-later). Faces must carry actual coverage;
 * fallbackFaces must already be in the system-selected native probe order.
 */
export function collageTextRuns(text, face, fallbackFaces) {
  if (face.containsGlyphs(text)) return [{ text, face }];
  const elements = [...graphemes.segment(text)], runs = [];
  let start = 0;
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    if (face.containsGlyphs(element.segment)) continue;
    if (start !== element.index) runs.push({ text: text.slice(start, element.index), face });
    start = element.index;
    while (++index < elements.length && !face.containsGlyphs(elements[index].segment)) { /* Find the next present grapheme. */ }
    const end = index < elements.length ? elements[index].index : text.length;
    const fallback = fallbackFaces.find(candidate => candidate !== null && candidate.containsGlyphs(element.segment));
    if (fallback) runs.push(...collageTextRuns(text.slice(start, end), fallback, fallbackFaces));
    else {
      // Native draws the whole remaining suffix here, not just the missing
      // span. Its later present span is still drawn, including any repetition.
      runs.push({ text: text.slice(start), face });
    }
    start = end;
  }
  if (start < text.length) runs.push({ text: text.slice(start), face });
  return runs;
}
