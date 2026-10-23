import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { withPostgresNativeQueryJitOff } from '../database/postgres-native-query-jit.js';
import { acquireNativeItemLinkOwner, hydrateNativeItemEntity, publishNativeItemLinks } from './native-item-entity.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { cachedFolderChildrenSnapshot } from './folder-cache.js';
import { physicalPlan } from './metadata-children.js';
import { idKey, libraryError } from './records.js';
import { createPostgresNativeItemQueryProjection } from './postgres-native-item-query-projection.js';
import { createPostgresLinkedResolutionWorkspace } from './postgres-linked-resolution-workspace.js';
import { resolvePostgresLinkedChildren, findPostgresLinkedChildByPath } from './postgres-linked-child-resolution.js';

/** Folder's user branch materializes physical Children and the complete linked
 * batch before visibility/name eligibility. SQL retains the first Guid position
 * and the last eligible exact object; later full filters never try an earlier
 * duplicate. Userless reads retain the exact Children occurrences. Only
 * bounded typed pages cross the SQL boundary. */
export async function createPostgresFolderLinksQuery({ session, library, item, user }) {
  const { linkedChildren } = library.options, { itemCreation } = library;
  if (!linkedChildren || !itemCreation) throw new TypeError('Folder queries require the runtime entity and relation owners.');
  item = itemCreation.getCachedItemById(item.Id) ?? item;
  const owner = acquireNativeItemLinkOwner(item), children = cachedFolderChildrenSnapshot(item);
  const liveSources = new Map(), winners = q('mm_folder_winners_' + randomUUID().replaceAll('-', ''));
  let scope, operation, resolution, cohort, projection, physicalTable, winnerTable = false, prepared, closing;
  const close = primary => closing ??= (async () => {
    const failures = [];
    for (const release of [() => physicalTable && session.client.query(`DROP TABLE ${physicalTable}`),
      () => winnerTable && session.client.query(`DROP TABLE ${winners}`), () => projection?.close(),
      () => resolution?.dispose(primary), () => cohort?.release(), () => operation?.release(),
      () => owner.release(), () => linkedChildren.flushReleases({ session }), () => scope?.release()]) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    liveSources.clear();
    if (failures.length) throw new AggregateError(primary ? [primary, ...failures] : failures,
      primary?.message ?? 'Folder query cleanup failed.', primary ? { cause: primary } : undefined);
  })();
  try {
    scope = linkedChildren.admitScope();
    if (user && item.LinkedChildrenLoaded) operation = linkedChildren.admitHandleOperation(item.LinkedChildren);
    cohort = await createNativeItemCohort({ linkedChildren,
      resolveLiveItem: (id, slot) => liveSources.get(slot)?.deref() ?? itemCreation.getCachedItemById(id) });
    let ordinal = 0n;
    if (children !== undefined) {
      // This iterable already belongs to the live Folder. No repository
      // candidate collection is materialized in process memory.
      for (const child of children) {
        const childOwner = acquireNativeItemLinkOwner(child);
        try {
          const slot = await cohort.capture(child, { ordinal: ++ordinal });
          liveSources.set(slot, new WeakRef(child));
        } finally { childOwner.release(); await linkedChildren.flushReleases({ session }); }
      }
    } else {
      const source = await physicalPlan(session, item, false, { linkedChildren, library });
      const sql = nativeTextSql(session.schemaName);
      const target = q('mm_folder_physical_' + randomUUID().replaceAll('-', ''));
      await session.client.query({ text: `CREATE TEMP TABLE ${target} AS
        SELECT source."Ordinal",item.* FROM (${source.text}) source
        JOIN ${q(session.schemaName)}."BaseItems" item ON ${sql.guidKey('item."Id"')}=${sql.guidKey('source."Id"')}`, values: source.values });
      physicalTable = target;
      const columns = tableDefinition('BaseItems').columns;
      for (let after = 0n;;) {
        const rows = (await session.client.query(`SELECT * FROM ${physicalTable} WHERE "Ordinal">$1 ORDER BY "Ordinal" LIMIT 128`, [after])).rows;
        if (!rows.length) break;
        const baseRows = rows.map(row => Object.fromEntries(columns.map(column => [column.name, decodeValue(column, row[column.name], 'postgres')])));
        const state = await library.load(session, null, { baseRows, includeUserData: true,
          includeFolderLinks: true, includeManualLinks: false, includeLinkGraph: true });
        try {
          for (const row of rows) {
            const stored = state.byId.get(idKey(decodeNativeTextBytes(row.Id)));
            if (!stored) continue;
            const child = hydrateNativeItemEntity(stored, stored.Type === 'Trailer' ? { trailerTypes: [] } : {});
            const childOwner = acquireNativeItemLinkOwner(child);
            try { await cohort.capture(child, { ordinal: ++ordinal }); }
            finally { childOwner.release(); await linkedChildren.flushReleases({ session }); }
          }
        } finally { await state.dispose({ session }); }
        after = BigInt(rows.at(-1).Ordinal);
      }
      await session.client.query(`DROP TABLE ${physicalTable}`); physicalTable = null;
    }
    if (user && !operation) {
      const loaded = await linkedChildren.load(session, item.Id);
      if (!item.LinkedChildrenLoaded) publishNativeItemLinks(item, loaded);
      else await linkedChildren.release(loaded, { session });
      operation = linkedChildren.admitHandleOperation(item.LinkedChildren);
    }
    if (user) {
      resolution = await createPostgresLinkedResolutionWorkspace(session,
        { linksPlan: linkedChildren.plan(operation.handle) });
      await resolvePostgresLinkedChildren({ session, library, item, links: operation.handle, linkedChildren,
        itemCreation, resolution, cohort, ordinalOffset: ordinal,
        findByPath: identity => findPostgresLinkedChildByPath({ library, store: library.store, itemCreation }, identity) });
    }
    projection = await createPostgresNativeItemQueryProjection(session);
    await cohort.flush();
    const captured = cohort.orderedPlan();
    for (let after = 0n;;) {
      const offset = captured.values.length;
      const rows = (await session.client.query({ text: `SELECT source."Ordinal",source."SlotKey" FROM (${captured.text}) source
        WHERE source."Ordinal">$${offset + 1} ORDER BY source."Ordinal" LIMIT 128`, values: [...captured.values, after] })).rows;
      if (!rows.length) break;
      for (const row of rows) await cohort.withSlot(row.SlotKey,
        child => projection.append(child, row.SlotKey, BigInt(row.Ordinal)));
      after = BigInt(rows.at(-1).Ordinal);
    }
    return Object.freeze({ async prepare(query, options, { prepareVisibility } = {}) {
      if (prepared) throw new Error('Folder eligibility has already been evaluated.');
      // The userless native branch filters Children directly. It neither
      // consumes LinkedChildren nor deduplicates separate same-ID occurrences.
      if (!user) return prepared = projection.plan();
      // BoxSet.IsVisible evaluates IsLegacyBoxSet before parental/tag access.
      // A nonempty Path therefore consumes the raw null sentinel even when a
      // later tag predicate or name filter would reject this occurrence.
      const invalidCollection = await session.client.query(`SELECT "__Occurrence" FROM ${projection.table}
        WHERE "Type"=$1 AND "__LinkedChildrenNull" AND "Path" IS NOT NULL AND octet_length("Path")>0
        ORDER BY "__Occurrence" LIMIT 1`, [nativeTextBytes('MediaBrowser.Controller.Entities.Movies.BoxSet')]);
      if (invalidCollection.rows.length) throw libraryError(500, 'Error processing request.');
      if (prepareVisibility) options = await prepareVisibility(projection.plan(), options);
      const childQuery = Object.fromEntries(['namestartswith', 'namestartswithorgreater', 'namelessthan']
        .filter(name => Object.hasOwn(query, name)).map(name => [name, query[name]]));
      const eligible = buildPostgresItemPageQuery(session, childQuery, { ...options,
        scope: {}, nativeItemsPlan: projection.plan(), itemIdsPlan: null, includeOwnedItems: true,
        includeAlternateVersions: true, groupByPresentationKey: false, collapseTypes: null,
        visibility: options.visibility ? { ...options.visibility, itemMode: 'standalone', scopeTopParentAccess: false } : undefined,
        memorySourceOrder: 'occurrence', memoryUserViewFilter: true });
      const sql = nativeTextSql(session.schemaName);
      await withPostgresNativeQueryJitOff(session, owner => owner.client.query({ text: `CREATE TEMP TABLE ${winners} AS WITH eligible AS (${eligible.text}), ranked AS (
        SELECT source."__Occurrence", min(source."__Occurrence") OVER(PARTITION BY ${sql.guidKey('source."Id"')}) AS "Ordinal",
          row_number() OVER(PARTITION BY ${sql.guidKey('source."Id"')} ORDER BY source."__Occurrence" DESC) AS rank
        FROM ${projection.table} source WHERE EXISTS(SELECT 1 FROM eligible WHERE eligible."__SlotKey"=source."__SlotKey")
      ) SELECT "__Occurrence","Ordinal" FROM ranked WHERE rank=1`, values: eligible.values }));
      winnerTable = true;
      prepared = Object.freeze({ text: `SELECT source.*,winner."Ordinal" AS "__SourceOrdinal" FROM ${projection.table} source
        JOIN ${winners} winner ON source."__Occurrence"=winner."__Occurrence"`, values: Object.freeze([]),
      repository: projection.plan().repository });
      return prepared;
    }, withSlot(slot, callback) { return cohort.withSlot(slot, callback); }, close });
  } catch (error) { await close(error); throw error; }
}
