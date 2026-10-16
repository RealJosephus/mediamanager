// Read only the selected system file's directories. No directory scanning or
// filename-to-family guesses. Table offsets in a TTC remain file-relative.
const unicode = new TextDecoder('utf-16be', { fatal: true });
function range(bytes, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new TypeError('Invalid system font directory range.');
  }
}
export function systemFontDirectories(bytes) {
  range(bytes, 0, 12);
  const collection = bytes.toString('ascii', 0, 4) === 'ttcf';
  const count = collection ? bytes.readUInt32BE(8) : 1;
  if (!count) throw new TypeError('Empty system font collection.');
  if (collection) {
    if (![0x10000, 0x20000].includes(bytes.readUInt32BE(4))) throw new TypeError('Unsupported system font collection.');
    range(bytes, 12, count * 4 + (bytes.readUInt32BE(4) === 0x20000 ? 12 : 0));
  }
  return Array.from({ length: count }, (_, index) => {
    const offset = collection ? bytes.readUInt32BE(12 + index * 4) : 0; range(bytes, offset, 12);
    if (![0x10000, 0x4f54544f, 0x74727565, 0x74797031].includes(bytes.readUInt32BE(offset))) throw new TypeError('Unsupported system font format.');
    const count = bytes.readUInt16BE(offset + 4), tables = new Map(); range(bytes, offset + 12, count * 16);
    for (let i = 0; i < count; i++) {
      const record = offset + 12 + i * 16, tag = bytes.toString('ascii', record, record + 4);
      const start = bytes.readUInt32BE(record + 8), length = bytes.readUInt32BE(record + 12); range(bytes, start, length);
      if (tables.has(tag)) throw new TypeError('Duplicate system font table.');
      tables.set(tag, bytes.subarray(start, start + length));
    }
    return tables;
  });
}
export function systemFontPostscriptNames(tables) {
  const bytes = tables.get('name'), names = new Set();
  if (!bytes) throw new TypeError('The system font has no name table.');
  range(bytes, 0, 6);
  const count = bytes.readUInt16BE(2), storage = bytes.readUInt16BE(4); range(bytes, 6, count * 12);
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12, platform = bytes.readUInt16BE(record), encoding = bytes.readUInt16BE(record + 2);
    if (bytes.readUInt16BE(record + 6) !== 6) continue;
    const length = bytes.readUInt16BE(record + 8), start = storage + bytes.readUInt16BE(record + 10); range(bytes, start, length);
    const value = bytes.subarray(start, start + length);
    if (platform === 0 || platform === 3 && [0, 1, 10].includes(encoding)) names.add(unicode.decode(value));
    else if (platform === 1 && encoding === 0 && value.every(byte => byte < 128)) names.add(value.toString('ascii'));
  }
  names.delete(''); return [...names];
}
export function selectSystemFontDirectory(bytes, descriptor) {
  const directories = systemFontDirectories(bytes);
  let index = descriptor.collectionIndex;
  if (index === null) {
    if (!descriptor.postscriptName) throw new TypeError('CoreText must identify the selected face by PostScript name.');
    const matches = directories.flatMap((tables, i) => systemFontPostscriptNames(tables).includes(descriptor.postscriptName) ? [i] : []);
    if (matches.length !== 1) throw new Error('The selected CoreText face is not uniquely present in its system font file.');
    [index] = matches;
  }
  if (!Number.isInteger(index) || index < 0 || index >= directories.length) throw new TypeError('The system font face index is out of range.');
  const tables = directories[index], postscriptNames = systemFontPostscriptNames(tables);
  if (descriptor.postscriptName && !postscriptNames.includes(descriptor.postscriptName)) throw new Error('The selected system font PostScript identity changed.');
  return { collectionIndex: index, tables, postscriptNames };
}
