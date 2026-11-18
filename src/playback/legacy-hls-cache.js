import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { operationFailure } from '../core/operation-failure.js';
import { checkAbort } from '../storage/errors.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { resolveRange, singleRange } from '../storage/range.js';

const fileFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
const missing = error => ['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG'].includes(error?.code);
const unavailable = () => Object.assign(new Error('The cached HLS artifact was not found.'), { status: 404 });

export async function existingHlsCacheDirectory(directory) {
  if (!directory) return null;
  try { return await realpath(directory); }
  catch (error) { if (missing(error)) return null; throw error; }
}

export async function hasLegacyHlsPlaylist(directory, playlistId, extension, signal) {
  if (!directory) return false;
  const key = ordinalIgnoreCaseKey(playlistId);
  const extensions = [ordinalIgnoreCaseKey(extension), ordinalIgnoreCaseKey('.m3u8')];
  try {
    for await (const entry of await opendir(directory)) {
      checkAbort(signal);
      if (entry.isFile() && extensions.includes(ordinalIgnoreCaseKey(path.extname(entry.name)))
        && ordinalIgnoreCaseKey(entry.name).includes(key)) return true;
    }
  } catch (error) { if (!missing(error)) throw error; }
  return false;
}

function readWindow(rangeHeader, ifRange, modified, size) {
  if (ifRange != null && !(Date.parse(ifRange) >= Math.floor(modified.valueOf() / 1000) * 1000)) return {};
  let range;
  try { range = singleRange(rangeHeader); }
  catch (error) {
    if (/^bytes\s*=\s*-0\s*$/iu.test(rangeHeader ?? '')) return { unsatisfied: true };
    if (!['not-supported', 'range-not-satisfiable'].includes(error.code)) throw error;
  }
  if (!range) return {};
  try { return { window: resolveRange(range, size) }; }
  catch (error) { if (error.code === 'range-not-satisfiable') return { unsatisfied: true }; throw error; }
}

async function* readBytes(handle, position, length, signal) {
  while (length > 0n) {
    checkAbort(signal);
    const buffer = Buffer.allocUnsafe(Number(length > 65536n ? 65536n : length));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    position += BigInt(bytesRead);
    length -= BigInt(bytesRead);
    yield buffer.subarray(0, bytesRead);
  }
}

export async function openLegacyHlsArtifact(directory, name, { rangeHeader, ifRange, signal }) {
  if (!directory) throw unavailable();
  checkAbort(signal);
  const filename = path.join(directory, name);
  let handle;
  try {
    const entry = await lstat(filename, { bigint: true });
    if (!entry.isFile()) throw unavailable();
    handle = await open(filename, fileFlags);
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino) throw unavailable();
    const modified = new Date(Number(info.mtimeMs));
    const { window, unsatisfied } = readWindow(rangeHeader, ifRange, modified, info.size);
    const length = unsatisfied ? 0n : window ? window.end - window.start + 1n : info.size;
    const headers = { 'Accept-Ranges': 'bytes', 'Content-Length': String(length) };
    if (unsatisfied) headers['Content-Range'] = `bytes */${info.size}`;
    if (window) headers['Content-Range'] = `bytes ${window.start}-${window.end}/${info.size}`;
    return { statusCode: unsatisfied ? 416 : window ? 206 : 200, modified: modified.toISOString(), headers,
      contentLength: length, stream: readBytes(handle, window?.start ?? 0n, length, signal), close: () => handle.close() };
  } catch (error) {
    const faults = [missing(error) ? unavailable() : error];
    try { await handle?.close(); } catch (error) { faults.push(error); }
    throw operationFailure(faults, 'Cached HLS file open and cleanup failed.');
  }
}
