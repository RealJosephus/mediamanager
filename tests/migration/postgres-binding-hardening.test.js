import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { quoteIdentifier as q } from '../../src/database/model.js';
import { databaseDigest, transferDatabase } from '../../src/migration/database-transfer.js';
import { seedAllTables } from '../database/fixtures.js';

const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;
const postgresOptions = { skip: !connectionString };

const instanceBinding = {
  serverId: '0123456789abcdef0123456789abcdef',
  originIdentityDigest: '0123456789abcdef'.repeat(4)
};

const differentBinding = {
  serverId: 'fedcba9876543210fedcba9876543210',
  originIdentityDigest: 'fedcba9876543210'.repeat(4)
};

let schemaSequence = 0;

function uniqueSchema(label) {
  schemaSequence += 1;
  const nonce = Math.floor(Math.random() * 0x100000).toString(36);
  return `mm_${label}_${process.pid.toString(36)}_${Date.now().toString(36)}_${schemaSequence}_${nonce}`;
}

async function closeAndDrop(databases, schemas) {
  const failures = [];
  for (const database of databases) {
    try { await database.close(); }
    catch (error) { failures.push(error); }
  }

  const cleanup = new pg.Client({ connectionString });
  let connected = false;
  try {
    await cleanup.connect();
    connected = true;
    for (const schema of schemas) {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
      await cleanup.query(`DROP SCHEMA IF EXISTS ${q(`${schema}__mm`)} CASCADE`);
    }
  } catch (error) { failures.push(error); }
  finally {
    if (connected) {
      try { await cleanup.end(); }
      catch (error) { failures.push(error); }
    }
  }

  if (failures.length) throw new AggregateError(failures, 'PostgreSQL binding test cleanup failed');
}

test('real PostgreSQL instance bindings are write-once, idempotent and cannot bypass setState', postgresOptions, async (t) => {
  const schema = uniqueSchema('write');
  const databases = [];
  t.after(() => closeAndDrop(databases, [schema]));

  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  databases.push(database);

  await assert.rejects(
    database.setState('instanceBinding', JSON.stringify(instanceBinding)),
    /write-once; use writeInstanceBinding/
  );
  await assert.rejects(
    database.setState('nativeEnvelope', '{}'),
    /write-once; use writeNativeEnvelope/
  );
  await assert.rejects(
    database.setState('transferReceipt', '{}'),
    /write-once; use writeTransferReceipt/
  );
  assert.equal(await database.readInstanceBinding(), null);

  assert.deepEqual(await database.writeInstanceBinding(instanceBinding), instanceBinding);
  assert.deepEqual(await database.writeInstanceBinding({ ...instanceBinding }), instanceBinding);
  assert.equal(
    Number((await database.client.query(`SELECT count(*) AS count FROM ${q(database.controlSchema)}.state WHERE key = 'instanceBinding'`)).rows[0].count),
    1
  );

  await assert.rejects(database.writeInstanceBinding(differentBinding), /instance binding differs/);
  assert.deepEqual(await database.readInstanceBinding(), instanceBinding);
  assert.equal(await database.getState('instanceBinding'), JSON.stringify(instanceBinding));
});

test('real PostgreSQL preflight rejects structural control-schema tampering', postgresOptions, async (t) => {
  const schema = uniqueSchema('shape');
  const databases = [];
  t.after(() => closeAndDrop(databases, [schema]));

  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  databases.push(database);
  await database.client.query(`ALTER TABLE ${q(database.controlSchema)}.state ADD COLUMN "unexpected" text`);

  await assert.rejects(database.preflight(), /control schema differs from its verified creation state/);
});

test('real PostgreSQL preflight binds schema, relation and column ownership and ACL state', postgresOptions, async (t) => {
  const labels = ['schema_owner', 'relation_owner', 'privileges', 'objects'];
  const schemas = Object.fromEntries(labels.map(label => [label, uniqueSchema(label)]));
  const role = uniqueSchema('owner_role');
  const databases = [];
  t.after(async () => {
    await closeAndDrop(databases, Object.values(schemas));
    const cleanup = new pg.Client({ connectionString });
    await cleanup.connect();
    try { await cleanup.query(`DROP ROLE IF EXISTS ${q(role)}`); }
    finally { await cleanup.end(); }
  });
  const open = async label => {
    const database = await PostgresDatabase.open({
      connectionString, schema: schemas[label], create: true, deferRuntimeSchemaInitialization: true,
    });
    databases.push(database);
    return database;
  };

  const schemaOwner = await open('schema_owner');
  const originalOwner = (await schemaOwner.inspectSchema()).namespaces[0].owner;
  await schemaOwner.client.query(`CREATE ROLE ${q(role)}`);
  await schemaOwner.client.query(`ALTER SCHEMA ${q(schemas.schema_owner)} OWNER TO ${q(role)}`);
  assert.equal((await schemaOwner.inspectSchema()).namespaces[0].owner, role);
  await assert.rejects(schemaOwner.preflight(), /schema differs from its verified creation state/);

  const relationOwner = await open('relation_owner');
  assert.equal((await relationOwner.inspectSchema()).relations
    .find(entry => entry.relname === 'Users').owner, originalOwner);
  await relationOwner.client.query(`ALTER TABLE "Users" OWNER TO ${q(role)}`);
  assert.equal((await relationOwner.inspectSchema()).relations
    .find(entry => entry.relname === 'Users').owner, role);
  await assert.rejects(relationOwner.preflight(), /schema differs from its verified creation state/);

  const privileges = await open('privileges');
  await privileges.client.query(`GRANT USAGE ON SCHEMA ${q(schemas.privileges)} TO PUBLIC`);
  await privileges.client.query('GRANT SELECT ON "Users" TO PUBLIC');
  await privileges.client.query('GRANT UPDATE ("Username") ON "Users" TO PUBLIC');
  const privilegeSnapshot = await privileges.inspectSchema();
  assert.notEqual(privilegeSnapshot.namespaces[0].privileges, null);
  assert.notEqual(privilegeSnapshot.relations.find(entry => entry.relname === 'Users').privileges, null);
  assert.notEqual(privilegeSnapshot.columns.find(entry => entry.table_name === 'Users'
    && entry.column_name === 'Username').privileges, null);
  await assert.rejects(privileges.preflight(), /schema differs from its verified creation state/);

  const objects = await open('objects');
  await objects.client.query(`CREATE OPERATOR ${q(schemas.objects)}.= (
    LEFTARG = text, RIGHTARG = text, FUNCTION = pg_catalog.texteq)`);
  assert.deepEqual((await objects.inspectSchema()).schemaObjects, [{
    object_type: 'operator', object_name: '=', owner: originalOwner,
  }]);
  await assert.rejects(objects.preflight(), /schema differs from its verified creation state/);
});

test('real PostgreSQL preflight rejects RLS and malformed native envelope state', postgresOptions, async (t) => {
  const rlsSchema = uniqueSchema('rls');
  const envelopeSchema = uniqueSchema('envelope');
  const databases = [];
  t.after(() => closeAndDrop(databases, [rlsSchema, envelopeSchema]));

  const rls = await PostgresDatabase.open({ connectionString, schema: rlsSchema, create: true });
  databases.push(rls);
  await rls.client.query('ALTER TABLE "Users" ENABLE ROW LEVEL SECURITY');
  await rls.client.query('ALTER TABLE "Users" FORCE ROW LEVEL SECURITY');
  await assert.rejects(rls.preflight(), /schema differs from its verified creation state/);

  const envelope = await PostgresDatabase.open({ connectionString, schema: envelopeSchema, create: true });
  databases.push(envelope);
  await envelope.client.query(`INSERT INTO ${q(envelope.controlSchema)}.state (key, value) VALUES ('nativeEnvelope', '{"ddl":[]}')`);
  await assert.rejects(envelope.preflight(), /Stored PostgreSQL native envelope is invalid/);
});

test('real PostgreSQL preflight binds rules, durability, sequence ownership and internal trigger state', postgresOptions, async (t) => {
  const schema = uniqueSchema('semantics');
  const databases = [];
  t.after(() => closeAndDrop(databases, [schema]));
  const database = await PostgresDatabase.open({ connectionString, schema, create: true });
  databases.push(database);

  await database.client.query('CREATE RULE mm_suppress_delete AS ON DELETE TO "Users" DO INSTEAD NOTHING');
  await assert.rejects(database.preflight(), /schema differs from its verified creation state/);
  await database.client.query('DROP RULE mm_suppress_delete ON "Users"');
  await database.preflight();

  await database.client.query('ALTER TABLE "ActivityLogs" SET UNLOGGED');
  await assert.rejects(database.preflight(), /schema differs from its verified creation state/);
  await database.client.query('ALTER TABLE "ActivityLogs" SET LOGGED');
  await database.preflight();

  const ownedSequence = (await database.client.query(`SELECT sequence.relname AS name
    FROM pg_class sequence
    JOIN pg_namespace sequence_namespace ON sequence_namespace.oid = sequence.relnamespace
    JOIN pg_depend dependency ON dependency.classid = 'pg_class'::regclass AND dependency.objid = sequence.oid
      AND dependency.refclassid = 'pg_class'::regclass AND dependency.deptype IN ('a', 'i')
    JOIN pg_class owner ON owner.oid = dependency.refobjid
    JOIN pg_attribute attribute ON attribute.attrelid = owner.oid AND attribute.attnum = dependency.refobjsubid
    WHERE sequence_namespace.nspname = $1 AND owner.relname = 'ActivityLogs' AND attribute.attname = 'Id'`, [schema])).rows[0]?.name;
  assert.ok(ownedSequence);
  assert.deepEqual((await database.inspectSchema()).sequenceOwnership.find(entry => entry.sequence_name === ownedSequence), {
    sequence_name: ownedSequence,
    deptype: 'i',
    owner_schema: schema,
    owner_table: 'ActivityLogs',
    owner_column: 'Id',
  });
  await database.client.query(`ALTER SEQUENCE ${q(ownedSequence)} CACHE 2`);
  await assert.rejects(database.preflight(), /schema differs from its verified creation state/);
  await database.client.query(`ALTER SEQUENCE ${q(ownedSequence)} CACHE 1`);
  await database.preflight();

  const internalTrigger = (await database.client.query(`SELECT trigger.tgname AS name
    FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = $1 AND relation.relname = 'AccessSchedules' AND trigger.tgisinternal
    ORDER BY trigger.tgname COLLATE "C" LIMIT 1`, [schema])).rows[0]?.name;
  assert.ok(internalTrigger);
  await database.client.query(`ALTER TABLE "AccessSchedules" DISABLE TRIGGER ${q(internalTrigger)}`);
  await assert.rejects(database.preflight(), /schema differs from its verified creation state/);
  await database.client.query(`ALTER TABLE "AccessSchedules" ENABLE TRIGGER ${q(internalTrigger)}`);
  await database.preflight();
});

test('real PostgreSQL reverse migration requires its bound native origin metadata', postgresOptions, async (t) => {
  const schema = uniqueSchema('origin');
  const databases = [];
  const target = new SqliteDatabase(':memory:', { create: true });
  t.after(() => target.close());
  t.after(() => closeAndDrop(databases, [schema]));

  const source = await PostgresDatabase.open({ connectionString, schema, create: true });
  databases.push(source);
  await assert.rejects(transferDatabase(source, target), /has no instance binding/u);
  assert.ok((await databaseDigest(target)).every(table => table.rows === 0));

  await source.writeInstanceBinding(instanceBinding);
  await assert.rejects(transferDatabase(source, target), /has no verified Jellyfin SQLite interchange origin/u);
  assert.ok((await databaseDigest(target)).every(table => table.rows === 0));
});

test('real PostgreSQL transfer saves bindings transactionally and preserves conflicting targets', postgresOptions, async (t) => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const targetSchema = uniqueSchema('target');
  const conflictSchema = uniqueSchema('conflict');
  const databases = [];
  t.after(() => source.close());
  t.after(() => closeAndDrop(databases, [targetSchema, conflictSchema]));
  seedAllTables(source);

  const target = await PostgresDatabase.open({ connectionString, schema: targetSchema, create: true });
  databases.push(target);
  const query = target.client.query.bind(target.client);
  let loseBeginAcknowledgement = true;
  let rejectDeferredConstraints = true;
  target.client.query = async (...args) => {
    if (loseBeginAcknowledgement && args[0] === 'BEGIN ISOLATION LEVEL REPEATABLE READ') {
      loseBeginAcknowledgement = false;
      await query(...args);
      throw new Error('injected lost PostgreSQL BEGIN acknowledgement');
    }
    if (rejectDeferredConstraints && args[0] === 'SET CONSTRAINTS ALL DEFERRED') {
      rejectDeferredConstraints = false;
      throw new Error('injected failure after PostgreSQL BEGIN');
    }
    return query(...args);
  };
  await assert.rejects(
    transferDatabase(source, target, { instanceBinding }),
    /lost PostgreSQL BEGIN acknowledgement/
  );
  assert.equal(target.inTransaction, false);
  assert.equal((await target.client.query('SELECT 1 AS value')).rows[0].value, 1);
  assert.equal(await target.readInstanceBinding(), null);
  assert.equal(await target.readTransferReceipt(), null);
  assert.ok((await databaseDigest(target)).every((table) => table.rows === 0));

  await assert.rejects(
    transferDatabase(source, target, { instanceBinding }),
    /injected failure after PostgreSQL BEGIN/
  );
  assert.equal(target.inTransaction, false);
  assert.equal((await target.client.query('SELECT 1 AS value')).rows[0].value, 1);
  assert.equal(await target.readInstanceBinding(), null);
  assert.equal(await target.readTransferReceipt(), null);
  assert.ok((await databaseDigest(target)).every((table) => table.rows === 0));

  const writeInstanceBinding = target.writeInstanceBinding.bind(target);
  const transactionMarkers = [];

  target.writeInstanceBinding = async (binding) => {
    transactionMarkers.push({
      root: target.inTransaction,
      session: target.operationContext.getStore()?.inTransaction,
    });
    await writeInstanceBinding(binding);
    throw new Error('injected failure after instance binding write');
  };
  await assert.rejects(
    transferDatabase(source, target, { instanceBinding }),
    /injected failure after instance binding write/
  );
  assert.equal(target.inTransaction, false);
  assert.equal(await target.readInstanceBinding(), null);
  assert.equal(await target.getState('nativeEnvelope'), undefined);
  assert.equal(await target.readTransferReceipt(), null);
  assert.ok((await databaseDigest(target)).every((table) => table.rows === 0));

  target.writeInstanceBinding = async (binding) => {
    transactionMarkers.push({
      root: target.inTransaction,
      session: target.operationContext.getStore()?.inTransaction,
    });
    return writeInstanceBinding(binding);
  };
  await transferDatabase(source, target, { instanceBinding });
  assert.deepEqual(transactionMarkers, [
    { root: false, session: true },
    { root: false, session: true },
  ]);
  assert.equal(target.inTransaction, false);
  assert.deepEqual(await target.readInstanceBinding(), instanceBinding);
  assert.ok(await target.readTransferReceipt());
  assert.deepEqual(await databaseDigest(target), await databaseDigest(source));

  const sameSchema = await PostgresDatabase.open({ connectionString, schema: targetSchema });
  databases.push(sameSchema);
  await assert.rejects(
    transferDatabase(target, sameSchema),
    /must not address the same database schema/
  );
  assert.equal(target.inTransaction, false);
  assert.equal(sameSchema.inTransaction, false);

  const conflict = await PostgresDatabase.open({ connectionString, schema: conflictSchema, create: true });
  databases.push(conflict);
  await conflict.writeInstanceBinding(differentBinding);
  await assert.rejects(
    transferDatabase(source, conflict, { instanceBinding }),
    /migration target has a different instance binding/
  );
  assert.equal(conflict.inTransaction, false);
  assert.deepEqual(await conflict.readInstanceBinding(), differentBinding);
  assert.equal(await conflict.getState('nativeEnvelope'), undefined);
  assert.equal(await conflict.readTransferReceipt(), null);
  assert.ok((await databaseDigest(conflict)).every((table) => table.rows === 0));
});

test('real PostgreSQL transfer resumes after a lost COMMIT acknowledgement only for the exact receipt', postgresOptions, async (t) => {
  const source = new SqliteDatabase(':memory:', { create: true });
  const schema = uniqueSchema('receipt');
  const databases = [];
  t.after(() => source.close());
  t.after(() => closeAndDrop(databases, [schema]));
  seedAllTables(source);

  let target = await PostgresDatabase.open({ connectionString, schema, create: true });
  databases.push(target);
  const query = target.client.query.bind(target.client);
  let loseCommitAcknowledgement = true;
  target.client.query = async (...args) => {
    if (loseCommitAcknowledgement && args[0] === 'COMMIT') {
      loseCommitAcknowledgement = false;
      await query(...args);
      throw new Error('injected lost PostgreSQL COMMIT acknowledgement');
    }
    return query(...args);
  };

  await assert.rejects(
    transferDatabase(source, target, { instanceBinding }),
    /lost PostgreSQL COMMIT acknowledgement/iu
  );
  assert.ok(await target.readTransferReceipt());
  assert.deepEqual(await databaseDigest(target), await databaseDigest(source));

  await target.close();
  databases.splice(databases.indexOf(target), 1);
  target = await PostgresDatabase.open({ connectionString, schema });
  databases.push(target);
  const resumed = await transferDatabase(source, target, { instanceBinding });
  assert.equal(resumed.verified, true);
  assert.deepEqual(resumed.tables, await databaseDigest(source));

  const user = (await source.rows('Users'))[0];
  source.update('Users', { Id: user.Id }, { Username: `${user.Username}-changed` });
  await assert.rejects(
    transferDatabase(source, target, { instanceBinding }),
    /different transfer receipt/iu
  );
});
