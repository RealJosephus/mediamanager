import { resolvePostgresLinkedChildren } from './postgres-linked-child-resolution.js';
import { nativeGuid } from '../users/native.js';
import { idKey, nonemptyId, EMPTY_ID, libraryError } from './records.js';
import { EMPTY_NATIVE_LINKS, isLinkedChildrenHandle, emptyLinkedChildrenPlan } from './postgres-linked-children.js';
import { publishNativeItemLinks } from './native-item-entity.js';
import { createPostgresCollectionMembership } from './postgres-collection-membership.js';
import { CollectionEventItems } from './collection-event-items.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { createNativeItemCohort } from './native-item-cohort.js';

function requireLinks(collection) {
  if (collection.LinkedChildren === null) throw libraryError(500, 'A collection linked child relation cannot be null.');
  if (collection.LinkedChildren !== EMPTY_NATIVE_LINKS && !isLinkedChildrenHandle(collection.LinkedChildren))
    throw new TypeError('A live collection requires its current native link value.');
  return collection.LinkedChildren;
}

export async function attachEmptyCollectionLinks(parent, collection, session) {
  publishNativeItemLinks(collection, await parent.linkedChildren.createFromSession({ session,
    parentId: collection.Id, loaded: true, plan: emptyLinkedChildrenPlan() }));
  await parent.linkedChildren.flushReleases({ session });
}


async function publish(parent, session, collection, membership) {
  publishNativeItemLinks(collection, await parent.linkedChildren.createFromSession({ session,
    parentId: collection.Id, loaded: true, plan: membership.resolution.linksPlan() }));
  await parent.linkedChildren.flushReleases({ session });
}

async function event(parent, session, collection, membership, cohort, count, name) {
  // Persisted LinkedChildren deduplicates. The event always owns the separate
  // non-deduplicated request relation, promoted before the TEMP can be dropped.
  await cohort.flush();
  const view = await cohort.view({ session, plan: membership.eventPlan() });
  const items = new CollectionEventItems({ linkedChildren: parent.linkedChildren, view,
    itemCreation: parent.itemCreation, store: parent.store, count: BigInt(count),
    scope: parent.eventScope, collection });
  try { parent.emit(name, { Collection: collection, Items: items }); }
  finally { await items.release({ session }); }
}

async function withCollectionOwner(parent, collection, operation) {
  const owner = parent.itemCreation.retainItem(collection);
  let failure;
  try { return await operation(); }
  catch (error) { failure = error; throw error; }
  finally {
    owner.release();
    try { await parent.store.run(session => parent.linkedChildren.flushReleases({ session })); }
    catch (cleanup) { if (failure) throw new AggregateError([failure, cleanup], failure.message, { cause: failure }); throw cleanup; }
  }
}

/** The manager serializes this whole operation and supplies an inherited
 * checked-out task session. No member IDs or raw links are materialized whole. */
export function addCollectionMembers(parent, collection, { query, ids, fireEvent = true,
  refreshOptions } = {}) {
  return withCollectionOwner(parent, collection, () => addOwnedCollectionMembers(parent, collection,
    { query, ids, fireEvent, refreshOptions }));
}

async function addOwnedCollectionMembers(parent, collection, { query, ids, fireEvent,
  refreshOptions }) {
  requireLinks(collection);
  return parent.store.run(async session => {
    let membership, cohort, failure;
    try {
      cohort = await createNativeItemCohort({ linkedChildren: parent.linkedChildren });
      membership = await createPostgresCollectionMembership(session, { collectionId: collection.Id,
        linksPlan: parent.linkedChildren.plan(collection.LinkedChildren, { session }) });
      await resolvePostgresLinkedChildren({ session, item: collection, links: collection.LinkedChildren,
        linkedChildren: parent.linkedChildren, library: parent.library, itemCreation: parent.itemCreation,
        findByPath: parent.findByPath, resolution: membership.resolution, cohort });
      const resolveMember = (id, options) => parent.itemCreation.withItem(id, async item => item ? {
        resolvedId: item.Id, slotKey: await cohort.capture(item, options),
      } : null);
      const count = query ? await membership.prepareAddFromQuery(query, { resolveMember })
        : await membership.prepareAddFromIterable(ids, { resolveMember });
      if (!count) return;
      await membership.appendAdditions();
      await publish(parent, session, collection, membership);
      await cohort.flush();
      const rating = await parent.loadContext.withContext(collection.Id, { draft: collection, includeChildren: false },
        loaded => membership.selectOfficialRating({ ratingsPlan: cohort.plan(), metadataCountryCode: loaded.item.MetadataCountryCode,
          defaultCountryCode: parent.library.options?.configuration?.MetadataCountryCode }));
      if (rating !== undefined) collection.OfficialRating = rating;
      await parent.updateRepository(collection);
      parent.queueCollection(collection, { ...refreshOptions, ForceSave: true });
      if (fireEvent) await event(parent, session, collection, membership, cohort, count, 'ItemsAddedToCollection');
    } catch (error) { failure = error; throw error; }
    finally {
      const errors = [];
      for (const cleanup of [() => membership?.dispose(failure), () => cohort?.release()]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors,
        'Collection operation cleanup failed.', failure ? { cause: failure } : undefined);
    }
  });
}

export function removeCollectionMembers(parent, collection, ids, refreshOptions) {
  return withCollectionOwner(parent, collection, () => removeOwnedCollectionMembers(parent, collection, ids, refreshOptions));
}

async function removeOwnedCollectionMembers(parent, collection, ids, refreshOptions) {
  // Preserve the null-link failure prefix: each first request is parsed and
  // looked up before native removal touches LinkedChildren. An empty request
  // still reaches the one save/queue/event boundary.
  if (collection.LinkedChildren === null) {
    for (const value of ids) { await parent.itemCreation.getItemById(nativeGuid(value)); requireLinks(collection); }
    await parent.updateRepository(collection);
    parent.queueCollection(collection, { ...refreshOptions, ForceSave: true });
    return parent.store.run(async session => {
      const cohort = await createNativeItemCohort({ linkedChildren: parent.linkedChildren });
      try { await event(parent, session, collection, { eventPlan: () => ({
        text: 'SELECT NULL::bigint AS "Ordinal", NULL::uuid AS "SlotKey" WHERE FALSE', values: [] }) },
      cohort, 0, 'ItemsRemovedFromCollection'); }
      finally { await cohort.release(); }
    });
  }
  requireLinks(collection);
  return parent.store.run(async session => {
    let membership, cohort, failure;
    try {
      cohort = await createNativeItemCohort({ linkedChildren: parent.linkedChildren });
      membership = await createPostgresCollectionMembership(session, { collectionId: collection.Id,
        linksPlan: parent.linkedChildren.plan(collection.LinkedChildren, { session }) });
      const { removed, eventCount } = await membership.prepareRemoveFromIterable(ids,
        { withMember: (id, operation) => parent.itemCreation.withItem(id, operation),
          captureItem: (item, options) => cohort.capture(item, options),
          warnMissing: () => parent.library.options?.logger?.warn?.('No collection title exists with the supplied Id') });
      if (removed) await publish(parent, session, collection, membership);
      // Removal always saves, queues and emits, including a zero-match request;
      // it leaves OfficialRating unchanged, matching CollectionManager.
      await parent.updateRepository(collection);
      parent.queueCollection(collection, { ...refreshOptions, ForceSave: true });
      await event(parent, session, collection, membership, cohort, eventCount, 'ItemsRemovedFromCollection');
    } catch (error) { failure = error; throw error; }
    finally {
      const errors = [];
      for (const cleanup of [() => membership?.dispose(failure), () => cohort?.release()]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors,
        'Collection operation cleanup failed.', failure ? { cause: failure } : undefined);
    }
  });
}
