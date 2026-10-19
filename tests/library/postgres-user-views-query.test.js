import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPostgresExternalViewPresenceQuery,
  buildPostgresUserViewChildPresenceQuery,
  queryPostgresExternalViewPresence,
  queryPostgresUserViewChildPresence,
} from '../../src/library/postgres-user-views-query.js';

const database = { dialect: 'postgres', schemaName: 'user_views_shape' };
const parentId = '12000000-0000-0000-0000-000000000001';
const userId = '12000000-0000-0000-0000-000000000002';

test('PostgreSQL UserViews probes external content with a relational EXISTS', () => {
  const plan = buildPostgresExternalViewPresenceQuery(database);
  assert.match(plan.text, /SELECT EXISTS/u);
  assert.match(plan.text, /FROM "user_views_shape"\."BaseItems" item/u);
  assert.match(plan.text, /substring\([^\n]+mm_bytes_text_projection[^\n]+item\."Type"[^\n]+ = ANY\(\$1::text\[\]\)/u);
  assert.deepEqual(plan.values, [['Channel', 'LiveTvChannel', 'LiveTvProgram']]);
  assert.doesNotMatch(plan.text, /LiveTvChannel/u, 'item types remain bound parameters');
});

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
      return calls.length === 1
        ? { rows: [{ Present: true }] }
        : { rows: [{ Id: null, TotalRecordCount: '3' }] };
    } },
    rows: async () => assert.fail('presence queries must not hydrate BaseItems'),
  };
  assert.equal(await queryPostgresExternalViewPresence(db), true);
  assert.equal(await queryPostgresUserViewChildPresence(db, { parentIds: [parentId], userId }), true);
  assert.equal(calls.length, 2);
  assert.equal(await queryPostgresUserViewChildPresence(db, { parentIds: [] }), false);
  assert.equal(calls.length, 2);
});
