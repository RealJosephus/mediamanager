import { postgresColumnType } from './native-text-sql.js';
import { isServerIdentity } from '../core/server-identity.js';
import { nativeTextFunctionStatements, nativeTextFunctionsSha256, assertNativeTextFunctionDefinitions } from './native-text-functions.js';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeModel, postgresStorageModel, quoteIdentifier as q, tableDefinition, columnDefinition, createTableSql, createIndexSql, dependencyOrder } from './model.js';
import { parseNativeEnvelope, serializeNativeEnvelope } from './native-envelope.js';
import { encodeValue, decodeValue, encodeValueSet } from './values.js';
import { postgresRelationOrderStatements,
  scanNativeRelationRows, verifyPostgresRelationOrder } from './native-relation-order.js';
import {
  createPostgresRuntimeFunctionSql,
  createPostgresRuntimeIndexSql,
  postgresRuntimeFunctions,
  postgresRuntimeIndexes,
  postgresRuntimeSchemaFingerprint,
  postgresRuntimeSchemaFingerprintKey,
  withoutPostgresRuntimeIndexes,
} from './postgres-runtime-schema.js';

// Explicit parsers avoid the pg driver's Date conversion and process-global type overrides.
const types = { getTypeParser(oid, format) { return oid === 20 ? (value) => BigInt(value) : pg.types.getTypeParser(oid, format); } };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textHash = (value) => createHash('sha256').update(value).digest('hex');
export function postgresIdentifier(value) { return Buffer.byteLength(value) <= 63 ? value : `${value.slice(0, 46)}_${hash(value).slice(0, 16)}`; }
const shortenDdl = (sql) => sql.replace(/(?:CONSTRAINT|INDEX) "([^"]+)"/g, (match, name) => match.replace(q(name), q(postgresIdentifier(name))));
const modelHash = hash({ model: postgresStorageModel, nativeTextFunctionsSha256 });
const sha256Pattern = /^[a-f0-9]{64}$/u;
const transactionControlStatementPattern = /^(?:BEGIN\b|START\s+TRANSACTION\b|COMMIT\b|END\b|ROLLBACK\b|ABORT\b|SAVEPOINT\b|RELEASE(?:\s+SAVEPOINT)?\b|PREPARE\s+TRANSACTION\b|SET\s+(?:LOCAL\s+)?TRANSACTION\b|SET\s+SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION\b)/iu;

// node-postgres can execute multiple statements in one query string. Inspect
// each top-level statement while ignoring comments and quoted bodies; a plain
// word search would mistake CASE ... END and function bodies for COMMIT aliases.
function hasTransactionControlWithStringMode(sql, backslashEscapes) {
  const statements = [''];
  let blockDepth = 0;
  for (let position = 0; position < sql.length;) {
    const current = sql[position], next = sql[position + 1];
    if (blockDepth > 0) {
      if (current === '/' && next === '*') { blockDepth++; position += 2; }
      else if (current === '*' && next === '/') { blockDepth--; position += 2; }
      else position++;
      continue;
    }
    if (current === '-' && next === '-') {
      position = sql.indexOf('\n', position + 2);
      if (position < 0) break;
      statements[statements.length - 1] += ' ';
      continue;
    }
    if (current === '/' && next === '*') { blockDepth = 1; position += 2; continue; }
    if (current === "'") {
      position++;
      while (position < sql.length) {
        if (backslashEscapes && sql[position] === '\\') { position += 2; continue; }
        if (sql[position] !== "'") { position++; continue; }
        if (sql[position + 1] === "'") { position += 2; continue; }
        position++;
        break;
      }
      statements[statements.length - 1] += ' ';
      continue;
    }
    if (current === '"') {
      position++;
      while (position < sql.length) {
        if (sql[position] !== '"') { position++; continue; }
        if (sql[position + 1] === '"') { position += 2; continue; }
        position++;
        break;
      }
      statements[statements.length - 1] += ' ';
      continue;
    }
    if (current === '$') {
      // PostgreSQL treats a dollar-quote tag immediately following an
      // unquoted identifier as part of that identifier, not as a string
      // delimiter. Mirroring that boundary prevents an identifier such as
      // x$tag$ from hiding a later top-level statement from this scanner.
      const precededByIdentifier = position > 0 && /[A-Za-z0-9_$\u0080-\uFFFF]/u.test(sql[position - 1]);
      const tag = precededByIdentifier ? undefined
        : /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(position))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, position + tag.length);
        position = end < 0 ? sql.length : end + tag.length;
        statements[statements.length - 1] += ' ';
        continue;
      }
    }
    if (current === ';') statements.push('');
    else statements[statements.length - 1] += current;
    position++;
  }
  return statements.some(statement => transactionControlStatementPattern.test(statement.trimStart()));
}
function hasTransactionControl(sql) {
  // standard_conforming_strings is a session setting and may be supplied by a
  // connection URL. Scan both PostgreSQL interpretations so a backslash just
  // before a quote cannot hide a following top-level COMMIT from this pooled
  // root boundary. A conservative false positive is preferable to allowing
  // transaction control to escape database.transaction().
  return hasTransactionControlWithStringMode(sql, false)
    || hasTransactionControlWithStringMode(sql, true);
}
const queryText = query => typeof query === 'string' ? query : query?.text ?? '';
const closedClientMessage = 'Client was closed and is not queryable';
const schemaCreationOwners = new WeakSet();

class PoolClientFacade {
  constructor(database) {
    this.database = database;
    this.dispatchQuery = (...args) => this.database.dispatchPooledQuery(...args);
  }
  get query() { return this.dispatchQuery; }
  set query(hook) {
    if (typeof hook !== 'function') throw new TypeError('PostgreSQL query hook must be a function');
    this.database.queryHook = hook === this.dispatchQuery ? null : hook;
  }
  get host() { return this.database.pool.options?.host ?? null; }
  get port() { return this.database.pool.options?.port ?? null; }
}

class OperationClientFacade {
  constructor(database, client) {
    this.database = database;
    this.physicalClient = client;
    this.queryOverride = null;
    this.discardedError = null;
    this.dispatchQuery = (...args) => {
      if (this.discardedError) return Promise.reject(this.discardedError);
      return this.database.dispatchOperationQuery(this.physicalClient, ...args);
    };
  }
  get query() { return this.queryOverride ?? this.dispatchQuery; }
  set query(query) {
    if (typeof query !== 'function') throw new TypeError('PostgreSQL session query must be a function');
    this.queryOverride = query === this.dispatchQuery ? null : query;
  }
  get id() { return this.physicalClient.id; }
  get host() { return this.physicalClient.host ?? null; }
  get port() { return this.physicalClient.port ?? null; }
}

export function canonicalInstanceBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Instance binding must be a plain object');
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'originIdentityDigest,serverId') {
    throw new TypeError('Instance binding must contain exactly serverId and originIdentityDigest');
  }
  if (!isServerIdentity(value.serverId)) {
    throw new TypeError('Instance binding serverId must be a valid native server identity');
  }
  if (typeof value.originIdentityDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.originIdentityDigest)) {
    throw new TypeError('Instance binding originIdentityDigest must be 64 lowercase hexadecimal characters');
  }
  return {
    serverId: value.serverId,
    originIdentityDigest: value.originIdentityDigest
  };
}

export function canonicalTransferReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Transfer receipt must be a plain object');
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'instanceBinding,nativeEnvelopeSha256,portableMountContractSha256,sourceIdentitySha256,sourceTables,targetIdentitySha256') {
    throw new TypeError('Transfer receipt has invalid fields');
  }
  for (const key of ['nativeEnvelopeSha256', 'sourceIdentitySha256', 'targetIdentitySha256']) {
    if (typeof value[key] !== 'string' || !sha256Pattern.test(value[key])) {
      throw new TypeError(`Transfer receipt ${key} must be a SHA-256 digest`);
    }
  }
  if (value.portableMountContractSha256 !== null
    && (typeof value.portableMountContractSha256 !== 'string'
      || !sha256Pattern.test(value.portableMountContractSha256))) {
    throw new TypeError('Transfer receipt portableMountContractSha256 must be null or a SHA-256 digest');
  }
  if (!Array.isArray(value.sourceTables) || value.sourceTables.length !== nativeModel.tables.length) {
    throw new TypeError('Transfer receipt must contain every source table digest');
  }
  const sourceTables = value.sourceTables.map((table, index) => {
    if (!table || typeof table !== 'object' || Array.isArray(table)
      || Object.keys(table).sort().join(',') !== 'name,rows,sha256'
      || table.name !== nativeModel.tables[index].name
      || !Number.isSafeInteger(table.rows) || table.rows < 0
      || typeof table.sha256 !== 'string' || !sha256Pattern.test(table.sha256)) {
      throw new TypeError('Transfer receipt contains an invalid source table digest');
    }
    return { name: table.name, rows: table.rows, sha256: table.sha256 };
  });
  const instanceBinding = value.instanceBinding === null ? null : canonicalInstanceBinding(value.instanceBinding);
  return {
    sourceTables,
    nativeEnvelopeSha256: value.nativeEnvelopeSha256,
    portableMountContractSha256: value.portableMountContractSha256,
    instanceBinding,
    sourceIdentitySha256: value.sourceIdentitySha256,
    targetIdentitySha256: value.targetIdentitySha256
  };
}

export class PostgresDatabase {
  constructor(pool, schema, { client, root } = {}) {
    this.pool = pool;
    this.schemaName = schema;
    this.controlSchema = `${schema}__mm`;
    this.dialect = 'postgres';
    this.inTransaction = false;
    this.connectionSession = Boolean(client);
    this.connectionActive = Boolean(client);
    this.connectionReleaseError = null;
    this.root = root ?? this;
    this.client = client ?? new PoolClientFacade(this);
    if (!client) {
      this.operationContext = new AsyncLocalStorage();
      this.queryHookContext = new AsyncLocalStorage();
      this.queryHook = null;
      this.closed = false;
      this.closePromise = null;
    }
  }

  static async open({
    connectionString,
    schema,
    create = false,
    max = 10,
    connectionTimeoutMillis = 10_000,
    idleTimeoutMillis = 30_000,
    runtimeSchemaLockTimeoutMillis = 30_000,
    deferRuntimeSchemaInitialization = false
  }) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(schema ?? '')) throw new Error('An explicit schema of at most 40 ASCII characters is required');
    if (!Number.isSafeInteger(max) || max < 1) throw new TypeError('max must be a positive integer');
    for (const [name, value] of Object.entries({ connectionTimeoutMillis, idleTimeoutMillis })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
    }
    if (!Number.isSafeInteger(runtimeSchemaLockTimeoutMillis) || runtimeSchemaLockTimeoutMillis < 1) {
      throw new TypeError('runtimeSchemaLockTimeoutMillis must be a positive integer');
    }
    if (typeof deferRuntimeSchemaInitialization !== 'boolean') {
      throw new TypeError('deferRuntimeSchemaInitialization must be a boolean');
    }
    const pool = new pg.Pool({ connectionString, types, max, connectionTimeoutMillis, idleTimeoutMillis });
    const database = new PostgresDatabase(pool, schema);
    try {
      if (create) {
        await database.initialize();
        schemaCreationOwners.add(database);
      }
      await database.preflight();
      if (!deferRuntimeSchemaInitialization) {
        await database.initializeRuntimeSchema({ lockTimeoutMs: runtimeSchemaLockTimeoutMillis });
      }
      return database;
    } catch (error) {
      const cleanupErrors = [];
      if (schemaCreationOwners.has(database)) {
        try { await database.dropSchemasCreatedByThisOpen(); }
        catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      try { await pool.end(); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
      if (cleanupErrors.length) {
        throw new AggregateError([error, ...cleanupErrors],
          'PostgreSQL open failed and its newly created schemas could not be cleaned up completely', { cause: error });
      }
      throw error;
    }
  }

  /** Drop only schemas atomically created by this object's successful create-open. */
  async dropSchemasCreatedByThisOpen() {
    if (this.connectionSession) throw new Error('A PostgreSQL operation session does not own schemas');
    if (!schemaCreationOwners.has(this)) {
      throw new Error('PostgreSQL schemas are not owned by this database open');
    }
    await this.withConnection(async database => {
      await database.client.query('BEGIN');
      try {
        await database.client.query(`DROP SCHEMA ${q(this.schemaName)}, ${q(this.controlSchema)} CASCADE`);
        await database.client.query('COMMIT');
      } catch (error) {
        try { await database.client.query('ROLLBACK'); }
        catch (rollbackError) {
          database.discardConnection(rollbackError);
          throw new AggregateError([error, rollbackError],
            'PostgreSQL schema cleanup and rollback both failed', { cause: error });
        }
        throw error;
      }
    });
    schemaCreationOwners.delete(this);
  }

  operationSession(client) {
    const sessionClient = new OperationClientFacade(this.root, client);
    const session = new PostgresDatabase(this.pool, this.schemaName, { client: sessionClient, root: this.root });
    for (const name of Object.getOwnPropertyNames(this.root)) {
      if (name === 'constructor' || typeof this.root[name] !== 'function' || typeof session[name] !== 'function') continue;
      session[name] = (...args) => this.root[name](...args);
    }
    return session;
  }

  discardConnection(error) {
    if (!this.connectionSession) throw new Error('Only a PostgreSQL operation session can discard its connection');
    this.connectionReleaseError = error instanceof Error ? error : new Error(String(error));
    this.client.discardedError ??= new Error('PostgreSQL operation connection was discarded', {
      cause: this.connectionReleaseError,
    });
  }

  dispatchPooledQuery(...args) {
    const root = this.root;
    const hook = root.queryHook;
    if (root.queryHookContext.getStore()) {
      const activeSession = root.operationContext.getStore();
      if (activeSession?.connectionActive) return activeSession.client.query(...args);
      return root.pooledQuery(...args);
    }
    if (!hook) return root.pooledQuery(...args);
    return root.queryHookContext.run(true, () => hook.call(root.client, ...args));
  }

  dispatchOperationQuery(client, ...args) {
    const root = this.root;
    const hook = root.queryHook;
    if (!hook || root.queryHookContext.getStore()) return client.query(...args);
    return root.queryHookContext.run(true, () => hook.call(root.client, ...args));
  }

  async configureConnection(client) {
    await client.query(`SET search_path TO ${q(this.schemaName)}, pg_catalog`);
  }

  async withConnection(operation) {
    if (typeof operation !== 'function') throw new TypeError('A PostgreSQL connection operation is required');
    if (this.connectionSession) return operation(this);
    if (this.closed) throw new Error(closedClientMessage);
    const activeSession = this.operationContext.getStore();
    if (activeSession?.connectionActive) return operation(activeSession);
    const client = await this.pool.connect();
    let setupError;
    let session;
    try {
      if (this.closed) throw new Error(closedClientMessage);
      try { await this.configureConnection(client); }
      catch (error) { setupError = error; throw error; }
      session = this.operationSession(client);
      try { return await this.operationContext.run(session, () => operation(session)); }
      finally { session.connectionActive = false; }
    } finally { client.release(setupError ?? session?.connectionReleaseError ?? undefined); }
  }

  async pooledQuery(...args) {
    if (this.connectionSession) return this.client.query(...args);
    if (this.closed) throw new Error(closedClientMessage);
    const sql = queryText(args[0]);
    if (hasTransactionControl(sql)) {
      throw new Error('PostgreSQL transaction control requires database.transaction()');
    }
    return this.withConnection(session => session.client.query(...args));
  }
  async initialize() {
    if (!this.connectionSession) return this.withConnection(database => database.initialize());
    await this.client.query('BEGIN');
    try {
      await this.client.query(`CREATE SCHEMA ${q(this.schemaName)}`);
      await this.client.query(`CREATE SCHEMA ${q(this.controlSchema)}`);
      await this.client.query(`SET LOCAL search_path TO ${q(this.schemaName)}, pg_catalog`);
      await this.client.query(nativeTextFunctionStatements(this.schemaName));
      for (const table of dependencyOrder()) {
        const sql = createTableSql(table, 'postgres').replace(/ text(?= |,|\n|\))/g, ' text COLLATE "C"');
        await this.client.query(shortenDdl(sql));
      }
      for (const table of nativeModel.tables) for (const index of table.indices) await this.client.query(shortenDdl(createIndexSql(table, index, 'postgres', { schema: this.schemaName })));
      await this.client.query(`CREATE TABLE ${q(this.controlSchema)}.state (key text PRIMARY KEY, value text NOT NULL)`);
      for (const sql of postgresRelationOrderStatements(this.schemaName, this.controlSchema)) await this.client.query(sql);
      await this.setState('modelHash', modelHash);
      await this.setState('schemaFingerprint', hash(await this.inspectSchema()));
      await this.setState('controlSchemaFingerprint', hash(await this.inspectControlSchema()));
      await this.client.query('COMMIT');
    } catch (error) {
      try { await this.client.query('ROLLBACK'); }
      catch (rollbackError) {
        this.discardConnection(rollbackError);
        throw new AggregateError([error, rollbackError], error.message, { cause: error });
      }
      throw error;
    }
  }
  async setState(key, value) {
    if (key === 'instanceBinding') throw new Error('The PostgreSQL instance binding is write-once; use writeInstanceBinding');
    if (key === 'nativeEnvelope') throw new Error('The PostgreSQL native envelope is write-once; use writeNativeEnvelope');
    if (key === 'transferReceipt') throw new Error('The PostgreSQL transfer receipt is write-once; use writeTransferReceipt');
    await this.client.query(`INSERT INTO ${q(this.controlSchema)}.state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
  }
  async getState(key) { return (await this.client.query(`SELECT value FROM ${q(this.controlSchema)}.state WHERE key = $1`, [key])).rows[0]?.value; }
  async readInstanceBinding() {
    const value = await this.getState('instanceBinding');
    if (value === undefined) return null;
    let parsed;
    try { parsed = JSON.parse(value); }
    catch { throw new Error('Stored PostgreSQL instance binding is not valid JSON'); }
    try { return canonicalInstanceBinding(parsed); }
    catch (error) { throw new Error(`Stored PostgreSQL instance binding is invalid: ${error.message}`, { cause: error }); }
  }
  async writeInstanceBinding(binding) {
    const canonical = canonicalInstanceBinding(binding);
    await this.client.query(`INSERT INTO ${q(this.controlSchema)}.state (key, value) VALUES ('instanceBinding', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(canonical)]);
    return this.validateInstanceBinding(canonical);
  }
  async validateInstanceBinding(expected) {
    const canonical = canonicalInstanceBinding(expected);
    const actual = await this.readInstanceBinding();
    if (!actual) throw new Error('PostgreSQL instance binding is missing');
    if (JSON.stringify(actual) !== JSON.stringify(canonical)) throw new Error('PostgreSQL instance binding differs');
    return actual;
  }
  async readNativeEnvelope() {
    const value = await this.getState('nativeEnvelope');
    if (value === undefined) return null;
    try { return parseNativeEnvelope(value); }
    catch (error) { throw new Error(`Stored PostgreSQL native envelope is invalid: ${error.message}`, { cause: error }); }
  }
  async writeNativeEnvelope(envelope) {
    const serialized = serializeNativeEnvelope(envelope);
    await this.client.query(`INSERT INTO ${q(this.controlSchema)}.state (key, value) VALUES ('nativeEnvelope', $1) ON CONFLICT (key) DO NOTHING`, [serialized]);
    const actual = await this.getState('nativeEnvelope');
    if (actual !== serialized) {
      if (actual !== undefined) await this.readNativeEnvelope();
      throw new Error('PostgreSQL native envelope differs');
    }
    return parseNativeEnvelope(actual);
  }
  async readTransferReceipt() {
    const value = await this.getState('transferReceipt');
    if (value === undefined) return null;
    let parsed;
    try { parsed = JSON.parse(value); }
    catch { throw new Error('Stored PostgreSQL transfer receipt is not valid JSON'); }
    try { return canonicalTransferReceipt(parsed); }
    catch (error) { throw new Error(`Stored PostgreSQL transfer receipt is invalid: ${error.message}`, { cause: error }); }
  }
  async writeTransferReceipt(receipt) {
    if (!this.inTransaction) throw new Error('The PostgreSQL transfer receipt requires an active migration transaction');
    const canonical = canonicalTransferReceipt(receipt);
    const serialized = JSON.stringify(canonical);
    await this.client.query(`INSERT INTO ${q(this.controlSchema)}.state (key, value) VALUES ('transferReceipt', $1) ON CONFLICT (key) DO NOTHING`, [serialized]);
    const actual = await this.getState('transferReceipt');
    if (actual !== serialized) {
      if (actual !== undefined) await this.readTransferReceipt();
      throw new Error('PostgreSQL transfer receipt differs');
    }
    return canonicalTransferReceipt(JSON.parse(actual));
  }
  async databaseIdentity() {
    const { rows } = await this.client.query(`SELECT d.datname AS database_name, d.oid::text AS database_oid,
      inet_server_addr()::text AS server_address, inet_server_port() AS server_port
      FROM pg_database d WHERE d.datname = current_database()`);
    const value = rows[0];
    if (!value) throw new Error('PostgreSQL database identity is unavailable');
    return {
      database: value.database_name,
      databaseOid: value.database_oid,
      serverAddress: value.server_address ?? this.client.host ?? null,
      serverPort: value.server_port ?? this.client.port ?? null,
    };
  }
  async inspectSchema(schemaName = this.schemaName) {
    if (!this.connectionSession) return this.withConnection(database => database.inspectSchema(schemaName));
    const namespaces = (await this.client.query(`SELECT n.nspname,
      pg_catalog.pg_get_userbyid(n.nspowner) AS owner, n.nspacl AS privileges,
      pg_catalog.has_schema_privilege(n.oid, 'USAGE') AS usable,
      pg_catalog.has_schema_privilege(n.oid, 'CREATE') AS creatable
      FROM pg_catalog.pg_namespace n WHERE n.nspname = $1`, [schemaName])).rows;
    const defaultPrivileges = (await this.client.query(`SELECT
      pg_catalog.pg_get_userbyid(d.defaclrole) AS owner,
      namespace.nspname AS schema_name, d.defaclobjtype AS object_type, d.defaclacl AS privileges
      FROM pg_catalog.pg_default_acl d
      JOIN pg_catalog.pg_namespace target ON target.nspname = $1
      LEFT JOIN pg_catalog.pg_namespace namespace ON namespace.oid = d.defaclnamespace
      WHERE d.defaclrole = target.nspowner
        AND (d.defaclnamespace = 0 OR d.defaclnamespace = target.oid)
      ORDER BY namespace.nspname COLLATE pg_catalog."C" NULLS FIRST,
        d.defaclobjtype::text COLLATE pg_catalog."C"`, [schemaName])).rows;
    const columns = (await this.client.query(`SELECT c.table_name, c.column_name, c.ordinal_position,
      c.data_type, c.is_nullable, c.column_default, c.is_identity, c.identity_generation,
      c.is_generated, c.generation_expression, c.collation_name, attribute.attacl AS privileges
      FROM information_schema.columns c
      JOIN pg_catalog.pg_namespace namespace ON namespace.nspname = c.table_schema
      JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid
        AND relation.relname = c.table_name
      JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
        AND attribute.attname = c.column_name AND NOT attribute.attisdropped
      WHERE c.table_schema = $1
      ORDER BY c.table_name COLLATE pg_catalog."C", c.ordinal_position`, [schemaName])).rows;
    const constraints = (await this.client.query(`SELECT relation.relname AS table_name,
      constraint_definition.conname, constraint_definition.contype,
      pg_catalog.pg_get_constraintdef(constraint_definition.oid) AS definition
      FROM pg_catalog.pg_constraint constraint_definition
      JOIN pg_catalog.pg_class relation ON relation.oid = constraint_definition.conrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
      ORDER BY relation.relname COLLATE pg_catalog."C",
        constraint_definition.conname COLLATE pg_catalog."C"`, [schemaName])).rows;
    const indices = (await this.client.query(`SELECT tablename, indexname, indexdef
      FROM pg_catalog.pg_indexes WHERE schemaname = $1
      ORDER BY tablename COLLATE pg_catalog."C", indexname COLLATE pg_catalog."C"`, [schemaName])).rows;
    const indexState = (await this.client.query(`SELECT table_relation.relname AS table_name,
      index_relation.relname AS index_name, index_definition.indisunique, index_definition.indisprimary,
      index_definition.indisexclusion, index_definition.indimmediate, index_definition.indisclustered,
      index_definition.indisvalid, index_definition.indcheckxmin, index_definition.indisready,
      index_definition.indislive, index_definition.indisreplident
      FROM pg_catalog.pg_index index_definition
      JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_definition.indexrelid
      JOIN pg_catalog.pg_class table_relation ON table_relation.oid = index_definition.indrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_relation.relnamespace
      WHERE namespace.nspname = $1
      ORDER BY table_relation.relname COLLATE pg_catalog."C",
        index_relation.relname COLLATE pg_catalog."C"`, [schemaName])).rows;
    const relations = (await this.client.query(`SELECT relation.relname, relation.relkind,
      relation.relpersistence, relation.relreplident, relation.relispartition, relation.relispopulated,
      relation.reloptions, pg_catalog.pg_get_userbyid(relation.relowner) AS owner,
      relation.relacl AS privileges, tablespace.spcname AS tablespace,
      access_method.amname AS access_method
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_catalog.pg_tablespace tablespace ON tablespace.oid = relation.reltablespace
      LEFT JOIN pg_catalog.pg_am access_method ON access_method.oid = relation.relam
      WHERE namespace.nspname = $1
      ORDER BY relation.relname COLLATE pg_catalog."C"`, [schemaName])).rows;
    const rules = (await this.client.query(`SELECT relation.relname, rule.rulename, rule.ev_enabled,
      rule.is_instead, pg_catalog.pg_get_ruledef(rule.oid) AS definition
      FROM pg_catalog.pg_rewrite rule
      JOIN pg_catalog.pg_class relation ON relation.oid = rule.ev_class
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
      ORDER BY relation.relname COLLATE pg_catalog."C", rule.rulename COLLATE pg_catalog."C"`, [schemaName])).rows;
    const inheritance = (await this.client.query(`SELECT child.relname AS child_name,
      parent_namespace.nspname AS parent_schema, parent.relname AS parent_name, inheritance.inhseqno
      FROM pg_catalog.pg_inherits inheritance
      JOIN pg_catalog.pg_class child ON child.oid = inheritance.inhrelid
      JOIN pg_catalog.pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
      JOIN pg_catalog.pg_class parent ON parent.oid = inheritance.inhparent
      JOIN pg_catalog.pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
      WHERE child_namespace.nspname = $1 OR parent_namespace.nspname = $1
      ORDER BY child_namespace.nspname COLLATE pg_catalog."C", child.relname COLLATE pg_catalog."C",
        inheritance.inhseqno, parent_namespace.nspname COLLATE pg_catalog."C",
        parent.relname COLLATE pg_catalog."C"`, [schemaName])).rows;
    const sequences = (await this.client.query(`SELECT sequencename, data_type, start_value::text,
      min_value::text, max_value::text, increment_by::text, cycle, cache_size::text
      FROM pg_catalog.pg_sequences WHERE schemaname = $1
      ORDER BY sequencename COLLATE pg_catalog."C"`, [schemaName])).rows;
    const sequenceOwnership = (await this.client.query(`SELECT sequence.relname AS sequence_name,
      dependency.deptype, owner_namespace.nspname AS owner_schema, owner.relname AS owner_table,
      attribute.attname AS owner_column
      FROM pg_catalog.pg_class sequence
      JOIN pg_catalog.pg_namespace sequence_namespace ON sequence_namespace.oid = sequence.relnamespace
      LEFT JOIN pg_catalog.pg_depend dependency
        ON dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND dependency.objid = sequence.oid
        AND dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND dependency.deptype IN ('a', 'i')
      LEFT JOIN pg_catalog.pg_class owner ON owner.oid = dependency.refobjid
      LEFT JOIN pg_catalog.pg_namespace owner_namespace ON owner_namespace.oid = owner.relnamespace
      LEFT JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = dependency.refobjid
        AND attribute.attnum = dependency.refobjsubid
      WHERE sequence_namespace.nspname = $1 AND sequence.relkind = 'S'
      ORDER BY sequence.relname COLLATE pg_catalog."C",
        dependency.deptype::text COLLATE pg_catalog."C",
        owner_namespace.nspname COLLATE pg_catalog."C", owner.relname COLLATE pg_catalog."C",
        attribute.attname COLLATE pg_catalog."C"`, [schemaName])).rows;
    const rowSecurity = (await this.client.query(`SELECT relation.relname, relation.relrowsecurity,
      relation.relforcerowsecurity
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND relation.relkind IN ('r', 'p')
      ORDER BY relation.relname COLLATE pg_catalog."C"`, [schemaName])).rows;
    const policies = (await this.client.query(`SELECT tablename, policyname, permissive,
      roles::text, cmd, qual, with_check FROM pg_catalog.pg_policies WHERE schemaname = $1
      ORDER BY tablename COLLATE pg_catalog."C", policyname COLLATE pg_catalog."C"`, [schemaName])).rows;
    const triggers = (await this.client.query(`SELECT relation.relname, trigger_definition.tgname,
      trigger_definition.tgisinternal, trigger_definition.tgenabled,
      pg_catalog.pg_get_triggerdef(trigger_definition.oid) AS definition
      FROM pg_catalog.pg_trigger trigger_definition
      JOIN pg_catalog.pg_class relation ON relation.oid = trigger_definition.tgrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
      ORDER BY relation.relname COLLATE pg_catalog."C",
        trigger_definition.tgname COLLATE pg_catalog."C"`, [schemaName])).rows;
    const types = (await this.client.query(`SELECT type_definition.typname, type_definition.typlen,
      type_definition.typbyval, type_definition.typtype, type_definition.typcategory,
      type_definition.typispreferred, type_definition.typisdefined, type_definition.typdelim,
      type_definition.typtypmod, type_definition.typndims, type_definition.typnotnull,
      type_definition.typalign, type_definition.typstorage, type_definition.typdefault,
      relation.relname AS relation_name, element_namespace.nspname AS element_schema,
      element_type.typname AS element_name, base_namespace.nspname AS base_schema,
      base_type.typname AS base_name, collation_namespace.nspname AS collation_schema,
      collation_definition.collname AS collation_name,
      pg_catalog.pg_get_userbyid(type_definition.typowner) AS owner,
      type_definition.typacl AS privileges
      FROM pg_catalog.pg_type type_definition
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type_definition.typnamespace
      LEFT JOIN pg_catalog.pg_class relation ON relation.oid = type_definition.typrelid
      LEFT JOIN pg_catalog.pg_type element_type ON element_type.oid = type_definition.typelem
      LEFT JOIN pg_catalog.pg_namespace element_namespace ON element_namespace.oid = element_type.typnamespace
      LEFT JOIN pg_catalog.pg_type base_type ON base_type.oid = type_definition.typbasetype
      LEFT JOIN pg_catalog.pg_namespace base_namespace ON base_namespace.oid = base_type.typnamespace
      LEFT JOIN pg_catalog.pg_collation collation_definition
        ON collation_definition.oid = type_definition.typcollation
      LEFT JOIN pg_catalog.pg_namespace collation_namespace
        ON collation_namespace.oid = collation_definition.collnamespace
      WHERE namespace.nspname = $1
      ORDER BY type_definition.typname COLLATE pg_catalog."C"`, [schemaName])).rows;
    const typeConstraints = (await this.client.query(`SELECT type_definition.typname,
      constraint_definition.conname, constraint_definition.contype,
      pg_catalog.pg_get_constraintdef(constraint_definition.oid) AS definition
      FROM pg_catalog.pg_constraint constraint_definition
      JOIN pg_catalog.pg_type type_definition ON type_definition.oid = constraint_definition.contypid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type_definition.typnamespace
      WHERE namespace.nspname = $1
      ORDER BY type_definition.typname COLLATE pg_catalog."C",
        constraint_definition.conname COLLATE pg_catalog."C"`, [schemaName])).rows;
    const enumLabels = (await this.client.query(`SELECT type_definition.typname,
      enum_definition.enumsortorder::text AS sort_order, enum_definition.enumlabel
      FROM pg_catalog.pg_enum enum_definition
      JOIN pg_catalog.pg_type type_definition ON type_definition.oid = enum_definition.enumtypid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type_definition.typnamespace
      WHERE namespace.nspname = $1
      ORDER BY type_definition.typname COLLATE pg_catalog."C", enum_definition.enumsortorder`, [schemaName])).rows;
    const schemaObjects = (await this.client.query(`SELECT object_type, object_name, owner FROM (
      SELECT 'operator'::text AS object_type,
      object.oprname AS object_name, pg_catalog.pg_get_userbyid(object.oprowner) AS owner
      FROM pg_catalog.pg_operator object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.oprnamespace
      WHERE namespace.nspname = $1
      UNION ALL
      SELECT 'collation', object.collname, pg_catalog.pg_get_userbyid(object.collowner)
      FROM pg_catalog.pg_collation object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.collnamespace
      WHERE namespace.nspname = $1
      UNION ALL
      SELECT 'conversion', object.conname, pg_catalog.pg_get_userbyid(object.conowner)
      FROM pg_catalog.pg_conversion object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.connamespace
      WHERE namespace.nspname = $1
      UNION ALL
      SELECT 'operator class', object.opcname, pg_catalog.pg_get_userbyid(object.opcowner)
      FROM pg_catalog.pg_opclass object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.opcnamespace
      WHERE namespace.nspname = $1
      UNION ALL
      SELECT 'operator family', object.opfname, pg_catalog.pg_get_userbyid(object.opfowner)
      FROM pg_catalog.pg_opfamily object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.opfnamespace
      WHERE namespace.nspname = $1
      UNION ALL
      SELECT 'text search configuration', object.cfgname, pg_catalog.pg_get_userbyid(object.cfgowner)
      FROM pg_catalog.pg_ts_config object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.cfgnamespace
      WHERE namespace.nspname = $1
      UNION ALL
      SELECT 'text search dictionary', object.dictname, pg_catalog.pg_get_userbyid(object.dictowner)
      FROM pg_catalog.pg_ts_dict object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.dictnamespace
      WHERE namespace.nspname = $1
      UNION ALL
      SELECT 'text search parser', object.prsname, NULL::name
      FROM pg_catalog.pg_ts_parser object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.prsnamespace
      WHERE namespace.nspname = $1
      UNION ALL
      SELECT 'text search template', object.tmplname, NULL::name
      FROM pg_catalog.pg_ts_template object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.tmplnamespace
      WHERE namespace.nspname = $1
      UNION ALL
      SELECT 'extended statistics', object.stxname, pg_catalog.pg_get_userbyid(object.stxowner)
      FROM pg_catalog.pg_statistic_ext object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.stxnamespace
      WHERE namespace.nspname = $1
      UNION ALL
      SELECT 'extension', object.extname, pg_catalog.pg_get_userbyid(object.extowner)
      FROM pg_catalog.pg_extension object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.extnamespace
      WHERE namespace.nspname = $1
      ) schema_object
      ORDER BY object_type COLLATE pg_catalog."C", object_name COLLATE pg_catalog."C",
        owner COLLATE pg_catalog."C"`, [schemaName])).rows;
    const functions = (await this.client.query(`SELECT p.proname AS function_name,
      pg_catalog.oidvectortypes(p.proargtypes) AS input_types,
      pg_catalog.pg_get_function_result(p.oid) AS result_type,
      l.lanname AS language, p.provolatile AS volatility, p.proisstrict AS is_strict,
      p.prosecdef AS security_definer, p.proleakproof AS leakproof,
      p.proparallel AS parallel_safety, p.prokind AS kind,
      pg_catalog.pg_get_userbyid(p.proowner) AS owner,
      p.proacl AS privileges, pg_catalog.has_function_privilege(p.oid, 'EXECUTE') AS executable,
      p.proconfig AS configuration,
      p.prosrc AS source, pg_catalog.pg_get_functiondef(p.oid) AS definition
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
      WHERE n.nspname = $1
      ORDER BY p.proname COLLATE pg_catalog."C",
        pg_catalog.oidvectortypes(p.proargtypes) COLLATE pg_catalog."C"`, [schemaName])).rows;
    return {
      namespaces, defaultPrivileges, columns, constraints, indices, indexState, relations, rules,
      inheritance, sequences, sequenceOwnership, rowSecurity, policies, triggers, types,
      typeConstraints, enumLabels, schemaObjects, functions,
    };
  }
  async inspectControlSchema() { return this.inspectSchema(this.controlSchema); }
  async preflight() {
    if (!this.connectionSession) return this.withConnection(database => database.inTransaction
      ? database.preflight()
      : database.transaction(session => session.preflight(), {
        readOnly: true,
        isolation: 'repeatable-read',
      }));
    if (await this.getState('modelHash') !== modelHash) throw new Error('PostgreSQL model baseline differs');
    const schemaSnapshot = await this.inspectSchema();
    assertNativeTextFunctionDefinitions(schemaSnapshot, this.schemaName);
    if (await this.getState('schemaFingerprint') !== hash(withoutPostgresRuntimeIndexes(schemaSnapshot))) throw new Error('PostgreSQL schema differs from its verified creation state');
    if (await this.getState('controlSchemaFingerprint') !== hash(await this.inspectControlSchema())) throw new Error('PostgreSQL control schema differs from its verified creation state');
    await verifyPostgresRelationOrder(this);
    const expectedRuntimeFingerprint = await this.getState(postgresRuntimeSchemaFingerprintKey);
    if (expectedRuntimeFingerprint !== undefined) {
      if (expectedRuntimeFingerprint !== postgresRuntimeSchemaFingerprint(schemaSnapshot)) {
        throw new Error('PostgreSQL runtime schema differs from its verified initialization state');
      }
    }
    const binding = await this.readInstanceBinding();
    const envelope = await this.readNativeEnvelope();
    const receipt = await this.readTransferReceipt();
    if (receipt && (!envelope
      || JSON.stringify(receipt.instanceBinding) !== JSON.stringify(binding)
      || receipt.nativeEnvelopeSha256 !== textHash(serializeNativeEnvelope(envelope)))) {
      throw new Error('PostgreSQL transfer receipt differs from its bound origin metadata');
    }
    return true;
  }
  async initializeRuntimeSchema({ lockTimeoutMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
      throw new TypeError('lockTimeoutMs must be a positive integer');
    }
    if (!this.connectionSession) {
      return this.withConnection(database => database.initializeRuntimeSchema({ lockTimeoutMs }));
    }
    return this.transaction(async database => {
      await database.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `mediamanager:postgres-runtime-schema:${database.schemaName}`
      ]);
      const storedFingerprint = await database.getState(postgresRuntimeSchemaFingerprintKey);
      if (storedFingerprint !== undefined) {
        const actual = postgresRuntimeSchemaFingerprint(await database.inspectSchema());
        if (storedFingerprint !== actual) {
          throw new Error('PostgreSQL runtime schema differs from its verified initialization state');
        }
        return Object.freeze({ fingerprint: actual });
      }
      for (const definition of postgresRuntimeFunctions) {
        await database.client.query(createPostgresRuntimeFunctionSql(database.schemaName, definition));
      }
      for (const definition of postgresRuntimeIndexes) {
        await database.client.query(createPostgresRuntimeIndexSql(database.schemaName, definition));
      }
      const fingerprint = postgresRuntimeSchemaFingerprint(await database.inspectSchema());
      await database.setState(postgresRuntimeSchemaFingerprintKey, fingerprint);
      return Object.freeze({ fingerprint });
    }, { isolation: 'read-committed', lockTimeoutMs });
  }
  async transaction(callback, {
    readOnly = false,
    writeLockTables = [],
    isolation = 'repeatable-read',
    signal,
    lockRetryMs = 25,
    lockTimeoutMs
  } = {}) {
    if (!this.connectionSession) {
      if (this.inTransaction) throw new Error('Nested or concurrent transactions on this connection are not supported');
      return this.withConnection(database => database.transaction(callback, {
        readOnly, writeLockTables, isolation, signal, lockRetryMs, lockTimeoutMs
      }));
    }
    if (this.inTransaction) throw new Error('Nested or concurrent transactions on this connection are not supported');
    if (!Array.isArray(writeLockTables) || new Set(writeLockTables).size !== writeLockTables.length) {
      throw new TypeError('writeLockTables must contain unique table names');
    }
    const locked = writeLockTables.map(name => tableDefinition(name).name);
    if (readOnly && locked.length) throw new TypeError('A read-only transaction cannot request write locks');
    const isolationSql = { 'read-committed': 'READ COMMITTED', 'repeatable-read': 'REPEATABLE READ' }[isolation];
    if (!isolationSql) throw new TypeError('Unsupported transaction isolation level');
    if (!Number.isSafeInteger(lockRetryMs) || lockRetryMs < 1) throw new TypeError('lockRetryMs must be a positive integer');
    if (lockTimeoutMs !== undefined && (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1)) {
      throw new TypeError('lockTimeoutMs must be a positive integer');
    }
    const lockDeadline = lockTimeoutMs === undefined ? undefined : Date.now() + lockTimeoutMs;
    const tableLockTimeout = cause => {
      const error = new Error('PostgreSQL table lock timeout', { cause });
      error.code = '55P03';
      return error;
    };
    this.inTransaction = true;
    try {
      while (true) {
        signal?.throwIfAborted();
        if (lockDeadline !== undefined && Date.now() >= lockDeadline) throw tableLockTimeout();
        let began = true;
        let locking = false;
        try {
          await this.client.query(`BEGIN ISOLATION LEVEL ${isolationSql}${readOnly ? ' READ ONLY' : ''}`);
          if (lockDeadline !== undefined) {
            await this.client.query(`SET LOCAL lock_timeout = '${Math.max(1, lockDeadline - Date.now())}ms'`);
          }
          if (locked.length) {
            locking = true;
            await this.client.query(`LOCK TABLE ${locked.map(name => `${q(this.schemaName)}.${q(name)}`).join(', ')} IN EXCLUSIVE MODE NOWAIT`);
            locking = false;
          }
          const result = await callback(this);
          await this.client.query('COMMIT');
          began = false;
          return result;
        } catch (error) {
          if (began) {
            try { await this.client.query('ROLLBACK'); }
            catch (rollbackError) {
              this.discardConnection(rollbackError);
              throw new AggregateError([error, rollbackError], error.message, { cause: error });
            }
          }
          signal?.throwIfAborted();
          if (locking && error?.code === '55P03') {
            const remaining = lockDeadline === undefined ? lockRetryMs : lockDeadline - Date.now();
            if (remaining <= 0) throw tableLockTimeout(error);
            await delay(Math.min(lockRetryMs, remaining), undefined, { signal });
            continue;
          }
          throw error;
        }
      }
    } finally { this.inTransaction = false; }
  }
  relationRowsInInsertionOrder(name, options) { return scanNativeRelationRows(this, name, options); }
  async rows(name, { where = {}, whereIn = {}, whereAny = {}, whereNotNull = [], columns, orderBy, limit, offset = 0, after, consumer = 'runtime' } = {}) {
    const table = tableDefinition(name);
    if (!whereIn || typeof whereIn !== 'object' || Array.isArray(whereIn)) throw new TypeError('whereIn must be a column-to-array object');
    if (!whereAny || typeof whereAny !== 'object' || Array.isArray(whereAny)) throw new TypeError('whereAny must be a column-to-array object');
    if (!Array.isArray(whereNotNull) || new Set(whereNotNull).size !== whereNotNull.length) {
      throw new TypeError('whereNotNull must contain unique column names');
    }
    const selected = columns === undefined ? table.columns : (() => {
      if (!Array.isArray(columns) || !columns.length || new Set(columns).size !== columns.length) {
        throw new TypeError('columns must contain unique column names');
      }
      return columns.map(key => columnDefinition(table, key));
    })();
    if (after !== undefined) {
      if (!after || typeof after !== 'object' || Array.isArray(after)
        || Object.keys(after).length !== table.primaryKey.length
        || table.primaryKey.some(key => !Object.hasOwn(after, key))) {
        throw new TypeError('after must contain exactly the complete primary key');
      }
      if (orderBy !== undefined || offset !== 0) {
        throw new TypeError('after keyset pagination requires the default primary-key order and zero offset');
      }
    }
    const args = [];
    const predicates = Object.entries(where).map(([key, value]) => { const column = columnDefinition(table, key); if (value === null) return `${q(key)} IS NULL`; args.push(encodeValue(column, value, 'postgres')); return `${q(key)} = $${args.length}`; });
    for (const [key, values] of Object.entries(whereIn)) {
      const column = columnDefinition(table, key), encoded = encodeValueSet(column, values, 'postgres');
      const clauses = [];
      if (encoded.values.length) {
        args.push(encoded.values);
        clauses.push(`${q(key)} = ANY($${args.length}::${postgresColumnType(column)}[])`);
      }
      if (encoded.includesNull) clauses.push(`${q(key)} IS NULL`);
      predicates.push(clauses.length ? `(${clauses.join(' OR ')})` : 'FALSE');
    }
    const anyPredicates = [];
    for (const [key, values] of Object.entries(whereAny)) {
      const column = columnDefinition(table, key), encoded = encodeValueSet(column, values, 'postgres');
      const clauses = [];
      if (encoded.values.length) {
        args.push(encoded.values);
        clauses.push(`${q(key)} = ANY($${args.length}::${postgresColumnType(column)}[])`);
      }
      if (encoded.includesNull) clauses.push(`${q(key)} IS NULL`);
      anyPredicates.push(clauses.length ? `(${clauses.join(' OR ')})` : 'FALSE');
    }
    if (anyPredicates.length) predicates.push(`(${anyPredicates.join(' OR ')})`);
    for (const key of whereNotNull) { columnDefinition(table, key); predicates.push(`${q(key)} IS NOT NULL`); }
    if (after !== undefined) {
      const placeholders = table.primaryKey.map(key => {
        args.push(encodeValue(columnDefinition(table, key), after[key], 'postgres'));
        return `$${args.length}`;
      });
      predicates.push(`ROW(${table.primaryKey.map(q).join(', ')}) > ROW(${placeholders.join(', ')})`);
    }
    const order = orderBy ?? table.primaryKey.map((column) => ({ column, direction: 'ASC' }));
    let sql = `SELECT ${selected.map(column => q(column.name)).join(', ')} FROM ${q(name)}${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''} ORDER BY ${order.map(({ column, direction = 'ASC' }) => { columnDefinition(table, column); if (!['ASC', 'DESC'].includes(direction)) throw new Error('Invalid sort direction'); return `${q(column)} ${direction} NULLS ${direction === 'ASC' ? 'FIRST' : 'LAST'}`; }).join(', ')}`;
    if (limit !== undefined) { if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid pagination'); args.push(limit, offset); sql += ` LIMIT $${args.length - 1} OFFSET $${args.length}`; }
    return (await this.client.query(sql, args)).rows.map((row) => Object.fromEntries(selected.map((column) => [column.name, decodeValue(column, row[column.name], 'postgres', consumer)])));
  }
  async insert(name, values) {
    const table = tableDefinition(name);
    const names = Object.keys(values);
    for (const column of table.columns) if (!column.nullable && !column.generated && !names.includes(column.name)) throw new TypeError(`Missing ${name}.${column.name}`);
    const args = names.map((key) => encodeValue(columnDefinition(table, key), values[key], 'postgres'));
    const { rows } = await this.client.query(`INSERT INTO ${q(name)} (${names.map(q).join(', ')}) VALUES (${names.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING *`, args);
    return Object.fromEntries(table.columns.map((column) => [column.name, decodeValue(column, rows[0][column.name], 'postgres')]));
  }
  async insertBatch(name, values) {
    if (!this.connectionSession) return this.withConnection(database => database.insertBatch(name, values));
    const table = tableDefinition(name);
    if (!Array.isArray(values)) throw new TypeError('Batch insert values must be an array');
    if (!values.length) return 0n;
    const first = values[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) {
      throw new TypeError(`Batch inserts require a consistent ${name} row shape`);
    }
    const firstNames = Object.keys(first);
    const columns = table.columns.filter(column => Object.hasOwn(first, column.name));
    for (const columnName of firstNames) columnDefinition(table, columnName);
    for (const column of table.columns) {
      if (!column.nullable && !column.generated && !Object.hasOwn(first, column.name)) {
        throw new TypeError(`Missing ${name}.${column.name}`);
      }
    }
    if (!columns.length) throw new TypeError(`Batch inserts require at least one ${name} column`);
    for (const row of values) {
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).length !== firstNames.length
        || columns.some(column => !Object.hasOwn(row, column.name))) {
        throw new TypeError(`Batch inserts require a consistent ${name} row shape`);
      }
    }
    const maximumParameters = 65_535;
    const rowsPerStatement = Math.floor(maximumParameters / columns.length);
    if (rowsPerStatement < 1) throw new Error(`${name} has too many columns for a PostgreSQL batch insert`);
    let inserted = 0n;
    for (let start = 0; start < values.length; start += rowsPerStatement) {
      const batch = values.slice(start, start + rowsPerStatement);
      const args = [];
      const tuples = batch.map(row => `(${columns.map(column => {
        args.push(encodeValue(column, row[column.name], 'postgres'));
        return `$${args.length}`;
      }).join(', ')})`);
      const result = await this.client.query(
        `INSERT INTO ${q(name)} (${columns.map(column => q(column.name)).join(', ')}) VALUES ${tuples.join(', ')}`,
        args
      );
      if (result.rowCount !== batch.length) throw new Error(`PostgreSQL batch insert count mismatch for ${name}`);
      inserted += BigInt(result.rowCount);
    }
    return inserted;
  }
  async upsert(name, values) {
    const table = tableDefinition(name);
    const names = Object.keys(values);
    if (table.primaryKey.some(key => !names.includes(key))) throw new Error('Upserts require a complete primary key');
    for (const column of table.columns) if (!column.nullable && !column.generated && !names.includes(column.name)) throw new TypeError(`Missing ${name}.${column.name}`);
    const args = names.map(key => encodeValue(columnDefinition(table, key), values[key], 'postgres'));
    const changes = table.columns.filter(column => !column.generated && !table.primaryKey.includes(column.name));
    const assignments = changes.length
      ? changes.map(column => `${q(column.name)} = EXCLUDED.${q(column.name)}`).join(', ')
      : `${q(table.primaryKey[0])} = EXCLUDED.${q(table.primaryKey[0])}`;
    const { rows } = await this.client.query(`INSERT INTO ${q(name)} (${names.map(q).join(', ')}) VALUES (${names.map((_, index) => `$${index + 1}`).join(', ')}) ON CONFLICT (${table.primaryKey.map(q).join(', ')}) DO UPDATE SET ${assignments} RETURNING *`, args);
    return Object.fromEntries(table.columns.map(column => [column.name, decodeValue(column, rows[0][column.name], 'postgres')]));
  }
  async update(name, keys, values, { rowVersion } = {}) {
    const table = tableDefinition(name);
    if (table.primaryKey.some((key) => !(key in keys))) throw new Error('Updates require a complete primary key');
    const changes = { ...values };
    if (rowVersion !== undefined) changes.RowVersion = (BigInt(rowVersion) + 1n) & 4294967295n;
    if (!Object.keys(changes).length) throw new TypeError('An update requires at least one changed value.');
    const args = Object.entries(changes).map(([key, value]) => encodeValue(columnDefinition(table, key), value, 'postgres'));
    const conditions = Object.entries(keys).map(([key, value]) => { args.push(encodeValue(columnDefinition(table, key), value, 'postgres')); return `${q(key)} = $${args.length}`; });
    if (rowVersion !== undefined) { args.push(encodeValue(columnDefinition(table, 'RowVersion'), rowVersion, 'postgres')); conditions.push(`"RowVersion" = $${args.length}`); }
    const result = await this.client.query(`UPDATE ${q(name)} SET ${Object.keys(changes).map((key, index) => `${q(key)} = $${index + 1}`).join(', ')} WHERE ${conditions.join(' AND ')}`, args);
    if (rowVersion !== undefined && result.rowCount === 0) throw new Error('Concurrency conflict');
    return BigInt(result.rowCount);
  }
  async updateWhere(name, where, values, { whereIn = {} } = {}) {
    const table = tableDefinition(name), changes = Object.entries(values);
    if (!changes.length) throw new TypeError('A bulk update requires at least one changed value.');
    if (!whereIn || typeof whereIn !== 'object' || Array.isArray(whereIn)) throw new TypeError('whereIn must be a column-to-array object');
    const args = changes.map(([key, value]) => encodeValue(columnDefinition(table, key), value, 'postgres'));
    const conditions = Object.entries(where).map(([key, value]) => {
      const column = columnDefinition(table, key);
      if (value === null) return `${q(key)} IS NULL`;
      args.push(encodeValue(column, value, 'postgres')); return `${q(key)} = $${args.length}`;
    });
    for (const [key, values] of Object.entries(whereIn)) {
      const column = columnDefinition(table, key), encoded = encodeValueSet(column, values, 'postgres');
      const clauses = [];
      if (encoded.values.length) {
        args.push(encoded.values);
        clauses.push(`${q(key)} = ANY($${args.length}::${postgresColumnType(column)}[])`);
      }
      if (encoded.includesNull) clauses.push(`${q(key)} IS NULL`);
      conditions.push(clauses.length ? `(${clauses.join(' OR ')})` : 'FALSE');
    }
    if (!conditions.length) throw new TypeError('A bulk update requires a nonempty predicate.');
    const result = await this.client.query(`UPDATE ${q(name)} SET ${changes.map(([key], index) => `${q(key)} = $${index + 1}`).join(', ')} WHERE ${conditions.join(' AND ')}`, args);
    return BigInt(result.rowCount);
  }
  async delete(name, keys) {
    const table = tableDefinition(name);
    if (table.primaryKey.some((key) => !(key in keys))) throw new Error('Deletes require a complete primary key');
    return this.deleteWhere(name, keys);
  }
  async deleteWhere(name, where, { whereIn = {} } = {}) {
    const table = tableDefinition(name), entries = Object.entries(where);
    if (!whereIn || typeof whereIn !== 'object' || Array.isArray(whereIn)) throw new TypeError('whereIn must be a column-to-array object');
    const args = [], conditions = entries.map(([key, value]) => {
      const column = columnDefinition(table, key);
      if (value === null) return `${q(key)} IS NULL`;
      args.push(encodeValue(column, value, 'postgres')); return `${q(key)} = $${args.length}`;
    });
    for (const [key, values] of Object.entries(whereIn)) {
      const column = columnDefinition(table, key), encoded = encodeValueSet(column, values, 'postgres');
      const clauses = [];
      if (encoded.values.length) {
        args.push(encoded.values);
        clauses.push(`${q(key)} = ANY($${args.length}::${postgresColumnType(column)}[])`);
      }
      if (encoded.includesNull) clauses.push(`${q(key)} IS NULL`);
      conditions.push(clauses.length ? `(${clauses.join(' OR ')})` : 'FALSE');
    }
    if (!conditions.length) throw new TypeError('A bulk delete requires a nonempty predicate.');
    const result = await this.client.query(`DELETE FROM ${q(name)} WHERE ${conditions.join(' AND ')}`, args);
    return BigInt(result.rowCount);
  }
  async resetSequences(sequences = []) {
    if (!this.connectionSession) return this.withConnection(database => database.resetSequences(sequences));
    for (const table of nativeModel.tables) for (const column of table.columns.filter((entry) => entry.generated)) {
      const { rows } = await this.client.query(`SELECT MAX(${q(column.name)})::bigint AS maximum FROM ${q(table.name)}`);
      const imported = sequences.find((entry) => entry.name === table.name)?.seq ?? 0n;
      const maximum = [BigInt(rows[0].maximum ?? 0), BigInt(imported), 0n].reduce((a, b) => a > b ? a : b);
      await this.client.query('SELECT setval(pg_get_serial_sequence($1, $2), $3::bigint, $4)', [`${q(this.schemaName)}.${q(table.name)}`, column.name, (maximum || 1n).toString(), maximum > 0n]);
    }
  }
  async sequenceState() {
    if (!this.connectionSession) return this.withConnection(database => database.sequenceState());
    const result = [];
    for (const table of nativeModel.tables) for (const column of table.columns.filter((entry) => entry.generated)) {
      const sequence = (await this.client.query('SELECT pg_get_serial_sequence($1, $2) AS name', [`${q(this.schemaName)}.${q(table.name)}`, column.name])).rows[0].name;
      const state = (await this.client.query(`SELECT last_value, is_called FROM ${sequence}`)).rows[0];
      if (state.is_called) result.push({ name: table.name, seq: state.last_value });
    }
    return result;
  }
  async close() {
    if (this.connectionSession) throw new Error('A PostgreSQL operation session cannot close its pool');
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const errors = [];
      try { await this.pool.end(); }
      catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'PostgreSQL database could not close every pooled resource');
    })();
    return this.closePromise;
  }
}
