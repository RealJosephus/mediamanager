import { createNativeItemCohort } from './native-item-cohort.js';
import { boxSetDisplayOrder } from './boxset-state.js';
import { withYearTraversal } from './year-traversal.js';
import { prepareYearOrder, withYearMemoryOrder } from './year-memory-order.js';
import { yearsFailure } from './postgres-years-source.js';

/** YearsController creates every positive distinct by-name entity before its
 * response window. Source counts, Guid winners and stable memory order remain
 * SQL-owned; DTO hydration is bounded independently of an unbounded Limit. */
export async function queryYears({ library, database, input, user, hasUser, parent, state,
  virtualChildren, specialChildren, isVisible, projectPage, signal }) {
  return withYearTraversal({ library, database, input, user, hasUser, parent, state,
    recursive: input.recursive !== false, virtualChildren, specialChildren, isVisible, signal }, async source => {
    let catalogue, failed = false, primary, order;
    try {
      catalogue = await createNativeItemCohort({ linkedChildren: library.options.linkedChildren });
      const extracted = await source.seal(async (year, position) => {
        const item = await library.getYear(year);
        await catalogue.capture(item, { ordinal: position });
      }, {
        ...(hasUser && parent.Type === 'BoxSet' ? {
          withSortedWinners: (raw, consume) => withYearMemoryOrder({ database, source: raw,
            sortBy: [boxSetDisplayOrder(parent)], sortOrder: ['Ascending'], user,
            configuration: library.options.configuration, signal }, consume),
        } : {}),
        beforeExtract: () => {
          order = prepareYearOrder(input.sortBy, input.sortOrder, user);
          if (order.failure && !order.createBeforeFailure) throw order.failure;
        },
        afterExtract: () => { if (order.failure) throw order.failure; },
      });
      await catalogue.flush();
      const plan = catalogue.orderedPlan();
      const named = Object.freeze({ withSlot: (slot, operation) => catalogue.withSlot(slot, operation),
        async page(after = 0n) {
          const offset = plan.values.length;
          return (await database.client.query({ text: `SELECT source."Ordinal",source."SlotKey" FROM (${plan.text}) source
            WHERE source."Ordinal">$${offset + 1} ORDER BY source."Ordinal" LIMIT 128`, values: [...plan.values, after], signal })).rows
            .map(row => ({ position: BigInt(row.Ordinal), slot: row.SlotKey }));
        },
      });
      return await withYearMemoryOrder({ database, source: named, sortBy: order.sortBy, sortOrder: order.sortOrder, user,
        configuration: library.options.configuration, startIndex: input.startIndex ?? 0, limit: input.limit, signal }, async ordered => {
        const Items = [];
        for (let after = 0n;;) {
          const page = await ordered.page(after);
          if (!page.length) break;
          const items = [];
          await catalogue.withSlots(page.map(row => row.slot), async item => {
            items.push(item);
            // withSlots keeps every borrowed item alive through the final
            // callback, so one bounded DTO page observes their live values.
            if (items.length === page.length) Items.push(...await projectPage(items));
          });
          after = page.at(-1).position;
        }
        return { Items, TotalRecordCount: extracted.total, StartIndex: input.startIndex ?? 0 };
      });
    } catch (reason) { failed = true; primary = reason; throw reason; }
    finally {
      const reasons = [];
      for (const release of [() => catalogue?.release(), () => library.options.linkedChildren.flushReleases({ session: database })]) {
        try { await release(); } catch (reason) { reasons.push(reason); }
      }
      if (reasons.length) throw yearsFailure(failed ? [primary, ...reasons] : reasons);
    }
  });
}
