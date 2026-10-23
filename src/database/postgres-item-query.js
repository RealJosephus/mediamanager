import { decodeNativeTextBytes, nativeTextBytes, nativeTextProjection, nativeTextOrdinalIgnoreCaseKey } from './native-text.js';
import { nativeTextSql } from './native-text-sql.js';
import { quoteIdentifier as q } from './model.js';
import { postgresAliasedVersionFamilyKey, postgresSignedPaddedInteger } from './postgres-query-expressions.js';
import { withPostgresNativeQueryJitOff } from './postgres-native-query-jit.js';
import {
  postgresCleanValueFunctionName,
  postgresRemoveDiacriticsFunctionName,
  postgresInvariantLowerFunctionName,
  postgresOrdinalIgnoreCaseKeyFunctionName,
  postgresParentalRatingScoreFunctionName,
  postgresSafeInt32FunctionName,
  postgresSafeNativeItemDataFunctionName,
  postgresNativeJsonGuidKeyFunctionName,
  postgresCollectionFolderMatchFunctionName,
  postgresExpandedPathKeyFunctionName,
} from './postgres-runtime-schema.js';
import { lowerInvariant } from '../core/identity.js';
import { cleanValue, idKey } from '../library/records.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { wireGuid } from '../users/native.js';
import { searchHistoryClient, searchHistoryKey } from '../sessions/search-history.js';
import { postgresPlaylistSharingPredicate } from '../library/postgres-playlist-query.js';
import {
  clrTrim as clrTrimValue,
  clrWhitespaceCharacters,
} from '../metadata/whitespace.js';

// SQLite's DateTime TEXT may omit the fraction and use a space separator.
// Compare the same instant without a PostgreSQL timestamp cast (microseconds),
// which would lose the native seventh fractional digit.
const nativeDateTextKey = expression => `CASE WHEN ${expression} IS NULL THEN NULL ELSE
  substring(${expression} from 1 for 10) || 'T' || substring(${expression} from 12 for 8) || '.' ||
  rpad(COALESCE(substring(${expression} from '\\.([0-9]{1,7})'), ''), 7, '0') || 'Z' END`;

const SUPPORTED_FILTERS = new Set([
  'ids', 'excludeitemids', 'includeitemtypes', 'excludeitemtypes', 'mediatypes', 'years',
  'indexnumber', 'parentindexnumber', 'islocked', 'isseries', 'isfolder', 'ismovie', 'isairing', 'hasaired',
  'channelids', 'minstartdate', 'maxstartdate', 'minenddate', 'maxenddate', 'externalseriesid', 'name',
  'hasdeadparentid', 'isdeadgenre', 'isdeadstudio',
  'mincommunityrating', 'mincriticrating', 'minpremieredate', 'maxpremieredate',
  'mindatelastsaved', 'mindatelastsavedforuser', 'hasoverview', 'hasimdbid', 'hastmdbid',
  'hastvdbid', 'albumids', 'genres', 'tags', 'isfavorite', 'likes', 'favoriteorlikes',
  'isresumable', 'namestartswith', 'namestartswithorgreater', 'namelessthan', 'searchterm',
  'ismissing', 'locationtypes', 'excludelocationtypes', 'minwidth', 'minheight', 'maxwidth',
  'maxheight', 'is3d', 'videotypes', 'audiolanguages', 'subtitlelanguages', 'hassubtitles',
  'startindex', 'limit', 'sortby', 'sortorder', 'enabletotalrecordcount', 'enableimages',
  'enableuserdata', 'enableimagetypes', 'imagetypelimit', 'fields', 'recursive', 'parentid',
  'userid', 'collapseboxsetitems', 'filters', 'isplayed', 'isunaired', 'isplaceholder',
  'issports', 'isnews', 'iskids', 'ishd', 'is4k', 'hasofficialrating', 'hasparentalrating',
  'hasthemesong', 'hasthemevideo', 'hasspecialfeature', 'hastrailer', 'officialratings',
  'minparentalrating', 'maxparentalrating', 'minindexnumber', 'seriesstatuses', 'imagetypes', 'person',
  'personids', 'persontypes', 'artistids', 'artistcleannames', 'albumartistids',
  'contributingartistids', 'excludeartistids', 'genreids', 'studioids', 'studionames',
  'studiocleannames', 'adjacentto', 'wassearched'
]);

const SORT_COLUMNS = new Map(Object.entries({
  default: 'i."SortName"',
  airedepisodeorder: 'i."SortName"',
  sortname: 'i."SortName"',
  name: 'i."CleanName"',
  album: 'i."Album"',
  datecreated: 'i."DateCreated"',
  officialrating: 'i."InheritedParentalRatingValue"',
  premieredate: 'COALESCE(i."PremiereDate", CASE WHEN i."ProductionYear" IS NULL THEN NULL ELSE convert_to(lpad(i."ProductionYear"::text, 4, \'0\') || \'-01-01 00:00:00\', \'UTF8\') END)',
  startdate: 'i."StartDate"',
  runtime: 'i."RunTimeTicks"',
  communityrating: 'i."CommunityRating"',
  productionyear: 'i."ProductionYear"',
  criticrating: 'i."CriticRating"',
  isfolder: 'i."IsFolder"',
  seriessortname: 'i."SeriesName"',
  videobitrate: 'i."TotalBitrate"',
  airtime: 'i."SortName"',
  datelastcontentadded: 'i."DateLastMediaAdded"',
  parentindexnumber: 'i."ParentIndexNumber"',
  indexnumber: 'i."IndexNumber"'
}));

const ASCII_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ASCII_LOWER = 'abcdefghijklmnopqrstuvwxyz';


const asciiLowerValue = value => String(value).replace(/[A-Z]/gu,
  character => character.toLowerCase());

function table(database, name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/u.test(database.schemaName ?? '')) {
    throw new TypeError('A valid PostgreSQL schema is required for item queries.');
  }
  return `${q(database.schemaName)}.${q(name)}`;
}

function validateStringArray(value, name) {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new TypeError(`${name} must be a string array.`);
  }
  return value;
}

function validateFolderPlan(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.text !== 'string' || !value.text.trim() || !Array.isArray(value.values)) {
    throw new TypeError(`${name} must be a relational root-folder query plan.`);
  }
  return value;
}

function validateRatingContext(value, name) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)
    || (value.foldersPlan === undefined ? !Array.isArray(value.folders) : value.folders !== undefined)) {
    throw new TypeError(`${name} must be a parental-rating context.`);
  }
  const country = entry => entry === undefined || entry === null || typeof entry === 'string';
  if (value.collectionOptions !== undefined && (!Array.isArray(value.collectionOptions)
    || value.collectionOptions.some(entry => !entry || typeof entry !== 'object'
      || typeof entry.id !== 'string' || !country(entry.country)))) {
    throw new TypeError(`${name}.collectionOptions must contain identifiers and countries.`);
  }
  if (value.foldersPlan !== undefined) validateFolderPlan(value.foldersPlan, `${name}.foldersPlan`);
  for (const folder of value.folders ?? []) {
    if (!folder || typeof folder !== 'object' || Array.isArray(folder)
      || typeof folder.id !== 'string' || typeof folder.type !== 'string'
      || !country(folder.path) || !country(folder.preferredCountry) || !country(folder.libraryCountry)
      || !(folder.tags === undefined || Array.isArray(folder.tags)
        && folder.tags.every(tag => typeof tag === 'string'))
      || !(folder.physicalLocations == null || Array.isArray(folder.physicalLocations)
        && folder.physicalLocations.every(location => location == null || typeof location === 'string'))) {
      throw new TypeError(`${name} contains an invalid folder.`);
    }
  }
  if (!country(value.defaultCountry)) throw new TypeError(`${name}.defaultCountry must be a string or null.`);
  return value;
}

function direction(query, index) {
  // The controller's optional SortOrder defaults to Ascending before the
  // repository query is built; only an explicit non-Ascending enum descends.
  return String(query.sortorder?.[index] ?? query.sortorder?.[0] ?? 'Ascending').toLowerCase() === 'ascending'
    ? 'ASC' : 'DESC';
}

function memoryDirection(query, index) {
  // LibraryManager checks only Descending. Undefined numeric enum values are
  // therefore ascending here, unlike the repository mapper below.
  return String(query.sortorder?.[index] ?? query.sortorder?.[0] ?? 'Ascending').toLowerCase() === 'descending'
    ? 'DESC' : 'ASC';
}

function nulls(direction) { return direction === 'ASC' ? 'NULLS FIRST' : 'NULLS LAST'; }

function unsupportedKeys(query) {
  return Object.keys(query).filter(key => !SUPPORTED_FILTERS.has(key));
}

function regexLiteral(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
}

/**
 * Return whether a parsed Jellyfin repository query can be executed without a
 * JavaScript filtering fallback.
 */
export function supportsPostgresItemQuery(query, { userId, repository = true, allowMissingUserSorts = false } = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return false;
  if (unsupportedKeys(query).length) return false;
  const userSorts = repository
    ? ['PlayCount', 'IsPlayed', 'IsUnplayed', 'IsFavoriteOrLiked']
    : ['DatePlayed', 'PlayCount', 'IsUnplayed', 'IsFavoriteOrLiked'];
  if ((query.isfavorite !== undefined || query.likes !== undefined || query.favoriteorlikes || query.isresumable || query.wassearched !== undefined)
    && !userId) return false;
  if (!allowMissingUserSorts && query.sortby?.some(value => userSorts.includes(value)) && !userId) return false;
  return true;
}

export function buildPostgresItemPageQuery(database, query, {
  scope = {},
  userId,
  includeOwnedItems = false,
  includeAlternateVersions = false,
  groupByPresentationKey = false,
  includeOrdinal = false,
  nameAccessTypes = [],
  requireRelatedNameAccess = false,
  searchScores = null,
  searchCollation = null,
  resumableMode = 'repository',
  excludeVersionFamilyIds = [],
  collapseTypes = null,
  collapseMode = 'repository',
  collapseCollectionPath = null,
  memorySortConfiguration = {},
  memoryRatingContext = null,
  memoryPresort = null,
  memorySourceOrder = null,
  memoryFolderPlayback = false,
  repositoryFolderPlayback = resumableMode === 'repository',
  memoryUserViewFilter = false,
  nativeItemsPlan = null,
  itemIdsPlan = null,
  genreIdsPlan = null,
  playedFolderScope = null,
  playlistSharing = null,
  nativeVisibilityProjections = null,
  visibility,
} = {}) {
  if (database?.dialect !== 'postgres') throw new TypeError('PostgreSQL item queries require a PostgreSQL database.');
  if (!supportsPostgresItemQuery(query, { userId, repository: resumableMode === 'repository',
    allowMissingUserSorts: Boolean(searchScores?.length) })) {
    const keys = unsupportedKeys(query);
    throw new Error(`The item query requires unsupported repository semantics${keys.length ? `: ${keys.join(', ')}` : ''}.`);
  }
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new TypeError('Item query scope must be an object.');
  if (!['repository', 'memory'].includes(resumableMode)) throw new TypeError('Unknown resumable query mode.');
  if (!['repository', 'memory'].includes(collapseMode)) throw new TypeError('Unknown collapse query mode.');
  if (collapseCollectionPath !== null && typeof collapseCollectionPath !== 'string') {
    throw new TypeError('collapseCollectionPath must be a string or null.');
  }
  if (!memorySortConfiguration || typeof memorySortConfiguration !== 'object' || Array.isArray(memorySortConfiguration)) {
    throw new TypeError('memorySortConfiguration must be an object.');
  }
  validateRatingContext(memoryRatingContext, 'memoryRatingContext');
  if (memoryPresort !== null && typeof memoryPresort !== 'string') {
    throw new TypeError('memoryPresort must be a string or null.');
  }
  if (memorySourceOrder !== null && memorySourceOrder !== 'stored-sort-name' && memorySourceOrder !== 'occurrence') {
    throw new TypeError('Unknown memory source order.');
  }
  if (typeof memoryFolderPlayback !== 'boolean') throw new TypeError('memoryFolderPlayback must be boolean.');
  if (typeof memoryUserViewFilter !== 'boolean') throw new TypeError('memoryUserViewFilter must be boolean.');
  if (nativeItemsPlan !== null && (resumableMode !== 'memory' || typeof nativeItemsPlan?.text !== 'string'
    || !nativeItemsPlan.text.trim() || !Array.isArray(nativeItemsPlan.values))) {
    throw new TypeError('Live item projections require a relational memory-query plan.');
  }
  if (memorySourceOrder === 'occurrence' && nativeItemsPlan === null) throw new TypeError('Occurrence order requires live item projections.');
  if (typeof requireRelatedNameAccess !== 'boolean') throw new TypeError('requireRelatedNameAccess must be boolean.');
  if (nativeVisibilityProjections !== null) {
    if (!Array.isArray(nativeVisibilityProjections) || nativeVisibilityProjections.length > 128) {
      throw new TypeError('Native visibility projections require at most 128 items.');
    }
    const ids = new Set(), normalized = [], fields = ['Id', 'OfficialRating', 'CustomRating', 'LibraryFolderIds'];
    const canonicalGuid = value => {
      if (typeof value !== 'string') throw new TypeError('Native visibility identities must be typed Guid strings.');
      try { return wireGuid(value); }
      catch { throw new TypeError('Native visibility identities must be typed Guid strings.'); }
    };
    for (const item of nativeVisibilityProjections) {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).length !== fields.length || !fields.every(name => Object.hasOwn(item, name))
        || ![item.OfficialRating, item.CustomRating].every(value => value === null || typeof value === 'string')
        || item.LibraryFolderIds !== null && !Array.isArray(item.LibraryFolderIds)) {
        throw new TypeError('Native visibility projections require unique Guid identities and complete nullable typed fields.');
      }
      const Id = canonicalGuid(item.Id);
      if (ids.has(Id)) throw new TypeError('Native visibility projections require unique Guid identities.');
      ids.add(Id); normalized.push({ Id, OfficialRating: item.OfficialRating, CustomRating: item.CustomRating,
        LibraryFolderIds: item.LibraryFolderIds === null ? null : item.LibraryFolderIds.map(canonicalGuid) });
    }
    nativeVisibilityProjections = normalized;
    if (visibility?.itemMode !== 'standalone') throw new TypeError('Native visibility projections require standalone visibility.');
  }
  if (itemIdsPlan !== null && (!itemIdsPlan || typeof itemIdsPlan !== 'object'
    || typeof itemIdsPlan.text !== 'string' || !itemIdsPlan.text.trim()
    || !Array.isArray(itemIdsPlan.values))) {
    throw new TypeError('itemIdsPlan must be a relational identifier query plan.');
  }
  if (genreIdsPlan !== null && (!genreIdsPlan || typeof genreIdsPlan !== 'object'
    || typeof genreIdsPlan.text !== 'string' || !genreIdsPlan.text.trim()
    || !Array.isArray(genreIdsPlan.values)
    || typeof genreIdsPlan.emptyMatchesAll !== 'boolean')) {
    throw new TypeError('genreIdsPlan must be a relational query plan with explicit empty-set semantics.');
  }
  if (genreIdsPlan !== null && (query.genres?.length || query.genreids?.length)) {
    throw new TypeError('Genre selectors and genreIdsPlan cannot be combined.');
  }
  if (playedFolderScope !== null && (!playedFolderScope || typeof playedFolderScope !== 'object'
    || Array.isArray(playedFolderScope) || typeof playedFolderScope.played !== 'boolean'
    || typeof playedFolderScope.displayMissingEpisodes !== 'boolean'
    || playedFolderScope.played && (typeof playedFolderScope.now !== 'string' || !playedFolderScope.now))) {
    throw new TypeError('playedFolderScope must contain played, displayMissingEpisodes and a current native date.');
  }
  if (searchScores !== null && (!Array.isArray(searchScores) || searchScores.some(entry => !entry
    || typeof entry.id !== 'string' || !Number.isSafeInteger(entry.score)))) {
    throw new TypeError('searchScores must be an array of identifier and integer score pairs or null.');
  }
  if (searchScores?.length && (!searchCollation || typeof searchCollation !== 'object'
    || Array.isArray(searchCollation) || typeof searchCollation.schema !== 'string'
    || typeof searchCollation.name !== 'string'
    || !searchCollation.schema || !searchCollation.name)) {
    throw new TypeError('A PostgreSQL collation is required for provider search ordering.');
  }
  validateStringArray(excludeVersionFamilyIds, 'excludeVersionFamilyIds');
  if (collapseTypes !== null) validateStringArray(collapseTypes, 'collapseTypes');
  const allowedScope = new Set(['ids', 'parentId', 'parentIds', 'parentOrAncestorId', 'parentOrLinkedId',
    'childParentId', 'childParentIds', 'ancestorId', 'ancestorIds', 'topParentIds', 'linkedParentId',
    'linkedParentIds', 'linkedChildAncestorIds', 'linkedTopParentIds', 'seriesPresentationKey', 'seriesPresentationKeys',
    'specialSeason', 'boxSetRepositoryId', 'sourceChildren']);
  const unknownScope = Object.keys(scope).filter(key => !allowedScope.has(key));
  if (unknownScope.length) throw new TypeError(`Unknown item query scope: ${unknownScope.join(', ')}`);

  const leafType = alias => `substring(${nativeTextSql(database.schemaName).projection(`${alias}."Type"`)} from '[^.]+$')`;
  const sql = nativeTextSql(database.schemaName);
  const project = expression => sql.projection(expression);
  const fromProject = expression => sql.fromProjection(expression);
  const asciiLower = expression => sql.sqliteAsciiLowerKey(expression);
  const nativeDateKey = expression => nativeDateTextKey(project(expression));
  const projectDocument = value => typeof value === 'string' ? nativeTextProjection(value)
    : Array.isArray(value) ? value.map(projectDocument)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, projectDocument(child)])) : value;
  const values = [];
  const bind = value => { values.push(value); return `$${values.length}`; };
  let clrTrimCharactersParameter;
  const clrTrim = expression => {
    clrTrimCharactersParameter ??= bind(clrWhitespaceCharacters);
    return `btrim(${expression}, ${clrTrimCharactersParameter})`;
  };
  const bindTextArray = (value, name) => `${bind(validateStringArray(value, name))}::text[]`;
  const bindNativeText = value => bind(value == null ? null : nativeTextBytes(String(value)));
  const bindNativeArray = (value, name) => `${bind(validateStringArray(value, name).map(nativeTextBytes))}::bytea[]`;
  const bindOrdinalArray = value => `${bind(value.map(value => nativeTextOrdinalIgnoreCaseKey(String(value))))}::bytea[]`;
  const normalizedId = expression => `replace(${nativeTextSql(database.schemaName).guidLower(expression)}, '-', '')`;
  const bindIdArray = (value, name) => bindTextArray(validateStringArray(value, name).map(idKey), name);
  const predicates = [`i."Type" <> 'PLACEHOLDER'`];
  const postCollapsePredicates = [];
  const relationalCtes = [];
  const baseItems = table(database, 'BaseItems');
  let primaryItems = baseItems;
  if (nativeItemsPlan !== null) {
    const offset = values.length;
    relationalCtes.push(`native_query_items AS (${nativeItemsPlan.text.replace(/\$(\d+)\b/gu, (_, index) => '$' + (Number(index) + offset))})`);
    values.push(...nativeItemsPlan.values); primaryItems = 'native_query_items';
    if (collapseTypes !== null) {
      const replacement = nativeItemsPlan.repository;
      if (typeof replacement?.text !== 'string' || !Array.isArray(replacement.values)) {
        throw new TypeError('Live collection collapse requires a repository row projection.');
      }
      const replacementOffset = values.length;
      relationalCtes.push(`native_query_repository_items AS (${replacement.text.replace(/\$(\d+)\b/gu,
        (_, index) => '$' + (Number(index) + replacementOffset))})`);
      values.push(...replacement.values);
    }
  }
  const liveAlias = alias => nativeItemsPlan !== null && ['i', 'memory_source', 'incoming', 'existing'].includes(alias);
  const memoryList = (alias, column) => liveAlias(alias) ? `${alias}.${q('__' + column)}`
    : `ARRAY(SELECT ${fromProject('list_value')} FROM unnest(string_to_array(${project(`${alias}.${q(column)}`)}, '|')) list_value)`;
  if (nativeVisibilityProjections?.length) {
    // Only the caller's bounded typed objects cross this boundary. The complete
    // library remains in its real relation; this is not a BaseItems mirror.
    relationalCtes.push(`native_visibility_input("Id","OfficialRating","CustomRating","LibraryFolderIds") AS (
      SELECT source."Id",source."OfficialRating",source."CustomRating",NULLIF(source."LibraryFolderIds"::jsonb,'null'::jsonb)
      FROM unnest(${bind(nativeVisibilityProjections.map(item => idKey(item.Id)))}::text[],
        ${bind(nativeVisibilityProjections.map(item => item.OfficialRating === null ? null : nativeTextBytes(item.OfficialRating)))}::bytea[],
        ${bind(nativeVisibilityProjections.map(item => item.CustomRating === null ? null : nativeTextBytes(item.CustomRating)))}::bytea[],
        ${bind(nativeVisibilityProjections.map(item => JSON.stringify(item.LibraryFolderIds?.map(idKey) ?? null)))}::text[])
        source("Id","OfficialRating","CustomRating","LibraryFolderIds"))`);
  }
  // Resolve the outer Guid once before scanning the bounded projection.
  // Presence stays separate from the nullable projected value.
  const visibilityColumn = (alias, name, stored = `${alias}.${q(name)}`) => liveAlias(alias) && name === 'LibraryFolderIds'
    ? `${alias}."__LibraryFolderIds"` : !nativeVisibilityProjections?.length ? stored
    : `(SELECT CASE WHEN visibility_value."Present" IS TRUE THEN visibility_value."Value" ELSE ${stored} END
      FROM (SELECT ${normalizedId(`${alias}."Id"`)} AS "Id" OFFSET 0) visibility_key
      LEFT JOIN LATERAL (
        SELECT projected.${q(name)} AS "Value", TRUE AS "Present" FROM native_visibility_input projected
        WHERE projected."Id" = visibility_key."Id" OFFSET 0
      ) visibility_value ON TRUE)`;
  let sourceExpansion = '';
  if (scope.sourceChildren != null) {
    if (!Array.isArray(scope.sourceChildren) || scope.sourceChildren.some(source => !source
      || typeof source.key !== 'string' || !Array.isArray(source.parentIds)
      || source.parentIds.some(id => typeof id !== 'string'))) throw new TypeError('Invalid child source groups.');
    // Distinct children within one source, but preserve separate contributions
    // from different grouped folders and their stable concatenation order.
    const flattened = scope.sourceChildren.flatMap((source, ordinal) => source.parentIds.map((parentId, parentOrdinal) => ({
      ordinal, parentOrdinal, key: idKey(source.key), parentId: idKey(parentId),
    })));
    const sources = bind(flattened.map(source => source.key));
    const parents = bind(flattened.map(source => source.parentId));
    const sourceLinks = table(database, 'LinkedChildren');
    sourceExpansion = `JOIN (
      SELECT source_group."Key", source_group."Ordinal", child."Id" AS "ItemId",
        min(source_group."ParentOrdinal") AS "ParentOrdinal"
      FROM unnest(${sources}::text[], ${parents}::text[], ${bind(flattened.map(source => source.ordinal))}::integer[],
        ${bind(flattened.map(source => source.parentOrdinal))}::integer[]) source_group("Key", "ParentId", "Ordinal", "ParentOrdinal")
      JOIN ${baseItems} child ON ${normalizedId('child."ParentId"')} = source_group."ParentId"
        OR EXISTS (SELECT 1 FROM ${sourceLinks} source_link
          WHERE ${normalizedId('source_link."ParentId"')} = source_group."ParentId"
            AND ${normalizedId('source_link."ChildId"')} = ${normalizedId('child."Id"')})
      GROUP BY source_group."Key", source_group."Ordinal", child."Id"
    ) source_child ON ${normalizedId('source_child."ItemId"')} = ${normalizedId('i."Id"')}`;
  }
  const ancestors = table(database, 'AncestorIds');
  const providers = table(database, 'BaseItemProviders');
  const itemValues = table(database, 'ItemValues');
  const itemValuesMap = table(database, 'ItemValuesMap');
  const userData = table(database, 'UserData');
  const searchHistory = (alias, column) => userId == null ? 'NULL' : `(SELECT history.${q(column)}
    FROM ${table(database, 'CustomItemDisplayPreferences')} history
    WHERE history."Client" = ${bindNativeText(searchHistoryClient)} AND history."Key" = ${bindNativeText(searchHistoryKey)}
      AND ${normalizedId('history."UserId"')} = ${bind(idKey(userId))}
      AND ${normalizedId('history."ItemId"')} = ${normalizedId(`${alias}."Id"`)} LIMIT 1)`;
  const searchDate = alias => `(${project(searchHistory(alias, 'Value'))})::bigint`;
  if (query.wassearched !== undefined) predicates.push(`${searchHistory('i', 'Value')} IS ${query.wassearched ? 'NOT ' : ''}NULL`);
  const links = table(database, 'LinkedChildren');
  const peopleMap = table(database, 'PeopleBaseItemMap');
  const people = table(database, 'Peoples');
  const streams = table(database, 'MediaStreamInfos');
  const images = table(database, 'BaseItemImageInfos');
  if (playedFolderScope?.played) {
    const virtualExclusion = playedFolderScope.displayMissingEpisodes
      ? `(${leafType('i')} = 'Episode' AND i."PremiereDate" IS NOT NULL
        AND i."PremiereDate" > ${bindNativeText(playedFolderScope.now)})`
      : 'TRUE';
    predicates.push(`NOT (i."IsVirtualItem" IS TRUE AND ${virtualExclusion})`);
  }
  let searchScoreExpression = null;
  if (searchScores?.length) {
    const uniqueScores = [...new Map(searchScores.map(entry => [idKey(entry.id), entry.score])).entries()];
    const scoreIds = bindTextArray(uniqueScores.map(([id]) => id), 'search score ids');
    const scores = `${bind(uniqueScores.map(([, score]) => score))}::integer[]`;
    relationalCtes.push(`search_scores("Id", "Score") AS (SELECT * FROM unnest(${scoreIds}, ${scores}))`);
    searchScoreExpression = `(SELECT search_score."Score" FROM search_scores search_score
      WHERE search_score."Id" = ${normalizedId('i."Id"')} LIMIT 1)`;
  }
  const runtimeTextKey = (name, expression) => `${q(database.schemaName)}.${q(name)}(${expression})`;
  const invariantLower = expression => runtimeTextKey(postgresInvariantLowerFunctionName, expression);
  const ordinalKey = expression => runtimeTextKey(postgresOrdinalIgnoreCaseKeyFunctionName, expression);
  const safeInt32 = expression => runtimeTextKey(postgresSafeInt32FunctionName, expression);
  const safeNativeItemData = alias => runtimeTextKey(postgresSafeNativeItemDataFunctionName,
    `${alias}."Type", ${alias}."Data"`);
  const ratingContextBindings = new Map(), ratingFolderBindings = new Map();
  const bindFolderPlan = (plan, name) => {
    validateFolderPlan(plan, name);
    const offset = values.length;
    const text = plan.text.replace(/\$(\d+)\b/gu, (_, index) => '$' + (Number(index) + offset));
    values.push(...plan.values);
    return text;
  };
  const folderArrayJson = (expression, encode = project) => `CASE WHEN ${expression} IS NULL THEN 'null'::jsonb
    ELSE COALESCE((SELECT jsonb_agg(${encode('folder_value."Value"')} ORDER BY folder_value."Ordinal")
      FROM unnest(${expression}) WITH ORDINALITY folder_value("Value","Ordinal")), '[]'::jsonb) END`;
  const bindRatingFolders = context => {
    // The catalogue stays in SQL. Explicit finite controls use the same JSON
    // relation consumed below, without enumerating a production root in JS.
    if (context.foldersPlan === undefined) return `${bind(JSON.stringify(projectDocument(context.folders)))}::jsonb`;
    const source = bindFolderPlan(context.foldersPlan, 'parental-rating foldersPlan');
    return `(SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id',${project('root_folder."Id"')},
      'type',substring(${project('root_folder."NativeType"')} from '[^.]+$'),
      'path',${project('root_folder."Path"')},
      'preferredCountry',${project('root_folder."PreferredCountry"')},
      'physicalLocations',${folderArrayJson('root_folder."PhysicalLocations"')},
      'tags',${folderArrayJson('root_folder."Tags"')}
    ) ORDER BY root_folder."Ordinal"), '[]'::jsonb) FROM (${source}) root_folder)`;
  };
  const defaultRatingContext = Object.freeze({
    defaultCountry: memorySortConfiguration.MetadataCountryCode === undefined ? 'US' : memorySortConfiguration.MetadataCountryCode,
    folders: [],
  });
  const ratingFoldersBinding = (context, name) => {
    const validated = validateRatingContext(context ?? defaultRatingContext, name);
    const key = validated.foldersPlan ?? JSON.stringify(validated.folders);
    if (!ratingFolderBindings.has(key)) ratingFolderBindings.set(key, bindRatingFolders(validated));
    return ratingFolderBindings.get(key);
  };
  const ratingContextBinding = (context, name) => {
    const validated = validateRatingContext(context ?? defaultRatingContext, name);
    const normalized = {
      defaultCountry: validated.defaultCountry === undefined ? 'US' : validated.defaultCountry,
      collectionOptions: validated.collectionOptions ?? [],
      ...(validated.foldersPlan === undefined ? { folders: validated.folders } : { foldersPlan: validated.foldersPlan }),
    };
    const key = validated.foldersPlan === undefined ? JSON.stringify(normalized) : validated;
    if (!ratingContextBindings.has(key)) ratingContextBindings.set(key, Object.freeze({
      folders: ratingFoldersBinding(validated, name),
      collectionOptions: `${bind(JSON.stringify(projectDocument(normalized.collectionOptions)))}::jsonb`,
      defaultCountry: bind(normalized.defaultCountry == null ? null : nativeTextProjection(normalized.defaultCountry)),
    }));
    return ratingContextBindings.get(key);
  };
  const memoryPreferredMetadataCountry = (alias, context, name) => {
    const binding = ratingContextBinding(context, name);
    const idKeySql = expression => `replace(${nativeTextSql(database.schemaName).guidLower(expression)}, '-', '')`;
    // GetCollectionFolders returns a complete List before country selection.
    // Aggregate every matched ordinal even if an earlier folder has a country.
    return `(WITH RECURSIVE rating_country_chain("Id", "ParentId", "PreferredCountry", "Depth", "Seen") AS (
      SELECT ${alias}."Id", ${alias}."ParentId", ${project(`${alias}."PreferredMetadataCountryCode"`)}, 0,
        ARRAY[${idKeySql(`${alias}."Id"`)}]
      UNION ALL
      SELECT rating_parent."Id", rating_parent."ParentId", ${project('rating_parent."PreferredMetadataCountryCode"')},
        rating_chain."Depth" + 1, rating_chain."Seen" || ${idKeySql('rating_parent."Id"')}
      FROM rating_country_chain rating_chain
      JOIN ${baseItems} rating_parent ON ${idKeySql('rating_parent."Id"')}
        = ${idKeySql('rating_chain."ParentId"')}
      WHERE NOT (${idKeySql('rating_parent."Id"')} = ANY(rating_chain."Seen"))
    ), rating_root_walk("Id", "ParentId", "OwnerId", "Path", "Depth", "Seen") AS (
      SELECT ${alias}."Id", ${alias}."ParentId", ${alias}."OwnerId", ${alias}."Path", 0,
        ARRAY[${idKeySql(`${alias}."Id"`)}]
      UNION ALL
      SELECT rating_next."Id", rating_next."ParentId", rating_next."OwnerId", rating_next."Path",
        rating_root."Depth" + 1, rating_root."Seen" || ${idKeySql('rating_next."Id"')}
      FROM rating_root_walk rating_root
      JOIN LATERAL (
        SELECT rating_parent.* FROM ${baseItems} rating_parent
        WHERE ${idKeySql('rating_parent."Id"')} = ${idKeySql('rating_root."ParentId"')}
          AND ${leafType('rating_parent')} <> 'AggregateFolder'
        UNION ALL
        SELECT rating_owner.* FROM ${baseItems} rating_owner
        WHERE NOT EXISTS (SELECT 1 FROM ${baseItems} rating_parent
          WHERE ${idKeySql('rating_parent."Id"')} = ${idKeySql('rating_root."ParentId"')})
          AND ${idKeySql('rating_owner."Id"')} = ${idKeySql('rating_root."OwnerId"')}
        LIMIT 1
      ) rating_next ON TRUE
      WHERE NOT (${idKeySql('rating_next."Id"')} = ANY(rating_root."Seen"))
    ), rating_root AS (
      SELECT * FROM rating_root_walk ORDER BY "Depth" DESC LIMIT 1
    ), rating_folders AS (
      SELECT rating_folder."Document", rating_folder."Ordinal",
        rating_folder."Document" ->> 'id' AS "Id",
        rating_folder."Document" ->> 'type' AS "Type",
        rating_folder."Document" ->> 'path' AS "Path",
        rating_folder."Document" ->> 'preferredCountry' AS "PreferredCountry",
        rating_folder."Document" ->> 'libraryCountry' AS "LibraryCountry",
        rating_folder."Document" -> 'physicalLocations' AS "PhysicalLocations"
      FROM jsonb_array_elements(${binding.folders}) WITH ORDINALITY
        AS rating_folder("Document", "Ordinal")
    ), rating_collection_options AS (
      SELECT rating_option."Document" ->> 'id' AS "Id",
        rating_option."Document" ->> 'country' AS "Country",
        rating_option."Ordinal"
      FROM jsonb_array_elements(${binding.collectionOptions}) WITH ORDINALITY
        AS rating_option("Document", "Ordinal")
    ), rating_matched_ordinals AS (
      SELECT COALESCE(array_agg(rating_folder."Ordinal"),ARRAY[]::bigint[]) AS "Values"
      FROM rating_folders rating_folder CROSS JOIN rating_root
      WHERE CASE WHEN rating_folder."Path" IS NULL AND rating_root."Path" IS NULL
          OR ${ordinalKey('rating_folder."Path"')} = ${ordinalKey('rating_root."Path"')}
        THEN TRUE ELSE EXISTS (
            SELECT 1 FROM jsonb_array_elements(rating_folder."PhysicalLocations") rating_location("Value")
            WHERE ${ordinalKey("COALESCE(rating_location.\"Value\" #>> '{}', '')")}
              = ${ordinalKey('COALESCE(rating_root."Path", \'\')')}
          ) END
    ), rating_matched_folders AS (
      SELECT rating_folder.* FROM rating_folders rating_folder CROSS JOIN rating_matched_ordinals matched
      WHERE rating_folder."Ordinal"=ANY(matched."Values")
    )
    SELECT COALESCE(
      (SELECT "PreferredCountry" FROM rating_country_chain
        WHERE "PreferredCountry" IS NOT NULL AND "PreferredCountry" <> ''
        ORDER BY "Depth" LIMIT 1),
      (SELECT "PreferredCountry" FROM rating_matched_folders
        WHERE "PreferredCountry" IS NOT NULL AND "PreferredCountry" <> ''
        ORDER BY "Ordinal" LIMIT 1),
      CASE WHEN ${leafType(alias)} = 'CollectionFolder' THEN
        NULLIF(COALESCE((SELECT "Country" FROM rating_collection_options
          WHERE ${idKeySql('"Id"')} = ${idKeySql(`${alias}."Id"`)}
          ORDER BY "Ordinal" LIMIT 1),
        (SELECT "LibraryCountry" FROM rating_folders
          WHERE ${idKeySql('"Id"')} = ${idKeySql(`${alias}."Id"`)}
          ORDER BY "Ordinal" LIMIT 1)), '')
      ELSE
        NULLIF(COALESCE((SELECT rating_option."Country" FROM rating_collection_options rating_option
          WHERE ${idKeySql('rating_option."Id"')} = (SELECT ${idKeySql('rating_folder."Id"')}
            FROM rating_matched_folders rating_folder WHERE rating_folder."Type" = 'CollectionFolder'
            ORDER BY rating_folder."Ordinal" LIMIT 1)
          ORDER BY rating_option."Ordinal" LIMIT 1),
        (SELECT "LibraryCountry" FROM rating_matched_folders
          WHERE "Type" = 'CollectionFolder'
          ORDER BY "Ordinal" LIMIT 1)), '')
      END,
      ${binding.defaultCountry}
    ))`;
  };
  const memoryRatingScore = (rating, alias, context, name) => {
    const binding = ratingContextBinding(context, name);
    const country = memoryPreferredMetadataCountry(alias, context, name);
    return runtimeTextKey(postgresParentalRatingScoreFunctionName,
      `${rating}, jsonb_build_array(${country}, ${binding.defaultCountry})`);
  };
  const memoryBlockedTagExists = (alias, context, names, name) => {
    const blocked = names.filter(tag => String(tag).trim()).map(cleanValue);
    if (!names.length) return 'FALSE';
    const folders = ratingFoldersBinding(context, name);
    const blockedParameter = bindNativeArray(blocked, `${name}.blockedTags`);
    const idKeySql = expression => `replace(${nativeTextSql(database.schemaName).guidLower(expression)}, '-', '')`;
    const itemTags = nativeItemsPlan ? folderArrayJson('rating_item."Tags"')
      : `to_jsonb(string_to_array(COALESCE(${project('rating_item."Tags"')}, ''), '|'))`;
    // GetInheritedTags completes membership and AddRange before overlap checks.
    // Keep that read when normalization removes every raw preference.
    return `(WITH RECURSIVE rating_tag_chain("Id", "ParentId", "OwnerId", "Path", "Tags", "Depth", "Seen") AS (
      SELECT ${alias}."Id", ${alias}."ParentId", ${alias}."OwnerId", ${alias}."Path", ${nativeItemsPlan ? memoryList(alias, 'Tags') : `${alias}."Tags"`}, 0,
        ARRAY[${idKeySql(`${alias}."Id"`)}]
      UNION ALL
      SELECT rating_parent."Id", rating_parent."ParentId", rating_parent."OwnerId", rating_parent."Path",
        ${nativeItemsPlan ? memoryList('rating_parent', 'Tags') : 'rating_parent."Tags"'}, rating_chain."Depth" + 1,
        rating_chain."Seen" || ${idKeySql('rating_parent."Id"')}
      FROM rating_tag_chain rating_chain
      JOIN ${baseItems} rating_parent ON ${idKeySql('rating_parent."Id"')}
        = ${idKeySql('rating_chain."ParentId"')}
      WHERE NOT (${idKeySql('rating_parent."Id"')} = ANY(rating_chain."Seen"))
    ), rating_tag_root_walk("Id", "ParentId", "OwnerId", "Path", "Depth", "Seen") AS (
      SELECT ${alias}."Id", ${alias}."ParentId", ${alias}."OwnerId", ${alias}."Path", 0,
        ARRAY[${idKeySql(`${alias}."Id"`)}]
      UNION ALL
      SELECT rating_next."Id", rating_next."ParentId", rating_next."OwnerId", rating_next."Path",
        rating_root."Depth" + 1, rating_root."Seen" || ${idKeySql('rating_next."Id"')}
      FROM rating_tag_root_walk rating_root
      JOIN LATERAL (
        SELECT rating_parent.* FROM ${baseItems} rating_parent
        WHERE ${idKeySql('rating_parent."Id"')} = ${idKeySql('rating_root."ParentId"')}
          AND ${leafType('rating_parent')} <> 'AggregateFolder'
        UNION ALL
        SELECT rating_owner.* FROM ${baseItems} rating_owner
        WHERE NOT EXISTS (SELECT 1 FROM ${baseItems} rating_parent
          WHERE ${idKeySql('rating_parent."Id"')} = ${idKeySql('rating_root."ParentId"')})
          AND ${idKeySql('rating_owner."Id"')} = ${idKeySql('rating_root."OwnerId"')}
        LIMIT 1
      ) rating_next ON TRUE
      WHERE NOT (${idKeySql('rating_next."Id"')} = ANY(rating_root."Seen"))
    ), rating_tag_root AS (
      SELECT * FROM rating_tag_root_walk ORDER BY "Depth" DESC LIMIT 1
    ), rating_tag_folders AS (
      SELECT rating_folder."Document", rating_folder."Ordinal",
        rating_folder."Document" ->> 'path' AS "Path",
        rating_folder."Document" -> 'physicalLocations' AS "PhysicalLocations",
        COALESCE(rating_folder."Document" -> 'tags', '[]'::jsonb) AS "Tags"
      FROM jsonb_array_elements(${folders}) WITH ORDINALITY
        AS rating_folder("Document", "Ordinal")
    ), rating_tag_matched_ordinals AS (
      SELECT COALESCE(array_agg(rating_folder."Ordinal"),ARRAY[]::bigint[]) AS "Values"
      FROM rating_tag_folders rating_folder CROSS JOIN rating_tag_root
      WHERE CASE WHEN rating_folder."Path" IS NULL AND rating_tag_root."Path" IS NULL
          OR ${ordinalKey('rating_folder."Path"')} = ${ordinalKey('rating_tag_root."Path"')}
        THEN TRUE ELSE EXISTS (
          SELECT 1 FROM jsonb_array_elements(rating_folder."PhysicalLocations") rating_location("Value")
          WHERE ${ordinalKey("COALESCE(rating_location.\"Value\" #>> '{}', '')")}
            = ${ordinalKey('COALESCE(rating_tag_root."Path", \'\')')}
        ) END
    ), rating_tag_matched_folders AS (
      SELECT rating_folder.* FROM rating_tag_folders rating_folder CROSS JOIN rating_tag_matched_ordinals matched
      WHERE rating_folder."Ordinal"=ANY(matched."Values")
    ), rating_tag_snapshot AS (
      SELECT COALESCE(jsonb_agg(rating_tag."Value"),'[]'::jsonb) AS "Values" FROM (
        SELECT ${itemTags} AS "Tags" FROM rating_tag_chain rating_item
        UNION ALL SELECT "Tags" FROM rating_tag_matched_folders
      ) inherited CROSS JOIN LATERAL jsonb_array_elements_text(inherited."Tags") rating_tag("Value")
    )
    SELECT CASE WHEN jsonb_array_length(snapshot."Values")>=0 THEN EXISTS(
      SELECT 1 FROM jsonb_array_elements_text(snapshot."Values") rating_tag("Value")
      WHERE ${runtimeTextKey(postgresCleanValueFunctionName, fromProject('rating_tag."Value"'))}=ANY(${blockedParameter})
    ) ELSE FALSE END FROM rating_tag_snapshot snapshot)`;
  };

  let cachedMemorySortName;
  const memorySortName = (alias = 'i') => {
    if (liveAlias(alias)) return `${alias}."SortName"`;
    if (alias === 'i' && cachedMemorySortName) return cachedMemorySortName;
    const rawColumn = name => `${alias}.${q(name)}`;
    const column = name => ['ForcedSortName', 'Name', 'SortName'].includes(name) ? project(rawColumn(name)) : rawColumn(name);
    const type = leafType(alias);
    const forcedOrName = `COALESCE(NULLIF(${column('ForcedSortName')}, ''), ${column('Name')})`;
    let normalized = project(invariantLower(fromProject(clrTrim(forcedOrName))));
    for (const word of memorySortConfiguration.SortRemoveWords ?? ['the', 'a', 'an']) {
      const text = String(word);
      const prefix = bind(`^${regexLiteral(nativeTextProjection(text))} `), interior = bind(` ${nativeTextProjection(text)} `);
      const suffix = bind(` ${regexLiteral(nativeTextProjection(text))}$`);
      // BaseItem.CreateSortName performs these three ordinal operations in
      // sequence. In particular, a value equal to the word is not removed.
      normalized = `regexp_replace(replace(regexp_replace(${normalized}, ${prefix}, ''),
        ${interior}, ' '), ${suffix}, '')`;
    }
    for (const character of memorySortConfiguration.SortRemoveCharacters ?? [',', '&', '-', '{', '}', "'"]) {
      normalized = `replace(${normalized}, ${bind(nativeTextProjection(String(character)))}, '')`;
    }
    for (const character of memorySortConfiguration.SortReplaceCharacters ?? ['.', '+', '%']) {
      normalized = `replace(${normalized}, ${bind(nativeTextProjection(String(character)))}, ' ')`;
    }
    const padded = `(SELECT string_agg(CASE WHEN chunks[1] ~ '^[0-9]+$' AND char_length(chunks[1]) < 10 THEN lpad(chunks[1], 10, '0') ELSE chunks[1] END, '' ORDER BY ordinal) FROM regexp_matches(${normalized}, E'[0-9]+|(?:\\x01[01]|[^0-9\\x01])+', 'g') WITH ORDINALITY AS sort_chunks(chunks, ordinal))`;
    const withoutDiacritics = project(runtimeTextKey(postgresRemoveDiacriticsFunctionName, fromProject(`COALESCE(${padded}, '')`)));
    const signed = (name, width) => postgresSignedPaddedInteger(column(name), width);
    const expression = `CASE
      WHEN ${type} = 'Season' AND COALESCE(${column('ForcedSortName')}, '') = '' THEN CASE WHEN ${column('IndexNumber')} IS NULL THEN ${column('Name')} ELSE ${signed('IndexNumber', 4)} END
      WHEN ${type} = 'Episode' AND COALESCE(${column('ForcedSortName')}, '') = '' THEN concat(CASE WHEN ${column('ParentIndexNumber')} IS NULL THEN '' ELSE ${signed('ParentIndexNumber', 3)} || ' - ' END, CASE WHEN ${column('IndexNumber')} IS NULL THEN '' ELSE ${signed('IndexNumber', 4)} || ' - ' END, COALESCE(${column('Name')}, ''))
      WHEN ${type} IN ('Audio', 'AudioBook') AND COALESCE(${column('ForcedSortName')}, '') = '' THEN concat(CASE WHEN ${column('ParentIndexNumber')} IS NULL THEN '' ELSE ${signed('ParentIndexNumber', 4)} || ' - ' END, CASE WHEN ${column('IndexNumber')} IS NULL THEN '' ELSE ${signed('IndexNumber', 4)} || ' - ' END, COALESCE(${column('Name')}, ''))
      WHEN ${type} = 'Person' THEN ltrim(${forcedOrName}, ${clrTrimCharactersParameter ??= bind(clrWhitespaceCharacters)})
      WHEN ${forcedOrName} IS NULL OR ${forcedOrName} = '' THEN ${forcedOrName}
      WHEN ${withoutDiacritics} ~ '[^\\x00-\\x7F]' AND ${column('SortName')} IS NOT NULL THEN ${column('SortName')}
      ELSE ${withoutDiacritics}
    END`;
    const bytes = fromProject(expression);
    if (alias === 'i') cachedMemorySortName = bytes;
    return bytes;
  };

  if (scope.ids) predicates.push(`${normalizedId('i."Id"')} = ANY(${bindIdArray(scope.ids, 'scope.ids')})`);
  if (itemIdsPlan !== null) {
    const parameterOffset = values.length;
    const relationalText = itemIdsPlan.text.replace(/\$(\d+)/gu,
      (_, index) => `$${Number(index) + parameterOffset}`);
    values.push(...itemIdsPlan.values);
    relationalCtes.push(`requested_item_ids AS (${relationalText})`);
    predicates.push(`${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} IN (SELECT ${nativeTextSql(database.schemaName).guidLower("\"Id\"")} FROM requested_item_ids)`);
  }
  if (scope.seriesPresentationKeys) {
    predicates.push(`i."SeriesPresentationUniqueKey" = ANY(${bindNativeArray(scope.seriesPresentationKeys,
      'scope.seriesPresentationKeys')})`);
  }
  if (Object.hasOwn(scope, 'seriesPresentationKey')) {
    if (scope.seriesPresentationKey !== null && typeof scope.seriesPresentationKey !== 'string') {
      throw new TypeError('scope.seriesPresentationKey must be a string or null.');
    }
    predicates.push(`i."SeriesPresentationUniqueKey" IS NOT DISTINCT FROM ${bindNativeText(scope.seriesPresentationKey)}`);
  }
  if (Object.hasOwn(scope, 'specialSeason')) {
    if (scope.specialSeason !== undefined && typeof scope.specialSeason !== 'boolean') {
      throw new TypeError('scope.specialSeason must be a boolean or undefined.');
    }
    if (scope.specialSeason === true) predicates.push('i."IndexNumber" = 0');
    else if (scope.specialSeason === false) {
      predicates.push('i."IndexNumber" IS NOT NULL AND i."IndexNumber" <> 0');
    }
  }
  if (scope.parentId != null) predicates.push(`${normalizedId('i."ParentId"')} = ${bind(idKey(scope.parentId))}`);
  if (scope.parentIds) predicates.push(`${normalizedId('i."ParentId"')} = ANY(${bindIdArray(scope.parentIds, 'scope.parentIds')})`);
  if (scope.parentOrAncestorId != null) {
    const parent = idKey(scope.parentOrAncestorId);
    predicates.push(`(${normalizedId('i."ParentId"')} = ${bind(parent)} OR EXISTS (SELECT 1 FROM ${ancestors} scope_ancestor WHERE ${nativeTextSql(database.schemaName).guidLower("scope_ancestor.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${normalizedId('scope_ancestor."ParentItemId"')} = ${bind(parent)}))`);
  }
  if (scope.parentOrLinkedId != null) {
    const parent = idKey(scope.parentOrLinkedId);
    let linkedAccess = '';
    if (scope.linkedTopParentIds) {
      const linkedTopParents = bindIdArray(scope.linkedTopParentIds, 'scope.linkedTopParentIds');
      const linkedName = `${leafType('i')} IN ('Person', 'Genre', 'MusicGenre', 'MusicArtist', 'Studio')`;
      const linkedOwner = `EXISTS (SELECT 1 FROM ${baseItems} scope_owner WHERE ${nativeTextSql(database.schemaName).guidLower("scope_owner.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"OwnerId\"")} AND (${normalizedId('scope_owner."TopParentId"')} = ANY(${linkedTopParents}) OR ${normalizedId('scope_owner."Id"')} = ANY(${linkedTopParents})))`;
      linkedAccess = ` AND (${linkedName} OR ${normalizedId('i."TopParentId"')} = ANY(${linkedTopParents}) OR ${normalizedId('i."Id"')} = ANY(${linkedTopParents}) OR ${linkedOwner})`;
    }
    predicates.push(`(${normalizedId('i."ParentId"')} = ${bind(parent)} OR (EXISTS (SELECT 1 FROM ${links} scope_link WHERE ${normalizedId('scope_link."ParentId"')} = ${bind(parent)} AND ${nativeTextSql(database.schemaName).guidLower("scope_link.\"ChildId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")})${linkedAccess}))`);
  }
  if (scope.childParentId != null) predicates.push(`${normalizedId('COALESCE(i."SeasonId", i."ParentId")')} = ${bind(idKey(scope.childParentId))}`);
  if (scope.childParentIds) predicates.push(`${normalizedId('COALESCE(i."SeasonId", i."ParentId")')} = ANY(${bindIdArray(scope.childParentIds, 'scope.childParentIds')})`);
  if (scope.ancestorId != null) predicates.push(`EXISTS (SELECT 1 FROM ${ancestors} a WHERE ${nativeTextSql(database.schemaName).guidLower("a.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${normalizedId('a."ParentItemId"')} = ${bind(idKey(scope.ancestorId))})`);
  if (scope.ancestorIds) predicates.push(`EXISTS (SELECT 1 FROM ${ancestors} a WHERE ${nativeTextSql(database.schemaName).guidLower("a.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${normalizedId('a."ParentItemId"')} = ANY(${bindIdArray(scope.ancestorIds, 'scope.ancestorIds')}))`);
  if (scope.topParentIds) {
    const scopedTopParents = bindIdArray(scope.topParentIds, 'scope.topParentIds');
    const nameExemption = nameAccessTypes.length
      ? ` OR ${leafType('i')} = ANY(${bindTextArray(nameAccessTypes, 'scope name types')})`
      : '';
    predicates.push(`(${normalizedId('i."TopParentId"')} = ANY(${scopedTopParents})${nameExemption})`);
  }
  if (scope.linkedParentId != null) {
    let linkedAccess = '';
    if (scope.linkedTopParentIds) {
      const linkedTopParents = bindIdArray(scope.linkedTopParentIds, 'scope.linkedTopParentIds');
      const linkedName = `${leafType('i')} IN ('Person', 'Genre', 'MusicGenre', 'MusicArtist', 'Studio')`;
      const linkedOwner = `EXISTS (SELECT 1 FROM ${baseItems} scope_owner WHERE ${nativeTextSql(database.schemaName).guidLower("scope_owner.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"OwnerId\"")} AND (${normalizedId('scope_owner."TopParentId"')} = ANY(${linkedTopParents}) OR ${normalizedId('scope_owner."Id"')} = ANY(${linkedTopParents})))`;
      linkedAccess = ` AND (${linkedName} OR ${normalizedId('i."TopParentId"')} = ANY(${linkedTopParents}) OR ${normalizedId('i."Id"')} = ANY(${linkedTopParents}) OR ${linkedOwner})`;
    }
    predicates.push(`(EXISTS (SELECT 1 FROM ${links} lc WHERE ${normalizedId('lc."ParentId"')} = ${bind(idKey(scope.linkedParentId))} AND ${nativeTextSql(database.schemaName).guidLower("lc.\"ChildId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")})${linkedAccess})`);
  }
  if (scope.linkedParentIds) {
    const linkedParents = bindIdArray(scope.linkedParentIds, 'scope.linkedParentIds');
    predicates.push(`EXISTS (SELECT 1 FROM ${links} lc WHERE ${normalizedId('lc."ParentId"')} = ANY(${linkedParents}) AND ${nativeTextSql(database.schemaName).guidLower("lc.\"ChildId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")})`);
  }
  if (scope.boxSetRepositoryId != null) {
    const parent = bind(idKey(scope.boxSetRepositoryId));
    // BoxSet.GetItems recursively traverses hierarchical descendants and any
    // linked folder it encounters, while returning non-folder link targets as
    // leaves.  The recursive relation remains rooted in one requested BoxSet;
    // only the final SQL page is hydrated by the service.
    predicates.push(`${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} IN (
      WITH RECURSIVE box_set_nodes("Id", "IsFolder") AS (
        SELECT box_root."Id", TRUE
        FROM ${baseItems} box_root
        WHERE ${normalizedId('box_root."Id"')} = ${parent}::text
        UNION
        SELECT box_next."Id", box_next."IsFolder"
        FROM box_set_nodes box_parent
        CROSS JOIN LATERAL (
          SELECT box_child."Id", box_child."IsFolder"
          FROM ${baseItems} box_child
          WHERE ${nativeTextSql(database.schemaName).guidLower("box_child.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("box_parent.\"Id\"")} OR EXISTS (
              SELECT 1 FROM ${ancestors} box_ancestor
              WHERE ${nativeTextSql(database.schemaName).guidLower("box_ancestor.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("box_child.\"Id\"")}
                AND ${nativeTextSql(database.schemaName).guidLower("box_ancestor.\"ParentItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("box_parent.\"Id\"")}
            )
          UNION
          SELECT box_linked."Id", box_linked."IsFolder"
          FROM ${links} box_link
          JOIN ${baseItems} box_linked ON ${nativeTextSql(database.schemaName).guidLower("box_linked.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("box_link.\"ChildId\"")}
          WHERE ${nativeTextSql(database.schemaName).guidLower("box_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("box_parent.\"Id\"")}
        ) box_next
        WHERE box_parent."IsFolder" IS TRUE
      )
      SELECT ${nativeTextSql(database.schemaName).guidLower("box_member.\"Id\"")} FROM box_set_nodes box_member
      WHERE ${normalizedId('box_member."Id"')} <> ${parent}::text
    )`);
  }
  if (scope.linkedChildAncestorIds) {
    const scopedAncestors = bindIdArray(scope.linkedChildAncestorIds, 'scope.linkedChildAncestorIds');
    predicates.push(`EXISTS (SELECT 1 FROM ${links} selector_link JOIN ${ancestors} selector_ancestor ON ${nativeTextSql(database.schemaName).guidLower("selector_ancestor.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("selector_link.\"ChildId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("selector_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${normalizedId('selector_ancestor."ParentItemId"')} = ANY(${scopedAncestors}))`);
  }

  if (query.ids?.length) predicates.push(`${normalizedId('i."Id"')} = ANY(${bindIdArray(query.ids, 'ids')})`);
  if (query.channelids?.length) predicates.push(`${normalizedId('i."ChannelId"')} = ANY(${bindIdArray(query.channelids, 'channelids')})`);
  if (query.externalseriesid && clrTrimValue(query.externalseriesid)) predicates.push(`i."ExternalSeriesId" = ${bind(nativeTextBytes(query.externalseriesid))}`);
  if (query.name && clrTrimValue(query.name)) predicates.push(`i."CleanName" = ${bind(nativeTextBytes(cleanValue(query.name)))}`);
  for (const [key, column, operator] of [['minstartdate', 'StartDate', '>='], ['maxstartdate', 'StartDate', '<='],
    ['minenddate', 'EndDate', '>='], ['maxenddate', 'EndDate', '<=']]) {
    if (query[key] == null || key === 'minenddate' && query.hasaired === false || key === 'maxenddate' && query.hasaired === true) continue;
    predicates.push(`${nativeDateKey(`i.${q(column)}`)} ${operator} ${bind(query[key])}`);
  }
  if (query.excludeitemids?.length) predicates.push(`NOT (${normalizedId('i."Id"')} = ANY(${bindIdArray(query.excludeitemids, 'excludeitemids')}))`);
  if (query.includeitemtypes?.length) predicates.push(`${leafType('i')} = ANY(${bindTextArray(query.includeitemtypes, 'includeitemtypes')})`);
  else if (query.excludeitemtypes?.length) predicates.push(`NOT (${leafType('i')} = ANY(${bindTextArray(query.excludeitemtypes, 'excludeitemtypes')}))`);
  if (query.mediatypes?.length) predicates.push(`i."MediaType" = ANY(${bindNativeArray(query.mediatypes, 'mediatypes')})`);
  if (query.years?.length) {
    const years = query.years.map(value => Number(value));
    if (years.some(value => !Number.isSafeInteger(value))) throw new TypeError('years must contain integers.');
    predicates.push(`i."ProductionYear" = ANY(${bind(years)}::integer[])`);
  }

  for (const [key, column] of [['indexnumber', 'IndexNumber'], ['parentindexnumber', 'ParentIndexNumber']]) {
    if (query[key] !== undefined) predicates.push(memoryUserViewFilter && key === 'parentindexnumber'
      ? `(i.${q(column)} IS NULL OR i.${q(column)} = ${bind(query[key])})`
      : `i.${q(column)} = ${bind(query[key])}`);
  }
  if (query.minindexnumber !== undefined) predicates.push(`i."IndexNumber" >= ${bind(query.minindexnumber)}`);
  for (const [key, column] of [['islocked', 'IsLocked'], ['isseries', 'IsSeries'], ['isfolder', 'IsFolder']]) {
    if (query[key] !== undefined) predicates.push(`i.${q(column)} IS ${query[key] ? 'TRUE' : 'FALSE'}`);
  }
  if (query.isairing !== undefined) {
    const now = bind(new Date().toISOString().replace(/Z$/u, '0000Z'));
    const start = nativeDateKey('i."StartDate"'), end = nativeDateKey('i."EndDate"');
    predicates.push(query.isairing
      ? `(${start} <= ${now} AND ${end} >= ${now})`
      : `(${start} > ${now} OR ${end} < ${now})`);
  }
  if (query.hasaired !== undefined) {
    const now = bind(new Date().toISOString().replace(/Z$/u, '0000Z'));
    predicates.push(`${nativeDateKey('i."EndDate"')} ${query.hasaired ? '<=' : '>='} ${now}`);
  }
  if (query.hasdeadparentid === true) {
    // The detached-user-data placeholder satisfies the FK but cannot keep a
    // child alive. Only the immediate physical parent participates here.
    predicates.push(`i."ParentId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM ${baseItems} parent
      WHERE ${normalizedId('parent."Id"')} <> '00000000000000000000000000000001'
        AND ${normalizedId('parent."Id"')} = ${normalizedId('i."ParentId"')})`);
  }
  for (const [key, type] of [['isdeadgenre', 2], ['isdeadstudio', 3]]) {
    if (query[key] === true) {
      // Cleanup uses every raw display value, including unmapped values. Its
      // case-sensitive equality is independent of CleanName and CleanValue.
      predicates.push(`NOT EXISTS (SELECT 1 FROM ${itemValues} value
        WHERE value."Type" = ${bind(type)} AND value."Value" = i."Name")`);
    }
  }
  // BaseItemRepository deliberately treats Movie/Trailer queries as movie-like
  // without restricting the persisted IsMovie column (including TV programs).
  const allMovieTypes = resumableMode === 'repository' && query.ismovie === true && (!query.includeitemtypes?.length
    || query.includeitemtypes.some(type => ['Movie', 'Trailer'].includes(type)));
  if (query.ismovie !== undefined && !allMovieTypes) {
    predicates.push(`i."IsMovie" IS ${query.ismovie ? 'TRUE' : 'FALSE'}`);
  }
  for (const [key, column] of [['mincommunityrating', 'CommunityRating'], ['mincriticrating', 'CriticRating']]) {
    if (query[key] !== undefined) predicates.push(`i.${q(column)} >= ${bind(query[key])}${nativeItemsPlan ? ` AND i.${q(column)} <> 'NaN'::real` : ''}`);
  }
  for (const [key, column, comparison] of [
    ['minpremieredate', 'PremiereDate', '>='], ['maxpremieredate', 'PremiereDate', '<='],
    ['mindatelastsaved', 'DateLastSaved', '>='], ['mindatelastsavedforuser', 'DateLastSaved', '>=']
  ]) if (query[key] !== undefined) predicates.push(`i.${q(column)} IS NOT NULL AND ${nativeDateKey(`i.${q(column)}`)} ${comparison} ${bind(query[key])}`);
  if (query.hasoverview !== undefined) predicates.push(query.hasoverview
    ? `i."Overview" IS NOT NULL AND i."Overview" <> ''`
    : `(i."Overview" IS NULL OR i."Overview" = '')`);
  if (query.isunaired !== undefined) {
    const comparison = query.isunaired ? '>=' : '<';
    predicates.push(`i."PremiereDate" IS NOT NULL AND i."PremiereDate" ${comparison} ${bindNativeText(new Date().toISOString().replace('T', ' ').replace('Z', ''))}`);
  }
  if (query.hasofficialrating !== undefined) {
    const expression = `(i."OfficialRating" IS NOT NULL AND i."OfficialRating" <> '') OR EXISTS (SELECT 1 FROM ${ancestors} rating_ancestor JOIN ${baseItems} rating_item ON ${nativeTextSql(database.schemaName).guidLower("rating_item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("rating_ancestor.\"ItemId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("rating_ancestor.\"ParentItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND rating_item."OfficialRating" IS NOT NULL AND rating_item."OfficialRating" <> '')`;
    predicates.push(query.hasofficialrating ? `(${expression})` : `NOT (${expression})`);
  }
  if (query.officialratings?.length) {
    const ratings = bindNativeArray(query.officialratings, 'officialratings');
    predicates.push(memoryUserViewFilter ? `COALESCE(i."OfficialRating", ''::bytea) = ANY(${ratings})`
      : `(i."OfficialRating" = ANY(${ratings}) OR EXISTS (SELECT 1 FROM ${ancestors} rating_ancestor JOIN ${baseItems} rating_item ON ${nativeTextSql(database.schemaName).guidLower("rating_item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("rating_ancestor.\"ItemId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("rating_ancestor.\"ParentItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND rating_item."OfficialRating" = ANY(${ratings})))`);
  }
  if (memoryUserViewFilter && query.hasparentalrating !== undefined) {
    const hasRating = `(COALESCE(i."CustomRating", '') <> '' OR COALESCE(i."OfficialRating", '') <> '')`;
    predicates.push(query.hasparentalrating ? hasRating : `NOT ${hasRating}`);
  } else if (query.hasparentalrating === false && query.minparentalrating == null
    && query.maxparentalrating == null && !visibility?.blockUnratedTypes?.length) {
    predicates.push('i."InheritedParentalRatingValue" IS NULL');
  }
  if (query.minparentalrating != null) predicates.push(`(i."InheritedParentalRatingValue" IS NULL OR i."InheritedParentalRatingValue" > ${bind(query.minparentalrating.score)} OR (i."InheritedParentalRatingValue" = ${bind(query.minparentalrating.score)} AND COALESCE(i."InheritedParentalRatingSubValue", 0) >= ${bind(query.minparentalrating.subScore ?? 0)}))`);
  if (query.maxparentalrating != null) {
    const score = bind(query.maxparentalrating.score), subScore = bind(query.maxparentalrating.subScore ?? 0);
    const withinRating = alias => `(${alias}."InheritedParentalRatingValue" IS NULL
      OR ${alias}."InheritedParentalRatingValue" < ${score}
      OR (${alias}."InheritedParentalRatingValue" = ${score}
        AND COALESCE(${alias}."InheritedParentalRatingSubValue", 0) <= ${subScore}))`;
    const manualMembers = `SELECT 1 FROM ${links} max_rating_link
      WHERE ${nativeTextSql(database.schemaName).guidLower("max_rating_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND max_rating_link."ChildType" = 0`;
    predicates.push(`${withinRating('i')} AND (NOT EXISTS (${manualMembers}) OR EXISTS (
      SELECT 1 FROM ${links} max_rating_link JOIN ${baseItems} max_rating_child
        ON ${nativeTextSql(database.schemaName).guidLower("max_rating_child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("max_rating_link.\"ChildId\"")}
      WHERE ${nativeTextSql(database.schemaName).guidLower("max_rating_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND max_rating_link."ChildType" = 0
        AND ${withinRating('max_rating_child')}))`);
  }
  if (query.seriesstatuses?.length) {
    const parts = query.seriesstatuses.map(String);
    const patterns = bind(parts.map(nativeTextBytes));
    predicates.push(`EXISTS (SELECT 1 FROM unnest(${patterns}::bytea[]) series_status_pattern("Pattern") WHERE position(series_status_pattern."Pattern" IN i."Data") > 0)`);
  }

  for (const [key, provider] of [['hasimdbid', 'imdb'], ['hastmdbid', 'tmdb'], ['hastvdbid', 'tvdb']]) {
    if (query[key] === undefined) continue;
    const providerKey = bind(nativeTextOrdinalIgnoreCaseKey(provider));
    const exists = nativeItemsPlan ? `EXISTS (SELECT 1 FROM unnest(i."__ProviderKeys", i."__ProviderValues") p("Key","Value")
      WHERE ${sql.ordinalIgnoreCaseKey('p."Key"')}=${providerKey} AND COALESCE(p."Value", ''::bytea)<>''::bytea)`
      : `EXISTS (SELECT 1 FROM ${providers} p WHERE ${nativeTextSql(database.schemaName).guidLower("p.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${ordinalKey('p."ProviderId"')} = ${providerKey}${memoryUserViewFilter ? ` AND COALESCE(p."ProviderValue", '') <> ''` : ''})`;
    predicates.push(query[key] ? exists : `NOT ${exists}`);
  }
  if (resumableMode === 'repository' && query.albumids?.length) predicates.push(`${normalizedId('i."ParentId"')} = ANY(${bindIdArray(query.albumids, 'albumids')})`);

  const valueExists = (type, names, negate = false) => {
    const expression = `EXISTS (SELECT 1 FROM ${itemValuesMap} vm JOIN ${itemValues} v ON ${nativeTextSql(database.schemaName).guidLower("v.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("vm.\"ItemValueId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("vm.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND v."Type" = ${bind(type)} AND v."CleanValue" = ANY(${bindNativeArray(names, 'item value names')}))`;
    predicates.push(negate ? `NOT ${expression}` : expression);
  };
  const memoryPipeValues = (column, names, label) => {
    const requested = bindOrdinalArray(names);
    const populated = !nativeItemsPlan && column === 'Genres' ? ` AND ${clrTrim(`COALESCE(${project(`i.${q(column)}`)}, '')`)} <> ''` : '';
    predicates.push(`EXISTS (SELECT 1 FROM unnest(${memoryList('i', column)}) memory_value("Name") WHERE ${sql.ordinalIgnoreCaseKey('memory_value."Name"')} = ANY(${requested}))${populated}`);
  };
  const memoryPipeSelectorIds = (column, selectorIds, label) => {
    const selectors = bindIdArray(selectorIds, label);
    const populated = !nativeItemsPlan && column === 'Genres' ? ` AND ${clrTrim(`COALESCE(${project(`i.${q(column)}`)}, '')`)} <> ''` : '';
    predicates.push(`EXISTS (SELECT 1 FROM unnest(${memoryList('i', column)}) memory_value("Name") WHERE ${sql.ordinalIgnoreCaseKey('memory_value."Name"')} IN (SELECT ${ordinalKey('selector."Name"')} FROM ${baseItems} selector WHERE ${normalizedId('selector."Id"')} = ANY(${selectors}) AND selector."Name" IS NOT NULL))${populated}`);
  };
  if (query.genres?.length) {
    if (resumableMode === 'memory') memoryPipeValues('Genres', query.genres, 'memory genres');
    else valueExists(2, query.genres.map(cleanValue));
  }
  if (genreIdsPlan !== null) {
    const parameterOffset = values.length;
    const relationalText = genreIdsPlan.text.replace(/\$(\d+)/gu,
      (_, index) => `$${Number(index) + parameterOffset}`);
    values.push(...genreIdsPlan.values);
    relationalCtes.push(`requested_genre_ids("Id") AS (
      SELECT DISTINCT genre_id."Id" FROM (${relationalText}) genre_id WHERE genre_id."Id" IS NOT NULL
    )`);
    relationalCtes.push(`requested_genres("CleanValue") AS (
      SELECT DISTINCT selector."CleanName" FROM ${baseItems} selector
      JOIN requested_genre_ids requested ON ${normalizedId('selector."Id"')} = ${normalizedId('requested."Id"')}
      WHERE selector."CleanName" IS NOT NULL
    )`);
    const relatedGenre = `EXISTS (SELECT 1 FROM ${itemValuesMap} genre_map
      JOIN ${itemValues} genre_value ON ${nativeTextSql(database.schemaName).guidLower("genre_value.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("genre_map.\"ItemValueId\"")}
      WHERE ${nativeTextSql(database.schemaName).guidLower("genre_map.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND genre_value."Type" = 2
        AND genre_value."CleanValue" IN (SELECT "CleanValue" FROM requested_genres))`;
    predicates.push(genreIdsPlan.emptyMatchesAll
      ? `(NOT EXISTS (SELECT 1 FROM requested_genre_ids) OR ${relatedGenre})`
      : relatedGenre);
  }
  const includedTags = [...query.tags ?? []];
  const excludedTags = [];
  for (const [key, tag] of [['issports', 'Sports'], ['isnews', 'News'], ['iskids', 'Kids']]) {
    if (query[key] === true) includedTags.push(tag);
    else if (query[key] === false) excludedTags.push(tag);
  }
  if (includedTags.length) {
    if (nativeItemsPlan) memoryPipeValues('Tags', includedTags, 'live tags');
    else valueExists(4, includedTags.map(cleanValue));
  }
  if (excludedTags.length) valueExists(4, excludedTags.map(cleanValue), true);

  const selectorValueExists = (type, selectorIds, { contributing = false, negate = false } = {}) => {
    if (!selectorIds?.length) return;
    const selector = `SELECT s."CleanName" FROM ${baseItems} s WHERE ${normalizedId('s."Id"')} = ANY(${bindIdArray(selectorIds, 'selector ids')}) AND s."CleanName" IS NOT NULL`;
    let expression = `EXISTS (SELECT 1 FROM ${itemValuesMap} vm JOIN ${itemValues} v ON ${nativeTextSql(database.schemaName).guidLower("v.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("vm.\"ItemValueId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("vm.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND v."Type" ${contributing ? '= 0' : `= ${bind(type)}`} AND v."CleanValue" IN (${selector})`;
    if (contributing) expression += ` AND NOT EXISTS (SELECT 1 FROM ${itemValuesMap} avm JOIN ${itemValues} av ON ${nativeTextSql(database.schemaName).guidLower("av.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("avm.\"ItemValueId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("avm.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND av."Type" = 1 AND av."CleanValue" IN (${selector}))`;
    expression += ')';
    predicates.push(negate ? `NOT ${expression}` : expression);
  };
  if (query.genreids?.length) {
    if (resumableMode === 'memory') memoryPipeSelectorIds('Genres', query.genreids, 'memory genreids');
    else selectorValueExists(2, query.genreids);
  }
  if (query.studioids?.length) {
    if (resumableMode === 'memory') memoryPipeSelectorIds('Studios', query.studioids, 'memory studioids');
    else selectorValueExists(3, query.studioids);
  }
  if (resumableMode === 'memory' && query.studionames?.length) {
    memoryPipeValues('Studios', query.studionames, 'memory studio names');
  } else if (query.studiocleannames?.length) valueExists(3, query.studiocleannames);
  if (query.artistids?.length) {
    const selector = `SELECT s."CleanName" FROM ${baseItems} s WHERE ${normalizedId('s."Id"')} = ANY(${bindIdArray(query.artistids, 'artistids')}) AND s."CleanName" IS NOT NULL`;
    predicates.push(`EXISTS (SELECT 1 FROM ${itemValuesMap} vm JOIN ${itemValues} v ON ${nativeTextSql(database.schemaName).guidLower("v.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("vm.\"ItemValueId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("vm.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND v."Type" IN (0, 1) AND v."CleanValue" IN (${selector}))`);
  }
  if (query.artistcleannames?.length) {
    const names = bindNativeArray(query.artistcleannames, 'artistcleannames');
    predicates.push(`EXISTS (SELECT 1 FROM ${itemValuesMap} vm JOIN ${itemValues} v ON ${nativeTextSql(database.schemaName).guidLower("v.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("vm.\"ItemValueId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("vm.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND v."Type" IN (0, 1) AND v."CleanValue" = ANY(${names}))`);
  }
  if (query.albumartistids?.length) selectorValueExists(1, query.albumartistids);
  if (query.contributingartistids?.length) selectorValueExists(0, query.contributingartistids, { contributing: true });
  if (query.excludeartistids?.length) {
    const selector = `SELECT s."CleanName" FROM ${baseItems} s WHERE ${normalizedId('s."Id"')} = ANY(${bindIdArray(query.excludeartistids, 'excludeartistids')}) AND s."CleanName" IS NOT NULL`;
    predicates.push(`NOT EXISTS (SELECT 1 FROM ${itemValuesMap} vm JOIN ${itemValues} v ON ${nativeTextSql(database.schemaName).guidLower("v.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("vm.\"ItemValueId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("vm.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND v."Type" IN (0, 1) AND v."CleanValue" IN (${selector}))`);
  }

  const personExists = personPredicate => {
    const typePredicate = query.persontypes?.length
      ? ` AND p."PersonType" = ANY(${bindNativeArray(query.persontypes, 'persontypes')})` : '';
    predicates.push(`EXISTS (SELECT 1 FROM ${peopleMap} pm JOIN ${people} p ON ${nativeTextSql(database.schemaName).guidLower("p.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("pm.\"PeopleId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("pm.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${personPredicate}${typePredicate})`);
  };
  if (query.person) personExists(`p."Name" = ${bindNativeText(query.person)}`);
  if (query.personids?.length) {
    personExists(`p."Name" IN (SELECT selector."Name" FROM ${baseItems} selector WHERE ${normalizedId('selector."Id"')} = ANY(${bindIdArray(query.personids, 'personids')}))`);
  }

  if (query.imagetypes?.length) {
    const requested = query.imagetypes.map(value => Number.isFinite(Number(value)) ? Number(value) : ({ Primary: 0, Art: 1, Backdrop: 2, Banner: 3, Logo: 4, Thumb: 5, Disc: 6, Box: 7, Screenshot: 8, Menu: 9, Chapter: 10, BoxRear: 11, Profile: 12 })[value]);
    if (requested.some(value => !Number.isSafeInteger(value))) throw new TypeError('imagetypes contains an unknown value.');
    const selected = bind(requested);
    predicates.push(nativeItemsPlan ? `i."__ImageTypes" && ${selected}::integer[]`
      : `EXISTS (SELECT 1 FROM ${images} image WHERE ${nativeTextSql(database.schemaName).guidLower("image.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND image."ImageType" = ANY(${selected}::integer[]))`);
  }

  let virtual = query.ismissing;
  if (query.excludelocationtypes?.some(value => String(value).toLowerCase() === 'virtual')) virtual = false;
  if (query.locationtypes?.length && query.locationtypes.length < 4) {
    virtual = query.locationtypes.some(value => String(value).toLowerCase() === 'virtual');
  }
  // Jellyfin's repository PrepareFilterQuery forces physical resume items and
  // therefore overrides LocationTypes/IsMissing rather than intersecting it.
  if (virtual !== undefined && !(query.isresumable && resumableMode === 'repository')) {
    predicates.push(`i."IsVirtualItem" IS ${virtual ? 'TRUE' : 'FALSE'}`);
  }

  const relatedDirectOrContainer = directPredicate => `(${directPredicate.replaceAll('item.', 'i.')} OR (i."IsFolder" IS TRUE AND (EXISTS (SELECT 1 FROM ${ancestors} media_ancestor JOIN ${baseItems} item ON ${nativeTextSql(database.schemaName).guidLower("item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("media_ancestor.\"ItemId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("media_ancestor.\"ParentItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${directPredicate}) OR EXISTS (SELECT 1 FROM ${links} media_link JOIN ${baseItems} item ON ${nativeTextSql(database.schemaName).guidLower("item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("media_link.\"ChildId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("media_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${directPredicate}))))`;
  if (query.is3d !== undefined) {
    const expression = relatedDirectOrContainer(`strpos(COALESCE(${project('item."Data"')}, ''), 'Video3DFormat') > 0`);
    predicates.push(query.is3d ? expression : `NOT ${expression}`);
  }
  if (query.videotypes?.length) {
    const patterns = query.videotypes.flatMap(value => [`"VideoType":"${value}"`, `"IsoType":"${value}"`]);
    predicates.push(relatedDirectOrContainer(`EXISTS (SELECT 1 FROM unnest(${bind(patterns.map(nativeTextBytes))}::bytea[]) format_pattern("Value") WHERE position(format_pattern."Value" IN COALESCE(item."Data", '\\x'::bytea)) > 0)`));
  }
  let streamFilterIndex = 0;
  const streamExists = (streamType, languages) => {
    const suffix = streamFilterIndex++;
    const language = languages?.length
      ? ` AND (stream."Language" = ANY(${bindNativeArray(languages.filter(value => value !== 'und'), 'stream languages')})${languages.includes('und') ? ' OR stream."Language" IS NULL OR stream."Language" = \'\'' : ''})`
      : '';
    const directName = `stream_direct_${suffix}`;
    const leavesName = `stream_leaves_${suffix}`;
    const hierarchyName = `stream_hierarchy_${suffix}`;
    const edgesName = `stream_link_edges_${suffix}`;
    const linkedName = `stream_linked_${suffix}`;
    const linkedAncestorsName = `stream_linked_ancestors_${suffix}`;
    const seamName = `stream_seam_${suffix}`;
    const foldersName = `stream_folders_${suffix}`;
    relationalCtes.push(`${directName}("Id") AS (
      SELECT DISTINCT ${normalizedId('stream."ItemId"')}
      FROM ${streams} stream
      WHERE stream."StreamType" = ${bind(streamType)}${language}
    )`);
    relationalCtes.push(`${leavesName}("Id") AS (
      SELECT "Id" FROM ${directName}
      UNION
      SELECT ${normalizedId('version."PrimaryVersionId"')}
      FROM ${baseItems} version
      JOIN ${directName} direct_stream ON direct_stream."Id" = ${normalizedId('version."Id"')}
      WHERE version."PrimaryVersionId" IS NOT NULL
        AND replace(${nativeTextSql(database.schemaName).guidLower("version.\"PrimaryVersionId\"")}, '-', '') <> '00000000000000000000000000000000'
    )`);
    relationalCtes.push(`${hierarchyName}("Id") AS (
      SELECT DISTINCT ${normalizedId('stream_ancestor."ParentItemId"')}
      FROM ${ancestors} stream_ancestor
      JOIN ${leavesName} stream_leaf ON stream_leaf."Id" = ${normalizedId('stream_ancestor."ItemId"')}
    )`);
    relationalCtes.push(`${edgesName}("ChildId", "ParentId") AS (
      SELECT ${normalizedId('stream_link."ChildId"')}, ${normalizedId('stream_link."ParentId"')}
      FROM ${links} stream_link
      WHERE COALESCE(stream_link."ChildType", 0) NOT IN (2, 3)
      UNION
      SELECT ${normalizedId('stream_ancestor."ItemId"')}, ${normalizedId('stream_link."ParentId"')}
      FROM ${ancestors} stream_ancestor
      JOIN ${links} stream_link ON ${nativeTextSql(database.schemaName).guidLower("stream_link.\"ChildId\"")} = ${nativeTextSql(database.schemaName).guidLower("stream_ancestor.\"ParentItemId\"")}
      WHERE COALESCE(stream_link."ChildType", 0) NOT IN (2, 3)
    )`);
    relationalCtes.push(`${linkedName}("Id") AS (
      SELECT stream_edge."ParentId"
      FROM ${edgesName} stream_edge
      WHERE stream_edge."ChildId" IN (
        SELECT "Id" FROM ${leavesName}
        UNION
        SELECT "Id" FROM ${hierarchyName}
      )
      UNION
      SELECT stream_edge."ParentId"
      FROM ${edgesName} stream_edge
      JOIN ${linkedName} linked_parent ON linked_parent."Id" = stream_edge."ChildId"
    )`);
    relationalCtes.push(`${linkedAncestorsName}("Id") AS (
      SELECT DISTINCT ${normalizedId('stream_ancestor."ParentItemId"')}
      FROM ${ancestors} stream_ancestor
      JOIN ${linkedName} linked_parent ON linked_parent."Id" = ${normalizedId('stream_ancestor."ItemId"')}
    )`);
    relationalCtes.push(`${seamName}("Id") AS (
      SELECT DISTINCT ${normalizedId('stream_ancestor."ParentItemId"')}
      FROM ${ancestors} stream_ancestor
      WHERE ${normalizedId('stream_ancestor."ItemId"')} IN (
        SELECT "Id" FROM ${hierarchyName}
        UNION
        SELECT "Id" FROM ${linkedAncestorsName}
      )
    )`);
    relationalCtes.push(`${foldersName}("Id") AS (
      SELECT "Id" FROM ${hierarchyName}
      UNION SELECT "Id" FROM ${linkedName}
      UNION SELECT "Id" FROM ${linkedAncestorsName}
      UNION SELECT "Id" FROM ${seamName}
    )`);
    return `(CASE WHEN i."IsFolder" IS TRUE
      THEN ${normalizedId('i."Id"')} IN (SELECT "Id" FROM ${foldersName})
      ELSE ${normalizedId('i."Id"')} IN (SELECT "Id" FROM ${leavesName}) END)`;
  };
  if (query.hassubtitles !== undefined) {
    const expression = streamExists(2);
    predicates.push(query.hassubtitles ? expression : `NOT ${expression}`);
  }
  if (query.subtitlelanguages?.length) predicates.push(streamExists(2, query.subtitlelanguages));
  if (query.audiolanguages?.length) predicates.push(streamExists(0, query.audiolanguages));

  const folderAwareBoolean = directCondition => `(${directCondition.replaceAll('candidate.', 'i.')} OR EXISTS (SELECT 1 FROM ${ancestors} boolean_ancestor JOIN ${baseItems} candidate ON ${nativeTextSql(database.schemaName).guidLower("candidate.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("boolean_ancestor.\"ItemId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("boolean_ancestor.\"ParentItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${directCondition}) OR EXISTS (SELECT 1 FROM ${links} boolean_link JOIN ${baseItems} candidate ON ${nativeTextSql(database.schemaName).guidLower("candidate.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("boolean_link.\"ChildId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("boolean_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${directCondition}))`;
  if (query.isplaceholder !== undefined) {
    const expression = folderAwareBoolean(`strpos(COALESCE(${project('candidate."Data"')}, ''), 'IsPlaceHolder":true') > 0`);
    predicates.push(query.isplaceholder ? expression : `NOT ${expression}`);
  }
  for (const [key, extraPredicate] of [
    ['hasspecialfeature', `extra."ExtraType" NOT IN (0, 2, 8, 9)`],
    ['hastrailer', `extra."ExtraType" = 2`],
    ['hasthemesong', `extra."ExtraType" = 8`],
    ['hasthemevideo', `extra."ExtraType" = 9`],
  ]) if (query[key] !== undefined) {
    // Native WithPrimaryVersions promotes an extra owner that is an alternate
    // to that alternate's primary once, before folder-aware propagation.
    const ownedBy = ownerId => `(${normalizedId('extra."OwnerId"')} = ${normalizedId(ownerId)} OR EXISTS (SELECT 1 FROM ${baseItems} extra_version WHERE ${normalizedId('extra_version."Id"')} = ${normalizedId('extra."OwnerId"')} AND ${normalizedId('extra_version."PrimaryVersionId"')} = ${normalizedId(ownerId)}))`;
    const owned = `EXISTS (SELECT 1 FROM ${baseItems} extra WHERE ${ownedBy('i."Id"')} AND ${extraPredicate})`;
    const childOwned = `EXISTS (SELECT 1 FROM ${ancestors} extra_ancestor JOIN ${baseItems} extra ON ${ownedBy('extra_ancestor."ItemId"')} WHERE ${nativeTextSql(database.schemaName).guidLower("extra_ancestor.\"ParentItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${extraPredicate})`;
    const linkedChildOwned = `EXISTS (SELECT 1 FROM ${links} extra_link JOIN ${baseItems} extra ON ${ownedBy('extra_link."ChildId"')} WHERE ${nativeTextSql(database.schemaName).guidLower("extra_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${extraPredicate})`;
    const expression = `(${owned} OR ${childOwned} OR ${linkedChildOwned})`;
    predicates.push(query[key] ? expression : `NOT ${expression}`);
  }

  const versionDimension = (column, comparison, value) => `(i.${q(column)} IS NOT NULL AND i.${q(column)} ${comparison} ${bind(value)} OR EXISTS (SELECT 1 FROM ${baseItems} version WHERE ${normalizedId('version."PrimaryVersionId"')} = ${normalizedId('i."Id"')} AND version.${q(column)} IS NOT NULL AND version.${q(column)} ${comparison} ${bind(value)}))`;
  // Alternate-version dimensions are part of Jellyfin's repository predicate.
  for (const [key, column] of [['minwidth', 'Width'], ['minheight', 'Height']]) {
    if (query[key] !== undefined) predicates.push(versionDimension(column, '>=', query[key]));
  }
  for (const [key, column] of [['maxwidth', 'Width'], ['maxheight', 'Height']]) if (query[key] !== undefined) {
    predicates.push(`i.${q(column)} IS NOT NULL AND i.${q(column)} <= ${bind(query[key])} AND NOT EXISTS (SELECT 1 FROM ${baseItems} version WHERE ${normalizedId('version."PrimaryVersionId"')} = ${normalizedId('i."Id"')} AND version.${q(column)} IS NOT NULL AND version.${q(column)} > ${bind(query[key])})`);
  }
  if (query.ishd !== undefined || query.is4k !== undefined) {
    const resolutionBucket = alias => {
      const versions = condition => `EXISTS (SELECT 1 FROM ${baseItems} resolution_version WHERE ${normalizedId('resolution_version."PrimaryVersionId"')} = ${normalizedId(`${alias}."Id"`)} AND ${condition})`;
      const ownSd = `${alias}."Width" IS NOT NULL AND ${alias}."Width" > 0 AND ${alias}."Width" < 1200`;
      const ownHd = `${alias}."Width" IS NOT NULL AND ${alias}."Width" >= 1200`;
      const own4k = `(${alias}."Width" IS NOT NULL AND ${alias}."Width" >= 3800 OR ${alias}."Height" IS NOT NULL AND ${alias}."Height" >= 2100)`;
      const versionsSd = versions('resolution_version."Width" IS NOT NULL AND resolution_version."Width" > 0 AND resolution_version."Width" < 1200');
      const versionsHd = versions('resolution_version."Width" IS NOT NULL AND resolution_version."Width" >= 1200');
      const versions4k = versions('(resolution_version."Width" IS NOT NULL AND resolution_version."Width" >= 3800 OR resolution_version."Height" IS NOT NULL AND resolution_version."Height" >= 2100)');
      const buckets = [];
      if (query.ishd === false) buckets.push(`((${ownSd} OR ${versionsSd}) AND NOT ${versionsHd} AND NOT ${versions4k})`);
      if (query.ishd === true) buckets.push(`((${ownHd} OR ${versionsHd}) AND NOT ${own4k} AND NOT ${versions4k})`);
      if (query.is4k === true) buckets.push(`(${own4k} OR ${versions4k})`);
      return buckets.length ? `(${buckets.join(' OR ')})` : 'FALSE';
    };
    const directResolution = resolutionBucket('i');
    const descendantResolution = resolutionBucket('resolution_item');
    predicates.push(`(CASE WHEN i."IsFolder" IS TRUE THEN
      EXISTS (SELECT 1 FROM ${ancestors} resolution_ancestor
        JOIN ${baseItems} resolution_item ON ${nativeTextSql(database.schemaName).guidLower("resolution_item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("resolution_ancestor.\"ItemId\"")}
        WHERE ${nativeTextSql(database.schemaName).guidLower("resolution_ancestor.\"ParentItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${descendantResolution})
      OR EXISTS (SELECT 1 FROM ${links} resolution_link
        JOIN ${baseItems} resolution_item ON ${nativeTextSql(database.schemaName).guidLower("resolution_item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("resolution_link.\"ChildId\"")}
        WHERE ${nativeTextSql(database.schemaName).guidLower("resolution_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${descendantResolution})
      ELSE ${directResolution} END)`);
  }

  const normalizedSortName = () => resumableMode === 'memory'
    ? invariantLower(`COALESCE(${memorySortName()}, '')`)
    : asciiLower('i."SortName"');
  const hasNameFilter = value => memoryUserViewFilter ? Boolean(value) : Boolean(clrTrimValue(value ?? ''));
  const hasNameStartsWith = hasNameFilter(query.namestartswith);
  const hasNameStartsWithOrGreater = hasNameFilter(query.namestartswithorgreater);
  const hasNameLessThan = hasNameFilter(query.namelessthan);
  const hasSearchTerm = Boolean(query.searchterm?.trim());
  const addNamePredicate = expression => {
    if (collapseTypes === null) predicates.push(expression);
    else if (collapseMode === 'memory') {
      // Folder.Children filters materialized children, collapses them, and then
      // repeats the name filter against any introduced collection entity.
      predicates.push(expression);
      postCollapsePredicates.push(expression);
    } else postCollapsePredicates.push(expression);
  };
  if (resumableMode !== 'memory' && (hasNameStartsWith || hasNameStartsWithOrGreater || hasNameLessThan)) {
    addNamePredicate('i."SortName" IS NOT NULL');
  }
  if (hasNameStartsWith) {
    if (resumableMode === 'memory' && !memoryUserViewFilter) {
      const key = bind(nativeTextOrdinalIgnoreCaseKey(String(query.namestartswith)));
      addNamePredicate(`substring(${ordinalKey(memorySortName())} FROM 1 FOR octet_length(${key}::bytea)) = ${key}::bytea`);
    } else addNamePredicate(sql.sqliteLike(normalizedSortName(), bindNativeText(`${lowerInvariant(String(query.namestartswith))}%`)));
  }
  if (hasNameStartsWithOrGreater) addNamePredicate(resumableMode === 'memory' && !memoryUserViewFilter
    ? `${ordinalKey(memorySortName())} >= ${bind(nativeTextOrdinalIgnoreCaseKey(String(query.namestartswithorgreater)))}`
    : `${normalizedSortName()} >= ${bindNativeText(lowerInvariant(String(query.namestartswithorgreater)))}`);
  if (hasNameLessThan) addNamePredicate(resumableMode === 'memory' && !memoryUserViewFilter
    ? `${ordinalKey(memorySortName())} < ${bind(nativeTextOrdinalIgnoreCaseKey(String(query.namelessthan)))}`
    : `${normalizedSortName()} < ${bindNativeText(lowerInvariant(String(query.namelessthan)))}`);
  if (resumableMode !== 'memory' && hasSearchTerm) {
    const term = String(query.searchterm);
    const normalized = `%${cleanValue(term)}%`, original = `%${asciiLowerValue(term)}%`;
    predicates.push(`(${sql.sqliteLike(asciiLower('i."CleanName"'), bindNativeText(normalized))} OR ${sql.sqliteLike(asciiLower('i."Name"'), bindNativeText(original))} OR ${sql.sqliteLike(asciiLower('i."OriginalTitle"'), bindNativeText(original))})`);
  }

  let preferredFilterUserParameter;
  const preferredFilterUserValue = column => {
    if (userId == null) return 'NULL';
    preferredFilterUserParameter ??= bind(idKey(userId));
    return `(SELECT filter_data.${q(column)} FROM ${userData} filter_data WHERE ${nativeTextSql(database.schemaName).guidLower("filter_data.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${normalizedId('filter_data."UserId"')} = ${preferredFilterUserParameter} ORDER BY CASE WHEN ${nativeTextSql(database.schemaName).guidLower("filter_data.\"CustomDataKey\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} THEN 0 ELSE 1 END, filter_data."CustomDataKey" LIMIT 1)`;
  };
  const userRows = () => userId == null ? null
    : `SELECT 1 FROM ${userData} u WHERE ${nativeTextSql(database.schemaName).guidLower("u.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${normalizedId('u."UserId"')} = ${bind(idKey(userId))}`;
  if (query.isfavorite !== undefined) {
    const expression = memoryUserViewFilter
      ? `COALESCE(${preferredFilterUserValue('IsFavorite')}, FALSE)`
      : `EXISTS (${userRows()} AND u."IsFavorite" IS TRUE)`;
    predicates.push(query.isfavorite ? expression : `NOT ${expression}`);
  }
  if (query.likes !== undefined) {
    if (memoryUserViewFilter) {
      const rating = preferredFilterUserValue('Rating');
      predicates.push(`${rating} IS NOT NULL AND (${rating} >= 6.5) IS ${query.likes ? 'TRUE' : 'FALSE'}`);
    } else {
      const expression = `EXISTS (${userRows()} AND u."Rating" >= 6.5)`;
      predicates.push(query.likes ? expression : `NOT ${expression}`);
    }
  }
  if (query.favoriteorlikes !== undefined && (query.favoriteorlikes || memoryUserViewFilter)) {
    const expression = memoryUserViewFilter
      ? `(COALESCE(${preferredFilterUserValue('IsFavorite')}, FALSE) OR COALESCE(${preferredFilterUserValue('Rating')} >= 6.5, FALSE))`
      : `EXISTS (${userRows()} AND (u."IsFavorite" IS TRUE OR u."Rating" >= 6.5))`;
    predicates.push(query.favoriteorlikes ? expression : `NOT ${expression}`);
  }
  const familyExpression = alias => postgresAliasedVersionFamilyKey(database.schemaName, alias);
  let memoryPlaybackUser;
  const memoryPlaybackUserParameter = () => {
    if (userId == null) return null;
    memoryPlaybackUser ??= bind(idKey(userId));
    return memoryPlaybackUser;
  };
  const memoryLeafPlayed = alias => userId == null ? 'FALSE'
    : `EXISTS (SELECT 1 FROM ${baseItems} memory_played_version JOIN ${userData} memory_played_data ON ${nativeTextSql(database.schemaName).guidLower("memory_played_data.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("memory_played_version.\"Id\"")} WHERE ${familyExpression('memory_played_version')} = ${familyExpression(alias)} AND ${normalizedId('memory_played_data."UserId"')} = ${memoryPlaybackUserParameter()} AND memory_played_data."Played" IS TRUE)`;
  const memoryFolderLeaf = alias => {
    const related = `(${nativeTextSql(database.schemaName).guidLower("memory_leaf.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)} OR EXISTS (SELECT 1 FROM ${ancestors} memory_ancestor WHERE ${nativeTextSql(database.schemaName).guidLower("memory_ancestor.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("memory_leaf.\"Id\"")} AND ${nativeTextSql(database.schemaName).guidLower("memory_ancestor.\"ParentItemId\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)}) OR EXISTS (SELECT 1 FROM ${links} memory_link WHERE ${nativeTextSql(database.schemaName).guidLower("memory_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)} AND (${nativeTextSql(database.schemaName).guidLower("memory_link.\"ChildId\"")} = ${nativeTextSql(database.schemaName).guidLower("memory_leaf.\"Id\"")} OR EXISTS (SELECT 1 FROM ${ancestors} memory_link_ancestor WHERE ${nativeTextSql(database.schemaName).guidLower("memory_link_ancestor.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("memory_leaf.\"Id\"")} AND ${nativeTextSql(database.schemaName).guidLower("memory_link_ancestor.\"ParentItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("memory_link.\"ChildId\"")}))))`;
    return `${related} AND memory_leaf."IsFolder" IS FALSE AND memory_leaf."IsVirtualItem" IS FALSE AND (memory_leaf."OwnerId" IS NULL OR replace(${nativeTextSql(database.schemaName).guidLower("memory_leaf.\"OwnerId\"")}, '-', '') = '00000000000000000000000000000000' OR memory_leaf."ExtraType" IS NOT NULL) AND (memory_leaf."PrimaryVersionId" IS NULL OR NOT EXISTS (SELECT 1 FROM ${baseItems} memory_primary WHERE ${normalizedId('memory_primary."Id"')} = ${normalizedId('memory_leaf."PrimaryVersionId"')} AND ${nativeTextSql(database.schemaName).guidLower("memory_primary.\"TopParentId\"")} IS NOT DISTINCT FROM ${nativeTextSql(database.schemaName).guidLower("memory_leaf.\"TopParentId\"")}))`;
  };
  const memoryPlayed = alias => `(${alias}."IsFolder" IS TRUE AND NOT EXISTS (SELECT 1 FROM ${baseItems} memory_leaf WHERE ${memoryFolderLeaf(alias)} AND NOT ${memoryLeafPlayed('memory_leaf')}) OR ${alias}."IsFolder" IS NOT TRUE AND ${memoryLeafPlayed(alias)})`;
  const preferredMemoryPosition = () => memoryUserViewFilter
    ? preferredFilterUserValue('PlaybackPositionTicks')
    : `(SELECT preferred_data."PlaybackPositionTicks" FROM ${userData} preferred_data WHERE ${nativeTextSql(database.schemaName).guidLower("preferred_data.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND ${normalizedId('preferred_data."UserId"')} = ${bind(idKey(userId))} ORDER BY CASE WHEN ${nativeTextSql(database.schemaName).guidLower("preferred_data.\"CustomDataKey\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} THEN 0 ELSE 1 END, preferred_data."CustomDataKey" LIMIT 1)`;
  if (query.isresumable !== undefined && (query.isresumable || memoryUserViewFilter)) {
    if (resumableMode === 'memory') {
      const resumable = `COALESCE(${preferredMemoryPosition()}, 0) > 0`;
      predicates.push(query.isresumable ? resumable : `NOT (${resumable})`);
    } else {
      const resumeUser = bind(idKey(userId));
      const lastPlayed = '(array_agg(resume_data."LastPlayedDate" ORDER BY resume_data."LastPlayedDate" DESC NULLS LAST))[1]';
      const globalWinners = `SELECT ${nativeTextSql(database.schemaName).guidLower("resume_ranked.\"Id\"")} FROM (SELECT resume_item."Id", row_number() OVER (PARTITION BY ${familyExpression('resume_item')}, CASE WHEN ${lastPlayed} IS NULL THEN 0 ELSE 1 END ORDER BY ${lastPlayed} DESC NULLS LAST, ${nativeTextSql(database.schemaName).guidLower("resume_item.\"Id\"")} ASC) AS __resume_rank FROM ${baseItems} resume_item JOIN ${userData} resume_data ON ${nativeTextSql(database.schemaName).guidLower("resume_data.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("resume_item.\"Id\"")} WHERE ${normalizedId('resume_data."UserId"')} = ${resumeUser} AND resume_data."PlaybackPositionTicks" > 0 GROUP BY resume_item."Id", resume_item."PrimaryVersionId") resume_ranked WHERE resume_ranked.__resume_rank = 1`;
      // Resume eligibility is evaluated against this concrete folder only.
      // Presentation-key replicas are merged later for DTO counters, not for
      // deciding whether each replica itself belongs in the result set.
      const folderMember = `SELECT i."Id"`;
      const folderCandidateIds = `SELECT resume_ancestor."ItemId" FROM ${ancestors} resume_ancestor WHERE ${nativeTextSql(database.schemaName).guidLower("resume_ancestor.\"ParentItemId\"")} IN (SELECT ${nativeTextSql(database.schemaName).guidLower("folder_id.\"Id\"")} FROM (${folderMember}) folder_id) UNION SELECT resume_link."ChildId" FROM ${links} resume_link WHERE ${nativeTextSql(database.schemaName).guidLower("resume_link.\"ParentId\"")} IN (SELECT ${nativeTextSql(database.schemaName).guidLower("folder_id.\"Id\"")} FROM (${folderMember}) folder_id) UNION SELECT linked_ancestor."ItemId" FROM ${links} resume_link JOIN ${ancestors} linked_ancestor ON ${nativeTextSql(database.schemaName).guidLower("linked_ancestor.\"ParentItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("resume_link.\"ChildId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("resume_link.\"ParentId\"")} IN (SELECT ${nativeTextSql(database.schemaName).guidLower("folder_id.\"Id\"")} FROM (${folderMember}) folder_id)`;
      const leafBase = `${nativeTextSql(database.schemaName).guidLower("resume_leaf.\"Id\"")} IN (SELECT ${nativeTextSql(database.schemaName).guidLower("folder_candidate.\"ItemId\"")} FROM (${folderCandidateIds}) folder_candidate) AND resume_leaf."IsFolder" IS FALSE AND resume_leaf."IsVirtualItem" IS FALSE`;
      const defaultLeaf = `${leafBase} AND (resume_leaf."OwnerId" IS NULL OR resume_leaf."ExtraType" IS NOT NULL) AND (resume_leaf."PrimaryVersionId" IS NULL OR NOT EXISTS (SELECT 1 FROM ${baseItems} resume_primary WHERE ${normalizedId('resume_primary."Id"')} = ${normalizedId('resume_leaf."PrimaryVersionId"')} AND ${nativeTextSql(database.schemaName).guidLower("resume_primary.\"TopParentId\"")} IS NOT DISTINCT FROM ${nativeTextSql(database.schemaName).guidLower("resume_leaf.\"TopParentId\"")}))`;
      const leafPlayed = alias => `EXISTS (SELECT 1 FROM ${baseItems} played_version JOIN ${userData} played_data ON ${nativeTextSql(database.schemaName).guidLower("played_data.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("played_version.\"Id\"")} WHERE ${familyExpression('played_version')} = ${familyExpression(alias)} AND ${normalizedId('played_data."UserId"')} = ${resumeUser} AND played_data."Played" IS TRUE)`;
      const progressFolder = `EXISTS (SELECT 1 FROM ${baseItems} resume_leaf JOIN ${userData} leaf_progress ON ${nativeTextSql(database.schemaName).guidLower("leaf_progress.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("resume_leaf.\"Id\"")} WHERE ${leafBase} AND ${normalizedId('leaf_progress."UserId"')} = ${resumeUser} AND leaf_progress."PlaybackPositionTicks" > 0)`;
      const mixedFolder = `EXISTS (SELECT 1 FROM ${baseItems} resume_leaf WHERE ${defaultLeaf} AND ${leafPlayed('resume_leaf')}) AND EXISTS (SELECT 1 FROM ${baseItems} resume_leaf WHERE ${defaultLeaf} AND NOT ${leafPlayed('resume_leaf')})`;
      predicates.push(`((i."IsFolder" IS FALSE AND i."IsVirtualItem" IS FALSE AND ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} IN (${globalWinners})) OR (${leafType('i')} IN ('Series', 'Season') AND (${progressFolder} OR (${mixedFolder}))))`);
    }
  }
  if (excludeVersionFamilyIds.length) {
    const activeIds = bindTextArray(excludeVersionFamilyIds.map(idKey), 'excludeVersionFamilyIds');
    predicates.push(`(i."IsFolder" IS TRUE OR ${familyExpression('i')} NOT IN (SELECT ${familyExpression('active_item')} FROM ${baseItems} active_item WHERE replace(${nativeTextSql(database.schemaName).guidLower("active_item.\"Id\"")}, '-', '') = ANY(${activeIds})))`);
  }
  let repositoryPlayedLeaves, repositoryPlaybackUser;
  const repositoryLeafPlayed = alias => {
    if (userId == null) return 'FALSE';
    repositoryPlaybackUser ??= bind(idKey(userId));
    const same = (a, b) => `${normalizedId(a)} = ${normalizedId(b)}`;
    return `EXISTS (SELECT 1 FROM ${userData} native_played_data WHERE ${normalizedId('native_played_data."UserId"')} = ${repositoryPlaybackUser}
      AND native_played_data."Played" IS TRUE AND (${same('native_played_data."ItemId"', `${alias}."Id"`)}
        OR ${normalizedId('native_played_data."ItemId"')} IN (SELECT ${normalizedId('played_version."Id"')} FROM ${baseItems} played_version
          WHERE ${same('played_version."PrimaryVersionId"', `${alias}."Id"`)})
        OR ${alias}."PrimaryVersionId" IS NOT NULL AND (${same('native_played_data."ItemId"', `${alias}."PrimaryVersionId"`)}
          OR ${normalizedId('native_played_data."ItemId"')} IN (SELECT ${normalizedId('played_sibling."Id"')} FROM ${baseItems} played_sibling
            WHERE ${same('played_sibling."PrimaryVersionId"', `${alias}."PrimaryVersionId"`)}))))`;
  };
  const repositoryPlayed = alias => {
    if (userId == null) return 'FALSE';
    if (!repositoryPlayedLeaves) {
      const { topParentIds: _topParentIds, libraryTopParentIds: _libraryTopParentIds, ...leafVisibility } = visibility ?? {};
      const plan = buildPostgresItemPageQuery(database, { isfolder: false, ismissing: false }, {
        userId, visibility: leafVisibility,
      });
      repositoryPlayedLeaves = plan.text.replace(/\$(\d+)/gu, (_, index) => `$${Number(index) + values.length}`);
      values.push(...plan.values);
    }
    const same = (a, b) => `${normalizedId(a)} = ${normalizedId(b)}`;
    const descendant = `EXISTS (SELECT 1 FROM ${ancestors} played_ancestor
        WHERE ${same('played_ancestor."ParentItemId"', `${alias}."Id"`)} AND ${same('played_ancestor."ItemId"', 'played_leaf."Id"')})
      OR EXISTS (SELECT 1 FROM ${links} played_link WHERE ${same('played_link."ParentId"', `${alias}."Id"`)}
        AND (${same('played_link."ChildId"', 'played_leaf."Id"')} OR EXISTS (SELECT 1 FROM ${ancestors} played_link_ancestor
          WHERE ${same('played_link_ancestor."ParentItemId"', 'played_link."ChildId"')}
            AND ${same('played_link_ancestor."ItemId"', 'played_leaf."Id"')})))`;
    return `((${alias}."IsFolder" IS TRUE AND NOT EXISTS (SELECT 1 FROM ${baseItems} played_leaf
      WHERE played_leaf."Id" IN (SELECT "Id" FROM (${repositoryPlayedLeaves}) played_access)
        AND (${descendant}) AND NOT ${repositoryLeafPlayed('played_leaf')}))
      OR (${alias}."IsFolder" IS FALSE AND ${repositoryLeafPlayed(alias)}))`;
  };
  if (query.isplayed !== undefined) {
    const played = repositoryFolderPlayback ? repositoryPlayed('i') : resumableMode === 'memory' && memoryFolderPlayback
      ? memoryPlayed('i')
      : userId == null ? 'FALSE' : `EXISTS (SELECT 1 FROM ${userData} played_data WHERE ${normalizedId('played_data."UserId"')} = ${bind(idKey(userId))} AND played_data."Played" IS TRUE AND (${nativeTextSql(database.schemaName).guidLower("played_data.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} OR ${normalizedId('played_data."ItemId"')} IN (SELECT ${normalizedId('version."Id"')} FROM ${baseItems} version WHERE ${normalizedId('version."PrimaryVersionId"')} = ${normalizedId('i."Id"')}) OR i."PrimaryVersionId" IS NOT NULL AND (${normalizedId('played_data."ItemId"')} = ${normalizedId('i."PrimaryVersionId"')} OR ${normalizedId('played_data."ItemId"')} IN (SELECT ${normalizedId('sibling."Id"')} FROM ${baseItems} sibling WHERE ${normalizedId('sibling."PrimaryVersionId"')} = ${normalizedId('i."PrimaryVersionId"')}))))`;
    predicates.push(query.isplayed ? played : `NOT ${played}`);
  }

  if (playlistSharing != null) {
    predicates.push(postgresPlaylistSharingPredicate(database, playlistSharing, bind));
  }
  if (visibility != null) {
    if (!visibility || typeof visibility !== 'object' || Array.isArray(visibility)) throw new TypeError('visibility must be an object.');
    const allowedVisibilityKeys = new Set(['topParentIds', 'libraryTopParentIds', 'ratingContext',
      'blockedTags', 'allowedTags', 'maxRating', 'maxSubRating', 'blockUnratedTypes', 'boxSetStandalone',
      'boxSetTopParentExempt', 'boxSetChildRatingMode', 'boxSetRootLookupOnly', 'boxSetUserRootIds', 'boxSetRootFolders', 'boxSetRootFoldersPlan', 'boxSetPathExpansion', 'itemMode',
      'scopeTopParentAccess']);
    const unknown = Object.keys(visibility).filter(key => !allowedVisibilityKeys.has(key));
    if (unknown.length) throw new TypeError(`Unknown visibility option: ${unknown.join(', ')}`);
    const visibilityPredicateStart = predicates.length, ownParentalPredicates = [];
    const parentalPredicate = expression => { ownParentalPredicates.push(expression); predicates.push(expression); };
    if (visibility.boxSetRootLookupOnly !== undefined && typeof visibility.boxSetRootLookupOnly !== 'boolean') {
      throw new TypeError('visibility.boxSetRootLookupOnly must be boolean.');
    }
    const boxSetRootLookupOnly = visibility.boxSetRootLookupOnly === true;
    if (boxSetRootLookupOnly && visibility.boxSetStandalone !== true) {
      throw new TypeError('BoxSet root lookup preflight requires standalone BoxSet visibility.');
    }
    if (visibility.boxSetChildRatingMode != null
      && !['repository', 'memory', 'both'].includes(visibility.boxSetChildRatingMode)) {
      throw new TypeError('visibility.boxSetChildRatingMode must be repository, memory or both.');
    }
    if (visibility.itemMode != null && !['repository', 'standalone'].includes(visibility.itemMode)) {
      throw new TypeError('visibility.itemMode must be repository or standalone.');
    }
    if (visibility.scopeTopParentAccess != null && typeof visibility.scopeTopParentAccess !== 'boolean') {
      throw new TypeError('visibility.scopeTopParentAccess must be boolean.');
    }
    validateRatingContext(visibility.ratingContext, 'visibility.ratingContext');
    const standaloneItemVisibility = visibility.itemMode === 'standalone';
    let standaloneMembershipIsEmpty = null;
    if (visibility.boxSetUserRootIds !== undefined) validateStringArray(visibility.boxSetUserRootIds, 'visibility.boxSetUserRootIds');
    if (visibility.boxSetStandalone && !boxSetRootLookupOnly && visibility.boxSetUserRootIds === undefined) {
      throw new TypeError('Standalone BoxSet visibility requires the actual visible user-root child identities.');
    }
    if (visibility.boxSetRootFolders !== undefined && (!Array.isArray(visibility.boxSetRootFolders)
      || visibility.boxSetRootFolders.some(folder => !folder || typeof folder !== 'object' || Array.isArray(folder)
        || Object.keys(folder).length !== 3 || !['Id', 'Path', 'PhysicalLocations'].every(name => Object.hasOwn(folder, name))
        || typeof folder.Id !== 'string' || folder.Path !== null && typeof folder.Path !== 'string'
        || folder.PhysicalLocations !== null && (!Array.isArray(folder.PhysicalLocations)
          || !folder.PhysicalLocations.every(location => location === null || typeof location === 'string'))))) {
      throw new TypeError('BoxSet root folders require complete typed Id, nullable Path and nullable PhysicalLocations.');
    }
    if (visibility.boxSetRootFoldersPlan !== undefined) {
      validateFolderPlan(visibility.boxSetRootFoldersPlan, 'visibility.boxSetRootFoldersPlan');
      if (visibility.boxSetRootFolders !== undefined) throw new TypeError('BoxSet visibility requires one root-folder source.');
    }
    if (visibility.boxSetStandalone && visibility.boxSetRootFolders === undefined && visibility.boxSetRootFoldersPlan === undefined) {
      throw new TypeError('Standalone BoxSet visibility requires the actual raw user-root folders.');
    }
    if (visibility.boxSetPathExpansion !== undefined && (!visibility.boxSetPathExpansion
      || typeof visibility.boxSetPathExpansion !== 'object' || Array.isArray(visibility.boxSetPathExpansion)
      || Object.keys(visibility.boxSetPathExpansion).length !== 2
      || !['appDataPath', 'metadataPath'].every(name => typeof visibility.boxSetPathExpansion[name] === 'string'))) {
      throw new TypeError('BoxSet path expansion requires complete typed appDataPath and metadataPath strings.');
    }
    if (visibility.topParentIds) validateStringArray(visibility.topParentIds, 'visibility.topParentIds');
    if (visibility.boxSetStandalone || visibility.topParentIds
      && (visibility.scopeTopParentAccess !== false || nameAccessTypes.length)) {
      const topParents = (visibility.topParentIds && visibility.scopeTopParentAccess !== false || nameAccessTypes.length)
        ? bindIdArray(visibility.topParentIds ?? [], 'visibility.topParentIds') : 'NULL::text[]';
      const relatedTopParent = alias => `(${normalizedId(`${alias}."TopParentId"`)} = ANY(${topParents}) OR ${normalizedId(`${alias}."Id"`)} = ANY(${topParents}))`;
      const relatedTagExists = (alias, names) => {
        const valuesParameter = bindNativeArray(names.map(cleanValue), 'visibility related tags');
        return `EXISTS (SELECT 1 FROM ${itemValuesMap} related_permission_map JOIN ${itemValues} related_permission_value ON ${nativeTextSql(database.schemaName).guidLower("related_permission_value.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("related_permission_map.\"ItemValueId\"")} WHERE related_permission_value."Type" = 4 AND related_permission_value."CleanValue" = ANY(${valuesParameter}) AND (${nativeTextSql(database.schemaName).guidLower("related_permission_map.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)} OR ${nativeTextSql(database.schemaName).guidLower("related_permission_map.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."TopParentId"`)} OR ${nativeTextSql(database.schemaName).guidLower("related_permission_map.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."SeriesId"`)} OR ${nativeTextSql(database.schemaName).guidLower("related_permission_map.\"ItemId\"")} IN (SELECT ${nativeTextSql(database.schemaName).guidLower("related_permission_ancestor.\"ParentItemId\"")} FROM ${ancestors} related_permission_ancestor WHERE ${nativeTextSql(database.schemaName).guidLower("related_permission_ancestor.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)})))`;
      };
      const relatedVisibility = [];
      if (nameAccessTypes.length && visibility.blockedTags?.length) relatedVisibility.push(`NOT ${relatedTagExists('access_media', visibility.blockedTags)}`);
      if (nameAccessTypes.length && visibility.allowedTags?.length) relatedVisibility.push(`(${leafType('access_media')} = 'Person' OR ${relatedTagExists('access_media', visibility.allowedTags)})`);
      if (nameAccessTypes.length && visibility.maxRating != null) {
        const relatedMax = bind(visibility.maxRating), relatedSub = bind(visibility.maxSubRating ?? 0);
        const withinRelatedRating = alias => `(${alias}."InheritedParentalRatingValue" IS NULL OR ${alias}."InheritedParentalRatingValue" < ${relatedMax} OR (${alias}."InheritedParentalRatingValue" = ${relatedMax} AND COALESCE(${alias}."InheritedParentalRatingSubValue", 0) <= ${relatedSub}))`;
        relatedVisibility.push(withinRelatedRating('access_media'));
        relatedVisibility.push(`(NOT EXISTS (SELECT 1 FROM ${links} related_rating_link WHERE ${nativeTextSql(database.schemaName).guidLower("related_rating_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("access_media.\"Id\"")} AND related_rating_link."ChildType" = 0) OR EXISTS (SELECT 1 FROM ${links} related_rating_link JOIN ${baseItems} related_rating_child ON ${nativeTextSql(database.schemaName).guidLower("related_rating_child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("related_rating_link.\"ChildId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("related_rating_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("access_media.\"Id\"")} AND related_rating_link."ChildType" = 0 AND ${withinRelatedRating('related_rating_child')}))`);
      }
      if (nameAccessTypes.length && visibility.blockUnratedTypes?.length) {
        relatedVisibility.push(`(access_media."InheritedParentalRatingValue" IS NULL AND access_media."UnratedType" = ANY(${bindNativeArray(visibility.blockUnratedTypes, 'visibility related blockUnratedTypes')})) IS NOT TRUE`);
      }
      const relatedVisibilitySql = relatedVisibility.length ? ` AND ${relatedVisibility.join(' AND ')}` : '';
      const personRelated = `EXISTS (SELECT 1 FROM ${people} access_person JOIN ${peopleMap} access_people_map ON ${nativeTextSql(database.schemaName).guidLower("access_people_map.\"PeopleId\"")} = ${nativeTextSql(database.schemaName).guidLower("access_person.\"Id\"")} JOIN ${baseItems} access_media ON ${nativeTextSql(database.schemaName).guidLower("access_media.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("access_people_map.\"ItemId\"")} WHERE access_person."Name" = i."Name" AND ${relatedTopParent('access_media')}${relatedVisibilitySql})`;
      const valueType = `CASE ${leafType('i')} WHEN 'Genre' THEN 2 WHEN 'MusicGenre' THEN 2 WHEN 'Studio' THEN 3 ELSE NULL END`;
      const valueRelated = `EXISTS (SELECT 1 FROM ${itemValues} access_value JOIN ${itemValuesMap} access_value_map ON ${nativeTextSql(database.schemaName).guidLower("access_value_map.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("access_value.\"ItemValueId\"")} JOIN ${baseItems} access_media ON ${nativeTextSql(database.schemaName).guidLower("access_media.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("access_value_map.\"ItemId\"")} WHERE access_value."CleanValue" = i."CleanName" AND (access_value."Type" = ${valueType} OR (${leafType('i')} = 'MusicArtist' AND access_value."Type" IN (0, 1))) AND ${relatedTopParent('access_media')}${relatedVisibilitySql})`;
      const relatedNames = [];
      if (nameAccessTypes.includes('Person')) relatedNames.push(`(${leafType('i')} = 'Person' AND ${personRelated})`);
      const valueNameTypes = nameAccessTypes.filter(type => type !== 'Person');
      if (valueNameTypes.length) relatedNames.push(`(${leafType('i')} = ANY(${bindTextArray(valueNameTypes, 'visibility value name types')}) AND ${valueRelated})`);
      let boxSetAccess = '';
      if (visibility.boxSetStandalone) {
        const userRootIds = boxSetRootLookupOnly ? null
          : bindTextArray(visibility.boxSetUserRootIds.map(wireGuid), 'visibility.boxSetUserRootIds');
        const libraryFolderIds = `NULLIF(${visibilityColumn('i', 'LibraryFolderIds', `NULLIF((${safeNativeItemData('i')} -> 'LibraryFolderIds')::jsonb,'null'::jsonb)`)}, 'null'::jsonb)`;
        const pathKeyHex = value => value === null ? null : Buffer.from(ordinalIgnoreCaseKey(value), 'utf16le').swap16().toString('hex');
        const pathKeySql = expression => `encode(${sql.ordinalIgnoreCaseKey(expression)},'hex')`;
        const rootFolders = visibility.boxSetRootFoldersPlan === undefined
          ? bind(JSON.stringify(visibility.boxSetRootFolders.map(folder => ({ Id: wireGuid(folder.Id),
            Path: pathKeyHex(folder.Path), PhysicalLocations: folder.PhysicalLocations?.map(pathKeyHex) ?? null }))))
          : `(SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'Id',replace(${sql.guidLower('root_folder."Id"')},'-',''),
              'Path',${pathKeySql('root_folder."Path"')},
              'PhysicalLocations',${folderArrayJson('root_folder."PhysicalLocations"', pathKeySql)}
            ) ORDER BY root_folder."Ordinal"),'[]'::jsonb)
            FROM (${bindFolderPlan(visibility.boxSetRootFoldersPlan, 'visibility.boxSetRootFoldersPlan')}) root_folder)`;
        const expansion = visibility.boxSetPathExpansion ?? { appDataPath: '%AppDataPath%', metadataPath: '%MetadataPath%' };
        const pathExpansion = bind(JSON.stringify([pathKeyHex(expansion.appDataPath), pathKeyHex(expansion.metadataPath)]));
        const terminalPathKey = runtimeTextKey(postgresExpandedPathKeyFunctionName, `terminal."Path",${pathExpansion}::jsonb`);
        // Keep each recursive edge lookup parameterized by its current node;
        // flattening it scans the complete link relation for every candidate.
        const derivedMembership = `(WITH RECURSIVE box_node("Id") AS (
          SELECT i."Id" UNION
          SELECT nested."Id" FROM box_node node CROSS JOIN LATERAL (
            SELECT edge."ChildId" FROM ${links} edge
            WHERE ${normalizedId('edge."ParentId"')}=${normalizedId('node."Id"')} OFFSET 0
          ) nested_link
          JOIN ${baseItems} nested ON ${normalizedId('nested."Id"')}=${normalizedId('nested_link."ChildId"')}
          WHERE ${leafType('nested')}='BoxSet'
        ), box_media AS (
          SELECT linked_item.* FROM box_node node CROSS JOIN LATERAL (
            SELECT edge."ChildId" FROM ${links} edge
            WHERE ${normalizedId('edge."ParentId"')}=${normalizedId('node."Id"')} OFFSET 0
          ) media_link
          JOIN ${baseItems} linked_item ON ${normalizedId('linked_item."Id"')}=${normalizedId('media_link."ChildId"')}
          WHERE ${leafType('linked_item')} NOT IN ('BoxSet','PLACEHOLDER')
        ), box_root_walk("StartId","Id","ParentId","OwnerId","Path","Depth","Seen") AS (
          SELECT media."Id",media."Id",media."ParentId",media."OwnerId",media."Path",0,ARRAY[${normalizedId('media."Id"')}]
          FROM box_media media UNION ALL
          SELECT walk."StartId",next_root."Id",next_root."ParentId",next_root."OwnerId",next_root."Path",walk."Depth"+1,
            walk."Seen" || ${normalizedId('next_root."Id"')}
          FROM box_root_walk walk JOIN LATERAL (
            SELECT parent.* FROM ${baseItems} parent WHERE ${normalizedId('parent."Id"')}=${normalizedId('walk."ParentId"')}
              AND ${leafType('parent')} NOT IN ('AggregateFolder','PLACEHOLDER')
            UNION ALL
            SELECT owner.* FROM ${baseItems} owner WHERE NOT EXISTS (
              SELECT 1 FROM ${baseItems} parent WHERE ${normalizedId('parent."Id"')}=${normalizedId('walk."ParentId"')}
                AND ${leafType('parent')}<>'PLACEHOLDER')
              AND ${normalizedId('owner."Id"')}=${normalizedId('walk."OwnerId"')}
              AND ${leafType('owner')}<>'PLACEHOLDER'
            LIMIT 1
          ) next_root ON TRUE WHERE NOT (${normalizedId('next_root."Id"')}=ANY(walk."Seen"))
        ), box_roots AS (
          SELECT DISTINCT ON ("StartId") "StartId","Path" FROM box_root_walk ORDER BY "StartId","Depth" DESC
        ) SELECT array_remove(array_agg(CASE WHEN ${runtimeTextKey(postgresCollectionFolderMatchFunctionName,
          `jsonb_build_array(encode(${terminalPathKey},'hex'),folder."Document"->'Path',folder."Document"->'PhysicalLocations')`)}
          THEN folder."Document"->>'Id' END),NULL)
          FROM box_roots terminal CROSS JOIN jsonb_array_elements(${rootFolders}::jsonb) folder("Document"))`;
        // Aggregating every raw-folder comparison before intersecting user IDs
        // preserves source-null failures even for an inaccessible raw folder.
        standaloneMembershipIsEmpty = `CASE WHEN ${libraryFolderIds} IS NULL
          THEN COALESCE(cardinality(${derivedMembership}),0)=0
          ELSE jsonb_array_length(${libraryFolderIds})=0 END`;
        if (boxSetRootLookupOnly) {
          // Native calls GetChildren(user,true) only after own parental access,
          // nonempty raw links and complete nonempty folder membership. Root
          // identities and the later child parental checks are not consumed.
          boxSetAccess = ` OR (${leafType('i')} = 'BoxSet' AND CASE WHEN NOT EXISTS (SELECT 1 FROM ${links} direct_link WHERE ${nativeTextSql(database.schemaName).guidLower("direct_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")}) THEN FALSE ELSE NOT (${standaloneMembershipIsEmpty}) END)`;
        } else {
          const membershipAllowed = `CASE WHEN ${libraryFolderIds} IS NULL
            THEN (SELECT COALESCE(cardinality(membership."Ids"),0)=0 OR membership."Ids" && ${userRootIds}
              FROM (SELECT ${derivedMembership} AS "Ids" OFFSET 0) membership)
            ELSE (jsonb_array_length(${libraryFolderIds})=0 OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(${libraryFolderIds}) folder_id("Id")
              WHERE ${runtimeTextKey(postgresNativeJsonGuidKeyFunctionName, 'folder_id."Id"::json')}=ANY(${userRootIds}))) END`;
          boxSetAccess = ` OR (${leafType('i')} = 'BoxSet' AND CASE WHEN NOT EXISTS (SELECT 1 FROM ${links} direct_link WHERE ${nativeTextSql(database.schemaName).guidLower("direct_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")}) THEN TRUE ELSE ${membershipAllowed} END)`;
        }
      } else if (visibility.boxSetTopParentExempt) {
        boxSetAccess = ` OR ${leafType('i')} = 'BoxSet'`;
      }
      const directTopParentAccess = !visibility.topParentIds || visibility.scopeTopParentAccess === false ? 'TRUE'
        : `(${normalizedId('i."TopParentId"')} = ANY(${topParents}) OR ${normalizedId('i."Id"')} = ANY(${topParents}))`;
      const ordinaryAccess = requireRelatedNameAccess && relatedNames.length
        ? `((NOT (${leafType('i')} = ANY(${bindTextArray(nameAccessTypes, 'visibility name access types')})) AND ${directTopParentAccess}) OR ${relatedNames.join(' OR ')})`
        : `(${directTopParentAccess}${relatedNames.length ? ` OR ${relatedNames.join(' OR ')}` : ''})`;
      const scopedAccess = visibility.boxSetStandalone || visibility.boxSetTopParentExempt
        ? `(${leafType('i')} <> 'BoxSet' AND ${ordinaryAccess})` : ordinaryAccess;
      predicates.push(`(${scopedAccess}${boxSetAccess})`);
    }
    const inheritedTagExists = names => {
      const valuesParameter = bindNativeArray(names.map(cleanValue), 'visibility tags');
      return `EXISTS (SELECT 1 FROM ${itemValuesMap} permission_map JOIN ${itemValues} permission_value ON ${nativeTextSql(database.schemaName).guidLower("permission_value.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemValueId\"")} WHERE permission_value."Type" = 4 AND permission_value."CleanValue" = ANY(${valuesParameter}) AND (${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} OR ${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"TopParentId\"")} OR ${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"SeriesId\"")} OR ${nativeTextSql(database.schemaName).guidLower("permission_map.\"ItemId\"")} IN (SELECT ${nativeTextSql(database.schemaName).guidLower("permission_ancestor.\"ParentItemId\"")} FROM ${ancestors} permission_ancestor WHERE ${nativeTextSql(database.schemaName).guidLower("permission_ancestor.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")})))`;
    };
    const memoryTagExists = names => {
      const tags = bindNativeArray(names.map(cleanValue), 'visibility memory tags');
      return `EXISTS (
        SELECT 1
        FROM ${baseItems} memory_tag_item
        CROSS JOIN LATERAL unnest(string_to_array(COALESCE(${project('memory_tag_item."Tags"')}, ''), '|')) memory_tag("Value")
        WHERE (${nativeTextSql(database.schemaName).guidLower("memory_tag_item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} OR ${nativeTextSql(database.schemaName).guidLower("memory_tag_item.\"Id\"")} IN (
          SELECT ${nativeTextSql(database.schemaName).guidLower("memory_tag_ancestor.\"ParentItemId\"")}
          FROM ${ancestors} memory_tag_ancestor
          WHERE ${nativeTextSql(database.schemaName).guidLower("memory_tag_ancestor.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")}
        ))
          AND ${runtimeTextKey(postgresCleanValueFunctionName, fromProject('memory_tag."Value"'))} = ANY(${tags})
      )`;
    };
    const standaloneTagExists = names => memoryBlockedTagExists('i',
      visibility.ratingContext ?? memoryRatingContext, names, 'visibility.ratingContext');
    const standaloneRating = () => {
      const rawRating = `(WITH RECURSIVE direct_rating_chain("Id", "ParentId", "SeasonId", "SeriesId", "Type", "CustomRating", "OfficialRating", "Depth", "Seen") AS (
        SELECT i."Id", i."ParentId", i."SeasonId", i."SeriesId", i."Type",
          ${visibilityColumn('i', 'CustomRating')}, ${visibilityColumn('i', 'OfficialRating')}, 0,
          ARRAY[replace(${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")}, '-', '')]
        UNION ALL
        SELECT direct_parent."Id", direct_parent."ParentId", direct_parent."SeasonId",
          direct_parent."SeriesId", direct_parent."Type", ${visibilityColumn('direct_parent', 'CustomRating')},
          ${visibilityColumn('direct_parent', 'OfficialRating')}, direct_chain."Depth" + 1,
          direct_chain."Seen" || replace(${nativeTextSql(database.schemaName).guidLower("direct_parent.\"Id\"")}, '-', '')
        FROM direct_rating_chain direct_chain
        JOIN ${baseItems} direct_parent ON replace(${nativeTextSql(database.schemaName).guidLower("direct_parent.\"Id\"")}, '-', '')
          = replace(${sql.guidLower(`CASE ${leafType('direct_chain')} WHEN 'Episode' THEN direct_chain."SeasonId" WHEN 'Season' THEN direct_chain."SeriesId" ELSE direct_chain."ParentId" END`)}, '-', '')
        WHERE NOT (replace(${nativeTextSql(database.schemaName).guidLower("direct_parent.\"Id\"")}, '-', '') = ANY(direct_chain."Seen"))
      ) SELECT COALESCE(
        (SELECT "CustomRating" FROM direct_rating_chain
          WHERE "CustomRating" IS NOT NULL AND "CustomRating" <> '' ORDER BY "Depth" LIMIT 1),
        (SELECT "OfficialRating" FROM direct_rating_chain
          WHERE "OfficialRating" IS NOT NULL AND "OfficialRating" <> '' ORDER BY "Depth" LIMIT 1)
      ))`;
      const score = memoryRatingScore('direct_rating."Rating"', 'i',
        visibility.ratingContext ?? memoryRatingContext, 'visibility.ratingContext');
      return { rawRating, score };
    };
    if (visibility.blockedTags?.length) {
      if (standaloneItemVisibility) {
        parentalPredicate(`NOT ${standaloneTagExists(visibility.blockedTags)}`);
      } else if (resumableMode === 'memory') {
        parentalPredicate(`NOT ${memoryTagExists(visibility.blockedTags)}`);
      } else {
        const standaloneBlocked = visibility.boxSetStandalone
          ? ` AND (${leafType('i')} <> 'BoxSet' OR NOT ${memoryTagExists(visibility.blockedTags)})`
          : '';
        parentalPredicate(`(NOT ${inheritedTagExists(visibility.blockedTags)}${standaloneBlocked})`);
      }
    }
    if (visibility.allowedTags?.length) {
      const person = `${leafType('i')} = ANY(${bindTextArray(['Person'], 'allowed tag exemptions')})`;
      const parentExempt = `EXISTS (SELECT 1 FROM ${baseItems} allowed_parent WHERE ${nativeTextSql(database.schemaName).guidLower("allowed_parent.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"ParentId\"")} AND ${leafType('allowed_parent')} IN ('UserRootFolder', 'AggregateFolder', 'UserView'))`;
      if (standaloneItemVisibility) {
        parentalPredicate(`(${person} OR ${parentExempt} OR ${standaloneTagExists(visibility.allowedTags)})`);
      } else if (resumableMode === 'memory') {
        parentalPredicate(`(${person} OR ${parentExempt} OR ${memoryTagExists(visibility.allowedTags)})`);
      } else {
        const standaloneAllowed = visibility.boxSetStandalone
          ? ` AND (${leafType('i')} <> 'BoxSet' OR (${person} OR ${parentExempt} OR ${memoryTagExists(visibility.allowedTags)}))`
          : '';
        parentalPredicate(`((${person} OR ${inheritedTagExists(visibility.allowedTags)})${standaloneAllowed})`);
      }
    }
    if (visibility.maxRating != null) {
      if (standaloneItemVisibility) {
        const direct = standaloneRating();
        const maximum = bind(visibility.maxRating);
        const withinScore = visibility.maxSubRating == null
          ? `(direct_score."Score")[1] <= ${maximum}`
          : `((direct_score."Score")[1] < ${maximum} OR ((direct_score."Score")[1] = ${maximum}
            AND COALESCE((direct_score."Score")[2], 0) <= ${bind(visibility.maxSubRating)}))`;
        parentalPredicate(`EXISTS (SELECT 1
          FROM LATERAL (SELECT ${direct.rawRating} AS "Rating" OFFSET 0) direct_rating
          CROSS JOIN LATERAL (SELECT ${direct.score} AS "Score" OFFSET 0) direct_score
          WHERE direct_score."Score" IS NULL OR ${withinScore})`);
      } else {
        parentalPredicate(`(i."InheritedParentalRatingValue" IS NULL OR i."InheritedParentalRatingValue" < ${bind(visibility.maxRating)} OR (i."InheritedParentalRatingValue" = ${bind(visibility.maxRating)} AND COALESCE(i."InheritedParentalRatingSubValue", 0) <= ${bind(visibility.maxSubRating ?? 0)}))`);
      }
      if (!boxSetRootLookupOnly && ['repository', 'both'].includes(visibility.boxSetChildRatingMode)) {
        const childMax = bind(visibility.maxRating), childSub = bind(visibility.maxSubRating ?? 0);
        const bypassStandaloneRating = visibility.boxSetStandalone && standaloneMembershipIsEmpty
          ? ` OR (${standaloneMembershipIsEmpty})` : '';
        predicates.push(`(${leafType('i')} <> 'BoxSet' OR NOT EXISTS (SELECT 1 FROM ${links} rating_link WHERE ${nativeTextSql(database.schemaName).guidLower("rating_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND rating_link."ChildType" = 0)${bypassStandaloneRating} OR EXISTS (SELECT 1 FROM ${links} rating_link JOIN ${baseItems} rating_child ON ${nativeTextSql(database.schemaName).guidLower("rating_child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("rating_link.\"ChildId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("rating_link.\"ParentId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND rating_link."ChildType" = 0 AND (rating_child."InheritedParentalRatingValue" IS NULL OR rating_child."InheritedParentalRatingValue" < ${childMax} OR (rating_child."InheritedParentalRatingValue" = ${childMax} AND COALESCE(rating_child."InheritedParentalRatingSubValue", 0) <= ${childSub}))))`);
      }
      if (!boxSetRootLookupOnly && ['memory', 'both'].includes(visibility.boxSetChildRatingMode)) {
        const rawRating = `(WITH RECURSIVE rating_display_chain("Id", "ParentId", "SeasonId", "SeriesId", "Type", "CustomRating", "OfficialRating", "Depth", "Seen") AS (
          SELECT rating_child."Id", rating_child."ParentId", rating_child."SeasonId", rating_child."SeriesId",
            rating_child."Type", ${visibilityColumn('rating_child', 'CustomRating')}, ${visibilityColumn('rating_child', 'OfficialRating')}, 0,
            ARRAY[replace(${nativeTextSql(database.schemaName).guidLower("rating_child.\"Id\"")}, '-', '')]
          UNION ALL
          SELECT rating_parent."Id", rating_parent."ParentId", rating_parent."SeasonId", rating_parent."SeriesId",
            rating_parent."Type", ${visibilityColumn('rating_parent', 'CustomRating')}, ${visibilityColumn('rating_parent', 'OfficialRating')},
            rating_chain."Depth" + 1, rating_chain."Seen" || replace(${nativeTextSql(database.schemaName).guidLower("rating_parent.\"Id\"")}, '-', '')
          FROM rating_display_chain rating_chain
          JOIN ${baseItems} rating_parent ON replace(${nativeTextSql(database.schemaName).guidLower("rating_parent.\"Id\"")}, '-', '')
            = replace(${sql.guidLower(`CASE ${leafType('rating_chain')} WHEN 'Episode' THEN rating_chain."SeasonId" WHEN 'Season' THEN rating_chain."SeriesId" ELSE rating_chain."ParentId" END`)}, '-', '')
          WHERE NOT (replace(${nativeTextSql(database.schemaName).guidLower("rating_parent.\"Id\"")}, '-', '') = ANY(rating_chain."Seen"))
        ) SELECT COALESCE(
          (SELECT "CustomRating" FROM rating_display_chain
            WHERE "CustomRating" IS NOT NULL AND "CustomRating" <> '' ORDER BY "Depth" LIMIT 1),
          (SELECT "OfficialRating" FROM rating_display_chain
            WHERE "OfficialRating" IS NOT NULL AND "OfficialRating" <> '' ORDER BY "Depth" LIMIT 1)
        ))`;
        const childRatingContext = visibility.ratingContext ?? memoryRatingContext;
        const score = memoryRatingScore('rating_value."Rating"', 'rating_child',
          childRatingContext, 'visibility.ratingContext');
        const maximum = bind(visibility.maxRating);
        const withinScore = visibility.maxSubRating == null
          ? `(rating_score."Score")[1] <= ${maximum}`
          : `((rating_score."Score")[1] < ${maximum} OR ((rating_score."Score")[1] = ${maximum}
            AND COALESCE((rating_score."Score")[2], 0) <= ${bind(visibility.maxSubRating)}))`;
        const type = leafType('rating_child');
        const blocksUnrated = `(rating_child."IsFolder" IS NOT TRUE
          AND ${type} NOT IN ('Person', 'Genre', 'MusicGenre', 'MusicArtist', 'Studio')
          OR ${type} IN ('BoxSet', 'Series', 'MusicAlbum'))`;
        const category = `CASE WHEN ${type} = 'BoxSet' THEN 'Movie' ELSE rating_child."UnratedType" END`;
        const unratedAllowed = visibility.blockUnratedTypes?.length
          ? `NOT (rating_score."Score" IS NULL AND ${blocksUnrated}
            AND ${category} = ANY(${bindNativeArray(visibility.blockUnratedTypes,
              'visibility child blockUnratedTypes')}))`
          : 'TRUE';
        const ratingAllowed = `EXISTS (SELECT 1
          FROM LATERAL (SELECT ${rawRating} AS "Rating" OFFSET 0) rating_value
          CROSS JOIN LATERAL (SELECT ${score} AS "Score" OFFSET 0) rating_score
          WHERE (rating_score."Score" IS NULL OR ${withinScore}) AND ${unratedAllowed})`;
        const blockedTag = memoryBlockedTagExists('rating_child', childRatingContext,
          visibility.blockedTags ?? [], 'visibility.ratingContext');
        const childAllowed = `(NOT ${blockedTag} AND ${ratingAllowed})`;
        const bypassStandaloneRating = visibility.boxSetStandalone && standaloneMembershipIsEmpty
          ? ` OR (${standaloneMembershipIsEmpty})` : '';
        const resolvedChildren = `SELECT 1 FROM ${links} rating_link JOIN ${baseItems} rating_child
          ON replace(${nativeTextSql(database.schemaName).guidLower("rating_child.\"Id\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("rating_link.\"ChildId\"")}, '-', '')
          WHERE replace(${nativeTextSql(database.schemaName).guidLower("rating_link.\"ParentId\"")}, '-', '') = replace(${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")}, '-', '')
            AND ${leafType('rating_child')}<>'PLACEHOLDER'`;
        predicates.push(`(${leafType('i')} <> 'BoxSet' OR NOT EXISTS (${resolvedChildren})${bypassStandaloneRating} OR EXISTS (${resolvedChildren} AND ${childAllowed}))`);
      }
    }
    if (visibility.blockUnratedTypes?.length && !(resumableMode === 'repository' && query.hasparentalrating === true)) {
      const storedUnratedType = visibility.boxSetStandalone
        ? `CASE WHEN ${leafType('i')} = 'BoxSet' THEN 'Movie' ELSE i."UnratedType" END`
        : 'i."UnratedType"';
      const unratedType = standaloneItemVisibility
        ? `CASE WHEN ${leafType('i')} IN ('LiveTvProgram', 'LiveTvChannel')
          THEN ${fromProject(leafType('i'))} ELSE ${storedUnratedType} END` : storedUnratedType;
      if (standaloneItemVisibility) {
        const direct = standaloneRating();
        const blocksUnrated = `(i."IsFolder" IS NOT TRUE
          AND ${leafType('i')} NOT IN ('Person', 'Genre', 'MusicGenre', 'MusicArtist', 'Studio')
          OR ${leafType('i')} IN ('BoxSet', 'Series', 'MusicAlbum'))`;
        parentalPredicate(`EXISTS (SELECT 1
          FROM LATERAL (SELECT ${direct.rawRating} AS "Rating") direct_rating
          CROSS JOIN LATERAL (SELECT ${direct.score} AS "Score") direct_score
          WHERE direct_score."Score" IS NOT NULL OR NOT (${blocksUnrated}
            AND ${unratedType} = ANY(${bindNativeArray(visibility.blockUnratedTypes,
              'visibility.blockUnratedTypes')})))`);
      } else {
        parentalPredicate(`(i."InheritedParentalRatingValue" IS NULL AND ${unratedType} = ANY(${bindNativeArray(visibility.blockUnratedTypes, 'visibility.blockUnratedTypes')})) IS NOT TRUE`);
      }
    }
    if (visibility.boxSetStandalone) {
      const completeVisibility = predicates.splice(visibilityPredicateStart);
      // PostgreSQL may reorder AND terms. Native BoxSet checks its own
      // parental access before touching LibraryFolderIds or raw root folders.
      const parentalGate = boxSetRootLookupOnly
        ? `${leafType('i')}='BoxSet' AND (${ownParentalPredicates.join(' AND ') || 'TRUE'})`
        : `${leafType('i')}<>'BoxSet' OR (${ownParentalPredicates.join(' AND ') || 'TRUE'})`;
      predicates.push(`CASE WHEN ${parentalGate}
        THEN (${completeVisibility.join(' AND ')}) ELSE FALSE END`);
    }
  }

  if (!includeOwnedItems) predicates.push(`(i."OwnerId" IS NULL OR i."ExtraType" IS NOT NULL)`);
  if (!includeOwnedItems && !includeAlternateVersions && !(query.isresumable && resumableMode === 'repository')) {
    predicates.push(`(i."PrimaryVersionId" IS NULL OR NOT EXISTS (SELECT 1 FROM ${baseItems} primary_item WHERE ${normalizedId('primary_item."Id"')} = ${normalizedId('i."PrimaryVersionId"')} AND ${nativeTextSql(database.schemaName).guidLower("primary_item.\"TopParentId\"")} IS NOT DISTINCT FROM ${nativeTextSql(database.schemaName).guidLower("i.\"TopParentId\"")}))`);
  }

  // LibraryManager sorts live entities, whose scalar getters differ from the
  // nullable repository columns in several important places. Keep those
  // expressions in one place so ordinary Folder.Children and stable BoxSet
  // children use the same comparer values before SQL paging.
  const minDate = `'0001-01-01T00:00:00.0000000Z'`;
  const storedDateOrder = expression => nativeDateTextKey(project(expression));
  const firstNonemptyListValue = (alias, column) => `(SELECT memory_list_part."Value"
    FROM unnest(${memoryList(alias, column)}) WITH ORDINALITY memory_list_part("Value", "Ordinal")
    WHERE memory_list_part."Value" <> ''::bytea ORDER BY memory_list_part."Ordinal" LIMIT 1)`;
  const firstStudio = alias => liveAlias(alias) ? `${alias}."__Studios"[1]` : `CASE WHEN ${alias}."Studios" IS NULL THEN NULL
    ELSE ${fromProject(`split_part(${project(`${alias}."Studios"`)}, '|', 1)`)} END`;
  const naturalTextOrder = expression => ordinalKey(`CASE WHEN ${expression} IS NULL THEN NULL ELSE COALESCE((
    SELECT string_agg(CASE WHEN memory_natural_chunk[1] ~ '^[0-9]+$'
      THEN lpad(COALESCE(NULLIF(ltrim(memory_natural_chunk[1], '0'), ''), '0'), 20, '0')
      ELSE lower(memory_natural_chunk[1]) END, '' ORDER BY memory_natural_ordinal)
    FROM regexp_matches(${project(expression)}, E'[0-9]+|(?:\\x01[01]|[^0-9\\x01])+', 'g')
      WITH ORDINALITY AS memory_natural_parts(memory_natural_chunk, memory_natural_ordinal)
  ), '') END`);
  const presentGuid = expression => `${expression} IS NOT NULL
    AND replace(${nativeTextSql(database.schemaName).guidLower(expression)}, '-', '') <> ''
    AND replace(${nativeTextSql(database.schemaName).guidLower(expression)}, '-', '') <> '00000000000000000000000000000000'`;
  const memorySeriesSortName = alias => {
    const direct = `(SELECT ${memorySortName('memory_series')} FROM ${baseItems} memory_series
      WHERE ${leafType('memory_series')} = 'Series' AND ${nativeTextSql(database.schemaName).guidLower("memory_series.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."SeriesId"`)} LIMIT 1)`;
    const inherited = `(WITH RECURSIVE memory_series_walk("Id", "ParentId", "Depth", "Seen") AS (
      SELECT memory_parent."Id", memory_parent."ParentId", 1,
        ARRAY[replace(${nativeTextSql(database.schemaName).guidLower("memory_parent.\"Id\"")}, '-', '')]
      FROM ${baseItems} memory_parent
      WHERE ${nativeTextSql(database.schemaName).guidLower("memory_parent.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."ParentId"`)}
      UNION ALL
      SELECT memory_parent."Id", memory_parent."ParentId", memory_walk."Depth" + 1,
        memory_walk."Seen" || replace(${nativeTextSql(database.schemaName).guidLower("memory_parent.\"Id\"")}, '-', '')
      FROM memory_series_walk memory_walk
      JOIN ${baseItems} memory_parent ON ${nativeTextSql(database.schemaName).guidLower("memory_parent.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("memory_walk.\"ParentId\"")}
      WHERE NOT (replace(${nativeTextSql(database.schemaName).guidLower("memory_parent.\"Id\"")}, '-', '') = ANY(memory_walk."Seen"))
    ) SELECT ${memorySortName('memory_series')} FROM memory_series_walk memory_walk
      JOIN ${baseItems} memory_series ON ${nativeTextSql(database.schemaName).guidLower("memory_series.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("memory_walk.\"Id\"")}
      WHERE ${leafType('memory_series')} = 'Series' ORDER BY memory_walk."Depth" LIMIT 1)`;
    return `CASE WHEN ${leafType(alias)} = 'AudioBook' THEN ${alias}."SeriesName"
      WHEN ${leafType(alias)} NOT IN ('Episode', 'Season') THEN NULL
      WHEN ${presentGuid(`${alias}."SeriesId"`)} THEN COALESCE(${direct}, ${alias}."SeriesName")
      ELSE COALESCE(${inherited}, ${alias}."SeriesName") END`;
  };
  const memoryOfficialRating = alias => {
    const rating = `${alias}."OfficialRating"`;
    const score = memoryRatingScore(rating, alias,
      memoryRatingContext ?? visibility?.ratingContext, 'memoryRatingContext');
    return [
      `CASE WHEN ${rating} IS NULL OR ${rating} = '' THEN 0 ELSE COALESCE((${score})[1], 0) END`,
      `CASE WHEN ${rating} IS NULL OR ${rating} = '' THEN 0 ELSE COALESCE((${score})[2], 0) END`,
    ];
  };
  const memoryUserValue = (alias, column, aggregate = 'max') => userId == null ? 'NULL'
    : `(SELECT ${column === 'LastPlayedDate' ? `(array_agg(memory_sort_data.${q(column)} ORDER BY memory_sort_data.${q(column)} DESC NULLS LAST))[1]` : `${aggregate}(memory_sort_data.${q(column)})`} FROM ${userData} memory_sort_data
      WHERE ${nativeTextSql(database.schemaName).guidLower("memory_sort_data.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower(`${alias}."Id"`)}
        AND ${normalizedId('memory_sort_data."UserId"')} = ${memoryPlaybackUserParameter()})`;
  const memorySortExpressions = (name, alias = 'i') => {
    const type = leafType(alias);
    switch (name) {
      case 'default':
      case 'isplayed':
      case 'videobitrate':
      case 'airtime':
      case 'seriesdateplayed': return null;
      case 'airedepisodeorder': return [];
      case 'album': return [`${ordinalKey(`CASE WHEN ${type} IN ('Audio', 'AudioBook') THEN ${alias}."Album" ELSE '' END`)}`];
      case 'albumartist': return [`${ordinalKey(`CASE WHEN ${type} IN ('Audio', 'AudioBook', 'MusicAlbum')
        THEN ${firstNonemptyListValue(alias, 'AlbumArtists')} ELSE NULL END`)}`];
      case 'artist': return [`${ordinalKey(`CASE WHEN ${type} IN ('Audio', 'AudioBook')
        THEN ${firstNonemptyListValue(alias, 'Artists')} ELSE '' END`)}`];
      case 'runtime': return [`COALESCE(${alias}."RunTimeTicks", 0)`];
      case 'communityrating':
      case 'criticrating': {
        const value = `${alias}.${q(name === 'communityrating' ? 'CommunityRating' : 'CriticRating')}`;
        return nativeItemsPlan ? [`CASE WHEN ${value} = 'NaN'::real THEN 0 ELSE 1 END`, `COALESCE(${value}, 0)::real`]
          : [`COALESCE(${value}, 0)::real`];
      }
      case 'productionyear': return [`COALESCE(${alias}."ProductionYear", CASE WHEN ${alias}."PremiereDate" IS NULL
        THEN 0 ELSE substring(${project(`${alias}."PremiereDate"`)} from 1 for 4)::integer END, 0)`];
      case 'isfolder': return [`CASE WHEN ${alias}."IsFolder" IS TRUE THEN 0 ELSE 1 END`];
      case 'datecreated': return [`COALESCE(${storedDateOrder(`${alias}."DateCreated"`)}, ${minDate})`];
      case 'dateplayed': return [`COALESCE(${storedDateOrder(memoryUserValue(alias, 'LastPlayedDate'))}, ${minDate})`];
      case 'datelastsearched': return [searchDate(alias), searchHistory(alias, 'Id')];
      case 'datelastcontentadded': return [`CASE WHEN ${alias}."IsFolder" IS TRUE
        THEN COALESCE(${storedDateOrder(`${alias}."DateLastMediaAdded"`)}, ${minDate}) ELSE ${minDate} END`];
      case 'startdate': return [`CASE WHEN ${type} = 'LiveTvProgram'
        THEN COALESCE(${storedDateOrder(`${alias}."StartDate"`)}, ${minDate}) ELSE ${minDate} END`];
      case 'premieredate': return [`CASE WHEN ${alias}."PremiereDate" IS NOT NULL
        THEN ${storedDateOrder(`${alias}."PremiereDate"`)}
        WHEN ${alias}."ProductionYear" BETWEEN 1 AND 9999
          THEN lpad(${alias}."ProductionYear"::text, 4, '0') || '-01-01T00:00:00.0000000Z'
        ELSE ${minDate} END`];
      case 'sortname': return [`${ordinalKey(memorySortName(alias))}`];
      case 'name': return [`${ordinalKey(`${alias}."Name"`)}`];
      case 'seriessortname': return [`${ordinalKey(memorySeriesSortName(alias))}`];
      case 'indexnumber': return [`${alias}."IndexNumber"`];
      case 'parentindexnumber': return [`${alias}."ParentIndexNumber"`];
      case 'isunplayed': return [`CASE WHEN ${memoryPlayed(alias)} THEN 0 ELSE 1 END`];
      case 'playcount': return [`COALESCE(${memoryUserValue(alias, 'PlayCount')}, 0)`];
      case 'isfavoriteorliked': return [`CASE WHEN COALESCE(${memoryUserValue(alias, 'IsFavorite', 'bool_or')}, FALSE)
        OR COALESCE(${memoryUserValue(alias, 'Rating')} >= 6.5, FALSE) THEN 0 ELSE 1 END`];
      case 'officialrating': return memoryOfficialRating(alias);
      case 'studio': return [naturalTextOrder(firstStudio(alias))];
      default: return undefined;
    }
  };
  const extractedInteger = (alias, property) => nativeItemsPlan ? `${alias}.${q('__' + property)}`
    : safeInt32(`(${safeNativeItemData(alias)} ->> '${property}')`);
  const int32 = expression => `(mod(mod((${expression})::bigint + 2147483648, 4294967296)
    + 4294967296, 4294967296) - 2147483648)`;
  const scalarComparison = (left, right) => `CASE WHEN ${left} IS NULL THEN CASE WHEN ${right} IS NULL THEN 0 ELSE -1 END
    WHEN ${right} IS NULL THEN 1 WHEN ${left} < ${right} THEN -1 WHEN ${left} > ${right} THEN 1 ELSE 0 END`;
  const memoryAiredEpisodeComparison = (left, right) => {
    const leftEpisode = `${leafType(left)} = 'Episode'`, rightEpisode = `${leafType(right)} = 'Episode'`;
    const leftSpecial = `COALESCE(${left}."ParentIndexNumber", -1) = 0`;
    const rightSpecial = `COALESCE(${right}."ParentIndexNumber", -1) = 0`;
    const after = alias => extractedInteger(alias, 'AirsAfterSeasonNumber');
    const beforeSeason = alias => extractedInteger(alias, 'AirsBeforeSeasonNumber');
    const beforeEpisode = alias => extractedInteger(alias, 'AirsBeforeEpisodeNumber');
    const specialValue = alias => `(COALESCE(${after(alias)}, ${beforeSeason(alias)}, 0)::bigint * 1000000000
      + CASE WHEN ${after(alias)} IS NULL THEN 0 ELSE 1000000 END
      + ${int32(`COALESCE(${beforeEpisode(alias)}, 0)::bigint * 1000`)}
      + COALESCE(${alias}."IndexNumber", 0)::bigint)`;
    const regularValue = alias => int32(`${int32(`COALESCE(${alias}."ParentIndexNumber", -1)::bigint * 1000`)}
      + COALESCE(${alias}."IndexNumber", -1)::bigint`);
    const regularToSpecial = (regular, special) => `CASE
      WHEN COALESCE(${regular}."ParentIndexNumber", -1) < COALESCE(${after(special)}, ${beforeSeason(special)}, -1) THEN -1
      WHEN COALESCE(${regular}."ParentIndexNumber", -1) > COALESCE(${after(special)}, ${beforeSeason(special)}, -1) THEN 1
      WHEN ${after(special)} IS NOT NULL THEN -1 WHEN ${beforeEpisode(special)} IS NULL THEN 1
      WHEN ${regular}."IndexNumber" IS NULL THEN 0
      WHEN ${regular}."IndexNumber" = ${beforeEpisode(special)} THEN 1
      ELSE ${scalarComparison(`${regular}."IndexNumber"`, beforeEpisode(special))} END`;
    const regularCompare = `CASE WHEN ${regularValue(left)} <> ${regularValue(right)}
      THEN ${scalarComparison(regularValue(left), regularValue(right))}
      WHEN ${left}."PremiereDate" IS NOT NULL AND ${right}."PremiereDate" IS NOT NULL
      THEN ${scalarComparison(storedDateOrder(`${left}."PremiereDate"`), storedDateOrder(`${right}."PremiereDate"`))}
      ELSE 0 END`;
    const episodeCompare = `CASE WHEN ${leftSpecial} AND ${rightSpecial}
      THEN ${scalarComparison(specialValue(left), specialValue(right))}
      WHEN NOT (${leftSpecial}) AND NOT (${rightSpecial}) THEN ${regularCompare}
      WHEN ${leftSpecial} THEN -(${regularToSpecial(right, left)}) ELSE ${regularToSpecial(left, right)} END`;
    return `CASE WHEN NOT (${leftEpisode}) THEN CASE WHEN ${rightEpisode} THEN 1 ELSE 0 END
      WHEN NOT (${rightEpisode}) THEN -1 ELSE ${episodeCompare} END`;
  };

  const stableMemorySource = resumableMode === 'memory' && memorySourceOrder === 'stored-sort-name';
  const order = [];
  if (searchScoreExpression !== null) {
    const collation = `${q(searchCollation.schema)}.${q(searchCollation.name)}`;
    // SearchManager's final stable ordering is provider score, followed by the
    // culture-aware entity SortName. The ordinary item order remains the tail
    // for exact ties, matching the stable in-process sort without materializing
    // or paging provider candidates outside PostgreSQL.
    order.push(`COALESCE(${searchScoreExpression}, 0) DESC`);
    const cultureText = `replace(replace(${project(memorySortName('i'))}, chr(1) || '0', ''), chr(1) || '1', '')`;
    order.push(`(${cultureText}) COLLATE ${collation} ASC NULLS FIRST`);
  }
  if (resumableMode !== 'memory' && hasSearchTerm) {
    const term = String(query.searchterm), normalized = cleanValue(term), original = asciiLowerValue(term);
    order.push(`CASE WHEN i."CleanName" = ${bindNativeText(normalized)} OR ${asciiLower('i."OriginalTitle"')} = ${bindNativeText(original)} THEN 0 WHEN ${sql.sqliteLike('i."CleanName"', bindNativeText(`${normalized} %`))} OR ${sql.sqliteLike(asciiLower('i."OriginalTitle"'), bindNativeText(`${original} %`))} THEN 1 WHEN ${sql.sqliteLike('i."CleanName"', bindNativeText(`${normalized}%`))} OR ${sql.sqliteLike(asciiLower('i."OriginalTitle"'), bindNativeText(`${original}%`))} THEN 2 ELSE 3 END ASC`);
  }
  const requestedSorts = (query.sortby ?? []).map((name, index) => ({ name: String(name).toLowerCase(), index }))
    .filter(entry => entry.name !== 'default');
  let memoryRandomSource = false;
  let sorts = requestedSorts;
  if (resumableMode === 'memory') {
    const lastRandom = sorts.findLastIndex(entry => entry.name === 'random');
    if (lastRandom >= 0) {
      // In-memory Random shuffles the current sequence and discards every
      // earlier lazy OrderBy. Later registered comparers stably sort that
      // shuffled sequence, so random becomes their final tie-break.
      memoryRandomSource = true;
      sorts = sorts.slice(lastRandom + 1);
    }
  }
  const memoryRegisteredSorts = sorts.filter(entry => !['isplayed', 'videobitrate', 'airtime', 'seriesdateplayed']
    .includes(entry.name) && !/^[+-]?\d+$/u.test(entry.name));
  const useMemoryInsertion = resumableMode === 'memory'
    && memoryRegisteredSorts.some(entry => entry.name === 'airedepisodeorder');
  for (const { name, index } of sorts) {
    if (resumableMode === 'memory') {
      if (['isplayed', 'videobitrate', 'airtime', 'seriesdateplayed'].includes(name) || useMemoryInsertion) continue;
      const expressions = memorySortExpressions(name);
      if (expressions === undefined && /^[+-]?\d+$/u.test(name)) continue;
      if (expressions === undefined) throw new Error(`Unsupported PostgreSQL item sort: ${name}`);
      if (expressions === null || expressions.length === 0) continue;
      const dir = memoryDirection(query, index);
      for (const expression of expressions) order.push(`${expression} ${dir} ${nulls(dir)}`);
      continue;
    }
    let dir = direction(query, index);
    if (name === 'random') { order.push('random()'); continue; }
    let expression = SORT_COLUMNS.get(name);
    if (name === 'datelastsearched') {
      order.push(`${searchDate('i')} ${dir} ${nulls(dir)}`, `${searchHistory('i', 'Id')} ${dir}`);
      continue;
    }
    if (['dateplayed', 'playcount', 'isplayed', 'isunplayed', 'isfavoriteorliked'].includes(name)) {
      if (!userId && !searchScores?.length && name !== 'dateplayed'
        && !(resumableMode === 'memory' && name === 'isplayed')) throw new Error(`Sort key ${name} requires a user.`);
      if (repositoryFolderPlayback && ['isplayed', 'isunplayed'].includes(name)) {
        expression = name === 'isplayed' ? repositoryPlayed('i') : `NOT (${repositoryPlayed('i')})`;
      } else if (resumableMode === 'repository' && name !== 'dateplayed') {
        const column = { playcount: 'PlayCount', isplayed: 'Played', isunplayed: 'Played', isfavoriteorliked: 'IsFavorite' }[name];
        expression = `(SELECT u.${q(column)} FROM ${userData} u WHERE ${nativeTextSql(database.schemaName).guidLower('u."ItemId"')} = ${nativeTextSql(database.schemaName).guidLower('i."Id"')}
          AND ${normalizedId('u."UserId"')} = ${bind(idKey(userId))} ORDER BY u."CustomDataKey" LIMIT 1)`;
        if (name === 'isfavoriteorliked') expression = `COALESCE(${expression}, FALSE)`;
        if (name === 'isunplayed') expression = `NOT (${expression})`;
      } else if (name === 'isunplayed') expression = `NOT (${memoryPlayed('i')})`;
      else {
        const column = { dateplayed: 'LastPlayedDate', playcount: 'PlayCount', isplayed: 'Played', isfavoriteorliked: 'IsFavorite' }[name];
        const aggregate = ['isplayed', 'isfavoriteorliked'].includes(name) ? 'bool_or' : 'max';
        let itemPredicate = `${nativeTextSql(database.schemaName).guidLower("u.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")}`;
        if (name === 'dateplayed' && resumableMode === 'repository') {
          itemPredicate = `(${itemPredicate} OR (i."PrimaryVersionId" IS NULL AND ${normalizedId('u."ItemId"')} IN (SELECT ${normalizedId('date_version."Id"')} FROM ${baseItems} date_version WHERE ${normalizedId('date_version."PrimaryVersionId"')} = ${normalizedId('i."Id"')})))`;
        }
        const userPredicate = userId == null ? '' : ` AND ${normalizedId('u."UserId"')} = ${bind(idKey(userId))}`;
        expression = `(SELECT ${column === 'LastPlayedDate' ? `(array_agg(u.${q(column)} ORDER BY u.${q(column)} DESC NULLS LAST))[1]` : `${aggregate}(u.${q(column)})`} FROM ${userData} u WHERE ${itemPredicate}${userPredicate})`;
      }
    }
    if (name === 'seriesdateplayed') {
      const seriesUserPredicate = userId == null ? '' : ` AND ${normalizedId('series_data."UserId"')} = ${bind(idKey(userId))}`;
      expression = `(SELECT (array_agg(series_data."LastPlayedDate" ORDER BY series_data."LastPlayedDate" DESC NULLS LAST))[1] FROM ${baseItems} series_member JOIN ${userData} series_data ON ${nativeTextSql(database.schemaName).guidLower("series_data.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("series_member.\"Id\"")} WHERE series_member."SeriesPresentationUniqueKey" = i."PresentationUniqueKey"${seriesUserPredicate} AND series_data."Played" IS TRUE)`;
    }
    if (['artist', 'albumartist', 'studio'].includes(name)) {
      const type = { artist: 0, albumartist: 1, studio: 3 }[name];
      expression = `(SELECT (array_agg(v."CleanValue" ORDER BY v."CleanValue" ASC NULLS LAST))[1] FROM ${itemValuesMap} vm JOIN ${itemValues} v ON ${nativeTextSql(database.schemaName).guidLower("v.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("vm.\"ItemValueId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("vm.\"ItemId\"")} = ${nativeTextSql(database.schemaName).guidLower("i.\"Id\"")} AND v."Type" = ${bind(type)})`;
    }
    if (!expression && /^[+-]?\d+$/u.test(name)) expression = 'i."SortName"';
    if (!expression) throw new Error(`Unsupported PostgreSQL item sort: ${name}`);
    order.push(`${expression} ${dir} ${nulls(dir)}`);
    if (name === 'sortname') order.push(`i."Name" ${dir} ${nulls(dir)}`);
  }
  if (resumableMode === 'memory' && !useMemoryInsertion) {
    if (memoryRandomSource) order.push('random()');
    else {
      if (stableMemorySource && memoryPresort != null) {
        const name = memoryPresort.toLowerCase();
        if (name === 'random') order.push('random()');
        else {
          const expressions = memorySortExpressions(name);
          if (expressions === undefined || Array.isArray(expressions) && expressions.length === 0) {
            throw new Error(`Unsupported PostgreSQL memory pre-sort: ${name}`);
          }
          if (expressions !== null) for (const expression of expressions) {
            order.push(`${expression} ASC NULLS FIRST`);
          }
        }
      }
      // Folder.GetCachedChildren starts from the repository's binary SortName
      // sequence. In-memory comparers are stable, so it remains the final
      // semantic tie-break after request and optional BoxSet display ordering.
      if (scope.sourceChildren != null) order.push('i."__source_ordinal" ASC', 'i."__source_parent_ordinal" ASC');
      order.push(memorySourceOrder === 'occurrence'
        ? nativeItemsPlan && collapseTypes !== null ? 'i."__collapse_ordinal" ASC' : 'i."__SourceOrdinal" ASC'
        : 'i."SortName" ASC NULLS FIRST');
    }
  } else if (resumableMode !== 'memory' && !hasSearchTerm
    && !sorts.some(entry => ['sortname', 'name'].includes(entry.name))) {
    order.push('i."SortName" ASC NULLS FIRST');
  }
  // PostgreSQL must have a total order or OFFSET pages can duplicate/omit rows.
  if (!useMemoryInsertion) order.push('i."Id" ASC');

  let memoryInsertionComparison;
  let memoryInsertionSourceOrder;
  if (useMemoryInsertion) {
    let completeComparison = '0';
    for (let index = memoryRegisteredSorts.length - 1; index >= 0; index--) {
      const entry = memoryRegisteredSorts[index];
      const sign = memoryDirection(query, entry.index) === 'ASC' ? 1 : -1;
      let entryComparison = '0';
      if (entry.name === 'airedepisodeorder') {
        entryComparison = `(${memoryAiredEpisodeComparison('incoming', 'existing')}) * ${sign}`;
      } else {
        const incoming = memorySortExpressions(entry.name, 'incoming');
        const existing = memorySortExpressions(entry.name, 'existing');
        if (incoming === undefined || existing === undefined || incoming === null || existing === null
          || incoming.length !== existing.length) {
          throw new Error(`Unsupported PostgreSQL memory comparison: ${entry.name}`);
        }
        for (let expressionIndex = incoming.length - 1; expressionIndex >= 0; expressionIndex--) {
          const comparison = `(${scalarComparison(incoming[expressionIndex], existing[expressionIndex])}) * ${sign}`;
          entryComparison = `COALESCE(NULLIF(${comparison}, 0), ${entryComparison})`;
        }
      }
      completeComparison = `COALESCE(NULLIF(${entryComparison}, 0), ${completeComparison})`;
    }
    memoryInsertionComparison = completeComparison;
    memoryInsertionSourceOrder = [];
    if (memoryRandomSource) memoryInsertionSourceOrder.push('random()');
    else {
      if (stableMemorySource && memoryPresort != null) {
        const name = memoryPresort.toLowerCase();
        if (name === 'random') memoryInsertionSourceOrder.push('random()');
        else {
          const expressions = memorySortExpressions(name, 'memory_source');
          if (expressions === undefined || Array.isArray(expressions) && expressions.length === 0) {
            throw new Error(`Unsupported PostgreSQL memory pre-sort: ${name}`);
          }
          if (expressions !== null) for (const expression of expressions) {
            memoryInsertionSourceOrder.push(`${expression} ASC NULLS FIRST`);
          }
        }
      }
      if (scope.sourceChildren != null) memoryInsertionSourceOrder.push('memory_source."__source_ordinal" ASC', 'memory_source."__source_parent_ordinal" ASC');
      memoryInsertionSourceOrder.push(memorySourceOrder === 'occurrence'
        ? nativeItemsPlan && collapseTypes !== null ? 'memory_source."__collapse_ordinal" ASC' : 'memory_source."__SourceOrdinal" ASC'
        : 'memory_source."SortName" ASC NULLS FIRST');
    }
    memoryInsertionSourceOrder.push('memory_source."Id" ASC');
  }

  const startIndex = query.startindex ?? 0;
  const limit = query.limit;
  if (!Number.isSafeInteger(startIndex) || startIndex < 0
    || limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0 && resumableMode !== 'repository')) {
    throw new TypeError('Invalid item query pagination.');
  }
  let pagination = '';
  // SQLite repository Take with a negative count is unbounded; zero still
  // returns an empty page. Public request binding has its own validation.
  if (limit !== undefined && limit >= 0 && !(resumableMode === 'memory' && limit === 0)) pagination += ` LIMIT ${bind(limit)}`;
  if (startIndex) pagination += ` OFFSET ${bind(startIndex)}`;

  const ctes = [
    ...relationalCtes,
    `filtered AS (\n  SELECT i.*${scope.sourceChildren != null ? ', source_child."Ordinal" AS "__source_ordinal", source_child."ParentOrdinal" AS "__source_parent_ordinal"' : ''}\n  FROM ${primaryItems} i\n  ${sourceExpansion}\n  WHERE ${predicates.join('\n    AND ')}\n)`,
  ];
  if (groupByPresentationKey) {
    ctes.push(`group_ranked AS (\n  SELECT filtered.*, row_number() OVER (PARTITION BY "PresentationUniqueKey" ORDER BY ("PrimaryVersionId" IS NOT NULL) ASC, "Id" ASC) AS __group_rank\n  FROM filtered\n)`);
    ctes.push('precollapsed AS (SELECT * FROM group_ranked WHERE __group_rank = 1)');
  } else ctes.push('precollapsed AS (SELECT * FROM filtered)');
  if (collapseTypes !== null) {
    const eligible = collapseTypes.length
      ? `${leafType('candidate')} = ANY(${bindTextArray(collapseTypes, 'collapseTypes')})`
      : 'TRUE';
    let collapseParentScope = '';
    if (collapseMode === 'memory' && collapseCollectionPath !== null) {
      // collectionBoxSets uses nativePathWithin(collectionPath, folder.Path):
      // the physical folder may be the collections directory itself or any
      // native ancestor of it. Compare frozen native keys and require a path
      // separator at the prefix boundary so sibling names cannot collide.
      const collectionWithinRoot = nativeTextSql(database.schemaName).pathWithin(bindNativeText(collapseCollectionPath), 'collapse_root."Path"');
      collapseParentScope = ` AND EXISTS (SELECT 1 FROM ${baseItems} collapse_root JOIN ${baseItems} collapse_aggregate ON ${nativeTextSql(database.schemaName).guidLower("collapse_aggregate.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("collapse_root.\"ParentId\"")} AND ${leafType('collapse_aggregate')} = 'AggregateFolder' WHERE ${nativeTextSql(database.schemaName).guidLower("collapse_root.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("collapse_parent.\"ParentId\"")} AND ${collectionWithinRoot})`;
    }
    const childType = collapseMode === 'repository' ? ' AND collapse_link."ChildType" = 0' : '';
    const containing = `EXISTS (SELECT 1 FROM ${links} collapse_link JOIN ${baseItems} collapse_parent ON ${nativeTextSql(database.schemaName).guidLower("collapse_parent.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("collapse_link.\"ParentId\"")} WHERE ${nativeTextSql(database.schemaName).guidLower("collapse_link.\"ChildId\"")} = ${nativeTextSql(database.schemaName).guidLower("candidate.\"Id\"")}${childType} AND ${leafType('collapse_parent')} = 'BoxSet'${collapseParentScope})`;
    ctes.push(`collapsed_ids AS (\n  SELECT candidate."Id"\n  FROM precollapsed candidate\n  WHERE NOT (${eligible}) OR (${eligible} AND ${leafType('candidate')} <> 'BoxSet' AND NOT ${containing})\n  UNION\n  SELECT collapse_parent."Id"\n  FROM precollapsed candidate\n  JOIN ${links} collapse_link ON ${nativeTextSql(database.schemaName).guidLower("collapse_link.\"ChildId\"")} = ${nativeTextSql(database.schemaName).guidLower("candidate.\"Id\"")}${childType}\n  JOIN ${baseItems} collapse_parent ON ${nativeTextSql(database.schemaName).guidLower("collapse_parent.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("collapse_link.\"ParentId\"")} AND ${leafType('collapse_parent')} = 'BoxSet'${collapseParentScope}\n  WHERE ${eligible}\n)`);
    if (nativeItemsPlan) {
      const sql = nativeTextSql(database.schemaName);
      ctes.push(`collapsed_source AS (
        SELECT item.* FROM precollapsed item JOIN collapsed_ids ON ${sql.guidKey('collapsed_ids."Id"')}=${sql.guidKey('item."Id"')}
        UNION ALL SELECT item.* FROM native_query_repository_items item JOIN collapsed_ids ON ${sql.guidKey('collapsed_ids."Id"')}=${sql.guidKey('item."Id"')}
        WHERE NOT EXISTS(SELECT 1 FROM precollapsed captured WHERE ${sql.guidKey('captured."Id"')}=${sql.guidKey('item."Id"')})
      )`);
      const contributes = `(${sql.guidKey('candidate."Id"')}=${sql.guidKey('item."Id"')}
        OR (${eligible}) AND ${leafType('candidate')} IN ('Movie','Series') AND EXISTS (
          SELECT 1 FROM ${links} relation WHERE ${sql.guidKey('relation."ChildId"')}=${sql.guidKey('candidate."Id"')}
          AND ${sql.guidKey('relation."ParentId"')}=${sql.guidKey('item."Id"')}))`;
      const category = collapseTypes.length === 1 ? `CASE WHEN EXISTS(SELECT 1 FROM precollapsed candidate
        WHERE (${eligible}) AND ${contributes}) THEN 0 ELSE 1 END,` : '';
      ctes.push(`collapsed AS (SELECT item.*, row_number() OVER(ORDER BY ${category}
        (SELECT min(candidate."__SourceOrdinal") FROM precollapsed candidate WHERE ${contributes}),
        item."SortName" ASC NULLS FIRST,item."Id") AS "__collapse_ordinal" FROM collapsed_source item)`);
    } else ctes.push(`collapsed AS (\n  SELECT item.*\n  FROM ${baseItems} item\n  JOIN collapsed_ids ON ${nativeTextSql(database.schemaName).guidLower("collapsed_ids.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("item.\"Id\"")}\n)`);
  } else ctes.push('collapsed AS (SELECT * FROM precollapsed)');
  ctes.push(postCollapsePredicates.length
    ? `selected AS (SELECT i.* FROM collapsed i WHERE ${postCollapsePredicates.join('\n    AND ')})`
    : 'selected AS (SELECT * FROM collapsed)');
  if (useMemoryInsertion) {
    ctes.push(`memory_sort_input AS (
      SELECT memory_source.*, row_number() OVER (ORDER BY ${memoryInsertionSourceOrder.join(', ')}) AS "__input_ordinal",
        count(*) OVER () AS "__input_count"
      FROM selected memory_source
    )`);
    // Stable sorting tracks occurrences. Same-ID objects can carry different
    // live fields and must never join one another through their shared Guid.
    ctes.push(`memory_sort_state("Step", "Keys", "InputCount") AS (
      SELECT 0::bigint, ARRAY[]::bigint[], count(*)::bigint FROM memory_sort_input
      UNION ALL
      SELECT memory_state."Step" + 1,
        CASE WHEN memory_insertion."Ordinal" IS NULL THEN memory_state."Keys" || incoming."__input_ordinal"
          WHEN memory_insertion."Ordinal" = 1 THEN ARRAY[incoming."__input_ordinal"] || memory_state."Keys"
          ELSE memory_state."Keys"[1:memory_insertion."Ordinal" - 1] || ARRAY[incoming."__input_ordinal"]
            || memory_state."Keys"[memory_insertion."Ordinal":cardinality(memory_state."Keys")] END,
        memory_state."InputCount"
      FROM memory_sort_state memory_state
      JOIN memory_sort_input incoming ON incoming."__input_ordinal" = memory_state."Step" + 1
      LEFT JOIN LATERAL (
        SELECT memory_existing_position."Ordinal"
        FROM unnest(memory_state."Keys") WITH ORDINALITY memory_existing_position("Key", "Ordinal")
        JOIN memory_sort_input existing ON existing."__input_ordinal"=memory_existing_position."Key"
        WHERE ${memoryInsertionComparison} < 0
        ORDER BY memory_existing_position."Ordinal" LIMIT 1
      ) memory_insertion ON TRUE
      WHERE memory_state."Step" < memory_state."InputCount"
    )`);
    ctes.push(`memory_ordered AS (
      SELECT memory_position."Key", memory_position."Ordinal" AS "__memory_ordinal"
      FROM memory_sort_state memory_state
      CROSS JOIN LATERAL unnest(memory_state."Keys") WITH ORDINALITY memory_position("Key", "Ordinal")
      WHERE memory_state."Step" = memory_state."InputCount"
    )`);
    const finalOrder = [...order, 'memory_ordered."__memory_ordinal" ASC', 'i."Id" ASC'];
    ctes.push(`ordered_base AS (\n  SELECT i."Id"${nativeItemsPlan ? ', i."__SlotKey"' : ''}, row_number() OVER (ORDER BY ${finalOrder.join(', ')}) AS __ordinal\n  FROM memory_sort_input i\n  JOIN memory_ordered ON memory_ordered."Key"=i."__input_ordinal"\n)`);
  } else {
    ctes.push(`ordered_base AS (\n  SELECT i."Id"${nativeItemsPlan ? ', i."__SlotKey"' : ''}, row_number() OVER (ORDER BY ${order.join(', ')}) AS __ordinal\n  FROM selected i\n)`);
  }
  if (query.adjacentto) {
    const adjacentId = bind(idKey(query.adjacentto));
    ctes.push(`anchor AS (SELECT __ordinal FROM ordered_base WHERE replace(${nativeTextSql(database.schemaName).guidLower("\"Id\"")}, '-', '') = ${adjacentId} LIMIT 1)`);
    ctes.push('ordered AS (SELECT ordered_base.* FROM ordered_base CROSS JOIN anchor WHERE ordered_base.__ordinal BETWEEN greatest(anchor.__ordinal - 1, 1) AND anchor.__ordinal + 1)');
  } else ctes.push('ordered AS (SELECT * FROM ordered_base)');
  ctes.push(`page AS (SELECT "Id"${nativeItemsPlan ? ', "__SlotKey"' : ''}, __ordinal FROM ordered ORDER BY __ordinal${pagination})`);
  ctes.push('total AS (SELECT count(*)::bigint AS "TotalRecordCount" FROM ordered)');
  const requestedPageOrder = !nativeItemsPlan && !searchScores?.length && query.ids?.length > 1 && !query.sortby?.length
    ? `array_position(${bindTextArray(query.ids.map(idKey), 'requested page ids')}, replace(${nativeTextSql(database.schemaName).guidLower("page.\"Id\"")}, '-', '')) NULLS LAST, `
    : '';
  const ordinal = includeOrdinal ? `, row_number() OVER (ORDER BY ${requestedPageOrder}page.__ordinal NULLS LAST) AS "__ordinal"` : '';
  const text = `WITH RECURSIVE ${ctes.join(',\n')}\nSELECT page."Id", total."TotalRecordCount"${nativeItemsPlan ? ', page."__SlotKey"' : ''}${ordinal}\nFROM total\nLEFT JOIN page ON TRUE\nORDER BY page.__ordinal NULLS LAST`;
  const orderedText = requestedPageOrder
    ? text.replace('ORDER BY page.__ordinal NULLS LAST', `ORDER BY ${requestedPageOrder}page.__ordinal NULLS LAST`)
    : text;
  return Object.freeze({ text: orderedText, values: Object.freeze(values), startIndex, limit });
}

/** Execute a bounded, relational PostgreSQL item query and decode only its page. */
export async function queryPostgresItemPage(database, query, options = {}) {
  const plan = buildPostgresItemPageQuery(database, query, options);
  const execute = async session => {
    let result;
    try { result = await session.client.query({ text: plan.text, values: plan.values, signal: options.signal }); }
    catch (error) {
      if (error.code === 'MM002') throw Object.assign(new TypeError("Value cannot be null. (Parameter 'source')", { cause: error }),
        { status: 400, statusCode: 400, nativeException: 'ArgumentNullException', parameterName: 'source' });
      throw error;
    }
    const ids = result.rows.map(row => row.Id == null ? null : decodeNativeTextBytes(row.Id)).filter(id => id != null);
    const total = result.rows.length ? Number(result.rows[0].TotalRecordCount) : 0;
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('PostgreSQL returned an invalid item count.');
    const rows = ids.length ? await session.rows('BaseItems', { whereIn: { Id: ids } }) : [];
    const byId = new Map(rows.map(row => [String(row.Id).toLowerCase(), row]));
    return {
      rows: ids.map(id => byId.get(String(id).toLowerCase())).filter(Boolean),
      total,
      startIndex: plan.startIndex,
      plan,
      ...(options.nativeItemsPlan ? { slots: result.rows.filter(row => row.Id != null).map(row => ({
        id: decodeNativeTextBytes(row.Id), slot: row.__SlotKey,
      })) } : {}),
    };
  };
  const projectionCount = options.nativeVisibilityProjections?.length ?? 0;
  return options.nativeItemsPlan || projectionCount > 0
    ? withPostgresNativeQueryJitOff(database, execute)
    : execute(database);
}

function rebasePostgresParameters(text, offset) {
  if (!offset) return text;
  return text.replace(/\$(\d+)/gu, (_match, ordinal) => `$${Number(ordinal) + offset}`);
}

/**
 * Count direct children for every projected folder in one relational query.
 *
 * DtoService asks ItemCountService for persisted source-parent counts, rather
 * than invoking a Folder's virtual GetChildCount. Accessible linked relation
 * rows take precedence over hierarchy, retain duplicates and ignore the
 * hierarchy-only missing-item filter. Each requested source occurrence is
 * then summed independently, including repeated physical source identifiers.
 * Persisted folders sharing an ordinal presentation key instead count distinct
 * hierarchical child keys across every member, even when that total is zero.
 */
export async function queryPostgresDtoChildCounts(database, requests, query = {}, options = {}) {
  if (database?.dialect !== 'postgres') throw new TypeError('PostgreSQL child counts require PostgreSQL.');
  if (!Array.isArray(requests) || requests.some(request => !request
    || typeof request.key !== 'string' || !Array.isArray(request.parentIds)
    || request.parentIds.some(id => typeof id !== 'string')
    || typeof request.linkEligible !== 'boolean')) {
    throw new TypeError('Child-count requests require a key, parent identifiers and link eligibility.');
  }
  const flattened = requests.flatMap(request => request.parentIds.map(parentId => ({
    itemKey: request.key,
    parentKey: idKey(parentId),
    linkEligible: request.linkEligible,
  })));
  if (!flattened.length) return new Map(requests.map(request => [request.key, 0]));

  const parentIds = [...new Map(flattened.map(entry => [entry.parentKey, entry.parentKey])).values()];
  const baseItems = table(database, 'BaseItems');
  const links = table(database, 'LinkedChildren');
  const nativeSql = nativeTextSql(database.schemaName);
  const normalized = expression => nativeSql.guidKey(expression);
  const nonemptyKey = expression => `${expression} IS NOT NULL AND octet_length(${expression}) > 0`;
  // Keep membership entirely relational. Even a request for one folder can
  // include many same-key members, whose child IDs must not cross into Node.
  const hierarchyIds = {
    text: `WITH requested_parent AS (
      SELECT source."Id",source."PresentationUniqueKey" FROM ${baseItems} source
      WHERE ${normalized('source."Id"')} = ANY($1::text[])
    ), member_ids AS (
      SELECT unnest($1::text[]) AS "MemberKey"
      UNION
      SELECT ${normalized('member."Id"')} FROM ${baseItems} member JOIN requested_parent source
        ON member."IsFolder" IS TRUE AND ${nonemptyKey('source."PresentationUniqueKey"')}
          AND member."PresentationUniqueKey" = source."PresentationUniqueKey"
    ) SELECT child."Id" FROM ${baseItems} child JOIN member_ids member
      ON ${normalized('COALESCE(child."SeasonId",child."ParentId")')} = member."MemberKey"`,
    values: [parentIds],
  };
  // InternalItemsQuery(user) is passed directly to ApplyAccessFiltering: it
  // contains parental/tag restrictions but no prepared library/root scope.
  const { topParentIds: _topParents, libraryTopParentIds: _libraries,
    ...accessVisibility } = options.visibility ?? {};
  const planOptions = {
    userId: options.userId,
    visibility: options.userId == null ? undefined : accessVisibility,
  };
  const { ismissing: _hierarchicalMissing, ...linkedQuery } = query;
  const linkedPlan = buildPostgresItemPageQuery(database, linkedQuery, {
    ...planOptions,
    scope: { linkedParentIds: parentIds },
  });
  const hierarchicalPlan = buildPostgresItemPageQuery(database, options.userId == null ? linkedQuery : query, {
    ...planOptions,
    itemIdsPlan: hierarchyIds,
  });
  const values = [...linkedPlan.values, ...hierarchicalPlan.values];
  const bind = value => { values.push(value); return `$${values.length}`; };
  const requestedItems = `${bind(flattened.map(entry => entry.itemKey))}::text[]`;
  const requestedParents = `${bind(flattened.map(entry => entry.parentKey))}::text[]`;
  const requestedLinkEligibility = `${bind(flattened.map(entry => entry.linkEligible))}::boolean[]`;
  const result = await database.client.query({
    text: `/* dto-child-counts */
      WITH requested AS (
        SELECT * FROM unnest(${requestedItems}, ${requestedParents}, ${requestedLinkEligibility})
          WITH ORDINALITY AS source("ItemKey", "ParentKey", "LinkEligible", "Ordinal")
      ), parents AS (
        SELECT DISTINCT "ParentKey" FROM requested
      ), merged_members AS (
        SELECT parents."ParentKey",member."Id" AS "MemberId"
        FROM parents JOIN ${baseItems} source ON ${normalized('source."Id"')}=parents."ParentKey"
        JOIN ${baseItems} member ON member."IsFolder" IS TRUE
          AND ${nonemptyKey('source."PresentationUniqueKey"')}
          AND member."PresentationUniqueKey"=source."PresentationUniqueKey"
      ), merged_parents AS (
        SELECT "ParentKey" FROM merged_members GROUP BY "ParentKey" HAVING count(*) > 1
      ), linked_eligible AS (
        ${linkedPlan.text}
      ), hierarchical_eligible AS (
        ${rebasePostgresParameters(hierarchicalPlan.text, linkedPlan.values.length)}
      ), linked_counts AS (
        SELECT parents."ParentKey", count(*)::bigint AS "Count"
        FROM parents
        JOIN ${links} link ON ${normalized('link."ParentId"')} = parents."ParentKey"
        JOIN linked_eligible ON ${nativeTextSql(database.schemaName).guidLower("linked_eligible.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("link.\"ChildId\"")}
        JOIN ${baseItems} child ON ${nativeTextSql(database.schemaName).guidLower("child.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("link.\"ChildId\"")}
        ${options.userId == null ? 'WHERE child."PrimaryVersionId" IS NULL' : ''}
        GROUP BY parents."ParentKey"
      ), hierarchical_counts AS (
        SELECT parents."ParentKey", count(*)::bigint AS "Count"
        FROM parents
        JOIN ${baseItems} child
          ON ${normalized('COALESCE(child."SeasonId", child."ParentId")')} = parents."ParentKey"
        JOIN hierarchical_eligible ON ${nativeTextSql(database.schemaName).guidLower("hierarchical_eligible.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("child.\"Id\"")}
        ${options.userId == null ? 'WHERE child."PrimaryVersionId" IS NULL' : ''}
        GROUP BY parents."ParentKey"
      ), merged_counts AS (
        SELECT merged."ParentKey", count(DISTINCT CASE WHEN eligible."Id" IS NULL THEN NULL
          WHEN ${nonemptyKey('child."PresentationUniqueKey"')} THEN child."PresentationUniqueKey"
          ELSE ${nativeSql.fromProjection(normalized('child."Id"'))} END)::bigint AS "Count"
        FROM merged_parents merged JOIN merged_members member USING ("ParentKey")
        LEFT JOIN ${baseItems} child
          ON ${normalized('COALESCE(child."SeasonId",child."ParentId")')}=${normalized('member."MemberId"')}
        LEFT JOIN hierarchical_eligible eligible
          ON ${nativeSql.guidLower('eligible."Id"')}=${nativeSql.guidLower('child."Id"')}
          ${options.userId == null ? 'AND child."PrimaryVersionId" IS NULL' : ''}
        GROUP BY merged."ParentKey"
      )
      SELECT requested."ItemKey",
        sum(CASE WHEN merged_counts."Count" IS NOT NULL THEN merged_counts."Count"
          WHEN requested."LinkEligible" AND COALESCE(linked_counts."Count", 0) > 0
          THEN linked_counts."Count" ELSE COALESCE(hierarchical_counts."Count", 0) END)::bigint AS "Count"
      FROM requested
      LEFT JOIN linked_counts USING ("ParentKey")
      LEFT JOIN hierarchical_counts USING ("ParentKey")
      LEFT JOIN merged_counts USING ("ParentKey")
      GROUP BY requested."ItemKey"
      ORDER BY min(requested."Ordinal")`,
    values,
    signal: options.signal,
  });
  const counts = new Map(requests.map(request => [request.key, 0]));
  for (const row of result.rows) {
    const count = Number(row.Count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('PostgreSQL returned an invalid DTO child count.');
    }
    counts.set(row.ItemKey, count);
  }
  return counts;
}
