import { idKey } from './records.js';
import { hasFilters } from './query.js';
import { collectionType, userViewQueryPlan } from './user-view-query.js';

export function prepareItemsController(query, requested, state, user, checkAccess, { controller = true } = {}) {
  const userRoot = state.items.find(item => item.Type === 'UserRootFolder');
  let implicitAggregate = !requested && !user;
  let item = requested ?? (implicitAggregate ? state.items.find(item => item.Type === 'AggregateFolder') ?? userRoot : userRoot);
  const linkedChildAncestorIds = [];
  if (controller && query.includeitemtypes?.length === 1 && ['BoxSet', 'Playlist'].includes(query.includeitemtypes[0])
    && !['BoxSet', 'Playlist'].includes(item?.Type)) {
    const target = query.includeitemtypes[0] === 'BoxSet' ? 'boxsets' : 'playlists';
    if (requested && requested.Type !== 'UserRootFolder' && collectionType(requested) !== target) linkedChildAncestorIds.push(requested.Id);
    delete query.parentid;
    item = userRoot;
    implicitAggregate = false;
  }
  // Controller authorization precedes Folder.GetItems/UserViewBuilder. In
  // particular, a forbidden view must not expose its builder's 501 or null-user
  // failure before the parent access error is returned.
  checkAccess?.(item);
  let parent = item?.IsFolder ? item : userRoot;
  const type = collectionType(parent);
  if (controller && (parent?.Type === 'PlaylistsFolder' || type === 'playlists')) {
    query.includeitemtypes = ['Playlist'];
    query.recursive = Boolean(user);
  } else if (controller && parent?.Type === 'CollectionFolder' && !query.includeitemtypes?.length && type === 'boxsets') {
    query.includeitemtypes = ['BoxSet'];
  }
  if (controller && parent?.Type === 'CollectionFolder' && query.includeitemtypes?.length && query.recursive === undefined) query.recursive = true;

  return { item, parent, implicitAggregate, linkedChildAncestorIds };
}

export function itemsDispatch(query, requested, state, user, checkAccess, { controller = true, prepared } = {}) {
  const initial = prepared ?? prepareItemsController(query, requested, state, user, checkAccess, { controller });
  const { item, linkedChildAncestorIds } = initial;
  let { parent, implicitAggregate } = initial;

  let directRepository = false;
  let memoryView = false;
  let viewParent = false;
  let foldersView = false;
  let pageResult = false;
  let nextUpView = false;
  let defaultViewChildren = false;
  let menuType;
  if (parent?.Type === 'UserView' && !query.ids?.length) {
    viewParent = true;
    const plan = userViewQueryPlan(query, parent, state, user);
    parent = plan.parent;
    directRepository = plan.directRepository ?? false;
    memoryView = plan.memoryView ?? false;
    foldersView = plan.foldersView ?? false;
    pageResult = plan.pageResult ?? false;
    nextUpView = plan.nextUpView ?? false;
    defaultViewChildren = plan.defaultViewChildren ?? false;
    menuType = plan.menuType;
    implicitAggregate = false;
  }
  const isUserRoot = parent?.Type === 'UserRootFolder' && !implicitAggregate;
  const recursive = !memoryView && (query.recursive === true || isUserRoot && hasFilters(query));
  const repository = directRepository || recursive || Boolean(query.ids?.length);
  const postFilter = recursive && !directRepository && !query.ids?.length
    && query.includeitemtypes?.length > 0 && query.includeitemtypes.every(type => ['BoxSet', 'Playlist'].includes(type));
  return { accessItem: item, parent, isUserRoot, recursive, repository, directRepository, memoryView, viewParent,
    foldersView, menuType, nextUpView, defaultViewChildren, pageResult, implicitAggregate, linkedChildAncestorIds, postFilter };
}

export function filterLinkedChildAncestors(items, state, ids) {
  if (!ids.length) return items;
  const ancestors = new Set(ids.map(idKey));
  const children = new Set(state.parents.filter(row => ancestors.has(idKey(row.ParentItemId))).map(row => idKey(row.ItemId)));
  const parents = new Set(state.links.filter(row => children.has(idKey(row.ChildId))).map(row => idKey(row.ParentId)));
  return items.filter(item => parents.has(idKey(item.Id)));
}
