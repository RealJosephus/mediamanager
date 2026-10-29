import { dtoOptions, projectItem } from './dto.js';
import { idKey } from './records.js';
import { loadPostgresNavigationRows, loadPostgresPageGraph, loadPostgresRowsByIds, queryPostgresFolderStats } from './postgres-library-query.js';
import { createPostgresSuggestionsQuery, suggestionFailure } from './postgres-suggestions-query.js';

/** LibraryManager.GetItemsResult plus DtoService.GetBaseItemDtos. The caller
 * owns the admitted library/channel state scope and the private DTO helpers. */
export async function querySuggestions(library, database, input, {
  user, signal, visibilityFor, topParentIdsFor, filterItems, prefetchDtos,
}) {
  const navigationRows = await loadPostgresNavigationRows(database);
  const navigation = await library.load(database, user, { includeUserData: false, baseRows: navigationRows });
  let visibility;
  if (user) {
    // This call also owns Native's lazy creation/refresh of user views, even
    // if the filter or public Take subsequently produces no rows.
    const views = await library.userViews.views(navigation, user, { includeHidden: true });
    const topParentIds = await topParentIdsFor(views, navigation);
    visibility = { ...await visibilityFor(navigation), topParentIds };
  }
  let selected, failed = false, primary;
  try {
    selected = await createPostgresSuggestionsQuery(database, input, { userId: user?.Id, visibility, signal });
    const Items = [], options = dtoOptions({}, true);
    for (let offset = 0;; offset += 128) {
      const ids = await selected.page(offset);
      if (!ids.length) break;
      let state, pageFailed = false, pageReason;
      try {
        const rows = await loadPostgresRowsByIds(database, ids);
        state = await library.load(database, user, { baseRows: await loadPostgresPageGraph(database, rows, navigationRows) });
        const items = ids.map(id => state.byId.get(idKey(id))).filter(Boolean);
        const accessible = await filterItems(items, state);
        state.folderStats = await queryPostgresFolderStats(database, accessible.filter(item => item.IsFolder).map(item => item.Id), user?.Id);
        await prefetchDtos(accessible, state, options);
        for (const item of accessible) Items.push(await projectItem(item, state, user, options, library.options));
      } catch (reason) { pageFailed = true; pageReason = reason; throw reason; }
      finally {
        try { await state?.dispose({ session: database }); }
        catch (cleanup) { throw suggestionFailure(pageFailed ? [pageReason, cleanup] : [cleanup]); }
      }
    }
    // GetItemsResult's disabled count is the deserialized repository page
    // length before DtoService's visibility, rather than the number of DTOs.
    return { Items, TotalRecordCount: selected.total, StartIndex: selected.startIndex };
  } catch (reason) { failed = true; primary = reason; throw reason; }
  finally {
    try { await selected?.close({ failed }); }
    catch (cleanup) { throw suggestionFailure(failed ? [primary, cleanup] : [cleanup]); }
  }
}
