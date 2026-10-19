import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { quoteIdentifier as q } from '../database/model.js';
import { idKey, nonemptyId } from './records.js';

function qualified(database, name) {
  if (database?.dialect !== 'postgres') throw new TypeError('A PostgreSQL database is required.');
  return `${q(database.schemaName)}.${q(name)}`;
}

export function buildPostgresExternalViewPresenceQuery(database) {
  return Object.freeze({
    text: `SELECT EXISTS (
      SELECT 1
      FROM ${qualified(database, 'BaseItems')} item
      WHERE substring(${nativeTextSql(database.schemaName).projection("item.\"Type\"")} from '[^.]+$') = ANY($1::text[])
    ) AS "Present"`,
    values: Object.freeze([Object.freeze(['Channel', 'LiveTvChannel', 'LiveTvProgram'])]),
  });
}

export async function queryPostgresExternalViewPresence(database) {
  const plan = buildPostgresExternalViewPresenceQuery(database);
  const result = await database.client.query({ text: plan.text, values: plan.values });
  return result.rows[0]?.Present === true;
}

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
