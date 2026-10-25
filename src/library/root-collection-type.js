import { nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { idKey, libraryError, nonemptyId } from './records.js';

const collectionTypes = [
  'MediaBrowser.Controller.Entities.CollectionFolder',
  'Emby.Server.Implementations.Playlists.PlaylistsFolder',
].map(nativeTextBytes);

/** GetTopFolderContentType consumes ICollectionFolder occurrences lazily.
 * Unlike raw membership, PhysicalLocations.Contains uses ordinal string
 * equality and a later invalid list is not touched after a non-null winner. */
export async function rootCollectionType(library, item, state) {
  if (item == null) return null;
  let top = item;
  const seen = new Set([idKey(item.Id)]);
  while (nonemptyId(top.ParentId) && !seen.has(idKey(top.ParentId))) {
    seen.add(idKey(top.ParentId));
    const parent = state.byId.get(idKey(top.ParentId));
    if (!parent || parent.Type === 'AggregateFolder') break;
    top = parent;
  }
  return await library.withRootFolderPlan(state, async ({ session, plan, withSlot }) => {
    const offset = plan.values.length, sql = nativeTextSql(session.schemaName), target = `$${offset + 2}::bytea`;
    const samePath = `${sql.ordinalIgnoreCaseKey('folder."Path"')} IS NOT DISTINCT FROM ${sql.ordinalIgnoreCaseKey(target)}`;
    const matchesLocation = `EXISTS(SELECT 1 FROM unnest(folder."PhysicalLocations") location
      WHERE ${sql.ordinalKey('location')} IS NOT DISTINCT FROM ${sql.ordinalKey(target)})`;
    for (let after = 0n;;) {
      const rows = (await session.client.query({ text: `SELECT folder."Ordinal",folder."SlotKey",
        folder."PhysicalLocations" IS NULL AND NOT (${samePath}) AS "InvalidLocations"
        FROM (${plan.text}) folder WHERE folder."Ordinal">$${offset + 3}
          AND folder."NativeType"=ANY($${offset + 1}::bytea[])
          AND ((${samePath}) OR folder."PhysicalLocations" IS NULL OR ${matchesLocation})
        ORDER BY folder."Ordinal" LIMIT 1`, values: [...plan.values, collectionTypes,
        top.Path == null ? null : nativeTextBytes(top.Path), after] })).rows;
      if (!rows.length) return null;
      const row = rows[0];
      if (row.InvalidLocations) throw libraryError(500, "Value cannot be null. (Parameter 'source')");
      const value = await withSlot(row.SlotKey, folder =>
        folder.Type === 'PlaylistsFolder' ? 'playlists' : folder.CollectionType ?? null);
      if (value !== null) return value;
      after = BigInt(row.Ordinal);
    }
  });
}
