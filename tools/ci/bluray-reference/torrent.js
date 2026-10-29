import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

const text = value => new TextDecoder('utf-8', { fatal: true }).decode(value);
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
export function safeMember(value) {
  assert.ok(typeof value === 'string' && value && !/[:\\\r\n\0]/u.test(value)
    && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..'), 'Original media paths must remain relative ordinary members.');
  return value;
}

/** Hash the original info dictionary bytes, without re-encoding bencode. */
export function readTorrent(bytes, descriptor) {
  assert.equal(bytes.length, descriptor.bytes); assert.equal(digest('sha256', bytes), descriptor.sha256);
  let position = 0, infoBytes;
  const read = (depth = 0) => {
    assert.ok(depth < 32 && position < bytes.length, 'Invalid torrent nesting or truncated metadata.');
    const token = bytes[position];
    if (token === 105) {
      const end = bytes.indexOf(101, ++position), source = bytes.subarray(position, end).toString('ascii');
      assert.ok(end >= position && /^(?:0|-[1-9]\d*|[1-9]\d*)$/u.test(source), 'Invalid torrent integer.'); position = end + 1;
      const value = Number(source); assert.ok(Number.isSafeInteger(value)); return value;
    }
    if (token === 108 || token === 100) {
      position++; const result = token === 108 ? [] : new Map();
      while (bytes[position] !== 101) {
        if (Array.isArray(result)) result.push(read(depth + 1));
        else {
          const key = read(depth + 1); assert.ok(Buffer.isBuffer(key)); const name = text(key); assert.ok(!result.has(name));
          const start = position, value = read(depth + 1); result.set(name, value);
          if (depth === 0 && name === 'info') infoBytes = bytes.subarray(start, position);
        }
      }
      position++; return result;
    }
    const colon = bytes.indexOf(58, position), source = bytes.subarray(position, colon).toString('ascii');
    assert.ok(colon > position && /^(?:0|[1-9]\d*)$/u.test(source), 'Invalid torrent byte string.');
    const length = Number(source); position = colon + 1; assert.ok(Number.isSafeInteger(length) && position + length <= bytes.length);
    const value = bytes.subarray(position, position + length); position += length; return value;
  };
  const root = read(); assert.ok(root instanceof Map); assert.equal(position, bytes.length); assert.ok(infoBytes);
  assert.equal(digest('sha1', infoBytes), descriptor.infoHash);
  const info = root.get('info'); assert.ok(info instanceof Map);
  const name = safeMember(text(info.get('name'))); assert.equal(name.includes('/'), false);
  const pieces = info.get('pieces'); assert.ok(Buffer.isBuffer(pieces));
  assert.equal(info.get('piece length'), descriptor.pieceLength); assert.equal(pieces.length, descriptor.piecesCount * 20);
  assert.equal(digest('sha256', pieces), descriptor.piecesSha256);
  const files = info.get('files').map(file => ({ path: safeMember(file.get('path').map(text).join('/')), bytes: file.get('length') }));
  assert.deepEqual(files, descriptor.files); assert.equal(new Set(files.map(file => file.path)).size, files.length);
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  assert.equal(Math.ceil(totalBytes / descriptor.pieceLength), descriptor.piecesCount);
  return { name, files, pieces, pieceLength: descriptor.pieceLength, infoHash: descriptor.infoHash,
    announces: [text(root.get('announce')), ...(root.get('announce-list') ?? []).flat().map(text)], totalBytes,
    metadata: { createdBy: text(root.get('created by')), creationDate: root.get('creation date'), encoding: text(root.get('encoding')) } };
}

/** Verify every v1 piece across file boundaries and hash every complete file. */
export async function verifyTorrentFiles(root, torrent, { signal } = {}) {
  const files = []; let pieceIndex = 0, pieceBytes = 0, totalBytes = 0, piece = createHash('sha1');
  const finishPiece = () => {
    assert.equal(piece.digest('hex'), torrent.pieces.subarray(pieceIndex * 20, pieceIndex * 20 + 20).toString('hex'),
      'Downloaded original torrent piece differs at index ' + pieceIndex);
    pieceIndex++; pieceBytes = 0; piece = createHash('sha1');
  };
  for (const entry of torrent.files) {
    const filename = path.join(root, ...entry.path.split('/')), before = await lstat(filename);
    assert.ok(before.isFile() && !before.isSymbolicLink()); assert.equal(before.size, entry.bytes);
    const hash = createHash('sha256'); let fileBytes = 0;
    for await (const chunk of createReadStream(filename, { signal, highWaterMark: 1024 * 1024 })) {
      hash.update(chunk); fileBytes += chunk.length; totalBytes += chunk.length;
      for (let offset = 0; offset < chunk.length;) {
        const length = Math.min(chunk.length - offset, torrent.pieceLength - pieceBytes);
        piece.update(chunk.subarray(offset, offset + length)); pieceBytes += length; offset += length;
        if (pieceBytes === torrent.pieceLength) finishPiece();
      }
    }
    const after = await lstat(filename); assert.equal(fileBytes, entry.bytes); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
    files.push({ ...entry, sha256: hash.digest('hex') });
  }
  if (pieceBytes) finishPiece();
  assert.equal(totalBytes, torrent.totalBytes); assert.equal(pieceIndex, torrent.pieces.length / 20);
  return { files, piecesVerified: pieceIndex, totalBytes };
}
