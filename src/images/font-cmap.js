// Unicode nominal glyph mapping, without shaping or variation-sequence lookup.
// Format: https://learn.microsoft.com/en-us/typography/opentype/spec/cmap
function range(bytes, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new TypeError('Invalid font character-map range.');
  }
}

function segmentMap(bytes) {
  range(bytes, 0, 16);
  const length = bytes.readUInt16BE(2), count = bytes.readUInt16BE(6) / 2;
  range(bytes, 0, length);
  if (!Number.isInteger(count) || !count || 16 + count * 8 > length) throw new TypeError('Invalid format 4 segments.');
  bytes = bytes.subarray(0, length);
  const starts = 16 + count * 2, deltas = 16 + count * 4, offsets = 16 + count * 6, glyphs = 16 + count * 8;
  const segments = [];
  for (let i = 0; i < count; i++) {
    const start = bytes.readUInt16BE(starts + i * 2), end = bytes.readUInt16BE(14 + i * 2);
    const delta = bytes.readInt16BE(deltas + i * 2), offset = bytes.readUInt16BE(offsets + i * 2);
    if (start > end || (i && start <= segments[i - 1].end)) throw new TypeError('Unordered format 4 segments.');
    const address = offsets + i * 2 + offset;
    if (offset) {
      if (offset % 2 || address < glyphs) throw new TypeError('Invalid format 4 glyph offset.');
      range(bytes, address, (end - start + 1) * 2);
    }
    segments.push({ start, end, delta, address: offset ? address : 0 });
  }
  if (segments.at(-1).start !== 0xffff || segments.at(-1).end !== 0xffff) throw new TypeError('Missing format 4 terminal segment.');
  return codepoint => {
    const segment = findSegment(segments, codepoint);
    if (!segment) return 0;
    if (!segment.address) return (codepoint + segment.delta) & 0xffff;
    const glyph = bytes.readUInt16BE(segment.address + (codepoint - segment.start) * 2);
    return glyph ? (glyph + segment.delta) & 0xffff : 0;
  };
}

function groupMap(bytes, format) {
  range(bytes, 0, 16);
  const length = bytes.readUInt32BE(4), count = bytes.readUInt32BE(12);
  range(bytes, 0, length);
  if (length < 16 + count * 12) throw new TypeError('Invalid character-map groups.');
  const groups = [];
  for (let i = 0; i < count; i++) {
    const offset = 16 + i * 12;
    const start = bytes.readUInt32BE(offset), end = bytes.readUInt32BE(offset + 4), glyph = bytes.readUInt32BE(offset + 8);
    if (start > end || end > 0x10ffff || (i && start <= groups[i - 1].end)
      || glyph + (format === 12 ? end - start : 0) > 0xffff) throw new TypeError('Invalid character-map group.');
    groups.push({ start, end, glyph });
  }
  return codepoint => {
    const group = findSegment(groups, codepoint);
    return group ? group.glyph + (format === 12 ? codepoint - group.start : 0) : 0;
  };
}

function findSegment(segments, codepoint) {
  let low = 0, high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle].end < codepoint) low = middle + 1;
    else high = middle;
  }
  const segment = segments[low];
  return segment && segment.start <= codepoint ? segment : null;
}

/** Read a standalone sfnt's Unicode cmap. Extract TTC faces before calling. */
export function readFontCmap(bytes) {
  range(bytes, 0, 12);
  if (![0x00010000, 0x4f54544f, 0x74727565, 0x74797031].includes(bytes.readUInt32BE(0))) throw new TypeError('Expected a standalone sfnt font.');
  const tableCount = bytes.readUInt16BE(4);
  range(bytes, 12, tableCount * 16);
  let cmap, glyphCount;
  for (let i = 0; i < tableCount; i++) {
    const record = 12 + i * 16, tag = bytes.toString('ascii', record, record + 4);
    if (tag !== 'cmap' && tag !== 'maxp') continue;
    const offset = bytes.readUInt32BE(record + 8), length = bytes.readUInt32BE(record + 12);
    range(bytes, offset, length);
    const table = bytes.subarray(offset, offset + length);
    if (tag === 'cmap') {
      if (cmap) throw new TypeError('Duplicate font character map.');
      cmap = table;
    } else {
      if (glyphCount !== undefined) throw new TypeError('Duplicate font glyph count.');
      range(table, 0, 6); glyphCount = table.readUInt16BE(4);
    }
  }
  if (!cmap || !glyphCount) throw new TypeError('The font requires cmap and maxp tables.');
  range(cmap, 0, 4);
  if (cmap.readUInt16BE(0) !== 0) throw new TypeError('Unsupported character-map version.');
  const count = cmap.readUInt16BE(2), candidates = [];
  range(cmap, 4, count * 8);
  for (let i = 0; i < count; i++) {
    const record = 4 + i * 8, platform = cmap.readUInt16BE(record), encoding = cmap.readUInt16BE(record + 2);
    if (!(platform === 0 && [0, 1, 2, 3, 4, 6].includes(encoding)) && !(platform === 3 && [1, 10].includes(encoding))) continue;
    const offset = cmap.readUInt32BE(record + 4); range(cmap, offset, 2);
    const format = cmap.readUInt16BE(offset);
    if (![4, 12, 13].includes(format)) continue;
    // A full-repertoire subtable takes precedence over a BMP subtable. Select
    // one mapping rather than merging them; prefer Windows for equal formats.
    const rank = (format === 12 ? 3 : format === 13 ? 2 : 1) * 2 + (platform === 3 ? 1 : 0);
    candidates.push({ offset, format, rank });
  }
  const selected = candidates.sort((left, right) => right.rank - left.rank)[0];
  if (!selected) throw new TypeError('No supported Unicode character map.');
  const subtable = cmap.subarray(selected.offset);
  const lookup = selected.format === 4 ? segmentMap(subtable) : groupMap(subtable, selected.format);
  const glyphForCodepoint = codepoint => {
    if (!Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) return 0;
    const glyph = lookup(codepoint);
    return glyph < glyphCount ? glyph : 0;
  };
  return {
    glyphForCodepoint,
    containsGlyphs(text) {
      if (typeof text !== 'string') throw new TypeError('Glyph coverage requires a string.');
      for (const scalar of text) if (!glyphForCodepoint(scalar.codePointAt(0))) return false;
      return true;
    }
  };
}
