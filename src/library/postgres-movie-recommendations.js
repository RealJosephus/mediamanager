import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { buildPostgresItemPageQuery, queryPostgresItemPage, visitPostgresRowPlanPages } from '../database/postgres-item-query.js';
import { idKey } from './records.js';
import { buildPostgresMovieSimilarPlan } from './postgres-similar-items-query.js';

const table = (database, name) => `${q(database.schemaName)}.${q(name)}`;
const rebase = (text, offset) => text.replace(/\$(\d+)/gu, (_match, position) => '$' + (offset + Number(position)));

function buildPersonRecommendationsPlan(database, { watchedIds, itemTypes, itemLimit, userId, visibility, withProviderIds }) {
  const sql = nativeTextSql(database.schemaName);
  const same = (left, right) => `${sql.guidKey(left)} = ${sql.guidKey(right)}`;
  const items = table(database, 'BaseItems');
  const people = table(database, 'Peoples');
  const credits = table(database, 'PeopleBaseItemMap');
  const providers = table(database, 'BaseItemProviders');
  const accessible = buildPostgresItemPageQuery(database, { includeitemtypes: itemTypes, ismovie: true, isplayed: false }, { userId, visibility });
  const values = [...accessible.values];
  const bind = value => { values.push(value); return '$' + values.length; };
  const watched = bind(watchedIds.map(idKey));
  // The repository adds four candidates when metadata grouping is requested.
  const window = bind((itemLimit + 6) | 0);
  const limit = bind(itemLimit);
  const lookup = withProviderIds ? `LEFT JOIN LATERAL (
      SELECT provider."ProviderValue" AS imdb FROM ${providers} provider
      WHERE ${same('provider."ItemId"', 'sampled."Id"')}
        AND ${sql.ordinalIgnoreCaseKey('provider."ProviderId"')} = ${sql.ordinalIgnoreCaseKey(bind(nativeTextBytes('Imdb')))}
      ORDER BY provider."ProviderId" LIMIT 1
    ) key ON TRUE` : '';
  const imdb = withProviderIds ? 'key.imdb' : 'NULL::bytea';
  const role = sql.projection('person."PersonType"');
  return {
    text: `WITH accessible AS MATERIALIZED (${accessible.text}),
    watched_credits AS (
      SELECT credit."ItemId", person."Name" AS name,
        CASE WHEN ${role} = 'Director' THEN 2 ELSE 3 END AS kind,
        row_number() OVER (ORDER BY credit."ListOrder", credit."ItemId", credit."PeopleId", credit."Role") AS occurrence
      FROM ${credits} credit JOIN ${people} person ON ${same('person."Id"', 'credit."PeopleId"')}
      WHERE ${sql.guidKey('credit."ItemId"')} = ANY(${watched}::text[])
        AND ${role} COLLATE "C" IN ('Director', 'Actor', 'GuestStar')
        AND octet_length(person."Name") > 0
    ), watched_ordered AS (
      SELECT *, min(occurrence) OVER (PARTITION BY kind,"ItemId") AS first_credit FROM watched_credits
    ), names AS (
      SELECT DISTINCT ON (kind,name) kind,name,
        row_number() OVER (PARTITION BY kind ORDER BY first_credit, occurrence) AS position
      FROM watched_ordered ORDER BY kind,name,position
    ), matches AS (
      SELECT DISTINCT names.kind,names.name,names.position,item."Id",item."SortName",
        item."PresentationUniqueKey", item."PrimaryVersionId" IS NOT NULL AS alternate
      FROM names JOIN ${people} person ON person."Name" = names.name
        AND (names.kind = 3 OR ${role} COLLATE "C" = 'Director')
      JOIN ${credits} credit ON ${same('credit."PeopleId"', 'person."Id"')}
      JOIN accessible ON accessible."Id" = credit."ItemId"
      JOIN ${items} item ON item."Id" = accessible."Id"
    ), representatives AS (
      SELECT DISTINCT ON (kind,name,"PresentationUniqueKey") *
      FROM matches ORDER BY kind,name,"PresentationUniqueKey",alternate,"Id"
    ), sampled AS (
      SELECT *, row_number() OVER (PARTITION BY kind,name ORDER BY "SortName" NULLS FIRST,"Id") AS sample_order
      FROM representatives
    ), keyed AS (
      SELECT sampled.*, ${imdb} AS imdb FROM sampled ${lookup}
      WHERE ${window} < 0 OR sample_order <= ${window}
    ), unique_items AS (
      SELECT DISTINCT ON (kind,name,imdb,CASE WHEN imdb IS NULL THEN "Id" END) *
      FROM keyed ORDER BY kind,name,imdb,CASE WHEN imdb IS NULL THEN "Id" END,sample_order
    ), picked AS (
      SELECT "Id",kind AS "Kind",name AS "CategoryKey",position AS "SourceOrder",
        row_number() OVER (PARTITION BY kind,name ORDER BY sample_order) AS "ItemOrder"
      FROM unique_items
    ) SELECT * FROM picked WHERE "ItemOrder" <= ${limit}`,
    values,
  };
}

/** Select the recommendation categories and their ordered members in PostgreSQL. */
export async function visitPostgresMovieRecommendations(database, input, {
  userId, visibility, baselineScope, baselineVisibility, enableExternalContent, signal,
}, visit) {
  const { categoryLimit, itemLimit } = input;
  const itemTypes = enableExternalContent ? ['Movie', 'Trailer', 'LiveTvProgram'] : ['Movie'];
  const baselineOptions = { userId, visibility: baselineVisibility, scope: baselineScope, groupByPresentationKey: true, signal };
  const played = await queryPostgresItemPage(database, {
    includeitemtypes: ['Movie'], isplayed: true, limit: 11,
    sortby: ['DatePlayed', 'Random'], sortorder: ['Descending', 'Descending'],
  }, baselineOptions);
  const liked = await queryPostgresItemPage(database, {
    includeitemtypes: itemTypes, ismovie: true, isfavorite: true, limit: 14,
    excludeitemids: played.rows.map(item => item.Id), sortby: ['Random'], sortorder: ['Descending'],
  }, baselineOptions);
  if (categoryLimit <= 0 || itemLimit <= 0) return;
  const recent = played.rows.slice(0, categoryLimit), favorites = liked.rows.slice(0, categoryLimit);
  const baselineNames = new Map([...recent, ...favorites].map(item => [idKey(item.Id), item.Name]));
  const sql = nativeTextSql(database.schemaName);
  const values = [], selections = [];
  for (const [kind, sources] of [recent, favorites].entries()) {
    const plan = buildPostgresMovieSimilarPlan(database, { sourceIds: sources.map(item => item.Id),
      userId, limit: itemLimit, enableExternalContent, visibility });
    if (!plan) continue;
    selections.push(`SELECT "Id", ${kind} AS "Kind", ${sql.fromProjection('"SourceId"')} AS "CategoryKey", "SourceOrder", "ItemOrder"
      FROM (${rebase(plan.text, values.length)}) AS movie_items`);
    values.push(...plan.values);
  }
  if (played.rows.length) {
    const plan = buildPersonRecommendationsPlan(database, {
      watchedIds: played.rows.slice(0, 6).map(item => item.Id), itemTypes, itemLimit, userId, visibility,
      withProviderIds: input.fields.includes('ProviderIds'),
    });
    selections.push(`SELECT * FROM (${rebase(plan.text, values.length)}) person`);
    values.push(...plan.values);
  }
  if (!selections.length) return;
  values.push(categoryLimit);
  // The two movie queues advance twice per turn, then director and actor
  // advance once each. After applying this limit the controller groups by type.
  const text = `WITH recommendations AS MATERIALIZED (${selections.join('\nUNION ALL\n')}),
    categories AS (
      SELECT "Kind","CategoryKey",row_number() OVER (PARTITION BY "Kind"
        ORDER BY min("SourceOrder"),"CategoryKey") - 1 AS category_order
      FROM recommendations GROUP BY "Kind","CategoryKey"
    ), selected_categories AS (
      SELECT * FROM categories
      ORDER BY category_order / CASE WHEN "Kind" < 2 THEN 2 ELSE 1 END,
        CASE WHEN "Kind" < 2 THEN "Kind" * 2 + category_order % 2 ELSE "Kind" + 2 END
      LIMIT $${values.length}
    ) SELECT recommendations."Id", recommendations."Kind", recommendations."CategoryKey"
    FROM selected_categories JOIN recommendations USING ("Kind","CategoryKey")
    ORDER BY "Kind",category_order,"ItemOrder"`;
  await visitPostgresRowPlanPages(database, { text, values, startIndex: 0 },
    { signal }, rows => visit(rows, baselineNames));
}
