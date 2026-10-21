import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { PostgresDatabase } from '../database/postgres.js';
import { quoteIdentifier as q,tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { nativeGuid } from '../users/native.js';
import { clrTrim } from '../metadata/whitespace.js';
import { mapRecord } from './records.js';

const handles = new WeakSet();
const revisionObservers = new WeakMap();
const pageSize = 128;
const fields = '"Ordinal", "ItemId", "Type", "Path", "LibraryItemId"';
export const EMPTY_NATIVE_LINKS = Object.freeze({ kind: 'empty-native-links' });
export const isLinkedChildrenHandle = value => value !== null && typeof value === 'object' && handles.has(value);
const requirePlan = plan => {
  if (!plan || typeof plan.text !== 'string' || !Array.isArray(plan.values)) throw new TypeError('An ordered SQL link relation is required.');
  return plan;
};
const sessionValid = session => session?.dialect === 'postgres' && session.connectionSession === true && typeof session.client?.query === 'function';
const encode = value => value == null ? null : nativeTextBytes(value);
const decode = value => value == null ? null : decodeNativeTextBytes(value, 'runtime');
const immutablePlan = (text, values = []) => Object.freeze({ text, values: Object.freeze(values) });
const rebase = (plan, offset) => plan.text.replace(/\$(\d+)\b/gu, (_, value) => '$' + (Number(value) + offset));
export const emptyLinkedChildrenPlan = () => immutablePlan(`SELECT NULL::bigint AS "Ordinal", NULL::bytea AS "ItemId",
  0::integer AS "Type", NULL::bytea AS "Path", NULL::bytea AS "LibraryItemId" WHERE FALSE`);

class LinkedChildrenHandle {
  constructor(store, entry, revision = 0n) {
    this.store = store; this.entry = entry; this.revision = revision; this.released = false;
    entry.references += 1; handles.add(this);
  }
  retain() { return this.store.retain(this); }
  observe(listener){if(typeof listener!=='function')throw new TypeError('A relation revision observer is required.');let observers=revisionObservers.get(this);if(!observers)revisionObservers.set(this,observers=new Set());observers.add(listener);let released=false;return Object.freeze({release(){if(released)return;released=true;observers.delete(listener);}});}
  count(options) { return this.store.count(this, options); }
  pages(options) { return this.store.pages(this, options); }
  release(options) { return this.store.release(this, options); }
  toJSON() { throw new TypeError('Live SQL links must be captured as an explicitly pinned state token.'); }
}

/** One private runtime schema owns raw native sequences across pool sessions.
 * It is separate from the 31 native exchange tables. Members never reside in
 * Node: handles contain set/revision metadata, pages contain at most 128 rows.
 * Initialize before cold hydration/importers; close only after consumers drain. */
export class PostgresLinkedChildrenStore {
  #entries = new Map();
  #pendingReleases = new Set();
  #handleOperations = new WeakMap();
  #mutationTails = new WeakMap();
  #closed = false;
  #initialized = false;
  #ownDatabase;
  #operations = new Set();
  #operationContext = new AsyncLocalStorage();
  #closing = false;
  #closePromise;
  #drainWaiters = new Set();
  constructor({ database, relationDatabase, runtimeId = randomUUID() }) {
    if (database?.dialect !== 'postgres' || typeof database.withConnection !== 'function') throw new TypeError('SQL links require a pooled PostgreSQL database.');
    if (relationDatabase) {
      if (relationDatabase.dialect !== 'postgres' || typeof relationDatabase.withConnection !== 'function') throw new TypeError('A separate relation connection owner is required.');
      this.relationDatabase = relationDatabase; this.#ownDatabase = false;
    } else {
      if (!database.pool?.options) throw new TypeError('The runtime link repository requires the native database pool configuration.');
      // Independent admission avoids nested AsyncLocalStorage reuse and a
      // deadlock when every native request connection is already checked out.
      const pool = new pg.Pool({ ...database.pool.options, max: 1 });
      this.relationDatabase = new PostgresDatabase(pool, database.schemaName);
      const native = database.root ?? database, relations = this.relationDatabase;
      // Reuse the actual query observer while pinning its forwarding facade to
      // the relation connection, never the enclosing read-only native request.
      Object.defineProperty(relations, 'queryHook', { configurable: false, get: () => native.queryHook == null ? null
        : (...args) => native.operationContext.run(relations.operationContext.getStore(), () =>
          native.queryHookContext.run(true, () => native.queryHook.call(native.client, ...args))) });
      this.#ownDatabase = true;
    }
    Object.assign(this, { database, runtimeId });
    this.schemaName = 'mm_links_' + runtimeId.replaceAll('-', '');
    if (!/^mm_links_[a-f0-9]{32}$/u.test(this.schemaName)) throw new TypeError('A UUID runtime identity is required.');
    this.sets = `${q(this.schemaName)}.sets`;
    this.rows = `${q(this.schemaName)}.rows`;
    this.pins = `${q(this.schemaName)}.pins`;
  }
  #active(owned = false) {
    if (this.#closed || !this.#initialized || !owned && this.#closing && this.#operationContext.getStore() !== this) {
      throw new Error('SQL link runtime is not active.');
    }
  }
  #run(operation) {
    this.#active(true);
    if (this.#operationContext.getStore() === this) return operation();
    const pending = this.#operationContext.run(this, () => Promise.resolve().then(operation));
    this.#operations.add(pending);
    const finished = () => { this.#operations.delete(pending); this.#changed(); };
    pending.then(finished, finished);
    return pending;
  }
  #changed() {
    for (const resolve of this.#drainWaiters) resolve();
    this.#drainWaiters.clear();
  }
  #lease() {
    this.#active();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    this.#operations.add(pending);
    let released = false;
    return () => { if (released) return; released = true; this.#operations.delete(pending); release(); this.#changed(); };
  }
  #using(session, operation) {
    return this.#run(() => {
      if (session != null) {
        if (!sessionValid(session)) throw new TypeError('A checked-out PostgreSQL session is required.');
        return operation(session);
      }
      return this.relationDatabase.withConnection(operation);
    });
  }
  async initialize() {
    if (this.#closed || this.#initialized) throw new Error('SQL link runtime initializes exactly once.');
    await this.relationDatabase.withConnection(async session => {
      await session.client.query(`CREATE SCHEMA ${q(this.schemaName)};
        CREATE TABLE ${this.sets} (id uuid PRIMARY KEY, parent_id bytea NOT NULL, max_revision bigint NOT NULL DEFAULT 0);
        CREATE TABLE ${this.rows} (set_id uuid NOT NULL REFERENCES ${this.sets}(id) ON DELETE CASCADE,
          "Ordinal" bigint NOT NULL CHECK ("Ordinal">0), "ItemId" bytea, "Type" integer NOT NULL,
          "Path" bytea, "LibraryItemId" bytea, revision bigint NOT NULL DEFAULT 0,
          PRIMARY KEY (set_id, "Ordinal", revision));
        CREATE TABLE ${this.pins} (scope_id uuid NOT NULL, slot_id bytea NOT NULL,
          set_id uuid NOT NULL REFERENCES ${this.sets}(id), revision bigint NOT NULL,
          PRIMARY KEY(scope_id,slot_id));
        CREATE TABLE ${q(this.schemaName)}.item_states (scope_id uuid NOT NULL,slot_id uuid NOT NULL,
          state bytea NOT NULL,"Id" bytea NOT NULL,"OfficialRating" bytea,"CustomRating" bytea,"Name" bytea,
          "EndDateTicks" bigint,"AllImagesLocalOrSd" boolean,PRIMARY KEY(scope_id,slot_id));
        CREATE TABLE ${q(this.schemaName)}.item_cohorts (view_id uuid NOT NULL,"Ordinal" bigint NOT NULL,
          scope_id uuid NOT NULL,slot_id uuid NOT NULL,PRIMARY KEY(view_id,"Ordinal"));`);
    });
    this.#initialized = true;
  }
  check(handle) {
    this.#active(true);
    if (!isLinkedChildrenHandle(handle) || handle.store !== this || handle.released) throw new TypeError('A live handle from this runtime is required.');
  }
  #handle(id, revision = 0n) {
    let entry = this.#entries.get(id);
    if (!entry) { entry = { id, references: 0 }; this.#entries.set(id, entry); }
    return new LinkedChildrenHandle(this, entry, revision);
  }
  retain(handle) { this.check(handle); return this.#handle(handle.entry.id, handle.revision); }
  /** Keep the exact mutable branch alive across awaits. Retain is deliberately
   * different: it creates an immutable revision which may later fork. */
  admitHandleOperation(handle) {
    this.#active();
    if (handle !== EMPTY_NATIVE_LINKS && handle !== null) this.check(handle);
    const releaseOwner = this.#lease();
    let state;
    const token = {};
    if (isLinkedChildrenHandle(handle)) {
      state = this.#handleOperations.get(handle);
      if (!state) this.#handleOperations.set(handle, state = { baseReleased: false, tokens: new Set() });
      state.tokens.add(token);
    }
    let releasing;
    return Object.freeze({ handle, release: () => releasing ??= this.#operationContext.run(this, async () => {
      try {
        if (!state) return;
        state.tokens.delete(token);
        if (state.baseReleased && state.tokens.size === 0 && !handle.released) {
          const entry = this.#releaseReference(handle);
          // The original caller's session may already be returned or aborted.
          // Final operation release always collects on the relation owner.
          try { await this.#collect(entry); }
          catch (error) { this.#pendingReleases.add(entry); throw error; }
        }
      } finally { releaseOwner(); }
    }) });
  }
  plan(handle) {
    if (handle === EMPTY_NATIVE_LINKS) { this.#active(true); return emptyLinkedChildrenPlan(); }
    if (handle === null) throw Object.assign(new TypeError('A native folder link sequence cannot be null.'), { nativeException: 'NullReferenceException', status: 500 });
    this.check(handle);
    return immutablePlan(`SELECT DISTINCT ON ("Ordinal") ${fields} FROM ${this.rows}
      WHERE set_id=$1 AND revision<=$2 ORDER BY "Ordinal", revision DESC`, [handle.entry.id, handle.revision]);
  }
  /** One autocommitted statement publishes a TEMP relation on its owning
   * session. It precedes repository persistence, so save rollback cannot erase
   * assigned members or a preceding successful link cache mutation. */
  async createFromSession({ session, parentId='00000000000000000000000000000000', plan }) {
    this.#active(); requirePlan(plan);
    if (!sessionValid(session) || session.inTransaction) throw new TypeError('Raw link publication requires its current session before the repository transaction.');
    const id = randomUUID(), offset = plan.values.length;
    return this.#using(session, async db => {
    await db.client.query({ text: `WITH owned AS (
      INSERT INTO ${this.sets}(id,parent_id) VALUES ($${offset + 1},$${offset + 2}) RETURNING id
    ) INSERT INTO ${this.rows}(set_id,${fields}) SELECT owned.id, source."Ordinal", source."ItemId",
      source."Type", source."Path", source."LibraryItemId" FROM (${plan.text}) source CROSS JOIN owned
      ORDER BY source."Ordinal"`, values: [...plan.values, id, encode(parentId)] });
    return this.#handle(id);
    });
  }
  createFromPlan({ parentId, plan }) {
    return this.#using(null, session => this.createFromSession({ session, parentId, plan }));
  }
  /** Metadata's source-first concatenation uses one string key: a nonempty
   * Guid's normalized key, otherwise Path (null and empty share the empty key).
   * SQL owns deduplication and order; a replacing Playlist copies raw repeats. */
  async merge(source, target, { parentId, replace = false, session } = {}) {
    this.#active();
    const incoming = this.plan(source ?? EMPTY_NATIVE_LINKS), existing = this.plan(target ?? EMPTY_NATIVE_LINKS);
    return this.#using(null, async db => {
      let plan = incoming;
      if (!replace) {
        const sql = nativeTextSql(db.schemaName);
        const key = `CASE WHEN ${sql.guidKey('"ItemId"')} <> '00000000000000000000000000000000'
          AND "ItemId" IS NOT NULL THEN convert_to(${sql.guidKey('"ItemId"')},'UTF8') ELSE COALESCE("Path",'\\x'::bytea) END`;
        plan = immutablePlan(`WITH combined AS (
          SELECT 0 AS source_order,source.* FROM (${incoming.text}) source UNION ALL
          SELECT 1 AS source_order,source.* FROM (${rebase(existing, incoming.values.length)}) source
        ), ranked AS (SELECT *,row_number() OVER(PARTITION BY ${key} ORDER BY source_order,"Ordinal") AS occurrence FROM combined)
        SELECT row_number() OVER(ORDER BY source_order,"Ordinal") AS "Ordinal","ItemId","Type","Path","LibraryItemId"
        FROM ranked WHERE occurrence=1 ORDER BY source_order,"Ordinal"`, [...incoming.values, ...existing.values]);
      }
      return this.createFromSession({ session: db, parentId, plan });
    });
  }
  /** BaseXmlSaver uses manual ItemIds and repository paths, independently of
   * live path-cache resolution. Own that projection before saver file I/O. */
  async xmlPaths(handle, { session, parentId, expandPath = value => value } = {}) {
    const raw = this.plan(handle);
    return this.#using(session, async db => {
      if (db.inTransaction) throw new TypeError('XML path publication precedes repository save.');
      const sql = nativeTextSql(db.schemaName), items = `${q(db.schemaName)}.${q('BaseItems')}`;
      const manualCount = BigInt((await db.client.query({ text: `SELECT count(*) AS count FROM (${raw.text}) source WHERE "Type"=0`, values: raw.values })).rows[0].count);
      const selected=q('mm_xml_items_'+randomUUID().replaceAll('-','')),valid=q('mm_xml_valid_'+randomUUID().replaceAll('-',''));
      await db.client.query({text:`CREATE TEMP TABLE ${selected} AS SELECT row_number() OVER(ORDER BY item."SortName") AS "__Ordinal",item.* FROM ${items} item
        WHERE EXISTS(SELECT 1 FROM (${raw.text}) source WHERE source."Type"=0 AND ${sql.guidKey('source."ItemId"')}<>'00000000000000000000000000000000'
          AND ${sql.guidKey('item."Id"')}=${sql.guidKey('source."ItemId"')})`,values:raw.values});
      let materialized;
      try{
      await db.client.query(`CREATE TEMP TABLE ${valid}(id bytea PRIMARY KEY,path bytea)`);
      // GetItemList maps the complete positive-ID batch before the saver opens
      // its plural node. Validate each frozen repository row in bounded pages;
      // paths and the complete membership remain SQL-owned.
      const columns=tableDefinition('BaseItems').columns;
      for(let after=0n;;){const rows=(await db.client.query(`SELECT * FROM ${selected} WHERE "__Ordinal">$1 ORDER BY "__Ordinal" LIMIT 128`,[after])).rows;
        if(!rows.length)break;for(const row of rows){const mapped=mapRecord(Object.fromEntries(columns.map(column=>[column.name,decodeValue(column,row[column.name],'postgres','runtime')])));
          if(mapped)await db.client.query(`INSERT INTO ${valid}(id,path) VALUES ($1,$2)`,[encode(mapped.Id),encode(mapped.Path)]);}
        after=BigInt(rows.at(-1).__Ordinal);
      }
      const plan = immutablePlan(`SELECT source."Ordinal",source."ItemId",source."Type",item.path AS "Path",NULL::bytea AS "LibraryItemId"
        FROM (${raw.text}) source LEFT JOIN ${valid} item ON ${sql.guidKey('item.id')}=${sql.guidKey('source."ItemId"')}
        WHERE source."Type"=0 ORDER BY source."Ordinal"`, [...raw.values]);
      materialized = await this.createFromSession({ session: db, parentId, plan });
      const writer = await this.createWriter({ session: db, parentId });
      try {
        for await (const page of this.pages(materialized, { session: db })) for (const row of page) {
          const value = row.Path == null ? null : expandPath(row.Path);
          if (typeof value === 'string' && clrTrim(value)) await writer.append({ ...row, Path: value });
        }
        return { manualCount, paths: await writer.finish() };
      } catch (error) { await writer.abort(); throw error; }
      finally { await this.release(materialized, { session: db }); }
      }finally{await db.client.query(`DROP TABLE IF EXISTS ${selected},${valid}`);}
    });
  }
  storedPlan(session, parentId) {
    if (!sessionValid(session)) throw new TypeError('Cold links require their authoritative PostgreSQL session.');
    const relation = `${q(session.schemaName)}.${q('LinkedChildren')}`;
    return immutablePlan(`SELECT row_number() OVER(ORDER BY "SortOrder") AS "Ordinal", "ChildId" AS "ItemId",
      "ChildType"::integer AS "Type", NULL::bytea AS "Path", NULL::bytea AS "LibraryItemId"
      FROM ${relation} WHERE ${nativeTextSql(session.schemaName).guidKey('"ParentId"')}=${nativeTextSql(session.schemaName).guidKey('$1::bytea')} ORDER BY "SortOrder"`, [encode(parentId)]);
  }
  async load(session, parentId) {
    return this.createFromSnapshot({session,parentId,plan:this.storedPlan(session,parentId)});
  }
  async createFromSnapshot({session,parentId,plan:source}) {
    this.#active();requirePlan(source);
    if(!sessionValid(session))throw new TypeError('The source snapshot requires its checked-out session.');
    if (!session.inTransaction) return this.createFromSession({ session, parentId, plan: source });
    // A READ ONLY request owns its source snapshot. A cursor pins that SELECT
    // snapshot across FETCH pages; a separate runtime connection commits the
    // owned relation, independently of a later request rollback.
    const cursor = q('mm_link_read_' + randomUUID().replaceAll('-', ''));
    return this.#run(async () => {
    await session.client.query({ text: `DECLARE ${cursor} NO SCROLL CURSOR FOR ${source.text}`, values: source.values });
    try {
    return await this.#using(null, async target => {
      const writer = await this.createWriter({ session: target, parentId });
      try {
        for (;;) {
          const rows = (await session.client.query(`FETCH FORWARD 128 FROM ${cursor}`)).rows;
          if (!rows.length) break;
          for (const row of rows) await writer.append({ ItemId: decode(row.ItemId), Type: Number(row.Type), Path: decode(row.Path), LibraryItemId: decode(row.LibraryItemId) });
        }
        return await writer.finish();
      } catch (error) {
        try { await writer.abort(); } catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
        throw error;
      }
    });
    } finally { await session.client.query(`CLOSE ${cursor}`); }
    });
  }
  async page(handle, { session, after = 0n, limit = pageSize } = {}) {
    if (typeof after !== 'bigint' || after < 0n || !Number.isInteger(limit) || limit < 1 || limit > pageSize) throw new TypeError('Link pages require a bigint cursor and limit from 1 to 128.');
    const plan = this.plan(handle), offset = plan.values.length;
    return this.#using(session?.inTransaction ? null : session, async database => {
      const result = await database.client.query({ text: `SELECT * FROM (${plan.text}) source WHERE "Ordinal">$${offset + 1}
        ORDER BY "Ordinal" LIMIT $${offset + 2}`, values: [...plan.values, after, limit] });
      return result.rows.map(row => ({ ...row, Ordinal: BigInt(row.Ordinal), ItemId: decode(row.ItemId), Path: decode(row.Path), LibraryItemId: decode(row.LibraryItemId) }));
    });
  }
  async *pages(handle, options = {}) {
    const pinned = handle === EMPTY_NATIVE_LINKS ? handle : this.retain(handle);
    try {
      for (let after = 0n; ; ) {
        const page = await this.page(pinned, { ...options, after }); if (!page.length) return;
        yield page; after = page.at(-1).Ordinal;
      }
    } finally { if (isLinkedChildrenHandle(pinned)) await this.release(pinned, { session: options.session }); }
  }
  async count(handle, { session } = {}) {
    const plan = this.plan(handle);
    return this.#using(session?.inTransaction ? null : session, async database => BigInt((await database.client.query({ text: `SELECT count(*) AS count FROM (${plan.text}) source`, values: plan.values })).rows[0].count));
  }
  /** Preserve clone/captured revisions: append one cache version, forking only
   * if another live branch has already advanced the observed set revision. */
  recordResolution(handle, ordinal, itemId, options = {}) {
    this.check(handle);
    const preceding = this.#mutationTails.get(handle) ?? Promise.resolve();
    const pending = this.#run(() => preceding.then(() => this.#recordResolution(handle, ordinal, itemId, options)));
    this.#mutationTails.set(handle, pending.catch(() => {}));
    return pending;
  }
  async #recordResolution(handle, ordinal, itemId, { session } = {}) {
    this.check(handle);
    if (typeof ordinal !== 'bigint' || ordinal <= 0n) throw new TypeError('An existing raw link ordinal is required.');
    const old = handle.entry, observed = handle.revision;
    const changed = await this.#using(session?.inTransaction ? null : session, async database => {
      if (database.inTransaction) throw new TypeError('Live link cache resolution must commit before the repository transaction.');
      return database.transaction(async db => {
        const result = await db.client.query(`SELECT max_revision FROM ${this.sets} WHERE id=$1 FOR UPDATE`, [old.id]);
        if (result.rows.length !== 1) throw new Error('Absent live link set.');
        let id = old.id, revision = observed;
        if (BigInt(result.rows[0].max_revision) !== observed) {
          id = randomUUID(); revision = 0n;
          await db.client.query(`INSERT INTO ${this.sets}(id,parent_id) SELECT $1,parent_id FROM ${this.sets} WHERE id=$2`, [id, old.id]);
          const plan = this.plan(handle);
          await db.client.query({ text: `INSERT INTO ${this.rows}(set_id,${fields}) SELECT $3,${fields} FROM (${plan.text}) source`, values: [...plan.values, id] });
        }
        const next = revision + 1n;
        const update = await db.client.query(`INSERT INTO ${this.rows}(set_id,${fields},revision)
          SELECT $1,"Ordinal",$4,"Type","Path","LibraryItemId",$5 FROM ${this.rows}
          WHERE set_id=$1 AND "Ordinal"=$2 AND revision<=$3 ORDER BY revision DESC LIMIT 1`, [id, ordinal, revision, encode(itemId), next]);
        if (update.rowCount !== 1) throw new Error('Absent raw link ordinal.');
        await db.client.query(`UPDATE ${this.sets} SET max_revision=$2 WHERE id=$1`, [id, next]);
        return { id, revision: next };
      });
    });
    // Never publish an uncommitted branch. A clone retained during await keeps
    // the old immutable revision and continues to resolve independently.
    if (changed.id !== old.id) {
      const replacement = this.#handle(changed.id, changed.revision);
      old.references -= 1; handle.entry = replacement.entry; replacement.released = true;
      await this.#collect(old, session);
    }
    handle.revision = changed.revision;
    for(const observer of revisionObservers.get(handle)??[])observer(handle);
  }
  async pinState(handle, { session, scopeId, slotId }) {
    this.check(handle);
    await this.#using(session?.inTransaction ? null : session, async db => {
    const previous=(await db.client.query(`SELECT set_id FROM ${this.pins} WHERE scope_id=$1 AND slot_id=$2`,[scopeId,encode(slotId)])).rows[0]?.set_id;
    await db.client.query(`INSERT INTO ${this.pins}(scope_id,slot_id,set_id,revision)
      VALUES ($1,$2,$3,$4) ON CONFLICT(scope_id,slot_id) DO UPDATE SET set_id=EXCLUDED.set_id,revision=EXCLUDED.revision`,
    [scopeId, encode(slotId), handle.entry.id, handle.revision]);
    if(previous&&previous!==handle.entry.id&&!this.#entries.get(previous)?.references)await db.client.query(`DELETE FROM ${this.sets} source WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM ${this.pins} pins WHERE pins.set_id=source.id)`,[previous]);
    });
    return Object.freeze({ runtimeId: this.runtimeId, scopeId, slotId, setId: handle.entry.id, revision: handle.revision.toString() });
  }
  async restoreState(token, { session } = {}) {
    if (token?.runtimeId !== this.runtimeId || !/^\d+$/u.test(token.revision)) throw new TypeError('State links belong to their active capturing runtime.');
    const present = await this.#using(session?.inTransaction ? null : session, async db => (await db.client.query(`SELECT EXISTS(SELECT 1 FROM ${this.pins}
      WHERE scope_id=$1 AND slot_id=$2 AND set_id=$3 AND revision=$4) AS present`, [token.scopeId, encode(token.slotId), token.setId, BigInt(token.revision)])).rows[0].present);
    if (!present) throw new Error('The link state scope has been released.');
    return this.#handle(token.setId, BigInt(token.revision));
  }
  async #collect(entry, session) {
    if (entry.references !== 0 || this.#entries.get(entry.id)?.references) return;
    // Check local ownership after obtaining a connection as well: a retained
    // view arriving during await must not lose its underlying SQL relation.
    await this.#using(session?.inTransaction ? null : session, async db => {
      if (entry.references !== 0 || this.#entries.get(entry.id)?.references) return;
      const result = await db.client.query(`DELETE FROM ${this.sets} source WHERE id=$1
        AND NOT EXISTS(SELECT 1 FROM ${this.pins} pins WHERE pins.set_id=source.id)`, [entry.id]);
      // Pins own their sets in SQL. Keeping zero-reference metadata here would
      // recreate an all-member Node registry when a large typed cohort pins
      // many folders. A restored pin creates only its current page's entry.
      if (entry.references === 0&&this.#entries.get(entry.id)===entry) this.#entries.delete(entry.id);
    });
  }
  #releaseReference(handle) {
    handle.released = true; handle.entry.references -= 1;
    this.#changed();
    return handle.entry;
  }
  #requestRelease(handle) {
    const state = this.#handleOperations.get(handle);
    if (state) {
      if (state.baseReleased) return false;
      state.baseReleased = true;
      if (state.tokens.size) return false;
    }
    this.#releaseReference(handle);
    return true;
  }
  queueRelease(handle) {
    if (!isLinkedChildrenHandle(handle) || handle.released) return;
    this.#operationContext.run(this, () => {
      this.check(handle);
      if (this.#requestRelease(handle)) this.#pendingReleases.add(handle.entry);
    });
  }
  async release(handle, { session } = {}) {
    if (handle === EMPTY_NATIVE_LINKS || handle === null || handle?.released) return;
    return this.#operationContext.run(this, async () => {
      this.check(handle);
      if (!this.#requestRelease(handle)) return;
      try { await this.#collect(handle.entry, session); }
      catch (error) { this.#pendingReleases.add(handle.entry); throw error; }
    });
  }
  async flushReleases({ session } = {}) {
    return this.#operationContext.run(this, async () => {
    const errors = [];
    for (const entry of this.#pendingReleases) {
      try { await this.#collect(entry, session); this.#pendingReleases.delete(entry); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'SQL link ownership release failed.');
    });
  }
  async releaseStateScope(scopeId, { session } = {}) {
    await this.#using(session?.inTransaction ? null : session,async db=>{
      const candidates=q('mm_unpin_'+randomUUID().replaceAll('-','')),protectedSets=q('mm_active_'+randomUUID().replaceAll('-',''));
      try{
        await db.client.query(`CREATE TEMP TABLE ${candidates} AS SELECT DISTINCT set_id FROM ${this.pins} WHERE scope_id=$1`,[scopeId]);
        await db.client.query(`CREATE TEMP TABLE ${protectedSets}(id uuid PRIMARY KEY)`);
        let batch=[];const write=async()=>{if(!batch.length)return;await db.client.query(`INSERT INTO ${protectedSets}(id) SELECT id FROM unnest($1::uuid[]) source(id)`,[batch]);batch=[];};
        // This is the bounded live cache/request ownership registry, never the
        // cohort's pinned members. Send at most 128 identifiers per statement.
        for(const entry of this.#entries.values())if(entry.references){batch.push(entry.id);if(batch.length===128)await write();}await write();
        await db.client.query(`DELETE FROM ${this.pins} WHERE scope_id=$1`,[scopeId]);
        await db.client.query(`DELETE FROM ${this.sets} source WHERE EXISTS(SELECT 1 FROM ${candidates} candidate WHERE candidate.set_id=source.id)
          AND NOT EXISTS(SELECT 1 FROM ${this.pins} pins WHERE pins.set_id=source.id) AND NOT EXISTS(SELECT 1 FROM ${protectedSets} active WHERE active.id=source.id)`);
      }finally{await db.client.query(`DROP TABLE IF EXISTS ${candidates},${protectedSets}`);}
    });
  }
  async createWriter({ session, parentId }) {
    if (!sessionValid(session)) throw new TypeError('A member importer requires its current checked-out session.');
    const releaseLease = this.#lease();
    const temporary = q('mm_link_input_' + randomUUID().replaceAll('-', ''));
    try { await session.client.query(`CREATE TEMP TABLE ${temporary} ("Ordinal" bigint PRIMARY KEY, "ItemId" bytea,
      "Type" integer NOT NULL, "Path" bytea, "LibraryItemId" bytea)`); }
    catch (error) { releaseLease(); throw error; }
    let ordinal = 0n, finished = false; const buffer = [];
    const flush = async () => {
      if (!buffer.length) return;
      const values = [], tuples = buffer.map(row => '(' + [row.Ordinal, encode(row.ItemId), row.Type, encode(row.Path), encode(row.LibraryItemId)]
        .map(value => { values.push(value); return '$' + values.length; }).join(',') + ')');
      await session.client.query({ text: `INSERT INTO ${temporary}(${fields}) VALUES ${tuples.join(',')}`, values }); buffer.length = 0;
    };
    const abort = async () => {
      if (finished) return; finished = true;
      try { await session.client.query(`DROP TABLE ${temporary}`); } finally { releaseLease(); }
    };
    return Object.freeze({
      async append(link) {
        if (finished) throw new Error('The member importer is closed.');
        const type = typeof link.Type === 'number' ? link.Type : ['Manual','Shortcut','LocalAlternateVersion','LinkedAlternateVersion'].indexOf(link.Type ?? 'Manual');
        if (!Number.isInteger(type) || type < -2147483648 || type > 2147483647
          || typeof link.Type === 'string' && type < 0) throw new TypeError('A native integer linked child Type is required.');
        buffer.push({ ...link, Type: type, Ordinal: ++ordinal }); if (buffer.length === pageSize) await flush();
      },
      get count() { return ordinal; }, abort,
      finish: () => this.#operationContext.run(this, async () => {
        if (finished) throw new Error('The member importer is closed.');
        try {
          await flush();
          return await this.createFromSnapshot({ session, parentId, plan: immutablePlan(`SELECT ${fields} FROM ${temporary} ORDER BY "Ordinal"`) });
        }
        finally { await abort(); }
      }),
    });
  }
  withSession(operation) { this.#active(); return this.#using(null, operation); }
  admitScope() {
    const releaseLease=this.#lease();let released=false;
    return Object.freeze({run:operation=>{
      if(released)throw new Error('The relation scope has been released.');
      return this.#operationContext.run(this,()=>this.#using(null,operation));
    },release(){if(released)return;released=true;releaseLease();}});
  }
  async persist(session, item, { reversePath = value => value, logger } = {}) {
    if (!sessionValid(session) || !session.inTransaction) throw new TypeError('Folder link replacement belongs to the caller repository transaction.');
    if (!item.LinkedChildrenLoaded) return;
    this.plan(item.LinkedChildren); // Preserve the native null sentinel failure.
    const captured=item.LinkedChildren===EMPTY_NATIVE_LINKS?EMPTY_NATIVE_LINKS:this.retain(item.LinkedChildren);
    const source = this.plan(captured), temporary = q('mm_link_save_' + randomUUID().replaceAll('-', ''));
    try{
    const sql = nativeTextSql(session.schemaName), items = `${q(session.schemaName)}.${q('BaseItems')}`;
    const links = `${q(session.schemaName)}.${q('LinkedChildren')}`, order = `${q(session.controlSchema)}.item_order`;
    await session.client.query(`CREATE TEMP TABLE ${temporary}("Ordinal" bigint PRIMARY KEY,"ItemId" bytea,"Type" integer,"Path" bytea,"LibraryItemId" bytea,"OriginalPath" bytea) ON COMMIT DROP`);
    // A relation published after this caller's REPEATABLE READ began is not
    // visible through that transaction. Read its pinned revision on the live
    // relation pool and copy bounded raw pages into the caller's SQL work set.
    for(let after=0n;;){const rows=await this.#using(null,async database=>(await database.client.query({
      text:`SELECT * FROM (${source.text}) source WHERE "Ordinal">$${source.values.length+1} ORDER BY "Ordinal" LIMIT 128`,values:[...source.values,after]})).rows);
      if(!rows.length)break;const values=[],tuples=rows.map(row=>'('+[row.Ordinal,row.ItemId,row.Type,row.Path,row.LibraryItemId,row.Path].map(value=>{values.push(value);return'$'+values.length;}).join(',')+')');
      await session.client.query({text:`INSERT INTO ${temporary}("Ordinal","ItemId","Type","Path","LibraryItemId","OriginalPath") VALUES ${tuples.join(',')}`,values});
      after=BigInt(rows.at(-1).Ordinal);
    }
    // Path reversal is a declared Node runtime operation. Visit one bounded
    // raw page at a time; SQL retains every member and resolution projection.
    for (let after = 0n; ; ) {
      const rows = (await session.client.query(`SELECT "Ordinal","Path","LibraryItemId" FROM ${temporary} WHERE "Ordinal">$1 ORDER BY "Ordinal" LIMIT 128`, [after])).rows;
      if (!rows.length) break;
      for (const row of rows) {
        let libraryId = null;
        if (row.LibraryItemId != null) {
          const raw = decode(row.LibraryItemId);
          try { libraryId = nativeGuid(raw); } catch { libraryId = null; }
        }
        await session.client.query(`UPDATE ${temporary} SET "Path"=$2,"LibraryItemId"=$3 WHERE "Ordinal"=$1`,
          [row.Ordinal, encode(row.Path == null ? null : reversePath(decode(row.Path))), encode(libraryId)]);
      }
      after = BigInt(rows.at(-1).Ordinal);
    }
    const zero = '00000000000000000000000000000000';
    const resolvedGroups = `WITH resolved AS MATERIALIZED (
      SELECT source.*, COALESCE(cached."Id",by_path."Id",source."LibraryItemId",source."ItemId") AS child_id FROM ${temporary} source
      LEFT JOIN LATERAL (SELECT candidate."Id" FROM ${items} candidate WHERE ${sql.guidKey('candidate."Id"')}=${sql.guidKey('source."ItemId"')}
        AND ${sql.guidKey('source."ItemId"')}<>'${zero}' LIMIT 1) cached ON TRUE
      LEFT JOIN LATERAL (SELECT candidate."Id" FROM ${items} candidate JOIN ${order} native_order ON native_order.item_id=candidate."Id"
        WHERE candidate."Path"=source."Path" AND octet_length(source."Path")>0 ORDER BY native_order.position LIMIT 1) by_path ON cached."Id" IS NULL
    ), groups AS MATERIALIZED (${item.Type === 'Playlist' ? `SELECT "Ordinal" AS first_ordinal,"Type",child_id,"OriginalPath" FROM resolved WHERE child_id IS NOT NULL AND ${sql.guidKey('child_id')}<>'${zero}'`
      : `SELECT first_ordinal,"Type",child_id,"OriginalPath" FROM (SELECT "Type",child_id,"OriginalPath",
        min("Ordinal") OVER(PARTITION BY ${sql.guidKey('child_id')}) AS first_ordinal,
        row_number() OVER(PARTITION BY ${sql.guidKey('child_id')} ORDER BY "Ordinal" DESC) AS last_position
        FROM resolved WHERE child_id IS NOT NULL AND ${sql.guidKey('child_id')}<>'${zero}') ranked WHERE last_position=1`})`;
    const selected = `${resolvedGroups} SELECT $1::bytea AS "ParentId",(row_number() OVER(ORDER BY first_ordinal)-1)::integer AS "SortOrder",
      child_id AS "ChildId","Type" AS "ChildType" FROM groups WHERE EXISTS(SELECT 1 FROM ${items} candidate
      WHERE ${sql.guidKey('candidate."Id"')}=${sql.guidKey('groups.child_id')})`;
    await session.client.query(`DELETE FROM ${links} WHERE ${sql.guidKey('"ParentId"')}=${sql.guidKey('$1::bytea')}`, [encode(item.Id)]);
    await session.client.query({ text: `INSERT INTO ${links}("ParentId","SortOrder","ChildId","ChildType") ${selected}`, values: [encode(item.Id)] });
    // Missing links are skipped by SQL. Keep warning projections paged rather
    // than reconstructing the entire failed member sequence in Node.
    if (logger?.warn) {
      for (let after = 0n; ; ) {
        const rows = (await session.client.query(`${resolvedGroups} SELECT first_ordinal,child_id,"OriginalPath" FROM groups
          WHERE first_ordinal>$1 AND NOT EXISTS(SELECT 1 FROM ${items} candidate
          WHERE ${sql.guidKey('candidate."Id"')}=${sql.guidKey('groups.child_id')}) ORDER BY first_ordinal LIMIT 128`, [after])).rows;
        if (!rows.length) break;
        for (const row of rows) logger.warn('Skipping LinkedChild for parent {ParentName} ({ParentId}): child item {ChildId} (path {ChildPath}) does not exist in database',
          item.Name, item.Id, decode(row.child_id), decode(row.OriginalPath) ?? 'unknown');
        after = BigInt(rows.at(-1).first_ordinal);
      }
    }
    }finally{await this.release(captured);}
  }
  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      // Runtime has already stopped new requests/cache owners. Retained event
      // and importer owners can still finish/release; do not drop their rows.
      while (this.#operations.size || [...this.#entries.values()].some(entry => entry.references !== 0)) {
        await new Promise(resolve => this.#drainWaiters.add(resolve));
      }
      const failures = [];
      if (this.#initialized) await this.#operationContext.run(this, async () => {
        try { await this.flushReleases(); } catch (error) { failures.push(error); }
        try { await this.relationDatabase.withConnection(db => db.client.query(`DROP SCHEMA ${q(this.schemaName)} CASCADE`)); }
        catch (error) { failures.push(error); }
      });
      try { if (this.#ownDatabase) await this.relationDatabase.close(); } catch (error) { failures.push(error); }
      this.#closed = true; this.#entries.clear();
      if (failures.length) throw new AggregateError(failures, 'SQL link runtime close failed.');
    })();
    return this.#closePromise;
  }
}
