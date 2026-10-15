import { parentPort, workerData } from 'node:worker_threads';
import { openSync, closeSync, readSync, unlinkSync, createReadStream } from 'node:fs';
import { createGunzip, createInflateRaw } from 'node:zlib';
import { readArchiveBytes, readZipDirectory, zipEntryDataRange } from './zip-directory.js';
import { readDeflate64 } from './deflate64.js';
import { prepareRar4Entry, readRar4Directory } from './rar-entry.js';

const { filename, size, zipOnly } = workerData;
const fd = openSync(filename, 'r');
const sources = new Map([[0, fd]]);
let codec, entries, zip, archiveFormat = 0, gzip = false, closed = false;
async function loadCodec() {
  const createCodec = (await import('./resources/archive-codec.mjs')).default;
  return createCodec({ archiveRead(token, pointer, capacity, position) {
    const source = sources.get(token);
    if (source === undefined) throw failure('The archive source is closed.');
    return readSync(source, codec.HEAPU8, pointer, capacity, position);
  } });
}
const failure = message => Object.assign(new Error(message), { code: 'invalid-archive' });
function check(status, state) {
  if (status < 0) throw failure(codec.UTF8ToString(codec._mm_error(state)) || 'Archive decoding failed.');
  return status;
}
function openCodec(source = { token: 0, size }, independentRar4 = false) {
  const state = codec._mm_create(source.token, source.size, zipOnly ? 1 : 0);
  if (!state) throw failure('Cannot allocate an archive reader.');
  try {
    if (independentRar4) check(codec._mm_rar4_independent(state), state);
    check(codec._mm_open(state), state); return state;
  }
  catch (error) { codec._mm_free(state); throw error; }
}
async function initialize() {
  const signature = size >= 4 ? readArchiveBytes(fd, 0, 4, size).readUInt32LE(0) : 0;
  const classicEntries = signature === 0x21726152 ? readRar4Directory(fd, size) : null;
  if (zipOnly || [0x04034b50, 0x06054b50, 0x08074b50].includes(signature)) {
    zip = readZipDirectory(fd, size, { unicodePath: !zipOnly }); entries = zip.entries;
  } else if (classicEntries) {
    entries = classicEntries; archiveFormat = 0xd0000;
  } else if ((signature & 0xffff) === 0x8b1f) {
    gzip = true;
    const header = readArchiveBytes(fd, 0, 10, size), flags = header[3];
    if (header[2] !== 8 || flags & 0xe0) throw failure('The GZip header is invalid.');
    let offset = 10;
    if (flags & 4) { const length = readArchiveBytes(fd, offset, 2, size).readUInt16LE(0); offset += 2 + length; }
    let key = null;
    if (flags & 8) {
      const chunks = []; let ended = false;
      while (offset < size && !ended) {
        const block = readArchiveBytes(fd, offset, Math.min(4096, size - offset), size), end = block.indexOf(0);
        chunks.push(end < 0 ? block : block.subarray(0, end));
        offset += end < 0 ? block.length : end + 1; ended = end >= 0;
      }
      if (!ended) throw failure('The GZip filename is truncated.');
      key = Buffer.concat(chunks).toString('utf8');
    }
    entries = [{ key, size: readArchiveBytes(fd, size - 4, 4, size).readUInt32LE(0), isDirectory: false, ordinal: 0 }];
  } else {
    codec = await loadCodec();
    const state = openCodec(); entries = [];
    try {
      while (check(codec._mm_next(state), state) !== 1) {
        archiveFormat = codec._mm_format(state) & 0xff0000;
        const rawKey = codec.UTF8ToString(codec._mm_key(state));
        const key = archiveFormat === 0x100000 ? rawKey.replaceAll('\\', '-').replaceAll('/', '\\') : rawKey;
        entries.push({ key, size: codec._mm_size(state),
          isDirectory: Boolean(codec._mm_directory(state)), ordinal: entries.length });
        check(codec._mm_skip(state), state);
      }
    } finally { codec._mm_free(state); }
  }
  return { entries: entries.map(({ key, size: length, isDirectory }) => ({ key, size: length, isDirectory })), comment: zip?.comment ?? Buffer.alloc(0) };
}
async function readEntry(ordinal) {
  const entry = entries[ordinal];
  if (!entry) throw failure('The archive entry does not exist.');
  if (archiveFormat === 0x100000 && entry.isDirectory && entry.size === 0) return Buffer.alloc(0);
  if (zipOnly && ![0, 8, 9].includes(entry.method)) throw failure('The ZIP compression method is unsupported.');
  if (gzip) {
    const source = createReadStream(filename);
    const stream = source.pipe(createGunzip()); source.on('error', error => stream.destroy(error));
    try { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }
    finally { stream.destroy(); source.destroy(); }
  }
  if (zip && entry.method === 9) {
    if (entry.flags & 1) throw failure('The archive entry requires a password.');
    const range = zipEntryDataRange(fd, entry, size);
    return readDeflate64(fd, range.start, entry.compressedSize, entry.size);
  }
  if (zip && [0, 8].includes(entry.method)) {
    if (entry.flags & 1) throw failure('The archive entry requires a password.');
    const range = zipEntryDataRange(fd, entry, size);
    if (!entry.compressedSize) return Buffer.alloc(0);
    const source = createReadStream(filename, range);
    const stream = entry.method === 8 ? source.pipe(createInflateRaw()) : source;
    if (stream !== source) source.on('error', error => stream.destroy(error));
    try {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      return Buffer.concat(chunks);
    } finally { stream.destroy(); source.destroy(); }
  }
  if (!codec) codec = await loadCodec();
  let derived, state, pointer;
  try {
    derived = prepareRar4Entry(fd, size, ordinal, filename + '.entry');
    if (derived) sources.set(1, openSync(derived.filename, 'r'));
    state = openCodec(derived ? { token: 1, size: derived.size } : undefined, Boolean(derived));
    pointer = codec._malloc(65536);
    if (!pointer) throw failure('Cannot allocate an archive read buffer.');
    let current = 0;
    while (check(codec._mm_next(state), state) !== 1) {
      const selected = zip ? codec._mm_header_position(state) === entry.localOffset : current === (derived ? 0 : ordinal);
      if (selected) {
        const chunks = [];
        while (true) {
          const count = check(codec._mm_read(state, pointer, 65536), state);
          if (!count) return Buffer.concat(chunks);
          chunks.push(Buffer.from(codec.HEAPU8.subarray(pointer, pointer + count)));
        }
      }
      check(codec._mm_skip(state), state); current++;
    }
    throw failure('The archive entry cannot be located.');
  } finally {
    try {
      if (pointer) codec._free(pointer);
      if (state) codec._mm_free(state);
    } finally {
      const derivedFd = sources.get(1); sources.delete(1);
      try { if (derivedFd !== undefined) closeSync(derivedFd); }
      finally { if (derived) unlinkSync(derived.filename); }
    }
  }
}
let tail = Promise.resolve();
parentPort.on('message', ({ id, ordinal }) => {
  tail = tail.then(async () => {
    try { if (closed) throw failure('The archive reader is closed.'); parentPort.postMessage({ id, result: await readEntry(ordinal) }); }
    catch (error) { parentPort.postMessage({ id, error: { name: error.name, message: error.message, code: error.code } }); }
  });
});
process.on('exit', () => { if (!closed) { closed = true; for (const source of sources.values()) closeSync(source); sources.clear(); } });
try { parentPort.postMessage({ id: 0, result: await initialize() }); }
catch (error) { parentPort.postMessage({ id: 0, error: { name: error.name, message: error.message, code: error.code } }); }
