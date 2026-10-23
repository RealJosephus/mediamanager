import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { cachedFolderChildrenSnapshot, readCachedFolderChildren, observeFolderChildrenInvalidation, observeFolderChildIdsInvalidation } from './folder-cache.js';
import { BoundedItemCache } from './bounded-item-cache.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { acquireNativeItemLinkOwner, acquireNativeItemLinkBranch, hydrateNativeItemEntity, setNativeItemResource,
  attachNativeItemResourceGraph, withNativeItemResourceAdmission } from './native-item-entity.js';
import { physicalPlan } from './postgres-folder-physical-plan.js';
import { idKey, nonemptyId, libraryError } from './records.js';
import { hasPostgresFolderChildIds, postgresFolderChildIds, capturePostgresFolderChildIds } from './postgres-folder-child-ids.js';

const caches = new WeakMap(), resourceKey = Symbol('cached Folder children');

async function releaseAll(primary, message, operations) {
  const errors = [];
  for (const operation of operations) try { await operation(); } catch (error) { errors.push(error); }
  if (!errors.length) return;
  if (!primary && errors.length === 1) throw errors[0];
  throw new AggregateError(primary ? [primary, ...errors] : errors, primary?.message ?? message,
    primary ? { cause: primary } : undefined);
}

function retainView(cohort, retainRoot, links) {
  const current = cohort.retain();
  let root;
  try { root = retainRoot(); }
  catch (error) { links.queueOwnedRelease(() => current.release()); throw error; }
  let released = false;
  return Object.freeze({ cohort: current,
    retain: () => {
      if (released) throw new Error('The cached Folder view has been released.');
      return retainView(current, () => root.retain(), links);
    },
    run: operation => {
      const borrowed = current.retain();
      try {
        return root.run(async () => {
          let primary;
          try { return await operation(borrowed); }
          catch (error) { primary = error; throw error; }
          finally { await releaseAll(primary, 'Cached Folder view release failed.', [() => borrowed.release()]); }
        });
      } catch (error) { links.queueOwnedRelease(() => borrowed.release()); throw error; }
    },
    async release() {
      if (released) return;
      released = true;
      try { await current.release(); } finally { root.release(); }
    },
  });
}

async function build({ session, library, item, children }, entry) {
  const links = library.options.linkedChildren, owners = new WeakMap(), warm = new Map();
  const materialized = new BoundedItemCache(128, { onRemove: child => {
    owners.get(child)?.release(); owners.delete(child);
  } });
  let cohort, subscription, idSubscription, idLease, binding, construction, held, primary;
  try {
    let ids = hasPostgresFolderChildIds(item) ? postgresFolderChildIds(item) : null;
    if (ids) idLease = ids.retain();
    let idsInvalidated = false;
    if (hasPostgresFolderChildIds(item)) idSubscription = observeFolderChildIdsInvalidation(item, () => { idsInvalidated = true; });
    subscription = observeFolderChildrenInvalidation(item, () => {
      entry.invalidated = true;
      if (caches.get(item) === entry) caches.delete(item);
      binding?.unbind();
    });
    cohort = await createNativeItemCohort({ linkedChildren: links,
      resolveLiveItem: (_id, slot) => materialized.peek(slot) ?? warm.get(slot)?.deref(),
      onMaterialize: (child, slot) => {
        binding.link(child, { slot });
        warm.set(slot, new WeakRef(child));
      },
      onRelease: () => {
        const failures = [];
        for (const release of [() => materialized.clear(),
          () => { warm.clear(); subscription?.release(); }]) {
          try { release(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, 'Cached Folder child branches failed to release.');
      } });
    if (entry.invalidated) return null;
    binding = setNativeItemResource(item, resourceKey, { retain() {
      const retained = cohort.retain(); held = retained;
      return { release: () => links.queueOwnedRelease(() => retained.release()) };
    }, detached() {
      entry.invalidated = true;
      if (caches.get(item) === entry) caches.delete(item);
      subscription?.release();
    } });
    await binding.ready;
    if (entry.invalidated) { binding.unbind(); return null; }
    construction = binding.retain();
    let ordinal = 0n;
    const capture = async (child, live = children !== undefined) => {
      const owner = acquireNativeItemLinkOwner(child);
      let failure;
      try {
        const slot = await cohort.capture(child, { ordinal: ++ordinal });
        if (live) warm.set(slot, new WeakRef(child));
      } catch (error) { failure = error; throw error; }
      finally { await releaseAll(failure, 'Captured Folder child cleanup failed.',
        [() => owner.release(), () => links.flushReleases({ session })]); }
    };
    if (children !== undefined) {
      for (const child of children) await capture(child);
    } else {
      if (ids && item.Type === 'AggregateFolder' && await ids.empty()) ids = null;
      if (ids) {
        if (typeof library.itemCreation?.withItem !== 'function') throw new TypeError('Folder child ID replay requires the formal item manager.');
        const source = ids.plan(), offset = source.values.length;
        for (let after = 0n;;) {
          const rows = (await session.client.query({ text: `SELECT source."Ordinal",source."Id" FROM (${source.text}) source
            WHERE source."Ordinal">$${offset + 1} ORDER BY source."Ordinal" LIMIT 128`, values: [...source.values, after] })).rows;
          if (!rows.length) break;
          for (const row of rows) {
            const id = decodeNativeTextBytes(row.Id);
            if (!nonemptyId(id)) throw libraryError(400, "Guid can't be empty (Parameter 'id')");
            await library.itemCreation.withItem(id, child => child ? capture(child, true) : undefined);
          }
          after = BigInt(rows.at(-1).Ordinal);
        }
      } else {
        const source = await physicalPlan(session, item, false, { linkedChildren: links, library });
        const captureRows = async current => {
          const sql = nativeTextSql(current.schemaName), cursor = q('mm_cached_folder_' + randomUUID().replaceAll('-', ''));
          // A cursor fixes the complete SELECT snapshot without DDL in a native
          // read-only request. Cohort writes use their independent relation pool.
          await current.client.query({ text: `DECLARE ${cursor} NO SCROLL CURSOR FOR
            SELECT source."Ordinal",item.* FROM (${source.text}) source
            JOIN ${q(current.schemaName)}."BaseItems" item ON ${sql.guidKey('item."Id"')}=${sql.guidKey('source."Id"')}
            ORDER BY source."Ordinal"`, values: source.values });
          let failure;
          try {
            const columns = tableDefinition('BaseItems').columns;
            for (;;) {
              const rows = (await current.client.query(`FETCH FORWARD 128 FROM ${cursor}`)).rows;
              if (!rows.length) break;
              const baseRows = rows.map(row => Object.fromEntries(columns.map(column => [column.name, decodeValue(column, row[column.name], 'postgres')])));
              const state = await library.load(current, null, { baseRows, includeUserData: true, includeFolderLinks: true, includeManualLinks: false, includeLinkGraph: true });
              let pageFailure;
              try {
                for (const row of rows) {
                  const stored = state.byId.get(idKey(decodeNativeTextBytes(row.Id)));
                  if (stored) await capture(hydrateNativeItemEntity(stored, stored.Type === 'Trailer' ? { trailerTypes: [] } : {}));
                }
              } catch (error) { pageFailure = error; throw error; }
              finally { await releaseAll(pageFailure, 'Cold Folder page release failed.', [() => state.dispose({ session: current })]); }
            }
          } catch (error) { failure = error; throw error; }
          finally {
            await releaseAll(failure, 'Cold Folder cursor release failed.', [async () => {
              try { await current.client.query(`CLOSE ${cursor}`); }
              catch (error) { current.discardConnection(error); throw error; }
            }]);
          }
        };
        if (session.inTransaction) await captureRows(session);
        else await session.transaction(captureRows, { readOnly: true, isolation: 'read-committed' });
      }
    }
    await cohort.flush();
    if (children === undefined && !ids && hasPostgresFolderChildIds(item) && !entry.invalidated && !idsInvalidated) {
      const capturedIds = await capturePostgresFolderChildIds({ linkedChildren: links, item, plan: cohort.orderedPlan(),
        isCurrent: () => !entry.invalidated && !idsInvalidated });
      await capturedIds.release();
    }
    const retainItem = (slot, child) => {
      if (!owners.has(child)) owners.set(child, acquireNativeItemLinkBranch(child));
      materialized.set(slot, child);
    };
    const snapshot = {
      retain: () => retainView(held, () => binding.retain(), links),
      withRetainedSlot: (view, slot, operation) => view.withSlot(slot, child => {
        retainItem(slot, child); return operation(child);
      }),
      withPage: async (view, current, { after = 0n, limit = 128, retainItems = false } = {}, operation) => {
        if (typeof after !== 'bigint' || after < 0n || !Number.isInteger(limit) || limit < 1 || limit > 128
          || typeof operation !== 'function') throw new TypeError('Cached Folder pages require an ordinal, bounded limit and callback.');
        await view.flush();
        const plan = view.orderedPlan(), offset = plan.values.length;
        const rows = (await current.client.query({ text: `SELECT source."Ordinal",source."SlotKey" FROM (${plan.text}) source
          WHERE source."Ordinal">$${offset + 1} ORDER BY source."Ordinal" LIMIT $${offset + 2}`, values: [...plan.values, after, limit] })).rows;
        const page = [], pageOwners = [];
        let failure;
        try {
          for (const row of rows) await view.withSlot(row.SlotKey, child => {
            pageOwners.push(acquireNativeItemLinkOwner(child));
            if (retainItems) retainItem(row.SlotKey, child);
            page.push(Object.freeze({ ordinal: BigInt(row.Ordinal), slot: row.SlotKey, item: child }));
          });
          return await operation(Object.freeze({ entries: Object.freeze(page), after: page.at(-1)?.ordinal ?? after }));
        } catch (error) { failure = error; throw error; }
        finally { await releaseAll(failure, 'Cached Folder page ownership release failed.',
          [...pageOwners.map(owner => () => owner.release()), () => links.flushReleases({ session: current })]); }
      },
    };
    if (entry.invalidated) { binding.unbind(); return null; }
    return snapshot;
  } catch (error) {
    primary = error;
    throw error;
  }
  finally {
    const cleanup = [];
    if (primary) cleanup.push(() => {
      if (caches.get(item) === entry) caches.delete(item);
    }, () => subscription?.release(), () => binding?.unbind());
    await releaseAll(primary, 'Cached Folder construction cleanup failed.', [...cleanup,
      () => idSubscription?.release(), () => idLease?.release(), () => cohort?.release(), () => construction?.release()]);
  }
}

/** The exact parent owns one cold Children snapshot in SQL. Only explicitly
 * returned pages enter the bounded materialization cache; query traversal does
 * not evict a directory borrowed earlier by another native consumer. */
export async function withPostgresCachedFolderChildren({ session, library, item }, operation) {
  const links = library.options.linkedChildren;
  return withNativeItemResourceAdmission(item, async () => {
    attachNativeItemResourceGraph(item, links.resourceGraph);
    const owner = acquireNativeItemLinkOwner(item);
    return withNativeItemResourceAdmission(item, async () => {
      let view, primary;
      try {
        const children = cachedFolderChildrenSnapshot(item);
        if (children !== undefined) readCachedFolderChildren(item, null, () => children);
        let entry = caches.get(item);
        if (!entry || children !== undefined && !entry.building) {
          entry = { invalidated: false, building: true };
          caches.set(item, entry);
          entry.ready = build({ session, library, item, children }, entry).finally(() => { entry.building = false; });
        }
        const source = await entry.ready;
        if (!source || entry.invalidated) return withPostgresCachedFolderChildren({ session, library, item }, operation);
        view = source.retain();
        const borrowedSession = callback => session.connectionActive && !session.connectionReleaseError
          ? callback(session) : library.store.run(callback);
        const frame = current => Object.freeze({
          retain: () => frame(current.retain()), release: () => current.release(),
          withPage: (options, callback) => current.run(borrowed => borrowedSession(db => source.withPage(borrowed, db, options, callback))),
          pages: async function* () {
            const held = current.retain();
            try {
              for (let after = 0n;;) {
                const page = await held.run(borrowed => borrowed.page({ after }));
                try {
                  if (!page.entries.length) return;
                  yield Object.freeze(page.entries.map(entry => entry.item));
                  after = page.entries.at(-1).Ordinal;
                } finally { await page.release(); }
              }
            } finally { await held.release(); }
          },
          withSlot: (slot, callback) => current.run(borrowed => borrowed.withSlot(slot, callback)),
          withRetainedSlot: (slot, callback) => current.run(borrowed => source.withRetainedSlot(borrowed, slot, callback)),
          pathPlan: () => current.cohort.pathPlan(),
          flush: () => current.run(borrowed => borrowed.flush()),
          orderedPlan: () => current.cohort.orderedPlan(),
        });
        return await view.run(() => operation(frame(view)));
      } catch (error) { primary = error; throw error; }
      finally { await releaseAll(primary, 'Cached Folder operation cleanup failed.',
        [() => view?.release(), () => owner.release(), () => links.flushReleases({ session })]); }
    });
  });
}
