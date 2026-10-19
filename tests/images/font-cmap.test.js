import test from 'node:test';
import assert from 'node:assert/strict';
import { readFontCmap } from '../../src/images/font-cmap.js';

// Minimal in-memory sfnt tables contain mapping numbers, not font assets.
function font(records, glyphCount = 1000) {
  const cmap = Buffer.alloc(4 + records.length * 8 + records.reduce((sum, record) => sum + record.table.length, 0));
  cmap.writeUInt16BE(records.length, 2);
  let offset = 4 + records.length * 8;
  for (const [index, record] of records.entries()) {
    const position = 4 + index * 8;
    cmap.writeUInt16BE(record.platform ?? 3, position); cmap.writeUInt16BE(record.encoding ?? 1, position + 2);
    cmap.writeUInt32BE(offset, position + 4); record.table.copy(cmap, offset); offset += record.table.length;
  }
  const bytes = Buffer.alloc(76 + cmap.length);
  bytes.writeUInt32BE(0x00010000); bytes.writeUInt16BE(2, 4);
  bytes.writeUInt16BE(32, 6); bytes.writeUInt16BE(1, 8);
  bytes.write('cmap', 12); bytes.writeUInt32BE(76, 20); bytes.writeUInt32BE(cmap.length, 24);
  bytes.write('maxp', 28); bytes.writeUInt32BE(44, 36); bytes.writeUInt32BE(32, 40);
  bytes.writeUInt32BE(0x00010000, 44); bytes.writeUInt16BE(glyphCount, 48); bytes.writeUInt16BE(2, 58); cmap.copy(bytes, 76);
  return bytes;
}

function format4() {
  // A..C use signed delta; Hebrew alef..gimel use an offset array with a
  // missing middle glyph; the required final segment maps U+FFFF to zero.
  const bytes = Buffer.alloc(46);
  bytes.writeUInt16BE(4); bytes.writeUInt16BE(bytes.length, 2); bytes.writeUInt16BE(6, 6);
  bytes.writeUInt16BE(4, 8); bytes.writeUInt16BE(1, 10); bytes.writeUInt16BE(2, 12);
  for (const [index, [start, end, delta, offset]] of [[65, 67, -55, 0], [0x5d0, 0x5d2, 3, 4], [0xffff, 0xffff, 1, 0]].entries()) {
    bytes.writeUInt16BE(end, 14 + index * 2); bytes.writeUInt16BE(start, 22 + index * 2);
    bytes.writeInt16BE(delta, 28 + index * 2); bytes.writeUInt16BE(offset, 34 + index * 2);
  }
  bytes.writeUInt16BE(20, 40); bytes.writeUInt16BE(0, 42); bytes.writeUInt16BE(30, 44);
  return bytes;
}

function grouped(format, groups) {
  const bytes = Buffer.alloc(16 + groups.length * 12);
  bytes.writeUInt16BE(format); bytes.writeUInt32BE(bytes.length, 4); bytes.writeUInt32BE(groups.length, 12);
  for (const [index, group] of groups.entries()) for (const [field, value] of group.entries()) bytes.writeUInt32BE(value, 16 + index * 12 + field * 4);
  return bytes;
}

test('Unicode BMP coverage follows signed deltas, relative glyph arrays and missing glyph zero', () => {
  const source = font([{ table: format4() }]), original = Buffer.from(source), cmap = readFontCmap(source);
  assert.deepEqual([64, 65, 66, 67, 68, 0x5d0, 0x5d1, 0x5d2, 0xffff].map(cmap.glyphForCodepoint), [0, 10, 11, 12, 0, 23, 0, 33, 0]);
  assert.equal(cmap.containsGlyphs('ABCאג'), true); assert.equal(cmap.containsGlyphs('אב'), false);
  assert.equal(cmap.containsGlyphs(''), true); assert.equal(cmap.containsGlyphs('😀'), false);
  assert.equal(readFontCmap(font([{ table: format4() }], 23)).containsGlyphs('א'), false, 'An index beyond maxp is not a present glyph.');
  assert.deepEqual(source, original);
});

test('full Unicode mapping selects one subtable and keeps supplementary-plane scalars intact', () => {
  const cmap = readFontCmap(font([{ table: format4() },
    { encoding: 10, table: grouped(12, [[65, 65, 80], [0x200d, 0x200d, 81], [0x1f600, 0x1f602, 90]]) }]));
  assert.equal(cmap.glyphForCodepoint(65), 80); assert.equal(cmap.glyphForCodepoint(66), 0, 'Do not merge an unselected BMP mapping.');
  assert.deepEqual([0x1f5ff, 0x1f600, 0x1f601, 0x1f602, 0x1f603].map(cmap.glyphForCodepoint), [0, 90, 91, 92, 0]);
  assert.equal(cmap.containsGlyphs('A😀‍😂'), true);
  assert.equal(cmap.containsGlyphs('😀️'), false, 'A variation selector needs its own nominal glyph for ContainsGlyphs.');
  for (const codepoint of [-1, 0x110000, 0xd800, 0xdfff, NaN, 65.5, '65']) assert.equal(cmap.glyphForCodepoint(codepoint), 0);
  assert.equal(cmap.containsGlyphs('\ud800'), false); assert.throws(() => cmap.containsGlyphs(null), TypeError);
});

test('Unicode last-resort ranges use constant glyphs and ignore variation and symbol encodings', () => {
  const variation = Buffer.alloc(10); variation.writeUInt16BE(14); variation.writeUInt32BE(10, 2);
  const cmap = readFontCmap(font([{ platform: 0, encoding: 5, table: variation },
    { platform: 0, encoding: 6, table: grouped(13, [[0x4e00, 0x9fff, 50], [0x1f600, 0x1f64f, 60]]) },
    { platform: 3, encoding: 0, table: format4() }]));
  assert.equal(cmap.glyphForCodepoint(0x4e00), 50); assert.equal(cmap.glyphForCodepoint(0x9fff), 50);
  assert.equal(cmap.glyphForCodepoint(0x1f64f), 60); assert.equal(cmap.glyphForCodepoint(65), 0);
  assert.equal(cmap.containsGlyphs('电影😀'), true); assert.equal(cmap.containsGlyphs('😀️'), false);
  assert.throws(() => readFontCmap(font([{ platform: 0, encoding: 5, table: variation }])), /No supported Unicode/);
});

test('equal Unicode formats select the Windows mapping consistently', () => {
  const unicode = { platform: 0, encoding: 4, table: grouped(12, [[65, 65, 10]]) };
  const windows = { platform: 3, encoding: 10, table: grouped(12, [[65, 65, 20]]) };
  assert.equal(readFontCmap(font([unicode, windows])).glyphForCodepoint(65), 20);
  assert.equal(readFontCmap(font([windows, unicode])).glyphForCodepoint(65), 20);
});

test('malformed sfnt and cmap ranges fail before coverage is reported', () => {
  const changed = (table, modify) => { const bytes = Buffer.from(table); modify(bytes); return bytes; };
  const invalidTables = [format4().subarray(0, 10),
    changed(format4(), bytes => bytes.writeUInt16BE(5, 6)),
    changed(format4(), bytes => bytes.writeUInt16BE(40, 36)),
    changed(format4(), bytes => bytes.writeUInt16BE(64, 24)),
    changed(format4(), bytes => bytes.writeUInt16BE(0xfffe, 26)),
    grouped(12, [[80, 65, 1]]), grouped(12, [[65, 70, 1], [70, 80, 20]]),
    grouped(12, [[0x110000, 0x110000, 1]]), grouped(12, [[65, 67, 0xffff]]),
    changed(grouped(12, [[65, 65, 1]]), bytes => bytes.writeUInt32BE(2, 12))];
  for (const table of invalidTables) assert.throws(() => readFontCmap(font([{ table }])), TypeError);
  const source = font([{ table: format4() }]);
  for (const bytes of [Buffer.alloc(11), changed(source, bytes => bytes.write('ttcf')),
    changed(source, bytes => bytes.writeUInt32BE(bytes.length - 1, 20)),
    changed(source, bytes => bytes.writeUInt16BE(1, 76)),
    changed(source, bytes => bytes.writeUInt32BE(0xffffffff, 84))]) assert.throws(() => readFontCmap(bytes), TypeError);
});
