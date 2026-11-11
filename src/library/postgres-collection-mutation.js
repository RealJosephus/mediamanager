import { resolvePostgresLinkedChildren } from './postgres-linked-child-resolution.js';
import { nativeGuid } from '../users/native.js';
import { idKey, nonemptyId, EMPTY_ID, libraryError } from './records.js';
import { EMPTY_NATIVE_LINKS, isLinkedChildrenHandle, emptyLinkedChildrenPlan } from './postgres-linked-children.js';
import { publishNativeItemLinks } from './native-item-entity.js';
import { createPostgresCollectionMembership } from './postgres-collection-membership.js';
import { CollectionEventItems } from './collection-event-items.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { operationFailure } from '../core/operation-failure.js';

async function withMemberCleanup(operation, cleanups) {
  const errors = [];
  let value;
  try { value = await operation(); } catch (error) { errors.push(error); }
  const primary = errors[0];
  for (const cleanup of cleanups) {
    try { await cleanup(primary); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw operationFailure(errors, 'Collection membership operation failed.');
  return value;
}

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
  let items;
  await withMemberCleanup(() => {
    items = new CollectionEventItems({ linkedChildren: parent.linkedChildren, view,
      itemCreation: parent.itemCreation, store: parent.store, count: BigInt(count),
      scope: parent.eventScope, collection });
    parent.emit(name, { Collection: collection, Items: items });
  }, [() => items ? items.release({ session }) : view.release({ session })]);
}

async function withCollectionOwner(parent, collection, operation) {
  const owner = parent.itemCreation.retainItem(collection);
  return withMemberCleanup(operation, [() => owner.release(),
    () => parent.store.run(session => parent.linkedChildren.flushReleases({ session }))]);
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
    let membership, cohort;
    return withMemberCleanup(async () => {
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
    }, [primary => membership?.dispose(primary), () => cohort?.release()]);
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
      return withMemberCleanup(() => event(parent, session, collection, { eventPlan: () => ({
        text: 'SELECT NULL::bigint AS "Ordinal", NULL::uuid AS "SlotKey" WHERE FALSE', values: [] }) },
      cohort, 0, 'ItemsRemovedFromCollection'), [() => cohort.release()]);
    });
  }
  requireLinks(collection);
  return parent.store.run(async session => {
    let membership, cohort;
    return withMemberCleanup(async () => {
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
    }, [primary => membership?.dispose(primary), () => cohort?.release()]);
  });
}
