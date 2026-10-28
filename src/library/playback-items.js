import { nativeTextSql } from '../database/native-text-sql.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { quoteIdentifier as q } from '../database/model.js';
import { buildPostgresItemPageQuery, queryPostgresItemPage } from '../database/postgres-item-query.js';
import { loadPostgresNavigationRows, loadPostgresRowsByIds } from './postgres-library-query.js';
import { visibleLibrary } from './permissions.js';
import { sameNativePath } from './native-path.js';
import { idKey, mapRecord, NAME_TYPES, nonemptyId, repositoryCleanName,
  repositoryTopParentId } from './records.js';
import { postgresParentalRatingContext } from './parental-rating.js';
import { postgresFolderMixGenres } from './postgres-mix-sources.js';
import { withMusicGenreSelector } from './music-mix-genres.js';

const failure = (status, message) => Object.assign(new Error(message), { status });
const normalizedId = (database, expression) => nativeTextSql(database.schemaName).guidKey(expression);

function table(database, name) {
  if (database?.dialect !== 'postgres') throw new TypeError('A PostgreSQL database is required.');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/u.test(database.schemaName ?? '')) {
    throw new TypeError('A valid PostgreSQL schema is required for playback item queries.');
  }
  return `${q(database.schemaName)}.${q(name)}`;
}

function uniqueIds(ids) {
  return [...new Map(ids.filter(nonemptyId).map(id => [idKey(id), id])).values()];
}

function playbackFrontierEdges(database, { links = 'none', parentEdges = true } = {}) {
  const baseItems = table(database, 'BaseItems');
  const ancestors = table(database, 'AncestorIds');
  const linkedChildren = table(database, 'LinkedChildren');
  const branches = [];
  if (parentEdges) branches.push(`SELECT child."Id" AS "ChildId"
          FROM ${baseItems} child
          WHERE ${normalizedId(database, 'child."ParentId"')} = ${normalizedId(database, 'parent."Id"')}`);
  branches.push(`SELECT descendant."Id" AS "ChildId"
          FROM ${ancestors} relation
          JOIN ${baseItems} descendant
            ON ${normalizedId(database, 'descendant."Id"')} = ${normalizedId(database, 'relation."ItemId"')}
          WHERE ${normalizedId(database, 'relation."ParentItemId"')} = ${normalizedId(database, 'parent."Id"')}`);
  if (links !== 'none') branches.push(`SELECT linked_item."Id" AS "ChildId"
          FROM ${linkedChildren} linked
          JOIN ${baseItems} linked_item
            ON ${normalizedId(database, 'linked_item."Id"')} = ${normalizedId(database, 'linked."ChildId"')}
          WHERE ${normalizedId(database, 'linked."ParentId"')} = ${normalizedId(database, 'parent."Id"')}
            ${links === 'manual' ? 'AND linked."ChildType" = 0' : ''}`);
  return branches.join('\n          UNION ALL\n          ');
}

async function mappedRows(database, ids) {
  return (await loadPostgresRowsByIds(database, uniqueIds(ids))).map(row => mapRecord(row)).filter(Boolean);
}

/** Resolve every ordinary container/name item in one request-scoped relation.
 * The result keeps membership per requested item while allowing the shared
 * item planner to apply visibility and SortName ordering only once. */
async function queryPostgresPlaybackExpansionIds(database, items, {
  collectionRoots = new Map(), selectionPlan, boxSetTopParentIds = null,
} = {}) {
  const uniqueItems = [...new Map(items.filter(item => item && nonemptyId(item.Id))
    .map(item => [idKey(item.Id), item])).values()];
  const resultByItem = new Map(uniqueItems.map(item => [idKey(item.Id), []]));
  const folders = uniqueItems.filter(item => item.IsFolder && item.Type !== 'UserView');
  const names = uniqueItems.filter(item => NAME_TYPES.has(item.Type));
  if (!folders.length && !names.length) return resultByItem;

  const baseItems = table(database, 'BaseItems');
  const ancestors = table(database, 'AncestorIds');
  const linkedChildren = table(database, 'LinkedChildren');
  const values = [];
  const bind = value => { values.push(value); return `$${values.length}`; };
  const ctes = [];
  const selections = [];
  let boxSetRootsParameter = null;

  if (folders.length) {
    const requests = folders.map(item => ({
      key: idKey(item.Id),
      links: item.Type === 'BoxSet' ? 'all' : item.Type === 'Playlist' ? 'manual' : 'none',
      boxSet: item.Type === 'BoxSet',
      roots: item.Type === 'CollectionFolder'
        ? [item.Id, ...(collectionRoots.get(idKey(item.Id)) ?? [])] : [item.Id],
    }));
    const roots = requests.flatMap(request => uniqueIds(request.roots)
      .map(root => ({ requestKey: request.key, rootKey: idKey(root) })));
    const requestKeys = `${bind(requests.map(request => request.key))}::text[]`;
    const linkModes = `${bind(requests.map(request => request.links))}::text[]`;
    const boxSets = `${bind(requests.map(request => request.boxSet))}::boolean[]`;
    const rootRequestKeys = `${bind(roots.map(root => root.requestKey))}::text[]`;
    const rootKeys = `${bind(roots.map(root => root.rootKey))}::text[]`;
    if (requests.some(request => request.boxSet) && boxSetTopParentIds !== null) {
      boxSetRootsParameter = `${bind(uniqueIds(boxSetTopParentIds).map(idKey))}::text[]`;
    }
    ctes.push(`folder_request_input AS (
        SELECT * FROM unnest(${requestKeys}, ${linkModes}, ${boxSets})
          AS input("RequestKey", "LinkMode", "BoxSet")
      )`, `folder_requests AS (
        SELECT input.*,
          CASE WHEN input."BoxSet" THEN NOT EXISTS (
            SELECT 1 FROM ${linkedChildren} linked
            WHERE ${normalizedId(database, 'linked."ParentId"')} = input."RequestKey"
          ) ELSE TRUE END AS "ParentEdges"
        FROM folder_request_input input
      )`, `folder_roots AS (
        SELECT roots."RequestKey", roots."RootKey"
        FROM unnest(${rootRequestKeys}, ${rootKeys}) AS roots("RequestKey", "RootKey")
      )`, `folder_closure("RequestKey", "Id") AS (
        SELECT roots."RequestKey", seed."Id"
        FROM folder_roots roots
        JOIN ${baseItems} seed ON ${normalizedId(database, 'seed."Id"')} = roots."RootKey"
        UNION
        SELECT parent."RequestKey", edge."ChildId"
        FROM folder_closure parent
        JOIN folder_requests request ON request."RequestKey" = parent."RequestKey"
        CROSS JOIN LATERAL (
          SELECT child."Id" AS "ChildId"
          FROM ${baseItems} child
          WHERE request."ParentEdges"
            AND ${normalizedId(database, 'child."ParentId"')} = ${normalizedId(database, 'parent."Id"')}
          UNION ALL
          SELECT descendant."Id" AS "ChildId"
          FROM ${ancestors} relation
          JOIN ${baseItems} descendant
            ON ${normalizedId(database, 'descendant."Id"')} = ${normalizedId(database, 'relation."ItemId"')}
          WHERE ${normalizedId(database, 'relation."ParentItemId"')} = ${normalizedId(database, 'parent."Id"')}
          UNION ALL
          SELECT linked_item."Id" AS "ChildId"
          FROM ${linkedChildren} linked
          JOIN ${baseItems} linked_item
            ON ${normalizedId(database, 'linked_item."Id"')} = ${normalizedId(database, 'linked."ChildId"')}
          WHERE request."LinkMode" <> 'none'
            AND ${normalizedId(database, 'linked."ParentId"')} = ${normalizedId(database, 'parent."Id"')}
            AND (request."LinkMode" <> 'manual' OR linked."ChildType" = 0)
        ) edge
      )`);
    selections.push(`SELECT closure."RequestKey", closure."Id"
      FROM folder_closure closure
      WHERE NOT EXISTS (
        SELECT 1 FROM folder_roots root
        WHERE root."RequestKey" = closure."RequestKey"
          AND root."RootKey" = ${normalizedId(database, 'closure."Id"')}
      )`);
  }

  if (names.length) {
    const requestKeys = `${bind(names.map(item => idKey(item.Id)))}::text[]`;
    const itemTypes = `${bind(names.map(item => item.Type))}::text[]`;
    const itemNames = `${bind(names.map(item => item.Name == null ? null : nativeTextBytes(item.Name)))}::bytea[]`;
    const cleanNames = `${bind(names.map(item => nativeTextBytes(repositoryCleanName(item))))}::bytea[]`;
    const people = table(database, 'Peoples');
    const peopleMap = table(database, 'PeopleBaseItemMap');
    const itemValues = table(database, 'ItemValues');
    const itemValuesMap = table(database, 'ItemValuesMap');
    ctes.push(`name_requests AS (
        SELECT * FROM unnest(${requestKeys}, ${itemTypes}, ${itemNames}, ${cleanNames})
          AS request("RequestKey", "ItemType", "Name", "CleanName")
      )`);
    selections.push(`SELECT request."RequestKey", related."Id"
      FROM name_requests request
      JOIN ${people} person ON person."Name" = request."Name"
      JOIN ${peopleMap} relation ON ${nativeTextSql(database.schemaName).guidLower("relation.\"PeopleId\"")} = ${nativeTextSql(database.schemaName).guidLower("person.\"Id\"")}
      JOIN ${baseItems} related ON ${nativeTextSql(database.schemaName).guidLower("related.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("relation.\"ItemId\"")}
      WHERE request."ItemType" = 'Person'`, `SELECT request."RequestKey", related."Id"
      FROM name_requests request
      JOIN ${itemValues} value ON value."CleanValue" = request."CleanName"
        AND value."Type" = ANY(CASE request."ItemType"
          WHEN 'Genre' THEN ARRAY[2]
          WHEN 'MusicGenre' THEN ARRAY[2]
          WHEN 'MusicArtist' THEN ARRAY[0, 1]
          WHEN 'Studio' THEN ARRAY[3]
          ELSE ARRAY[]::integer[] END)
      JOIN ${itemValuesMap} relation ON ${nativeTextSql(database.schemaName).guidLower("relation.\"ItemValueId\"")} = ${nativeTextSql(database.schemaName).guidLower("value.\"ItemValueId\"")}
      JOIN ${baseItems} related ON ${nativeTextSql(database.schemaName).guidLower("related.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("relation.\"ItemId\"")}
      WHERE request."ItemType" <> 'Person'`);
  }

  let playable = '';
  if (selectionPlan) {
    const original = 'SELECT page."Id", total."TotalRecordCount"\nFROM total';
    const replacement = 'SELECT page."Id", page.__ordinal AS "__Ordinal"\nFROM total';
    const ordered = selectionPlan.text.replace(original, replacement);
    if (ordered === selectionPlan.text) throw new Error('The PostgreSQL item selection plan did not expose page ordering.');
    const rebased = ordered.replace(/\$(\d+)/gu, (_match, ordinal) => `$${Number(ordinal) + values.length}`);
    playable = `, playable AS MATERIALIZED (${rebased})`;
    values.push(...selectionPlan.values);
  }
  const resolved = await database.client.query({
    text: `WITH RECURSIVE ${ctes.join(',\n')}${playable}
      SELECT distinct_expansion."RequestKey", distinct_expansion."Id"
      FROM (
        SELECT DISTINCT expanded."RequestKey", expanded."Id"
        FROM (${selections.join('\nUNION ALL\n')}) expanded
      ) distinct_expansion
      ${selectionPlan ? `JOIN playable ON ${nativeTextSql(database.schemaName).guidLower("playable.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("distinct_expansion.\"Id\"")}
      ${boxSetRootsParameter ? `LEFT JOIN folder_requests request
        ON request."RequestKey" = distinct_expansion."RequestKey"
      LEFT JOIN ${baseItems} expansion_item
        ON ${nativeTextSql(database.schemaName).guidLower("expansion_item.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("distinct_expansion.\"Id\"")}` : ''}
      WHERE playable."Id" IS NOT NULL
        ${boxSetRootsParameter ? `AND (request."BoxSet" IS NOT TRUE
          OR ${normalizedId(database, 'expansion_item."TopParentId"')} = ANY(${boxSetRootsParameter}))` : ''}
      ORDER BY distinct_expansion."RequestKey" COLLATE "C", playable."__Ordinal"`
      : 'ORDER BY distinct_expansion."RequestKey" COLLATE "C", distinct_expansion."Id"'}`,
    values,
  });
  for (const row of resolved.rows) {
    const selected = resultByItem.get(row.RequestKey);
    if (selected && row.Id != null) {
      const id = decodeNativeTextBytes(row.Id);
      if (nonemptyId(id)) selected.push(id);
    }
  }
  return resultByItem;
}

function resolvedPhysicalFolderIds(folder, state) {
  const stored = folder.PhysicalFolderIds ?? [];
  const locations = [...(folder.PhysicalLocations ?? []), ...(folder.PhysicalLocationsList ?? [])];
  if (!locations.length) return stored;
  const result = new Map();
  for (const location of locations) {
    const matches = state.items.filter(candidate => candidate.IsFolder && candidate.Type !== 'CollectionFolder'
      && sameNativePath(candidate.Path, location));
    const physical = matches.find(candidate => state.byId.get(idKey(candidate.ParentId))?.Type === 'AggregateFolder')
      ?? matches.find(candidate => idKey(candidate.Id) === idKey(repositoryTopParentId(candidate)))
      ?? matches[0];
    if (physical) result.set(idKey(physical.Id), physical.Id);
  }
  return result.size ? [...result.values()] : stored;
}

async function playbackNavigation(database, library, user, planning) {
  planning.navigation ??= (async () => {
    const navigationRows = await loadPostgresNavigationRows(database);
    return library.load(database, user, { includeUserData: false, baseRows: navigationRows });
  })();
  return planning.navigation;
}

const activePlaybackPlans = new WeakMap();

async function withPlaybackPlanning(database, planning, operation) {
  activePlaybackPlans.set(planning, (activePlaybackPlans.get(planning) ?? 0) + 1);
  let operationFailed = false;
  let operationError;
  try { return await operation(); }
  catch (error) { operationFailed = true; operationError = error; throw error; }
  finally {
    const remaining = activePlaybackPlans.get(planning) - 1;
    if (remaining) activePlaybackPlans.set(planning, remaining);
    else {
      activePlaybackPlans.delete(planning);
      const navigation = planning.navigation;
      const visibility = planning.visibility;
      delete planning.navigation;
      delete planning.visibility;
      // Failed construction already propagates through the operation; only a
      // successfully returned state has an owner to dispose.
      try {
        if (visibility) await Promise.resolve(visibility).catch(() => {});
        const state = navigation ? await Promise.resolve(navigation).catch(() => null) : null;
        if (state) await state.dispose({ session: database });
      } catch (cleanupError) {
        if (operationFailed) throw new AggregateError([operationError, cleanupError],
          'Playback planning and navigation cleanup failed.');
        throw cleanupError;
      }
    }
  }
}

async function playbackVisibility(database, library, user, planning) {
  if (!user) return undefined;
  const state = await playbackNavigation(database, library, user, planning);
  const policy = user.Policy;
  const libraryFolders = state.items.filter(item => item.Type === 'CollectionFolder');
  const allowedLibraries = libraryFolders.filter(item => visibleLibrary(item, user, library.options.libraryOptions));
  const physicalIds = folders => [...new Map(folders.flatMap(folder => folder.Type === 'CollectionFolder'
    ? resolvedPhysicalFolderIds(folder, state) : [repositoryTopParentId(folder) ?? folder.Id])
    .filter(nonemptyId).map(id => [idKey(id), id])).values()];
  const libraryTopParentIds = [...new Map([...physicalIds(libraryFolders), ...libraryFolders.map(item => item.Id)]
    .map(id => [idKey(id), id])).values()];
  const topParentIds = [...new Map([...physicalIds(allowedLibraries), ...allowedLibraries.map(item => item.Id)]
    .map(id => [idKey(id), id])).values()];
  const maxRating = user.MaxParentalRatingScore ?? policy.MaxParentalRatingScore ?? policy.MaxParentalRating;
  const maxSubRating = user.MaxParentalRatingSubScore ?? policy.MaxParentalRatingSubScore
    ?? policy.MaxParentalSubRating;
  return {
    ...(libraryFolders.length ? { topParentIds, libraryTopParentIds } : {}),
    blockedTags: policy.BlockedTags ?? [],
    allowedTags: policy.AllowedTags ?? [],
    maxRating,
    maxSubRating,
    ratingContext: postgresParentalRatingContext(library.options, await library.rootFolderPlan(state)),
    blockUnratedTypes: policy.BlockUnratedItems ?? [],
  };
}

export async function queryPostgresRelationalPlayPage(database, library, query, relationalScope, user, planning = {}) {
  return withPlaybackPlanning(database, planning, async () => {
  planning.visibility ??= playbackVisibility(database, library, user, planning);
  const { topParentIds: _topParentIds, libraryTopParentIds: _libraryTopParentIds,
    ...visibility } = await planning.visibility ?? {};
  const relational = relationalScopeQuery(database, relationalScope, 1);
  const plan = buildPostgresItemPageQuery(database, query, {
    userId: user?.Id,
    groupByPresentationKey: Boolean(user),
    resumableMode: 'repository',
    memorySortConfiguration: library.options.configuration,
    visibility,
    itemIdsPlan: relational,
  });
  // Membership is a relational input to the item plan, before grouping,
  // ordering and pagination; it does not depend on SQL display formatting.
  const selected = await database.client.query({ text: plan.text, values: plan.values });
  const ids = selected.rows.filter(row => row.Id != null).map(row => decodeNativeTextBytes(row.Id));
  const total = selected.rows.length ? Number(selected.rows[0].TotalRecordCount) : 0;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('PostgreSQL returned an invalid relational item count.');
  const rows = await mappedRows(database, ids);
  const byId = new Map(rows.map(item => [idKey(item.Id), item]));
  return {
    rows: ids.map(id => byId.get(idKey(id))).filter(Boolean),
    total,
    startIndex: plan.startIndex,
  };
  });
}

async function userViewItems(library, view, user, { audioOnly = false, limit, startIndex } = {}) {
  // SessionManager resolves the receiver without a standalone user gate;
  // the native view still applies its user-aware selection to every child.
  return library.getItemList({
    parentid: view.Id,
    recursive: true,
    ...(audioOnly ? { includeitemtypes: ['Audio'] } : {
      filters: ['IsNotFolder'],
      ismissing: false,
      excludeitemtypes: [...NAME_TYPES],
      sortby: ['SortName'],
      sortorder: ['Ascending'],
    }),
    fields: ['SortName'],
    enableimages: false,
    enableuserdata: false,
    ...(limit === undefined ? {} : { limit }),
    ...(startIndex === undefined ? {} : { startindex: startIndex }),
  }, { user, checkParentAccess: false });
}

function relationalScopeQuery(database, {
  mode, roots: inputRoots, links = 'none', includeTopParent = false,
}, parameterIndex) {
  if (!['direct', 'recursive'].includes(mode)) throw new TypeError('Unknown playback relational scope mode.');
  if (!['none', 'all'].includes(links)) throw new TypeError('Unknown playback relational scope link mode.');
  const roots = uniqueIds(inputRoots).map(idKey);
  if (!roots.length) return { text: 'SELECT NULL::bytea AS "Id" WHERE FALSE', values: [] };
  const rootParameter = `$${parameterIndex}::text[]`;
  const baseItems = table(database, 'BaseItems');
  const linkedChildren = table(database, 'LinkedChildren');
  if (mode === 'direct') {
    const linked = links === 'all' ? `
      UNION
      SELECT relation."ChildId" AS "Id"
      FROM ${linkedChildren} relation
      WHERE ${normalizedId(database, 'relation."ParentId"')} = ANY(${rootParameter})` : '';
    return {
      text: `SELECT direct."Id"
        FROM ${baseItems} direct
        WHERE ${normalizedId(database, 'direct."ParentId"')} = ANY(${rootParameter})${linked}`,
      values: [roots],
    };
  }

  const frontierEdges = playbackFrontierEdges(database, { links, parentEdges: true });
  const topParentSeeds = includeTopParent ? `
      UNION
      SELECT scoped."Id"
      FROM ${baseItems} scoped
      WHERE ${normalizedId(database, 'scoped."TopParentId"')} = ANY(${rootParameter})` : '';
  return {
    text: `WITH RECURSIVE closure("Id") AS (
        SELECT seed."Id"
        FROM ${baseItems} seed
        WHERE ${normalizedId(database, 'seed."Id"')} = ANY(${rootParameter})${topParentSeeds}
        UNION
        SELECT edge."ChildId"
        FROM closure parent
        CROSS JOIN LATERAL (
          ${frontierEdges}
        ) edge
      )
      SELECT closure."Id"
      FROM closure
      WHERE NOT (${normalizedId(database, 'closure."Id"')} = ANY(${rootParameter}))`,
    values: [roots],
  };
}

async function* mixGenreLists(database, library, item, user, planning) {
  if (['Playlist', 'MusicAlbum', 'MusicArtist', 'Audio', 'AudioBook'].includes(item.Type)) {
    yield item.Genres ?? [];
    return;
  }
  if (!user) throw failure(item.Type === 'UserView' ? 500 : 400, 'Error processing request.');
  if (item.Type === 'UserView') {
    let startIndex = 0;
    while (true) {
      const children = await userViewItems(library, item, user, { audioOnly: true, limit: 128, startIndex });
      for (const child of children) {
        if (!['Audio', 'AudioBook'].includes(child.Type)) throw failure(500, 'Error processing request.');
        yield child.Genres ?? [];
      }
      if (children.length < 128) break;
      startIndex += children.length;
    }
  } else {
    planning.visibility ??= playbackVisibility(database, library, user, planning);
    const navigation = await playbackNavigation(database, library, user, planning);
    const collectionRoots = navigation.items.filter(folder => folder.Type === 'CollectionFolder')
      .map(folder => ({ Id: folder.Id, ids: resolvedPhysicalFolderIds(folder, navigation) }));
    yield* postgresFolderMixGenres(database, item, {
      user, visibility: await planning.visibility, collectionRoots, configuration: library.options.configuration,
    });
  }
  yield item.Genres ?? [];
}

async function selectInstantMix(database, library, user, planning, selectors) {
  planning.visibility ??= playbackVisibility(database, library, user, planning);
  const page = await queryPostgresItemPage(database, {
    includeitemtypes: ['Audio'], sortby: ['Random'], sortorder: ['Ascending'], limit: 200,
    ...(selectors.genreIds ? { genreids: selectors.genreIds } : {}),
  }, {
    userId: user?.Id, groupByPresentationKey: false, visibility: await planning.visibility,
    ...(selectors.genreIdsPlan ? { genreIdsPlan: selectors.genreIdsPlan } : {}),
  });
  return page.rows.map(row => mapRecord(row)).filter(Boolean);
}

export async function queryPostgresInstantMixGenres(database, library, genres, user = null, planning = {}) {
  return withPlaybackPlanning(database, planning, () => withMusicGenreSelector(database, library, [genres],
    genreIdsPlan => selectInstantMix(database, library, user, planning, { genreIdsPlan })));
}

export async function queryPostgresInstantMix(database, library, item, user = null, planning = {}) {
  return withPlaybackPlanning(database, planning, async () => {
  if (item.Type === 'MusicGenre') return selectInstantMix(database, library, user, planning, { genreIds: [item.Id] });
  if (!['Playlist', 'MusicAlbum', 'MusicArtist', 'Audio', 'AudioBook'].includes(item.Type) && !item.IsFolder) return [];
  const mixed = await withMusicGenreSelector(database, library, mixGenreLists(database, library, item, user, planning),
    genreIdsPlan => selectInstantMix(database, library, user, planning, { genreIdsPlan }));
  return ['Audio', 'AudioBook'].includes(item.Type)
    ? [item, ...mixed.filter(entry => idKey(entry.Id) !== idKey(item.Id))] : mixed;
  });
}

async function expandContainers(database, library, items, user, planning) {
  const collections = items.filter(item => item.Type === 'CollectionFolder');
  const collectionRoots = new Map();
  if (collections.length) {
    const navigation = await playbackNavigation(database, library, user, planning);
    for (const collection of collections) {
      collectionRoots.set(idKey(collection.Id), resolvedPhysicalFolderIds(collection, navigation));
    }
  }
  planning.visibility ??= playbackVisibility(database, library, user, planning);
  const selectionPlan = buildPostgresItemPageQuery(database, {
    isfolder: false,
    excludelocationtypes: ['Virtual'],
    excludeitemtypes: [...NAME_TYPES],
    sortby: ['SortName'],
    sortorder: ['Ascending'],
  }, {
    userId: user?.Id,
    includeOwnedItems: true,
    includeAlternateVersions: true,
    resumableMode: 'memory',
    memorySortConfiguration: library.options.configuration,
    visibility: await planning.visibility,
  });
  const idsByItem = await queryPostgresPlaybackExpansionIds(database, items, {
    collectionRoots,
    selectionPlan,
    boxSetTopParentIds: user ? (await planning.visibility)?.topParentIds ?? [] : null,
  });
  const rows = await mappedRows(database, [...idsByItem.values()].flat());
  const byId = new Map(rows.map(item => [idKey(item.Id), item]));
  const expanded = new Map();
  for (const item of items) {
    const key = idKey(item.Id);
    expanded.set(key, (idsByItem.get(key) ?? []).map(id => byId.get(idKey(id))).filter(Boolean));
  }
  return expanded;
}

async function resolveSeriesId(database, episode) {
  if (nonemptyId(episode.SeriesId)) {
    const [series] = await mappedRows(database, [episode.SeriesId]);
    if (series?.Type === 'Series') return series.Id;
  }
  if (!nonemptyId(episode.ParentId)) return null;
  const baseItems = table(database, 'BaseItems');
  const result = await database.client.query({
    text: `WITH RECURSIVE parents("Id", "ParentId", "Type", "Depth", "Seen") AS (
      SELECT parent."Id", parent."ParentId", parent."Type", 1,
        ARRAY[${normalizedId(database, 'parent."Id"')}]
      FROM ${baseItems} parent
      WHERE ${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("$1")}
      UNION ALL
      SELECT parent."Id", parent."ParentId", parent."Type", child."Depth" + 1,
        child."Seen" || ${normalizedId(database, 'parent."Id"')}
      FROM parents child
      JOIN ${baseItems} parent ON ${nativeTextSql(database.schemaName).guidLower("parent.\"Id\"")} = ${nativeTextSql(database.schemaName).guidLower("child.\"ParentId\"")}
      WHERE NOT (${normalizedId(database, 'parent."Id"')} = ANY(child."Seen"))
    )
    SELECT "Id" FROM parents
    WHERE substring(${nativeTextSql(database.schemaName).projection('"Type"')} from '[^.]+$') = 'Series'
    ORDER BY "Depth" LIMIT 1`,
    values: [nativeTextBytes(episode.ParentId)],
  });
  return result.rows[0]?.Id == null ? null : decodeNativeTextBytes(result.rows[0].Id);
}

async function remainingSeriesEpisodes(database, library, current, user) {
  const seriesId = await resolveSeriesId(database, current);
  if (!seriesId) return null;
  try {
    const page = await library.querySeriesEpisodes({
      seriesId,
      startItemId: current.Id,
      isMissing: false,
      EnableImages: false,
      EnableUserData: false,
      Fields: [],
    }, { user });
    return page.Items.length ? page.Items : null;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

/** Expand a remote-play command without materializing the PostgreSQL library. */
export async function expandPostgresPlayItems(database, library, itemIds, {
  user = null,
  mixing = false,
  enableNextEpisodeAutoPlay = false,
} = {}) {
  const rows = mixing ? [] : await mappedRows(database, itemIds);
  const byId = new Map(rows.map(item => [idKey(item.Id), item]));
  const result = [];
  const planning = {};
  return withPlaybackPlanning(database, planning, async () => {
  const expandable = mixing ? [] : [...byId.values()].filter(item => item.Type !== 'UserView'
    && (NAME_TYPES.has(item.Type) || item.IsFolder));
  const expanded = expandable.length
    ? await expandContainers(database, library, expandable, user, planning) : new Map();
  const userViews = new Map();
  for (const requested of itemIds) {
    if (mixing) {
      if (!nonemptyId(requested)) throw failure(400, "Guid can't be empty. (Parameter 'id')");
      const mix = item => item ? queryPostgresInstantMix(database, library, item, user, planning) : [];
      // Each input observes the real manager cache and the previous input's
      // committed genre creation before resolving its own source identity.
      result.push(...await (library.itemCreation
        ? library.itemCreation.withItem(requested, mix)
        : mix((await mappedRows(database, [requested]))[0])));
      continue;
    }
    const item = byId.get(idKey(requested));
    if (!item) continue;
    if (item.Type === 'UserView') {
      const key = idKey(item.Id);
      if (!userViews.has(key)) userViews.set(key, await userViewItems(library, item, user));
      result.push(...userViews.get(key));
    } else if (NAME_TYPES.has(item.Type) || item.IsFolder) {
      result.push(...(expanded.get(idKey(item.Id)) ?? []));
    }
    else result.push(item);
  }
  if (enableNextEpisodeAutoPlay && result.length === 1 && result[0].Type === 'Episode') {
    return await remainingSeriesEpisodes(database, library, result[0], user) ?? result;
  }
  return result;
  });
}
