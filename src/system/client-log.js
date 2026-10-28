import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { nativeFileName } from '../library/native-path.js';

export const maximumClientLogBytes = 1_000_000;
const leaf = value => {
  if (value == null || value === '') return null;
  const name = nativeFileName(value, { windows: process.platform === 'win32' });
  return !name || name === '.' || name === '..' ? null : name;
};
const statusError = (status, message) => Object.assign(new Error(message), { status });

/** Logs are instance infrastructure, independent of media/metadata mounts. */
export async function writeClientLog({ directory, clientName, clientVersion, source }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw statusError(503, 'Client log storage is unavailable.');
  const client = leaf(clientName) ?? 'unknown-client', version = leaf(clientVersion) ?? 'unknown-version';
  const timestamp = new Date().toISOString().replace(/\D/gu, '').slice(0, 14);
  const filename = `upload_${client}_${version}_${timestamp}_${randomUUID().replaceAll('-', '')}.log`;
  if (filename.includes('\0')) throw statusError(400, 'The client log filename contains a null character.');
  const destination = path.join(directory, filename), relative = path.relative(directory, destination);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw statusError(400, 'The client log filename is outside its log directory.');
  }
  let file;
  try { file = await open(destination, 'wx'); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') error.status = 404;
    throw error;
  }
  let primary, failed = false, bytes = 0;
  try {
    for await (const chunk of source) {
      bytes += chunk.length;
      // Like the native request-body limit, this fails while copying and
      // retains only bytes which were actually written before the failure.
      if (bytes > maximumClientLogBytes) throw new Error('The client log request body exceeds its configured limit.');
      await file.writeFile(chunk);
    }
  } catch (error) { primary = error; failed = true; }
  try { await file.close(); }
  catch (error) {
    if (!failed) throw error;
    const failure = new AggregateError([primary, error], 'Client log upload and file close failed.', { cause: primary });
    for (const name of ['code', 'status', 'statusCode']) {
      try { if (primary != null && Object.hasOwn(primary, name)) failure[name] = primary[name]; } catch { /* Preserve both original reasons. */ }
    }
    throw failure;
  }
  if (failed) throw primary;
  return filename;
}
