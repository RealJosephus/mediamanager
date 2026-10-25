import { readSync } from 'node:fs';

const invalid = message => Object.assign(new Error(message), { code: 'invalid-archive' });
function integer(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw invalid('Archive offsets exceed the supported file range.');
  return number;
}
export function readArchiveBytes(fd, offset, length, size) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
    throw invalid('Archive data is outside its file.');
  }
  const result = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, result, read, length - read, offset + read);
    if (!count) throw invalid('Archive data is truncated.');
    read += count;
  }
  return result;
}

/** Read raw central-directory keys. ZIP entry names are data, never host paths. */
export function readZipDirectory(fd, size, { unicodePath = false } = {}) {
  const tailOffset = Math.max(0, size - 65557), tail = readArchiveBytes(fd, tailOffset, size - tailOffset, size);
  let index = tail.length - 22;
  for (; index >= 0; index--) {
    if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) <= tail.length) break;
  }
  if (index < 0) throw invalid('The ZIP end-of-directory record is missing.');
  const end = tailOffset + index;
  if (tail.readUInt16LE(index + 4) || tail.readUInt16LE(index + 6)) throw invalid('Split ZIP archives are unsupported.');
  let count = tail.readUInt16LE(index + 10), directorySize = tail.readUInt32LE(index + 12), offset = tail.readUInt32LE(index + 16);
  let directoryEnd = end;
  if (count === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff) {
    const locator = readArchiveBytes(fd, end - 20, 20, size);
    if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) || locator.readUInt32LE(16) !== 1) {
      throw invalid('The ZIP64 locator is invalid.');
    }
    const recordOffset = integer(locator.readBigUInt64LE(8));
    const record = readArchiveBytes(fd, recordOffset, 56, size);
    if (record.readUInt32LE(0) !== 0x06064b50 || record.readUInt32LE(16) || record.readUInt32LE(20)) throw invalid('The ZIP64 directory is invalid.');
    count = integer(record.readBigUInt64LE(32));
    directorySize = integer(record.readBigUInt64LE(40));
    offset = integer(record.readBigUInt64LE(48));
    directoryEnd = recordOffset;
  }
  // Self-extracting files can store offsets relative to the ZIP payload.
  const declared = offset;
  if (count && readArchiveBytes(fd, offset, 4, size).readUInt32LE(0) !== 0x02014b50) offset = directoryEnd - directorySize;
  const adjustment = offset - declared, entries = [];
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const header = readArchiveBytes(fd, offset, 46, size);
    if (header.readUInt32LE(0) !== 0x02014b50) throw invalid('The ZIP central directory is invalid.');
    const nameLength = header.readUInt16LE(28), extraLength = header.readUInt16LE(30), commentLength = header.readUInt16LE(32);
    const name = readArchiveBytes(fd, offset + 46, nameLength, size);
    const extra = readArchiveBytes(fd, offset + 46 + nameLength, extraLength, size);
    let compressedSize = header.readUInt32LE(20), length = header.readUInt32LE(24), localOffset = header.readUInt32LE(42);
    if ([compressedSize, length, localOffset].includes(0xffffffff)) {
      let found = false;
      for (let cursor = 0; cursor + 4 <= extra.length;) {
        const id = extra.readUInt16LE(cursor), fieldLength = extra.readUInt16LE(cursor + 2), start = cursor + 4;
        cursor = start + fieldLength;
        if (cursor > extra.length) throw invalid('A ZIP extra field is truncated.');
        if (id !== 1) continue;
        let position = start;
        const next = () => { if (position + 8 > cursor) throw invalid('The ZIP64 entry is truncated.'); const value = integer(extra.readBigUInt64LE(position)); position += 8; return value; };
        if (length === 0xffffffff) length = next();
        if (compressedSize === 0xffffffff) compressedSize = next();
        if (localOffset === 0xffffffff) localOffset = next();
        found = true; break;
      }
      if (!found) throw invalid('The ZIP64 entry is missing.');
    }
    let key = name.toString('utf8');
    if (unicodePath) for (let cursor = 0; cursor + 4 <= extra.length;) {
      const id = extra.readUInt16LE(cursor), length = extra.readUInt16LE(cursor + 2), start = cursor + 4;
      cursor = start + length;
      if (cursor > extra.length) throw invalid('A ZIP extra field is truncated.');
      if (id === 0x7075 && length >= 5) {
        key = extra.subarray(start + 5, cursor).toString('utf8');
      }
    }
    entries.push({ key, size: length, isDirectory: key.endsWith('/'), ordinal,
      compressedSize, localOffset: localOffset + adjustment, method: header.readUInt16LE(10), flags: header.readUInt16LE(8) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, comment: Buffer.from(tail.subarray(index + 22, index + 22 + tail.readUInt16LE(index + 20))) };
}

export function zipEntryDataRange(fd, entry, size) {
  const header = readArchiveBytes(fd, entry.localOffset, 30, size);
  if (header.readUInt32LE(0) !== 0x04034b50) throw invalid('The ZIP local header is invalid.');
  const start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + entry.compressedSize > size) throw invalid('The ZIP entry data is truncated.');
  return { start, end: start + entry.compressedSize - 1 };
}
