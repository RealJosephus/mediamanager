import { idKey, nonemptyId, sameId, libraryError } from './records.js';

const collectionTypes = new Map([
  ...['unknown', 'movies', 'tvshows', 'music', 'musicvideos', 'trailers', 'homevideos', 'boxsets', 'books',
    'photos', 'livetv', 'playlists', 'folders'].map((name, index) => [index, name]),
  ...['tvshowseries', 'tvgenres', 'tvgenre', 'tvlatest', 'tvnextup', 'tvresume', 'tvfavoriteseries',
    'tvfavoriteepisodes', 'movielatest', 'movieresume', 'moviemovies', 'moviecollection', 'moviefavorites',
    'moviegenres', 'moviegenre'].map((name, index) => [101 + index, name]),
]);

export const collectionTypeNames = Array.from({ length: 116 }, (_, value) => collectionTypes.get(value));

export function collectionType(item) {
  if (item?.Type === 'PlaylistsFolder') return 'playlists';
  const value = item?.CollectionType ?? item?.ViewType;
  return collectionTypes.get(value) ?? String(value ?? '').toLowerCase();
}

export const eligibleForGrouping = folder => folder?.Type === 'CollectionFolder'
  && ['', 'movies', 'tvshows'].includes(collectionType(folder));

export function groupedMediaFolders(folders, user) {
  const grouped = user?.Configuration?.GroupedFolders ?? [];
  return folders.filter(folder => eligibleForGrouping(folder) && grouped.some(id => sameId(id, folder.Id)));
}

export function userViewQueryPlan(query, view, state, user) {
  const type = collectionType(view);
  // A nonempty, unresolved DisplayParentId does not fall back to ParentId.
  const displayId = nonemptyId(view.DisplayParentId) ? view.DisplayParentId : view.ParentId;
  const display = state.byId.get(idKey(displayId));
  const parent = display?.IsFolder ? display : view;
  if (type === 'folders') {
    if (!user) throw libraryError(400, 'Error processing request.');
    return { parent, memoryView: true, foldersView: true };
  }
  if (['movies', 'tvshows'].includes(type)) {
    if (query.recursive !== true) return { parent, memoryView: true, menuType: type };
    if (!user) throw libraryError(500, 'Error processing request.');
    query.includeitemtypes = query.includeitemtypes?.length ? query.includeitemtypes
      : type === 'movies' ? ['Movie'] : ['Series', 'Season', 'Episode'];
    return { parent };
  }
  if (type === 'moviecollection') {
    if (!user) throw libraryError(500, 'Error processing request.');
    query.includeitemtypes = ['BoxSet'];
    query.recursive = true;
    delete query.parentid;
    return { parent: state.items.find(item => item.Type === 'UserRootFolder'), directRepository: true };
  }
  const types = {
    books: ['Book', 'AudioBook'], moviemovies: ['Movie'], moviefavorites: ['Movie'], movielatest: ['Movie'],
    movieresume: ['Movie'], moviegenre: ['Movie'], tvshowseries: ['Series'], tvfavoriteseries: ['Series'],
    tvfavoriteepisodes: ['Episode'], tvlatest: ['Episode'], tvresume: ['Episode'], tvgenre: ['Series'],
  }[type];
  if (types) {
    // These builders call InternalItemsQuery.SetUser even when the caller is
    // an API key without a user, which dereferences null in the frozen server.
    if (!user) throw libraryError(500, 'Error processing request.');
    query.recursive = true;
    query.includeitemtypes = types;
    if (['moviefavorites', 'tvfavoriteseries', 'tvfavoriteepisodes'].includes(type)) query.isfavorite = true;
    if (['moviegenre', 'tvgenre'].includes(type)) query.genreids = [view.Id];
    const special = ['movielatest', 'tvlatest', 'movieresume', 'tvresume'].includes(type);
    if (special) {
      query.sortby = [type.endsWith('resume') ? 'DatePlayed' : 'DateCreated', 'SortName'];
      query.sortorder = ['Descending', 'Descending'];
      query.limit = 50;
      if (type.endsWith('resume')) query.isresumable = true;
      if (type === 'tvlatest') query.ismissing = false;
    }
    return { parent, directRepository: true, pageResult: special };
  }
  if (['moviegenres', 'tvgenres'].includes(type)) return { parent, memoryView: true, menuType: type };
  if (type === 'tvnextup') {
    if (!user) throw libraryError(400, 'Error processing request.');
    return { parent, nextUpView: true };
  }
  return { parent, memoryView: parent.Type === 'UserView', defaultViewChildren: parent.Type === 'UserView' };
}
