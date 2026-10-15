import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeNativeText, decodeNativeTextEncoding } from '../../src/core/native-text.js';

// Actual .NET 10 CodePagesEncodingProvider byte output, recorded on the same
// pinned runtime used by the playlist provider oracle.
const samples = [
  ['ibm850', 'Q2FmgiBkgmqF', 'Café déjà'],
  ['ibm852', 'UP2hbGnnIKdsdZxvdZ9r7CBrheU=', 'Příliš žluťoučký kůň'],
  ['ibm855', '3eG366jlINK34Q==', 'Привет мир'],
  ['x-mac-ce', 'UN6SbGnkIOxsdelvdYtr+SBr88s=', 'Příliš žluťoučký kůň'],
  ['hz-gb-2312', 'fntWUE5EOGhHen59', '中文歌曲'],
  ['iso-2022-kr', 'GyQpQw5HUTE5DyAOM2s3IQ8=', '한국 노래'],
  ['x-cp50227', '1tDOxLjox/o=', '中文歌曲'],
  ['utf-32', 'TQAAAPoAAABzAAAAaQAAAGMAAABhAAAAIAAAAOkAAABwAAAAaQAAAGMAAABhAAAA', 'Música épica'],
  ['utf-32BE', 'AAAATQAAAPoAAABzAAAAaQAAAGMAAABhAAAAIAAAAOkAAABwAAAAaQAAAGMAAABh', 'Música épica'],
];

for (const [encoding, base64, expected] of samples) test(`native StreamReader decoder: ${encoding}`, () => {
  assert.equal(decodeNativeTextEncoding(Buffer.from(base64, 'base64'), encoding), expected);
});

test('native StreamReader BOM detection overrides its declared fallback encoding', () => {
  const utf16 = Buffer.from('//4jAEUAWABUAE0AMwBVAAoA', 'base64');
  assert.equal(decodeNativeTextEncoding(utf16, 'windows-1252'), '#EXTM3U\n');
  assert.equal(decodeNativeText(utf16), '#EXTM3U\n');
});

test('native UTF-32 decoder replaces invalid scalars and incomplete trailing units', () => {
  const bytes = Buffer.alloc(10);
  bytes.writeUInt32LE(0x110000, 0);
  bytes.writeUInt32LE(0x41, 4);
  bytes[8] = 0x42;
  assert.equal(decodeNativeTextEncoding(bytes, 'utf-32'), '\ufffdA\ufffd');
});
