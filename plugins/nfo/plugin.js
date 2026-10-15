import { decodeNativeText } from '@mediamanager/plugin-sdk/core/native-text';
import { nfoConfiguration } from './configuration.js';
import { nfoPaths, nfoHasChanged } from './paths.js';
import { parseNfoAsync } from './parser.js';
import { serializeNfo } from './saver.js';
import { ItemUpdateType } from '@mediamanager/plugin-sdk/metadata/save-manager';
import { child } from '@mediamanager/plugin-sdk/core/xml';
import { readNfoSaveXml } from './partial-xml.js';
import { applyNfoUserData, applyNfoUserDataEntry } from './user-data-import.js';
import { StorageError, requireCapability } from '@mediamanager/plugin-sdk/storage/errors';

const types = { Movie: 'Movie', Video: 'Video', MusicVideo: 'MusicVideo', Series: 'Series', Season: 'Season', Episode: 'Episode', MusicAlbum: 'Album', MusicArtist: 'Artist' };

async function readSnapshot(vfs, path, signal) {
  const handle = await vfs.openRead(path, { signal });
  try { const chunks = []; for await (const chunk of handle.stream) { signal?.throwIfAborted(); chunks.push(Buffer.from(chunk)); } return { bytes: Buffer.concat(chunks), version: handle.version }; }
  finally { await handle.close(); }
}
const read = async (vfs, path, signal) => (await readSnapshot(vfs, path, signal)).bytes;

export function createNfoPlugin({ vfs, configuration, store, userData, spoolRoot, fileSystem, logger = { error() {} } }) {
  const config = nfoConfiguration(configuration);
  const locate = async (item, context) => {
    for (const path of nfoPaths(item, context)) {
      try { const entry = await vfs.stat(path, { signal: context?.signal }); if (entry.kind === 'file') return { path, ...entry }; }
      catch (error) { if (error.code !== 'not-found') throw error; }
    }
    return null;
  };
  const getMetadata = async (item, context = {}) => {
    const file = await locate(item, context);
    if (!file) return { HasMetadata: false };
    try {
      const xml = decodeNativeText(await read(vfs, file.path, context.signal));
      let applied = 0;
      const onUserDataImport = store && userData
        ? async entry => { if (await applyNfoUserDataEntry(entry, { configuration: config, store, userData })) applied++; }
        : undefined;
      // Native DirectoryService receives the literal NFO value. On Windows a
      // file URI therefore does not alias its decoded filesystem path.
      const localImageStat = context.imageAssets
        ? async value => {
          const literalIdentity = /^file:/iu.test(value);
          try { return await context.imageAssets.stat(value, { literalIdentity }); }
          catch (error) {
            if (['not-found', 'ENOENT', 'ENOTDIR'].includes(error.code) || literalIdentity && error.code === 'unmapped-path') return null;
            throw error;
          }
        }
        : undefined;
      // BaseNfoProvider and BaseVideoNfoProvider parse into newly-created
      // MetadataResult collections. Existing library images are considered
      // later by the refresh host and must not suppress NFO image discovery.
      const result = await parseNfoAsync(xml, { type: item.Type, indexNumber: item.IndexNumber, configuration: config, ...context,
        images: [], remoteImages: [], localImageCandidates: [], onUserDataImport, localImageStat });
      if (onUserDataImport) result.UserDataImportsAppliedCount = applied;
      return result;
    }
    catch (error) {
      if (['not-found', 'unavailable', 'ENOENT', 'EIO'].includes(error.code)
        || ['FileNotFoundException', 'IOException'].includes(error.nativeException ?? error.name)) return { HasMetadata: false };
      throw error;
    }
  };
  const prepareSave = async (item, context = {}) => {
    const path = nfoPaths(item, context)[0];
    const snapshot = async () => {
      try { return await readSnapshot(vfs, path, context.signal); } catch (error) { if (error.code !== 'not-found') throw error; return null; }
    };
    const before = await snapshot();
    const original = before?.bytes;
    const document = original ? readNfoSaveXml(decodeNativeText(original)) : null;
    if (original) {
      // Independent callers must supply the same authoritative collections as the runtime host.
      const root = document.root;
      const missing = [];
      if (root) {
        if (root.children.some((node) => ['actor', 'director', 'writer', 'credits'].includes(node.name)) && !Object.hasOwn(context, 'people') && typeof context.getPeople !== 'function') missing.push('people');
        if (config.SaveImagePathsInNfo && child(root, 'art')?.children.length && !Object.hasOwn(context, 'images')) missing.push('images');
        if (child(child(root, 'fileinfo') ?? { children: [] }, 'streamdetails')?.children.length && !Object.hasOwn(context, 'mediaStreams')) missing.push('mediaStreams');
        if (item.Type === 'MusicAlbum' && child(root, 'track') && !Object.hasOwn(context, 'tracks')) missing.push('tracks');
        if (item.Type === 'MusicArtist' && child(root, 'album') && !Object.hasOwn(context, 'albums')) missing.push('albums');
        if (config.UserId?.trim() && root.children.some((node) => ['watched', 'playcount', 'lastplayed', 'resume', 'isuserfavorite', 'userrating'].includes(node.name)) && !Object.hasOwn(context, 'userData')) missing.push('userData');
      }
      if (missing.length) {
        const error = new Error(`NFO save requires authoritative metadata context: ${missing.join(', ')}.`);
        error.code = 'metadata-context-required'; throw error;
      }
    }
    const prepared = await serializeNfo(item, { configuration: config, spoolRoot, fileSystem, ...context, existingDocument: document, existingPath: path, logger });
    try {
    context.signal?.throwIfAborted();
    let same=original!=null&&BigInt(original.length)===prepared.size;
    if(same){let offset=0;for await(const bytes of prepared.stream()){if(!bytes.equals(original.subarray(offset,offset+bytes.length))){same=false;break;}offset+=bytes.length;}}
    const changed = !same;
    const capabilities = changed ? vfs.capabilities(path) : null;
    if (capabilities) {
      requireCapability({ capabilities }, 'create');
      requireCapability({ capabilities }, 'replace');
    }
    if(!changed)await prepared.close();
    return { path, changed, close:()=>prepared.close(),
      async apply() {
       try {
        if (!changed) return { path, changed: false };
        const current = await snapshot();
        if (Boolean(current) !== Boolean(before) || current && !current.bytes.equals(original)) {
          throw new StorageError('version-changed', 'The NFO file changed before saving.');
        }
        await vfs.write(path, prepared.stream(), { signal: context.signal, overwrite: !before ? false : true, size: prepared.size,
          ...(before?.version && capabilities.conditionalWrite ? { ifMatch: before.version } : {}) });
        return { path, changed: true };
       } finally {await prepared.close();}
      }
    };
    } catch(error) {await prepared.close();throw error;}
  };
  const save = async (item, context = {}) => (await prepareSave(item, context)).apply();
  const validateSave = (item, context = {}) => {
    const capabilities = vfs.capabilities(nfoPaths(item, context)[0]);
    requireCapability({ capabilities }, 'create');
    requireCapability({ capabilities }, 'replace');
  };
  const plugin = { id: 'nfo', name: 'Nfo', configurationKey: 'xbmcmetadata', configuration: config, locate, getMetadata, save, providers: [] };
  for (const [type, name] of Object.entries(types)) plugin.providers.push({ id: `${name}NfoProvider`, name: 'Nfo', kind: 'local', itemTypes: [type], getMetadata });
  plugin.providers.push({ id: 'SeriesNfoSeasonProvider', name: 'Nfo', kind: 'local', itemTypes: ['Season'], getMetadata: (item, context) => getMetadata(item, { ...context, seriesSeason: true }) });
  for (const [name, itemTypes] of [['Movie', ['Movie', 'Video', 'MusicVideo']], ['Series', ['Series']], ['Season', ['Season']], ['Episode', ['Episode']], ['Album', ['MusicAlbum']], ['Artist', ['MusicArtist']]]) plugin.providers.push({
    id: `${name}NfoSaver`, name: 'Nfo', kind: 'saver', itemTypes, save, prepareSave, validateSave,
    getSavePath: (item, context) => nfoPaths(item, context)[0],
    isEnabledFor: async (item, updateType, context) => {
      if (!item.SupportsLocalMetadata || !itemTypes.includes(item.Type)) return false;
      if (name === 'Movie' && item.ExtraType != null) return false;
      if (updateType >= (config.SaveImagePathsInNfo ? ItemUpdateType.ImageUpdate : ItemUpdateType.MetadataDownload)) return true;
      if (name !== 'Season' || updateType < ItemUpdateType.MetadataImport) return false;
      try { return (await vfs.stat(nfoPaths(item, context)[0])).kind === 'file'; } catch (error) { if (error.code === 'not-found') return false; throw error; }
    },
  });
  plugin.hasChanged = async (item, context = {}) => { const file = await locate(item, context); return file ? nfoHasChanged(file.modified, item.DateLastSaved) : false; };
  for (const provider of plugin.providers.filter(provider => provider.kind === 'local')) {
    provider.hasChanged = (item, context) => plugin.hasChanged(item, provider.id === 'SeriesNfoSeasonProvider' ? { ...context, seriesSeason: true } : context);
    provider.applySideEffects = (result, context) => result.UserDataImportsApplied
      ? { applied: result.UserDataImportsAppliedCount ?? 0, ignored: (result.UserDataImports?.length ?? 0) - (result.UserDataImportsAppliedCount ?? 0) }
      : applyNfoUserData(result, { ...context, configuration: config });
  }
  plugin.userDataSaveReasons = ['PlaybackFinished', 'TogglePlayed', 'UpdateUserRating'];
  plugin.shouldHandleUserDataSaved = (event) => plugin.userDataSaveReasons.includes(event.SaveReason) && Boolean(config.UserId?.trim());
  plugin.onUserDataSaved = async (event, saveMetadata) => {
    if (!plugin.shouldHandleUserDataSaved(event) || !event.Item.IsFileProtocol || !event.Item.SupportsLocalMetadata) return false;
    try { await saveMetadata(event.Item, 'MetadataDownload', ['Nfo']); return true; }
    catch (error) { logger.error(error, 'Error saving metadata', { Path: event.Item.Path ?? event.Item.Name }); return false; }
  };
  return plugin;
}
