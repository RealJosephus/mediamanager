// OpenType collections use absolute table offsets shared by several faces.
// Extract a standalone sfnt for the canvas API, which accepts only face zero.
// Format: https://learn.microsoft.com/en-us/typography/opentype/spec/otff
const aligned = value => Math.ceil(value / 4) * 4;
const headTag = 0x68656164, signatureTag = 0x44534947;

export function collageFontFiles(platform = process.platform) {
  // CoreText's generic sans-serif is Helvetica, but canvas registers only the
  // first (regular) member of this system collection. Keep the read limited to
  // the selected default family, rather than loading unrelated collections.
  return platform === 'darwin' ? ['/System/Library/Fonts/Helvetica.ttc'] : [];
}

function range(bytes, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new TypeError('Invalid font collection table range.');
  }
}

function checksum(bytes, offset, length) {
  let result = 0;
  for (let i = 0; i < aligned(length); i += 4) result = (result + bytes.readUInt32BE(offset + i)) >>> 0;
  return result;
}

export function* fontCollectionFaces(bytes) {
  range(bytes, 0, 12);
  if (bytes.toString('ascii', 0, 4) !== 'ttcf' || ![0x00010000, 0x00020000].includes(bytes.readUInt32BE(4))) {
    throw new TypeError('Expected an OpenType font collection.');
  }
  const count = bytes.readUInt32BE(8);
  if (!count) throw new TypeError('The font collection has no faces.');
  range(bytes, 12, count * 4 + (bytes.readUInt32BE(4) === 0x00020000 ? 12 : 0));
  for (let index = 0; index < count; index++) {
    const start = bytes.readUInt32BE(12 + index * 4); range(bytes, start, 12);
    const version = bytes.readUInt32BE(start), tableCount = bytes.readUInt16BE(start + 4);
    if (![0x00010000, 0x4f54544f, 0x74727565, 0x74797031].includes(version) || !tableCount) {
      throw new TypeError('Invalid font collection face directory.');
    }
    range(bytes, start + 12, tableCount * 16);
    const tables = [], tags = new Set();
    for (let table = 0; table < tableCount; table++) {
      const record = start + 12 + table * 16, tag = bytes.readUInt32BE(record);
      const offset = bytes.readUInt32BE(record + 8), length = bytes.readUInt32BE(record + 12);
      range(bytes, offset, length);
      if (tags.has(tag)) throw new TypeError('Duplicate font collection table.');
      tags.add(tag);
      // A collection signature no longer applies to the extracted sfnt.
      if (tag !== signatureTag) tables.push({ tag, offset, length });
    }
    tables.sort((left, right) => left.tag - right.tag);
    if (!tables.length || tables.length >= 4096) throw new TypeError('Invalid standalone font table count.');
    const output = Buffer.alloc(12 + tables.length * 16 + tables.reduce((sum, table) => sum + aligned(table.length), 0));
    output.writeUInt32BE(version, 0); output.writeUInt16BE(tables.length, 4);
    const selector = Math.floor(Math.log2(tables.length)), searchRange = 2 ** selector * 16;
    output.writeUInt16BE(searchRange, 6); output.writeUInt16BE(selector, 8);
    output.writeUInt16BE(tables.length * 16 - searchRange, 10);
    let cursor = 12 + tables.length * 16, head;
    for (let table = 0; table < tables.length; table++) {
      const { tag, offset, length } = tables[table], record = 12 + table * 16;
      bytes.copy(output, cursor, offset, offset + length);
      if (tag === headTag) {
        if (length < 12) throw new TypeError('Invalid font head table.');
        head = cursor; output.writeUInt32BE(0, head + 8);
      }
      output.writeUInt32BE(tag, record); output.writeUInt32BE(checksum(output, cursor, length), record + 4);
      output.writeUInt32BE(cursor, record + 8); output.writeUInt32BE(length, record + 12);
      cursor += aligned(length);
    }
    if (head !== undefined) output.writeUInt32BE((0xb1b0afba - checksum(output, 0, output.length)) >>> 0, head + 8);
    yield output;
  }
}
