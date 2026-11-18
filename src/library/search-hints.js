import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { buildPostgresNamedItemPlan } from './postgres-named-items-query.js';
import { buildPostgresSearchProviderPlan } from './postgres-search-provider.js';
import { NAME_TYPES, nonemptyId } from './records.js';
import { nativeItemTypes } from './native-item-entity.js';

const presentationTypes = new Set(['Episode', 'Video', 'Movie', 'MusicVideo', 'Series', 'Season']);
const namedTypes = [
  ['includeGenres', ['Genre', 'MusicGenre']], ['includePeople', ['Person']],
  ['includeStudios', ['Studio']], ['includeArtists', ['MusicArtist']],
];

export function buildSearchHintsPlan(db, input, { userId, visibility }) {
  const include = new Set(input.includeItemTypes), exclude = new Set([...input.excludeItemTypes, 'Year', 'Folder', 'CollectionFolder']);
  for (const [option, types] of namedTypes) {
    if (input[option] === false) for (const type of types) exclude.add(type);
    else if (input.includeMedia === false && (include.size === 0 || include.has(types[0]))) {
      for (const type of types) include.add(type);
    }
  }
  const providerTypes = [...include].filter(type => !exclude.has(type));
  const hasParent = nonemptyId(input.parentId), artistOnly = include.size === 1 && include.has('MusicArtist');
  const nameAccessTypes = hasParent ? [] : [...NAME_TYPES].filter(type =>
    !exclude.has(type) && (!providerTypes.length || providerTypes.includes(type)));
  const limit = input.limit ?? (artistOnly ? undefined : 100), startIndex = Math.max(0, input.startIndex ?? 0);
  const candidates = buildPostgresSearchProviderPlan(db, {
    searchterm: input.searchTerm, includeitemtypes: providerTypes, excludeitemtypes: [...exclude], mediatypes: input.mediaTypes,
  }, { userId, visibility, nameAccessTypes, parentId: input.parentId, limit: input.limit ?? 100 });
  if (!candidates) return null;

  const query = { includeitemtypes: artistOnly ? [] : [...include], excludeitemtypes: [...exclude], mediatypes: input.mediaTypes };
  for (const key of ['isKids', 'isMovie', 'isNews', 'isSeries', 'isSports']) {
    if (input[key] !== undefined) query[key.toLowerCase()] = input[key];
  }
  // The provider applies the user's library visibility before taking its
  // limit. The second repository lookup has explicit IDs and reapplies the
  // requested classification and parental filters to those candidates.
  const { topParentIds: _topParents, ...restrictions } = visibility ?? {};
  const access = { userId, visibility: userId ? restrictions : undefined };
  const itemIdsPlan = { text: 'SELECT "Id" FROM hint_candidates', values: [] };
  // Artist-only queries resolve names associated with the selected candidates.
  // Other searches project the candidates' own entities.
  const selected = artistOnly ? buildPostgresNamedItemPlan(db, {
    kind: 'MusicArtist', mediaQuery: query, mediaItemIdsPlan: itemIdsPlan,
    scope: hasParent ? { ancestorId: input.parentId } : {}, ...access,
  }) : buildPostgresItemPageQuery(db, query, {
    ...access, itemIdsPlan,
    groupByPresentationKey: Boolean(userId && (!include.size || [...include].some(type => presentationTypes.has(type)))),
  });
  const offset = candidates.values.length;
  const selection = selected.text.replace(/\$(\d+)/gu, (_, index) => '$' + (Number(index) + offset));
  const values = [...candidates.values, ...selected.values, nativeItemTypes.map(nativeTextBytes), limit ?? null, startIndex];
  const sql = nativeTextSql(db.schemaName), items = `${q(db.schemaName)}."BaseItems"`;
  const text = `WITH hint_candidates AS MATERIALIZED (${candidates.text}),
    selected AS (${selection}),
    eligible AS MATERIALIZED (
      SELECT selected."Id", COALESCE(candidate."Score", 0) AS "Score", item."SortName"
      FROM selected
      LEFT JOIN hint_candidates candidate ON candidate."Id" = selected."Id"
      JOIN ${items} item ON item."Id" = selected."Id"
      WHERE item."Type" = ANY($${values.length - 2}::bytea[])
    ), hint_page AS (
      SELECT "Id", "Score", "SortName" FROM eligible
      ORDER BY "Score" DESC, "SortName" ASC NULLS FIRST, ${sql.guidLower('"Id"')} ASC
      LIMIT $${values.length - 1} OFFSET $${values.length}
    )
    SELECT page."Id", total."TotalRecordCount"
    FROM (SELECT count(*) AS "TotalRecordCount" FROM eligible) total
    LEFT JOIN hint_page page ON TRUE
    ORDER BY page."Score" DESC NULLS LAST, page."SortName" ASC NULLS FIRST, ${sql.guidLower('page."Id"')} ASC`;
  return { text, values, limit, startIndex };
}
