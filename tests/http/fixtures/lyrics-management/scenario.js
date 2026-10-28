import net from 'node:net';
import path from 'node:path';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { parseLosslessJson } from '../../../../src/core/json.js';
import { projectProblemTrace } from '../../../helpers/http-body-projection.js';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const databaseFilename = root => path.join(root, 'data', 'data', 'jellyfin.db');
export const proxyTarget = filename => {
  const escaped = filename.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/');
  return '/d' + (escaped.startsWith('/') ? escaped : '/' + escaped);
};
export const inputAsset = new URL('../../../playback/fixtures/flac-copy-current/assets/upstream/subset/60%20-%20mono%20audio.flac', import.meta.url);
export const inputSha256 = '20539fbbd6ae28cea2b2182a4c60c6c70cbb710a136199fc83200c4e5fa00b1c';
export async function unusedPort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}
export async function portAvailable(port) {
  const server = net.createServer();
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); return true; }
  catch { return false; }
  finally { if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
export function checkpoint(root) {
  const database = new SqliteDatabase(databaseFilename(root), { requireMigrationHistory: true });
  try { database.database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { database.close(); }
}
export async function bytesAt(filename) {
  try { const bytes = await readFile(filename); return { exists: true, sha256: hash(bytes), base64: bytes.toString('base64') }; }
  catch (error) { if (error.code === 'ENOENT') return { exists: false }; if (error.code === 'EISDIR') return { exists: true, directory: true }; throw error; }
}
export async function resetMedia(root) {
  const bytes = await readFile(inputAsset); if (hash(bytes) !== inputSha256) throw new Error('The original FLAC input changed.');
  await mkdir(root, { recursive: true });
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name), relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The private media reset escaped its root.');
    await rm(target, { recursive: true, force: true });
  }
  for (const name of ['alpha', 'beta']) await writeFile(path.join(root, name + '.flac'), bytes, { flag: 'wx' });
}

export function responseValue(response) {
  let json;
  try { json = parseLosslessJson(response.body); } catch { }
  json = projectProblemTrace(json, response.status);
  return { status: response.status, contentType: response.contentType?.trim() ?? null,
    ...(json === undefined ? { body: response.body } : { json }) };
}
