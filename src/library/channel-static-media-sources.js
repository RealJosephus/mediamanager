import { internalImagePath } from '../metadata/image-paths.js';
import { MetadataImageAssets, imagePathApi } from '../metadata/image-assets.js';
import { md5Guid } from '../core/identity.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { readNativeMediaSourceInfoList } from '../playback/live-stream-info.js';
import { dtoId } from './records.js';

export function channelMediaSourceCachePath(item, metadataPath) {
  const api = imagePathApi(metadataPath);
  // Channel overrides BaseItem.GetInternalMetadataPath. Its folder identity
  // does not use the external content's ChannelId branch.
  const directory = item.Type === 'Channel' ? api.join(metadataPath, 'channels', dtoId(item.Id), 'metadata')
    : internalImagePath(item, metadataPath);
  return api.join(directory, 'channelmediasourceinfos.json');
}

/** Actual ChannelManager.NormalizeMediaSources, after the read/parse catch. */
export function normalizeChannelMediaSources(item, sources) {
  const itemId = dtoId(item.Id);
  const required = source => {
    if (source == null) throw Object.assign(new TypeError('Object reference not set to an instance of an object.'), { nativeException: 'NullReferenceException' });
    return source;
  };
  let hasDefault = sources.some(source => ordinalIgnoreCaseEquals(required(source).Id ?? '', itemId));
  for (const [index, source] of sources.entries()) {
    required(source); source.RunTimeTicks ??= item.RunTimeTicks;
    if (source.Id != null && source.Id !== '') continue;
    if (!hasDefault) { source.Id = itemId; hasDefault = true; continue; }
    const key = source.Path == null || source.Path === '' ? String(index) : source.Path;
    source.Id = md5Guid(itemId + key);
  }
  return sources;
}

/** Saved channel metadata uses existing mapped/state-owned asset access. The
 * native synchronous reader ignores cancellation and swallows file/JSON errors;
 * normalization runs outside that catch and may still fail on a null member. */
export async function readChannelStaticMediaSources(item, { metadataPath, programDataPath, fileSystem, mediaAssets } = {}) {
  metadataPath ??= programDataPath && imagePathApi(programDataPath).join(programDataPath, 'metadata');
  if (!metadataPath || !mediaAssets && !fileSystem) throw new TypeError('Channel saved media sources require instance metadata asset access.');
  const filename = channelMediaSourceCachePath(item, metadataPath);
  const assets = mediaAssets ?? new MetadataImageAssets({ fileSystem, metadataPath });
  let sources;
  try { sources = readNativeMediaSourceInfoList(await assets.read(filename)) ?? []; }
  catch { sources = []; }
  return normalizeChannelMediaSources(item, sources);
}
