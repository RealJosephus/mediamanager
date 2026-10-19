import path from 'node:path';
import { getNewItemId } from '../core/identity.js';
import { nativeGuid, nativeDateFromUnixNanoseconds } from '../users/native.js';
import { nativeDate } from '../sessions/user-data.js';
import { dateText, EMPTY_ID, sameId } from './records.js';
import { createVirtualPathExpander, createVirtualPathReverser } from './options.js';
import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';

const aggregateType = 'MediaBrowser.Controller.Entities.AggregateFolder';
const playlistType = 'Emby.Server.Implementations.Playlists.PlaylistsFolder';

const within = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function checkDirectory(root, directory, fileSystem) {
  let existing = directory;
  while (true) {
    try {
      const resolved = await fileSystem.realpath(existing);
      if (!within(root, resolved) || !(await fileSystem.stat(existing)).isDirectory()) {
        throw Object.assign(new Error('Native library root directories must stay inside the isolated instance.'), {
          code: 'UNSAFE_LIBRARY_ROOT_PATH', path: directory,
        });
      }
      return;
    } catch (error) {
      if (error.cause?.details?.reason === 'link') throw Object.assign(new Error('Native library root directories must not traverse links.'), { code:'UNSAFE_LIBRARY_ROOT_PATH',path:directory });
      if (error.code !== 'ENOENT' || existing === root) throw error;
      existing = path.dirname(existing);
    }
  }
}

const folder = (Id, Type, Name, Path, values = {}) => ({
  Id, Type, Name, CleanName: Name.toLowerCase(), SortName: Name.toLowerCase(), Path,
  ChannelId: EMPTY_ID, Genres: '', Studios: '', Tags: '', ProductionLocations: '',
  IsFolder: true, IsInMixedFolder: false, IsLocked: false, IsMovie: false,
  IsRepeat: false, IsSeries: false, IsVirtualItem: false,
  MediaType: 'Unknown', UnratedType: 'Other', Width: 0, Height: 0, ...values,
});

// A runtime without ApplicationPaths has no persistent root to initialize.
// Persistent runtimes always create the real directories and run this before
// library option loading or any public query; there is no test-only switch.
export async function initializeLibraryRoot({ fileSystem, store, programDataPath, dataPath, metadataPath, configuration = {}, now = () => new Date().toISOString() }) {
  if (!programDataPath) return;
  programDataPath = path.resolve(programDataPath);
  dataPath = path.resolve(dataPath ?? path.join(programDataPath, 'data'));
  const rootPath = path.join(programDataPath, 'root');
  const playlistPath = path.join(dataPath, 'playlists');
  const identityOptions = { programDataPath, enableCaseSensitiveItemIds: configuration.EnableCaseSensitiveItemIds };
  const rootId = nativeGuid(getNewItemId(rootPath, aggregateType, identityOptions));
  const playlistId = nativeGuid(getNewItemId(playlistPath, playlistType, identityOptions));
  const expandPath = createVirtualPathExpander({ programDataPath, dataPath, metadataPath });
  const reversePath = createVirtualPathReverser({ programDataPath, dataPath, metadataPath });
  await fileSystem.mkdir(programDataPath, { recursive: true });
  const stateRoot = await fileSystem.realpath(programDataPath);
  // A default/in-tree data path remains confined by the program-data root.
  // An explicitly separate DataPath is itself an application-path boundary;
  // its playlists child must remain beneath that resolved boundary.
  const inStateRoot = within(programDataPath, dataPath);
  if (inStateRoot) await checkDirectory(stateRoot, dataPath, fileSystem);
  await fileSystem.mkdir(dataPath, { recursive: true });
  if (inStateRoot) await checkDirectory(stateRoot, dataPath, fileSystem);
  const dataRoot = await fileSystem.realpath(dataPath);
  await checkDirectory(stateRoot, rootPath, fileSystem);
  await checkDirectory(dataRoot, playlistPath, fileSystem);
  await fileSystem.mkdir(rootPath, { recursive: true });
  await checkDirectory(stateRoot, rootPath, fileSystem);
  await fileSystem.mkdir(playlistPath, { recursive: true });
  await checkDirectory(dataRoot, playlistPath, fileSystem);
  const directory = await fileSystem.stat(playlistPath, { bigint: true });
  await store.serializeWrites(async db => {
    const rootRecord = (await db.rows('BaseItems', { where: { Id: rootId } }))[0];
    const root = rootRecord?.Type === aggregateType ? rootRecord : folder(rootId, aggregateType, path.basename(rootPath), rootPath, {
      DateCreated: nativeDate(now()), Data: JSON.stringify({ VirtualChildren: [], PhysicalLocationsList: [],
        IsRoot: true, IsHD: false, IsShortcut: false, Width: 0, Height: 0,
        DateLastSaved: '0001-01-01T00:00:00.0000000Z', RemoteTrailers: [] }),
    });
    const existing = (await db.rows('BaseItems', { where: { Id: playlistId } }))[0];
    // Native GetItemById must yield a BasePluginFolder with the same path.
    const reuse = existing?.Type === playlistType
      && ordinalIgnoreCaseKey(expandPath(existing.Path) ?? '') === ordinalIgnoreCaseKey(playlistPath);
    const playlists = reuse ? existing : folder(playlistId, playlistType, 'Playlists', reversePath(playlistPath), {
      DateCreated: nativeDateFromUnixNanoseconds(directory.birthtimeNs),
      DateModified: nativeDateFromUnixNanoseconds(directory.mtimeNs), TopParentId: playlistId,
    });
    if (sameId(playlists.ParentId, rootId)) return;
    // These are two independent native repository saves. An error in the
    // second save must not roll the successful aggregate save back.
    const rootSaved = now();
    const data = root.Data == null ? {} : JSON.parse(root.Data);
    data.DateLastSaved = dateText(rootSaved);
    await store.transaction(transaction => transaction.upsert('BaseItems', { ...root,
      Path: rootPath, DateLastSaved: nativeDate(rootSaved), Data: JSON.stringify(data) }));
    const playlistSaved = now();
    await store.transaction(async transaction => {
      await transaction.upsert('BaseItems', { ...playlists, ParentId: rootId, DateLastSaved: nativeDate(playlistSaved), Data: null });
      const ancestors = await transaction.rows('AncestorIds', { where: { ItemId: playlistId } });
      if (!ancestors.some(row => sameId(row.ParentItemId, rootId))) {
        await transaction.insert('AncestorIds', { ItemId: playlistId, ParentItemId: rootId });
      }
      for (const row of ancestors) if (!sameId(row.ParentItemId, rootId)) {
        await transaction.delete('AncestorIds', { ItemId: playlistId, ParentItemId: row.ParentItemId });
      }
    });
  });
}
