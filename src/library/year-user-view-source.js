import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { quoteIdentifier as q } from '../database/model.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { withPostgresNativeQueryJitOff } from '../database/postgres-native-query-jit.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { createPostgresNativeItemQueryProjection } from './postgres-native-item-query-projection.js';
import { buildPostgresUserViewGenrePageQuery } from './postgres-user-view-genre-query.js';
import { withPostgresNextUpPages } from './postgres-next-up-query.js';
import { buildPostgresSeriesEpisodePageQuery } from './postgres-series-episodes-query.js';
import { loadPostgresPageGraph, loadPostgresRowsByIds } from './postgres-library-query.js';
import { nativeUserSubviewIdentity } from './identity.js';
import { collectionType, groupedMediaFolders, userViewQueryPlan } from './user-view-query.js';
import { resolveSeries } from './series-reference.js';
import { createPresentationUniqueKey } from './presentation-key.js';
import { nativeItemDescriptor } from './native-item-entity.js';
import { boxSetCollapsePlan } from './boxset-collapse.js';
import { boxSetDisplayOrder } from './boxset-state.js';
import { createPostgresFolderCollectionCollapse } from './postgres-folder-collection-collapse.js';
import { withYearMemoryOrder } from './year-memory-order.js';
import { idKey, MIN_DATE, nonemptyId } from './records.js';
import { withYearTraversal } from './year-traversal.js';
import { yearsFailure } from './postgres-years-source.js';

/** Freeze an already scoped source before bounded consumption. Its owner
 * remains admitted until every page callback and TEMP release has completed. */
async function frozen(database, plan, ordinal, consume, signal) {
  const table = q('mm_year_child_' + randomUUID().replaceAll('-', ''));
  let attempted = false, failed = false, primary;
  try {
    signal?.throwIfAborted(); attempted = true;
    await withPostgresNativeQueryJitOff(database, session => session.client.query({
      text: `CREATE TEMP TABLE ${table} AS SELECT source.* FROM (${plan.text}) source`, values: plan.values, signal,
    }));
    return await consume(async (after = 0n) => {
      signal?.throwIfAborted();
      return (await database.client.query({
        text: `SELECT * FROM ${table} WHERE ${q(ordinal)}>$1 ORDER BY ${q(ordinal)} LIMIT 128`, values: [after], signal,
      })).rows;
    });
  } catch (reason) { failed = true; primary = reason; throw reason; }
  finally {
    if (attempted) try { await database.client.query(`DROP TABLE IF EXISTS ${table}`); }
    catch (cleanup) { database.discardConnection(cleanup); throw yearsFailure(failed ? [primary, cleanup] : [cleanup]); }
  }
}

export function createYearSpecialChildren({ library, database, state, user, navigationRows,
  visibilityFor, physicalIdsFor, nextUpIdsFor, internalPlan, isVisible, virtualChildren,
  prepareVisibility, memoryRatingContext, signal }) {
  const consumeRows = async (rows, append) => {
    signal?.throwIfAborted();
    if (!rows.length) return;
    const page = await library.load(database, user, { includeUserData: false,
      baseRows: await loadPostgresPageGraph(database, rows, navigationRows) });
    let failed = false, primary;
    try { await append(rows.map(row => page.byId.get(idKey(row.Id))).filter(Boolean)); }
    catch (reason) { failed = true; primary = reason; throw reason; }
    finally {
      try { await page.dispose({ session: database }); }
      catch (cleanup) { throw yearsFailure(failed ? [primary, cleanup] : [cleanup]); }
    }
  };
  const consumePlan = (plan, append, ordinal = '__ordinal', owner) => frozen(database, plan, ordinal, async page => {
    for (let after = 0n;;) {
      const rows = await page(after);
      if (!rows.length) break;
      const selected = rows.filter(row => row.Id != null);
      const ids = selected.filter(row => row.__SlotKey == null).map(row => decodeNativeTextBytes(row.Id));
      const stored = await loadPostgresRowsByIds(database, ids), byId = new Map(stored.map(row => [idKey(row.Id), row]));
      if (selected.every(row => row.__SlotKey == null)) await consumeRows(ids.map(id => byId.get(idKey(id))).filter(Boolean), append);
      else for (const row of selected) {
        if (row.__SlotKey != null) {
          if (!owner?.withSlot) throw new TypeError('A live Year child source requires its admitted slot owner.');
          await owner.withSlot(row.__SlotKey, item => append([item]));
        } else await consumeRows([byId.get(idKey(decodeNativeTextBytes(row.Id)))].filter(Boolean), append);
      }
      after = BigInt(rows.at(-1)[ordinal]);
    }
  }, signal);

  const memory = async (query, produce, append, postFilterParent) => {
    let cohort, projection, collections, failed = false, primary, ordinal = 0n;
    try {
      cohort = await createNativeItemCohort({ linkedChildren: library.options.linkedChildren });
      projection = await createPostgresNativeItemQueryProjection(database);
      await produce(async items => {
        if (!items.length) return;
        const slots = await cohort.captureSlots(items);
        for (const [index, item] of items.entries()) await projection.append(item, slots[index], ++ordinal);
      });
      await cohort.flush();
      let input = query, nativeItemsPlan = projection.plan();
      const options = {
        resumableMode: 'memory', memorySourceOrder: 'occurrence', includeOrdinal: true, memoryUserViewFilter: true,
        includeOwnedItems: true, includeAlternateVersions: true, groupByPresentationKey: false, userId: user?.Id,
        memorySortConfiguration: library.options.configuration,
      };
      const collapse = postFilterParent && boxSetCollapsePlan(query, { parent: postFilterParent, user,
        configuration: library.options.configuration, repository: false });
      if (collapse?.active) {
        const visibility = await visibilityFor(state);
        collections = await createPostgresFolderCollectionCollapse({ session: database, library,
          source: { withSlot: (slot, operation) => cohort.withSlot(slot, operation) }, sourcePlan: nativeItemsPlan,
          query, options: { ...options, scope: {}, memoryRatingContext: await memoryRatingContext(),
            collapseTypes: collapse.types, collapseMode: 'memory',
            collapseCollectionPath: path.join(library.options.programDataPath, 'data', 'collections'),
            visibility: visibility ? { ...visibility, boxSetStandalone: true, boxSetTopParentExempt: false,
              itemMode: 'standalone', scopeTopParentAccess: false } : undefined }, user, prepareVisibility });
        nativeItemsPlan = collections.plan;
        input = Object.fromEntries(['sortby', 'sortorder', 'startindex', 'limit', 'adjacentto']
          .filter(key => Object.hasOwn(query, key)).map(key => [key, query[key]]));
      }
      const plan = buildPostgresItemPageQuery(database, input, { ...options, nativeItemsPlan });
      await frozen(database, plan, '__ordinal', async page => {
        for (let after = 0n;;) {
          const rows = await page(after);
          if (!rows.length) break;
          for (const row of rows) if (row.Id != null) await (collections ?? cohort).withSlot(row.__SlotKey, item => append([item]));
          after = BigInt(rows.at(-1).__ordinal);
        }
      }, signal);
    } catch (reason) { failed = true; primary = reason; throw reason; }
    finally {
      const failures = [];
      for (const release of [() => collections?.close(failed ? primary : undefined), () => projection?.close(), () => cohort?.release(),
        () => library.options.linkedChildren.flushReleases({ session: database })]) {
        try { await release(); } catch (reason) { failures.push(reason); }
      }
      if (failures.length) throw yearsFailure(failed ? [primary, ...failures] : failures);
    }
  };

  const actualChildren = (parent, capture) => withYearTraversal({ library, database, parent, state, user, hasUser: true,
    recursive: false, input: {}, virtualChildren, specialChildren: children, isVisible, signal }, source =>
    source.withWinners(async ordered => {
      const consume = async selected => {
        for (let after = 0n;;) {
          const page = await selected.page(after);
          if (!page.length) break;
          for (const row of page) await selected.withSlot(row.slot, item => capture([item]));
          after = page.at(-1).position;
        }
      };
      if (user && parent.Type === 'BoxSet') return withYearMemoryOrder({ database, source: ordered,
        sortBy: [boxSetDisplayOrder(parent)], user, configuration: library.options.configuration, signal }, consume);
      return consume(ordered);
    }));

  const dispatchChildren = async (parent, { recursive, input = {} }, append) => {
    signal?.throwIfAborted();
    const visibility = await visibilityFor(state);
    if (parent.Type === 'Series') {
      const key = parent.PresentationUniqueKey ?? createPresentationUniqueKey(parent, { libraryOptions: library.options.libraryOptions });
      const { topParentIds: _top, ...explicit } = visibility ?? {};
      const query = { includeitemtypes: ['Season'], sortby: ['SortName'], sortorder: ['Ascending'],
        ...(user && !(user.DisplayMissingEpisodes ?? user.Configuration?.DisplayMissingEpisodes) ? { ismissing: false } : {}) };
      return consumePlan(buildPostgresItemPageQuery(database, query, { scope: { seriesPresentationKey: key },
        userId: user?.Id, visibility: user ? explicit : undefined, groupByPresentationKey: Boolean(user), includeOrdinal: true }), append);
    }
    if (parent.Type === 'Season') {
      const series = resolveSeries(parent, state.byId);
      if (!series || series.SourceType === 'Channel') return;
      const plan = buildPostgresSeriesEpisodePageQuery(database, { mode: 'season', seasonId: parent.Id,
        seriesKey: series.PresentationUniqueKey ?? createPresentationUniqueKey(series, { libraryOptions: library.options.libraryOptions }),
        includeMissing: true, includeSpecials: library.options.configuration.DisplaySpecialsWithinSeasons ?? true,
        groupByPresentationKey: Boolean(user), visibility: visibility && Object.fromEntries(
          ['blockedTags', 'allowedTags', 'maxRating', 'maxSubRating', 'blockUnratedTypes', 'libraryTopParentIds', 'ratingContext']
            .map(key => [key, visibility[key]])) });
      return consumePlan(plan.relation, append, 'Ordinal');
    }
    const query = { parentid: parent.Id, recursive, enabletotalrecordcount: false,
      ...(recursive ? { includeitemtypes: input.includeItemTypes ?? [], excludeitemtypes: input.excludeItemTypes ?? [],
        mediatypes: input.mediaTypes ?? [] } : {}) };
    const dispatch = userViewQueryPlan(query, parent, state, user);
    const reference = nonemptyId(parent.DisplayParentId) ? parent.DisplayParentId : parent.ParentId;
    const referenced = state.byId.get(idKey(reference));
    if (dispatch.parent.Type === 'UserView' && idKey(dispatch.parent.Id) === idKey(parent.Id)
      && referenced?.SourceType === 'Channel' && nativeItemDescriptor(referenced.NativeType).family === 'folder') {
      // Channel folders dispatch through the provider even when a concrete
      // Folder subclass exposes IsFolder=false for its public DTO.
      dispatch.parent = referenced;
      if (dispatch.defaultViewChildren) { dispatch.defaultViewChildren = false; dispatch.memoryView = false; }
    }
    if (dispatch.nextUpView) {
      const roots = groupedMediaFolders(await library.navigationChildren(state, user), user)
        .filter(folder => collectionType(folder) === 'tvshows');
      const { topParentIds: _top, libraryTopParentIds: _library, ...explicit } = visibility ?? {};
      return withPostgresNextUpPages(database, { userId: user.Id, seriesDiscovery: {
        topParentIds: [...await nextUpIdsFor(dispatch.parent.Type === 'UserView' ? roots : [dispatch.parent])], nextUpDateCutoff: MIN_DATE },
        visibility: user ? explicit : undefined, displaySpecialsWithinSeasons: library.options.configuration.DisplaySpecialsWithinSeasons === true,
        enableTotalRecordCount: false }, async ({ pages }) => {
        for await (const page of pages) await consumeRows(page.rows, append);
      });
    }
    if (dispatch.foldersView) return memory(query, async capture => {
      const roots = await library.navigationChildren(state, user);
      for (let offset = 0; offset < roots.length; offset += 128) await capture(roots.slice(offset, offset + 128));
    }, append);
    if (['movies', 'tvshows'].includes(dispatch.menuType)) return memory(query,
      async capture => capture(await library.userViews.menu(dispatch.menuType, dispatch.parent, database, state)), append);
    if (['moviegenres', 'tvgenres'].includes(dispatch.menuType)) {
      let scope;
      if (dispatch.parent.Type === 'CollectionFolder') scope = { topParentIds: await physicalIdsFor([dispatch.parent]) };
      else if (dispatch.parent.Type === 'UserView' && ['', 'movies', 'tvshows'].includes(collectionType(dispatch.parent))) {
        const roots = groupedMediaFolders(await library.navigationChildren(state, user), user)
          .filter(folder => !collectionType(folder) || collectionType(folder) === collectionType(dispatch.parent));
        scope = { topParentIds: await physicalIdsFor(roots) };
      } else scope = { ancestorId: nonemptyId(dispatch.parent.DisplayParentId) ? dispatch.parent.DisplayParentId
        : nonemptyId(dispatch.parent.ParentId) ? dispatch.parent.ParentId : dispatch.parent.Id };
      const plan = buildPostgresUserViewGenrePageQuery(database, {}, {
        itemType: dispatch.menuType === 'moviegenres' ? 'Movie' : 'Series', scope, groupByPresentationKey: Boolean(user),
        visibility: visibility && Object.fromEntries(['blockedTags', 'allowedTags', 'maxRating', 'maxSubRating', 'blockUnratedTypes']
          .map(key => [key, visibility[key]])),
        itemId: nativeUserSubviewIdentity(dispatch.parent.Id, dispatch.menuType === 'moviegenres' ? 'moviegenre' : 'tvgenre', library.options).Id,
      });
      return memory(query, capture => frozen(database, plan, '__ordinal', async page => {
        for (let after = 0n;;) {
          const rows = await page(after);
          if (!rows.length) break;
          for (const row of rows) if (row.Name != null) {
            const name = decodeNativeTextBytes(row.Name);
            for await (const view of library.userViews.genreMenu(dispatch.menuType, dispatch.parent, [{ Genres: [name] }], database, state)) await capture([view]);
          }
          after = BigInt(rows.at(-1).__ordinal);
        }
      }, signal), append);
    }
    if (dispatch.defaultViewChildren) return memory(query, async capture => {
      const roots = groupedMediaFolders(await library.navigationChildren(state, user), user);
      for (const root of roots) await actualChildren(root, capture);
    }, append);
    if (!dispatch.directRepository && (dispatch.parent.Type === 'Channel' || dispatch.parent.SourceType === 'Channel')) {
      let consuming = false;
      try {
        await (library.channelViewsAccess ?? library.channels).withChannelItems({ User: user,
          ParentId: dispatch.parent.Id, ChannelIds: [dispatch.parent.Type === 'Channel' ? dispatch.parent.Id : dispatch.parent.ChannelId],
          Recursive: query.recursive === true, EnableTotalRecordCount: false,
          IncludeItemTypes: query.includeitemtypes ?? [], ExcludeItemTypes: query.excludeitemtypes ?? [], MediaTypes: query.mediatypes ?? [],
        }, async selected => {
          // Channel.GetItemsInternal catches failures of its complete provider,
          // cache and repository read. This callback begins only after that
          // source has been frozen and fully validated. Consumer failures and
          // cancellation keep their own cause and unwind the selection owner.
          consuming = true;
          for (let offset = 0;; offset += 128) {
            signal?.throwIfAborted();
            const page = await selected.page({ offset, limit: 128 });
            if (!page.rows.length) break;
            await consumeRows(page.rows, append);
          }
        });
      } catch (reason) { if (consuming) throw reason; }
      return;
    }
    if (!dispatch.directRepository && query.recursive !== true && dispatch.parent.SourceType !== 'Channel') {
      return memory(query, capture => actualChildren(dispatch.parent, capture), append, dispatch.parent);
    }
    return internalPlan(query, (plan, owner) => consumePlan(plan, append, '__ordinal', owner));
  };
  const children = async (parent, options, append) => {
    const reference = parent.Type === 'UserView'
      ? nonemptyId(parent.DisplayParentId) ? parent.DisplayParentId : parent.ParentId : null;
    if (nonemptyId(reference)) return library.itemCreation.withItem(reference, async resolved => {
      // UserView resolves its current relationship through the manager. A
      // metadata consumer can change that Guid after the initial graph read.
      if (resolved) library.adoptLiveItem(state, resolved);
      else state.byId.delete(idKey(reference));
      return dispatchChildren(parent, options, append);
    });
    return dispatchChildren(parent, options, append);
  };
  return children;
}
