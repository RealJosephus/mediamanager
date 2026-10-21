import { quoteIdentifier as q } from '../database/model.js';
import { liveTvStateKey } from '../library/live-tv-state.js';

const documentPaths = ['data/data/livetv/timers.json', 'data/data/livetv/seriestimers.json'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** Capture only bounded exchange metadata in the caller's database snapshot. */
export async function captureLiveTvState(database) {
  if (database.dialect !== 'postgres') return null;
  const result = await database.client.query({ text: `
    WITH saved AS (
      SELECT value::jsonb AS document, encode(sha256(convert_to(value, 'UTF8')), 'hex') AS state_sha256
      FROM ${q(database.controlSchema)}.state WHERE key = $1
    ), documents AS (
      SELECT saved.*, kinds.ordinal, kinds.kind, saved.document -> kinds.kind AS entry
      FROM saved CROSS JOIN (VALUES (0, 'timers'), (1, 'seriesTimers')) AS kinds(ordinal, kind)
    ), sources AS (
      SELECT *, CASE WHEN jsonb_typeof(entry -> 'sourceHex') = 'string'
        AND entry ->> 'sourceHex' ~ '^([0-9a-f]{2})*$'
        THEN decode(entry ->> 'sourceHex', 'hex') END AS source_bytes
      FROM documents
    )
    SELECT state_sha256,
      jsonb_typeof(document) = 'object' AND jsonb_typeof(entry) = 'object'
        AND jsonb_typeof(entry -> 'rows') = 'array'
        AND ((entry -> 'sourceHex' = 'null'::jsonb AND entry -> 'sourceSha256' = 'null'::jsonb)
          OR (source_bytes IS NOT NULL AND jsonb_typeof(entry -> 'sourceSha256') = 'string')) AS valid,
      octet_length(source_bytes) AS bytes, encode(sha256(source_bytes), 'hex') AS sha256,
      entry ->> 'sourceSha256' AS expected_sha256
    FROM sources ORDER BY ordinal`, values: [liveTvStateKey] });
  if (!result.rows.length) return null;
  if (result.rows.length !== documentPaths.length || result.rows.some(row => row.valid !== true
    || !digest(row.state_sha256) || row.sha256 !== row.expected_sha256)) {
    throw new Error('PostgreSQL Live TV state has invalid native exchange documents.');
  }
  return { sha256: result.rows[0].state_sha256, files: result.rows.map((row, index) => ({
    path: documentPaths[index], bytes: row.bytes, sha256: row.sha256,
  })) };
}

/** Native files must represent the PostgreSQL authority before they can be exported. */
export function validateLiveTvState(value, files, dialect) {
  if (value === null) return;
  if (dialect !== 'postgres' || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'files,sha256' || !digest(value.sha256)
    || !Array.isArray(value.files) || value.files.length !== documentPaths.length) {
    throw new Error('State package Live TV source binding is invalid.');
  }
  for (const [index, file] of value.files.entries()) {
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || Object.keys(file).sort().join(',') !== 'bytes,path,sha256' || file.path !== documentPaths[index]
      || (file.bytes === null ? file.sha256 !== null
        : !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !digest(file.sha256))) {
      throw new Error('State package Live TV source binding is invalid.');
    }
    const actual = files.find(entry => entry.path.toLowerCase() === file.path);
    if (file.bytes === null ? actual !== undefined
      : !actual || actual.path !== file.path || actual.bytes !== file.bytes || actual.sha256 !== file.sha256) {
      throw new Error(`State package native file differs from PostgreSQL Live TV state: ${file.path}`);
    }
  }
}
