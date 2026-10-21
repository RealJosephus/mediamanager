import { cleanValue, idKey, sameId, nonemptyId, libraryError, repositoryTopParentId, repositoryValue, NAME_TYPES, unsupported } from './records.js';
import { itemParentalRating, ratingWithinLimit } from './parental-rating.js';
import { boxSetLibraryFolderIds, collectionFoldersForItem, parentChainForItem, userRootFolders } from './collection-membership.js';
import { isLegacyBoxSet } from './boxset-state.js';
import path from 'node:path';
import { nativeContainsSubPath } from './native-path.js';

const hasId = (values, id) => (values ?? []).some(value => sameId(value, id));

export function visibleLibrary(item, user, libraryOptions) {
  const options = libraryOptions instanceof Map ? libraryOptions.get(idKey(item.Id)) ?? libraryOptions.get(item.Id) : libraryOptions?.[item.Id] ?? libraryOptions?.[idKey(item.Id)];
  if (options?.Enabled === false) return false;
  if (!user) return true;
  const policy = user.Policy;
  if (!policy) throw new TypeError('Library access requires an authoritative user policy.');
  if (policy.BlockedMediaFolders?.length) return !hasId(policy.BlockedMediaFolders, item.Id);
  return policy.EnableAllFolders === true || hasId(policy.EnabledFolders, item.Id);
}

export function visiblePerson(item, user, state, options = {}) {
  if (!user) return true;
  const policy = user.Policy;
  if (!policy) throw new TypeError('Person access requires an authoritative user policy.');
  // Person.IsVisible uses parental checks with allowed tags skipped. It does not
  // require a visible related movie, folder access, or an unrated-item allowance.
  const tags = new Set([item, ...parentChainForItem(item, state), ...collectionFoldersForItem(item, state)]
    .flatMap(parent => (parent.Tags ?? []).map(cleanValue)));
  if ((policy.BlockedTags ?? []).filter(tag => tag.trim()).map(cleanValue).some(tag => tags.has(tag))) return false;
  const max = user.MaxParentalRatingScore ?? policy.MaxParentalRatingScore ?? policy.MaxParentalRating;
  const sub = user.MaxParentalRatingSubScore ?? policy.MaxParentalRatingSubScore ?? policy.MaxParentalSubRating;
  return ratingWithinLimit(itemParentalRating(item, state, options), max, sub);
}

export function parentalAllowed(item, user, state, options = {}) {
  if (!user) return true;
  const policy = user.Policy;
  if (!policy) throw new TypeError('Parental access requires an authoritative user policy.');
  const inherited = [item, ...parentChainForItem(item, state), ...collectionFoldersForItem(item, state)];
  const tags = new Set(inherited.flatMap(parent => (parent.Tags ?? []).map(cleanValue)));
  if ((policy.BlockedTags ?? []).filter(tag => tag.trim()).map(cleanValue).some(tag => tags.has(tag))) return false;
  const parent = state.byId.get(idKey(item.ParentId)) ?? item;
  if (!options.skipAllowedTags && !['UserRootFolder', 'AggregateFolder', 'UserView'].includes(parent.Type)
    && policy.AllowedTags?.length
    && !policy.AllowedTags.filter(tag => tag.trim()).map(cleanValue).some(tag => tags.has(tag))) return false;
  const rating = itemParentalRating(item, state, options);
  const max = user.MaxParentalRatingScore ?? policy.MaxParentalRatingScore ?? policy.MaxParentalRating;
  const sub = user.MaxParentalRatingSubScore ?? policy.MaxParentalRatingSubScore ?? policy.MaxParentalSubRating;
  if (!ratingWithinLimit(rating, max, sub)) return false;
  const blocksUnrated = !item.IsFolder && !NAME_TYPES.has(item.Type)
    || ['BoxSet', 'Series', 'MusicAlbum'].includes(item.Type);
  const category = item.Type === 'BoxSet' ? 'Movie' : item.UnratedType;
  return rating != null || !blocksUnrated || !(policy.BlockUnratedItems ?? []).includes(category);
}

function visibleBoxSet(item, user, state, options) {
  if (!parentalAllowed(item, user, state, options)) return false;
  const links = state.links.filter(link => sameId(link.ParentId, item.Id));
  if (!links.length) return true;
  const ids = boxSetLibraryFolderIds(item, state);
  if (!ids.length) return true;
  const visibleFolders = userRootFolders(state).filter(folder => visibleItem(folder, user, state, {
    ...options, query: false, checkStandaloneParents: false,
  }));
  if (!ids.some(id => visibleFolders.some(folder => sameId(folder.Id, id)))) return false;
  const max = user.MaxParentalRatingScore ?? user.Policy.MaxParentalRatingScore ?? user.Policy.MaxParentalRating;
  if (max != null) {
    const children = links.map(link => state.byId.get(idKey(link.ChildId))).filter(Boolean);
    if (children.length && children.every(child => !parentalAllowed(child, user, state, { ...options, skipAllowedTags: true }))) return false;
  }
  return true;
}

function visiblePlaylist(item, user, state, options) {
  const allowedChild = () => {
    const max = user.MaxParentalRatingScore ?? user.Policy.MaxParentalRatingScore ?? user.Policy.MaxParentalRating;
    if (max == null) return true;
    const children = state.links.filter(link => sameId(link.ParentId, item.Id))
      .map(link => state.byId.get(idKey(link.ChildId))).filter(Boolean);
    return !children.length || children.some(child => parentalAllowed(child, user, state, { ...options, skipAllowedTags: true }));
  };
  const dataPath = options.dataPath ?? (options.programDataPath && path.join(options.programDataPath, 'data'));
  const shared = item.Path && dataPath && nativeContainsSubPath(item.Path, dataPath);
  if (!shared) return visibleItem(item, user, state, { ...options, playlistVisibilityChecked: true }) && allowedChild();
  if (item.OpenAccess || sameId(user.Id, item.OwnerUserId)) return allowedChild();
  const shares = item.Shares === undefined ? [] : item.Shares;
  if (!Array.isArray(shares)) throw new TypeError('Invalid Playlist.Shares.');
  return shares.some(share => sameId(share.UserId, user.Id)) && allowedChild();
}

export function visibleItem(item, user, state, { libraryOptions, configuration, programDataPath, dataPath, skipAllowedTags = false, query = true,
  checkStandaloneParents = true, scopeLibraryFolders = true, playlistVisibilityChecked = false, skipRelatedNameCheck = false } = {}) {
  if (!user) return true;
  const policy = user.Policy;
  if (!policy) throw new TypeError('Library access requires an authoritative user policy.');
  if (!query && item.Type === 'Playlist' && !playlistVisibilityChecked) return visiblePlaylist(item, user, state,
    { libraryOptions, configuration, programDataPath, dataPath, skipAllowedTags, query, checkStandaloneParents, scopeLibraryFolders });
  if (!query && item.Type === 'BoxSet'
    && !isLegacyBoxSet(item, state.links.some(link => sameId(link.ParentId, item.Id)), programDataPath)) {
    return visibleBoxSet(item, user, state, { libraryOptions, configuration, programDataPath, skipAllowedTags });
  }
  // Only Channel overrides IsVisible. Live TV entities inherit BaseItem's
  // parental checks, and the repository does not invoke this virtual method.
  if (!query && item.Type === 'Channel') {
    const blocked = policy.BlockedChannels ?? [];
    if (blocked.length ? hasId(blocked, item.Id)
      : policy.EnableAllChannels !== true && !hasId(policy.EnabledChannels, item.Id)) return false;
  }
  const ancestors = query ? state.ancestors(item) : parentChainForItem(item, state);
  const libraries = [item, ...ancestors].filter(parent => parent.Type === 'CollectionFolder');
  const playlistsDomain = [item, ...ancestors].some(parent => parent.Type === 'PlaylistsFolder');
  // IsVisible checks a CollectionFolder itself, not a media item's library
  // membership. Standalone access checks that membership separately. Items
  // repository dispatch establishes its own TopParentIds/ParentId/Ids scope.
  const checkLibraries = item.Type === 'CollectionFolder' || query && scopeLibraryFolders;
  if (checkLibraries && !(query && item.Type === 'BoxSet') && libraries.length && !libraries.some(parent => visibleLibrary(parent, user, libraryOptions))) return false;
  if (checkLibraries && !(query && item.Type === 'BoxSet') && !libraries.length && repositoryTopParentId(item) && state.items.some(parent => parent.Type === 'CollectionFolder')
    && !NAME_TYPES.has(item.Type) && !playlistsDomain) return false;

  // Repository tag inheritance is an EF relation over persisted AncestorIds,
  // plus explicit SeriesId and TopParentId. It does not derive collection
  // memberships or traverse an unsaved ParentId chain as IsVisible does.
  const inherited = (query ? [item,
    ...state.parents.filter(row => sameId(row.ItemId, item.Id)).map(row => state.byId.get(idKey(row.ParentItemId))),
    state.byId.get(idKey(repositoryTopParentId(item))), state.byId.get(idKey(item.SeriesId))]
    : [item, ...ancestors, ...collectionFoldersForItem(item, state)]).filter(Boolean);
  const tags = new Set(inherited.flatMap(parent => query && state.valuesFor ? state.valuesFor(parent, 4) : (parent.Tags ?? []).map(cleanValue)));
  if ((policy.BlockedTags ?? []).filter(tag => tag.trim()).map(cleanValue).some(tag => tags.has(tag))) return false;
  const exemptAllowed = item.Type === 'Person' || (!query && ['UserRootFolder', 'AggregateFolder', 'UserView'].includes(state.byId.get(idKey(item.ParentId))?.Type ?? item.Type));
  if (!skipAllowedTags && !exemptAllowed && policy.AllowedTags?.length && !policy.AllowedTags.filter(tag => tag.trim()).map(cleanValue).some(tag => tags.has(tag))) return false;
  const max = user.MaxParentalRatingScore ?? policy.MaxParentalRatingScore ?? policy.MaxParentalRating;
  const sub = user.MaxParentalRatingSubScore ?? policy.MaxParentalRatingSubScore ?? policy.MaxParentalSubRating;
  const withinStoredRating = entry => entry.InheritedParentalRatingValue == null || max == null || entry.InheritedParentalRatingValue < max
    || (entry.InheritedParentalRatingValue === max && (entry.InheritedParentalRatingSubValue ?? 0) <= (sub ?? 0));
  const ratingOptions = { libraryOptions, configuration };
  const directRating = query ? undefined : itemParentalRating(item, state, ratingOptions);
  const withinRating = query ? withinStoredRating : entry => ratingWithinLimit(
    sameId(entry.Id, item.Id) ? directRating : itemParentalRating(entry, state, ratingOptions), max, sub);
  if (!withinRating(item)) return false;
  if (max != null) {
    const members = state.links.filter(link => sameId(link.ParentId, item.Id) && Number(link.ChildType) === 0);
    if (members.length && !members.some(link => { const child = state.byId.get(idKey(link.ChildId)); return child && withinRating(child); })) return false;
  }
  const unrated = policy.BlockUnratedItems ?? [];
  if (query) {
    if (item.InheritedParentalRatingValue == null && unrated.includes(repositoryValue(item, 'UnratedType'))) return false;
  } else if (directRating == null) {
    // BaseItem exempts ordinary folders and by-name entities. These folder
    // subclasses explicitly opt back into their persisted unrated category.
    const blocksUnrated = !item.IsFolder && !NAME_TYPES.has(item.Type) || ['BoxSet', 'Series', 'MusicAlbum'].includes(item.Type);
    if (blocksUnrated && unrated.includes(item.Type === 'BoxSet' ? 'Movie' : item.UnratedType)) return false;
  }
  // BaseItem.IsVisibleStandalone first checks the item, then every parent with
  // allowed-tag matching skipped. A child's lower CustomRating cannot grant
  // direct access through a parent whose own rating exceeds the user's limit.
  if (!query && checkStandaloneParents && ancestors.some(parent => !visibleItem(parent, user, state, {
    libraryOptions, configuration, programDataPath, dataPath, skipAllowedTags: true, query: false, checkStandaloneParents: false,
  }))) return false;
  if (!query && checkStandaloneParents && item.SourceType === 'Channel') {
    // BaseItem checks a channel source's own parents but bypasses library
    // membership. ChannelManager then resolves exactly one ChannelId and calls
    // IsVisible, not IsVisibleStandalone, on that root.
    if (!nonemptyId(item.ChannelId)) throw libraryError(400, 'Guid cannot be empty.');
    const channel = state.byId.get(idKey(item.ChannelId));
    if (channel?.Type !== 'Channel') throw libraryError(500, 'The source channel is unavailable.');
    if (!visibleItem(channel, user, state, {
      libraryOptions, configuration, programDataPath, dataPath, query: false, checkStandaloneParents: false,
    })) return false;
  }
  if (!query && checkStandaloneParents && item.SourceType !== 'Channel') {
    const topParent = ancestors.at(-1) ?? item;
    if (topParent.Path != null && topParent.Path !== '') {
      const collectionFolders = collectionFoldersForItem(item, state);
      if (collectionFolders.length) {
        const blocked = policy.BlockedMediaFolders ?? [];
        const allowedIds = blocked.length
          ? userRootFolders(state).filter(folder => !hasId(blocked, folder.Id)).map(folder => folder.Id)
          : policy.EnableAllFolders === true ? collectionFolders.map(folder => folder.Id) : policy.EnabledFolders ?? [];
        if (!collectionFolders.some(folder => hasId(allowedIds, folder.Id))) return false;
      }
    }
  }
  if (!skipRelatedNameCheck && NAME_TYPES.has(item.Type) && (policy.EnableAllFolders !== true || max != null || unrated.length || policy.BlockedTags?.length || policy.AllowedTags?.length)) {
    if (!state.relatedItems) unsupported('Restricted by-name item visibility requires related item records.');
    return state.relatedItems(item).some(related => !NAME_TYPES.has(related.Type) && visibleItem(related, user, state, { libraryOptions, configuration, query }));
  }
  return true;
}
