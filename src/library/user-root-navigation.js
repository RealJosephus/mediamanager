import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { userRootItem } from './collection-membership.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { createPostgresLinkedResolutionWorkspace } from './postgres-linked-resolution-workspace.js';
import { resolvePostgresLinkedChildren, findPostgresLinkedChildByPath } from './postgres-linked-child-resolution.js';
import { acquireNativeItemLinkOwner, isNativeItemEntity, nativeItemDescriptor, publishNativeItemLinks } from './native-item-entity.js';

const pageSize = 128;
// Non-Folder root entries supply navigation identity/scope, not full DTO or
// relationship state. Folder instances remain exact owned typed objects.
const scalarFields = Object.freeze(['Id', 'NativeType', 'Type', 'IsFolder', 'Name', 'SortName', 'ForcedSortName',
  'Path', 'ParentId', 'OwnerId', 'ChannelId', 'CollectionType', 'DisplayParentId', 'UserId', 'IsRoot', 'IsHidden',
  'PresentationUniqueKey', 'SourceType', 'LocationType', 'MediaType', 'OfficialRating', 'CustomRating',
  'PreferredMetadataCountryCode', 'DateCreated', 'DateLastMediaAdded', 'ViewType']);
const isFolder = item => isNativeItemEntity(item) && nativeItemDescriptor(item.NativeType).family === 'folder';
function scalarProjection(item) {
  const result = {};
  for (const name of scalarFields) {
    const value = item[name];
    if (value != null && !['string', 'number', 'boolean', 'bigint', 'undefined'].includes(typeof value)) {
      throw new TypeError('A non-Folder root navigation projection must contain only scalar fields.');
    }
    result[name] = value;
  }
  return Object.freeze(result);
}
async function cleanup(primary, operations, message) {
  const failures = [];
  for (const operation of operations) {
    try { await operation(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(primary ? [primary, ...failures] : failures,
    primary?.message ?? message, primary ? { cause: primary } : undefined);
}

/** initialItems(context) materializes unfiltered raw+virtual occurrences before
 * links resolve. filterPage(items,context) runs only after complete resolution
 * and returns one Boolean per occurrence; identities cannot decide that mask.
 * The returned frame owns its root branch, exact Folder values and winner SQL
 * view until close. TEMP resolution ends before the supplied session returns;
 * later typed callbacks use an independent admitted relation scope.
 * withPage(options, callback) returns the callback's value. Its page contains
 * {entries:[{ordinal,slot,item}],after}; after remains unchanged for an empty
 * page. Typed values are owned until the callback settles, never by a caller
 * retaining its page array after that boundary. */
export async function prepareUserRootNavigation({ library, session, state, user, initialItems, filterPage }) {
  if (session?.dialect !== 'postgres' || !session.connectionSession || session.inTransaction
    || !library?.options?.linkedChildren || !library.itemCreation || !library.store
    || typeof initialItems !== 'function' || typeof filterPage !== 'function') {
    throw new TypeError('User-root navigation requires a nontransaction PostgreSQL operation, live library and occurrence callbacks.');
  }
  const linkedChildren = library.options.linkedChildren, storedRoot = userRootItem(state);
  const root = storedRoot ? library.itemCreation.getCachedItemById(storedRoot.Id) ?? storedRoot : null;
  const rootOwner = root ? acquireNativeItemLinkOwner(root) : null;
  const initialOwners = new Map(), folderSlots = new Map();
  const restoringSlot = new AsyncLocalStorage();
  const selected = [], winnerTable = q('mm_user_root_winners_' + randomUUID().replaceAll('-', ''));
  let rootOperation, resolution, cohort, visible, winners, frameScope, tableAttempted = false, ordinal = 0n;
  const context = { library, root, session, state, user };
  const dropTable = async primary => {
    if (!tableAttempted) return;
    tableAttempted = false;
    try { await session.client.query(`DROP TABLE IF EXISTS ${winnerTable}`); }
    catch (error) {
      if (primary && session.inTransaction && error.code === '25P02') return;
      session.discardConnection(error); throw error;
    }
  };
  const releaseFolders = async all => {
    for (const [slot, entry] of folderSlots) if (all || !entry.selected) {
      entry.owner.release(); folderSlots.delete(slot);
    }
    for (const owner of initialOwners.values()) owner.release();
    initialOwners.clear();
  };
  const capture = async (item, operation) => {
    let owner = isFolder(item) ? initialOwners.get(item) ?? acquireNativeItemLinkOwner(item) : null;
    if (owner) initialOwners.delete(item);
    try {
      const slot = await operation();
      if (owner) {
        const previous = folderSlots.get(slot);
        if (previous?.item !== item) {
          previous?.owner.release();
          folderSlots.set(slot, { item, owner, selected: false });
          owner = null;
        }
      }
      return slot;
    } finally { owner?.release(); }
  };
  let failure;
  try {
    frameScope = linkedChildren.admitScope();
    // UserRoot.GetEligibleChildren eagerly materializes Children+Virtual before
    // GetLinkedChildren, but none of its visibility callbacks run yet.
    const initial = Array.from(await initialItems(context));
    for (const item of initial) if (isFolder(item) && !initialOwners.has(item)) {
      initialOwners.set(item, acquireNativeItemLinkOwner(item));
    }
    if (root && !root.LinkedChildrenLoaded) {
      const loaded = await linkedChildren.load(session, root.Id);
      // A warm assignment made while cold I/O was pending is authoritative.
      if (!root.LinkedChildrenLoaded) publishNativeItemLinks(root, loaded);
      else await linkedChildren.release(loaded, { session });
    }
    if (root) rootOperation = linkedChildren.admitHandleOperation(root.LinkedChildren);
    cohort = await createNativeItemCohort({ linkedChildren, resolveLiveItem: id =>
      folderSlots.get(restoringSlot.getStore())?.item ?? library.itemCreation.getCachedItemById(id) });
    if (root) {
      const links = rootOperation.handle;
      resolution = await createPostgresLinkedResolutionWorkspace(session, { linksPlan: linkedChildren.plan(links) });
      await resolvePostgresLinkedChildren({ session, item: root, links, linkedChildren, library,
        itemCreation: library.itemCreation,
        findByPath: identity => findPostgresLinkedChildByPath({ library, store: library.store, itemCreation: library.itemCreation }, identity),
        resolution, cohort: Object.freeze({
          // Folder references survive even if the real bounded registry evicts
          // them during complete link resolution. Media slots stay SQL-owned.
          captureSlot: item => capture(item, () => cohort.captureSlot(item)),
          capture: (item, options) => capture(item, () => cohort.capture(item, options)),
          appendSlot: (slot, options) => cohort.appendSlot(slot, options),
        }) });
      await resolution.dispose(); resolution = null;
    }
    // A second occurrence view shares the slots, without overwriting the raw
    // linked order. Its Id projection observes live mutations before grouping.
    visible = await cohort.view({ session, plan: {
      text: 'SELECT NULL::bigint AS "Ordinal", NULL::uuid AS "SlotKey" WHERE FALSE', values: [],
    } });
    const appendPage = async (items, source) => {
      if (!items.length || items.length > pageSize) throw new TypeError('Root occurrence pages require 1..128 items.');
      const ordinals = items.map(() => ++ordinal);
      const mask = await filterPage(items, { ...context, source, ordinals: Object.freeze(ordinals) });
      if (!Array.isArray(mask) || mask.length !== items.length || mask.some(value => typeof value !== 'boolean')) {
        throw new TypeError('Root visibility must return one Boolean for every occurrence.');
      }
      for (let index = 0; index < items.length; index++) if (mask[index]) {
        const item = items[index];
        if (!isNativeItemEntity(item)) throw new TypeError('Root visibility requires exact typed item occurrences.');
        await capture(item, () => visible.capture(item, { ordinal: ordinals[index] }));
      }
    };
    for (let offset = 0; offset < initial.length; offset += pageSize) await appendPage(initial.slice(offset, offset + pageSize), 'initial');
    const restoreSlot = (view, slot, operation) => restoringSlot.run(slot, () => view.withSlot(slot, operation));
    const linksPlan = cohort.orderedPlan();
    for (let after = 0n; ;) {
      const offset = linksPlan.values.length;
      const rows = (await session.client.query({ text: `SELECT source."Ordinal",source."SlotKey"
        FROM (${linksPlan.text}) source WHERE source."Ordinal">$${offset + 1}
        ORDER BY source."Ordinal" LIMIT ${pageSize}`, values: [...linksPlan.values, after] })).rows;
      if (!rows.length) break;
      const pageItems = new Map(), pageOwners = [];
      let pageFailure;
      try {
        // withSlot may reuse a live object only when it was captured into this
        // exact slot. A same-ID repository object never replaces that branch.
        for (const row of rows) if (!pageItems.has(row.SlotKey)) {
          await restoreSlot(cohort, row.SlotKey, item => {
            pageOwners.push(acquireNativeItemLinkOwner(item));
            pageItems.set(row.SlotKey, item);
          });
        }
        await appendPage(rows.map(row => pageItems.get(row.SlotKey)), 'linked');
        after = BigInt(rows.at(-1).Ordinal);
      } catch (error) { pageFailure = error; throw error; }
      finally { await cleanup(pageFailure, [
        ...pageOwners.map(owner => () => owner.release()), () => linkedChildren.flushReleases({ session }),
      ], 'Root linked page cleanup failed.'); }
    }
    await visible.flush();
    const source = visible.orderedPlan(), sql = nativeTextSql(session.schemaName);
    tableAttempted = true;
    await session.client.query({ text: `CREATE TEMP TABLE ${winnerTable} AS
      WITH occurrences AS (${source.text}), ranked AS (
        SELECT DISTINCT ON (${sql.guidKey('occurrence."Id"')})
          min(occurrence."Ordinal") OVER (PARTITION BY ${sql.guidKey('occurrence."Id"')}) AS "Ordinal", occurrence."SlotKey"
        FROM occurrences occurrence ORDER BY ${sql.guidKey('occurrence."Id"')},occurrence."Ordinal" DESC
      ) SELECT "Ordinal","SlotKey" FROM ranked ORDER BY "Ordinal"`, values: source.values });
    winners = await visible.view({ session, plan: {
      text: `SELECT "Ordinal","SlotKey" FROM ${winnerTable} ORDER BY "Ordinal"`, values: [],
    } });
    for (let after = 0n; ;) {
      const rows = (await session.client.query(`SELECT "Ordinal","SlotKey" FROM ${winnerTable}
        WHERE "Ordinal">$1 ORDER BY "Ordinal" LIMIT ${pageSize}`, [after])).rows;
      if (!rows.length) break;
      for (const row of rows) {
        const exact = folderSlots.get(row.SlotKey);
        if (exact) { exact.selected = true; selected.push(exact.item); }
        else selected.push(await restoreSlot(winners, row.SlotKey, scalarProjection));
      }
      after = BigInt(rows.at(-1).Ordinal);
    }
    await cleanup(undefined, [() => dropTable(), () => visible.release(), () => cohort.release(),
      () => releaseFolders(false), () => linkedChildren.flushReleases({ session })], 'Root preparation cleanup failed.');
    visible = null; cohort = null;
    const items = Object.freeze(selected);
    const pending = new Set();
    let closed = false, closing;
    const active = () => {
      if (closed) throw new Error('The user-root navigation frame has been closed.');
    };
    // Admission happens in the caller's stack. Accepted callbacks keep every
    // SQL/entity owner even when close withdraws subsequent admissions.
    const admit = operation => {
      active();
      const result = Promise.resolve().then(operation);
      pending.add(result);
      result.then(() => pending.delete(result), () => pending.delete(result));
      return result;
    };
    const winnerRows = async ({ after, limit, slot } = {}) => {
      await winners.flush();
      const plan = winners.orderedPlan(), offset = plan.values.length;
      const selection = slot === undefined
        ? `source."Ordinal">$${offset + 1} ORDER BY source."Ordinal" LIMIT $${offset + 2}`
        : `source."SlotKey"=$${offset + 1}`;
      return frameScope.run(async current => (await current.client.query({
        text: `SELECT source."Ordinal",source."SlotKey" FROM (${plan.text}) source
          WHERE ${selection}`,
        values: [...plan.values, ...(slot === undefined ? [after, limit] : [slot])],
      })).rows);
    };
    const withWinnerSlot = (slot, operation) => restoreSlot(winners, slot, operation);
    return Object.freeze({ get items() {
      active();
      return items;
    }, orderedPlan() {
      active(); return winners.orderedPlan();
    }, withSlot(slot, operation) {
      if (typeof slot !== 'string' || typeof operation !== 'function') throw new TypeError('A winner slot and callback are required.');
      return admit(async () => {
        const rows = await winnerRows({ slot });
        if (rows.length !== 1) throw new TypeError('The slot is not a winner in this user-root frame.');
        return withWinnerSlot(rows[0].SlotKey, operation);
      });
    }, withPage({ after = 0n, limit = pageSize } = {}, operation) {
      if (typeof after !== 'bigint' || after < 0n || !Number.isInteger(limit) || limit < 1 || limit > pageSize
        || typeof operation !== 'function') throw new TypeError('Root typed pages require a bigint cursor, a limit from 1 to 128 and a callback.');
      return admit(async () => {
        const rows = await winnerRows({ after, limit }), pageItems = new Map(), owners = [];
        let pageFailure;
        try {
          for (const row of rows) if (!pageItems.has(row.SlotKey)) {
            await withWinnerSlot(row.SlotKey, item => {
              owners.push(acquireNativeItemLinkOwner(item)); pageItems.set(row.SlotKey, item);
            });
          }
          const entries = Object.freeze(rows.map(row => Object.freeze({
            ordinal: BigInt(row.Ordinal), slot: row.SlotKey, item: pageItems.get(row.SlotKey),
          })));
          return await operation(Object.freeze({ entries, after: entries.at(-1)?.ordinal ?? after }));
        } catch (error) { pageFailure = error; throw error; }
        finally { await cleanup(pageFailure, [...owners.map(owner => () => owner.release()),
          () => linkedChildren.flushReleases()], 'Root typed page ownership cleanup failed.'); }
      });
    }, close(primary) {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        while (pending.size) await Promise.allSettled([...pending]);
        await cleanup(primary, [() => winners.release(), () => releaseFolders(true),
          () => rootOperation?.release(), () => rootOwner?.release(), () => linkedChildren.flushReleases(),
          () => frameScope.release()], 'Root navigation ownership cleanup failed.');
      })();
      return closing;
    } });
  } catch (error) { failure = error; throw error; }
  finally {
    if (failure) await cleanup(failure, [() => dropTable(failure), () => resolution?.dispose(failure),
      () => winners?.release(), () => visible?.release(), () => cohort?.release(), () => releaseFolders(true),
      () => rootOperation?.release(), () => rootOwner?.release(), () => linkedChildren.flushReleases({ session }),
      () => frameScope?.release()],
    'Root navigation preparation failed to release its owners.');
  }
}
