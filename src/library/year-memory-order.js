import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { withPostgresNativeQueryJitOff } from '../database/postgres-native-query-jit.js';
import { createPostgresNativeItemQueryProjection } from './postgres-native-item-query-projection.js';
import { yearsFailure } from './postgres-years-source.js';
import { libraryError } from './records.js';

// The registered IUserBaseItemComparer implementations fail when Sort obtains
// the comparer, before a lazy sequence is enumerated. A preceding Random has
// already enumerated that sequence and therefore committed its Year prefix.
const userComparers = new Set(['dateplayed', 'playcount', 'isunplayed', 'isfavoriteorliked']);

export function prepareYearOrder(sortBy = [], sortOrder = [], user) {
  if (sortBy.length && sortOrder.length > sortBy.length) throw libraryError(500, 'Index was outside the bounds of the array.');
  const directions = sortBy.map((_, index) => sortOrder[index] ?? sortOrder[0] ?? 'Ascending');
  let enumerated = false;
  for (const name of sortBy) {
    const key = String(name).toLowerCase();
    if (key === 'random') enumerated = true;
    if (!user && userComparers.has(key)) return { sortBy, sortOrder: directions,
      failure: libraryError(400, `Sort key '${name}' requires a user, but none was provided.`), createBeforeFailure: enumerated };
  }
  return { sortBy, sortOrder: directions };
}

/** Sort an owned typed source with the existing memory-comparison SQL. The
 * public window is frozen once; only 128 slot identities enter a result page. */
export async function withYearMemoryOrder({ database, source, sortBy = [], sortOrder = [], user,
  configuration = {}, startIndex = 0, limit, signal }, consume) {
  const order = prepareYearOrder(sortBy, sortOrder, user);
  if (order.failure) throw order.failure;
  const output = q('mm_year_order_' + randomUUID().replaceAll('-', ''));
  let projection, attempted = false, failed = false, primary;
  try {
    projection = await createPostgresNativeItemQueryProjection(database);
    for (let after = 0n;;) {
      signal?.throwIfAborted();
      const rows = await source.page(after);
      if (!rows.length) break;
      for (const row of rows) await source.withSlot(row.slot, item => projection.append(item, row.slot, row.position));
      after = rows.at(-1).position;
    }
    const plan = buildPostgresItemPageQuery(database, { sortby: order.sortBy, sortorder: order.sortOrder }, {
      nativeItemsPlan: projection.plan(), resumableMode: 'memory', memorySourceOrder: 'occurrence', includeOrdinal: true,
      userId: user?.Id, includeOwnedItems: true, includeAlternateVersions: true, groupByPresentationKey: false,
      memorySortConfiguration: configuration,
    });
    attempted = true;
    await withPostgresNativeQueryJitOff(database, session => session.client.query({
      text: `CREATE TEMP TABLE ${output} AS SELECT "__ordinal" AS position,"__SlotKey" AS slot
        FROM (${plan.text}) ordered WHERE "Id" IS NOT NULL`, values: plan.values, signal,
    }));
    await database.client.query(`CREATE UNIQUE INDEX ON ${output}(position)`);
    const skip = Math.max(0, startIndex), take = limit == null ? null : Math.max(0, limit);
    return await consume(Object.freeze({ withSlot: source.withSlot,
      async page(after = 0n) {
        signal?.throwIfAborted();
        return (await database.client.query({ text: `SELECT position,slot FROM ${output}
          WHERE position>$1 AND position>$2 AND ($3::bigint IS NULL OR position<=$2+$3) ORDER BY position LIMIT 128`,
        values: [after, skip, take], signal })).rows.map(row => ({ position: BigInt(row.position), slot: row.slot }));
      },
    }));
  } catch (reason) { failed = true; primary = reason; throw reason; }
  finally {
    const failures = [];
    for (const release of [() => attempted && database.client.query(`DROP TABLE IF EXISTS ${output}`), () => projection?.close()]) {
      try { await release(); } catch (reason) { failures.push(reason); }
    }
    if (failures.length) {
      database.discardConnection(failures[0]); throw yearsFailure(failed ? [primary, ...failures] : failures);
    }
  }
}
