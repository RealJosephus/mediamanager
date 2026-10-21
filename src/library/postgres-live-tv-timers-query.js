import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { liveTvStateKey } from './live-tv-state.js';
import { libraryError } from './records.js';
import { resolvePostgresSearchCollation, releasePostgresSearchCollation } from './postgres-search-provider.js';

/** SQL owns every timer predicate, stable order, count and result window. */
export async function queryPostgresLiveTvTimerPage(database, kind, query = {}, { offset = 0, limit = 128, id } = {}) {
  if (!['timers', 'seriesTimers'].includes(kind) || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new TypeError('Invalid Live TV timer query.');
  const table = `${q(database.controlSchema)}.state`, sql = nativeTextSql(database.schemaName);
  const values = [liveTvStateKey], bind = value => { values.push(value); return '$' + values.length; };
  const predicates = [], series = kind === 'seriesTimers';
  if (!series) {
    predicates.push("entry.value->>'status' <> 'Completed'");
    if (query.isActive != null) predicates.push(`(entry.value->>'status' = 'InProgress') = ${bind(query.isActive)}::boolean`);
    if (query.isScheduled != null) predicates.push(`(entry.value->>'status' = 'New') = ${bind(query.isScheduled)}::boolean`);
    if (query.channelId != null) predicates.push(`entry.value->>'channelInternalId' = ${bind(query.channelId)}`);
    if (query.seriesTimerId != null) predicates.push(`entry.value->>'seriesTimerInternalId' = ${bind(query.seriesTimerId)}`);
    if (id !== undefined) predicates.push(`lower(entry.value->>'internalId') = lower(${bind(id)}::text)`);
  }
  const requested = series && id !== undefined ? `lower(entry.value->>'internalId') = lower(${bind(id)}::text)` : 'TRUE';
  let collation, primaryError;
  try {
    let order = `entry.value->>'startDate' COLLATE "C" ASC, entry.ordinal`;
    if (series) {
      collation = await resolvePostgresSearchCollation(database, 'und', { numeric: true });
      const name = `replace(replace(${sql.projection("decode(entry.value->>'name', 'hex')")}, chr(1) || '0', ''), chr(1) || '1', '')`;
      const descending = query.sortOrder === 'Descending';
      const byName = `${name} COLLATE ${q(collation.schema)}.${q(collation.name)} ${descending ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`;
      order = `${typeof query.sortBy === 'string' && /^priority$/iu.test(query.sortBy)
        ? `(entry.value->'dto'->>'Priority')::integer ${descending ? 'ASC' : 'DESC'}, ` : ''}${byName}, entry.ordinal`;
    }
    const result = await database.client.query({ text: `/* live-tv-${kind}-page */
      WITH document AS (
        SELECT value::jsonb->'${kind}'->'rows' AS value FROM ${table} WHERE key = $1
      ), entries AS (
        SELECT entry.value, entry.ordinal FROM document,
          jsonb_array_elements(document.value) WITH ORDINALITY entry(value, ordinal)
      ), selected AS (
        SELECT entry.value, ${requested} AS requested,
          row_number() OVER (ORDER BY ${order}) AS ordinal FROM entries entry
        ${predicates.length ? 'WHERE ' + predicates.join(' AND ') : ''}
      ), metadata AS (
        SELECT (SELECT count(*) FROM selected) AS total,
          EXISTS (SELECT 1 FROM entries WHERE value = 'null'::jsonb) AS fault
      ), page AS (
        SELECT * FROM selected ORDER BY ordinal LIMIT ${bind(limit)} OFFSET ${bind(offset)}
      ) SELECT metadata.*, page.value, page.requested FROM metadata LEFT JOIN page ON TRUE ORDER BY page.ordinal`, values });
    const metadata = result.rows[0];
    if (metadata?.fault) throw libraryError(500, 'Invalid null Live TV state entry.');
    const total = Number(metadata?.total ?? 0);
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid Live TV timer count.');
    return { total, rows: result.rows.filter(row => row.value != null).map(row => ({ value: row.value, requested: row.requested })) };
  } catch (error) { primaryError = error; throw error; }
  finally { await releasePostgresSearchCollation(collation, primaryError); }
}
