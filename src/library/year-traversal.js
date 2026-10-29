import { randomUUID } from 'node:crypto';
import { nativeItemDescriptor } from './native-item-entity.js';
import { libraryError } from './records.js';
import { createPostgresYearsSource, yearsFailure } from './postgres-years-source.js';
import { createYearFolderSource } from './year-folder-source.js';

/** Traverse YearsController's actual Folder sources. SQL owns the DFS queue,
 * Guid visited set, occurrence count and final Guid winners. Source callbacks
 * are the native UserView branch and per-item IsVisible, not public Items. */
export async function withYearTraversal({ library, database, parent, user, hasUser, recursive, input,
  state, virtualChildren, specialChildren, isVisible, signal }, consume) {
  const isFolder = parent.IsFolder && nativeItemDescriptor(parent.NativeType).family === 'folder';
  const rootView = isFolder && hasUser && parent.Type === 'UserView';
  const directSpecial = isFolder && hasUser && !recursive && ['Series', 'Season'].includes(parent.Type);
  const rootPlaylist = isFolder && hasUser && parent.Type === 'Playlist';
  const mode = !isFolder ? 'leaf' : rootView ? recursive ? 'user-view' : 'userless-direct'
    : directSpecial ? 'userless-direct' : rootPlaylist ? recursive ? 'user-playlist' : 'user-playlist-direct'
    : hasUser ? recursive ? 'user-recursive' : 'user-direct' : recursive ? 'userless-recursive' : 'userless-direct';
  let source, rootSlot, failed = false, primary;
  try {
    source = await createPostgresYearsSource(database, { linkedChildren: library.options.linkedChildren, mode,
      includeItemTypes: input.includeItemTypes, excludeItemTypes: input.excludeItemTypes, mediaTypes: input.mediaTypes, signal,
      // queryYears already owns this manager/root entity through the complete
      // traversal. Borrow its actual Children/VirtualChildren graph rather than
      // restoring a scalar snapshot and losing the root's warm relationships.
      resolveSourceSlot: parent.Type === 'AggregateFolder' ? slot => slot === rootSlot ? operation => operation(parent) : undefined : undefined });
    if (!isFolder) {
      await source.append([parent], [[0n]], { visible: true });
      return await consume(source);
    }
    if (hasUser && !user && !directSpecial && (!rootView || recursive)) {
      throw libraryError(rootView ? 500 : 400, "Value cannot be null. (Parameter 'user')");
    }
    if (rootView || directSpecial) {
      let ordinal = 0n;
      await specialChildren(parent, { recursive, input: rootView && recursive ? input : {} }, async items => {
        await source.append(items, items.map(() => [++ordinal]), { visible: true });
      });
      return await consume(source);
    }
    const reader = createYearFolderSource({ library, database, state, user, virtualChildren });
    rootSlot = await source.capture(parent);
    await source.enqueue({ path: [0n], slot: rootSlot, id: parent.Id });
    // Userless recursive links are read only after the entire initial physical
    // DFS. They contribute their own values, but are not recursively expanded.
    if (!hasUser && recursive) await source.enqueue({ path: [1n], slot: rootSlot, id: parent.Id, kind: 'root-links' });
    for (;;) {
      signal?.throwIfAborted();
      const work = await source.next();
      if (!work) break;
      await source.withSlot(work.slot, async item => {
        const frame = randomUUID();
        let local = 0n;
        const append = (items, sourceOptions = {}) => source.append(items, items.map(() => [...work.path, ++local]),
          { frame, visible: !hasUser, ...sourceOptions });
        if (work.kind === 'root-links') { await reader.linked(item, append); return; }
        if (hasUser) {
          if (item.Type === 'UserView') await specialChildren(item, { recursive: false, input: {} }, append);
          else await reader.eligible(item, append);
          await reader.linked(item, append);
          // AddChildren materializes complete Children+links, then all visible
          // occurrences, then applies type/media filters, before descending.
          for (let after = 0n;;) {
            const page = await source.framePage(frame, after);
            if (!page.length) break;
            const mask = [];
            for (const entry of page) mask.push(await source.withSlot(entry.slot, isVisible));
            await source.setVisible(page, mask);
            after = page.at(-1).ordinal;
          }
        } else await reader.physical(item, append);
        if (recursive && !rootPlaylist) for (let after = 0n;;) {
          const page = await source.folders(frame, after);
          if (!page.length) break;
          for (const entry of page) await source.enqueue({ path: entry.path, slot: entry.slot, id: entry.id });
          after = page.at(-1).ordinal;
        }
      });
    }
    return await consume(source);
  } catch (reason) { failed = true; primary = reason; throw reason; }
  finally {
    try { await source?.close({ failed }); }
    catch (cleanup) { throw yearsFailure(failed ? [primary, cleanup] : [cleanup]); }
  }
}
