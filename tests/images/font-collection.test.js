import test from 'node:test';
import assert from 'node:assert/strict';
import { collageFontFiles, fontCollectionFaces } from '../../src/images/font-collection.js';

// An in-memory container with shared tables exercises TTC relocation without
// depending on, generating or distributing a font's glyph data.
function collection(version = 0x00010000) {
  const extraHeader = version === 0x00020000 ? 12 : 0;
  const bytes = Buffer.alloc(256 + extraHeader);
  bytes.write('ttcf'); bytes.writeUInt32BE(version, 4); bytes.writeUInt32BE(2, 8);
  bytes.writeUInt32BE(20 + extraHeader, 12); bytes.writeUInt32BE(96 + extraHeader, 16);
  bytes.writeUInt32BE(0xdeadbeef, 172 + extraHeader + 8);
  bytes.write('shared!', 228 + extraHeader); bytes.writeUInt32BE(30, 236 + extraHeader); bytes.writeUInt32BE(40, 244 + extraHeader);
  bytes.write('sign', 252 + extraHeader);
  for (const [index, directory] of [20 + extraHeader, 96 + extraHeader].entries()) {
    bytes.writeUInt32BE(0x00010000, directory); bytes.writeUInt16BE(4, directory + 4);
    const tables = [['head', 172, 54], ['hmtx', 236 + index * 8, 8], ['name', 228, 7], ['DSIG', 252, 4]];
    for (const [index, [tag, offset, length]] of tables.entries()) {
      const record = directory + 12 + index * 16;
      bytes.write(tag, record); bytes.writeUInt32BE(offset + extraHeader, record + 8); bytes.writeUInt32BE(length, record + 12);
    }
  }
  return bytes;
}

function directory(bytes) {
  return Array.from({ length: bytes.readUInt16BE(4) }, (_, index) => {
    const record = 12 + index * 16;
    return { tag: bytes.toString('ascii', record, record + 4), checksum: bytes.readUInt32BE(record + 4),
      offset: bytes.readUInt32BE(record + 8), length: bytes.readUInt32BE(record + 12) };
  });
}

test('TTC extraction preserves every face and shared table while rebuilding sfnt offsets and checksums', () => {
  const source = collection(), original = Buffer.from(source), faces = [...fontCollectionFaces(source)];
  assert.equal(faces.length, 2); assert.deepEqual(source, original);
  for (const [index, face] of faces.entries()) {
    const tables = directory(face);
    assert.deepEqual(tables.map(table => table.tag), ['head', 'hmtx', 'name']);
    let total = 0;
    for (let offset = 0; offset < face.length; offset += 4) total = (total + face.readUInt32BE(offset)) >>> 0;
    assert.equal(total, 0xb1b0afba);
    assert.equal(face.readUInt16BE(6), 32); assert.equal(face.readUInt16BE(8), 1); assert.equal(face.readUInt16BE(10), 16);
    for (const table of tables) {
      assert.equal(table.offset % 4, 0);
      assert.ok(table.offset >= 60 && table.offset + table.length <= face.length);
      const contents = Buffer.from(face.subarray(table.offset, table.offset + table.length));
      if (table.tag === 'head') {
        contents.writeUInt32BE(0xdeadbeef, 8); assert.deepEqual(contents, source.subarray(172, 226));
      } else if (table.tag === 'hmtx') assert.deepEqual(contents, source.subarray(236 + index * 8, 244 + index * 8));
      else assert.equal(contents.toString(), 'shared!');
    }
  }
  assert.deepEqual([...fontCollectionFaces(collection(0x00020000))], faces, 'TTC v2 has an additional DSIG header before its face directories.');
});

test('TTC extraction rejects truncated headers, duplicate tables and escaping table ranges', () => {
  const invalid = mutate => { const bytes = collection(); mutate(bytes); return bytes; };
  for (const bytes of [Buffer.alloc(11), invalid(bytes => bytes.write('OTTO')),
    invalid(bytes => bytes.writeUInt32BE(0x00030000, 4)), invalid(bytes => bytes.writeUInt32BE(0, 8)),
    invalid(bytes => bytes.writeUInt32BE(100, 8)), invalid(bytes => bytes.writeUInt32BE(250, 12)),
    invalid(bytes => bytes.writeUInt32BE(250, 20 + 12 + 8)),
    invalid(bytes => bytes.write('head', 20 + 12 + 16)), invalid(bytes => bytes.writeUInt32BE(8, 20 + 12 + 12))]) {
    assert.throws(() => [...fontCollectionFaces(bytes)], TypeError);
  }
});

test('collage completes only the selected macOS system default collection', () => {
  assert.deepEqual(collageFontFiles('darwin'), ['/System/Library/Fonts/Helvetica.ttc']);
  assert.deepEqual(collageFontFiles('win32'), []); assert.deepEqual(collageFontFiles('linux'), []);
});
