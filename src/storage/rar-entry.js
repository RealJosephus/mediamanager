import { closeSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { createDecipheriv, createHash } from 'node:crypto';

const signature = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const invalid = message => Object.assign(new Error(message), { code: 'invalid-archive' });
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? value >>> 1 ^ 0xedb88320 : value >>> 1;
  return value;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = value >>> 8 ^ crcTable[(value ^ byte) & 255];
  return ~value >>> 0;
}
function readBytes(fd, position, length, size) {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0 || length > size - position)
    throw invalid('The RAR entry exceeds its archive source.');
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, position + offset);
    if (!count) throw invalid('The RAR entry source is truncated.');
    offset += count;
  }
  return bytes;
}
function isRar4(fd, size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('Invalid RAR source size.');
  return size >= signature.length && readBytes(fd, 0, signature.length, size).equals(signature);
}
function* fileHeaders(fd, size) {
  let position = signature.length, index = 0;
  while (position + 7 <= size) {
    const prefix = readBytes(fd, position, 7, size), type = prefix[2], flags = prefix.readUInt16LE(3), length = prefix.readUInt16LE(5);
    if (length < 7) throw invalid('The RAR header is truncated.');
    const header = readBytes(fd, position, length, size);
    if ((crc32(header.subarray(2)) & 0xffff) !== header.readUInt16LE(0)) throw invalid('The RAR header checksum is invalid.');
    if (flags & 0x8000 && length < 11) throw invalid('The RAR data header is truncated.');
    let packed = flags & 0x8000 ? BigInt(header.readUInt32LE(7)) : 0n;
    if (type === 0x74) {
      const nameOffset = flags & 0x100 ? 40 : 32;
      if (length < nameOffset) throw invalid('The RAR file header is truncated.');
      let unpacked = BigInt(header.readUInt32LE(11));
      if (flags & 0x100) { packed += BigInt(header.readUInt32LE(32)) << 32n; unpacked += BigInt(header.readUInt32LE(36)) << 32n; }
      if (packed > BigInt(Number.MAX_SAFE_INTEGER) || unpacked > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('The RAR entry exceeds the supported file range.');
      const nameEnd = nameOffset + header.readUInt16LE(26), saltLength = flags & 0x400 ? 8 : 0;
      if (nameEnd + saltLength > length) throw invalid('The RAR filename or salt is truncated.');
      if (Number(packed) > size - position - length) throw invalid('The RAR data is truncated.');
      yield { header, flags, nameOffset, nameEnd, saltLength, packed: Number(packed), unpacked: Number(unpacked), dataOffset: position + length, ordinal: index++ };
    }
    if (packed > BigInt(Number.MAX_SAFE_INTEGER) || Number(packed) > size - position - length) throw invalid('The RAR data is truncated.');
    if (type === 0x7b) return;
    position += length + Number(packed);
  }
}
function selectedHeader(fd, size, ordinal) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new TypeError('Invalid RAR entry ordinal.');
  if (!isRar4(fd, size)) return null;
  for (const entry of fileHeaders(fd, size)) if (entry.ordinal === ordinal) {
    if (entry.flags & 3) throw invalid('A split RAR entry requires additional archive volumes.');
    // A fresh native compressed solid selection has no allocated window.
    // Stored entries do not use that window.
    if (entry.flags & 0x10 && entry.header[25] !== 0x30) throw invalid('A fresh compressed solid RAR4 entry has no decoder window.');
    return entry;
  }
  return null;
}
function unicodeName(bytes, encoded) {
  const get = index => {
    if (index >= bytes.length) throw invalid('The RAR Unicode filename is truncated.');
    return bytes[index];
  };
  let decoded = 0, flags = 0, flagBits = 0, result = '';
  const highByte = get(encoded++);
  while (encoded < bytes.length) {
    if (!flagBits) { flags = get(encoded++); flagBits = 8; }
    switch (flags >>> 6) {
      case 0: result += String.fromCharCode(get(encoded++)); decoded++; break;
      case 1: result += String.fromCharCode(get(encoded++) + (highByte << 8)); decoded++; break;
      case 2: result += String.fromCharCode(get(encoded) + (get(encoded + 1) << 8)); encoded += 2; decoded++; break;
      case 3: {
        let length = get(encoded++);
        if (length & 0x80) {
          const correction = get(encoded++);
          for (length = (length & 0x7f) + 2; length > 0 && decoded < bytes.length; length--, decoded++)
            result += String.fromCharCode((highByte << 8) + ((get(decoded) + correction) & 255));
        } else for (length += 2; length > 0 && decoded < bytes.length; length--, decoded++) result += String.fromCharCode(get(decoded));
        break;
      }
    }
    flags = flags << 2 & 255; flagBits -= 2;
  }
  return result;
}
/** Native RAR4 directory order includes directories and duplicate FILE headers.
 * Only header bytes are read. Names remain data, never access paths. Unicode
 * filename decoding follows the pinned SharpCompress FileNameDecoder source. */
export function readRar4Directory(fd, size) {
  if (!isRar4(fd, size)) return null;
  const entries = [];
  for (const { header, flags, nameOffset, unpacked, ordinal } of fileHeaders(fd, size)) {
    const declaredLength = header.readInt16LE(26);
    if (declaredLength < 0) throw invalid('The RAR filename length is invalid.');
    const bytes = header.subarray(nameOffset, nameOffset + Math.min(4096, declaredLength));
    const end = flags & 0x200 ? bytes.indexOf(0) : -1;
    const key = end < 0 ? bytes.toString('utf8') : unicodeName(bytes, end + 1);
    entries.push({ key: key.replaceAll('/', '\\'), size: unpacked, isDirectory: (flags & 0xe0) === 0xe0, ordinal });
  }
  return entries;
}

/** CryptKey3(null) uses an empty password. Its fixed SHA-1 rounds and AES-CBC
 * construction follow the actual SharpCompress package source pinned beside
 * archive-codec-rar4.patch; the derived bytes are never an image fixture. */
function emptyPasswordCipher(salt) {
  const rounds = 1 << 18, data = Buffer.allocUnsafe((salt.length + 3) * rounds), iv = Buffer.alloc(16);
  for (let round = 0; round < rounds; round++) {
    salt.copy(data, round * 11);
    data.writeUIntLE(round, round * 11 + 8, 3);
    if (round % 16384 === 0) iv[round / 16384] = createHash('sha1').update(data.subarray(0, (round + 1) * 11)).digest()[19];
  }
  const digest = createHash('sha1').update(data).digest(), key = Buffer.alloc(16);
  for (let word = 0; word < 4; word++) for (let byte = 0; byte < 4; byte++) key[word * 4 + byte] = digest[word * 4 + 3 - byte];
  return createDecipheriv('aes-128-cbc', key, iv).setAutoPadding(false);
}
function block(type, length) {
  const bytes = Buffer.alloc(length);
  bytes[2] = type; bytes.writeUInt16LE(length, 5); bytes.writeUInt16LE(crc32(bytes.subarray(2)) & 0xffff, 0);
  return bytes;
}
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!count) throw invalid('The RAR entry spool could not be written.');
    offset += count;
  }
}

/** Prepare only the selected classic-RAR entry. Input is an owned
 * read-only archive descriptor; output is a caller-owned create-only spool.
 * Keys remain header data. They never become filesystem paths. The worker
 * must enable mm_rar4_independent on the new reader before mm_open. */
export function prepareRar4Entry(fd, size, ordinal, outputFilename) {
  const entry = selectedHeader(fd, size, ordinal);
  if (!entry) return null;
  const { header, flags, nameEnd, saltLength, packed, dataOffset } = entry;
  if (saltLength && packed % 16) throw invalid('The encrypted RAR AES data is truncated.');
  const cipher = saltLength ? emptyPasswordCipher(header.subarray(nameEnd, nameEnd + saltLength)) : null;
  const selected = Buffer.concat([header.subarray(0, nameEnd), header.subarray(nameEnd + saltLength)]);
  selected.writeUInt16LE(flags & ~0x414, 3);
  selected.writeUInt16LE(selected.length, 5);
  selected.writeUInt16LE(crc32(selected.subarray(2)) & 0xffff, 0);
  let output, created = false;
  try {
    output = openSync(outputFilename, 'wx'); created = true;
    writeAll(output, signature); writeAll(output, block(0x73, 13)); writeAll(output, selected);
    const buffer = Buffer.allocUnsafe(65536);
    let consumed = 0;
    while (consumed < packed) {
      const length = Math.min(buffer.length, packed - consumed);
      let offset = 0;
      while (offset < length) {
        const count = readSync(fd, buffer, offset, length - offset, dataOffset + consumed + offset);
        if (!count) throw invalid('The encrypted RAR entry data is truncated.');
        offset += count;
      }
      const chunk = buffer.subarray(0, length);
      writeAll(output, cipher ? cipher.update(chunk) : chunk);
      consumed += length;
    }
    if (cipher) writeAll(output, cipher.final());
    writeAll(output, block(0x7b, 7));
    closeSync(output); output = undefined;
    return { filename: outputFilename, size: signature.length + 13 + selected.length + packed + 7 };
  } catch (error) {
    try { if (output !== undefined) closeSync(output); }
    finally { if (created) try { unlinkSync(outputFilename); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw cleanup; } }
    throw error;
  }
}
