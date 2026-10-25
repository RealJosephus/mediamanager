import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { observeFolderChildIdsInvalidation } from './folder-cache.js';
import { setNativeItemResource, attachNativeItemResourceGraph } from './native-item-entity.js';

const caches = new WeakMap(), resourceKey = Symbol('Folder child IDs');
export const hasPostgresFolderChildIds = item => ['AggregateFolder', 'UserRootFolder'].includes(item.Type);
export const postgresFolderChildIds = item => caches.get(item) ?? null;

/** The ID list survives releasing Children. It records the original identities,
 * never the mutable identity projection of a later restored child cohort. */
export async function capturePostgresFolderChildIds({ linkedChildren, item, plan, isCurrent }) {
  const scope = linkedChildren.admitScope(), id = randomUUID(), table = `${q(linkedChildren.schemaName)}.folder_child_ids`;
  let references = 1, released = false;
  try {
    const offset = plan.values.length;
    await scope.run(session => session.client.query({ text: `INSERT INTO ${table}(scope_id,"Ordinal","Id")
      SELECT $${offset + 1},source."Ordinal",source."Id" FROM (${plan.text}) source ORDER BY source."Ordinal"`,
    values: [...plan.values, id] }));
  } catch (error) { scope.release(); throw error; }
  const source = Object.freeze({
    plan: () => Object.freeze({ text: `SELECT "Ordinal","Id" FROM ${table} WHERE scope_id=$1`, values: Object.freeze([id]) }),
    empty: () => scope.run(async session => !(await session.client.query(`SELECT EXISTS(SELECT 1 FROM ${table} WHERE scope_id=$1) AS present`, [id])).rows[0].present),
    retain() {
      if (released) throw new Error('The Folder child ID cache has been released.');
      references++;
      let returned = false;
      return Object.freeze({ release() { if (returned) return; returned = true; return source.release(); } });
    },
    async release() {
      if (released || --references) return;
      released = true;
      try { await scope.run(session => session.client.query(`DELETE FROM ${table} WHERE scope_id=$1`, [id])); }
      finally { scope.release(); }
    },
  });
  let subscription, binding;
  try {
    if (!isCurrent()) return source;
    attachNativeItemResourceGraph(item, linkedChildren.resourceGraph);
    subscription = observeFolderChildIdsInvalidation(item, () => binding?.unbind());
    binding = setNativeItemResource(item, resourceKey, { retain() {
      const held = source.retain();
      return { release: () => linkedChildren.queueOwnedRelease(() => held.release()) };
    }, detached() {
      if (caches.get(item) === source) caches.delete(item);
      subscription.release();
    } });
    await binding.ready;
    if (!isCurrent()) { binding.unbind(); return source; }
    caches.set(item, source);
    return source;
  } catch (error) {
    binding?.unbind(); subscription?.release(); await source.release(); throw error;
  }
}
