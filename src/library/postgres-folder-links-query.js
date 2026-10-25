import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { withPostgresNativeQueryJitOff } from '../database/postgres-native-query-jit.js';
import { acquireNativeItemLinkOwner, publishNativeItemLinks } from './native-item-entity.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { cachedFolderChildrenSnapshot } from './folder-cache.js';
import { withPostgresCachedFolderChildren } from './postgres-cached-folder-children.js';
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
  const owner = acquireNativeItemLinkOwner(item), children = cachedFolderChildrenSnapshot(item);
  const liveSources = new Map(), winners = q('mm_folder_winners_' + randomUUID().replaceAll('-', ''));
  let scope, operation, resolution, cohort, projection, childSources, sourceTable, winnerTable = false, prepared, closing;
  const close = primary => closing ??= (async () => {
    const failures = [];
    for (const release of [() => sourceTable && session.client.query(`DROP TABLE ${sourceTable}`),
      () => winnerTable && session.client.query(`DROP TABLE ${winners}`), () => projection?.close(),
      () => resolution?.dispose(primary), () => cohort?.release(), () => childSources?.release(), () => operation?.release(),
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
      resolveLiveItem: (id, slot) => liveSources.get(slot)?.deref() ?? itemCreation.getCachedItemById(id),
      resolveSourceSlot: async slot => {
        if (!childSources) return null;
        const source = (await session.client.query(`SELECT source_slot FROM ${sourceTable} WHERE slot=$1`, [slot])).rows[0];
        return source ? callback => childSources.withSlot(source.source_slot, callback) : null;
      } });
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
      sourceTable = q('mm_folder_sources_' + randomUUID().replaceAll('-', ''));
      await session.client.query(`CREATE TEMP TABLE ${sourceTable} (slot uuid PRIMARY KEY,source_slot uuid NOT NULL)`);
      await withPostgresCachedFolderChildren({ session, library, item }, async source => {
        childSources = source.retain();
        for (let after = 0n;;) {
          const count = await source.withPage({ after }, async page => {
            for (const entry of page.entries) {
              const slot = await cohort.capture(entry.item, { ordinal: ++ordinal });
              await session.client.query(`INSERT INTO ${sourceTable}(slot,source_slot) VALUES($1,$2)
                ON CONFLICT(slot) DO UPDATE SET source_slot=EXCLUDED.source_slot`, [slot, entry.slot]);
            }
            after = page.after; return page.entries.length;
          });
          if (!count) break;
        }
      });
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
