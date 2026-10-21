import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes, nativeTextBytes } from '../database/native-text.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { loadPostgresRowsByIds } from './postgres-library-query.js';
import { releasePostgresSearchCollation, resolvePostgresSearchCollation } from './postgres-search-provider.js';
import { idKey } from './records.js';

function table(database, name) {
  if (database?.dialect !== 'postgres') throw new TypeError('Recording queries require PostgreSQL.');
  return `${q(database.schemaName)}.${q(name)}`;
}

/** FindByPath selects one newest folder for each exact repository path. */
export async function queryPostgresRecordingFolderSources(database, paths) {
  if (!Array.isArray(paths) || paths.some(value => typeof value !== 'string')) {
    throw new TypeError('Recording-folder paths must be strings.');
  }
  if (!paths.length) return [];
  const values = [];
  const plans = paths.map((identity, ordinal) => {
    const plan = buildPostgresItemPageQuery(database, { isfolder: true, sortby: ['DateCreated'], sortorder: ['Descending'], limit: 1 }, {
      itemIdsPlan: { text: `SELECT "Id" FROM ${table(database, 'BaseItems')} WHERE "Path" = $1`, values: [nativeTextBytes(identity)] },
    });
    const text = plan.text.replace(/\$(\d+)/gu, (_match, index) => `$${Number(index) + values.length}`);
    values.push(...plan.values);
    return `SELECT selected."Id", ${ordinal} AS ordinal FROM (${text}) selected WHERE selected."Id" IS NOT NULL`;
  });
  const result = await database.client.query({ text: `SELECT "Id" FROM (${plans.join(' UNION ALL ')}) matched ORDER BY ordinal`, values });
  const ids = result.rows.map(row => decodeNativeTextBytes(row.Id));
  const rows = new Map((await loadPostgresRowsByIds(database, ids)).map(row => [idKey(row.Id), row]));
  return ids.map(id => rows.get(idKey(id))).filter(Boolean);
}

/** Native Enumerable.OrderBy uses culture comparison and preserves equal-key order. */
export async function orderPostgresRecordingFolders(database, folders, { culture = 'en-US' } = {}) {
  if (!folders.length) return [];
  let collation, failure;
  try {
    collation = await resolvePostgresSearchCollation(database, culture);
    const sql = nativeTextSql(database.schemaName);
    const sortKey = `replace(replace(${sql.projection('requested."SortName"')}, chr(1) || '0', ''), chr(1) || '1', '')`;
    const result = await database.client.query({ text: `SELECT requested.ordinal FROM
      unnest($1::bytea[]) WITH ORDINALITY requested("SortName", ordinal)
      ORDER BY ${sortKey} COLLATE ${q(collation.schema)}.${q(collation.name)}
        ASC NULLS FIRST, requested.ordinal`, values: [folders.map(folder => folder.SortName == null ? null : nativeTextBytes(folder.SortName))] });
    return result.rows.map(row => folders[Number(row.ordinal) - 1]);
  } catch (error) { failure = error; throw error; }
  finally { await releasePostgresSearchCollation(collation, failure); }
}

/** Existing recordings retain repository filtering, offset, count and paging. */
export async function createPostgresRecordingQuery(database, input, { folderIds, userId, visibility } = {}) {
  if (!Array.isArray(folderIds) || folderIds.some(id => typeof id !== 'string')) {
    throw new TypeError('Recording queries require folder identifiers.');
  }
  const include = [], exclude = [], genres = [];
  for (const [name, type] of [['ismovie', 'Movie'], ['isseries', 'Episode']]) {
    if (input[name] === true) include.push(type);
    else if (input[name] === false) exclude.push(type);
  }
  if (input.issports === true) genres.push('Sports');
  if (input.iskids === true) genres.push('Kids', 'Children', 'Family');
  const query = { mediatypes: ['Video'], isfolder: false, ismissing: false,
    includeitemtypes: include, excludeitemtypes: exclude, genres,
    startindex: Math.max(0, input.startindex ?? 0), limit: input.isinprogress === true ? undefined : input.limit,
    sortby: ['DateCreated'], sortorder: ['Descending'], enabletotalrecordcount: input.enabletotalrecordcount };
  const options = { scope: { ancestorIds: folderIds }, userId, visibility, includeOrdinal: true,
    groupByPresentationKey: Boolean(userId) };
  const source = buildPostgresItemPageQuery(database, query, options);
  const sql = nativeTextSql(database.schemaName);
  const values = [...source.values];
  let incomplete = '';
  if (input.isinprogress === true) {
    // Apply IsCompleteMedia after the repository offset. Built-in recording
    // execution is absent; external Channel livestreams remain incomplete.
    values.push(nativeTextBytes('livestream'));
    incomplete = `WHERE substring(${sql.projection('item."Type"')} from '[^.]+$') IN ('Video', 'Movie', 'Episode', 'MusicVideo', 'Trailer')
        AND COALESCE(${sql.guidKey('item."ChannelId"')}, '') NOT IN ('', '${'0'.repeat(32)}')
        AND EXISTS (SELECT 1 FROM unnest(string_to_array(${sql.projection('item."Tags"')}, '|')) tag(value)
          WHERE ${sql.ordinalIgnoreCaseKey(sql.fromProjection('tag.value'))} = ${sql.ordinalIgnoreCaseKey('$' + values.length + '::bytea')})`;
  }
  const name = 'mm_recordings_' + randomUUID().replaceAll('-', '');
  const captured = `${q('pg_temp')}.${q(name)}`;
  let closing, creationAttempted = false;
  const close = primaryError => closing ??= (async () => {
    if (!creationAttempted) return;
    try { await database.client.query(`DROP TABLE IF EXISTS ${captured}`); }
    catch (error) {
      if (primaryError && database.inTransaction && error.code === '25P02') return;
      database.discardConnection(error);
      if (primaryError) throw new AggregateError([primaryError, error], primaryError.message, { cause: primaryError });
      throw error;
    }
  })();
  try {
    creationAttempted = true;
    // The materialized snapshot fixes identities, order and row values across
    // bounded DTO batches, including concurrent library mutations.
    await database.client.query({ text: `CREATE TEMP TABLE ${q(name)} AS
      WITH source AS (${source.text})
      SELECT item.*, source."__ordinal", source."TotalRecordCount" AS "__native_count"
      FROM source LEFT JOIN ${table(database, 'BaseItems')} item ON item."Id" = source."Id" ${incomplete}`, values });
    const counts = (await database.client.query(`SELECT count("Id")::bigint AS selected,
      COALESCE(max("__native_count"), 0)::bigint AS native FROM ${captured}`)).rows[0];
    const total = Number(input.isinprogress === true || input.enabletotalrecordcount === false ? counts.selected : counts.native);
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('PostgreSQL returned an invalid recording count.');
    const startIndex = input.startindex ?? 0, columns = tableDefinition('BaseItems').columns;
    return Object.freeze({ total, startIndex, plan: source, close,
      page: async ({ offset = 0, limit = 128 } = {}) => {
        if (closing) throw new Error('Recording query is closed.');
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
          throw new TypeError('Recording query pages require a nonnegative offset and at most 128 rows.');
        }
        const result = await database.client.query({ text: `SELECT ${columns.map(column => q(column.name)).join(', ')}
          FROM ${captured} WHERE "Id" IS NOT NULL ORDER BY "__ordinal" OFFSET $1 LIMIT $2`, values: [offset, limit] });
        return { rows: result.rows.map(row => Object.fromEntries(columns.map(column => [column.name, decodeValue(column, row[column.name])]))),
          total, startIndex };
      },
    });
  } catch (error) {
    try { await close(error); }
    catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
    throw error;
  }
}
