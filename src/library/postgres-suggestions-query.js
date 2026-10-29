import { randomUUID } from 'node:crypto';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { decodeNativeTextBytes, nativeTextBytes } from '../database/native-text.js';
import { quoteIdentifier as q } from '../database/model.js';
import { withPostgresNativeQueryJitOff } from '../database/postgres-native-query-jit.js';
import { nativeItemTypes } from './native-item-entity.js';

const count = value => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid suggestion count.');
  return result;
};

export function suggestionFailure(reasons) {
  if (reasons.length === 1) return reasons[0];
  const primary = reasons[0];
  let message = 'Suggestion query cleanup failed.';
  try { if (primary instanceof Error && typeof primary.message === 'string') message = primary.message; } catch { /* Keep the actual reason. */ }
  const failure = new AggregateError(reasons, message, { cause: primary });
  for (const key of ['code', 'status', 'statusCode']) {
    try { if (primary != null && Object.hasOwn(primary, key)) failure[key] = primary[key]; } catch { /* Diagnostic getters are optional. */ }
  }
  return failure;
}

/** Freeze one repository random permutation in SQL. Repeated bounded reads
 * consume that same result, including when the public Limit is unbounded. */
export async function createPostgresSuggestionsQuery(database, input = {}, { userId, visibility, signal } = {}) {
  if (database?.dialect !== 'postgres' || !database.connectionSession) {
    throw new TypeError('Suggestions require a checked-out PostgreSQL session.');
  }
  const startIndex = input.startIndex ?? 0, limit = input.limit;
  if (!Number.isInteger(startIndex) || limit != null && !Number.isInteger(limit)) throw new TypeError('Suggestion paging requires nullable integers.');
  const types = input.itemTypes ?? [];
  const grouped = Boolean(userId && (!types.length || types.some(type =>
    ['Episode', 'Video', 'Movie', 'MusicVideo', 'Series', 'Season'].includes(type))));
  const plan = buildPostgresItemPageQuery(database, {
    includeitemtypes: types, mediatypes: input.mediaTypes ?? [], ismissing: false,
  }, { userId, visibility, groupByPresentationKey: grouped, includePlaceholderRows: true });
  const source = q('mm_suggestions_' + randomUUID().replaceAll('-', ''));
  let attempted = false, closing;
  const close = ({ failed = false } = {}) => closing ??= (async () => {
    if (!attempted) return;
    try { await database.client.query(`/* suggestions-release */ DROP TABLE IF EXISTS ${source}`); }
    catch (reason) {
      if (failed && database.inTransaction && reason?.code === '25P02') return;
      database.discardConnection(reason); throw reason;
    }
  })();
  try {
    signal?.throwIfAborted(); attempted = true;
    await withPostgresNativeQueryJitOff(database, db => db.client.query({
      text: `/* suggestions-freeze */ CREATE TEMP TABLE ${source} AS
        SELECT candidate."Id", item."Type"=ANY($${plan.values.length + 1}::bytea[]) AS resolvable,
          row_number() OVER (ORDER BY random() DESC) AS ordinal
        FROM (${plan.text}) candidate JOIN ${q(database.schemaName)}."BaseItems" item ON item."Id"=candidate."Id"
        WHERE candidate."Id" IS NOT NULL`, values: [...plan.values, nativeItemTypes.map(nativeTextBytes)], signal,
    }));
    await database.client.query(`CREATE UNIQUE INDEX ON ${source}(ordinal)`);
    const skip = Math.max(0, startIndex), take = limit == null || limit < 0 ? null : limit;
    const summary = (await database.client.query({ text: `/* suggestions-count */
      SELECT count(*) AS total, count(*) FILTER (WHERE resolvable AND ordinal>$1 AND ($2::bigint IS NULL OR ordinal<=$1+$2)) AS selected
      FROM ${source}`, values: [skip, take], signal })).rows[0];
    // GetItems skips SQL COUNT for an unpaged request, even when enabled.
    // GetItemList drops unresolved rows before its count, while a paged enabled
    // count includes every matching repository row before deserialization.
    const countBeforeHydration = input.enableTotalRecordCount === true && (limit != null || startIndex !== 0);
    return Object.freeze({ startIndex, total: count(countBeforeHydration ? summary.total : summary.selected), close,
      async page(offset = 0) {
        if (closing) throw new Error('The suggestion query is closed.');
        if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Suggestion page offsets must be nonnegative integers.');
        signal?.throwIfAborted();
        const size = take == null ? 128 : Math.min(128, Math.max(0, take - offset));
        if (!size) return [];
        return (await database.client.query({ text: `/* suggestions-page */ SELECT "Id" FROM ${source}
          WHERE ordinal>$1 ORDER BY ordinal LIMIT $2`, values: [skip + offset, size], signal })).rows
          .map(row => decodeNativeTextBytes(row.Id));
      },
    });
  } catch (reason) {
    try { await close({ failed: true }); } catch (cleanup) { throw suggestionFailure([reason, cleanup]); }
    throw reason;
  }
}
