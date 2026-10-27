import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const text = bytes => bytes.toString('utf8').split('\0')[0];
const octal = bytes => {
  const value = text(bytes).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error('Unsupported original source TAR number.');
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) throw new Error('Original source TAR number exceeds its bound.');
  return result;
};

// Read original Git gzip/TAR containers without extracting paths or retaining their whole contents.
export async function streamSourceArchive(filename, members, capture = [], commit) {
  const key = name => name.endsWith('/') ? name.slice(0, -1) : name;
  const expected = new Map(members.map(member => [key(member.path), member]));
  if (expected.size !== members.length) throw new Error('Original source archive member is duplicated.');
  const selected = new Set(capture), captured = new Map(), seen = new Set();
  let header = Buffer.alloc(512), filled = 0, remaining = 0, padding = 0, current, footer = 0;
  let globalPax = new Map(), nextPax = new Map();
  const applyPax = (target, values) => {
    for (const [key, value] of values) { if (value === '') target.delete(key); else target.set(key, value); }
    return target;
  };
  const finish = () => {
    if (current?.pax) {
      const bytes = Buffer.concat(current.chunks), values = new Map();
      let offset = 0;
      while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset), length = Number(bytes.subarray(offset, space).toString('ascii'));
        if (space < offset || !/^[0-9]+$/u.test(bytes.subarray(offset, space).toString('ascii'))
          || !Number.isSafeInteger(length) || length <= space - offset + 1
          || offset + length > bytes.length || bytes[offset + length - 1] !== 10) throw new Error('Unsupported original source PAX record.');
        const record = bytes.subarray(space + 1, offset + length - 1).toString('utf8');
        const equals = record.indexOf('='), key = record.slice(0, equals), value = record.slice(equals + 1);
        if (equals < 1 || !['comment', 'path', 'linkpath', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key)) {
          throw new Error('Unsupported original source PAX attribute.');
        }
        if (key === 'comment' && commit !== undefined && value !== commit) {
          throw new Error('Original source PAX comment differs from its Git identity.');
        }
        values.set(key, value);
        offset += length;
      }
      if (current.pax === 103) globalPax = applyPax(globalPax, values);
      else nextPax = new Map([...nextPax, ...values]);
    }
    if (current?.member?.kind === 'file') {
      if (current.hash.digest('hex') !== current.member.sha256 || current.git.digest('hex') !== current.member.gitBlob) {
        throw new Error('Original source archive file differs from its Git blob: ' + current.member.path);
      }
      if (current.chunks) captured.set(current.member.path, Buffer.concat(current.chunks));
    }
    current = undefined;
  };
  await pipeline(createReadStream(filename), createGunzip(), async stream => {
    for await (const chunk of stream) {
      let offset = 0;
      while (offset < chunk.length) {
        if (remaining) {
          const length = Math.min(remaining, chunk.length - offset), bytes = chunk.subarray(offset, offset + length);
          current.hash?.update(bytes); current.git?.update(bytes); current.chunks?.push(Buffer.from(bytes));
          offset += length; remaining -= length;
          if (remaining === 0) finish();
        } else if (padding) {
          const length = Math.min(padding, chunk.length - offset); padding -= length; offset += length;
        } else if (footer) {
          const bytes = chunk.subarray(offset);
          if (bytes.some(value => value !== 0)) throw new Error('Original source TAR has unbound trailing bytes.');
          footer += bytes.length; offset = chunk.length;
        } else {
          const length = Math.min(512 - filled, chunk.length - offset);
          chunk.copy(header, filled, offset, offset + length); offset += length; filled += length;
          if (filled !== 512) continue;
          filled = 0;
          if (header.every(value => value === 0)) { footer = 512; continue; }
          const checksum = octal(header.subarray(148, 156));
          if (header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0) !== checksum) {
            throw new Error('Original source TAR header checksum changed.');
          }
          const prefix = text(header.subarray(345, 500)), name = text(header.subarray(0, 100));
          let filename = prefix ? prefix + '/' + name : name, bytes = octal(header.subarray(124, 136));
          const type = header[156]; let target = text(header.subarray(157, 257));
          remaining = bytes; padding = (512 - bytes % 512) % 512;
          // GitHub carries a commit comment; Gitiles also carries fractional times and long paths.
          if (type === 103 || type === 120) {
            if (bytes > 65536) throw new Error('Original source PAX record exceeds its bound.');
            current = { pax: type, chunks: [] };
          } else {
            const attributes = applyPax(new Map(globalPax), nextPax); nextPax = new Map();
            filename = attributes.get('path') ?? filename; target = attributes.get('linkpath') ?? target;
            if (attributes.has('size')) {
              if (!/^[0-9]+$/u.test(attributes.get('size')) || !Number.isSafeInteger(Number(attributes.get('size')))) {
                throw new Error('Unsupported original source PAX size.');
              }
              bytes = Number(attributes.get('size')); remaining = bytes; padding = (512 - bytes % 512) % 512;
            }
            const member = expected.get(key(filename)), kind = type === 53 ? 'directory' : type === 50 ? 'symlink' : [0, 48].includes(type) ? 'file' : undefined;
            if (!member || seen.has(key(filename)) || !kind || member.kind !== kind || member.bytes !== bytes
              || member.mode !== octal(header.subarray(100, 108))
              || kind !== 'file' && bytes !== 0 || kind === 'symlink' && member.target !== target) {
              throw new Error('Original source archive membership or link changed: ' + filename);
            }
            seen.add(key(filename)); current = { member };
            if (kind === 'file') {
              current.hash = createHash('sha256');
              current.git = createHash('sha1').update(`blob ${bytes}\0`);
              if (selected.has(member.path)) current.chunks = [];
            }
          }
          if (remaining === 0) finish();
        }
      }
    }
  });
  if (filled || remaining || padding || footer < 1024 || seen.size !== expected.size
    || [...selected].some(name => !captured.has(name))) throw new Error('Original source archive is incomplete.');
  return captured;
}
