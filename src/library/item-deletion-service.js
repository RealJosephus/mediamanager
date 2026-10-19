import {randomUUID} from 'node:crypto';
import {quoteIdentifier as q} from '../database/model.js';
import {nativeTextSql} from '../database/native-text-sql.js';
import {createMetadataChildren} from './metadata-children.js';
import {createNativeItemCohort} from './native-item-cohort.js';
import {acquireNativeItemLinkOwner} from './native-item-entity.js';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { EMPTY_ID, VIDEO_TYPES, idKey, nonemptyId, sameId, libraryError } from './records.js';
import { ItemDeletionScope } from './item-deletion-scope.js';
import { invalidateVideoParent } from './video-version-discovery.js';
import { loadLiveItemContext, updateLiveItemRepository, setPrimaryVersion as setPrimary } from './live-item-repository.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { ItemUpdateType } from '../metadata/save-manager.js';
import { prepareItemSourceDeletion } from './item-source-deletion.js';
import { resolveVideoVersionLinks } from './video-version-relations.js';

const conflict = () => Object.assign(new Error('The item changed before deletion.'), { code: 'metadata-conflict', status: 409 });
const genericFileLeafTypes = new Set(['Audio', 'AudioBook', 'Book']);
const generalMediaItemTypes = new Set([
  'Series', 'Season', 'BoxSet', 'Playlist', 'LiveTvProgram', 'MusicAlbum', 'Photo', 'PhotoAlbum'
]);
const exactFileSourceTypes = new Set([...genericFileLeafTypes, 'LiveTvProgram', 'Photo']);
const internalByNameFolders = new Map([
  ['Person', 'People'], ['Genre', 'Genre'], ['MusicGenre', 'MusicGenre'],
  ['Studio', 'Studio'], ['Year', 'Year'], ['MusicArtist', 'artists']
]);
const generalItemTypes = new Set([...generalMediaItemTypes, ...internalByNameFolders.keys()]);

function pathApi(value) {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? path.win32 : path.posix;
}

const sameOptionalId = (left, right) => !nonemptyId(left) && !nonemptyId(right) || sameId(left, right);

function directoryDiscStateMatches(item, snapshot, stored) {
  if (snapshot?.IsFolder !== item.IsFolder || snapshot?.IsInMixedFolder !== item.IsInMixedFolder
    || !sameOptionalId(snapshot?.OwnerId, item.OwnerId)
    || !sameOptionalId(snapshot?.PrimaryVersionId, item.PrimaryVersionId)
    || !sameOptionalId(snapshot?.ChannelId, item.ChannelId)) return false;
  if (!['Dvd', 'BluRay'].includes(item.VideoType) || stored?.VideoType !== item.VideoType
    || Boolean(stored.IsShortcut) !== Boolean(item.IsShortcut)
    || stored.IsPlaceHolder === true || item.IsPlaceHolder === true
    || !Array.isArray(item.AdditionalParts) || !Array.isArray(item.LocalAlternateVersions)
    || !Array.isArray(item.LinkedAlternateVersions)
    || !Array.isArray(stored.AdditionalParts) || !isDeepStrictEqual(stored.AdditionalParts, item.AdditionalParts)
    || !Array.isArray(stored.LocalAlternateVersions) || !isDeepStrictEqual(stored.LocalAlternateVersions, item.LocalAlternateVersions)
    // This JsonIgnore list is hydrated from LinkedChildren, not Data.
    || Object.hasOwn(stored, 'LinkedAlternateVersions') && !Array.isArray(stored.LinkedAlternateVersions)) return false;
  return true;
}

function directoryDiscLayout(item) {
  if (item.IsFolder === true || typeof item.Path !== 'string' || item.Path === ''
    || item.IsFileProtocol !== true || item.IsInMixedFolder === true
    || nonemptyId(item.OwnerId) || nonemptyId(item.ChannelId)) return null;
  if (item.AdditionalParts.length === 0) return { stacked: false };
  const api = pathApi(item.Path), container = api.dirname(item.Path);
  if (!container || container === item.Path) return null;
  const seen = [item.Path];
  for (const part of item.AdditionalParts) {
    if (typeof part !== 'string' || part === '' || !ordinalIgnoreCaseEquals(api.dirname(part), container)) return null;
    if (seen.some(value => ordinalIgnoreCaseEquals(value, part))) return null;
    seen.push(part);
  }
  return { stacked: true };
}

/** DeleteItem keeps repository promotion, file cleanup and SQL deletion as
 * separate boundaries. Its logical children determine cache/events; the
 * persistence service independently expands its ParentId/OwnerId closure. */
export class ItemDeletionService {
  constructor({ store, library, loadContext, itemCreation, updates, externalData, linkedChildReferences,
    vfs, metadataVfs = vfs, channelManager, logger = {}, now = () => new Date().toISOString() }) {
    if (!store || !library || !itemCreation || !updates || !externalData || typeof loadContext !== 'function'
      || !linkedChildReferences || typeof linkedChildReferences.reroute !== 'function') {
      throw new TypeError('Item deletion requires mapped persistence, metadata and live entities.');
    }
    Object.assign(this, { store, library, loadContext, itemCreation, updates, externalData,
      linkedChildReferences, vfs, metadataVfs, channelManager, logger, now });
  }

  async #context(item, { allowDirectoryDisc = false, cleanupOnly = false, relatedVersion = false } = {}) {
    if (!['Folder', ...VIDEO_TYPES, ...genericFileLeafTypes, ...generalItemTypes].includes(item.Type)) {
      throw libraryError(501, 'Deletion of this native item type is not implemented.');
    }
    const loaded = await loadLiveItemContext(item, this, { allowRetainedItem: true, includeChildren: false });
    try {
    const snapshot = loaded.sourceSnapshot;
    let stored;
    try { stored = JSON.parse(snapshot?.Data ?? '{}'); } catch { stored = null; }
    if (generalItemTypes.has(item.Type)) {
      if (snapshot?.IsFolder !== item.IsFolder
        || snapshot?.IsInMixedFolder !== item.IsInMixedFolder
        || snapshot?.IsVirtualItem !== item.IsVirtualItem
        || !sameOptionalId(snapshot?.OwnerId, item.OwnerId)
        || !sameOptionalId(snapshot?.PrimaryVersionId, item.PrimaryVersionId)
        || !sameOptionalId(snapshot?.ChannelId, item.ChannelId)) {
        throw libraryError(501, 'Deletion of this native item with a changed source shape is not implemented.');
      }
    }
    if (internalByNameFolders.has(item.Type)) {
      const accessedByName = item.Type !== 'MusicArtist' || !nonemptyId(item.ParentId);
      if (item.IsInMixedFolder || item.IsVirtualItem || (accessedByName && nonemptyId(item.OwnerId))
        || nonemptyId(item.PrimaryVersionId) || nonemptyId(item.ChannelId)) {
        throw libraryError(501, 'Deletion of this native by-name item shape is not implemented.');
      }
      if (accessedByName) {
        if (typeof loaded.metadataPath !== 'string' || loaded.metadataPath === '') {
          throw libraryError(501, 'Deletion of a by-name item requires the isolated metadata root.');
        }
        const api = pathApi(loaded.metadataPath), root = api.resolve(loaded.metadataPath, internalByNameFolders.get(item.Type));
        const target = typeof item.Path === 'string' && item.Path !== '' && item.IsFileProtocol && api.isAbsolute(item.Path)
          ? api.resolve(item.Path) : null;
        const relative = target && api.relative(root, target);
        if (!target || !relative || relative === '..' || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) {
          throw libraryError(501, 'Deletion of this by-name item requires its isolated instance metadata directory.');
        }
        const location = await loaded.imageAssets.resolve(item.Path);
        if (!location.localPath || api.resolve(location.localPath) !== target) {
          throw libraryError(501, 'Deletion of this by-name item requires isolated instance state.');
        }
        loaded.internalSourcePath = item.Path;
      } else if (!item.IsFolder || !loaded.context.accessPath) {
        throw libraryError(501, 'Deletion of this physical music artist requires mapped folder storage.');
      }
    }
    if (genericFileLeafTypes.has(item.Type)) {
      if (item.IsFolder === true
        || snapshot?.IsInMixedFolder !== item.IsInMixedFolder
        || !sameOptionalId(snapshot?.OwnerId, item.OwnerId)
        || !sameOptionalId(snapshot?.ChannelId, item.ChannelId)
        || Boolean(stored?.IsShortcut) !== Boolean(item.IsShortcut)) {
        throw libraryError(501, 'Deletion of this native file item shape is not implemented.');
      }
    }
    if (VIDEO_TYPES.has(item.Type)) {
      if (snapshot?.IsInMixedFolder !== item.IsInMixedFolder
        || snapshot?.IsVirtualItem !== item.IsVirtualItem
        || !sameOptionalId(snapshot?.ChannelId, item.ChannelId)
        || Boolean(stored?.IsPlaceHolder) !== Boolean(item.IsPlaceHolder)
        || item.IsPlaceHolder && stored?.VideoType !== item.VideoType) {
        throw libraryError(501, 'Deletion of this native video with a changed source shape is not implemented.');
      }
      const directoryDisc = !item.IsPlaceHolder && (['Dvd', 'BluRay'].includes(item.VideoType)
        || ['Dvd', 'BluRay'].includes(stored?.VideoType));
      if (directoryDisc) {
        if (cleanupOnly) {
          if (snapshot?.IsFolder !== item.IsFolder || stored?.VideoType !== item.VideoType
            || Boolean(stored?.IsShortcut) !== Boolean(item.IsShortcut)
            || !sameOptionalId(snapshot?.OwnerId, item.OwnerId)
            || !sameOptionalId(snapshot?.PrimaryVersionId, item.PrimaryVersionId)) {
            throw libraryError(501, 'Deletion of this native video with a changed source shape is not implemented.');
          }
          // Folder deletion cleans captured descendants' metadata and rows.
          // Only the requested parent contributes source deletion paths.
          return loaded;
        }
        if (!directoryDiscStateMatches(item, snapshot, stored)) {
          throw libraryError(501, 'Deletion of this native video with a changed source shape is not implemented.');
        }
        await this.store.run(async db => {
          const plan = await resolveVideoVersionLinks(db, item, { reversePath: loaded.reversePath });
          const project = links => links.map(link => [idKey(link.ChildId), link.ChildType]);
          const links = loaded.versionLinks.filter(link => link.ChildType === 2 || link.ChildType === 3);
          const incoming = await db.rows('LinkedChildren', { where: { ChildId: item.Id }, whereIn: { ChildType: [2, 3] } });
          if (!isDeepStrictEqual(project(plan.links), project(links))
            || incoming.some(link => !sameId(link.ParentId, item.PrimaryVersionId))) {
            throw libraryError(501, 'Deletion of a disc with inconsistent version relationships is not implemented.');
          }
        });
        // Version promotion and missing-version cleanup only need metadata
        // context; they do not authorize deleting the related source tree.
        if (relatedVersion) return loaded;
        // Episode.GetDeletePaths keeps its own Path as a file target even for
        // disc media. Source deletion must fail at that execution boundary if
        // the path is a directory; DB-only cleanup remains valid.
        if (allowDirectoryDisc && item.Type === 'Episode' && item.IsFolder === false
          && item.IsFileProtocol && !item.IsShortcut) return loaded;
        const discLayout = allowDirectoryDisc && ['Movie', 'MusicVideo', 'Video'].includes(item.Type)
          && !item.IsShortcut && !item.IsPlaceHolder
          ? directoryDiscLayout(item) : null;
        if (!discLayout) throw libraryError(501, 'Deletion of this native disc source requires its isolated directory lifecycle.');
        return { ...loaded, discLayout };
      }
      // STRM, ISO and placeholder files use the ordinary local Path deletion rules.
      // ShortcutPath is a playback target and never a source deletion path.
      if (!['VideoFile', 'Iso'].includes(item.VideoType)
        && !(item.IsPlaceHolder && ['Dvd', 'BluRay'].includes(item.VideoType))) {
        throw libraryError(501, 'Deletion of this native video source requires its resolver lifecycle.');
      }
    }
    return loaded;
    } catch(error) {
      try { await loaded.dispose(); }
      catch(cleanup) { throw new AggregateError([error,cleanup],error.message,{cause:error}); }
      throw error;
    }
  }

  async #update(item) {
    await updateLiveItemRepository(item, { ...this, updateReason: ItemUpdateType.MetadataEdit });
  }

  deleteItems(idsPlan, scope, publishDeletedPage) { return scope.persistPlan(idsPlan, { now: this.now, publishDeletedPage }); }

  async #sourceDeletion(item, loaded) {
    if (['BoxSet', 'Playlist'].includes(item.Type) && loaded.context.localPath) {
      const localRoot = loaded.context.localRoot;
      if (typeof localRoot !== 'string' || localRoot === '') {
        throw libraryError(501, 'Managed folder source deletion requires isolated instance data.');
      }
      const api = pathApi(localRoot);
      const managedRoot = item.Type === 'BoxSet' && loaded.context.managedCollectionDirectoryRoot;
      const root = managedRoot ? api.resolve(managedRoot)
        : api.resolve(localRoot, item.Type === 'Playlist' ? 'playlists' : 'collections');
      const scopeRelative = api.relative(api.resolve(localRoot), root);
      if (scopeRelative === '..' || scopeRelative.startsWith(`..${api.sep}`) || api.isAbsolute(scopeRelative)) {
        throw libraryError(501, 'Managed collection source root must remain in isolated instance state.');
      }
      const target = api.resolve(loaded.context.localPath), relative = api.relative(root, target);
      if (!relative || relative === '..' || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) {
        throw libraryError(501, 'Managed folder source deletion requires its isolated item directory.');
      }
      const location = await loaded.imageAssets.resolve(item.Path);
      if (!location.localPath || api.resolve(location.localPath) !== target) {
        throw libraryError(501, 'Managed collection source deletion requires isolated instance state.');
      }
      return this.#stateSourceDeletion(loaded, item.Path);
    }
    const mixed = !item.IsFolder && item.IsInMixedFolder;
    // Episode.GetDeletePaths always names its own Path, including non-mixed
    // episodes. Other Video types name the containing directory when non-mixed.
    // Playlist inherits IsFolder=true even when its Path is a file. Native
    // GetDeletePaths uses the actual file-system entry, not that getter.
    let playlistFile = false;
    if (item.Type === 'Playlist') {
      try { playlistFile = (await this.vfs.stat(loaded.context.accessPath)).kind === 'file'; }
      catch (error) { if (error.code !== 'not-found') throw error; }
    }
    const fileLeaf = exactFileSourceTypes.has(item.Type) || mixed || item.Type === 'Episode' || playlistFile;
    const accessPath = loaded.context.accessPath && (fileLeaf || item.IsFolder || loaded.discLayout && !loaded.discLayout.stacked
      ? loaded.context.accessPath : path.posix.dirname(loaded.context.accessPath));
    return prepareItemSourceDeletion({ item, accessPath, vfs: this.vfs, metadataVfs: this.metadataVfs,
      fileLeaf, mixed, actualSourceKind: genericFileLeafTypes.has(item.Type) });
  }

  async #stateSourceDeletion(loaded, sourcePath) {
    let info;
    try { info = await loaded.imageAssets.stat(sourcePath); }
    catch (error) { if (error.code === 'not-found') return async () => {}; throw error; }
    return info.kind === 'directory'
      ? () => loaded.imageAssets.deleteDirectory(sourcePath)
      : () => loaded.imageAssets.delete(sourcePath);
  }

  deleteItem(item, options = {}, parent, notifyParentItem = true) {
    return this.#deleteItem(item, options, parent, notifyParentItem, true);
  }

  async #deleteItem(item, options, parent, notifyParentItem, allowDirectoryDisc = false, validatedVersionContext) {
    if (item == null) throw new TypeError('DeleteItem requires a native item.');
    return this.store.serializeWrites(async database => {
      const contexts=new Set(),owners=[],keep=value=>{contexts.add(value);return value;};
      let children,cohort,scope,failure; const logical=q('mm_delete_logical_'+randomUUID().replaceAll('-',''));
      owners.push(acquireNativeItemLinkOwner(item));
      try{
      const loaded = validatedVersionContext ?? keep(await this.#context(item, { allowDirectoryDisc }));
      if (parent === undefined) {
        const owner = nonemptyId(item.OwnerId) ? await this.itemCreation.getItemById(item.OwnerId) : null;
        parent = owner ?? (nonemptyId(item.ParentId) ? await this.itemCreation.getItemById(item.ParentId) : null);
      }
      if(parent)owners.push(acquireNativeItemLinkOwner(parent));
      const factory=createMetadataChildren({store:this.store,library:this.library,linkedChildren:this.itemCreation.linkedChildren,
        configuration:loaded.globalOptions,libraryOptions:loaded.libraryOptions});
      if(item.IsFolder)children=await factory.recursive(item,{includeLinkedChildren:false});
      cohort=await createNativeItemCohort({linkedChildren:this.itemCreation.linkedChildren});
      await database.client.query(`CREATE TEMP TABLE ${logical}("Ordinal" bigint PRIMARY KEY,"Key" text NOT NULL)`);
      await database.client.query(`INSERT INTO ${logical} VALUES(0,$1)`,[idKey(item.Id)]);
      let ordinal=0n;
      if(children)for await(const page of children.pages())for(const child of page){
        // Native deletion consumes the captured Children entity directly. A
        // same-ID manager cache entry cannot replace its name, path or data.
        const context=await this.#context(child,{cleanupOnly:true});let childFailure;
        try {await cohort.capture(child,{ordinal:++ordinal});await database.client.query(`INSERT INTO ${logical} VALUES($1,$2)`,[ordinal,idKey(child.Id)]);}
        catch(error){childFailure=error;throw error;}
        finally {
          try {await context.dispose();}
          catch(cleanup){if(childFailure)throw new AggregateError([childFailure,cleanup],childFailure.message,{cause:childFailure});throw cleanup;}
        }
      }
      await children?.close();children=null;
      const eachChild=async operation=>{for(let after=0n;;){const page=await cohort.page({after,limit:128});
        try{if(!page.entries.length)return;for(const entry of page.entries)await operation(entry.item);after=page.entries.at(-1).Ordinal;}
        finally{await page.release();}}};
      const childFiles=operation=>eachChild(child=>this.loadContext.withContext(child.Id,{draft:child,includeChildren:false},context=>operation(child,context)));
      const idsPlan={text:`SELECT "Key",min("Ordinal") AS "Ordinal" FROM ${logical} GROUP BY "Key"`,values:[]};
      scope = new ItemDeletionScope({ store: this.store, database });
      await scope.capturePlan(idsPlan);
      // Disc extras use the same SQL OwnerId closure as ordinary videos.
      // They are not logical Folder children and receive no separate deletion events.
        const existingPrimary = nonemptyId(item.PrimaryVersionId) ? await this.itemCreation.getItemById(item.PrimaryVersionId) : null;
        if (existingPrimary && VIDEO_TYPES.has(existingPrimary.Type)){owners.push(acquireNativeItemLinkOwner(existingPrimary));keep(await this.#context(existingPrimary,{relatedVersion:true}));}
        const links = VIDEO_TYPES.has(item.Type) ? await database.rows('LinkedChildren', { where: { ParentId: item.Id }, whereIn:{ChildType:[2,3]},
          orderBy: [{ column: 'SortOrder', direction: 'ASC' }] }) : [];
        const alternateIds = new Map(links.filter(link => link.ChildType === 2).map(link => [idKey(link.ChildId), link.ChildId]));
        const localIds = new Set(alternateIds.keys());
        for (const link of links) if (link.ChildType === 3 && !alternateIds.has(idKey(link.ChildId))) alternateIds.set(idKey(link.ChildId), link.ChildId);
        const alternates = [];
        for (const id of alternateIds.values()) {
          const alternate = await this.itemCreation.getItemById(id);
          if (alternate && VIDEO_TYPES.has(alternate.Type)){owners.push(acquireNativeItemLinkOwner(alternate));alternates.push({item:alternate,loaded:keep(await this.#context(alternate,{relatedVersion:true}))});}
        }
        if (!isDeepStrictEqual((await database.rows('BaseItems', { where: { Id: item.Id } }))[0], loaded.snapshot)) throw conflict();
        const deleteSource = loaded.internalSourcePath ? await this.#stateSourceDeletion(loaded, loaded.internalSourcePath)
          : options.DeleteFileLocation && item.IsFileProtocol && !nonemptyId(item.ChannelId)
            ? await this.#sourceDeletion(item, loaded) : null;
        if (nonemptyId(item.ChannelId)) {
          if (options.DeleteFromExternalProvider !== false) {
            if (!this.channelManager?.deleteItem) throw libraryError(501, 'Channel provider deletion requires a channel manager.');
            try { await this.channelManager.deleteItem(item); }
            catch (error) { if (error.nativeException !== 'ArgumentException') throw error; }
          }
          options.DeleteFileLocation = false;
        }

        if (VIDEO_TYPES.has(item.Type) && !nonemptyId(item.PrimaryVersionId) && !nonemptyId(item.OwnerId)) {
          const surviving = [], missing = [];
          for (const alternate of alternates) {
            // ManagedFileSystem.FileExists returns false for non-file protocols
            // such as HTTP. Do not feed those identity paths into the VFS: they
            // are missing alternates for DeleteItem's purposes, not mount paths.
            const exists = alternate.item.Path && alternate.item.IsFileProtocol && alternate.loaded.context.accessPath
              ? await alternate.loaded.exists(alternate.loaded.context.accessPath) : false;
            if (alternate.item.Path && !exists) missing.push(alternate);
            else surviving.push(alternate.item);
          }
          for (const {item:alternate,loaded:alternateContext} of missing) {
            setPrimary(alternate, null); alternate.OwnerId = EMPTY_ID;
            alternate.LocalAlternateVersions = []; alternate.LinkedAlternateVersions = [];
            // These native in-memory resets intentionally precede persistence.
            // Reuse a disc's validated context owned by this call, without
            // granting source deletion or rejecting deliberate version changes.
            const discContext = !alternate.IsPlaceHolder && ['Dvd', 'BluRay'].includes(alternate.VideoType)
              ? alternateContext : undefined;
            await this.#deleteItem(alternate, { DeleteFileLocation: false }, undefined, false, false, discContext);
          }
          if (surviving.length) {
            const primary = surviving[0]; setPrimary(primary, null); primary.OwnerId = EMPTY_ID;
            primary.LocalAlternateVersions = item.LocalAlternateVersions.filter(value => !ordinalIgnoreCaseEquals(value, primary.Path));
            primary.LinkedAlternateVersions = item.LinkedAlternateVersions.filter(link => !sameId(link.ItemId, primary.Id));
            await this.#update(primary);
            await this.linkedChildReferences.reroute(item.Id, primary.Id);
            for (const alternate of surviving.slice(1)) {
              setPrimary(alternate, primary.Id); alternate.OwnerId = localIds.has(idKey(alternate.Id)) ? primary.Id : EMPTY_ID;
              await this.#update(alternate);
            }
          }
        } else if (VIDEO_TYPES.has(item.Type) && nonemptyId(item.PrimaryVersionId)) {
          await this.linkedChildReferences.reroute(item.Id, item.PrimaryVersionId);
          const primary = existingPrimary;
          if (primary && VIDEO_TYPES.has(primary.Type)) {
            primary.LinkedAlternateVersions = primary.LinkedAlternateVersions.filter(link => !sameId(link.ItemId, item.Id));
            await this.#update(primary);
          }
        }

        await this.externalData.deleteInternalItemFiles(item,{loaded});
        await childFiles((child,context)=>this.externalData.deleteInternalItemFiles(child,{loaded:context}));
        await deleteSource?.();
        item.ParentId = EMPTY_ID;
        await this.externalData.deleteItemFiles(item,{loaded});
        await childFiles((child,context)=>this.externalData.deleteItemFiles(child,{loaded:context}));
        await this.deleteItems(idsPlan,scope,async page=>{
          const logicalIds=new Set((await database.client.query(`SELECT "Key" FROM ${logical} WHERE "Key"=ANY($1::text[])`,[page.map(row=>row.Key)])).rows.map(row=>row.Key));
          for(const {Key:id,WasCacheable:cacheable} of page)if(logicalIds.has(id)||!cacheable)this.itemCreation.unregisterItem(id);
        });
        invalidateVideoParent(parent);
        // Native DeleteItem emits Removed even when notifyParentItem is false.
        await eachChild(child=>this.library.reportItemRemoved(child,item));
        this.library.reportItemRemoved(item, parent);
      } catch(error){failure=error;throw error;} finally {
        const errors=[];for(const loaded of contexts)try{await loaded.dispose();}catch(error){errors.push(error);}
        for(const owner of owners)try{owner.release();}catch(error){errors.push(error);}
        for(const cleanup of [()=>children?.close(),()=>cohort?.release(),()=>scope?.close(),
          ()=>database.client.query(`DROP TABLE IF EXISTS ${logical}`),()=>this.itemCreation.linkedChildren.flushReleases()]){
          try{await cleanup();}catch(error){errors.push(error);}
        }
        if(errors.length)throw new AggregateError(failure?[failure,...errors]:errors,failure?.message??'Deletion resources failed to release.',failure?{cause:failure}:undefined);
      }
    });
  }
}
