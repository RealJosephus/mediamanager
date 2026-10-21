import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { idKey, nonemptyId } from './records.js';

export function buildPostgresUserViewChildPresenceQuery(database, { parentIds, userId, visibility } = {}) {
  const ids = [...new Set((parentIds ?? []).filter(nonemptyId).map(idKey))];
  if (!ids.length) return null;
  return buildPostgresItemPageQuery(database, { limit: 1 }, {
    scope: { parentIds: ids },
    userId,
    visibility,
  });
}

export async function queryPostgresUserViewChildPresence(database, options) {
  const plan = buildPostgresUserViewChildPresenceQuery(database, options);
  if (!plan) return false;
  const result = await database.client.query({ text: plan.text, values: plan.values });
  const total = result.rows.length ? Number(result.rows[0].TotalRecordCount) : 0;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('PostgreSQL returned an invalid user-view child count.');
  return total > 0;
}
