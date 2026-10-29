import { createMetadataChildren } from './metadata-children.js';
import { requireNativeList } from './item-relations.js';
import { nativeItemDescriptor, publishNativeItemLinks } from './native-item-entity.js';
import { collectionFoldersForItem } from './collection-membership.js';
import { loadPostgresItemGraph } from './postgres-library-query.js';
import { findPostgresLinkedChildByPath } from './postgres-linked-child-resolution.js';
import { makeNativeAbsolutePath } from '../metadata/playlist-items.js';
import { nativeGuid } from '../users/native.js';
import { hasFileProtocol } from './delete-permission.js';
import { NAME_TYPES, idKey, nonemptyId, EMPTY_ID, libraryError } from './records.js';
import { yearsFailure } from './postgres-years-source.js';
import { cachedFolderChildrenSnapshot } from './folder-cache.js';

const folder = item => item && nativeItemDescriptor(item.NativeType).family === 'folder';

/** Read actual Folder Children/links before Years evaluates visibility. This
 * deliberately uses the native child owners rather than an Items repository
 * query; CollectionFolder, album tracks and BoxSet links have distinct sources. */
export function createYearFolderSource({ library, database, state, user, virtualChildren }) {
  const linkedChildren = library.options.linkedChildren, manager = library.itemCreation;
  const metadata = createMetadataChildren({ store: library.store, library, linkedChildren,
    configuration: library.options.configuration, libraryOptions: library.options.libraryOptions });
  const findByPath = identity => findPostgresLinkedChildByPath({ library, store: library.store, itemCreation: manager }, identity);

  async function consume(sequence, append) {
    let failed = false, primary;
    try { for await (const page of sequence.pages()) await append(page); }
    catch (reason) { failed = true; primary = reason; throw reason; }
    finally {
      try { await sequence.close(); }
      catch (cleanup) { throw yearsFailure(failed ? [primary, cleanup] : [cleanup]); }
    }
  }

  async function physical(item, append) {
    if (item.Type === 'CollectionFolder') {
      for (const id of requireNativeList(item.PhysicalFolderIds === undefined ? [] : item.PhysicalFolderIds, 'source')) {
        if (!nonemptyId(id)) throw libraryError(500, "Guid can't be empty (Parameter 'id')");
        await manager.withItem(id, async physicalFolder => {
          if (folder(physicalFolder)) await consume(await metadata.physical(physicalFolder, { preserveDuplicates: true }), append);
        });
      }
    } else {
      if (item.Type === 'BoxSet' && item.Path && cachedFolderChildrenSnapshot(item) === undefined) await ensureLinks(item);
      await consume(await metadata.physical(item, { preserveDuplicates: true }), append);
    }
  }

  async function eligible(item, append) {
    if (item.Type === 'MusicAlbum') await consume(await metadata.tracks(item), append);
    else if (item.Type === 'PlaylistsFolder') await physical(item, page => append(page, { sourceKinds: ['Playlist'] }));
    else await physical(item, append);
    if (item.Type === 'UserRootFolder') {
      const extra = virtualChildren(state);
      for (let offset = 0; offset < extra.length; offset += 128) await append(extra.slice(offset, offset + 128));
    }
  }

  async function ensureLinks(item) {
    if (item.LinkedChildrenLoaded) return;
    const loaded = await linkedChildren.load(database, item.Id);
    if (!item.LinkedChildrenLoaded) publishNativeItemLinks(item, loaded);
    else await linkedChildren.release(loaded, { session: database });
  }

  async function boxSetLinkAllowed(child, roots, rootIds) {
    const examine = async owner => {
      const target = owner ?? child;
      if (NAME_TYPES.has(child.Type) || child.Type === 'Year') return true;
      const graph = await library.load(database, user, { includeUserData: false,
        baseRows: await loadPostgresItemGraph(database, [child.Id, target.Id]) });
      let failed = false, primary;
      try {
        library.adoptLiveItem(graph, child); library.adoptLiveItem(graph, target);
        if (!hasFileProtocol(target)) return await library.isItemVisible(target, user, graph);
        // Native passes the already-filtered root Folder values into this
        // path comparison. Unrelated disabled roots must not be consumed.
        return collectionFoldersForItem(target, graph, roots).some(item => rootIds.has(idKey(item.Id)));
      } catch (reason) { failed = true; primary = reason; throw reason; }
      finally {
        try { await graph.dispose({ session: database }); }
        catch (cleanup) { throw yearsFailure(failed ? [primary, cleanup] : [cleanup]); }
      }
    };
    return nonemptyId(child.OwnerId) ? manager.withItem(child.OwnerId, examine) : examine(null);
  }

  async function resolveBoxSetLink(item, handle, link, operation) {
    if (link.ItemId != null && !nonemptyId(link.ItemId)) return;
    const captured = async child => {
      const owner = child ? manager.retainItem(child) : null;
      let failed = false, primary;
      try {
        const next = child?.Id ?? EMPTY_ID;
        if (next !== link.ItemId) await linkedChildren.recordResolution(handle, link.Ordinal, next, { session: database });
        if (child) await operation(child);
      } catch (reason) { failed = true; primary = reason; throw reason; }
      finally {
        const reasons = [];
        for (const release of [() => owner?.release(), () => linkedChildren.flushReleases({ session: database })]) {
          try { await release(); } catch (reason) { reasons.push(reason); }
        }
        if (reasons.length) throw yearsFailure(failed ? [primary, ...reasons] : reasons);
      }
    };
    const fallback = async () => {
      if (link.Path) return captured(await findByPath(makeNativeAbsolutePath(item.Path, link.Path)));
      if (link.LibraryItemId) {
        let id;
        try { id = nativeGuid(link.LibraryItemId); }
        catch (reason) { throw Object.assign(libraryError(500, 'Unrecognized Guid format.'), { cause: reason }); }
        return manager.withItem(id, captured);
      }
      return captured(null);
    };
    if (link.ItemId != null) return manager.withItem(link.ItemId, first => first ? operation(first)
      : manager.withItem(link.ItemId, second => second ? captured(second) : fallback()));
    return fallback();
  }

  async function linked(item, append) {
    await ensureLinks(item);
    if (!user || !['BoxSet', 'Playlist'].includes(item.Type)) return consume(await metadata.linked(item), append);
    const operation = linkedChildren.admitHandleOperation(item.LinkedChildren);
    let failed = false, primary;
    try {
      // BoxSet.GetLinkedChildren(User) uses per-link manager lookups, not
      // ResolveLinkedChildren's eager positive-ID repository batch.
      if (await linkedChildren.count(operation.handle, { session: database }) === 0n) return;
      const roots = (await library.navigationChildren(state, user)).filter(folder), rootIds = new Set(roots.map(item => idKey(item.Id)));
      for await (const page of linkedChildren.pages(operation.handle, { session: database })) for (const link of page) {
        await resolveBoxSetLink(item, operation.handle, link, async child => {
          if (await boxSetLinkAllowed(child, roots, rootIds)) await append([child]);
        });
      }
    } catch (reason) { failed = true; primary = reason; throw reason; }
    finally {
      const reasons = [];
      for (const release of [() => operation.release(), () => linkedChildren.flushReleases({ session: database })]) {
        try { await release(); } catch (reason) { reasons.push(reason); }
      }
      if (reasons.length) throw yearsFailure(failed ? [primary, ...reasons] : reasons);
    }
  }

  return Object.freeze({ physical, eligible, linked });
}
