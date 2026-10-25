import { idKey, nonemptyId, sameId, VIDEO_TYPES } from './records.js';

const versionList = value => {
  if (value === null) throw Object.assign(new TypeError('A native video version array cannot be null.'),
    { status: 500 });
  return value ?? [];
};

export async function resolveVideoVersionLinks(db, item, { reversePath = value => value } = {}) {
  if (!VIDEO_TYPES.has(item.Type)) return null;
  const paths = versionList(item.LocalAlternateVersions).filter(value => value != null && value !== '').map(reversePath);
  const pathRows = paths.length ? await db.rows('BaseItems', { whereIn: { Path: paths } }) : [];
  const byPath = new Map();
  for (const row of pathRows) if (!byPath.has(row.Path)) byPath.set(row.Path, row.Id);
  const candidates = paths.filter(value => byPath.has(value)).map(value => ({ ChildId: byPath.get(value), ChildType: 2 }));
  for (const child of versionList(item.LinkedAlternateVersions)) if (nonemptyId(child.ItemId)) {
    candidates.push({ ChildId: child.ItemId, ChildType: 3 });
  }
  // Native grouping retains first occurrence order. Local entries were added
  // first, so they win a duplicate ID without changing that group's position.
  const unique = new Map();
  for (const child of candidates) if (!unique.has(idKey(child.ChildId))) unique.set(idKey(child.ChildId), child);
  const requested = [...unique.values()];
  const rows = requested.length ? await db.rows('BaseItems', { whereIn: { Id: requested.map(child => child.ChildId) } }) : [];
  const byId = new Map(rows.map(row => [idKey(row.Id), row]));
  return { requested, rows: byId, links: requested.filter(child => byId.has(idKey(child.ChildId)))
    .map((child, SortOrder) => ({ ParentId: item.Id, ...child, SortOrder })) };
}

// Call inside the owner's SaveItems transaction. This is deliberately not the
// generic DeleteItem closure: actual FK cascades/restrictions decide which
// orphan deletion succeeds, and non-FK preferences/segments remain untouched.
export async function persistVideoVersionRelations(db, item, options = {}) {
  const plan = await resolveVideoVersionLinks(db, item, options);
  if (!plan) return;
  const previous = await db.rows('LinkedChildren', { where: { ParentId: item.Id },
    orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
  const retainedOrders = new Set(previous.filter(row => row.ChildType !== 2 && row.ChildType !== 3)
    .map(row => row.SortOrder));
  for (const child of plan.requested) if (!plan.rows.has(idKey(child.ChildId))) {
    options.logger?.warn?.('Skipping alternate version for video {VideoName} ({VideoId}): child item {ChildId} does not exist in database',
      item.Name, item.Id, child.ChildId);
  }
  for (const row of plan.links) {
    if (retainedOrders.has(row.SortOrder)) {
      throw Object.assign(new Error('A video version conflicts with a tracked non-version LinkedChild key.'),
        { code: 'version-link-conflict', status: 500 });
    }
  }
  await db.deleteWhere('LinkedChildren', { ParentId: item.Id }, { whereIn: { ChildType: [2, 3] } });
  if (plan.links.length) await db.insertBatch('LinkedChildren', plan.links);
  const demotionIds = [...plan.rows.values()].filter(row => !sameId(row.Id, item.Id)
    && !sameId(row.Id, item.PrimaryVersionId) && !sameId(row.PrimaryVersionId, item.Id)).map(row => row.Id);
  if (demotionIds.length) {
    await db.updateWhere('BaseItems', {}, {
      PrimaryVersionId: item.Id,
      PresentationUniqueKey: idKey(item.Id),
    }, { whereIn: { Id: demotionIds } });
    options.logger?.info?.('Set PrimaryVersionId on {Count} alternate versions of video {VideoName} ({VideoId})',
      demotionIds.length, item.Name, item.Id);
  }
  const next = new Set(plan.requested.map(child => idKey(child.ChildId)));
  const orphanIds = previous.filter(row => row.ChildType === 2 && !next.has(idKey(row.ChildId)))
    .map(row => row.ChildId);
  if (orphanIds.length) {
    const orphans = await db.rows('BaseItems', { where: { OwnerId: item.Id },
      whereIn: { Id: orphanIds }, columns: ['Id'] });
    if (orphans.length) {
      options.logger?.info?.('Deleting {Count} orphaned LocalAlternateVersion items for video {VideoName} ({VideoId})',
        orphans.length, item.Name, item.Id);
      await db.deleteWhere('BaseItems', { OwnerId: item.Id }, {
        whereIn: { Id: orphans.map(row => row.Id) },
      });
    }
  }
  return plan.links;
}
