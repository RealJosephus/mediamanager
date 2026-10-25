import { dateTicks, idKey, nonemptyId, repositoryTopParentId } from './records.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { sortNative } from '../core/native-sort.js';
import { nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const nullableCompare = (a, b) => a == null ? (b == null ? 0 : -1) : b == null ? 1 : compare(a, b);
const positionCompare = (a, b) => nullableCompare(a.ParentIndexNumber, b.ParentIndexNumber) || nullableCompare(a.IndexNumber, b.IndexNumber);
const positionedAfter = (item, previous) => previous?.ParentIndexNumber == null || previous.IndexNumber == null
  || item.ParentIndexNumber != null && (item.ParentIndexNumber > previous.ParentIndexNumber
    || item.ParentIndexNumber === previous.ParentIndexNumber && item.IndexNumber != null && item.IndexNumber > previous.IndexNumber);

function specialOrder(item) {
  return BigInt.asIntN(64, BigInt(item.AirsAfterSeasonNumber ?? item.AirsBeforeSeasonNumber ?? 0) * 1000000000n
    + (item.AirsAfterSeasonNumber == null ? 0n : 1000000n)
    + BigInt(Math.imul(item.AirsBeforeEpisodeNumber ?? 0, 1000)) + BigInt(item.IndexNumber ?? 0));
}

function regularToSpecial(regular, special) {
  const seasons = compare(regular.ParentIndexNumber ?? -1, special.AirsAfterSeasonNumber ?? special.AirsBeforeSeasonNumber ?? -1);
  if (seasons) return seasons;
  if (special.AirsAfterSeasonNumber != null) return -1;
  if (special.AirsBeforeEpisodeNumber == null) return 1;
  if (regular.IndexNumber == null) return 0;
  return regular.IndexNumber === special.AirsBeforeEpisodeNumber ? 1 : compare(regular.IndexNumber, special.AirsBeforeEpisodeNumber);
}

export function airedEpisodeOrder(a, b) {
  const specialA = a.ParentIndexNumber === 0;
  const specialB = b.ParentIndexNumber === 0;
  if (specialA && specialB) return compare(specialOrder(a), specialOrder(b));
  if (specialA) return -regularToSpecial(b, a);
  if (specialB) return regularToSpecial(a, b);
  const result = compare((Math.imul(a.ParentIndexNumber ?? -1, 1000) + (a.IndexNumber ?? -1)) | 0,
    (Math.imul(b.ParentIndexNumber ?? -1, 1000) + (b.IndexNumber ?? -1)) | 0);
  return result || (a.PremiereDate != null && b.PremiereDate != null ? compare(dateTicks(a.PremiereDate), dateTicks(b.PremiereDate)) : 0);
}

export const sortAiredEpisodes = episodes => sortNative(episodes, airedEpisodeOrder);

export async function nextUpTopParentIds(parents, state, physicalIdsFor, user, library) {
  // The frozen repository only consumes TopParentIds. LibraryManager's ordinary
  // Folder/Series ancestor fallback therefore activates no series here.
  if (!parents.every(parent => ['CollectionFolder', 'UserView'].includes(parent.Type))) return new Set();
  const seen = new Set();
  const visit = async parent => {
    if (!parent || seen.has(idKey(parent.Id))) return [];
    seen.add(idKey(parent.Id));
    if (parent.Type === 'CollectionFolder') return physicalIdsFor(parent, state) ?? [];
    if (parent.Type === 'UserView') {
      if (ordinalIgnoreCaseEquals(parent.ViewType, 'livetv')) return [parent.Id];
      const reference = nonemptyId(parent.DisplayParentId) ? parent.DisplayParentId : parent.ParentId;
      if (nonemptyId(reference)) return visit(state.byId.get(idKey(reference)));
      if (parent.ViewType != null && !['movies', 'tvshows']
        .some(type => ordinalIgnoreCaseEquals(parent.ViewType, type))) return [];
      const source = await library.rootFolderPlan(state), offset = source.values.length;
      const sql = nativeTextSql(state.db.schemaName), result = [];
      for (let after = 0n;;) {
        const rows = (await state.db.client.query({ text: `SELECT folder."Ordinal",folder."SlotKey" FROM (${source.text}) folder
          WHERE folder."Ordinal">$${offset + 1} AND folder."NativeType"=$${offset + 2}::bytea
            AND ${sql.guidKey('folder."Id"')}=ANY($${offset + 3}::text[]) ORDER BY folder."Ordinal" LIMIT 128`,
          values: [...source.values, after, nativeTextBytes('MediaBrowser.Controller.Entities.CollectionFolder'),
            (user.Configuration?.GroupedFolders ?? []).map(idKey)] })).rows;
        if (!rows.length) return result;
        for (const row of rows) await library.withRootFolderSlot(state, row.SlotKey, async item => {
          if ((item.CollectionType == null || ordinalIgnoreCaseEquals(item.CollectionType, parent.ViewType))
            && await library.isItemVisible(item, user, state)) result.push(...await visit(item));
        });
        after = BigInt(rows.at(-1).Ordinal);
      }
    }
    const top = state.byId.get(idKey(repositoryTopParentId(parent)));
    return top ? [top.Id] : [];
  };
  const ids = [];
  for (const parent of parents) ids.push(...await visit(parent));
  return new Set(ids.map(idKey));
}
