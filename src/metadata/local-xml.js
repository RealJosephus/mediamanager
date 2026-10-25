import path from 'node:path';
import { StorageError, requireCapability } from '../storage/errors.js';
import { ItemUpdateType } from './save-manager.js';
import { nativePlaylistIsFile } from '../library/native-path.js';
import { createLocalXmlProviders } from './local-xml-provider.js';
import { directFileXmlSink, networkXmlSpool, validateXmlSpoolRoot } from './local-xml-sinks.js';
import { MetadataImageAssets } from './image-assets.js';

const providerName = 'Emby Xml';


const typeOf = item => String(item?.Type ?? item?.NativeType ?? '').split('.').at(-1);
const apiFor = value => /^[A-Za-z]:[\\/]|^\\\\/u.test(value ?? '') ? path.win32 : path.posix;

function isPlaylistFile(item, value, override) {
  if (override != null) return override === true;
  const api = apiFor(value);
  return typeOf(item) === 'Playlist' && api.extname(value) !== ''
    && nativePlaylistIsFile(item.Type === 'Playlist' ? item : { ...item, Type: 'Playlist' });
}

/** Native BoxSetXmlSaver/PlaylistXmlSaver destination using an identity,
 * state-local or VFS access base path supplied by the owning context. */
export function localXmlSavePath(item, { basePath = item?.Path, playlistFile } = {}) {
  if (typeof basePath !== 'string' || !basePath) throw new TypeError('Local XML metadata requires an item path.');
  const type = typeOf(item), api = apiFor(basePath);
  if (type === 'BoxSet') return api.join(basePath, 'collection.xml');
  if (type !== 'Playlist') throw new TypeError(`Unsupported local XML saver type: ${type}`);
  if (!isPlaylistFile(item, basePath, playlistFile)) return api.join(basePath, 'playlist.xml');
  const extension = api.extname(basePath);
  return basePath.slice(0, basePath.length - extension.length) + '.xml';
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const unsafe = message => new StorageError('permission-denied', message);

async function localDestination(item, context, fileSystem) {
  if (typeof context.localRoot !== 'string' || !path.isAbsolute(context.localRoot)) {
    throw unsafe('State-local XML metadata requires an absolute authorized root.');
  }
  const root = path.resolve(context.localRoot), base = path.resolve(context.localPath);
  const target = path.resolve(localXmlSavePath(item, { basePath: base, playlistFile: context.playlistFile }));
  if (!within(root, base) || !within(root, target)) throw unsafe('Local XML metadata escapes its authorized state root.');
  const playlistFile = isPlaylistFile(item, base, context.playlistFile);
  const container = playlistFile ? path.dirname(base) : base;
  const baseInfo = await fileSystem.lstat(base);
  if (baseInfo.isSymbolicLink() || (playlistFile ? !baseInfo.isFile() : !baseInfo.isDirectory())) {
    throw unsafe('Local XML metadata requires a non-symbolic item path of the expected kind.');
  }
  if (playlistFile) {
    const containerInfo = await fileSystem.lstat(container);
    if (!containerInfo.isDirectory() || containerInfo.isSymbolicLink()) {
      throw unsafe('Local XML metadata requires a non-symbolic containing directory.');
    }
  }
  const [actualRoot, actualContainer] = await Promise.all([fileSystem.realpath(root), fileSystem.realpath(container)]);
  if (!within(actualRoot, actualContainer)) throw unsafe('Local XML metadata resolves outside its authorized state root.');
  try {
    const info = await fileSystem.lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw unsafe('Local XML metadata destination must be a regular non-symbolic file.');
    if (!within(actualRoot, await fileSystem.realpath(target))) throw unsafe('Local XML metadata destination resolves outside its authorized state root.');
  } catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'not-found') throw error; }
  return { kind: 'local', path: target };
}

function destinationPath(item, context) {
  if (context.localPath != null) return localXmlSavePath(item, {
    basePath: context.localPath, playlistFile: context.playlistFile
  });
  if (typeof context.accessPath !== 'string' || !context.accessPath.startsWith('/')) {
    throw new TypeError('Local XML metadata requires an absolute VFS access path or a state-local path.');
  }
  return localXmlSavePath(item, { basePath: context.accessPath, playlistFile: context.playlistFile });
}


import { streamLocalXml } from './local-xml-writer.js';
export { streamLocalXml } from './local-xml-writer.js';

export function createLocalXmlPlugin({ vfs, fileSystem, externalIdInfos, spoolRoot, linkedChildren } = {}) {
  if (!fileSystem || typeof fileSystem.lstat !== 'function' || typeof fileSystem.realpath !== 'function'
    || typeof fileSystem.open !== 'function' || typeof fileSystem.stat !== 'function') {
    throw new TypeError('Local XML metadata requires a filesystem with direct file handles.');
  }
  const validateDestination = async (item, context = {}) => {
    if (context.localPath != null) return localDestination(item, context, fileSystem).catch(error=>{
      if (error.cause?.details?.reason === 'link') throw unsafe(error.message);
      throw error;
    });
    if (!vfs || typeof vfs.capabilities !== 'function' || typeof vfs.write !== 'function') {
      throw new TypeError('Network local XML metadata requires a VFS implementation.');
    }
    const target = destinationPath(item, context), capabilities = vfs.capabilities(target);
    requireCapability({ capabilities }, 'create');
    requireCapability({ capabilities }, 'replace');
    const options = context.vfsWriteOptions ?? {};
    if (options.ifMatch !== undefined) requireCapability({ capabilities }, 'conditionalWrite');
    if (options.atomic === true) requireCapability({ capabilities }, 'atomicReplace');
    return { kind: 'vfs', path: target,
      spoolRoot: await validateXmlSpoolRoot(context.spoolRoot ?? spoolRoot, fileSystem), options };
  };
  const save = async (item, context = {}) => {
    const destination = await validateDestination(item, context);
    const output = destination.kind === 'local'
      ? await directFileXmlSink(destination.path, fileSystem)
      : await networkXmlSpool(destination.spoolRoot, fileSystem);
    let preparationError;
    try {
      try { await streamLocalXml(item, output.sink, {
        ...context, playlistFile: isPlaylistFile(item, item.Path, context.playlistFile),
        prepareLinkedXmlItems: context.prepareLinkedXmlItems ?? (linkedChildren && (async value => {
          const snapshot = await linkedChildren.xmlPaths(value.LinkedChildren, { parentId: value.Id, expandPath: context.expandPath });
          return { manualCount: snapshot.manualCount, pages: options => snapshot.paths.pages(options),
            close: () => linkedChildren.release(snapshot.paths) };
        }))
      }); } catch (error) { preparationError = error; }
      if (destination.kind === 'vfs') {
        try { await output.upload(vfs, destination.path, { overwrite: true, ...destination.options }); }
        catch (error) {
          if (!preparationError) throw error;
          Object.defineProperty(preparationError, 'frameCommitError', { value: error });
        }
      }
      if (preparationError) throw preparationError;
    } finally { if (output.dispose) await output.dispose(); else await output.close(); }
    const result = { path: destination.path, changed: true };
    // DateLastSaved must cover the actual closed file, not a wall-clock sample
    // that can precede the filesystem's final modification timestamp.
    if (destination.kind === 'local') {
      const saved = await new MetadataImageAssets({ fileSystem,
        stateRoots: [context.localRoot] }).stat(destination.path);
      result.dateLastSavedFloor = saved.modified;
    }
    return result;
  };
  const provider = (id, itemType) => ({
    id, name: providerName, kind: 'saver', itemTypes: [itemType], save,
    validateSave: validateDestination,
    getSavePath: (item, context = {}) => destinationPath(item, context),
    getMonitorPath: (item, context = {}) => localXmlSavePath(item, { playlistFile: context.playlistFile }),
    isEnabledFor: item => item.SupportsLocalMetadata === true && typeOf(item) === itemType
  });
  const boxSet = provider('BoxSetXmlSaver', 'BoxSet');
  boxSet.isEnabledFor = (item, updateType) => item.SupportsLocalMetadata === true && typeOf(item) === 'BoxSet'
    && updateType >= ItemUpdateType.MetadataDownload;
  const playlist = provider('PlaylistXmlSaver', 'Playlist');
  playlist.isEnabledFor = (item, updateType) => item.SupportsLocalMetadata === true && typeOf(item) === 'Playlist'
    && updateType >= ItemUpdateType.MetadataImport;
  return { id: 'local-xml', name: providerName, providers: [boxSet, playlist,
    ...createLocalXmlProviders({ fileSystem, vfs, linkedChildren, savePath: localXmlSavePath, externalIdInfos })] };
}

/** Prepare one bounded state-owned stream. The caller must close it in finally. */
export async function serializeLocalXml(item, context = {}) {
  const output = await networkXmlSpool(await validateXmlSpoolRoot(context.spoolRoot, context.fileSystem), context.fileSystem);
  try {
    await streamLocalXml(item, output.sink, { ...context,
      playlistFile: isPlaylistFile(item, item.Path, context.playlistFile) });
    return await output.prepare();
  } catch (error) { await output.dispose(); throw error; }
}
