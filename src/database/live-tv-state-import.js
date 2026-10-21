import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { quoteIdentifier as q } from './model.js';
import { indexLiveTvDocument, liveTvStateKey } from '../library/live-tv-state.js';

/** One explicit native-state import per PostgreSQL database, never a query fallback. */
export async function initializeLiveTvState(database, { dataPath, logger } = {}) {
  if (!dataPath) return false;
  const state = `${q(database.controlSchema)}.state`;
  const existing = await database.client.query({ text: `SELECT 1 FROM ${state} WHERE key = $1`, values: [liveTvStateKey] });
  if (existing.rows.length) return false;
  const documents = {};
  for (const [kind, filename] of [['timers', 'timers.json'], ['seriesTimers', 'seriestimers.json']]) {
    let source;
    try { source = await readFile(path.join(dataPath, 'livetv', filename)); }
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
