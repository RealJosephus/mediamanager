import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import { getNewItemId } from '../core/identity.js';
import { nativeDate, nativeDateFromUnixNanoseconds, nativeGuid, wireGuid } from '../users/native.js';
import { dtoOptions as selectDtoOptions, projectItem, sortName } from './dto.js';
import { parseQuery } from './query.js';
import { cleanValue, idKey, libraryError, mapRecord, nonemptyId, sameId, unsupported } from './records.js';
import { serializeLocalXml } from '../metadata/local-xml.js';
import { buildPostgresPlaylistVisibility, queryPostgresDeletedUserPlaylistBatch,
  queryPostgresPlaylistAccess, queryPostgresPlaylistAccessBatch,
  queryPostgresPlaylistPage, queryPostgresPlaylistShellBatch,
  postgresPlaylistItemExists } from './postgres-playlist-query.js';
import { loadPostgresNavigationRows, loadPostgresPageGraph, loadPostgresRowsByIds } from './postgres-library-query.js';
import { replacePostgresItemAncestors } from './postgres-item-relation-mutation.js';
import { nativeContainsSubPath } from './native-path.js';
import { PlaylistFileWriter } from './playlist-file.js';
import {createNativeItemCohort} from './native-item-cohort.js';
import {cloneNativeItemEntity,publishNativeItemLinks,acquireNativeItemLinkOwner} from './native-item-entity.js';
import {EMPTY_NATIVE_LINKS} from './postgres-linked-children.js';
import {playlistStoredLinksPlan,insertPlaylistLinks,emptyPlaylistLinks,movePlaylistLink} from './postgres-playlist-membership.js';
import {quoteIdentifier as q} from '../database/model.js';
import {nativeTextBytes,decodeNativeTextBytes} from '../database/native-text.js';
import {nativeTextSql} from '../database/native-text-sql.js';

export const playlistNativeType = 'MediaBrowser.Controller.Playlists.Playlist';
const playlistsFolderNativeType = 'Emby.Server.Implementations.Playlists.PlaylistsFolder';
const writeLockTables = Object.freeze(['BaseItems', 'AncestorIds', 'LinkedChildren']);
const directlyPlayableTypes = new Set(['Audio', 'AudioBook', 'Video', 'Movie', 'Episode', 'MusicVideo', 'Trailer']);
const knownNonPlayableTypes = new Set(['Book', 'Channel', 'Genre', 'LiveTvChannel', 'LiveTvProgram', 'Person', 'Photo', 'Studio', 'Year']);
const mediaTypes = Object.freeze(['Unknown', 'Video', 'Audio', 'Photo', 'Book']);

const itemType = item => String(item?.Type ?? item?.NativeType ?? '').split('.').at(-1);
const storedJson = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint'
  ? JSON.rawJSON(entry.toString()) : entry);

function sanitizeFolderName(value) {
  if (typeof value !== 'string' || !value.trim()) throw libraryError(400, 'The Name field is required.');
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) {
    throw libraryError(400, 'The playlist name cannot be an absolute path.');
  }
  const sanitized = [...value].map(character => character.charCodeAt(0) < 32
    || ['"', '<', '>', '|', ':', '*', '?', '\\', '/'].includes(character) ? ' ' : character).join('');
  if (!sanitized.trim() || ['.', '..'].includes(sanitized)
    || /[. ]$/u.test(sanitized) || sanitized.includes('\0')) {
    throw libraryError(400, 'The playlist name does not produce a safe directory name.');
  }
  return sanitized;
}

function normalizeShares(value = []) {
  if (!Array.isArray(value)) throw libraryError(400, 'Users must be an array.');
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw libraryError(400, 'Invalid playlist user.');
    return { UserId: wireGuid(entry.UserId), CanEdit: entry.CanEdit === true };
  });
}

function normalizeMediaType(value) {
  if (value == null) return null;
  if (Number.isInteger(value) && value >= 0 && value < mediaTypes.length) return mediaTypes[value];
  const found = mediaTypes.find(entry => entry.toLowerCase() === String(value).toLowerCase());
  if (!found) throw libraryError(400, `Invalid playlist media type: ${value}`);
  return found;
}

function directChild(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`)
    && !relative.includes(path.sep);
}

async function missing(fileSystem, value) {
  try { await fileSystem.lstat(value); return false; }
  catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
}

function transactionOptions(signal) {
  return { signal, writeLockTables, isolation: 'repeatable-read', lockTimeoutMs: 250 };
}

export class PlaylistService {
  #closed = false;
  #tail = Promise.resolve();
  #refreshTail = Promise.resolve();
  #resources = new AsyncLocalStorage();

  constructor({ store, library, programDataPath, dataPath, configuration = {}, fileSystem = library?.options.fileSystem,
    vfs, identityMap, linkedChildren,spoolRoot,preflightExternalSave = async () => {}, updateExternalRepository, queueExternalRefresh = () => {},
    clock = () => new Date(), onError = () => {} } = {}) {
    if (!store || !library || typeof programDataPath !== 'string' || !path.isAbsolute(programDataPath)
      || typeof dataPath !== 'string' || !path.isAbsolute(dataPath)) {
      throw new TypeError('PlaylistService requires a store, library and absolute program/data paths.');
    }
    this.store = store;
    this.library = library;
    this.programDataPath = path.resolve(programDataPath);
    this.dataPath = path.resolve(dataPath);
    this.playlistsPath = path.join(this.dataPath, 'playlists');
    this.configuration = configuration;
    this.fileSystem = fileSystem;
    this.clock = clock;
    this.onError = onError;
    if(!linkedChildren||typeof spoolRoot!=='string'||!path.isAbsolute(spoolRoot))throw new TypeError('PlaylistService requires SQL links and an owned spool root.');
    this.linkedChildren=linkedChildren;this.spoolRoot=spoolRoot;
    this.fileWriter = new PlaylistFileWriter({ fileSystem, vfs, identityMap,spoolRoot });
    this.preflightExternalSave = preflightExternalSave;
    this.updateExternalRepository = updateExternalRepository;
    this.queueExternalRefresh = queueExternalRefresh;
  }

  #enqueue(operation) {
    if (this.#closed) return Promise.reject(libraryError(503, 'The playlist service is closed.'));
    const task = this.#tail.then(() => {
      if (this.#closed) throw libraryError(503, 'The playlist service is closed.');
      return this.#using(()=>this.store.serializeWrites(operation, { lockTimeoutMs: 250 }));
    });
    this.#tail = task.catch(() => {});
    return task;
  }

  #own(value,dispose){const resources=this.#resources.getStore();if(!resources)throw new Error('A playlist operation owner is required.');resources.push(()=>dispose(value));return value;}
  async #using(operation){const resources=[];return this.#resources.run(resources,async()=>{try{return await operation();}finally{const failures=[];for(const dispose of resources.reverse())try{await dispose();}catch(error){failures.push(error);}try{await this.linkedChildren.flushReleases();}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'Playlist operation release failed.');}});}
  #ownLinks(handle){return this.#own(handle,value=>this.linkedChildren.release(value));}
  async #cohort(){return this.#own(await createNativeItemCohort({linkedChildren:this.linkedChildren}),value=>value.release());}
  async #currentLinks(db,id,options){return this.#ownLinks(await this.linkedChildren.createFromSnapshot({session:db,parentId:id,plan:playlistStoredLinksPlan(db,id,options)}));}

  async #state(db, user, { includeUserData = false, ids = [] } = {}) {
    const navigationRows=await loadPostgresNavigationRows(db),requested=await loadPostgresRowsByIds(db,ids);
    const baseRows=await loadPostgresPageGraph(db,requested,navigationRows,{includeManualLinks:false});
    return this.#own(await this.library.load(db,user,{includeUserData,baseRows,includeManualLinks:false,includeLinkGraph:false}),value=>value.dispose());
  }

  async #expand(itemIds, user, { deferRelatedNameAccess = false } = {}) {
    const children=await this.#cohort();let ordinal=0n,mediaType=null;
    const links=await this.store.run(async session=>{const writer=await this.linkedChildren.createWriter({session});
    const add=async item=>{await writer.append({ItemId:item.Id,Type:0});await children.capture(item,{ordinal:++ordinal});if(mediaType==null&&item.MediaType&&item.MediaType!=='Unknown')mediaType=item.MediaType;};
    try{
    for (const value of itemIds) await this.library.store.run(async db => {
      const localState=await this.library.load(db,user,{includeUserData:false,includeLinkGraph:false,baseRows:await loadPostgresPageGraph(db,await loadPostgresRowsByIds(db,[value]),await loadPostgresNavigationRows(db),{includeManualLinks:false})});
      try{const item = localState.byId.get(idKey(value));
      const deferredNameAccess = deferRelatedNameAccess && ['MusicArtist', 'MusicGenre'].includes(item?.Type);
      if (!item || user && !await this.library.isItemVisible(item, user, localState, {
        skipRelatedNameCheck: deferredNameAccess,
      })) return;
      let query;
      if (item.Type === 'MusicArtist' || item.Type === 'MusicGenre') {
        query = { Recursive: true, IncludeItemTypes: ['Audio'],
          [item.Type === 'MusicArtist' ? 'ArtistIds' : 'GenreIds']: [item.Id],
          SortBy: ['AlbumArtist', 'Album', 'SortName'], SortOrder: ['Ascending', 'Ascending', 'Ascending'] };
      } else if (item.IsFolder) {
        query = { ParentId: item.Id, Recursive: true, IsFolder: false,
          MediaTypes: ['Audio', 'Video'], EnableTotalRecordCount: false };
      } else if (directlyPlayableTypes.has(item.Type)) {
        await add(item);
        return;
      } else if (knownNonPlayableTypes.has(item.Type)) return;
      else unsupported(`Playlist expansion for ${item.NativeType ?? item.Type} is not implemented.`);
      for(let start=0;;){const page=await this.library.getItemList({...query,StartIndex:start,Limit:128},{user});
      for (const child of page) {
        if (directlyPlayableTypes.has(child.Type)) await add(child);
        else if (!knownNonPlayableTypes.has(child.Type)) {
          unsupported(`Playlist expansion for ${child.NativeType ?? child.Type} is not implemented.`);
        }
      }
      if(page.length<128)break;start+=page.length;}
      }finally{await localState.dispose({session:db});}
    });
    return writer.finish();}catch(error){await writer.abort();throw error;}});
    return {links:this.#ownLinks(links),children,count:ordinal,mediaType};
  }

  async #visible(playlist, user, state) {
    return Boolean(user && await this.library.isItemVisible(playlist, user, state));
  }

  #canEdit(playlist, user) {
    return Boolean(user && (sameId(playlist.OwnerUserId, user.Id)
      || playlist.Shares.some(share => share.CanEdit === true && sameId(share.UserId, user.Id))));
  }

  async #playlist(db, id, user, { visible = true, includeUserData = false, seedIds = [] } = {}) {
    const state = await this.#state(db, user, { includeUserData, ids: [id] });
    const playlist = state.byId.get(idKey(id));
    if (!playlist || playlist.Type !== 'Playlist' || visible && !await this.#visible(playlist, user, state)) {
      throw libraryError(404, 'Playlist not found');
    }
    if (!Array.isArray(playlist.Shares)) throw libraryError(500, 'Invalid Playlist.Shares.');
    return { playlist, state };
  }

  async #postgresPlaylistShell(db, id) {
    const row = (await loadPostgresRowsByIds(db, [id]))[0];
    const playlist = row && this.#record(row);
    if (!playlist || playlist.Type !== 'Playlist') throw libraryError(404, 'Playlist not found');
    if (!Array.isArray(playlist.Shares)) throw libraryError(500, 'Invalid Playlist.Shares.');
    const parentRow = nonemptyId(playlist.ParentId)
      ? (await loadPostgresRowsByIds(db, [playlist.ParentId]))[0] : null;
    return { playlist, parent: parentRow ? this.#record(parentRow) : null };
  }

  #record(row) {
    const item = mapRecord(row);
    if (item) item.Path = this.library.options.expandPath?.(item.Path) ?? item.Path;
    return item;
  }

  async #postgresPlaylistRead(db, id, user) {
    const shell = await this.#postgresPlaylistShell(db, id);
    const navigationRows = await loadPostgresNavigationRows(db);
    const visibility = buildPostgresPlaylistVisibility(navigationRows, user, this.library.options.libraryOptions);
    if (!nativeContainsSubPath(shell.playlist.Path, this.dataPath)) {
      const graph = await loadPostgresPageGraph(db, await loadPostgresRowsByIds(db, [id]), navigationRows);
      const state = await this.library.load(db, user, { baseRows: graph });
      try{if (!await this.library.isItemVisible(shell.playlist, user, state, {
        playlistVisibilityChecked: true,
      })) throw libraryError(404, 'Playlist not found');}finally{await state.dispose();}
    }
    if (!await queryPostgresPlaylistAccess(db, shell.playlist, {
      user,
      dataPath: this.dataPath,
      programDataPath: this.programDataPath,
      visibility,
    })) throw libraryError(404, 'Playlist not found');
    return { ...shell, navigationRows, visibility };
  }

  async #writeTarget(playlist) {
    if (typeof playlist.Path === 'string' && directChild(this.playlistsPath, path.resolve(playlist.Path))) {
      await this.#managedDirectory(playlist.Path);
      return { kind: 'managed' };
    }
    const plan = await this.fileWriter.prepare(playlist);
    if (typeof this.updateExternalRepository !== 'function') unsupported('The external playlist repository lifecycle is not configured.');
    await this.preflightExternalSave(playlist);
    return { kind: 'external', plan };
  }

  async #finishUpdate(committed, reason, refresh = false) {
    const external = committed.target?.kind === 'external';
    if (committed.externalChanges) {
      // The runtime owns the native saver -> image -> repository -> event
      // phases. Preparation never runs that lifecycle inside a transaction.
      await this.updateExternalRepository(committed.playlist, committed.externalChanges);
    } else {
      this.library.reportItemUpdated(committed.playlist, committed.parent, external ? 16 : reason);
    }
    // UpdateToRepositoryAsync publishes MetadataEdit before SavePlaylistFile.
    if (external) {
      await this.fileWriter.write(committed.target.plan, committed.children);
      if (refresh) {
        const task = this.queueExternalRefresh(committed.playlist);
        Promise.resolve(task).catch(error => { try { this.onError(error); } catch { /* Observer only. */ } });
      }
    } else if (refresh) this.#queueXml(committed.playlist);
  }

  async #managedDirectory(value) {
    if (typeof value !== 'string') throw libraryError(409, 'The playlist path is not a managed directory.');
    const root = await this.fileSystem.realpath(this.playlistsPath);
    const candidate = path.resolve(value);
    const info = await this.fileSystem.lstat(candidate);
    const resolved = await this.fileSystem.realpath(candidate);
    if (!info.isDirectory() || info.isSymbolicLink() || !directChild(root, resolved)
      || path.dirname(resolved).toLowerCase() !== root.toLowerCase()) {
      throw libraryError(409, 'The playlist path is not a managed directory.');
    }
    return resolved;
  }

  async #replaceFile(filename, contents) {
    const temporary = path.join(path.dirname(filename), `.playlist-${randomUUID()}.tmp`);
    try {
      const file=await this.fileSystem.open(temporary,'wx');
      try{for await(const bytes of contents.stream())for(let offset=0;offset<bytes.length;){const written=await file.write(bytes,offset,bytes.length-offset);if(!written.bytesWritten)throw new Error('The playlist XML write made no progress.');offset+=written.bytesWritten;}}
      finally{await file.close();}
      await this.fileSystem.rename(temporary, filename);
    } catch (error) {
      try { await this.fileSystem.rm(temporary, { force: true }); }
      catch { /* Preserve the primary sidecar failure. */ }
      throw error;
    }
  }

  async #writeXml(playlist) {
    const directory = await this.#managedDirectory(playlist.Path);
    const filename = path.join(directory, 'playlist.xml');
    let previous = null;
    try {
      const info = await this.fileSystem.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw libraryError(409, 'The playlist metadata path is not a regular file.');
      previous=path.join(this.spoolRoot,`playlist-backup-${randomUUID()}.tmp`);await this.fileSystem.copyFile(filename,previous);
    }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const restore = async () => {
      if (previous == null) await this.fileSystem.rm(filename, { force: true });
      else await this.fileSystem.copyFile(previous,filename);
    };
    if(previous)this.#own(previous,value=>this.fileSystem.rm(value,{force:true}));
    const owner = acquireNativeItemLinkOwner(playlist);
    let contents;
    try {
    contents = await serializeLocalXml(playlist, { fileSystem: this.fileSystem,
      playlistFile:false,spoolRoot:this.spoolRoot,getPeople:()=>this.library.itemCreation.loadContext.withContext(playlist.Id,{draft:playlist,includeChildren:false},loaded=>loaded.context.getPeople(playlist)),
      prepareLinkedXmlItems:async item=>{const prepared=await this.linkedChildren.xmlPaths(item.LinkedChildren,{parentId:item.Id,expandPath:this.library.options.expandPath});
        return{manualCount:prepared.manualCount,pages:options=>this.linkedChildren.pages(prepared.paths,options),close:()=>this.linkedChildren.release(prepared.paths)};}
    });
    try { await this.#replaceFile(filename, contents); }
    catch (error) {
      try { await restore(); }
      catch (restoreError) {
        throw new AggregateError([error, restoreError], 'Playlist metadata could not be written or restored.', { cause: error });
      }
      throw error;
    }
    return restore;
    } finally {
      try { await contents?.close(); } finally { owner.release(); }
    }
  }

  async #childrenSnapshot(db,links,{manualOnly=false}={}){
    const cohort=await this.#cohort();let ordinal=0n;
    for await(const page of this.linkedChildren.pages(links)){
      const selected=manualOnly?page.filter(row=>row.Type===0):page;
      const rows=await loadPostgresRowsByIds(db,selected.map(row=>row.ItemId).filter(nonemptyId));
      const state=await this.library.load(db,null,{includeUserData:false,baseRows:rows,includeLinkGraph:false});
      try{for(const row of selected){const item=state.byId.get(idKey(row.ItemId));if(item)await cohort.capture(item,{ordinal:++ordinal});}}
      finally{await state.dispose();}
    }
    return cohort;
  }

  async #replaceLinks(db, playlist, links, { mediaAdded = false } = {}) {
    publishNativeItemLinks(playlist,this.linkedChildren.retain(links));
    await this.linkedChildren.persist(db,playlist,{reversePath:value=>value});
    const now = nativeDate(this.clock());
    const changes = { DateLastSaved: now };
    if (mediaAdded) changes.DateLastMediaAdded = now;
    await db.update('BaseItems', { Id: playlist.Id }, changes);
    const updated=this.#record((await db.rows('BaseItems', { where: { Id: playlist.Id }, limit: 1 }))[0]);
    publishNativeItemLinks(updated,this.linkedChildren.retain(links));this.#own(acquireNativeItemLinkOwner(updated),owner=>owner.release());return updated;
  }

  async #metadataUpdate(db, playlist, state, { name, links, shares, openAccess, ownerUserId, mediaAdded = false, target } = {}) {
    const finalLinks=links??await this.#currentLinks(db,playlist.Id);
    const children=await this.#childrenSnapshot(db,finalLinks);
    if (target?.kind === 'external') {
      return { playlist, children, externalChanges: { name, links, shares, openAccess, ownerUserId, mediaAdded } };
    }
    if (links != null){publishNativeItemLinks(playlist,this.linkedChildren.retain(finalLinks));await this.linkedChildren.persist(db,playlist,{reversePath:value=>value});}
    const data = { ...playlist.Data };
    if (shares !== undefined) data.Shares = shares;
    if (openAccess !== undefined) data.OpenAccess = openAccess;
    if (ownerUserId !== undefined) data.OwnerUserId = wireGuid(ownerUserId);
    const saved = nativeDate(this.clock());
    const changes = { Data: storedJson(data), DateLastSaved: saved };
    if (name !== undefined) Object.assign(changes, {
      Name: name, CleanName: cleanValue(name),
      SortName: sortName({ Type: playlist.NativeType, Name: name }, this.library.options) ?? cleanValue(name)
    });
    if (mediaAdded) changes.DateLastMediaAdded = saved;
    await db.update('BaseItems', { Id: playlist.Id }, changes);
    const updated = this.#record((await db.rows('BaseItems', { where: { Id: playlist.Id }, limit: 1 }))[0]);
    publishNativeItemLinks(updated,this.linkedChildren.retain(finalLinks));this.#own(acquireNativeItemLinkOwner(updated),owner=>owner.release());
    return { playlist: updated, children, restore: await this.#writeXml(updated) };
  }

  async #edit(id, user, changes, { signal, ownerOnly = false, target, seedIds = [] } = {}) {
    let restore;
    let committed;
    try {
      committed = await this.store.transaction(async db => {
        const { playlist, state } = await this.#playlist(db, nativeGuid(id), user, { seedIds });
        if (ownerOnly ? !sameId(playlist.OwnerUserId, user.Id) : !this.#canEdit(playlist, user)) throw libraryError(403, 'Forbidden');
        if (target && playlist.Path !== target.plan.identityPath) throw libraryError(409, 'The playlist path changed before saving.');
        const destination = target ?? await this.#writeTarget(playlist);
        const options = typeof changes === 'function' ? await changes(playlist, state) : changes;
        const result = await this.#metadataUpdate(db, playlist, state, { ...options, target: destination });
        restore = result.restore;
        return { playlist: result.playlist, children: result.children, externalChanges: result.externalChanges, target: destination,
          parent: state.byId.get(idKey(playlist.ParentId)) };
      }, transactionOptions(signal));
    } catch (error) { return this.#restore(restore, error); }
    await this.#finishUpdate(committed, 16);
  }

  async #restore(restore, error) {
    if (!restore) throw error;
    try { await restore(); }
    catch (restoreError) {
      throw new AggregateError([error, restoreError], 'Playlist persistence failed and its filesystem state could not be restored.', { cause: error });
    }
    throw error;
  }

  #queueXml(playlist) {
    const captured=cloneNativeItemEntity(playlist),owner=acquireNativeItemLinkOwner(captured);
    const refresh = this.#refreshTail.then(()=>this.#using(()=>this.#writeXml(captured))).finally(async()=>{owner.release();await this.linkedChildren.flushReleases();});
    this.#refreshTail = refresh.catch(error => {
      try { this.onError(error); } catch { /* Metadata refresh reporting cannot break committed writes. */ }
    });
  }

  async create({ name, ids = [], user, mediaType, users = [], isPublic = true, signal } = {}) {
    return this.#enqueue(async () => {
      if (!user) throw libraryError(403, 'A playlist owner is required.');
      const folderName = sanitizeFolderName(name);
      if (!Array.isArray(ids)) throw libraryError(400, 'Ids must be an array.');
      const itemIds = ids.map(nativeGuid);
      const shares = normalizeShares(users);
      mediaType = normalizeMediaType(mediaType);
      await this.fileSystem.mkdir(this.playlistsPath, { recursive: true });
      const root = await this.fileSystem.realpath(this.playlistsPath);
      let candidate = path.join(root, folderName);
      if (!directChild(root, candidate)) throw libraryError(400, 'The playlist path is outside the managed playlist directory.');
      while (true) {
        try { await this.fileSystem.mkdir(candidate); break; }
        catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          candidate += '1';
          if (!directChild(root, candidate)) throw libraryError(400, 'The playlist path is outside the managed playlist directory.');
        }
      }
      let restore = () => this.fileSystem.rm(candidate, { recursive: true, force: true });
      let committed;
      try {
        // Expansion can resolve root navigation and linked children. Keep it
        // outside the commit transaction under this operation's writer lock.
        const { state, parent, playable } = await this.store.run(async db => {
          const parentId = nativeGuid(getNewItemId(this.playlistsPath, playlistsFolderNativeType, {
            programDataPath: this.programDataPath,
            enableCaseSensitiveItemIds: this.configuration.EnableCaseSensitiveItemIds
          }));
          const state = await this.#state(db, user, { ids: [parentId] });
          const parent = state.byId.get(idKey(parentId));
          if (!parent || parent.NativeType !== playlistsFolderNativeType) {
            throw libraryError(500, 'The native playlists folder is unavailable.');
          }
          for (const id of itemIds) {
            const selectedState=await this.library.load(db,user,{includeUserData:false,includeLinkGraph:false,baseRows:await loadPostgresPageGraph(db,await loadPostgresRowsByIds(db,[id]),await loadPostgresNavigationRows(db),{includeManualLinks:false})});
            try{const item = selectedState.byId.get(idKey(id));
            if (!item) throw libraryError(400, 'No item exists with the supplied Id');
            if (mediaType == null || mediaType === 'Unknown') {
              if (item.MediaType && item.MediaType !== 'Unknown') mediaType = item.MediaType;
              else if (['MusicArtist', 'MusicAlbum', 'MusicGenre'].includes(item.Type)) mediaType = 'Audio';
              else if (item.Type === 'Genre') mediaType = 'Video';
              else if(item.IsFolder)mediaType=(await this.library.getItemList({ParentId:item.Id,Recursive:true,IsFolder:false,MediaTypes:['Audio','Video'],Limit:1},{user}))[0]?.MediaType;
            }
            }finally{await selectedState.dispose();}
          }
          const playable = await this.#expand(itemIds, user,
            { deferRelatedNameAccess: true });
          if ((mediaType == null || mediaType === 'Unknown') && playable.count) {
            mediaType = playable.mediaType ?? mediaType;
          }
          if (mediaType == null || mediaType === 'Unknown') mediaType = 'Audio';
          return { state, parent, playable };
        });
        committed = await this.store.transaction(async db => {
          const link = await this.fileSystem.lstat(candidate, { bigint: true });
          if (!link.isDirectory() || link.isSymbolicLink()) throw libraryError(409, 'The playlist path is not a safe directory.');
          const resolved = await this.fileSystem.realpath(candidate);
          if (!directChild(root, resolved) || path.dirname(resolved).toLowerCase() !== root.toLowerCase()) {
            throw libraryError(409, 'The playlist path left the managed playlist directory.');
          }
          const Id = nativeGuid(getNewItemId(resolved, playlistNativeType, {
            programDataPath: this.programDataPath,
            enableCaseSensitiveItemIds: this.configuration.EnableCaseSensitiveItemIds
          }));
          if (state.byId.has(idKey(Id)) || await postgresPlaylistItemExists(db, Id)) {
            throw libraryError(409, 'The deterministic playlist identity already exists.');
          }
          const saved = nativeDate(this.clock());
          const data = { OwnerUserId: wireGuid(user.Id), OpenAccess: isPublic === true, Shares: shares,
            PlaylistMediaType: mediaType };
          const row = await db.insert('BaseItems', {
            Id, Type: playlistNativeType, Name: name, CleanName: cleanValue(name),
            SortName: sortName({ Type: playlistNativeType, Name: name }, this.library.options) ?? cleanValue(name),
            Path: resolved, ParentId: parent.Id, TopParentId: parent.Id,
            DateCreated: nativeDateFromUnixNanoseconds(link.birthtimeNs),
            DateModified: nativeDateFromUnixNanoseconds(link.mtimeNs), DateLastSaved: saved,
            Genres: '', Studios: '', Tags: '', ProductionLocations: '',
            IsFolder: true, IsInMixedFolder: false, IsLocked: false, IsMovie: false,
            IsRepeat: false, IsSeries: false, IsVirtualItem: false,
            MediaType: mediaType, UnratedType: 'Other', Width: 0, Height: 0, Data: storedJson(data)
          });
          const ancestorIds = [parent.Id, ...(await db.rows('AncestorIds', { where: { ItemId: parent.Id } }))
            .map(entry => entry.ParentItemId)].filter((value, index, values) => values.findIndex(other => sameId(other, value)) === index);
          const desiredAncestors = ancestorIds.filter(ParentItemId => !sameId(ParentItemId, Id));
          await replacePostgresItemAncestors(db, Id, desiredAncestors);
          let playlist = this.#record(row);
          publishNativeItemLinks(playlist,this.linkedChildren.retain(playable.links));this.#own(acquireNativeItemLinkOwner(playlist),owner=>owner.release());
          await this.linkedChildren.persist(db,playlist,{reversePath:value=>value});
          if (playable.count) {
            const mediaAdded = nativeDate(this.clock());
            await db.update('BaseItems', { Id }, { DateLastMediaAdded: mediaAdded, DateLastSaved: mediaAdded });
            playlist = this.#record((await db.rows('BaseItems', { where: { Id }, limit: 1 }))[0]);
            publishNativeItemLinks(playlist,this.linkedChildren.retain(playable.links));this.#own(acquireNativeItemLinkOwner(playlist),owner=>owner.release());
          }
          // Native creation performs its synchronous ForceSave before AddToPlaylist;
          // the populated sidecar is produced by the queued post-add refresh.
          const initial=cloneNativeItemEntity(playlist);publishNativeItemLinks(initial,EMPTY_NATIVE_LINKS);this.#own(acquireNativeItemLinkOwner(initial),owner=>owner.release());
          const restoreXml = await this.#writeXml(initial);
          const removeDirectory = restore;
          restore = async () => { await restoreXml(); await removeDirectory(); };
          return { playlist, parent, children: playable.children,count:playable.count,id: wireGuid(Id) };
        }, transactionOptions(signal));
      } catch (error) { return this.#restore(restore, error); }
      restore = null;
      this.library.reportItemAdded(committed.playlist, committed.parent);
      if (committed.count) this.#queueXml(committed.playlist);
      return { Id: committed.id };
    });
  }

  async get(id, { user, signal } = {}) {
    return this.store.run(async db => {
      const result = await this.#postgresPlaylistRead(db, nativeGuid(id), user);
      const { playlist } = result;
      const plan=playlistStoredLinksPlan(db,playlist.Id,{resolvedOnly:true}),ItemIds=[];
      const cursor=q('playlist_get_'+randomUUID().replaceAll('-',''));
      await db.client.query({text:`DECLARE ${cursor} NO SCROLL CURSOR FOR ${plan.text}`,values:plan.values});
      try{for(;;){const rows=(await db.client.query(`FETCH FORWARD 128 FROM ${cursor}`)).rows;if(!rows.length)break;for(const row of rows)ItemIds.push(wireGuid(decodeNativeTextBytes(row.ItemId,'runtime')));}}
      finally{await db.client.query(`CLOSE ${cursor}`);}
      return { Shares: playlist.Shares, OpenAccess: playlist.OpenAccess === true,
        ItemIds };
    }, { signal, readOnly: true, lockTimeoutMs: 250 });
  }

  async update(id, { user, name, ids, users, isPublic, signal } = {}) {
    if (name != null && typeof name !== 'string') throw libraryError(400, 'Name must be a string.');
    if (ids != null && !Array.isArray(ids)) throw libraryError(400, 'Ids must be an array.');
    if (isPublic != null && typeof isPublic !== 'boolean') throw libraryError(400, 'IsPublic must be a boolean.');
    const requestedIds = ids == null ? null : ids.map(nativeGuid);
    const shares = users == null ? undefined : normalizeShares(users);
    return this.#enqueue(async () => {
      await this.#refreshTail;
      const target = await this.store.run(async db => {
        const { playlist } = await this.#playlist(db, nativeGuid(id), user);
        if (!this.#canEdit(playlist, user)) throw libraryError(403, 'Forbidden');
        return this.#writeTarget(playlist);
      }, { signal, readOnly: true, lockTimeoutMs: 250 });
      const metadata = { name: name == null ? undefined : name, shares,
        openAccess: isPublic == null ? undefined : isPublic };
      if (target.kind === 'external') {
        // The native endpoint commits and writes the empty list first, then
        // independently adds, queues ForceSave and finally edits metadata.
        if (requestedIds != null) {
          await this.#edit(id,user,{links:this.#ownLinks(await emptyPlaylistLinks(this.linkedChildren))},{target});
          await this.#add(id, requestedIds, { user, target });
        }
        await this.#edit(id, user, metadata, { target });
      } else {
        const expanded = requestedIds == null ? null
          : await this.#expand(requestedIds, user, { deferRelatedNameAccess: true });
        await this.#edit(id, user, expanded
          ? { ...metadata, links:expanded.links,mediaAdded:expanded.count>0n } : metadata,
          { signal, seedIds: requestedIds ?? [] });
      }
    });
  }

  async getUsers(id, { user, signal } = {}) {
    return this.store.run(async db => {
      const { playlist } = await this.#postgresPlaylistRead(db, nativeGuid(id), user);
      if (!sameId(playlist.OwnerUserId, user.Id)) throw libraryError(403, 'Forbidden');
      return playlist.Shares;
    }, { signal, readOnly: true, lockTimeoutMs: 250 });
  }

  async getUser(id, userId, { user, signal } = {}) {
    return this.store.run(async db => {
      const { playlist } = await this.#postgresPlaylistRead(db, nativeGuid(id), user);
      if (sameId(playlist.OwnerUserId, user.Id)) {
        // The native controller returns the calling owner's permission object,
        // regardless of which target user id was supplied.
        return { UserId: wireGuid(user.Id), CanEdit: true };
      }
      const target = nativeGuid(userId);
      const share = playlist.Shares.find(entry => sameId(entry.UserId, target));
      const permitted = playlist.Shares.some(entry => entry.CanEdit === true && sameId(entry.UserId, user.Id))
        || sameId(target, user.Id);
      if (!permitted) throw libraryError(403, 'Forbidden');
      if (!share) throw libraryError(404, 'User permissions not found');
      return share;
    }, { signal, readOnly: true, lockTimeoutMs: 250 });
  }

  async updateUser(id, userId, { user, canEdit, signal } = {}) {
    if (canEdit != null && typeof canEdit !== 'boolean') throw libraryError(400, 'CanEdit must be a boolean.');
    const targetUser = nativeGuid(userId);
    return this.#enqueue(async () => {
      await this.#refreshTail;
      await this.#edit(id, user, playlist => {
        const shares = [...playlist.Shares];
        const existing = shares.findIndex(entry => sameId(entry.UserId, targetUser));
        if (existing >= 0) shares.splice(existing, 1);
        shares.push({ UserId: wireGuid(targetUser), CanEdit: canEdit ?? false });
        return { shares };
      }, { signal, ownerOnly: true });
    });
  }

  async removeUser(id, userId, { user, signal } = {}) {
    const targetUser = nativeGuid(userId);
    return this.#enqueue(async () => {
      await this.#refreshTail;
      await this.#edit(id, user, playlist => {
        const shares = [...playlist.Shares];
        const existing = shares.findIndex(entry => sameId(entry.UserId, targetUser));
        if (existing < 0) throw libraryError(404, 'User permissions not found');
        shares.splice(existing, 1);
        return { shares };
      }, { signal });
    });
  }

  async getItems(id, { user, startIndex, limit, dtoOptions = {}, signal } = {}) {
    const selected = selectDtoOptions(parseQuery(dtoOptions), true);
    const channelAccess = selected.fields.has('candelete') ? this.library.channels?.admitOperation() : undefined;
    try { return await this.store.run(async db => {
      const playlistId = nativeGuid(id);
      const { playlist, navigationRows, visibility } = await this.#postgresPlaylistRead(db, playlistId, user);
      if (!(playlist.OpenAccess === true || sameId(playlist.OwnerUserId, user.Id)
        || playlist.Shares.some(share => sameId(share.UserId, user.Id)))) throw libraryError(403, 'Forbidden');
      const Items=[];let offset=Math.max(0,startIndex??0),remaining=limit==null?Infinity:Math.max(0,limit),total=0;
      for(;;){const page=await queryPostgresPlaylistPage(db,playlist.Id,{visibility,startIndex:offset,limit:Math.min(128,remaining)});total=page.total;
      const pageRows = await loadPostgresRowsByIds(db, page.links.map(link => link.ChildId));
      const graphRows = await loadPostgresPageGraph(db, pageRows, navigationRows,{includeManualLinks:false});
      const state = await this.library.load(db, user, { includeUserData: true, baseRows: graphRows,includeLinkGraph:false, channelAccess });
      try{for (const link of page.links) {
        const item = state.byId.get(idKey(link.ChildId));
        if (!item) continue;
        const dto = await projectItem(item, state, user, selected, this.library.options);
        dto.PlaylistItemId = wireGuid(link.ChildId);
        Items.push(dto);
      }}finally{await state.dispose();}
      remaining-=page.links.length;if(page.links.length<128||remaining<=0)break;offset+=page.links.length;}
      return { Items, TotalRecordCount: total, StartIndex:Math.max(0,startIndex??0) };
    }, { signal, readOnly: true, lockTimeoutMs: 250 });
    } finally { await channelAccess?.release(); }
  }

  async add(id, itemIds, { user, position, signal } = {}) {
    return this.#enqueue(() => this.#add(id, itemIds, { user, position, signal }));
  }

  async #add(id, itemIds, { user, position, signal, target } = {}) {
    const nativeItemIds = itemIds.map(nativeGuid);
    const { playlist, state, additions } = await this.store.run(async db => {
      const { playlist, state } = await this.#playlist(db, nativeGuid(id), user, { seedIds: nativeItemIds });
      if (!this.#canEdit(playlist, user)) throw libraryError(403, 'Forbidden');
      const additions = await this.#expand(nativeItemIds, user, { deferRelatedNameAccess: true });
      return { playlist, state, additions };
    });
    if (!additions.count) return;
    const committed = await this.store.transaction(async db => {
      if (target && playlist.Path !== target.plan.identityPath) throw libraryError(409, 'The playlist path changed before saving.');
      const destination = target ?? await this.#writeTarget(playlist);
      const currentLinks=await this.#currentLinks(db,playlist.Id);
      const links=this.#ownLinks(await insertPlaylistLinks(this.linkedChildren,currentLinks,additions.links,position));
      const externalChanges = destination.kind === 'external'
        ? { links, mediaAdded: true } : undefined;
      const updated = externalChanges ? playlist : await this.#replaceLinks(db, playlist, links, { mediaAdded: true });
      const children=await this.#childrenSnapshot(db,links,{manualOnly:destination.kind!=='external'});
      return { playlist: updated, parent: state.byId.get(idKey(updated.ParentId)), children, externalChanges, target: destination };
    }, transactionOptions(signal));
    if (committed) await this.#finishUpdate(committed, 2, true);
  }

  async remove(id, entryIds, { user, isApiKey = false, signal } = {}) {
    return this.#enqueue(async () => {
      let committed;
      try {
        committed = await this.store.transaction(async db => {
          const playlistId = nativeGuid(id);
          const result = isApiKey ? await this.#playlist(db, playlistId, null, { visible: false })
            : await this.#playlist(db, playlistId, user);
          const { playlist, state } = result;
          if (!isApiKey && !this.#canEdit(playlist, user)) throw libraryError(403, 'Forbidden');
          const destination = await this.#writeTarget(playlist);
          const links=await this.#currentLinks(db,playlist.Id,{resolvedOnly:true,excludeChildIds:entryIds.map(String)});
          const externalChanges = destination.kind === 'external' ? { links } : undefined;
          const updated = externalChanges ? playlist : await this.#replaceLinks(db, playlist, links);
          const children=await this.#childrenSnapshot(db,links,{manualOnly:destination.kind!=='external'});
          return { playlist: updated, parent: state.byId.get(idKey(updated.ParentId)), children, externalChanges, target: destination };
        }, transactionOptions(signal));
      } catch (error) { throw error; }
      await this.#finishUpdate(committed, 2, true);
    });
  }

  async move(id, entryId, newIndex, { user, signal } = {}) {
    return this.#enqueue(async () => {
      if (!Number.isInteger(newIndex) || newIndex < 0) throw libraryError(400, 'newIndex must be a non-negative integer.');
      let committed;
      try {
        committed = await this.store.transaction(async db => {
          const { playlist, state } = await this.#playlist(db, nativeGuid(id), user);
          if (!this.#canEdit(playlist, user)) throw libraryError(403, 'Forbidden');
          const currentLinks=await this.#currentLinks(db,playlist.Id);
          const target = String(entryId).toLowerCase();
          const visibility=buildPostgresPlaylistVisibility(await loadPostgresNavigationRows(db),user,this.library.options.libraryOptions);
          const writer=await this.linkedChildren.createWriter({session:db,parentId:playlist.Id});let accessible;
          try{for(let startIndex=0;;){const page=await queryPostgresPlaylistPage(db,playlist.Id,{visibility,startIndex,limit:128});
            for(const row of page.links)await writer.append({ItemId:row.ChildId,Type:Number(row.ChildType)});
            if(page.links.length<128)break;startIndex+=page.links.length;}accessible=this.#ownLinks(await writer.finish());}
          catch(error){await writer.abort();throw error;}
          const current=this.linkedChildren.plan(currentLinks),visible=this.linkedChildren.plan(accessible);
          const rebase=visible.text.replace(/\$(\d+)\b/gu,(_,value)=>'$'+(Number(value)+current.values.length));
          const values=[...current.values,...visible.values,target,Math.max(newIndex-1,0)+1],targetParameter='$'+(values.length-1),priorParameter='$'+values.length;
          const positions=await this.linkedChildren.withSession(async session=>{const sql=nativeTextSql(session.schemaName);return(await session.client.query({text:`WITH current AS (${current.text}),visible AS (${rebase})
            SELECT (SELECT min("Ordinal") FROM visible WHERE ${sql.guidKey('"ItemId"')}=${targetParameter}) AS accessible,
              (SELECT count(*) FROM visible) AS total,(SELECT min("Ordinal") FROM current WHERE ${sql.guidKey('"ItemId"')}=${targetParameter}) AS moving,
              (SELECT min("Ordinal") FROM current WHERE ${sql.guidKey('"ItemId"')}=(SELECT ${sql.guidKey('"ItemId"')} FROM visible WHERE "Ordinal"=${priorParameter}::bigint)) AS prior`,values})).rows[0];});
          if(positions.accessible==null)return null;
          const oldAccessibleIndex=Number(positions.accessible)-1;
          if (newIndex >= Number(positions.total)) throw libraryError(400, 'newIndex is outside the visible playlist.');
          if (oldAccessibleIndex === newIndex) return null;
          const destination = await this.#writeTarget(playlist);
          const priorAllIndex=Number(positions.prior)-1;
          const adjusted = newIndex === 0 ? Math.max(priorAllIndex - 1, 0) : priorAllIndex + 1;
          const remaining=(await this.linkedChildren.count(currentLinks))-1n;
          const links=this.#ownLinks(await movePlaylistLink(this.linkedChildren,currentLinks,{movingOrdinal:BigInt(positions.moving),
            insertionIndex:newIndex>=Number(remaining)?remaining:BigInt(Math.min(adjusted,Number(remaining)))}));
          const externalChanges = destination.kind === 'external' ? { links } : undefined;
          const updated = externalChanges ? playlist : await this.#replaceLinks(db, playlist, links);
          const children=await this.#childrenSnapshot(db,links);
          return { playlist: updated, parent: state.byId.get(idKey(updated.ParentId)), children, externalChanges, target: destination };
        }, transactionOptions(signal));
      } catch (error) { throw error; }
      if (committed) await this.#finishUpdate(committed, 2);
    });
  }

  async delete(id, { user, isApiKey = false, signal, channelAccess } = {}) {
    return this.#enqueue(() => this.#delete(id, { user, isApiKey, signal, channelAccess }));
  }

  async #delete(id, { user, isApiKey = false, deleteFileLocation = true, deleteFromExternalProvider = true,
    physicalParent = false, notifyParentItem = true, channelAccess } = {}) {
    await this.#refreshTail;
    if (!user && !isApiKey) throw libraryError(404, 'User not found.');
    const playlistId = nativeGuid(id);
    const { playlist } = await this.store.run(db => isApiKey
      ? this.#postgresPlaylistShell(db, playlistId) : this.#postgresPlaylistRead(db, playlistId, user));
    if (user && !(user.Policy?.IsAdministrator === true || sameId(playlist.OwnerUserId, user.Id))) {
      throw libraryError(401, 'Unauthorized');
    }
    if (!this.library.itemCreation || !this.library.itemDeletion) {
      unsupported('Playlist deletion requires the native item deletion lifecycle.');
    }
    const item = await this.library.itemCreation.getItemById(playlistId);
    if (!item || item.Type !== 'Playlist' || item.Path !== playlist.Path) {
      throw libraryError(409, 'The playlist changed before deletion.');
    }
    // LibraryController and user cleanup use different DeleteOptions. Native
    // DeleteItem is non-cancellable and never compensates file/DB prefixes.
    const parent = physicalParent ? nonemptyId(item.ParentId)
      ? await this.library.itemCreation.getItemById(item.ParentId) : null : undefined;
    return this.library.deleteItem(item, { DeleteFileLocation: deleteFileLocation,
      DeleteFromExternalProvider: deleteFromExternalProvider }, parent, notifyParentItem, channelAccess);
  }

  async removeForDeletedUser(user, { signal } = {}) {
    return this.#enqueue(async () => {
      await this.#refreshTail;
      const processPlaylist = async id => this.#using(async()=>{
        signal?.throwIfAborted();
        let restore;
        let committed;
        try {
          committed = await this.store.transaction(async db => {
            const { playlist, state } = await this.#playlist(db, id, user);
            const ranked = playlist.Shares.map((share, index) => ({ share, index }))
              .sort((left, right) => Number(right.share.CanEdit) - Number(left.share.CanEdit) || left.index - right.index)
              .map(entry => entry.share);
            if (!ranked.length) return { remove: playlist.OpenAccess !== true };
            const result = await this.#metadataUpdate(db, playlist, state, {
              ownerUserId: ranked[0].UserId, shares: ranked.slice(1)
            });
            restore = result.restore;
            return { playlist: result.playlist, parent: state.byId.get(idKey(result.playlist.ParentId)) };
          }, transactionOptions(signal));
        } catch (error) { return this.#restore(restore, error); }
        restore = null;
        if (committed.remove) await this.#delete(id, { isApiKey: true, deleteFileLocation: false, deleteFromExternalProvider: false,
          physicalParent: true, notifyParentItem: false });
        else if (committed.playlist) this.library.reportItemUpdated(committed.playlist, committed.parent, 16);
      });
      const playlistFolderId = nativeGuid(getNewItemId(this.playlistsPath, playlistsFolderNativeType, {
        programDataPath: this.programDataPath,
        enableCaseSensitiveItemIds: this.configuration.EnableCaseSensitiveItemIds,
      }));
      let afterId = '';
      while (true) {
        const { candidates, visibleIds } = await this.store.run(async db => {
          const candidates = await queryPostgresDeletedUserPlaylistBatch(db, {
            userId: user.Id,
            playlistFolderId,
            afterId,
          });
          for (const candidate of candidates) {
            if (!Array.isArray(candidate.Shares)) throw libraryError(500, 'Invalid Playlist.Shares.');
          }
          if (!candidates.length) return { candidates, visibleIds: new Set() };
          const rows = await queryPostgresPlaylistShellBatch(db, candidates.map(candidate => candidate.Id));
          const playlists = rows.map(mapRecord).filter(item => item?.Type === 'Playlist');
          const navigationRows = await loadPostgresNavigationRows(db);
          const visibility = buildPostgresPlaylistVisibility(navigationRows, user,
            this.library.options.libraryOptions);
          const access = await queryPostgresPlaylistAccessBatch(db, playlists, {
            user,
            dataPath: this.dataPath,
            programDataPath: this.programDataPath,
            visibility,
          });
          return {
            candidates,
            visibleIds: new Set(playlists.filter(playlist => access.get(idKey(playlist.Id)) === true)
              .map(playlist => idKey(playlist.Id))),
          };
        }, { signal, readOnly: true, lockTimeoutMs: 250 });
        if (!candidates.length) break;
        for (const candidate of candidates) {
          if (!visibleIds.has(idKey(candidate.Id))) continue;
          if (!candidate.Shares.length) {
            if (!candidate.OpenAccess) await this.#delete(candidate.Id, { isApiKey: true, deleteFileLocation: false, deleteFromExternalProvider: false,
              physicalParent: true, notifyParentItem: false });
            continue;
          }
          await processPlaylist(candidate.Id);
        }
        afterId = candidates.at(-1).Id;
      }
    });
  }

  async close() {
    this.#closed = true;
    await this.#tail;
    await this.#refreshTail;
  }
}
