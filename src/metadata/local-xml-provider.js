import { decodeNativeTextStream } from './native-text-stream.js';
import { dateTicks } from '../library/records.js';
import { nativePlaylistIsFile } from '../library/native-path.js';
import { newNativeItemEntity, releaseNativeItemLinks } from '../library/native-item-entity.js';
import { MetadataImageAssets } from './image-assets.js';
import { fetchLocalXml } from './local-xml-parser.js';

const types = { BoxSet: 'MediaBrowser.Controller.Entities.Movies.BoxSet', Playlist: 'MediaBrowser.Controller.Playlists.Playlist' };
const missing = error => ['not-found', 'ENOENT', 'ENOTDIR'].includes(error.code);
const ioError = error => missing(error) || ['io', 'unavailable', 'EIO'].includes(error.code);

/** Native GetXmlFile performs uncancelled lookup; only parser outer iterations
 * observe cancellation. Network paths never fall back to host media files. */
export function createLocalXmlProviders({ fileSystem, vfs, savePath, store, linkedChildren, externalIdInfos = () => [] } = {}) {
  const locate = async (item, context) => {
    let playlistFile = context.playlistFile;
    if (item.Type === 'Playlist' && playlistFile == null && nativePlaylistIsFile(item)) {
      try {
        const info = context.localPath
          ? await assets(context).stat(context.localPath)
          : await vfs.stat(context.accessPath);
        playlistFile = info.kind !== 'directory';
      } catch (error) { if (!missing(error)) throw error; }
    }
    const filename = savePath(item, { basePath: context.localPath ?? context.accessPath, playlistFile });
    try {
      const info = context.localPath ? await assets(context).stat(filename) : await vfs.stat(filename);
      return info.kind === 'file' ? { ...info, filename, local: context.localPath != null } : null;
    } catch (error) { if (missing(error)) return null; throw error; }
  };
  const assets = context => {
    if (!context.localRoot) throw new TypeError('State-local XML reading requires an authorized state root.');
    return new MetadataImageAssets({ fileSystem, stateRoots: [context.localRoot] });
  };
  const read = async function* (file, context) {
    const handle = await (file.local ? assets(context).openRead(file.filename) : vfs.openRead(file.filename));
    try { yield* decodeNativeTextStream(handle.stream); }
    finally { await handle.close(); }
  };
  return Object.keys(types).map(type => ({
    id: `${type}XmlProvider`, name: 'Emby Xml', kind: 'local', order: 1, itemTypes: [type],
    async getMetadata(item, context = {}) {
      const file = await locate(item, context);
      if (!file) return { HasMetadata: false, Item: null, People: null };
      const result = { HasMetadata: false, Item: newNativeItemEntity(types[type]), People: [] };
      try {
        const ids = context.externalIdInfos ?? await externalIdInfos(result.Item);
        return await linkedChildren.withSession(session => fetchLocalXml(async () => read(file, context), { type, result,
          signal: context.signal, externalIdInfos: ids, session, linkedChildren }));
      } catch (error) {
        if (ioError(error)) return result;
        releaseNativeItemLinks(result.Item); await linkedChildren.flushReleases(); throw error;
      }
    },
    async hasChanged(item, context = {}) {
      const file = await locate(item, context);
      return file != null && dateTicks(file.modified) > dateTicks(item.DateLastSaved);
    }
  }));
}
