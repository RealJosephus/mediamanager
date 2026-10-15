import { nativeTextBytes, nativeTextOrdinalIgnoreCaseKey } from '../../src/database/native-text.js';
import { nativeTextSql } from '../../src/database/native-text-sql.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DomainStore } from '../../src/database/domain-store.js';
import { tableDefinition } from '../../src/database/model.js';
import {
  collectPostgresItemDeletionKeys,
  buildPostgresItemDeletionPlan,
  deletePostgresItemRows,
  deletePostgresItemRowsFromPlan,
  findPostgresPeople,
  reattachPostgresUserDataRows,
} from '../../src/database/postgres-persistence-query.js';
import { postgresInvariantLowerFunctionName } from '../../src/database/postgres-runtime-schema.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { deletePersistedItems, updateInheritedValues } from '../../src/library/item-persistence.js';
import { persistPeopleCredits } from '../../src/metadata/persistence.js';

const postgresOptions = { skip: !process.env.MEDIAMANAGER_TEST_POSTGRES };

test('PostgreSQL relational deletion materializes a large closure and keeps all transfer bounded', postgresOptions, async t => {
  const { database, store, schema } = await setup(t, 'deletion_scope');
  const prefix = '9a120000-0000-0000-0000-';
  await insertItem(database, '00000000-0000-0000-0000-000000000001', 'Retention placeholder');
  await database.client.query({ text: `INSERT INTO "BaseItems"
    SELECT created.* FROM generate_series(1, 6000) value
    CROSS JOIN LATERAL jsonb_populate_record(NULL::"BaseItems", $1::jsonb || jsonb_build_object(
      'Id', $2::text || lpad(value::text, 12, '0'), 'Name', 'Root', 'Type', $3::text)) created`,
    values: [JSON.stringify(blank('BaseItems'), (_, value) => typeof value === 'bigint' ? Number(value) : value), prefix,
      'MediaBrowser.Controller.Entities.Genre'] });
  const child = prefix + '000000010001';
  await insertItem(database, child, 'Persistence-only child', { ParentId: prefix + '000000000001' });
  await database.insert('Users', { ...blank('Users'), Id: ids.keeper, Username: 'Scope user' });
  await database.insert('UserData', { ...blank('UserData'), ItemId: child, UserId: ids.keeper,
    CustomDataKey: 'Retained relational key', PlayCount: 7 });
  // Two root parameters exercise retention-value offsets. The actual closure
  // is a SQL relation throughout creation and deletion, never a Node ID set.
  const plan = buildPostgresItemDeletionPlan(database, {
    text: `SELECT ${nativeTextSql(schema).guidKey('"Id"')} AS "Key" FROM "${schema}"."BaseItems"
      WHERE "Type" = $1 AND "Name" = $2`, values: [nativeTextBytes('MediaBrowser.Controller.Entities.Genre'), nativeTextBytes('Root')],
  });
  let largest = 0;
  const execute = database.client.query.bind(database.client);
  database.client.query = async (...args) => { const result = await execute(...args); largest = Math.max(largest, result.rows.length); return result; };
  await store.transaction(async db => {
    await db.client.query({ text: `CREATE TEMP TABLE deletion_scope AS ${plan.text}`, values: plan.values });
    const count = await db.client.query('SELECT count(*) AS count FROM deletion_scope');
    assert.equal(Number(count.rows[0].count), 6001);
    await deletePostgresItemRowsFromPlan(db, { text: 'SELECT "Key" FROM deletion_scope', values: [] }, {
      retainedItemId: '00000000-0000-0000-0000-000000000001', retentionDate: '2026-10-12 12:34:56.1234567',
    });
    await db.client.query('DROP TABLE deletion_scope');
  });
  assert.equal(Number((await database.client.query('SELECT count(*) AS count FROM "BaseItems"')).rows[0].count), 1);
  const retained = await database.rows('UserData'); assert.equal(retained.length, 1);
  assert.equal(retained[0].ItemId, '00000000-0000-0000-0000-000000000001');
  assert.equal(retained[0].PlayCount, 7); assert.equal(retained[0].RetentionDate, '2026-10-12 12:34:56.1234567');
  assert.equal(largest, 1);
});

test('PostgreSQL relational deletion freezes parameterized roots through its final cleanup', postgresOptions, async t => {
  const { database, store, schema } = await setup(t, 'deletion_parameters');
  await insertItem(database, '00000000-0000-0000-0000-000000000001', 'Retention placeholder');
  await insertItem(database, ids.item, 'Scoped'); await insertItem(database, ids.keeper, 'Keep');
  await database.insert('Users', { ...blank('Users'), Id: ids.keeper, Username: 'Scope user' });
  await database.insert('UserData', { ...blank('UserData'), ItemId: ids.item, UserId: ids.keeper, CustomDataKey: 'Key' });
  await database.insert('MediaSegments', { ...blank('MediaSegments'), Id: ids.existingPerson, ItemId: ids.item });
  await database.insert('TrickplayInfos', { ...blank('TrickplayInfos'), ItemId: ids.item });
  await store.transaction(db => deletePostgresItemRowsFromPlan(db, {
    text: `SELECT ${nativeTextSql(schema).guidKey('"Id"')} AS "Key" FROM "${schema}"."BaseItems" WHERE "Type" = $1 AND "Name" = $2`,
    values: [nativeTextBytes('MediaBrowser.Controller.Entities.Movies.Movie'), nativeTextBytes('Scoped')],
  }, { retainedItemId: '00000000-0000-0000-0000-000000000001', retentionDate: '2026-10-12 12:34:56.7654321' }));
  assert.deepEqual((await database.rows('BaseItems')).map(row => row.Id).sort(), [
    '00000000-0000-0000-0000-000000000001', ids.keeper,
  ]);
  assert.equal((await database.rows('UserData'))[0].RetentionDate, '2026-10-12 12:34:56.7654321');
  assert.deepEqual(await database.rows('MediaSegments'), []);
  assert.deepEqual(await database.rows('TrickplayInfos'), []);
});
const ids = {
  item: '9a000000-0000-0000-0000-000000000001',
  keeper: '9a000000-0000-0000-0000-000000000002',
  existingPerson: '9a000000-0000-0000-0000-000000000003',
  oldPerson: '9a000000-0000-0000-0000-000000000004',
  oldOrphan: '9a000000-0000-0000-0000-000000000005',
  newOrphan: '9a000000-0000-0000-0000-000000000006',
  inheritedOne: '9a000000-0000-0000-0000-000000000007',
  inheritedTwo: '9a000000-0000-0000-0000-000000000008',
};

function blank(table) {
  return Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
    const type = column.clrType.replace('?', '');
    return [column.name, type === 'DateTime' ? '2025-01-02 03:04:05' : column.nullable ? null
      : type === 'bool' ? false : column.type === 'TEXT' ? '' : ['long', 'uint'].includes(type) ? 0n : 0];
  }));
}

async function setup(t, prefix) {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = await PostgresDatabase.open({
    connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
    schema,
    create: true,
  });
  const store = new DomainStore(database);
  t.after(async () => {
    database.queryHook = null;
    await database.client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.client.query(`DROP SCHEMA "${schema}__mm" CASCADE`);
    await store.close();
  });
  return { database, store, schema };
}

async function insertItem(database, Id, Name, overrides = {}) {
  return database.insert('BaseItems', {
    ...blank('BaseItems'),
    Id,
    Name,
    Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
    ...overrides,
  });
}

async function captureTableQueries(database, tablePattern, operation) {
  const queries = [];
  database.queryHook = async (...args) => {
    const result = await database.client.query(...args);
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    const values = typeof args[0] === 'object' && args[0] !== null ? args[0].values : args[1];
    if (tablePattern.test(text)) queries.push({ text, values, command: result.command, rows: result.rows?.length ?? 0 });
    return result;
  };
  try { await operation(); }
  finally { database.queryHook = null; }
  return queries;
}

function planIndexNames(value, result = new Set()) {
  if (Array.isArray(value)) for (const entry of value) planIndexNames(entry, result);
  else if (value && typeof value === 'object') {
    if (typeof value['Index Name'] === 'string') result.add(value['Index Name']);
    for (const entry of Object.values(value)) planIndexNames(entry, result);
  }
  return result;
}

async function explainCapturedMutation(database, query) {
  return database.transaction(async session => {
    await session.client.query('SET LOCAL enable_seqscan = off');
    return (await session.client.query({
      text: `EXPLAIN (FORMAT JSON, COSTS OFF) ${query.text}`,
      values: query.values,
    })).rows[0]['QUERY PLAN'];
  }, { isolation: 'read-committed' });
}

test('PostgreSQL deletion closure and mutations stay set-shaped', async () => {
  const statements = [];
  const database = {
    dialect: 'postgres',
    schemaName: 'deletion_fixture',
    client: {
      async query(text, values) {
        statements.push({ text, values });
        return { rows: /SELECT "Key"/u.test(text)
          ? [{ Key: ids.item.replaceAll('-', '') }, { Key: ids.keeper.replaceAll('-', '') }]
          : [], rowCount: 0 };
      },
    },
  };

  const keys = await collectPostgresItemDeletionKeys(database, [ids.item, ids.item.replaceAll('-', '')]);
  assert.deepEqual(keys, [ids.item.replaceAll('-', ''), ids.keeper.replaceAll('-', '')]);
  const closure = statements.shift();
  assert.deepEqual(closure.values, [[ids.item.replaceAll('-', '')]]);
  assert.match(closure.text, /WITH RECURSIVE/u);
  assert.match(closure.text, /ancestor_direct/u);
  assert.match(closure.text, /ancestor_indirect/u);
  assert.match(closure.text, /item\."ParentId"/u);
  assert.match(closure.text, /item\."OwnerId"/u);
  assert.doesNotMatch(closure.text, /"LinkedChildren"/u);

  await deletePostgresItemRows(database, keys, {
    retainedItemId: '00000000-0000-0000-0000-000000000001',
    retentionDate: '2026-10-09 12:00:00.0000001',
  });
  assert.equal(statements.length, 12);
  assert.ok(statements.every(statement => Array.isArray(statement.values ?? [])));
  assert.equal(statements.some(statement => /^\s*SELECT\b/iu.test(statement.text)), false);
  const ranked = statements.find(statement => /row_number\(\) OVER/iu.test(statement.text));
  assert.ok(ranked);
  assert.ok(ranked.text.includes(nativeTextSql(database.schemaName).guidKey('data."UserId"')));
  assert.ok(ranked.text.includes(`${nativeTextSql(database.schemaName).projection('data."LastPlayedDate"')} from '\\.([0-9]{1,7})')`));
  assert.match(ranked.text, /data\."PlayCount" DESC/u);
  assert.match(ranked.text, /data\."ItemId" ASC/u);
  assert.ok(statements.some(statement => /DELETE FROM "deletion_fixture"\."LinkedChildren"/u.test(statement.text)
    && /link\."ParentId"/u.test(statement.text) && /link\."ChildId"/u.test(statement.text)));
  assert.ok(statements.some(statement => /DELETE FROM "deletion_fixture"\."Peoples"/u.test(statement.text)
    && /NOT EXISTS/iu.test(statement.text)));
  assert.ok(statements.some(statement => /UPDATE "deletion_fixture"\."BaseItems"/u.test(statement.text)
    && /SET "OwnerId" = NULL/u.test(statement.text)));
  assert.equal(statements.filter(statement => /DELETE FROM "deletion_fixture"\."BaseItems"/u
    .test(statement.text)).length, 1);
});

test('PostgreSQL retained UserData reattachment is one set update plus one bounded reload', async () => {
  const statements = [];
  const retained = {
    ...blank('UserData'),
    ItemId: ids.item,
    UserId: ids.keeper,
    CustomDataKey: 'provider-key',
    PlayCount: 3,
    PlaybackPositionTicks: '9007199254740993',
  };
  const database = {
    dialect: 'postgres',
    schemaName: 'reattach_fixture',
    client: {
      async query(text, values) {
        statements.push({ text, values });
        return { rows: /^\s*SELECT/iu.test(text) ? [Object.fromEntries(tableDefinition('UserData').columns.map(column => [column.name, column.type === 'TEXT' && retained[column.name] != null ? nativeTextBytes(retained[column.name]) : retained[column.name]]))] : [], rowCount: 1 };
      },
    },
  };
  assert.deepEqual(await reattachPostgresUserDataRows(database, ids.item,
    ['provider-key', 'provider-key', 'identity-key']), [{
    ...retained,
    PlaybackPositionTicks: 9007199254740993n,
  }]);
  assert.equal(statements.length, 2);
  assert.match(statements[0].text, /^\s*UPDATE/u);
  assert.match(statements[0].text, /"CustomDataKey" = ANY\(\$3::bytea\[\]\)/u);
  assert.deepEqual(statements[0].values, [nativeTextBytes(ids.item), '00000000000000000000000000000001',
    ['provider-key', 'identity-key'].map(nativeTextBytes)]);
  assert.match(statements[1].text, /^\s*SELECT/u);
  assert.match(statements[1].text, /data\."ItemId"[^\n]+ = \$1/u);
});

test('real PostgreSQL deletion keeps closure, retention, relations, and item removal inside bounded SQL',
  postgresOptions, async t => {
    const { database, store } = await setup(t, 'delete_closure');
    const fixture = {
      root: '9b000000-0000-0000-0000-000000000001',
      direct: '9b000000-0000-0000-0000-000000000002',
      indirect: '9b000000-0000-0000-0000-000000000003',
      parentChild: '9b000000-0000-0000-0000-000000000004',
      ownerChild: '9b000000-0000-0000-0000-000000000005',
      keeper: '9b000000-0000-0000-0000-000000000006',
      user: '9b000000-0000-0000-0000-000000000007',
      orphanPerson: '9b000000-0000-0000-0000-000000000008',
      sharedPerson: '9b000000-0000-0000-0000-000000000009',
      media: '9b000000-0000-0000-0000-000000000010',
      placeholder: '00000000-0000-0000-0000-000000000001',
    };
    await insertItem(database, fixture.placeholder, 'Retention placeholder', { Type: 'PLACEHOLDER' });
    await insertItem(database, fixture.root, 'Root');
    await insertItem(database, fixture.keeper, 'Keeper');
    await insertItem(database, fixture.direct, 'Ancestor direct', { ParentId: fixture.keeper });
    await insertItem(database, fixture.indirect, 'Ancestor indirect', { ParentId: fixture.keeper });
    await insertItem(database, fixture.parentChild, 'Parent closure', { ParentId: fixture.indirect });
    await insertItem(database, fixture.ownerChild, 'Owner closure', { OwnerId: fixture.parentChild });
    await database.insert('AncestorIds', { ItemId: fixture.direct, ParentItemId: fixture.root });
    await database.insert('AncestorIds', { ItemId: fixture.indirect, ParentItemId: fixture.direct });
    await database.insert('Users', { ...blank('Users'), Id: fixture.user, InternalId: 911n,
      Username: 'Deletion fixture', NormalizedUsername: 'DELETION FIXTURE' });
    const userData = (ItemId, overrides = {}) => ({
      ...blank('UserData'), ItemId, UserId: fixture.user, CustomDataKey: 'shared-key', ...overrides,
    });
    await database.insert('UserData', userData(fixture.root, {
      LastPlayedDate: '2026-10-09 01:02:03.0000000', PlayCount: 99,
    }));
    await database.insert('UserData', userData(fixture.indirect, {
      LastPlayedDate: '2026-10-09 01:02:03.0000001', PlayCount: 2, Rating: 8.5,
    }));
    await database.insert('UserData', userData(fixture.placeholder, {
      LastPlayedDate: '2025-01-01 00:00:00', PlayCount: 1,
    }));
    await database.insert('CustomItemDisplayPreferences', { ...blank('CustomItemDisplayPreferences'),
      Id: 1, ItemId: fixture.direct, UserId: fixture.user, Client: 'fixture', Key: 'layout' });
    await database.insert('ItemDisplayPreferences', { ...blank('ItemDisplayPreferences'),
      Id: 1, ItemId: fixture.indirect, UserId: fixture.user, Client: 'fixture', SortBy: 'Name' });
    await database.insert('MediaSegments', { ...blank('MediaSegments'), Id: fixture.media,
      ItemId: fixture.parentChild, SegmentProviderId: 'fixture' });
    await database.insert('TrickplayInfos', { ...blank('TrickplayInfos'), ItemId: fixture.ownerChild,
      Width: 320 });
    await database.insert('LinkedChildren', { ParentId: fixture.root, SortOrder: 1,
      ChildId: fixture.keeper, ChildType: 0 });
    await database.insert('LinkedChildren', { ParentId: fixture.keeper, SortOrder: 2,
      ChildId: fixture.direct, ChildType: 0 });
    await database.insert('Peoples', { Id: fixture.orphanPerson, Name: 'Orphan', PersonType: 'Actor' });
    await database.insert('Peoples', { Id: fixture.sharedPerson, Name: 'Shared', PersonType: 'Actor' });
    await database.insert('PeopleBaseItemMap', { ItemId: fixture.root, PeopleId: fixture.orphanPerson,
      Role: '', ListOrder: 0, SortOrder: null });
    await database.insert('PeopleBaseItemMap', { ItemId: fixture.direct, PeopleId: fixture.sharedPerson,
      Role: '', ListOrder: 0, SortOrder: null });
    await database.insert('PeopleBaseItemMap', { ItemId: fixture.keeper, PeopleId: fixture.sharedPerson,
      Role: '', ListOrder: 1, SortOrder: null });

    const tablePattern = /"(?:AncestorIds|BaseItems|UserData|CustomItemDisplayPreferences|ItemDisplayPreferences|LinkedChildren|MediaSegments|PeopleBaseItemMap|Peoples|TrickplayInfos)"/u;
    const queries = await captureTableQueries(database, tablePattern,
      () => deletePersistedItems(store, [fixture.root], {
        now: () => '2026-10-09 12:00:00.0000001',
      }));
    const selects = queries.filter(query => query.command === 'SELECT');
    assert.equal(selects.length, 1, 'only the recursive closure returns rows to Node');
    assert.match(selects[0].text, /WITH RECURSIVE/u);
    assert.deepEqual(new Set((await database.rows('BaseItems')).map(row => row.Id)),
      new Set([fixture.placeholder, fixture.keeper]));
    const retained = await database.rows('UserData', { where: { ItemId: fixture.placeholder } });
    assert.equal(retained.length, 1);
    assert.deepEqual({ PlayCount: retained[0].PlayCount, Rating: retained[0].Rating,
      RetentionDate: retained[0].RetentionDate }, {
      PlayCount: 2, Rating: 8.5, RetentionDate: '2026-10-09 12:00:00.0000001',
    });
    for (const table of ['CustomItemDisplayPreferences', 'ItemDisplayPreferences', 'LinkedChildren',
      'MediaSegments', 'TrickplayInfos']) assert.equal((await database.rows(table)).length, 0, table);
    assert.equal((await database.rows('Peoples', { where: { Id: fixture.orphanPerson } })).length, 0);
    assert.equal((await database.rows('Peoples', { where: { Id: fixture.sharedPerson } })).length, 1);
    assert.equal((await database.rows('PeopleBaseItemMap', { where: { ItemId: fixture.keeper } })).length, 1);

    const closureIndexes = planIndexNames(await explainCapturedMutation(database, selects[0]));
    assert.ok(closureIndexes.has('mm_runtime_ancestor_parent_item_normalized_idx'));
    assert.ok(closureIndexes.has('mm_runtime_baseitems_parent_normalized_sort_idx'),
      `closure plan indexes: ${[...closureIndexes].sort().join(', ')}`);
    assert.ok(closureIndexes.has('mm_runtime_baseitems_owner_normalized_idx'),
      `closure plan indexes: ${[...closureIndexes].sort().join(', ')}`);
    const ranked = queries.find(query => query.command === 'DELETE' && /row_number\(\) OVER/iu.test(query.text));
    assert.ok(planIndexNames(await explainCapturedMutation(database, ranked))
      .has('mm_runtime_user_data_item_user_rating_normalized_idx'));
    const itemDelete = queries.find(query => query.command === 'DELETE'
      && /DELETE FROM [^\n]+\."BaseItems"/u.test(query.text));
    assert.ok(planIndexNames(await explainCapturedMutation(database, itemDelete))
      .has('mm_runtime_baseitems_id_normalized_idx'));
  });

test('PostgreSQL people lookup uses only the invariant key predicate and deduplicates equivalent requests', async () => {
  let query;
  const database = {
    dialect: 'postgres',
    schemaName: 'people_fixture',
    client: {
      async query(text, values) {
        query = { text, values };
        return { rows: [{ Id: nativeTextBytes(ids.existingPerson), Name: nativeTextBytes('\u1E9EMITH'), PersonType: null }] };
      },
    },
  };
  const rows = await findPostgresPeople(database, [
    { Name: '\u1E9EMITH', Type: null },
    { Name: '\u00DFmith', Type: null },
  ]);

  assert.deepEqual(rows, [{ Id: ids.existingPerson, Name: '\u1E9EMITH', PersonType: null }]);
  assert.deepEqual(query.values, [[nativeTextBytes('\u00DFmith')], [null]]);
  assert.match(query.text, /"people_fixture"\."mm_invariant_lower"\(person\."Name"\) = requested\."NameKey"/u);
  assert.doesNotMatch(query.text, /\blower\s*\(/iu);
  assert.doesNotMatch(query.text, /\bOR\b/iu);
});

test('real PostgreSQL metadata credits fetch only requested people from a large unrelated table', postgresOptions, async t => {
  const { database, store, schema } = await setup(t, 'people_bounds');
  const snapshot = await insertItem(database, ids.item, 'Target');
  await database.insert('Peoples', { Id: ids.existingPerson, Name: '\u1E9EMITH', PersonType: 'Actor' });
  await database.insert('Peoples', { Id: ids.oldPerson, Name: 'Old Credit', PersonType: 'Actor' });
  const oldCredit = await database.insert('PeopleBaseItemMap', {
    ItemId: ids.item,
    PeopleId: ids.oldPerson,
    Role: 'Old Role',
    ListOrder: 0,
    SortOrder: null,
  });
  await database.client.query(`
    INSERT INTO "${schema}"."Peoples" ("Id", "Name", "PersonType")
    SELECT convert_to(md5('unrelated-person-' || value::text), 'UTF8'), convert_to('Unrelated Person ' || value::text, 'UTF8'), convert_to('Actor', 'UTF8')
    FROM generate_series(1, 2500) value`);
  await database.client.query(`
    CREATE FUNCTION "${schema}".protect_unrelated_people() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF ${nativeTextSql(schema).sqliteLike("OLD.\"Name\"", "convert_to('Unrelated Person %', 'UTF8')")} THEN
        RAISE EXCEPTION 'Unrelated person row was modified';
      END IF;
      RETURN OLD;
    END $$`);
  await database.client.query(`
    CREATE TRIGGER protect_unrelated_people
    BEFORE UPDATE OR DELETE ON "${schema}"."Peoples"
    FOR EACH ROW EXECUTE FUNCTION "${schema}".protect_unrelated_people()`);

  const loaded = {
    item: { Id: ids.item },
    snapshot,
    relationships: { PeopleBaseItemMap: [oldCredit] },
  };
  const people = [
    { Name: '\u00DFmith', Type: 'Actor', Role: 'Lead' },
    { Name: 'New Target', Type: 'Director', Role: null },
  ];
  const queries = await captureTableQueries(database, /"Peoples"/u,
    () => persistPeopleCredits(store, loaded, people));

  const selects = queries.filter(query => query.command === 'SELECT');
  assert.deepEqual(selects.map(query => query.rows), [1]);
  assert.match(selects[0].text, /WITH requested/u);
  assert.match(selects[0].text, new RegExp(postgresInvariantLowerFunctionName, 'u'));
  assert.doesNotMatch(selects[0].text, /\blower\s*\(/iu);
  assert.doesNotMatch(selects[0].text, /\bOR\b/iu);
  const plan = await database.transaction(async session => {
    await session.client.query('SET LOCAL enable_seqscan = off');
    return (await session.client.query({
      text: `EXPLAIN (FORMAT JSON, COSTS OFF) ${selects[0].text}`,
      values: selects[0].values,
    })).rows[0]['QUERY PLAN'];
  }, { readOnly: true, isolation: 'read-committed' });
  assert.ok(planIndexNames(plan).has('mm_runtime_people_name_type_invariant_idx'),
    'the production people lookup uses the invariant Name and PersonType runtime index');
  assert.equal((await database.rows('Peoples', { where: { Id: ids.oldPerson } })).length, 0);
  assert.equal((await database.rows('Peoples', { where: { Id: ids.existingPerson } })).length, 1);
  assert.equal((await database.client.query(`SELECT count(*) AS count FROM "${schema}"."Peoples" WHERE ${nativeTextSql(schema).sqliteLike("\"Name\"", "convert_to('Unrelated Person %', 'UTF8')")}`)).rows[0].count, 2500n);
  const credits = (await database.rows('PeopleBaseItemMap', { where: { ItemId: ids.item } }))
    .sort((left, right) => left.ListOrder - right.ListOrder);
  assert.deepEqual(credits.map(row => [row.PeopleId, row.Role, row.ListOrder]), [
    [ids.existingPerson, 'Lead', 0],
    [credits[1].PeopleId, '', 1],
  ]);
  assert.equal((await database.rows('Peoples', { where: { Id: credits[1].PeopleId } }))[0].Name, 'New Target');
});

test('real PostgreSQL item deletion purges old orphans without loading or touching linked values', postgresOptions, async t => {
  const { database, store, schema } = await setup(t, 'orphan_bounds');
  await insertItem(database, ids.item, 'Deleted');
  await insertItem(database, ids.keeper, 'Keeper');
  await database.insert('ItemValues', { ItemValueId: ids.oldOrphan, Type: 5, Value: 'Old Orphan', CleanValue: 'old orphan' });
  await database.insert('ItemValues', { ItemValueId: ids.newOrphan, Type: 5, Value: 'New Orphan', CleanValue: 'new orphan' });
  await database.insert('ItemValuesMap', { ItemId: ids.item, ItemValueId: ids.newOrphan });
  await database.client.query(`
    INSERT INTO "${schema}"."ItemValues" ("ItemValueId", "CleanValue", "Type", "Value")
    SELECT convert_to(md5('unrelated-value-' || value::text), 'UTF8'), convert_to(lower('Unrelated Value ' || value::text), 'UTF8'), 5,
      convert_to('Unrelated Value ' || value::text, 'UTF8')
    FROM generate_series(1, 2500) value`);
  await database.client.query(`
    INSERT INTO "${schema}"."ItemValuesMap" ("ItemValueId", "ItemId")
    SELECT convert_to(md5('unrelated-value-' || value::text), 'UTF8'), $1
    FROM generate_series(1, 2500) value`, [nativeTextBytes(ids.keeper)]);
  await database.client.query(`
    CREATE FUNCTION "${schema}".protect_linked_values() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF ${nativeTextSql(schema).sqliteLike("OLD.\"Value\"", "convert_to('Unrelated Value %', 'UTF8')")} THEN
        RAISE EXCEPTION 'Unrelated linked value was deleted';
      END IF;
      RETURN OLD;
    END $$`);
  await database.client.query(`
    CREATE TRIGGER protect_linked_values
    BEFORE DELETE ON "${schema}"."ItemValues"
    FOR EACH ROW EXECUTE FUNCTION "${schema}".protect_linked_values()`);

  const queries = await captureTableQueries(database, /"ItemValues(?:Map)?"/u,
    () => deletePersistedItems(store, [ids.item], { now: () => '2026-10-09T00:00:00.0000000Z' }));

  assert.equal(queries.some(query => query.command === 'SELECT'), false);
  const orphanDelete = queries.find(query => query.command === 'DELETE' && /NOT EXISTS/u.test(query.text));
  assert.ok(orphanDelete);
  assert.ok(planIndexNames(await explainCapturedMutation(database, orphanDelete))
    .has('mm_runtime_item_values_map_value_item_raw_idx'),
  'orphan cleanup probes raw ItemValueId membership through its covering reverse index');
  assert.equal((await database.rows('ItemValues', { where: { ItemValueId: ids.oldOrphan } })).length, 0);
  assert.equal((await database.rows('ItemValues', { where: { ItemValueId: ids.newOrphan } })).length, 1);
  assert.equal((await database.rows('BaseItems', { where: { Id: ids.item } })).length, 0);
  const unrelated = await database.client.query(`
    SELECT count(*) AS count
    FROM "${schema}"."ItemValues" value
    JOIN "${schema}"."ItemValuesMap" map ON map."ItemValueId" = value."ItemValueId"
    WHERE ${nativeTextSql(schema).sqliteLike('value."Value"', "convert_to('Unrelated Value %', 'UTF8')")} AND map."ItemId" = $1`, [nativeTextBytes(ids.keeper)]);
  assert.equal(unrelated.rows[0].count, 2500n);
});

test('real PostgreSQL inherited cleanup deletes only type-six links without materializing either table', postgresOptions, async t => {
  const { database, store, schema } = await setup(t, 'inherited_bounds');
  await insertItem(database, ids.keeper, 'Keeper');
  await database.client.query(`
    INSERT INTO "${schema}"."ItemValues" ("ItemValueId", "CleanValue", "Type", "Value")
    SELECT convert_to(md5('ordinary-tag-' || value::text), 'UTF8'), convert_to(lower('Ordinary Tag ' || value::text), 'UTF8'), 5,
      convert_to('Ordinary Tag ' || value::text, 'UTF8')
    FROM generate_series(1, 2500) value`);
  await database.client.query(`
    INSERT INTO "${schema}"."ItemValuesMap" ("ItemValueId", "ItemId")
    SELECT convert_to(md5('ordinary-tag-' || value::text), 'UTF8'), $1
    FROM generate_series(1, 2500) value`, [nativeTextBytes(ids.keeper)]);
  for (const [ItemValueId, Value] of [[ids.inheritedOne, 'Inherited One'], [ids.inheritedTwo, 'Inherited Two']]) {
    await database.insert('ItemValues', { ItemValueId, Type: 6, Value, CleanValue: Value.toLowerCase() });
    await database.insert('ItemValuesMap', { ItemValueId, ItemId: ids.keeper });
  }
  await database.client.query(`
    CREATE FUNCTION "${schema}".protect_ordinary_maps() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM "${schema}"."ItemValues" value
        WHERE value."ItemValueId" = OLD."ItemValueId" AND value."Type" <> 6
      ) THEN
        RAISE EXCEPTION 'Ordinary item-value map was deleted';
      END IF;
      RETURN OLD;
    END $$`);
  await database.client.query(`
    CREATE TRIGGER protect_ordinary_maps
    BEFORE DELETE ON "${schema}"."ItemValuesMap"
    FOR EACH ROW EXECUTE FUNCTION "${schema}".protect_ordinary_maps()`);

  const queries = await captureTableQueries(database, /"ItemValues(?:Map)?"/u,
    () => updateInheritedValues(store));

  assert.equal(queries.some(query => query.command === 'SELECT'), false);
  assert.equal(queries.filter(query => query.command === 'DELETE').length, 1);
  const inheritedDelete = queries.find(query => query.command === 'DELETE');
  assert.match(inheritedDelete.text, /\bUSING\b/u);
  assert.ok(planIndexNames(await explainCapturedMutation(database, inheritedDelete))
    .has('mm_runtime_item_values_map_value_item_raw_idx'),
  'inherited cleanup joins raw ItemValueId through its covering reverse index');
  const counts = await database.client.query(`
    SELECT
      (SELECT count(*) FROM "${schema}"."ItemValues") AS values,
      (SELECT count(*) FROM "${schema}"."ItemValuesMap") AS maps,
      (SELECT count(*) FROM "${schema}"."ItemValuesMap" map
        JOIN "${schema}"."ItemValues" value ON value."ItemValueId" = map."ItemValueId"
        WHERE value."Type" = 6) AS inherited_maps`);
  assert.deepEqual(counts.rows[0], { values: 2502n, maps: 2500n, inherited_maps: 0n });
});
