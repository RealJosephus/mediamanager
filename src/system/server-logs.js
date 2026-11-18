import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { operationFailure } from '../core/operation-failure.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { nativeDateFromUnixNanoseconds } from '../users/native.js';

const missing = error => ['ENOENT', 'ENOTDIR'].includes(error?.code);
const fileEntry = entry => entry.isFile() || entry.isSymbolicLink();

async function entries(directory) {
  if (!directory) return [];
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (missing(error) || ['EACCES', 'EPERM'].includes(error.code)) return [];
    throw error;
  }
}

export async function getServerLogs(directory, culture, signal) {
  const result = [];
  for (const entry of await entries(directory)) {
    signal?.throwIfAborted();
    if (!fileEntry(entry) || !/\.(?:txt|log)$/iu.test(entry.name)) continue;
    let info;
    try { info = await stat(path.join(directory, entry.name), { bigint: true }); }
    catch (error) { if (missing(error)) continue; throw error; }
    if (!info.isFile()) continue;
    const created = process.platform === 'linux' ? (info.mtimeNs < info.ctimeNs ? info.mtimeNs : info.ctimeNs) : info.birthtimeNs;
    result.push({ Name: entry.name, Size: info.size, DateCreated: nativeDateFromUnixNanoseconds(created),
      DateModified: nativeDateFromUnixNanoseconds(info.mtimeNs) });
  }
  const compare = new Intl.Collator(culture).compare;
  return result.sort((a, b) => b.DateModified.localeCompare(a.DateModified, 'en')
    || b.DateCreated.localeCompare(a.DateCreated, 'en') || compare(a.Name, b.Name));
}

export async function findServerLog(directory, name) {
  for (const entry of await entries(directory)) {
    if (!fileEntry(entry) || !ordinalIgnoreCaseEquals(entry.name, name)) continue;
    const filename = path.join(directory, entry.name);
    try { if ((await stat(filename)).isFile()) return filename; }
    catch (error) { if (!missing(error)) throw error; }
  }
  return null;
}

export async function openServerLog(filename, { signal } = {}) {
  const faults = [];
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw Object.assign(new Error('Log file not found.'), { status: 404 });
    const stream = async function* () {
      let remaining = info.size;
      while (remaining > 0n) {
        signal?.throwIfAborted();
        const buffer = Buffer.allocUnsafe(Number(remaining > 65536n ? 65536n : remaining));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        remaining -= BigInt(bytesRead);
        yield buffer.subarray(0, bytesRead);
      }
    };
    return { statusCode: 200, headers: { 'Content-Length': String(info.size) },
      contentLength: info.size, stream: stream(), close: () => handle.close() };
  } catch (error) {
    faults.push(missing(error) ? Object.assign(error, { status: 404 }) : Object.assign(error, { status: error.status ?? 500 }));
  }
  try { await handle?.close(); } catch (error) { faults.push(error); }
  throw operationFailure(faults, 'Server log open and cleanup failed.');
}
