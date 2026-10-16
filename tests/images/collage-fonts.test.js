import test from 'node:test';
import assert from 'node:assert/strict';
import { collageFallbackFaces, collageTextRuns, readCollageFontFace } from '../../src/images/collage-fonts.js';

// Synthetic metadata and cmap numbers contain no glyph outlines or font assets.
function font({ weight = 700, width = 5, selection = 0, headStyle = 0, os2 = true } = {}) {
  const strings = [[3, 1, 1, 'Example UI'], [0, 4, 16, 'Example'], [3, 1, 21, '示例'], [1, 0, 1, 'Example Mac']];
  const encoded = strings.map(([platform, , , text]) => platform === 1 ? Buffer.from(text) : Buffer.from(text, 'utf16le').swap16());
  const name = Buffer.alloc(6 + strings.length * 12 + encoded.reduce((sum, bytes) => sum + bytes.length, 0));
  name.writeUInt16BE(strings.length, 2); name.writeUInt16BE(6 + strings.length * 12, 4);
  let cursor = 0;
  for (const [index, [platform, encoding, identifier]] of strings.entries()) {
    const record = 6 + index * 12;
    name.writeUInt16BE(platform, record); name.writeUInt16BE(encoding, record + 2); name.writeUInt16BE(identifier, record + 6);
    name.writeUInt16BE(encoded[index].length, record + 8); name.writeUInt16BE(cursor, record + 10);
    encoded[index].copy(name, 6 + strings.length * 12 + cursor); cursor += encoded[index].length;
  }
  const head = Buffer.alloc(54); head.writeUInt16BE(headStyle, 44);
  const metrics = Buffer.alloc(78); metrics.writeUInt16BE(weight, 4); metrics.writeUInt16BE(width, 6); metrics.writeUInt16BE(selection, 62);
  const maxp = Buffer.alloc(32); maxp.writeUInt32BE(0x10000); maxp.writeUInt16BE(10, 4);
  const cmap = Buffer.alloc(40); cmap.writeUInt16BE(1, 2); cmap.writeUInt16BE(3, 4); cmap.writeUInt16BE(10, 6); cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(12, 12); cmap.writeUInt32BE(28, 16); cmap.writeUInt32BE(1, 24);
  cmap.writeUInt32BE(65, 28); cmap.writeUInt32BE(67, 32); cmap.writeUInt32BE(1, 36);
  const tables = [['cmap', cmap], ['head', head], ['maxp', maxp], ['name', name], ...(os2 ? [['OS/2', metrics]] : [])];
  const bytes = Buffer.alloc(12 + tables.length * 16 + tables.reduce((sum, [, table]) => sum + Math.ceil(table.length / 4) * 4, 0));
  bytes.writeUInt32BE(0x10000); bytes.writeUInt16BE(tables.length, 4);
  const selector = Math.floor(Math.log2(tables.length)); bytes.writeUInt16BE(16 * 2 ** selector, 6); bytes.writeUInt16BE(selector, 8);
  bytes.writeUInt16BE(tables.length * 16 - 16 * 2 ** selector, 10);
  cursor = 12 + tables.length * 16;
  for (const [index, [tag, table]] of tables.entries()) {
    const record = 12 + index * 16; bytes.write(tag, record); bytes.writeUInt32BE(cursor, record + 8); bytes.writeUInt32BE(table.length, record + 12);
    table.copy(bytes, cursor); cursor += Math.ceil(table.length / 4) * 4;
  }
  return bytes;
}

test('collage font identity and coverage come from face tables rather than filenames', () => {
  const bytes = font(), original = Buffer.from(bytes), face = readCollageFontFace(bytes);
  assert.deepEqual(face.families, ['Example UI', 'Example', '示例', 'Example Mac']);
  assert.equal(face.weight, 700); assert.equal(face.width, 5); assert.equal(face.slant, 0);
  assert.equal(face.containsGlyphs('ABC'), true); assert.equal(face.containsGlyphs('ABD'), false);
  assert.equal(face.glyphForCodepoint(66), 2); assert.deepEqual(bytes, original);
  assert.equal(readCollageFontFace(font({ selection: 1 })).slant, 1);
  assert.equal(readCollageFontFace(font({ selection: 0x200 })).slant, 2);
  const old = readCollageFontFace(font({ os2: false, headStyle: 3 }));
  assert.equal(old.weight, 700); assert.equal(old.slant, 1); assert.equal(old.width, 5);
  assert.throws(() => readCollageFontFace(font({ weight: 0 })), /weight or width/);
});

function face(name, characters) {
  const supported = new Set(characters);
  return { name, containsGlyphs: text => [...text].every(character => supported.has(character)) };
}
const projection = runs => runs.map(run => [run.text, run.face.name]);

test('fallback initialization queries the native probes and retains the system result order and duplicates', () => {
  const queried = [], chinese = face('chinese', '鸡雞'), latin = face('latin', 'ABC');
  const faces = collageFallbackFaces((codepoint, style) => {
    queried.push(codepoint); assert.deepEqual(style, { weight: 700, width: 5, slant: 0 });
    return chinese.containsGlyphs(String.fromCodePoint(codepoint)) ? chinese : null;
  }, latin);
  assert.deepEqual(queried.map(codepoint => String.fromCodePoint(codepoint)), ['鸡', '雞', 'ノ', '각', '💩', 'ז', 'ي']);
  assert.deepEqual(faces, [chinese, chinese, latin]);
});

test('a present title remains one shaped draw and missing spans recurse in the supplied face order', () => {
  const latin = face('latin', 'ABC '), chinese = face('chinese', '鸡雞'), japanese = face('japanese', 'ノ');
  assert.deepEqual(projection(collageTextRuns('ABC', latin, [])), [['ABC', 'latin']]);
  assert.deepEqual(projection(collageTextRuns('A鸡ノ雞 B', latin, [chinese, japanese, latin])),
    [['A', 'latin'], ['鸡', 'chinese'], ['ノ', 'japanese'], ['雞', 'chinese'], [' B', 'latin']]);
  const alternative = face('alternative', '鸡雞ノ');
  assert.deepEqual(projection(collageTextRuns('鸡', latin, [alternative, chinese])), [['鸡', 'alternative']]);
});

test('fallback requires coverage of the complete grapheme including combining marks and emoji selectors', () => {
  const latin = face('latin', 'AB '), partial = face('partial', 'e🚵🏻‍♀'), complete = face('complete', 'é🚵🏻‍♀️');
  assert.deepEqual(projection(collageTextRuns('Aé🚵🏻‍♀️B', latin, [partial, complete])),
    [['A', 'latin'], ['é🚵🏻‍♀️', 'complete'], ['B', 'latin']]);
  assert.deepEqual(projection(collageTextRuns('🚵🏻‍♀️ B', latin, [partial])),
    [['🚵🏻‍♀️ B', 'latin'], [' B', 'latin']]);
});

test('exhausted fallback retains native suffix repetition and separates later missing spans', () => {
  const latin = face('latin', 'AB '), chinese = face('chinese', '鸡');
  assert.deepEqual(projection(collageTextRuns('A? B', latin, [chinese, latin])),
    [['A', 'latin'], ['? B', 'latin'], [' B', 'latin']]);
  assert.deepEqual(projection(collageTextRuns('A? B鸡', latin, [chinese, latin])),
    [['A', 'latin'], ['? B鸡', 'latin'], [' B', 'latin'], ['鸡', 'chinese']]);
  assert.deepEqual(projection(collageTextRuns('?鸡', latin, [chinese, latin])), [['?鸡', 'latin']]);
  assert.deepEqual(projection(collageTextRuns('A? B', latin, collageFallbackFaces(() => null, null))),
    [['A', 'latin'], ['? B', 'latin'], [' B', 'latin']], 'A missing system default remains a nullable fallback entry.');
});
