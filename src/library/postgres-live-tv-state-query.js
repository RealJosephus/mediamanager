import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes, nativeTextBytes } from '../database/native-text.js';
import { md5Guid, lowerInvariant } from '../core/identity.js';
import { idKey, libraryError } from './records.js';
import { liveTvStateKey } from './live-tv-state.js';
import { resolvePostgresSearchCollation, releasePostgresSearchCollation } from './postgres-search-provider.js';

const internalId = value => md5Guid(lowerInvariant('Emby' + (value ?? '') + '4'));
const string = value => value == null ? null : decodeNativeTextBytes(Buffer.from(value, 'hex'));

/** Resolve only the DTO page. Timer matching and stable winners stay in SQL. */
export async function queryPostgresProgramRecordingInfo(database, ids) {
  if (!ids.length) return new Map();
  const state = `${q(database.controlSchema)}.state`, items = `${q(database.schemaName)}.${q('BaseItems')}`;
  const sql = nativeTextSql(database.schemaName);
  const metadata = (await database.client.query({ text: `SELECT
      jsonb_array_length(value::jsonb->'timers'->'rows') AS timers,
      jsonb_array_length(value::jsonb->'seriesTimers'->'rows') AS series
    FROM ${state} WHERE key = $1`, values: [liveTvStateKey] })).rows[0];
  if (!metadata || !Number(metadata.timers) && !Number(metadata.series)) return new Map();
  let collation, primaryError;
  try {
    if (Number(metadata.series)) collation = await resolvePostgresSearchCollation(database, 'und', { numeric: true });
    const hex = name => `decode(entry.value->>'${name}', 'hex')`;
    const same = (left, right) => `${sql.ordinalIgnoreCaseKey(left)} IS NOT DISTINCT FROM ${sql.ordinalIgnoreCaseKey(right)}`;
    // PostgreSQL text cannot contain NUL. Its projection distinguishes NUL and
    // SOH; both are culturally ignorable in the native invariant name comparer.
    const name = `replace(replace(${sql.projection(hex('name'))}, chr(1) || '0', ''), chr(1) || '1', '')`;
    const seriesOrder = collation ? `${name} COLLATE ${q(collation.schema)}.${q(collation.name)} ASC NULLS FIRST,` : '';
    const result = await database.client.query({ text: `WITH document AS (
        SELECT value::jsonb AS value FROM ${state} WHERE key = $1
      ), timers AS (
        SELECT entry.value, entry.ordinal FROM document,
          jsonb_array_elements(document.value->'timers'->'rows') WITH ORDINALITY entry(value, ordinal)
      ), series AS (
        SELECT entry.value, entry.ordinal FROM document,
          jsonb_array_elements(document.value->'seriesTimers'->'rows') WITH ORDINALITY entry(value, ordinal)
      ), requested AS (
        SELECT item.* FROM ${items} item WHERE ${sql.guidKey('item."Id"')} = ANY($2::text[])
      ), matched AS (
        SELECT item."Id", item."ExternalSeriesId", timer.value AS timer,
          decode(timer.value->>'seriesTimerId', 'hex') IS NOT NULL
            AND decode(timer.value->>'seriesTimerId', 'hex') <> ''::bytea AS has_series
        FROM requested item LEFT JOIN LATERAL (
          SELECT entry.value FROM timers entry
          WHERE entry.value->>'status' <> 'Completed' AND ${same(hex('programId'), 'item."ExternalId"')}
          ORDER BY entry.value->>'startDate' COLLATE "C", entry.ordinal LIMIT 1
        ) timer ON TRUE
      ) SELECT matched."Id", matched.timer->>'id' AS timer_id, matched.timer->>'status' AS status,
        CASE WHEN matched.has_series THEN matched.timer->>'seriesTimerId' ELSE fallback.value->>'id' END AS series_id,
        COALESCE(matched.has_series, FALSE) OR fallback.value IS NOT NULL AS has_series_match,
        EXISTS (SELECT 1 FROM timers WHERE value = 'null'::jsonb) AS timer_fault,
        NOT COALESCE(matched.has_series, FALSE)
          AND length(btrim(${sql.projection('matched."ExternalSeriesId"')}, $3)) > 0
          AND EXISTS (SELECT 1 FROM series WHERE value = 'null'::jsonb) AS series_fault
      FROM matched LEFT JOIN LATERAL (
        SELECT entry.value FROM series entry
        WHERE NOT COALESCE(matched.has_series, FALSE)
          AND length(btrim(${sql.projection('matched."ExternalSeriesId"')}, $3)) > 0
          AND ${same(hex('seriesId'), 'matched."ExternalSeriesId"')}
        ORDER BY ${seriesOrder} entry.ordinal LIMIT 1
      ) fallback ON TRUE`, values: [liveTvStateKey, ids.map(idKey),
        '\u0009\u000a\u000b\u000c\u000d \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000'] });
    if (result.rows.some(row => row.timer_fault || row.series_fault)) throw libraryError(500, 'Invalid null Live TV state entry.');
    return new Map(result.rows.map(row => {
      const info = {};
      if (row.status != null && !['Cancelled', 'Error'].includes(row.status)) {
        info.TimerId = internalId(string(row.timer_id)); info.Status = row.status;
      }
      if (row.has_series_match) info.SeriesTimerId = internalId(string(row.series_id));
      return [idKey(decodeNativeTextBytes(row.Id)), info];
    }));
  } catch (error) { primaryError = error; throw error; }
  finally { await releasePostgresSearchCollation(collation, primaryError); }
}
