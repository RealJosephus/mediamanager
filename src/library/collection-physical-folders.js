import { nonemptyId } from './records.js';
import { requireNativeList } from './item-relations.js';
import { nativeFileSystemPathsEqual, nativeFileSystemPathKey } from './root-folder-file-data.js';
import { nativeItemTypes, nativeItemDescriptor } from './native-item-entity.js';
import { withPostgresCachedFolderChildren } from './postgres-cached-folder-children.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';

const isFolder = item => item && nativeItemDescriptor(item.NativeType).family === 'folder';
const folders = nativeItemTypes.filter(value => nativeItemDescriptor(value).family === 'folder').map(nativeTextBytes);

export async function physicalCollectionFolders(item, state, { session, enableCache = false, findByPath } = {}) {
  if (typeof session?.client?.query !== 'function') throw new TypeError('Collection physical folders require an admitted SQL session.');
  const library = state.library, manager = library?.itemCreation;
  if (enableCache) {
    const result = [];
    for (const id of requireNativeList(item.PhysicalFolderIds === undefined ? [] : item.PhysicalFolderIds, 'source')) {
      if (!nonemptyId(id)) throw Object.assign(new TypeError("Guid can't be empty (Parameter 'id')"),
        { nativeException: 'ArgumentException', parameterName: 'id', status: 500 });
      if (typeof manager?.withItem !== 'function') throw new TypeError('Collection physical-folder IDs require the formal item manager.');
      await manager.withItem(id, folder => { if (isFolder(folder)) { state.adoptItem(folder); result.push(folder); } });
    }
    return result;
  }
  const storedRoot = state.items.find(entry => entry.Type === 'AggregateFolder');
  if (!library?.rootHost && storedRoot && typeof manager?.getItemById !== 'function') throw new TypeError('Collection physical folders require the formal root manager.');
  const aggregate = library.rootHost ? await library.rootHost.getAggregateFolder()
    : storedRoot ? await manager.getItemById(storedRoot.Id) : null;
  const select = async source => {
    const live = new Map(), result = [], linkedChildren = library.options.linkedChildren;
    let cohort, selected, failure;
    try {
      cohort = await createNativeItemCohort({ linkedChildren, resolveLiveItem: (_id, slot) => live.get(slot)?.deref() });
      let ordinal = 0n;
      const capture = async folder => {
        const slot = await cohort.capture(folder, { ordinal: ++ordinal });
        live.set(slot, new WeakRef(folder));
      };
      for (const location of requireNativeList(item.PhysicalLocationsList === undefined ? [] : item.PhysicalLocationsList, 'source')) {
        if (nativeFileSystemPathsEqual(location, item.Path)) continue;
        let found = false;
        if (source) {
          await source.flush();
          const plan = source.pathPlan(), offset = plan.values.length, key = nativeFileSystemPathKey(location);
          for (let after = 0n;;) {
            const rows = (await session.client.query({ text: `SELECT source."Ordinal",source."SlotKey" FROM (${plan.text}) source
              WHERE source."Ordinal">$${offset + 1} AND source."NativeType"=ANY($${offset + 2}::bytea[])
                AND source."FileSystemPathKey"=$${offset + 3}::bytea ORDER BY source."Ordinal" LIMIT 128`,
              values: [...plan.values, after, folders, key == null ? null : nativeTextBytes(key)] })).rows;
            if (!rows.length) break;
            for (const row of rows) await source.withSlot(row.SlotKey, async folder => { found = true; await capture(folder); });
            after = BigInt(rows.at(-1).Ordinal);
          }
        }
        if (!found) {
          const folder = await findByPath(location, true);
          if (isFolder(folder)) await capture(folder);
        }
      }
      await cohort.flush();
      const plan = cohort.orderedPlan(), sql = nativeTextSql(session.schemaName);
      selected = await cohort.view({ session, plan: { text: `WITH ranked AS (
        SELECT source."Ordinal",source."SlotKey",row_number() OVER(PARTITION BY ${sql.guidKey('source."Id"')}
          ORDER BY source."Ordinal") AS rank FROM (${plan.text}) source
      ) SELECT "Ordinal","SlotKey" FROM ranked WHERE rank=1 ORDER BY "Ordinal"`, values: plan.values } });
      for (let after = 0n;;) {
        const page = await selected.page({ after, limit: 128 });
        try {
          if (!page.entries.length) return result;
          for (const entry of page.entries) { state.adoptItem(entry.item); result.push(entry.item); }
          after = page.entries.at(-1).Ordinal;
        } finally { await page.release(); }
      }
    } catch (error) { failure = error; throw error; }
    finally {
      const failures = [];
      for (const release of [() => selected?.release(), () => cohort?.release(), () => linkedChildren.flushReleases({ session })]) {
        try { await release(); } catch (error) { failures.push(error); }
      }
      live.clear();
      if (failures.length) throw new AggregateError([...(failure ? [failure] : []), ...failures],
        failure?.message ?? 'Collection physical-folder resources failed to release.', failure ? { cause: failure } : undefined);
    }
  };
  return aggregate ? withPostgresCachedFolderChildren({ session, library, item: aggregate }, select) : select(null);
}
