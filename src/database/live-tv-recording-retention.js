import { quoteIdentifier as q } from './model.js';
import { liveTvStateKey, recordingRetentionKey } from '../library/live-tv-state.js';

export const recordingRetentionVersion = 1;
const stateTable = database => `${q(database.controlSchema)}.state`;
const prefix = kind => `liveTvRecordingRetention:${kind}:`;

/** Update the per-series projections in the same transaction as the native document. */
export async function refreshRecordingRetention(database, kinds) {
  const table = stateTable(database);
  for (const kind of kinds) {
    const select = kind === 'seriesTimers'
      ? `SELECT DISTINCT ON (key) key, (value->'dto'->'KeepUpTo')::text AS value FROM entries ORDER BY key, ordinal`
      : `SELECT key, jsonb_agg(jsonb_build_array(value->>'id', value->>'recordingPath', value->>'recordingEndTicks')
          ORDER BY ordinal)::text AS value FROM entries GROUP BY key`;
    await database.client.query({ text: `/* live-tv-recording-retention-refresh */
      WITH entries AS (
        SELECT $2::text || (entry.value->>'retentionKey') AS key, entry.value, entry.ordinal
        FROM ${table} source, jsonb_array_elements(source.value::jsonb->($3::text)->'rows') WITH ORDINALITY entry(value, ordinal)
        WHERE source.key=$1 AND entry.value->>'retentionKey' IS NOT NULL
      ), projection AS MATERIALIZED (${select}), removed AS (
        DELETE FROM ${table} existing WHERE left(existing.key, length($2))=$2
        AND NOT EXISTS (SELECT 1 FROM projection WHERE projection.key=existing.key)
      )
      INSERT INTO ${table} AS existing (key,value) SELECT key,value FROM projection
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value WHERE existing.value IS DISTINCT FROM EXCLUDED.value`,
    values: [liveTvStateKey, prefix(kind), kind] });
  }
}

export async function readRecordingKeepUpTo(database, seriesId) {
  const { rows } = await database.client.query({ text: `/* live-tv-recording-retention-rule */
    SELECT value::integer AS keep FROM ${stateTable(database)} WHERE key=$1`,
  values: [prefix('seriesTimers') + recordingRetentionKey(seriesId)] });
  return rows[0]?.keep ?? 0;
}

export function recordingRetentionPlan(database, seriesId) {
  return { text: `/* live-tv-recording-retention-order */
    SELECT entry.value->>0 AS "Id", entry.value->>1 AS "RecordingPath"
    FROM ${stateTable(database)} source, jsonb_array_elements(source.value::jsonb) WITH ORDINALITY entry(value, ordinal)
    WHERE source.key=$1 ORDER BY (entry.value->>2)::bigint DESC, entry.ordinal`,
  values: [prefix('timers') + recordingRetentionKey(seriesId)], limit: -1, startIndex: 0 };
}
