import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { quoteIdentifier as q } from '../database/model.js';
import { postgresCleanValueFunctionName } from '../database/postgres-runtime-schema.js';

/** Select the native batch-lookup winner for each relational name. Callers
 * freeze this query in PostgreSQL before starting refresh side effects. */
export function buildPostgresArtistBatchLookupQuery(database, names) {
  if (!names || typeof names.text !== 'string' || !names.text.trim() || !Array.isArray(names.values)) {
    throw new TypeError('Artist batch lookup requires a relational name query.');
  }
  const items = `${q(database.schemaName)}.${q('BaseItems')}`;
  const sequence = `${q(database.controlSchema)}.${q('item_order')}`;
  const clean = `${q(database.schemaName)}.${q(postgresCleanValueFunctionName)}`;
  return { text: `/* artist-batch-lookup */
    SELECT requested."Ordinal" AS "__ordinal", requested."Name" AS "__name", selected.*
    FROM (${names.text}) requested LEFT JOIN LATERAL (
      SELECT artist.* FROM ${items} artist JOIN ${sequence} sequence ON sequence.item_id = artist."Id"
      WHERE artist."Type" = 'MediaBrowser.Controller.Entities.Audio.MusicArtist'
        AND artist."CleanName" = ${clean}(requested."Name")
      ORDER BY (artist."ParentId" IS NULL OR ${nativeTextSql(database.schemaName).guidKey('artist."ParentId"')} = '00000000000000000000000000000000'),
        sequence.position LIMIT 1
    ) selected ON true ORDER BY requested."Ordinal"`, values: names.values };
}
