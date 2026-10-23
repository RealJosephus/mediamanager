import { getNewItemId } from '../core/identity.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { MetadataImageAssets } from '../metadata/image-assets.js';
import { normalizeProbeFileDate } from '../storage/probe-lifecycle.js';
import { nativeDate } from '../sessions/user-data.js';
import { onMetadataChanged } from '../metadata/metadata-changed.js';
import { ItemUpdateType } from '../metadata/save-manager.js';
import { stringifyNativeJson } from '../core/json.js';
import { newNativeItemEntity, nativeItemDescriptor } from './native-item-entity.js';
import { updateLiveItemRepository } from './live-item-repository.js';
import { channelMediaSourceCachePath } from './channel-static-media-sources.js';
import { channelDateText } from './channel-item-data.js';
import { dateTicks, MIN_DATE, sameId, VIDEO_TYPES } from './records.js';

const nullReference = () => Object.assign(new TypeError('Object reference not set to an instance of an object.'), { nativeException: 'NullReferenceException', status: 500 });
const list = value => { if (value == null) throw nullReference(); return [...value]; };
const sourceList = value => {
  if (value == null) throw Object.assign(new TypeError("Value cannot be null. (Parameter 'source')"), { nativeException: 'ArgumentNullException', status: 400 });
  return value;
};
const equals = (left, right) => left == null || right == null ? left == null && right == null : ordinalIgnoreCaseEquals(left, right);
const named = (value, name, number) => value === name || value === number;
const missing = error => ['not-found', 'ENOENT', 'ENOTDIR', 'not-directory'].includes(error.code);
function nativeType(info) {
  if (named(info.Type, 'Folder', 1)) return ({ MusicAlbum: 'Audio.MusicAlbum', MusicArtist: 'Audio.MusicArtist', PhotoAlbum: 'PhotoAlbum',
    Series: 'TV.Series', Season: 'TV.Season', 1: 'Audio.MusicAlbum', 2: 'PhotoAlbum', 3: 'Audio.MusicArtist', 4: 'TV.Series', 5: 'TV.Season' })[info.FolderType] ?? 'Folder';
  if (named(info.MediaType, 'Audio', 0)) return named(info.ContentType, 'Podcast', 1) ? 'AudioBook' : 'Audio.Audio';
  if (named(info.ContentType, 'Episode', 4)) return 'TV.Episode';
  if (named(info.ContentType, 'Movie', 3)) return 'Movies.Movie';
  if (named(info.ContentType, 'Trailer', 2) || named(info.ExtraType, 'Trailer', 2)) return 'Trailer';
  return 'Video';
}

/** GetChannelItemEntityAsync's ordered mutations and repository boundaries.
 * The caller owns both the Channel operation and the Library frame. */
export async function materializeChannelItem(info, { provider, channel, parent, library, metadata, now = () => new Date().toISOString(), onError = () => {} }) {
  if (info == null) throw nullReference();
  // Native reads parent.Id before inspecting the incoming item.
  if (parent == null) throw nullReference();
  const type = 'MediaBrowser.Controller.Entities.' + nativeType(info);
  const id = getNewItemId((info.Id ?? '') + (provider.name ?? '') + '16', type, { programDataPath: library.options.programDataPath,
    enableCaseSensitiveItemIds: library.options.configuration.EnableCaseSensitiveItemIds });
  let item;
  try { item = await library.itemCreation.getItemById(id); }
  catch (error) { try { void Promise.resolve(onError(error)).catch(() => {}); } catch { /* Native logs a lookup failure and constructs anew. */ } }
  const isNew = item?.NativeType !== type;
  if (isNew) item = newNativeItemEntity(type);
  item.Id = id;
  const owner = library.itemCreation.retainItem(item);
  try {
  const descriptor = nativeItemDescriptor(type), probe = provider.supportsMediaProbe === true;
  let force = false;
  if (info.IsLiveStream) item.RunTimeTicks = null;
  else if (isNew || !probe) item.RunTimeTicks = info.RunTimeTicks ?? null;
  if (isNew) {
    item.Name = info.Name ?? null;
    item.Genres = list(info.Genres); item.Studios = list(info.Studios);
    for (const key of ['CommunityRating', 'Overview', 'IndexNumber', 'ParentIndexNumber', 'ProductionYear', 'ProviderIds', 'OfficialRating']) item[key] = info[key] ?? null;
    item.PremiereDate = channelDateText(info.PremiereDate);
    item.DateCreated = info.DateCreated == null ? now() : channelDateText(info.DateCreated);
    item.Tags = list(info.Tags); item.OriginalTitle = info.OriginalTitle ?? null;
  } else if (named(info.Type, 'Folder', 1) && named(info.FolderType, 'Container', 0) && item.Name !== (info.Name ?? null)) {
    item.Name = info.Name ?? null; force = true;
  }
  if (descriptor.hasArtist) item.Artists = list(info.Artists);
  if (descriptor.hasAlbumArtist) item.AlbumArtists = list(info.AlbumArtists);
  if (item.Type === 'Trailer') {
    const trailerTypes = sourceList(info.TrailerTypes);
    if (trailerTypes.length !== item.TrailerTypes.length || trailerTypes.some((value, index) => value !== item.TrailerTypes[index])) force = true;
    item.TrailerTypes = [...trailerTypes];
  }
  const modified = channelDateText(info.DateModified);
  if (dateTicks(modified) > dateTicks(item.DateModified)) { item.DateModified = modified; force = true; }
  if (!sameId(item.ChannelId, channel.Id)) force = true;
  item.ChannelId = channel.Id;
  if (!sameId(item.ParentId, parent.Id)) force = true;
  item.ParentId = parent.Id;
  if (descriptor.hasSeries) { if (!equals(item.SeriesName, info.SeriesName)) force = true; item.SeriesName = info.SeriesName ?? null; }
  if (!equals(item.ExternalId, info.Id)) force = true;
  item.ExternalId = info.Id ?? null;
  if (descriptor.family === 'audio' || VIDEO_TYPES.has(item.Type)) {
    // Jellyfin.Extensions resolves FirstOrDefault on IReadOnlyList here;
    // that overload returns default for a null list as well as an empty list.
    item.ExtraType = info.ExtraType; item.Path = info.MediaSources?.[0]?.Path ?? null;
  }
  const fileSystem = library.options.fileSystem;
  const assets = new MetadataImageAssets({ fileSystem, vfs: fileSystem.vfs, identityMap: fileSystem.identityMap, metadataPath: library.options.metadataPath });
  if (info.ImageUrl != null && info.ImageUrl !== '' && !item.ImageInfos.some(image => image.Type === 'Primary')) {
    let modified = MIN_DATE;
    if (!/^http/iu.test(info.ImageUrl)) {
      try { const file = await assets.stat(info.ImageUrl); modified = file.modified ? nativeDate(normalizeProbeFileDate(file.modified)) : MIN_DATE; }
      catch (error) { if (!missing(error)) throw error; }
    }
    item.ImageInfos = [...item.ImageInfos, { Path: info.ImageUrl, Type: 'Primary', DateModified: modified, Width: 0, Height: 0, BlurHash: null }]; force = true;
  }
  const live = item.Tags.some(tag => tag != null && ordinalIgnoreCaseEquals(tag, 'livestream'));
  if (!info.IsLiveStream && live) { item.Tags = item.Tags.filter(tag => tag == null || !ordinalIgnoreCaseEquals(tag, 'livestream')); force = true; }
  else if (info.IsLiveStream && !live) { item.Tags = [...item.Tags, 'livestream']; force = true; }
  const loaded = await metadata.loadContext(item.Id, { draft: item });
  try { onMetadataChanged(item, await loaded.parentalRating(item)); } finally { await loaded.dispose(); }
  if (isNew) {
    await library.itemCreation.createItems([item], parent, { creationIntent: 'library-save' });
    if (info.People?.length) await metadata.updatePeople(item, info.People);
  } else if (force) {
    const images = item.ImageInfos.map(image => ({ ...image, Blurhash: image.BlurHash == null ? null : Buffer.from(image.BlurHash) }));
    await updateLiveItemRepository(item, { itemCreation: library.itemCreation, loadContext: metadata.loadContext,
      updates: metadata.updates, updateReason: ItemUpdateType.None, images });
  }
  if ((isNew || force) && named(info.Type, 'Media', 0)) {
    const sources = probe && !info.IsLiveStream && Boolean(item.Path) ? [] : info.MediaSources;
    const filename = channelMediaSourceCachePath(item, library.options.metadataPath);
    if (!sources?.length) {
      try { await assets.delete(filename); } catch { /* Actual DeleteFile is a best-effort cache invalidation. */ }
    } else await assets.write(filename, Buffer.from(stringifyNativeJson(sources)));
  }
  if (isNew || force || dateTicks(item.DateLastRefreshed) === 0n) {
    // QueueRefresh is fire-and-forget in ChannelManager. Its host owns the
    // queued operation; failure must not change a successful item list.
    try { void metadata.queue(item.Id, { MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default' }, 1).catch(error => {
      try { void Promise.resolve(onError(error)).catch(() => {}); } catch { /* Reporting cannot reject detached work. */ }
    }); }
    catch (error) { try { void Promise.resolve(onError(error)).catch(() => {}); } catch { /* Logging cannot replace this request. */ } }
  }
  return item;
  } finally { owner.release(); await library.itemCreation.linkedChildren.flushReleases(); }
}
