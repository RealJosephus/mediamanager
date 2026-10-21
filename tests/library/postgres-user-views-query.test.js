import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPostgresUserViewChildPresenceQuery,
  queryPostgresUserViewChildPresence,
} from '../../src/library/postgres-user-views-query.js';

const database = { dialect: 'postgres', schemaName: 'user_views_shape' };
const parentId = '12000000-0000-0000-0000-000000000001';
const userId = '12000000-0000-0000-0000-000000000002';

test('PostgreSQL UserViews filters and counts special-library children in SQL', () => {
  const plan = buildPostgresUserViewChildPresenceQuery(database, {
    parentIds: [parentId],
    userId,
    visibility: { blockedTags: ['Blocked'], maxRating: 6 },
  });
  assert.match(plan.text, /replace\([^\n]+mm_native_guid_lower[^\n]+i\."ParentId"[^\n]+\) = ANY/u);
  assert.match(plan.text, /permission_ancestor/u);
  assert.match(plan.text, /"InheritedParentalRatingValue"/u);
  assert.match(plan.text, /total AS \(SELECT count\(\*\)::bigint/u);
  assert.match(plan.text, /LIMIT \$\d+/u);
  assert.equal(plan.text.includes(parentId), false);
  assert.ok(plan.values.some(value => Array.isArray(value)
    && value.includes(parentId.replaceAll('-', '').toLowerCase())));
});

test('PostgreSQL UserViews presence executors hydrate no catalogue rows', async () => {
  const calls = [];
  const db = {
    ...database,
    client: { query: async plan => {
      calls.push(plan);
      return { rows: [{ Id: null, TotalRecordCount: '3' }] };
    } },
    rows: async () => assert.fail('presence queries must not hydrate BaseItems'),
  };
  assert.equal(await queryPostgresUserViewChildPresence(db, { parentIds: [parentId], userId }), true);
  assert.equal(calls.length, 1);
  assert.equal(await queryPostgresUserViewChildPresence(db, { parentIds: [] }), false);
  assert.equal(calls.length, 1);
});
