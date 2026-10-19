import {cloneNativeItemValue} from './native-item-value.js';
import {nativeTextBytes,decodeNativeTextBytes} from '../database/native-text.js';
import {nativeTextSql} from '../database/native-text-sql.js';
import { idKey, sameId, nonemptyId, libraryError, cleanValue, MIN_DATE, mapRecord,
  VIDEO_TYPES } from './records.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { defaultLibraryOptions, createVirtualPathReverser } from './options.js';
import { projectStream } from './media-streams.js';
import { nativeGuid } from '../users/native.js';
import { readUserData } from '../sessions/user-data.js';
import { sortName } from './dto.js';
import path from 'node:path';
import { nativePersonIdentity } from './identity.js';
import { MetadataImageAssets } from '../metadata/image-assets.js';
import { substituteNfoImagePath } from './path-substitution.js';
import { itemParentalRating } from './parental-rating.js';
import { resolveSeries } from './series-reference.js';
import { createMetadataChildren } from './metadata-children.js';
import { nativeContainingFolderPath, nativeFileName, nativeFileNameWithoutExtension, nativeContainsSubPath,
  setNativePlaylistFileState } from './native-path.js';
import { nativeItemDescriptor, acquireNativeItemLinkOwner } from './native-item-entity.js';
import { attachMetadataSortCache, metadataSortName } from '../metadata/sort-cache.js';
import { probeFileChanged } from '../storage/probe-lifecycle.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { computeBoxSetLibraryFolderIds } from './collection-membership.js';
import { getNewItemId } from '../core/identity.js';
import { readItemImageRows } from './image-order.js';
import { readNativeImageRows } from '../database/native-relation-order.js';
import { itemSupportsAncestors } from './item-relations.js';
import { rebasedMetadataPath } from '../metadata/by-name-path.js';
import { internalFolderTypes, requiresInternalFolderRefresh } from '../metadata/internal-folder-refresh.js';
import { RootFolderFileData, nativeFileSystemPathsEqual } from './root-folder-file-data.js';
import { physicalCollectionFolders } from './collection-physical-folders.js';
import { clrTrim } from '../metadata/whitespace.js';
import { supportsOwnedItems, searchesContainingFolderForExtras } from './owned-items.js';
import { resolveVideoVersionLinks } from './video-version-relations.js';
import { VideoVersionDiscovery } from './video-version-discovery.js';
import { buildScanCollectionContext } from './scan-context.js';
import { OwnedExtraDiscovery } from './owned-extra-discovery.js';
import { detectUdfDiscType } from '../storage/udf-disc-type.js';
import { stateOwnedFiles, stateIgnoreFileAccess } from './state-owned-files.js';
import { DotIgnoreRule } from './dot-ignore-rule.js';
import { loadPostgresMetadataRows, loadPostgresPageGraph,
  loadPostgresRowsByIds, queryPostgresPlaylistLibraryRoots } from './postgres-library-query.js';
import { quoteIdentifier as q } from '../database/model.js';

export const metadataFields = ['Cast', 'Genres', 'ProductionLocations', 'Studios', 'Tags', 'Name', 'Overview', 'Runtime', 'OfficialRating'];
const imageTypes = ['Primary', 'Art', 'Backdrop', 'Banner', 'Logo', 'Thumb', 'Disc', 'Box', 'Screenshot', 'Menu', 'Chapter', 'BoxRear', 'Profile'];
const stateLocalXmlTypes = new Set(['BoxSet', 'Playlist']);
const firstText = values => values.find(value => value != null && value !== '');
const videoTypes = ['VideoFile', 'Iso', 'Dvd', 'BluRay'];
const extraTypes = ['Unknown', 'Clip', 'Trailer', 'BehindTheScenes', 'DeletedScene', 'Interview', 'Scene', 'Sample', 'ThemeSong', 'ThemeVideo', 'Featurette', 'Short'];

export { nativePersonIdentity } from './identity.js';

export function metadataLookup(item, parents = []) {
  const lookup = Object.fromEntries(['Path', 'Name', 'OriginalTitle', 'ProviderIds', 'IndexNumber', 'ParentIndexNumber', 'PremiereDate',
    'MetadataCountryCode', 'MetadataLanguage', 'SeriesProviderIds', 'SeasonProviderIds', 'SeriesDisplayOrder', 'IsMissingEpisode',
    'IndexNumberEnd'].map(key => [key, cloneNativeItemValue(item[key])]).concat([['Year', item.ProductionYear]]));
  if (item.Type === 'Movie' && !item.IsInMixedFolder && item.Path) {
    let name = nativeFileName(nativeContainingFolderPath(item));
    if (['VideoFile', 'Iso'].includes(item.VideoType) && ordinalIgnoreCaseEquals(name, nativeFileName(item.Path))) name = nativeFileNameWithoutExtension(name);
    lookup.Name = name;
  }
  if (item.Type === 'Book') lookup.SeriesName = item.SeriesName == null || item.SeriesName === ''
    ? parents[0]?.Name ?? null : item.SeriesName;
  return lookup;
}

export function createMetadataContextLoader({ store, library, fileSystem = library?.options.fileSystem, linkedChildren, spoolRoot, vfs, identityMap, metadataIdentityMap = identityMap, configuration = {}, contextExtensions = () => [], metadataConfiguration = { UseFileCreationTimeForDateAdded: true }, videoPathResolver, extraPathResolver, ignoreRule, externalData, logger }) {
  if (!store || !library) throw new TypeError('Metadata context requires a native store and library.');
  const relationScopes = new AsyncLocalStorage();
  const personIdentity = name => nativePersonIdentity(name, { ...library.options, configuration });
  const metadataPath = library.options.metadataPath ?? (library.options.programDataPath && imageMetadataPath(library.options.programDataPath));
  const dataPath = library.options.dataPath ?? (library.options.programDataPath && imagePathApiForRoot(library.options.programDataPath).join(library.options.programDataPath, 'data'));
  const reversePath = metadataPath && dataPath ? createVirtualPathReverser({ metadataPath, dataPath }) : value => value;
  const imageAssets = new MetadataImageAssets({ fileSystem, vfs, identityMap:metadataIdentityMap, metadataPath });
  const userViewAssets = new MetadataImageAssets({ fileSystem, metadataPath, stateRoots: library.options.programDataPath
    ? [imagePathApiForRoot(library.options.programDataPath).join(library.options.programDataPath, 'root')] : [] });
  const internalAssets = new MetadataImageAssets({ fileSystem, vfs, identityMap, metadataPath,
    stateRoots: [library.options.programDataPath && imagePathApiForRoot(library.options.programDataPath).join(library.options.programDataPath, 'root'), dataPath].filter(Boolean) });
  // Collection and managed-playlist XML belongs to this isolated instance.
  // Do not let an overlapping media prefix redirect state paths to a mount.
  const stateLocalXmlAssets = new MetadataImageAssets({ fileSystem, metadataPath, stateRoots: [dataPath].filter(Boolean) });
  const managedCollectionAssets = new MetadataImageAssets({ fileSystem, metadataPath,
    stateRoots: [library.options.programDataPath, dataPath].filter(Boolean) });
  const instanceIgnoreAssets = new MetadataImageAssets({ fileSystem, metadataPath,
    stateRoots: [library.options.programDataPath, dataPath].filter(Boolean) });
  const rootFileData = new RootFolderFileData({ assets: internalAssets, expandPath: library.options.expandPath });
  ignoreRule ??= vfs && identityMap ? new DotIgnoreRule({ vfs, identityMap }) : undefined;
  const videoVersionDiscovery = vfs && identityMap ? new VideoVersionDiscovery({ store, library, vfs, identityMap, ignoreRule, resolveFile: videoPathResolver, externalData, logger }) : undefined;
  const ownedExtraDiscovery = vfs && identityMap ? new OwnedExtraDiscovery({ vfs, identityMap, ignoreRule, resolveFile: extraPathResolver, logger }) : undefined;
  const stateExtraDiscovery = assets => new OwnedExtraDiscovery({ files: stateOwnedFiles(assets),
    ignoreRule: new DotIgnoreRule({ fileAccess: stateIgnoreFileAccess(instanceIgnoreAssets, ignoreRule?.fileAccess) }),
    classifyIso: (candidate, { signal } = {}) => detectUdfDiscType(assets, candidate.identityPath,
      { signal, version: candidate.entry.version }),
    resolveFile: extraPathResolver, logger });
  const stateOwnedExtraDiscovery = stateExtraDiscovery(stateLocalXmlAssets);
  const managedCollectionExtraDiscovery = stateExtraDiscovery(managedCollectionAssets);
  const access = item => identityMap.resolve({ itemId: item.Id, identityPath: item.Path,
    style: /^[A-Za-z]:[\\/]|^\\\\/.test(item.Path) ? 'windows' : 'posix' });
  const exists = async path => {
    try { return (await vfs.stat(path)).kind === 'file'; }
    catch (error) { if (error.code === 'not-found') return false; throw error; }
  };
  const loadContext = async (reference, { draft, includeChildren = false } = {}) => store.run(async db => {
    let state, itemOwner, loaded;
    try {
    const referenceId = typeof reference === 'string' ? nativeGuid(reference) : reference.Id;
    const targetRow = (await loadPostgresRowsByIds(db, [referenceId]))[0];
    const targetType = draft?.Type ?? String(targetRow?.Type ?? '').split('.').at(-1);
    const targetName = draft?.Name ?? targetRow?.Name;
    let scopedRows = await loadPostgresMetadataRows(db, referenceId, { targetType, targetName, configuration, includeChildren:false });
    // A newly resolved draft has no BaseItems row yet. Seed its bounded
    // relationship frame from the live references so persistence can still
    // derive the physical top parent and TV relationships without loading
    // the catalogue.
    if (draft) {
      const references = [draft.ParentId, draft.TopParentId, draft.NativeTopParentId,
        draft.SeasonId, draft.SeriesId, draft.OwnerId, draft.PrimaryVersionId].filter(nonemptyId);
      if (references.length) {
        const referenceRows = await loadPostgresRowsByIds(db, references);
        scopedRows = await loadPostgresPageGraph(db, referenceRows, scopedRows,
          { includeManualLinks:false });
      }
    }
    state = await library.load(db, null, { baseRows: scopedRows, includeManualLinks:false, includeFolderLinks:false, includeLinkGraph:false });
    const item = draft ?? state.byId.get(idKey(referenceId));
    if (!item) throw libraryError(404, 'Metadata item not found.');
    itemOwner = acquireNativeItemLinkOwner(item);
    // A supplied live entity owns its loaded, unknown or null link branch.
    // Repository-query entities can deliberately omit links; refreshing that
    // entity must keep unknown distinct from an authoritative empty set.
    if (!draft && nativeItemDescriptor(item.NativeType).family === 'folder') item.LinkedChildren = await linkedChildren.load(db, item.Id);
    const collectionsPath = dataPath && imagePathApiForRoot(dataPath).join(dataPath, 'collections');
    const declaredStateRoot = filename => typeof filename === 'string' && imagePathApiForRoot(filename).isAbsolute(filename)
      && [dataPath, library.options.programDataPath].filter(Boolean).find(root =>
        nativeFileSystemPathsEqual(filename, root) || nativeContainsSubPath(filename, root));
    // Native FindFolders also selects a direct AggregateFolder child whose
    // path contains DataPath/collections. Only that declared state ancestor
    // and its direct BoxSet directories acquire instance file access.
    const isCollectionRoot = value => value?.Path && collectionsPath && declaredStateRoot(value.Path)
      && state.byId.get(idKey(value.ParentId))?.Type === 'AggregateFolder'
      && nativeItemDescriptor(value.NativeType).family === 'folder'
      && (nativeFileSystemPathsEqual(value.Path, collectionsPath) || nativeContainsSubPath(collectionsPath, value.Path));
    const managedCollectionRoot = isCollectionRoot(item) || item.Type === 'Folder' && collectionsPath
      && nativeFileSystemPathsEqual(item.Path, collectionsPath);
    const collectionParent = item.Type === 'BoxSet' && state.byId.get(idKey(item.ParentId));
    const managedCollectionItem = isCollectionRoot(collectionParent) && declaredStateRoot(item.Path)
      && nativeFileSystemPathsEqual(imagePathApiForRoot(item.Path).dirname(item.Path), collectionParent.Path);
    const localStateAssets = managedCollectionRoot || managedCollectionItem ? managedCollectionAssets : stateLocalXmlAssets;
    const stateLocalItem = stateLocalXmlTypes.has(item.Type) || managedCollectionRoot;
    const byNameStateItem = ['Person', 'Genre', 'MusicGenre', 'Studio', 'Year'].includes(item.Type)
      || item.Type === 'MusicArtist' && item.IsAccessedByName;
    if (draft) { state.items.push(item); state.byId.set(idKey(item.Id), item); }
    const versionLinks = VIDEO_TYPES.has(item.Type) ? await db.rows('LinkedChildren', { where: { ParentId: item.Id },
      orderBy: [{ column: 'SortOrder', direction: 'ASC' }] }) : undefined;
    if (VIDEO_TYPES.has(item.Type)) {
      if (!Object.hasOwn(item, 'LocalAlternateVersions')) item.LocalAlternateVersions = [];
      // JsonIgnore: the serialized dictionary cannot supply this runtime list.
      if (!draft) item.LinkedAlternateVersions = versionLinks.filter(link => link.ChildType === 3)
        .map(link => ({ ItemId: link.ChildId, Type: 3 }));
    }
    // BaseItemMapper hydrates nullable storage dates into nonnullable entity
    // dates. Keep the raw nullable values only in the repository snapshot.
    for (const field of ['DateCreated', 'DateModified', 'DateLastRefreshed', 'DateLastSaved']) item[field] ??= MIN_DATE;
    if ((!vfs || !identityMap) && item.Type !== 'UserView' && !internalFolderTypes.includes(item.Type)
      && !stateLocalItem && !byNameStateItem) throw libraryError(501, 'Media-side metadata requires VFS and an identity map.');
    const parents = []; const visited = new Set([idKey(item.Id)]);
    let parentId = item.ParentId;
    while (nonemptyId(parentId) && !visited.has(idKey(parentId))) {
      visited.add(idKey(parentId)); const parent = state.byId.get(idKey(parentId));
      if (!parent) break;
      parents.push(parent); parentId = parent.ParentId;
    }
    const collectionFolders = await library.getCollectionFolders(item);
    const optionsByLibrary = library.options.libraryOptions;
    const libraryFolder = item.Type === 'CollectionFolder' ? item : collectionFolders.find(entry => entry.Type === 'CollectionFolder');
    const libraryOptions = libraryFolder && (optionsByLibrary instanceof Map ? optionsByLibrary.get(idKey(libraryFolder.Id)) : optionsByLibrary[idKey(libraryFolder.Id)])
      || defaultLibraryOptions();
    const refreshPreferredMetadata = (value, preferred = {}) => {
      const preferredParents = preferred.parents ?? loaded?.parents ?? parents;
      const preferredCollectionFolders = preferred.collectionFolders ?? loaded?.collectionFolders ?? collectionFolders;
      const preferredLibraryOptions = preferred.libraryOptions ?? loaded?.libraryOptions ?? libraryOptions;
      value.MetadataLanguage = firstText([value.PreferredMetadataLanguage, ...preferredParents.map(entry => entry.PreferredMetadataLanguage),
        ...preferredCollectionFolders.map(entry => entry.PreferredMetadataLanguage), preferredLibraryOptions.PreferredMetadataLanguage]) ?? configuration.PreferredMetadataLanguage;
      value.MetadataCountryCode = firstText([value.PreferredMetadataCountryCode, ...preferredParents.map(entry => entry.PreferredMetadataCountryCode),
        ...preferredCollectionFolders.map(entry => entry.PreferredMetadataCountryCode), preferredLibraryOptions.MetadataCountryCode]) ?? configuration.MetadataCountryCode;
      return value;
    };
    if (!item.Path) item.LocationType = item.SourceType === 'Channel' ? 'Remote' : 'Virtual';
    if (VIDEO_TYPES.has(item.Type)) item.VideoType = videoTypes[item.VideoType] ?? item.VideoType ?? 'VideoFile';
    item.ExtraType = extraTypes[item.ExtraType] ?? item.ExtraType;
    if (!draft && item.Type === 'Series' && !Object.hasOwn(item.Data, 'AirDays')) item.AirDays = [];
    // BaseItem constructs an empty trailer list even when Data omits it.
    // Refresh persistence must retain that default without an empty-provider merge.
    if (!Object.hasOwn(item, 'RemoteTrailers')) item.RemoteTrailers = [];
    item.HomePageUrl = null;
    item.IsFileProtocol = Boolean(item.Path) && !/^(?:http|rtsp|rtmp|rtp|ftp|udp)/i.test(item.Path) && (!item.Path.includes('://') || /^file:\/\//i.test(item.Path));
    if (!draft && (item.IsFolder || item.Type === 'MusicArtist')) item.DateLastMediaAdded ??= MIN_DATE;
    item.SupportsLocalMetadata = item.IsFileProtocol && item.SourceType !== 'Channel' && item.Type !== 'Photo';
    // A draft may be an existing repository/cache entity, not a new resolver
    // entity. Preserve supplied live locks, but hydrate absent runtime locks
    // from the authoritative relation instead of assuming an empty list.
    if (!Object.hasOwn(item, 'LockedFields')) item.LockedFields =
      (await db.rows('BaseItemMetadataFields', { where: { ItemId: item.Id } })).map(row => metadataFields[row.Id] ?? row.Id);
    refreshPreferredMetadata(item);
    const resolveItemSeries = value => resolveSeries(value, state.byId) ?? undefined;
    const resolveItemSeason = value => {
      const series = resolveItemSeries(value);
      const candidate = nonemptyId(value.SeasonId) ? state.byId.get(idKey(value.SeasonId)) : parents.find(entry => entry.Type === 'Season')
        ?? (series && value.ParentIndexNumber != null && state.children(series).find(entry => entry.Type === 'Season' && entry.IndexNumber === value.ParentIndexNumber));
      return candidate?.Type === 'Season' ? candidate : undefined;
    };
    const series = resolveItemSeries(item), season = resolveItemSeason(item);
    if (series) Object.assign(item, { SeriesProviderIds: series.ProviderIds, SeriesDisplayOrder: series.DisplayOrder });
    if (season) Object.assign(item, { SeasonProviderIds: season.ProviderIds, SeasonIndexNumber: season.IndexNumber });
    if (item.Type === 'Episode') item.IsMissingEpisode = item.LocationType === 'Virtual';
    const context = { fileSystem, linkedChildren, spoolRoot, expandPath:library.options.expandPath??(value=>value),people: [], images: [], mediaStreams: [], tracks: [], albums: [], userData: null,
      substituteImagePath: value => substituteNfoImagePath(value, configuration.PathSubstitutions),
      collectionFolderIds: collectionFolders.map(entry => entry.Id) };
    const refreshMetadataPathContext = async () => {
      delete context.accessPath;
      delete context.localPath;
      delete context.localRoot;
      delete context.managedCollectionDirectoryRoot;
      if (item.IsFileProtocol && byNameStateItem) {
        const location = await imageAssets.resolve(item.Path);
        if (location.localPath) {
          context.localPath = location.localPath;
          context.localRoot = metadataPath;
        } else context.accessPath = location.accessPath;
      } else if (item.IsFileProtocol && stateLocalItem) {
        try {
          const location = await localStateAssets.resolve(item.Path);
          context.localPath = location.localPath;
          context.localRoot = managedCollectionRoot || managedCollectionItem ? declaredStateRoot(item.Path) : dataPath;
          if (managedCollectionItem) context.managedCollectionDirectoryRoot = collectionParent.Path;
        } catch (error) {
          if (error.code !== 'unmapped-path' || managedCollectionRoot || managedCollectionItem) throw error;
          context.accessPath = access(item);
        }
      } else if (item.IsFileProtocol && internalFolderTypes.includes(item.Type)) {
        const location = await internalAssets.resolve(item.Path);
        if (location.accessPath) context.accessPath = location.accessPath;
      } else if (item.IsFileProtocol && item.Type === 'UserView') {
        const location = await userViewAssets.resolve(item.Path);
        if (!location.localPath) throw libraryError(501, 'UserView metadata must use instance state.');
      } else if (item.IsFileProtocol) {
        context.accessPath = access(item);
      }
      context.imageAssets = stateLocalItem && context.localPath ? localStateAssets
        : internalFolderTypes.includes(item.Type) ? internalAssets : item.Type === 'UserView' ? userViewAssets
          : context.accessPath ? imageAssets.forItem(item, context.accessPath) : imageAssets;
      return { accessPath: context.accessPath, localPath: context.localPath, imageAssets: context.imageAssets };
    };
    await refreshMetadataPathContext();
    if (item.Type === 'Playlist') {
      try {
        const info = context.localPath ? await fileSystem.stat(context.localPath) : await vfs.stat(context.accessPath);
        setNativePlaylistFileState(item, context.localPath ? info.isFile() : info.kind === 'file');
      } catch {
        // Directory.Exists returns false for an absent path, so a missing path
        // with an extension remains file-shaped and the provider owns the error.
        setNativePlaylistFileState(item, true);
      }
    }
    if (series?.Path && item.Type === 'Season') context.seriesPath = access(series);
    const refreshTvContext = value => {
      const series = resolveItemSeries(value), season = resolveItemSeason(value);
      value.SeriesProviderIds = series?.ProviderIds ?? {};
      value.SeriesDisplayOrder = series?.DisplayOrder;
      value.SeasonProviderIds = season?.ProviderIds ?? {};
      return { series, season, lookup: metadataLookup(value, loaded?.parents ?? parents), context: { ...context,
        seriesPath: value.Type === 'Season' && series?.Path ? access(series) : undefined } };
    };
    const peopleLinks = (await db.rows('PeopleBaseItemMap', { where: { ItemId: item.Id } }))
      .sort((a, b) => (a.ListOrder ?? 0) - (b.ListOrder ?? 0));
    const peopleRows = peopleLinks.length
      ? await db.rows('Peoples', { whereIn: { Id: [...new Set(peopleLinks.map(row => row.PeopleId))] } })
      : [];
    const personItemIds = [...new Set(peopleRows.map(person => personIdentity(person.Name).Id))];
    const missingPersonItemIds = personItemIds.filter(id => !state.byId.has(idKey(id)));
    if (missingPersonItemIds.length) {
      const providers = await db.rows('BaseItemProviders', { whereIn: { ItemId: missingPersonItemIds } });
      for (const row of await db.rows('BaseItems', { whereIn: { Id: missingPersonItemIds } })) {
        const personItem = mapRecord(row);
        if (!personItem) continue;
        for (const provider of providers) if (sameId(provider.ItemId, personItem.Id)) {
          personItem.ProviderIds[provider.ProviderId] = provider.ProviderValue;
        }
        personItem.Path = library.options.expandPath?.(personItem.Path) ?? personItem.Path;
        state.items.push(personItem);
        state.byId.set(idKey(personItem.Id), personItem);
      }
    }
    const imageItemIds = [item.Id, ...personItemIds];
    const imageRows = await readNativeImageRows(db, imageItemIds);
    const expandPath = library.options.expandPath ?? (value => value);
    context.images = (await readItemImageRows(db, item.Id)).map(row => ({ ...row, Type: imageTypes[row.ImageType] ?? row.ImageType, Path: expandPath(row.Path) }));
    for (const row of peopleLinks) {
      const person = peopleRows.find(entry => sameId(entry.Id, row.PeopleId));
      if (!person) throw new Error('A metadata person relation is missing its person.');
      const personItem = state.byId.get(idKey(personIdentity(person.Name).Id));
      const image = personItem && imageRows.find(entry => sameId(entry.ItemId, personItem.Id) && entry.ImageType === 0);
      context.people.push({ Name: person.Name, Type: person.PersonType ?? 'Unknown', Role: row.Role, SortOrder: row.SortOrder,
        ProviderIds: { ...personItem?.ProviderIds }, ImagePath: image ? expandPath(image.Path) : null });
    }
    // XML calls LibraryManager.GetPeople after its common frame has already
    // reached the sink. Read at that boundary; refresh's initial credits are
    // a different observation and cannot hide a later repository failure.
    context.getPeople = current => store.run(async database => {
      const credits = (await database.rows('PeopleBaseItemMap', { where: { ItemId: current.Id } }))
        .sort((left,right)=>(left.ListOrder??0)-(right.ListOrder??0));
      const people = credits.length ? await database.rows('Peoples', {
        whereIn: { Id: [...new Set(credits.map(row=>row.PeopleId))] } }) : [];
      const identities = people.map(person=>personIdentity(person.Name).Id);
      const providerRows = identities.length ? await database.rows('BaseItemProviders', { whereIn: { ItemId: identities } }) : [];
      const personImages = identities.length ? await readNativeImageRows(database,identities) : [];
      return credits.map(credit=>{
        const person=people.find(value=>sameId(value.Id,credit.PeopleId));
        if(!person)throw new Error('A metadata person relation is missing its person.');
        const personId=personIdentity(person.Name).Id;
        const image=personImages.find(value=>sameId(value.ItemId,personId)&&value.ImageType===0);
        return {Name:person.Name,Type:person.PersonType??'Unknown',Role:credit.Role,SortOrder:credit.SortOrder,
          ProviderIds:Object.fromEntries(providerRows.filter(value=>sameId(value.ItemId,personId)).map(value=>[value.ProviderId,value.ProviderValue])),
          ImagePath:image?expandPath(image.Path):null};
      });
    });
    context.mediaStreams = (await db.rows('MediaStreamInfos', { where: { ItemId: item.Id } })).map(row => projectStream(row, library.options));
    const childrenSource=createMetadataChildren({store,library,linkedChildren,configuration,libraryOptions});
    context.tracks=()=>childrenSource.tracks(item);context.albums=()=>childrenSource.albums(item);

    const saveLocalMetadataEnabled = item.SourceType !== 'Channel' && (libraryOptions.SaveLocalMetadata || ['Person', 'Genre', 'MusicGenre', 'Studio', 'Year', 'BoxSet', 'Playlist', 'UserView'].includes(item.Type)
      || item.Type === 'MusicArtist' && item.IsAccessedByName === true);
    const relationships = {};
    for (const table of ['BaseItemProviders', 'BaseItemMetadataFields', 'PeopleBaseItemMap', 'BaseItemImageInfos', 'ItemValuesMap']) relationships[table] = await db.rows(table, { where: { ItemId: item.Id } });
    if (itemSupportsAncestors(item)) relationships.AncestorIds = await db.rows('AncestorIds', { where: { ItemId: item.Id } });
    const fileSystemMetadata = async signal => {
      if (!item.Path) return null;
      try {
        const info = context.accessPath ? await vfs.stat(context.accessPath, { signal })
          : item.IsFileProtocol ? await (stateLocalItem ? localStateAssets
            : internalFolderTypes.includes(item.Type) ? internalAssets : item.Type === 'UserView' ? userViewAssets : imageAssets).stat(item.Path, { signal }) : null;
        if (!info) return null;
        // The pinned ManagedFileSystem populates times only for FileInfo.
        return { ...info, exists: true, modified: info.kind === 'directory' ? MIN_DATE : info.modified ?? MIN_DATE,
          created: info.kind === 'directory' ? MIN_DATE : info.created ?? MIN_DATE };
      } catch (error) {
        if (error.code !== 'not-found') throw error;
        // GetFileSystemInfo falls back to the opposite FileSystemInfo type
        // after its first existence guess. The missing entry retains MinValue.
        const filename = nativeFileName(item.Path), dot = filename.lastIndexOf('.');
        const hasExtension = dot >= 0 && dot < filename.length - 1;
        return { exists: false, kind: hasExtension ? 'directory' : 'file',
          modified: MIN_DATE, created: MIN_DATE, size: 0n };
      }
    };
    context.fileSystemMetadata = fileSystemMetadata;
    const findMetadataItemByPath = async (identityPath, isFolder) => {
      if (identityPath == null || identityPath === '') throw Object.assign(new TypeError("Invalid path. (Parameter 'path')"),
        { nativeException: identityPath == null ? 'ArgumentNullException' : 'ArgumentException', parameterName: 'path', status: 500 });
      return store.run(async database => {
        const baseItems = `${q(database.schemaName)}.${q('BaseItems')}`;
        const values = [isFolder];
        const pathPredicate = clrTrim(identityPath) === '' ? '' : `AND candidate."Path" = $${values.push(nativeTextBytes(reversePath(identityPath)))}`;
        const result = await database.client.query({
          text: `/* metadata-item-by-path */
            SELECT candidate."Id"
            FROM ${baseItems} candidate
            WHERE ($1::boolean IS NULL OR candidate."IsFolder" = $1)
              ${pathPredicate}
              AND (candidate."OwnerId" IS NULL OR candidate."ExtraType" IS NOT NULL)
              AND (candidate."PrimaryVersionId" IS NULL OR NOT EXISTS (
                SELECT 1
                FROM ${baseItems} primary_item
                WHERE ${nativeTextSql(database.schemaName).guidKey('primary_item."Id"')}
                    = ${nativeTextSql(database.schemaName).guidKey('candidate."PrimaryVersionId"')}
                  AND ${nativeTextSql(database.schemaName).guidKey('primary_item."TopParentId"')}
                    IS NOT DISTINCT FROM ${nativeTextSql(database.schemaName).guidKey('candidate."TopParentId"')}
              ))
            ORDER BY candidate."DateCreated" DESC NULLS LAST,
              candidate."Id" ASC
            LIMIT 1`,
          values,
        });
        const id = result.rows[0]?.Id==null?null:decodeNativeTextBytes(result.rows[0].Id,'runtime');
        if (!id) return null;
        const row = (await loadPostgresRowsByIds(database, [id]))[0];
        if (!row) return null;
        const found = mapRecord(row);
        if (!found) return null;
        found.Path = expandPath(found.Path);
        return found;
      });
    };
    const playlistLibraryRoots = () => store.run(async database => {
      const roots = await queryPostgresPlaylistLibraryRoots(database);
      return roots.map(value => library.options.expandPath?.(value) ?? value);
    });
    const playlistFileExists = async identityPath => {
      try {
        const accessPath = identityMap.resolve({ identityPath,
          style: /^[A-Za-z]:[\\/]|^\\\\/u.test(identityPath) ? 'windows' : 'posix' });
        return (await vfs.stat(accessPath)).kind === 'file';
      } catch { return false; }
    };
    Object.assign(context, { findMetadataItemByPath, playlistLibraryRoots, playlistFileExists });
    const physicalFolders = (enableCache = false) => physicalCollectionFolders(item, state, { enableCache, findByPath: findMetadataItemByPath });
    const rootFolderResolveArgs = setLocations => rootFileData.resolveArgs(item, setLocations);
    const requiresRefresh = async () => {
      const rebased = rebasedMetadataPath(item, { metadataPath });
      if (rebased != null && item.Path !== rebased) return true;
      // BaseItem tests the file without the request token. Folder then checks
      // whether a supported cumulative runtime is still missing.
      if (item.Path && item.DateModified && !item.DateModified.startsWith('0001-01-01')) {
        try {
          const info = await fileSystemMetadata();
          if (info?.exists && probeFileChanged(item, info.modified)) return true;
        } catch (error) { if (error.code !== 'not-found') throw error; }
      }
      const baseRequiresRefresh = ['MusicAlbum', 'MusicArtist'].includes(item.Type) && item.RunTimeTicks == null;
      return internalFolderTypes.includes(item.Type) ? requiresInternalFolderRefresh(item, { baseRequiresRefresh, resolveArgs: rootFolderResolveArgs, physicalFolders }) : baseRequiresRefresh;
    };
    attachMetadataSortCache(item, library.options);
    const versionItemCache = new Map(state.byId);
    let disposed = false;
    loaded = { item, context, linkedChildren,
      async dispose() {
        if (disposed) return; disposed = true;
        relationScopes.getStore()?.delete(loaded);
        itemOwner.release(); await state.dispose();
        await linkedChildren.flushReleases();
      }, logger, libraryOptions, globalOptions: configuration, metadataConfiguration, saveLocalMetadataEnabled, exists, relationships, versionLinks, fileSystemMetadata,
      lookup: metadataLookup(item, parents), lookupFor: value => metadataLookup(value, loaded?.parents ?? parents), parents, parent: parents[0], collectionFolders, series, season,
      resolveSeries: resolveItemSeries, resolveSeason: resolveItemSeason, refreshPreferredMetadata, refreshTvContext, requiresRefresh, reversePath, refreshMetadataPathContext, rootFolderResolveArgs, physicalFolders, findMetadataItemByPath,
      sortName: value => metadataSortName(value, library.options),
      metadataChildren:value=>childrenSource.children(value),
      getMediaSources: value => library.getLiveMediaSources(value),
      boxSetLibraryFolderIds:value=>childrenSource.libraryFolderIds(value),
      loadLibraryState:()=>store.run(async database=>{
        const sql=nativeTextSql(database.schemaName),base=`${q(database.schemaName)}.${q('BaseItems')}`;
        const links=`${q(database.schemaName)}.${q('LinkedChildren')}`;
        const baseRows=(await database.client.query(`WITH family AS (SELECT $1::text AS key UNION SELECT ${sql.guidKey('"ChildId"')} FROM ${links} WHERE ${sql.guidKey('"ParentId"')}=$1 AND "ChildType"=2)
          SELECT "Id" FROM ${base} WHERE ${sql.guidKey('"OwnerId"')} IN (SELECT key FROM family) OR ${sql.guidKey('"ParentId"')}=$1 OR ${sql.guidKey('"Id"')} IN (SELECT key FROM family)`,[idKey(item.Id)])).rows;
        const selected=await loadPostgresRowsByIds(database,baseRows.map(row=>decodeNativeTextBytes(row.Id,'runtime')));
        return library.load(database,null,{baseRows:await loadPostgresPageGraph(database,selected,state.items.map(value=>value.NativeRepositoryColumns).filter(Boolean),{includeManualLinks:false}),includeManualLinks:false,includeLinkGraph:true});
      }),
      getLocalAlternateVersionIds: prospectiveItem => store.run(async database => {
        const ids = (await database.rows('LinkedChildren', { where: { ParentId: item.Id, ChildType: 2 },
          orderBy: [{ column: 'SortOrder', direction: 'ASC' }] })).map(link => link.ChildId);
        if (!prospectiveItem) return ids;
        // Preflight both existing references and newly resolved paths before
        // the parent can write files/images or commit its version transaction.
        const plan = await resolveVideoVersionLinks(database, prospectiveItem, { reversePath });
        const known = new Set(ids.map(idKey));
        for (const link of plan?.links ?? []) if (link.ChildType === 2 && !known.has(idKey(link.ChildId))) {
          ids.push(link.ChildId); known.add(idKey(link.ChildId));
        }
        return ids;
      }),
      supportsOwnedItems: () => supportsOwnedItems(item, state),
      searchesContainingFolderForExtras: (value = item) => searchesContainingFolderForExtras(value, state),
      getNewItemId: (key, typeName) => getNewItemId(key, typeName, { programDataPath: library.options.programDataPath,
        enableCaseSensitiveItemIds: configuration.EnableCaseSensitiveItemIds }),
      localizedText: key => library.options.localization?.text(key) ?? ({ NameSeasonUnknown: 'Season Unknown', NameSeasonNumber: 'Season {0}' }[key] ?? key),
      libraryRuntimeOptions: library.options,
      parentalRating: (value, drafts) => {
        if (!drafts) return itemParentalRating(value, state, library.options);
        // Controller child saves observe the parent entity's edits made so far,
        // including fields that have not reached the parent's repository save.
        const byId = new Map(state.byId);
        for (const draft of drafts.values()) byId.set(idKey(draft.Id), draft);
        return itemParentalRating(value, { ...state, byId, items: state.items.map(entry => byId.get(idKey(entry.Id))) }, library.options);
      },
      personIdentity, reloadMetadataContext: loadContext,
      imageAssets: context.imageAssets,
      dataPath, metadataPath, fileSystem,
      videoVersionDiscovery, versionItemCache, adoptVersionItem:value=>state.adoptItem(value), loadDraftContext: value => loadContext(value.Id, { draft: value }),
      findOwnedExtras: (currentState, options) => (context.localPath && stateLocalXmlTypes.has(item.Type)
        ? managedCollectionItem ? managedCollectionExtraDiscovery : stateOwnedExtraDiscovery
          : ownedExtraDiscovery).find(loaded, currentState, options),
      ownedFileExists: (identityPath, nativeType) => exists(access({ Path: identityPath,
        Id: getNewItemId(identityPath, nativeType, { programDataPath: library.options.programDataPath,
          enableCaseSensitiveItemIds: configuration.EnableCaseSensitiveItemIds }) })),
      getVideoVersionCollectionType: () => parents[0]?.Path ? buildScanCollectionContext({ root: parents[0], state,
        collectionFolders, libraryOptions: library.options.libraryOptions, configuration }).collectionType : null,
      snapshot: (await db.rows('BaseItems', { where: { Id: item.Id } }))[0] };
    const previewContexts = async values => {
      const results = await Promise.allSettled(values.map(value=>loaded.loadDraftContext(value)));
      const failures = results.filter(result=>result.status==='rejected');
      if(failures.length){await Promise.all(results.filter(result=>result.status==='fulfilled').map(result=>result.value.dispose()));throw failures[0].reason;}
      return results.map(result=>result.value);
    };
    loaded.previewLocalAlternateContexts = async prospectiveItem => {
      const versions = await videoVersionDiscovery?.preview({ ...loaded, item: prospectiveItem }) ?? [];
      return previewContexts(versions);
    };
    loaded.previewOwnedPartContexts = async () => {
      const parts = await videoVersionDiscovery?.previewOwnedParts(loaded) ?? [];
      return previewContexts(parts);
    };
    for (const extension of contextExtensions()) await extension.enrich(loaded, { database: db });
    relationScopes.getStore()?.add(loaded);
    return loaded;
    } catch (error) {
      itemOwner?.release();
      try { await state?.dispose({ session: db }); await linkedChildren.flushReleases({ session: db }); }
      catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
      throw error;
    }
  });
  loadContext.library=library;loadContext.linkedChildren=linkedChildren;
  loadContext.withContext = async (reference, options, operation) => {
    const loaded = await loadContext(reference, options);
    try { return await operation(loaded); } finally { await loaded.dispose(); }
  };
  loadContext.withScope = async operation => {
    if (relationScopes.getStore()) return operation();
    const contexts = new Set();
    return relationScopes.run(contexts, async () => {
      try { return await operation(); }
      finally {
        const failures = [];
        for (const loaded of contexts) try { await loaded.dispose(); } catch (error) { failures.push(error); }
        await linkedChildren.flushReleases();
        if (failures.length) throw new AggregateError(failures, 'Metadata relation scope release failed.');
      }
    });
  };
  loadContext.withDetachedScope = operation => relationScopes.exit(() => loadContext.withScope(operation));
  return loadContext;
}

const imagePathApiForRoot = root => /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
function imageMetadataPath(root) { return imagePathApiForRoot(root).join(root, 'metadata'); }
