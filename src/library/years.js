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
    let catalogue, failed = false, primary, order, emptyNameWindow = false;
    try {
      // Year factories commit in source order while response captures use
      // bounded pages before the final SQL sort and window.
      const pending = [];
      const flush = async () => {
        if (!pending.length) return;
        const slots = await catalogue.captureSlots(pending.map(entry => entry.item));
        await catalogue.appendSlots(slots, { ordinals: pending.map(entry => entry.ordinal) });
        pending.length = 0;
      };
      const extracted = await source.seal(async (year, position) => {
        const item = await library.getYear(year);
        if (!emptyNameWindow) {
          pending.push({ item, ordinal: position });
          if (pending.length === 128) await flush();
        }
      }, {
        ...(hasUser && parent.Type === 'BoxSet' ? {
          withSortedWinners: (raw, consume) => withYearMemoryOrder({ database, source: raw,
            sortBy: [boxSetDisplayOrder(parent)], sortOrder: ['Ascending'], user,
            configuration: library.options.configuration, signal }, consume),
        } : {}),
        beforeExtract: async () => {
          order = prepareYearOrder(input.sortBy, input.sortOrder, user);
          if (order.failure && !order.createBeforeFailure) throw order.failure;
          // A Name comparison cannot affect an empty window. Still resolve
          // every Year in source order, including its writes and failures.
          emptyNameWindow = input.limit === 0 && order.sortBy.length === 1
            && String(order.sortBy[0]).toLowerCase() === 'name';
          if (!emptyNameWindow) catalogue = await createNativeItemCohort({ linkedChildren: library.options.linkedChildren });
        },
        afterExtract: () => { if (order.failure) throw order.failure; },
      });
      if (emptyNameWindow) {
        signal?.throwIfAborted();
        return { Items: [], TotalRecordCount: extracted.total, StartIndex: input.startIndex ?? 0 };
      }
      await flush();
      await catalogue.flush();
      const plan = catalogue.orderedPlan();
      const named = Object.freeze({ withSlot: (slot, operation) => catalogue.withSlot(slot, operation),
        withSlots: (slots, operation) => catalogue.withSlots(slots, operation),
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
