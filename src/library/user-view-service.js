import path from 'node:path';
import { dateTicks, idKey, nonemptyId, sameId, mapRecord, cleanValue, EMPTY_ID, MIN_DATE } from './records.js';
import { nativeUserSubviewIdentity, nativeUserViewIdentity, nativeShadowViewIdentity, nativeRootUserViewIdentity } from './identity.js';
import { collectionType, eligibleForGrouping } from './user-view-query.js';
import { userViewLabel } from './user-view-labels.js';
import { sortName } from './dto.js';
import { sortItems } from './query.js';
import { nativeDateFromUnixNanoseconds } from '../users/native.js';
import { MetadataRefreshHost } from '../metadata/refresh-host.js';
import { MetadataRegistry } from '../metadata/registry.js';
import { MetadataImages } from '../metadata/images.js';
import { MetadataUpdateHost } from '../metadata/update-host.js';
import { createMetadataContextLoader } from './metadata-context.js';
import { ItemUpdateType } from '../metadata/save-manager.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { removeDiacritics } from '../sessions/user-data.js';
import { MetadataImageAssets } from '../metadata/image-assets.js';
import { createUserViewDynamicImagePlugin } from '../metadata/user-view-dynamic-image-provider.js';
import { persistItemRelations } from './item-relations.js';
import { cloneNativeItemEntity, copyNativeItemState, releaseNativeItemLinks, nativeItemDescriptor } from './native-item-entity.js';
import { loadPostgresRowsByIds } from './postgres-library-query.js';

const refreshIntervalTicks = 24n * 60n * 60n * 10000000n;
const menus = {
  movies: [['movieresume', 'HeaderContinueWatching'], ['movielatest', 'Latest'], ['moviemovies', 'Movies'],
    ['moviecollection', 'Collections'], ['moviefavorites', 'Favorites'], ['moviegenres', 'Genres']],
  tvshows: [['tvresume', 'HeaderContinueWatching'], ['tvnextup', 'HeaderNextUp'], ['tvlatest', 'Latest'],
    ['tvshowseries', 'Shows'], ['tvfavoriteseries', 'HeaderFavoriteShows'], ['tvfavoriteepisodes', 'HeaderFavoriteEpisodes'], ['tvgenres', 'Genres']],
};

export class UserViewService {
  #refreshQueue = [];
  #processing;
  #createdIds = new Set();
  #closing = false;
  #refreshLifetime = new AbortController();
  #closePromise;
  constructor({ library, fileSystem = library?.options.fileSystem, users, updates, metadata, images, refreshes }) {
    Object.assign(this, { fileSystem, library, refreshes, store: library.store });
    const root = library.options.programDataPath;
    const pathApi = /^[A-Za-z]:[\\/]|^\\\\/.test(root ?? '') ? path.win32 : path.posix;
    this.stateAssets = new MetadataImageAssets({ fileSystem, metadataPath: library.options.metadataPath ?? (root && pathApi.join(root, 'metadata')),
      stateRoots: root ? [pathApi.join(root, 'root')] : [] });
    const logger = { error: error => library.onError(error) };
    this.ownsImages = !images && !metadata?.images;
    this.images = images ?? metadata?.images ?? new MetadataImages({ logger });
    this.updates = updates ?? new MetadataUpdateHost({ store: this.store, images: this.images, library, logger,
      now: () => library.clock().toISOString() });
    this.ownsMetadata = !metadata;
    this.metadata = metadata ?? new MetadataRefreshHost({ registry: this.updates.registry ?? new MetadataRegistry(),
      store: this.store, linkedChildren:library.options.linkedChildren,
      loadContext: createMetadataContextLoader({ store: this.store, library, linkedChildren:library.options.linkedChildren,
        spoolRoot:library.options.spoolRoot, configuration: library.options.configuration }),
      images: this.images, updates: this.updates, supportedItemTypes: ['UserView'], logger,
      now: () => library.clock().toISOString() });
    if (users && !this.metadata.registry.plugins().some(plugin => plugin.id === 'builtin-user-view-dynamic-images')) {
      this.metadata.registry.register(createUserViewDynamicImagePlugin({ library, users }));
    }
  }

  queueRefresh(item, { forceSave = true } = {}) {
    if (this.#closing) return;
    // ProviderManager retains every enqueue, including repeated ids. Selection
    // of unchanged providers happens inside the metadata service, not here.
    this.#refreshQueue.push({ item, forceSave });
    this.#startProcessing();
  }

  #startProcessing() {
    if (this.#processing || this.#closing || !this.#refreshQueue.length) return;
    this.#processing = this.#processRefreshQueue().finally(() => {
      this.#processing = undefined;
      this.#startProcessing();
    });
  }

  async #processRefreshQueue() {
    while (!this.#closing && this.#refreshQueue.length) {
      // Named views all use Normal priority. CLR PriorityQueue replaces the
      // removed root with the last node; equal priorities do not sift down.
      const { item, forceSave } = this.#refreshQueue[0];
      const last = this.#refreshQueue.pop();
      if (this.#refreshQueue.length) this.#refreshQueue[0] = last;
      try {
        // Leave the request's reentrant scope and join the connection queue.
        await this.store.enqueue(async () => {
          if (this.#closing) return;
          this.refreshes?.reportStarted(item);
          try {
            await this.metadata.refresh(item.Id, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', ForceSave: forceSave,
              signal: this.#refreshLifetime.signal });
            this.refreshes?.reportProgress(item, 100);
          } finally { this.refreshes?.reportCompleted(item); }
        });
      } catch (error) {
        // Cancellation by an individual provider is a failed refresh and must
        // not cancel later entries. Only disposal stops this queue.
        if (!this.#refreshLifetime.signal.aborted) {
          try { this.library.onError(error); } catch { /* Background observers cannot break queue cleanup. */ }
        }
      }
    }
  }

  async #named(identity, { name, parentId, viewType, forcedSortName, userId, mode = 'named' }, db, state) {
    let item = state.byId.get(idKey(identity.Id));
    if (!item) {
      // Views are loaded by their deterministic identity when requested; the
      // navigation frame must not hydrate every user's persisted views.
      const rows = await loadPostgresRowsByIds(db, [identity.Id]);
      if (rows.length) {
        const loaded = await this.library.load(db, null, { baseRows: rows });
        try {
        item = loaded.byId.get(idKey(identity.Id));
        if (item) {
          state.adoptItem(item);
          state.items.push(item);
          state.byId.set(idKey(item.Id), item);
          state.parents.push(...loaded.parents);
        }
        } finally { await loaded.dispose({ session: db }); }
      }
    }
    const isNew = item?.Type !== 'UserView' || mode === 'root' && ordinalIgnoreCaseKey(item.Path ?? '') !== ordinalIgnoreCaseKey(identity.Path);
    let importRequired = isNew && mode === 'root';
    if (isNew) {
      const location = await this.stateAssets.resolve(identity.Path);
      await this.fileSystem.mkdir(location.localPath, { recursive: true });
      const directory = await this.fileSystem.stat(location.localPath, { bigint: true });
      const input = {
        Id: identity.Id, Type: 'MediaBrowser.Controller.Entities.UserView', Name: name, CleanName: cleanValue(name),
        ForcedSortName: forcedSortName, SortName: sortName({ Type: 'UserView', Name: name, ForcedSortName: forcedSortName }, this.library.options),
        Path: identity.StoredPath, DateCreated: nativeDateFromUnixNanoseconds(directory.birthtimeNs),
        DateModified: nativeDateFromUnixNanoseconds(directory.mtimeNs),
        Data: JSON.stringify({ ...(viewType == null ? {} : { ViewType: viewType }), DisplayParentId: idKey(parentId), ...(userId ? { UserId: idKey(userId) } : {}),
          IsRoot: false, IsHD: false, IsShortcut: false, Width: 0, Height: 0, DateLastSaved: MIN_DATE, RemoteTrailers: [] }),
        Genres: '', Studios: '', Tags: '', ProductionLocations: '', ChannelId: EMPTY_ID,
        IsFolder: true, IsInMixedFolder: false, IsLocked: false, IsMovie: false, IsRepeat: false, IsSeries: false, IsVirtualItem: false,
        MediaType: 'Unknown', UnratedType: 'Other', Width: 0, Height: 0,
      };
      const { row, ancestors } = await this.store.transaction(async transactionDb => {
        const row = await transactionDb.upsert('BaseItems', input);
        const created = mapRecord(row); created.Path = identity.Path;
        const collectionFolders = await this.library.getCollectionFolders(created);
        await persistItemRelations(transactionDb, created, { parents: [], collectionFolders });
        return { row, ancestors: await transactionDb.rows('AncestorIds', { where: { ItemId: created.Id } }) };
      });
      item = mapRecord(row); item.Path = identity.Path;
      state.adoptItem(item);
      const oldIndex = state.items.findIndex(value => sameId(value.Id, item.Id));
      if (oldIndex < 0) state.items.push(item); else state.items[oldIndex] = item;
      state.byId.set(idKey(item.Id), item);
      this.#createdIds.add(idKey(item.Id));
      for (let index = state.parents.length - 1; index >= 0; index--) if (sameId(state.parents[index].ItemId, item.Id)) state.parents.splice(index, 1);
      state.parents.push(...ancestors);
      this.updates.reportItemAdded(item, null);
    } else if (mode !== 'shadow' && (item.Name !== name || mode === 'named' && !userId && item.ViewType !== viewType)) {
      const loaded = await this.metadata.loadContext(item.Id);
      // Preserve the originally assigned forced sort and display parent.
      const changed = cloneNativeItemEntity(loaded.item);
      try {
      changed.Name = name;
      if (mode === 'root') changed.ForcedSortName = forcedSortName;
      else if (!userId) changed.ViewType = viewType;
      await this.updates.update(loaded, { Item: changed, People: null, Images: null },
        mode === 'root' ? ItemUpdateType.MetadataImport : ItemUpdateType.MetadataEdit);
      importRequired = mode === 'root';
      const row = (await db.rows('BaseItems', { where: { Id: item.Id } }))[0];
      copyNativeItemState(item, mapRecord(row)); item.Path = identity.Path;
      } finally { releaseNativeItemLinks(changed); await loaded.dispose(); }
    }
    if (mode === 'root') {
      if (isNew) {
        const loaded = await this.metadata.loadContext(item.Id);
        try {
        await this.updates.update(loaded, { Item: loaded.item, People: null, Images: null }, ItemUpdateType.MetadataImport);
        copyNativeItemState(item, mapRecord((await db.rows('BaseItems', { where: { Id: item.Id } }))[0])); item.Path = identity.Path;
        } finally { await loaded.dispose(); }
      }
      if (importRequired) this.queueRefresh(item, { forceSave: false });
      return item;
    }
    const lastRefreshed = dateTicks(item.DateLastRefreshed ?? MIN_DATE);
    const displayParent = nonemptyId(item.DisplayParentId) ? state.byId.get(idKey(item.DisplayParentId)) : null;
    if (isNew || dateTicks(this.library.clock().toISOString()) - lastRefreshed >= refreshIntervalTicks
      || displayParent?.DateLastSaved && dateTicks(displayParent.DateLastSaved) > lastRefreshed) this.queueRefresh(item);
    return item;
  }

  async menu(type, parent, db, state) {
    this.#assertOpen();
    const items = [];
    for (const [index, [viewType, key]] of menus[type].entries()) items.push(await this.#named(
      nativeUserSubviewIdentity(parent.Id, viewType, this.library.options), { name: userViewLabel(key, this.library.options),
        parentId: parent.Id, viewType, forcedSortName: String(index) }, db, state));
    return items;
  }

  async global(viewType, name, db, state) {
    this.#assertOpen();
    return this.#named(nativeRootUserViewIdentity(viewType, this.library.options),
      { name, parentId: EMPTY_ID, viewType, forcedSortName: name, mode: 'root' }, db, state);
  }

  async *genreMenu(type, parent, sourceItems, db, state) {
    this.#assertOpen();
    const seen = new Set();
    const viewType = type === 'moviegenres' ? 'moviegenre' : 'tvgenre';
    for (const name of sourceItems.flatMap(item => item.Genres)) {
      const key = ordinalIgnoreCaseKey(removeDiacritics(name));
      if (seen.has(key)) continue;
      seen.add(key);
      let genre;
      try {
        genre = await this.library.getGenre(name);
      } catch (error) {
        // UserViewBuilder drops only the failed GetGenre name. Successful
        // names and directories created before the failure remain observable.
        this.library.onError(error);
        continue;
      }
      // The frozen GetUserViewWithName uses the parent id as a localization
      // key and one shared identity per parent/type. Its lazy source retains
      // duplicate list rows and interleaves each successful Genre creation.
      yield await this.#named(nativeUserSubviewIdentity(parent.Id, viewType, this.library.options),
        { name: userViewLabel(idKey(parent.Id), this.library.options), parentId: parent.Id, viewType,
          forcedSortName: sortName(genre, this.library.options) }, db, state);
    }
  }

  async views(state, user, { includeHidden = false, includeExternalContent = true, presetViews = [], channelAccess } = {}) {
    this.#assertOpen();
    channelAccess ??= this.library.channelViewsAccess;
    const list = []; const grouped = [];
    const shadow = folder => this.#named(nativeShadowViewIdentity(folder, collectionType(folder), this.library.options),
      { name: folder.Name, parentId: folder.Id, viewType: collectionType(folder) || null, forcedSortName: '', mode: 'shadow' }, state.db, state);
    for (const folder of await this.library.navigationChildren(state, user)) {
      if (nativeItemDescriptor(folder.NativeType).family !== 'folder') continue;
      const type = collectionType(folder);
      if (['playlists', 'boxsets'].includes(type) && !await this.library.hasVisibleUserViewChild(folder, state, user)) continue;
      if (type === 'playlists') {
        list.push(await this.#named(nativeUserViewIdentity(user.Id, folder.Id, type, this.library.options),
          { name: folder.Name, parentId: folder.Id, viewType: type, forcedSortName: null, userId: user.Id }, state.db, state));
      } else if (eligibleForGrouping(folder) && user.Configuration?.GroupedFolders?.some(id => sameId(id, folder.Id))) grouped.push(folder);
      else list.push(presetViews.includes(type || null) ? await shadow(folder) : folder);
    }
    for (const type of ['movies', 'tvshows']) {
      const parents = grouped.filter(folder => collectionType(folder) === '' || collectionType(folder) === type);
      if (parents.length === 1 && collectionType(parents[0]) === type) list.push(presetViews.includes(type) ? await shadow(parents[0]) : parents[0]);
      else if (parents.length) list.push(await this.#named(nativeUserViewIdentity(user.Id, EMPTY_ID, type, this.library.options),
        { name: userViewLabel(type === 'movies' ? 'Movies' : 'TvShows', this.library.options), parentId: EMPTY_ID,
          viewType: type, forcedSortName: '', userId: user.Id }, state.db, state));
    }
    if (this.library.options.configuration.EnableFolderView) list.push(await this.#named(nativeRootUserViewIdentity('folders', this.library.options),
      { name: userViewLabel('Folders', this.library.options), parentId: EMPTY_ID, viewType: 'folders', forcedSortName: '', mode: 'root' }, state.db, state));
    if (includeExternalContent) {
      if (channelAccess) for (const item of (await channelAccess.getChannelsInternal({ UserId: user.Id })).Items) {
        list.push(this.library.adoptLiveItem(state, item));
      }
      if (await this.library.options.liveTv?.isEnabledForUser(user)) {
        list.push(await this.global('livetv', this.library.options.localization?.text('HeaderLiveTV') ?? 'Live TV', state.db, state));
      }
    }
    const visible = includeHidden ? list : list.filter(item => !user.Configuration?.MyMediaExcludes?.some(id => sameId(id, item.Id)));
    const sorted = sortItems(visible, { sortby: ['SortName'] }, state.userData, state.isPlayed,
      { memory: true, sortNameFor: item => sortName(item, this.library.options) });
    const ordered = user.Configuration?.OrderedViews ?? [];
    const order = item => {
      let index = ordered.findIndex(id => sameId(id, item.Id));
      if (index < 0 && item.Type === 'UserView' && nonemptyId(item.DisplayParentId)) index = ordered.findIndex(id => sameId(id, item.DisplayParentId));
      return index < 0 ? 2147483647 : index;
    };
    return sorted.sort((a, b) => order(a) - order(b));
  }

  async drain() { while (this.#processing) await this.#processing; }
  createdInThisInstance(id) { return this.#createdIds.has(idKey(id)); }
  #assertOpen() {
    if (this.#closing) throw Object.assign(new Error('UserView refresh scheduling is closed.'), { code: 'closed' });
  }
  close() { return this.#closePromise ??= this.#close(); }
  dispose() {
    if (this.#closing) return;
    this.#closing = true;
    this.#refreshLifetime.abort();
  }
  async #close() {
    this.dispose();
    await this.drain();
    this.#refreshQueue.length = 0;
    if (this.ownsMetadata) await this.metadata.close();
    if (this.ownsImages) { await this.images.close(); await this.images.processor.close(); }
  }
}
