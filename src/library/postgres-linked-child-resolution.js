import { makeNativeAbsolutePath } from '../metadata/playlist-items.js';
import { nativeGuid } from '../users/native.js';
import { nonemptyId, EMPTY_ID, idKey, libraryError } from './records.js';
import { buildPostgresItemPageQuery, queryPostgresItemPage } from '../database/postgres-item-query.js';
import { hydrateNativeItemEntity, acquireNativeItemLinkOwner } from './native-item-entity.js';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes } from '../database/native-text.js';

/** LibraryManager.FindByPath's default repository query and live final lookup
 * are shared by metadata and UserRoot resolution, independently of the parent. */
export function findPostgresLinkedChildByPath({ library, store, itemCreation }, identity) {
  return store.run(async session => {
    const stored = library.options?.reversePath?.(identity) ?? identity;
    const result = await queryPostgresItemPage(session,
      { sortby: ['DateCreated'], sortorder: ['Descending'], limit: 1, enabletotalrecordcount: false },
      { groupByPresentationKey: false, itemIdsPlan: {
        text: `SELECT "Id" FROM ${q(session.schemaName)}."BaseItems" WHERE "Path"=$1`,
        values: [nativeTextBytes(stored)],
      } });
    return result.rows.length ? itemCreation.getItemById(result.rows[0].Id) : null;
  }, { readOnly: true });
}

/** Resolve one raw Folder relation in native order. The complete positive-ID
 * repository batch is hydrated before any live fallback. The caller owns the
 * item, resolution workspace, raw handle and typed cohort until completion. */
export async function resolvePostgresLinkedChildren({ session, item, links, linkedChildren,
  library, itemCreation, findByPath, resolution, cohort, ordinalOffset = 0n }) {
  await resolution.captureInitialBatch(buildPostgresItemPageQuery(session,
    { enabletotalrecordcount: false }, { itemIdsPlan: resolution.initialIdsPlan(), includeOrdinal: true }), {
    capturePage: async (rows, publishSlot) => {
      const state = await library.load(session, null, { baseRows: rows.map(row => row.baseRow),
        includeUserData: true, includeFolderLinks: true, includeManualLinks: false, includeLinkGraph: true });
      try {
        for (const row of rows) {
          const stored = state.byId.get(idKey(row.baseRow.Id));
          if (!stored) continue;
          // Default DtoOptions includes every field, images and user data. The
          // empty type filter does not request the TrailerTypes navigation.
          const child = hydrateNativeItemEntity(stored, stored.Type === 'Trailer' ? { trailerTypes: [] } : {});
          const owner = acquireNativeItemLinkOwner(child);
          try { await publishSlot(row.ordinal, await cohort.captureSlot(child)); }
          finally { owner.release(); await linkedChildren.flushReleases({ session }); }
        }
      } finally { await state.dispose({ session }); }
    }
  });
  for (let after = 0n; ; ) {
    const page = await resolution.readLinksPage({ after });
    if (!page.length) return;
    for (const link of page) {
      if (link.ItemId != null && !nonemptyId(link.ItemId)) continue;
      const batched = link.ItemId != null ? await resolution.initialSlot(link.ItemId) : null;
      if (batched) {
        await cohort.appendSlot(batched.slotKey, { ordinal: ordinalOffset + link.Ordinal });
        await resolution.recordResolution(link.Ordinal, { itemId: link.ItemId,
          resolvedId: batched.id, slotKey: batched.slotKey });
        continue;
      }
      const capture = async child => {
        const owner = child ? itemCreation.retainItem(child) : null;
        try {
          const nextId = child ? child.Id : EMPTY_ID;
          // Commit live cache publication before a later lookup failure or
          // repository save. Repository rollback must not erase this prefix.
          if (nextId !== link.ItemId) await linkedChildren.recordResolution(links,
            link.Ordinal, nextId, { session });
          const slotKey = child ? await cohort.capture(child, { ordinal: ordinalOffset + link.Ordinal, session }) : null;
          await resolution.recordResolution(link.Ordinal, { itemId: nextId,
            resolvedId: child?.Id ?? null, slotKey });
        } finally { owner?.release(); await linkedChildren.flushReleases({ session }); }
      };
      const fallback = async () => {
        if (link.Path) return capture(await findByPath(makeNativeAbsolutePath(item.Path, link.Path)));
        if (link.LibraryItemId) {
          let id;
          try { id = nativeGuid(link.LibraryItemId); }
          catch (error) {
            if (error?.status !== 400) throw error;
            // LibraryManager's string overload constructs Guid before lookup.
            // A malformed legacy ID is a failure, not a missing-item cache hit.
            throw Object.assign(libraryError(500, 'Unrecognized Guid format.'), { cause: error });
          }
          return itemCreation.withItem(id, capture);
        }
        return capture(null);
      };
      if (link.ItemId != null) await itemCreation.withItem(link.ItemId, child => child ? capture(child)
        : itemCreation.withItem(link.ItemId, second => second ? capture(second) : fallback()));
      else await fallback();
    }
    after = page.at(-1).Ordinal;
  }
}
