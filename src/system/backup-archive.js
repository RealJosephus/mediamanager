import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw, inflateRawSync } from 'node:zlib';
import yazl from 'yazl';
import { readArchiveBytes, readZipDirectory, zipEntryDataRange } from '../storage/zip-directory.js';

export const legacyBackupFormat = 'MediaManager.PostgreSQL.1';
export const backupFormat = 'MediaManager.PostgreSQL.2';
const maxDescriptorSize = 64 * 1024 * 1024;

export async function withBackupArchive(filename, operation) {
  if (!(await fs.lstat(filename)).isFile()) throw new Error('A regular backup archive is required.');
  const file = await fs.open(filename, 'r');
  try {
    const { size } = await file.stat();
    const { entries } = readZipDirectory(file.fd, size);
    const directory = new Map(entries.map(entry => [entry.key, entry]));
    if (directory.size !== entries.length) throw new Error('A backup archive has duplicate entries.');
    function range(entry) {
      if (!entry || entry.isDirectory || entry.flags & 1 || ![0, 8].includes(entry.method)) throw new Error('Unsupported ZIP entry.');
      return zipEntryDataRange(file.fd, entry, size);
    }
    function json(key, max = maxDescriptorSize) {
      const entry = directory.get(key), { start } = range(entry);
      if (entry.size > max || entry.compressedSize > max) throw new Error('Backup descriptor is too large.');
      const bytes = readArchiveBytes(file.fd, start, entry.compressedSize, size);
      const body = entry.method === 8 ? inflateRawSync(bytes, { maxOutputLength: max }) : bytes;
      if (body.length !== entry.size) throw new Error('Incomplete backup descriptor.');
      return JSON.parse(body.toString('utf8'));
    }
    function stream(entry) {
      const { start, end } = range(entry);
      async function* compressed() {
        for (let offset = start; offset <= end;) {
          const chunk = Buffer.allocUnsafe(Math.min(65536, end - offset + 1));
          const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
          if (!bytesRead) throw new Error('Incomplete backup payload.');
          offset += bytesRead;
          yield chunk.subarray(0, bytesRead);
        }
      }
      const source = Readable.from(compressed());
      return entry.method === 8 ? source.compose(createInflateRaw()) : source;
    }
    return await operation({ directory, json, stream });
  } finally { await file.close(); }
}

export function publicManifest(filename, value) {
  const { DateCreated, ServerVersion, BackupEngineVersion, Options } = value;
  if (!Number.isFinite(Date.parse(DateCreated)) || typeof ServerVersion !== 'string' || typeof BackupEngineVersion !== 'string'
    || !Options || ['Database', 'Metadata', 'Subtitles', 'Trickplay'].some(key => typeof Options[key] !== 'boolean')) {
    throw new Error('Invalid backup manifest.');
  }
  return { Path: filename, DateCreated, ServerVersion, BackupEngineVersion, Options };
}

async function copyAndHash(input, destination, limit) {
  const hash = createHash('sha256');
  let size = 0;
  async function* checked() {
    for await (const chunk of input) {
      size += chunk.length;
      if (size > limit) throw new Error('Backup payload exceeds its declared size.');
      hash.update(chunk);
      yield chunk;
    }
  }
  if (destination) await pipeline(checked(), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  else for await (const _ of checked()) { /* consume for validation */ }
  return { size, sha256: hash.digest('hex') };
}

export const payloadPath = (stage, index) => path.join(stage, String(index));

export async function writeBackupArchive(filename, stage, manifest, descriptor, capture) {
  const files = [];
  await capture(async (key, stream, attributes) => {
    const digest = await copyAndHash(stream, payloadPath(stage, files.length), Number.MAX_SAFE_INTEGER);
    files.push({ key, ...digest, ...attributes });
    return digest.size;
  });
  const index = Buffer.from(JSON.stringify({ ...descriptor, files }));
  if (index.length > maxDescriptorSize) throw new Error('Backup inventory is too large.');
  const zip = new yazl.ZipFile();
  zip.on('error', error => zip.outputStream.destroy(error));
  for (const [i, file] of files.entries()) zip.addFile(payloadPath(stage, i), file.key);
  zip.addBuffer(index, 'mediamanager.json');
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json');
  const saved = pipeline(zip.outputStream, createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
  zip.end();
  await saved;
}

export async function stageBackupArchive(archive, stage, files) {
  if (archive.directory.size !== files.length + 2) throw new Error('Backup inventory does not match the ZIP directory.');
  for (const [i, file] of files.entries()) {
    const entry = archive.directory.get(file.key);
    if (!entry || entry.size !== file.size) throw new Error('Backup payload is missing or has changed size.');
    await verifyPayload(archive.stream(entry), file, payloadPath(stage, i));
  }
}

async function verifyPayload(stream, file, destination) {
  const { size, sha256 } = await copyAndHash(stream, destination, file.size);
  if (size !== file.size || sha256 !== file.sha256) throw new Error('Backup payload integrity check failed.');
}

export function verifyStagedPayload(filename, file) {
  return verifyPayload(createReadStream(filename), file);
}
