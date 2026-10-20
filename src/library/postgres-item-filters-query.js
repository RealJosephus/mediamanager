import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { resolvePostgresSearchCollation, releasePostgresSearchCollation } from './postgres-search-provider.js';

/** Aggregate facets over relational item scopes; only the final choices leave SQL. */
export async function queryPostgresItemFilters(database, {
  query = {}, streamQuery = query, scope = {}, userId, visibility,
  legacy = false, includeLanguages = false, languageResolver,
} = {}) {
  const sql = nativeTextSql(database.schemaName);
  const table = name => `${q(database.schemaName)}.${q(name)}`;
  const same = (a, b) => `${sql.guidKey(a)} = ${sql.guidKey(b)}`;
  const values = [], ctes = [];
  const bind = value => { values.push(value); return `$${values.length}`; };
  const append = (name, plan) => {
    const text = plan.text.replace(/\$(\d+)/gu, (_, index) => `$${Number(index) + values.length}`);
    values.push(...plan.values);
    ctes.push(`${name} AS (${text})`);
  };
  const plan = (input, includeOwnedItems = false) => buildPostgresItemPageQuery(database, input, {
    scope, userId, visibility, includeOwnedItems,
    nameAccessTypes: ['Person', 'Genre', 'MusicGenre', 'Studio', 'Year', 'MusicArtist']
      .filter(type => input.includeitemtypes?.includes(type)),
  });
  append('source_ids', plan(query));
  // SQLite MIN ignores nulls and compares the raw TEXT bytes. DISTINCT ON
  // selects that representative without PostgreSQL's locale-dependent MIN.
  ctes.push(`named_values AS (SELECT DISTINCT ON (value."Type", value."CleanValue")
      value."Type", value."Value"
    FROM ${table('ItemValues')} value
    JOIN ${table('ItemValuesMap')} relation ON ${same('relation."ItemValueId"', 'value."ItemValueId"')}
    JOIN source_ids item ON ${same('item."Id"', 'relation."ItemId"')}
    WHERE value."Type" = ANY(${bind(legacy ? [2, 4] : [4])}::integer[])
    ORDER BY value."Type", value."CleanValue", value."Value" NULLS LAST)`);
  let collation, primaryError;
  try {
    const facets = [
      `SELECT CASE WHEN "Type" = 2 THEN 'Genres' ELSE 'Tags' END AS "Kind", "Value", NULL::bytea AS "Name"
        FROM named_values`,
    ];
    if (legacy) {
      ctes.push(`sources AS (SELECT item.* FROM source_ids source JOIN ${table('BaseItems')} item
        ON ${same('item."Id"', 'source."Id"')})`);
      facets.push(`SELECT DISTINCT 'Years', convert_to("ProductionYear"::text, 'UTF8'), NULL::bytea
        FROM sources WHERE "ProductionYear" > 0`,
      `SELECT DISTINCT 'OfficialRatings', "OfficialRating", NULL::bytea FROM sources
        WHERE "OfficialRating" IS NOT NULL AND octet_length("OfficialRating") > 0`);
    } else if (includeLanguages) {
      append('stream_ids', plan(streamQuery, true));
      ctes.push(`languages AS (SELECT DISTINCT stream."StreamType",
          CASE WHEN stream."Language" IS NULL OR octet_length(stream."Language") = 0
            THEN ${bind(nativeTextBytes('und'))}::bytea ELSE stream."Language" END AS language
        FROM ${table('MediaStreamInfos')} stream JOIN stream_ids item ON ${same('item."Id"', 'stream."ItemId"')}
        WHERE stream."StreamType" IN (0, 2))`,
      `language_names AS (SELECT ${sql.ordinalIgnoreCaseKey('alias')} AS key, name
        FROM unnest(${bind(languageResolver.aliases.map(nativeTextBytes))}::bytea[],
          ${bind(languageResolver.displayNames.map(nativeTextBytes))}::bytea[]) names(alias, name))`);
      collation = await resolvePostgresSearchCollation(database, 'en-US');
      facets.push(`SELECT CASE WHEN language."StreamType" = 0 THEN 'AudioLanguages' ELSE 'SubtitleLanguages' END,
        language.language, CASE WHEN names.name IS NULL THEN language.language
          ELSE names.name || convert_to(' (', 'UTF8') || language.language || convert_to(')', 'UTF8') END
        FROM languages language LEFT JOIN language_names names
          ON names.key = ${sql.ordinalIgnoreCaseKey('language.language')}`);
    }
    const rows = (await database.client.query({
      text: `WITH ${ctes.join(',\n')}, facets AS (${facets.join('\nUNION ALL\n')})
        SELECT * FROM facets ORDER BY "Kind" COLLATE "C",
          CASE WHEN "Kind" = 'Years' THEN ${sql.projection('"Value"')}::integer END,
          ${collation ? `${sql.projection('"Name"')} COLLATE ${q(collation.schema)}.${q(collation.name)},` : ''}
          "Value" NULLS FIRST`, values,
    })).rows;
    const result = legacy ? { Genres: [], Tags: [], OfficialRatings: [], Years: [] }
      : { Tags: [], AudioLanguages: [], SubtitleLanguages: [] };
    for (const row of rows) {
      const value = row.Value == null ? null : decodeNativeTextBytes(row.Value);
      result[row.Kind].push(row.Kind === 'Years' ? Number(value)
        : row.Name == null ? value : { Name: decodeNativeTextBytes(row.Name), Value: value });
    }
    return result;
  } catch (error) { primaryError = error; throw error; }
  finally { await releasePostgresSearchCollation(collation, primaryError); }
}
