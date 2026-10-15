import { randomUUID } from 'node:crypto';
import { quoteIdentifier } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { removeDiacritics } from '../sessions/user-data.js';
import { clrTrim } from '../metadata/whitespace.js';
import { cleanValue, EMPTY_ID, idKey, nonemptyId } from './records.js';

function table(database, name) {
  const quote = value => `"${String(value).replaceAll('"', '""')}"`;
  return `${quote(database.schemaName)}.${quote(name)}`;
}

export async function resolvePostgresSearchCollation(database, culture, { signal } = {}) {
  if (database?.dialect !== 'postgres' || database.connectionSession !== true || database.connectionActive !== true) {
    throw new TypeError('PostgreSQL search collations require an active owned operation session.');
  }
  let canonical;
  try { [canonical] = Intl.getCanonicalLocales(culture || 'en-US'); }
  catch { [canonical] = Intl.getCanonicalLocales('en-US'); }
  const language = canonical.split('-')[0];
  const candidates = [...new Set([
    `${canonical}-x-icu`,
    `${language}-x-icu`,
    'und-x-icu',
  ].map(name => name.toLowerCase()))];
  const result = await database.client.query({
    text: `SELECT n.nspname AS "Schema", c.collname AS "Name", c.colllocale AS "Locale", c.collicurules AS "Rules",
      c.collencoding AS "Encoding", c.collversion AS "Version", current_user AS "Owner",
      pg_catalog.pg_collation_actual_version(c.oid) AS "ActualVersion"
      FROM pg_catalog.pg_collation c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.collnamespace
      WHERE n.nspname = 'pg_catalog' AND c.collprovider = 'i' AND lower(c.collname) = ANY($1::text[])
      ORDER BY array_position($1::text[], lower(c.collname)), c.oid
      LIMIT 1`,
    values: [candidates],
    signal,
  });
  const row = result.rows[0];
  if (row?.Schema !== 'pg_catalog' || !row?.Name || !row?.Locale || row.Encoding !== -1
    || typeof row.Owner !== 'string' || typeof row.ActualVersion !== 'string') {
    throw new Error(`PostgreSQL has no verified ICU collation for '${canonical}'.`);
  }
  // CLR culture comparison leaves culturally equal strings tied. PostgreSQL's
  // deterministic ICU collations add a binary tie-breaker, which would change
  // stable paging for native ignorable characters such as the BOM.
  // Every invocation owns a distinct temporary object. Nested searches on the
  // same physical session cannot dispose another invocation's collation.
  const name = 'mm_search_' + randomUUID().replaceAll('-', '');
  const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
  const schema = 'pg_temp', createdInTransaction = database.inTransaction === true;
  const ddl = 'CREATE COLLATION ' + quoteIdentifier(schema) + '.' + quoteIdentifier(name)
    + ' (provider = icu, locale = ' + quote(row.Locale) + ', deterministic = false'
    + (row.Rules ? ', rules = ' + quote(row.Rules) : '') + ')';
  let creationAttempted = false, releasing;
  const scope = Object.freeze({ schema, name, release: primaryError => releasing ??= (async () => {
    if (!creationAttempted) return;
    if (database.connectionActive !== true) throw new TypeError('A search collation must be released before its owned operation session ends.');
    try {
      await database.client.query(`DROP COLLATION IF EXISTS ${quoteIdentifier(schema)}.${quoteIdentifier(name)}`);
    } catch (error) {
      // The transaction owner must roll back an aborted transaction. This
      // collation was created by that same transaction and rolls back with it.
      if (primaryError && createdInTransaction && database.inTransaction && error.code === '25P02') return;
      // A failed autocommit cleanup cannot leave the object on a pooled backend.
      database.discardConnection(error);
      throw error;
    }
  })() });
  try {
    creationAttempted = true;
    await database.client.query({ text: ddl, signal });
    const actual = (await database.client.query({ text: `SELECT c.collprovider AS "Provider",
      c.collisdeterministic AS "Deterministic", c.collencoding AS "Encoding",
      c.collcollate AS "Collate", c.collctype AS "Ctype", c.colllocale AS "Locale",
      c.collicurules AS "Rules", c.collversion AS "Version",
      pg_catalog.pg_get_userbyid(c.collowner) AS "Owner",
      pg_catalog.pg_collation_actual_version(c.oid) AS "ActualVersion"
      FROM pg_catalog.pg_collation c WHERE c.collnamespace = pg_catalog.pg_my_temp_schema()
        AND c.collname = $1`, values: [name], signal })).rows[0];
    const expected = { Provider: 'i', Deterministic: false, Encoding: -1, Collate: null, Ctype: null,
      Locale: row.Locale, Rules: row.Rules || null, Version: row.ActualVersion, Owner: row.Owner,
      ActualVersion: row.ActualVersion };
    if (!actual || Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
      throw new Error('PostgreSQL temporary search collation differs from its controlled definition.');
    }
    return scope;
  } catch (error) {
    await releasePostgresSearchCollation(scope, error);
    throw error;
  }
}

export async function releasePostgresSearchCollation(scope, primaryError, cleanupErrors = []) {
  const errors = [...cleanupErrors];
  try { await scope?.release(primaryError); } catch (error) { errors.push(error); }
  if (!errors.length) return;
  if (primaryError) throw new AggregateError([primaryError, ...errors], primaryError.message, { cause: primaryError });
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, 'PostgreSQL search collation cleanup failed.');
}

/**
 * Run Jellyfin's built-in search provider as a bounded PostgreSQL query.
 *
 * The provider has a deliberately smaller filter surface than ItemsQuery. Its
 * identifiers are subsequently unioned with the controller's explicit Ids and
 * passed through the ordinary item query.
 */
export async function queryPostgresBuiltInSearch(database, query, {
  userId,
  parentId,
  visibility,
  nameAccessTypes = [],
  signal,
} = {}) {
  if (database?.dialect !== 'postgres') {
    throw new TypeError('PostgreSQL search-provider queries require a PostgreSQL database.');
  }
  const raw = removeDiacritics(clrTrim(query.searchterm ?? ''));
  const clean = cleanValue(raw);
  if (!raw || !clean) return new Map();

  // ItemsController passes Limit * 3 using Int32 arithmetic. Both the provider
  // and SearchManager use 100 when the caller omitted Limit.
  const limit = query.limit == null ? 100 : Math.imul(query.limit, 3);
  if (limit <= 0) return new Map();

  const providerQuery = {
    searchterm: raw,
    ismissing: false,
    excludeitemids: [EMPTY_ID],
    ...(query.includeitemtypes?.length ? { includeitemtypes: query.includeitemtypes }
      : query.excludeitemtypes?.length ? { excludeitemtypes: query.excludeitemtypes } : {}),
    ...(query.mediatypes?.length ? { mediatypes: query.mediatypes } : {}),
  };
  const candidatePlan = buildPostgresItemPageQuery(database, providerQuery, {
    scope: nonemptyId(parentId) ? { parentOrAncestorId: parentId } : {},
    userId,
    includeOwnedItems: userId == null,
    // A user suppresses an alternate whenever its primary is in the same
    // library. A userless search instead suppresses it only if that primary
    // was itself matched; the outer query below implements the latter rule.
    includeAlternateVersions: userId == null,
    groupByPresentationKey: false,
    nameAccessTypes,
    resumableMode: 'repository',
    visibility,
  });

  const values = [...candidatePlan.values, nativeTextBytes(clean), nativeTextBytes(`${clean}%`), nativeTextBytes(`%${clean} %`), limit];
  const cleanParameter = `$${candidatePlan.values.length + 1}`;
  const prefixParameter = `$${candidatePlan.values.length + 2}`;
  const containsParameter = `$${candidatePlan.values.length + 3}`;
  const limitParameter = `$${candidatePlan.values.length + 4}`;
  const items = table(database, 'BaseItems');
  const text = `WITH provider_candidates AS MATERIALIZED (
  ${candidatePlan.text.replaceAll('\n', '\n  ')}
), scored AS (
  SELECT candidate."Id",
    CASE
      WHEN item."CleanName" = ${cleanParameter} THEN 100
      WHEN ${nativeTextSql(database.schemaName).sqliteLike('item."CleanName"', prefixParameter)} THEN 80
      WHEN ${nativeTextSql(database.schemaName).sqliteLike('item."CleanName"', containsParameter)} THEN 75
      ELSE 50
    END AS "Score"
  FROM provider_candidates candidate
  JOIN ${items} item ON ${nativeTextSql(database.schemaName).guidLower("item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("candidate.\"Id\"")}
  WHERE candidate."Id" IS NOT NULL
    AND (item."PrimaryVersionId" IS NULL OR NOT EXISTS (
      SELECT 1 FROM provider_candidates primary_match
      WHERE replace(${nativeTextSql(database.schemaName).guidLower("primary_match.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("item.\"PrimaryVersionId\"")}, '-', '')
    ))
)
SELECT "Id", "Score"
FROM scored
ORDER BY "Score" DESC, ${nativeTextSql(database.schemaName).guidLower("\"Id\"")} ASC
LIMIT ${limitParameter}`;
  const result = await database.client.query({ text, values, signal });
  return new Map(result.rows.map(row => [idKey(decodeNativeTextBytes(row.Id)), Number(row.Score)]));
}
