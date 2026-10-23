import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from './model.js';
import { indexLiveTvDocument, liveTvStateKey } from '../library/live-tv-state.js';

const liveTvFiles = [['timers', 'timers.json'], ['seriesTimers', 'seriestimers.json']];

function authoritativeSource(persisted, kind, filename) {
  const sourceHex = persisted?.[kind]?.sourceHex, expectedHash = persisted?.[kind]?.sourceSha256;
  if (sourceHex === null && expectedHash === null) return null;
  if (typeof sourceHex !== 'string' || !/^([a-f0-9]{2})*$/u.test(sourceHex)
    || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
    throw new Error(`The authoritative Live TV state for '${filename}' is invalid.`);
  }
  const bytes = Buffer.from(sourceHex, 'hex');
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
    throw new Error(`The authoritative Live TV state hash for '${filename}' is invalid.`);
  }
  return bytes;
}

/** Project PostgreSQL-owned Live TV source bytes with per-file atomic replacement. */
export async function reconcileLiveTvStateFiles(persisted, { dataPath, fileSystem = fs } = {}) {
  if (!dataPath) throw new TypeError('Live TV state reconciliation requires a native data path.');
  const directory = path.join(dataPath, 'livetv');
  await fileSystem.mkdir(directory, { recursive: true });
  for (const [kind, filename] of liveTvFiles) {
    const target = path.join(directory, filename), bytes = authoritativeSource(persisted, kind, filename);
    if (bytes === null) {
      await fileSystem.rm(target, { force: true });
      continue;
    }
    let current;
    try { current = await fileSystem.readFile(target); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    if (current?.equals(bytes)) continue;
    const temporary = path.join(directory, `.${filename}.${randomUUID()}.tmp`);
    try {
      await fileSystem.writeFile(temporary, bytes, { flag: 'wx' });
      await fileSystem.rename(temporary, target);
    } finally { await fileSystem.rm(temporary, { force: true }); }
  }
}

/** One explicit native-state import per PostgreSQL database, never a query fallback. */
export async function initializeLiveTvState(database, { dataPath, logger } = {}) {
  if (!dataPath) return false;
  const state = `${q(database.controlSchema)}.state`;
  const existing = await database.client.query({ text: `SELECT value FROM ${state} WHERE key = $1`, values: [liveTvStateKey] });
  if (existing.rows.length) {
    // Once imported, PostgreSQL owns these documents and the native files are
    // its exchange projection. Re-publish that projection after an interrupted
    // cross-resource mutation. A takeover/reimport uses a fresh database (or
    // explicitly removes this state key), so its native edits still import.
    let persisted;
    try { persisted = JSON.parse(existing.rows[0].value); }
    catch (error) { throw new Error('The authoritative Live TV state is invalid.', { cause: error }); }
    await reconcileLiveTvStateFiles(persisted, { dataPath });
    return false;
  }
  const documents = {};
  for (const [kind, filename] of liveTvFiles) {
    let source;
    try { source = await fs.readFile(path.join(dataPath, 'livetv', filename)); }
    catch (error) { if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw error; }
    const imported = source ? indexLiveTvDocument(kind, source) : { rows: [], issue: null };
    documents[kind] = { ...imported, sourceHex: source ? source.toString('hex') : null,
      sourceSha256: source ? createHash('sha256').update(source).digest('hex') : null };
    if (imported.issue) logger?.error?.(new Error(`Could not deserialize Live TV state '${filename}'.`));
  }
  await database.client.query({ text: `INSERT INTO ${state} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    values: [liveTvStateKey, JSON.stringify(documents)] });
  return true;
}
