import { EOL } from 'node:os';
import { BinaryResult, vfsStreamResult } from '../http/binary-result.js';
import { notFound } from '../http/binding.js';
import { imagePathApi } from '../metadata/image-assets.js';
import { nativeContainingFolderPath, nativeFileName, nativeFileNameWithoutExtension } from '../library/native-path.js';
import { nativeGuid, wireGuid } from '../users/native.js';

const readInfo = (store, itemId, width, signal) => store.run(async db =>
  (await db.rows('TrickplayInfos', { where: { ItemId: nativeGuid(itemId), Width: width }, limit: 1 }))[0], { signal });

export function readTrickplayResolutions(store, itemId, { signal } = {}) {
  return store.run(db => db.rows('TrickplayInfos', { where: { ItemId: nativeGuid(itemId) }, columns: ['Width', 'Height', 'Bandwidth'] }), { signal });
}

export function trickplayDirectory(item, dataPath, saveWithMedia) {
  if (saveWithMedia) {
    const folder = nativeContainingFolderPath(item), name = nativeFileName(item.Path);
    if (!folder || !name) return;
    return imagePathApi(folder).join(folder, nativeFileNameWithoutExtension(name) + '.trickplay');
  }
  if (!dataPath) return;
  const id = nativeGuid(item.Id).toLowerCase();
  return imagePathApi(dataPath).join(dataPath, 'trickplay', id.slice(0, 2), id);
}

export async function trickplayPlaylist(store, itemId, width, { token, signal }) {
  const info = await readInfo(store, itemId, width, signal);
  if (!info || info.ThumbnailCount <= 0) return notFound();
  const perTile = info.TileWidth * info.TileHeight;
  if (perTile <= 0) throw new Error('The saved trickplay tile layout is invalid.');
  const count = Math.ceil(info.ThumbnailCount / perTile);
  const duration = thumbnails => (info.Interval * thumbnails / 1000).toFixed(3).replace(/\.?0+$/u, '');
  const tile = `#EXT-X-TILES:RESOLUTION=${info.Width}x${info.Height},LAYOUT=${info.TileWidth}x${info.TileHeight},DURATION=${duration(1)}`;
  const suffix = `.jpg?MediaSourceId=${wireGuid(itemId)}&ApiKey=${token ?? ''}`;
  const lines = ['#EXTM3U', `#EXT-X-TARGETDURATION:${count}`, '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA-SEQUENCE:1', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-IMAGES-ONLY'];
  for (let index = 0; index < count; index++) {
    lines.push(`#EXTINF:${duration(Math.min(perTile, info.ThumbnailCount - index * perTile))},`, tile, index + suffix);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return BinaryResult.bytes(Buffer.from(lines.join(EOL)), 'application/vnd.apple.mpegurl; charset=utf-8');
}

export async function trickplayTile({ library, store, fileSystem }, itemId, width, index, { user, signal }) {
  let item;
  try { item = await library.getItemRecord(itemId, { user }); }
  catch (error) { if (error?.status === 404) return notFound(); throw error; }
  const info = await readInfo(store, item.Id, width, signal);
  if (!info) return notFound();

  const folders = item.Type === 'CollectionFolder' ? [item] : await library.getCollectionFolders(item);
  const folderId = folders.find(folder => folder.Type === 'CollectionFolder')?.Id;
  const options = library.options.libraryOptions;
  const libraryOptions = folderId && (options instanceof Map ? options.get(wireGuid(folderId)) ?? options.get(folderId)
    : options?.[folderId] ?? options?.[wireGuid(folderId)]);
  const directory = trickplayDirectory(item, library.options.dataPath, libraryOptions?.SaveTrickplayWithMedia);
  if (!directory) return notFound();
  const filename = imagePathApi(directory).join(directory, `${info.Width} - ${info.TileWidth}x${info.TileHeight}`, `${index}.jpg`);
  const vfs = fileSystem.vfs, accessPath = fileSystem.accessPath(filename);
  try { if ((await vfs.stat(accessPath, { signal })).kind !== 'file') return notFound(); }
  catch (error) {
    if (['not-found', 'not-directory', 'permission-denied'].includes(error?.code) && !error.errors) return notFound();
    throw error;
  }
  return vfsStreamResult(vfs, accessPath, { contentType: 'image/jpeg', physicalFile: true, ranges: false, attachment: true });
}
