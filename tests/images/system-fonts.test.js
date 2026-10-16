import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSystemFontDirectory, systemFontDirectories, systemFontPostscriptNames } from '../../src/images/system-fonts/sfnt.js';

function nameTable(name) {
  const text = Buffer.from(name, 'utf16le'); text.swap16();
  const bytes = Buffer.alloc(18 + text.length);
  bytes.writeUInt16BE(1, 2); bytes.writeUInt16BE(18, 4);
  bytes.writeUInt16BE(3, 6); bytes.writeUInt16BE(1, 8); bytes.writeUInt16BE(0x409, 10);
  bytes.writeUInt16BE(6, 12); bytes.writeUInt16BE(text.length, 14); text.copy(bytes, 18);
  return bytes;
}
function container(names) {
  const tables = names.map(nameTable), directories = 12 + names.length * 4, data = directories + names.length * 28;
  const bytes = Buffer.alloc(data + tables.reduce((sum, value) => sum + value.length, 0));
  bytes.write('ttcf'); bytes.writeUInt32BE(0x10000, 4); bytes.writeUInt32BE(names.length, 8);
  let offset = data;
  tables.forEach((table, i) => {
    const start = directories + i * 28; bytes.writeUInt32BE(start, 12 + i * 4);
    bytes.writeUInt32BE(0x10000, start); bytes.writeUInt16BE(1, start + 4); bytes.write('name', start + 12);
    bytes.writeUInt32BE(offset, start + 20); bytes.writeUInt32BE(table.length, start + 24);
    table.copy(bytes, offset); offset += table.length;
  });
  return bytes;
}

test('system face selection uses actual PostScript identity and file-relative TTC directories', () => {
  const bytes = container(['Family-Regular', 'Family-Bold']), original = Buffer.from(bytes);
  const selected = selectSystemFontDirectory(bytes, { collectionIndex: null, postscriptName: 'Family-Bold' });
  assert.equal(selected.collectionIndex, 1); assert.deepEqual(selected.postscriptNames, ['Family-Bold']);
  assert.deepEqual(systemFontPostscriptNames(systemFontDirectories(bytes)[0]), ['Family-Regular']);
  assert.deepEqual(bytes, original);
  assert.equal(selectSystemFontDirectory(bytes, { collectionIndex: 1 }).collectionIndex, 1);
});

test('system face selection rejects missing, ambiguous or conflicting identities', () => {
  const bytes = container(['Family-Regular', 'Family-Bold']);
  assert.throws(() => selectSystemFontDirectory(bytes, { collectionIndex: null, postscriptName: 'Absent' }), /not uniquely present/);
  assert.throws(() => selectSystemFontDirectory(container(['Duplicate', 'Duplicate']), { collectionIndex: null, postscriptName: 'Duplicate' }), /not uniquely present/);
  assert.throws(() => selectSystemFontDirectory(bytes, { collectionIndex: 0, postscriptName: 'Family-Bold' }), /identity changed/);
  assert.throws(() => selectSystemFontDirectory(bytes, { collectionIndex: 2 }), /out of range/);
  assert.throws(() => selectSystemFontDirectory(bytes, { collectionIndex: null }), /PostScript name/);
});

test('system font metadata cannot traverse a truncated directory or table', () => {
  const bytes = container(['Family']);
  assert.throws(() => systemFontDirectories(bytes.subarray(0, 15)), TypeError);
  const truncated = Buffer.from(bytes); truncated.writeUInt32BE(truncated.length, 16 + 20);
  assert.throws(() => systemFontDirectories(truncated), TypeError);
  const malformedName = new Map([['name', Buffer.alloc(5)]]);
  assert.throws(() => systemFontPostscriptNames(malformedName), TypeError);
});
