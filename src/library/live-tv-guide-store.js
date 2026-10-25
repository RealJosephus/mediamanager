import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { orderNativeItemSelection } from '../database/native-relation-order.js';
import { persistMetadataInDatabase } from '../metadata/persistence.js';
import { ItemUpdateType } from '../metadata/save-manager.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { guideProgramId, materializeGuideProgram } from './live-tv-guide-program.js';
import { itemTopParentId } from './item-save-tuple.js';
import { idKey, libraryError } from './records.js';

const emptySelection = () => ({ text: 'SELECT NULL::bigint AS "Ordinal",NULL::uuid AS "SlotKey" WHERE FALSE', values: [] });
const stamp = now => { const value = now(); return typeof value === 'string' ? value : new Date(value).toISOString(); };
async function cleanup(primary, operations) {
  const failures = [];
  for (const operation of operations) try { await operation(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(primary ? [primary, ...failures] : failures,
    primary?.message ?? 'Guide program batch ownership cleanup failed.', primary ? { cause: primary } : undefined);
}

class GuideProgramBatch {
  #closed = false;
  #sealed = false;
  #busy = false;
  #failure;
  #newSaved = false;
  #updatedSaved = false;
  #ordinal = 0n;
  #counts = { existing: 0n, seen: 0n, new: 0n, updated: 0n };
  #flags = { isMovie: false, isSeries: false, isSports: false, isNews: false, isKids: false };

  constructor(options, session, cohort) {
    Object.assign(this, options, { session, cohort });
    const suffix = randomUUID().replaceAll('-', '');
    this.tables = Object.fromEntries(['source', 'initial', 'seen', 'fresh'].map(name => [name, q('mm_guide_' + name + '_' + suffix)]));
  }
  #active() { if (this.#closed) throw libraryError(503, 'Guide program batch has closed.'); }
  #saving() { this.#active(); if (!this.#sealed) throw new TypeError('Consume all guide programs and seal before saving.'); if (this.#failure) throw this.#failure; }
  query(text, values = []) { return this.session.client.query(text, values); }
  get counts() { return Object.freeze({ ...this.#counts }); }
  get flags() { return Object.freeze({ ...this.#flags }); }
  /** Plans are valid only inside the callback that owns this TEMP session. */
  get seenPlan() { this.#active(); return Object.freeze({ text: `SELECT "Ordinal","Id" FROM ${this.tables.seen}`, values: [] }); }
  /** Each getter returns a retained view; the consumer must release it. */
  get newView() { this.#saving(); return this.newOccurrences.retain(); }
  get updatedView() { this.#saving(); return this.updatedOccurrences.retain(); }

  async initialize() {
    const source = buildPostgresItemPageQuery(this.session, { includeitemtypes: ['LiveTvProgram'], channelids: [this.channel.Id] }, { includeOrdinal: true });
    const base = `${q(this.session.schemaName)}.${q('BaseItems')}`, t = this.tables;
    await this.query(`CREATE TEMP TABLE ${t.source} AS SELECT source."__ordinal" AS "Ordinal",item.* FROM (${source.text}) source
      JOIN ${base} item ON item."Id"=source."Id" WHERE source."Id" IS NOT NULL`, source.values);
    await this.query(`CREATE UNIQUE INDEX ON ${t.source}("Ordinal");
      CREATE TEMP TABLE ${t.initial}("Key" text PRIMARY KEY,"SlotKey" uuid NOT NULL);
      CREATE TEMP TABLE ${t.seen}("Ordinal" bigint PRIMARY KEY,"Id" bytea NOT NULL);
      CREATE TEMP TABLE ${t.fresh}("Key" text PRIMARY KEY,"Id" bytea NOT NULL)`);
    const columns = tableDefinition('BaseItems').columns;
    for (let after = 0n; ;) {
      const rows = (await this.query(`/* guide-capture-page */ SELECT * FROM ${t.source} WHERE "Ordinal">$1 ORDER BY "Ordinal" LIMIT 128`, [after])).rows;
      if (!rows.length) break;
      const baseRows = rows.map(row => Object.fromEntries(columns.map(column => [column.name, decodeValue(column, row[column.name], 'postgres')])));
      const state = await this.library.load(this.session, null, { includeUserData: false, includeLinkGraph: false, baseRows });
      let failure;
      try {
        for (const row of rows) {
          const item = state.byId.get(idKey(decodeNativeTextBytes(row.Id, 'runtime')));
          if (!item) continue;
          const slot = await this.cohort.capture(item, { ordinal: BigInt(row.Ordinal) });
          try { await this.query(`INSERT INTO ${t.initial} VALUES($1,$2)`, [idKey(item.Id), slot]); }
          catch (error) {
            if (error.code === '23505') throw libraryError(400, 'An item with the same key has already been added.');
            throw error;
          }
          this.#counts.existing++;
        }
      } catch (error) { failure = error; throw error; }
      finally { await cleanup(failure, [() => state.dispose({ session: this.session })]); }
      after = BigInt(rows.at(-1).Ordinal);
    }
    await this.query(`DROP TABLE ${t.source}`);
    this.newOccurrences = await this.cohort.view({ session: this.session, plan: emptySelection() });
    this.updatedOccurrences = await this.cohort.view({ session: this.session, plan: emptySelection() });
  }

  async consume(info) {
    this.#active();
    if (this.#sealed || this.#busy) throw new TypeError('Guide programs must be consumed serially before sealing.');
    if (this.#failure) throw this.#failure;
    this.#busy = true;
    try {
      const id = guideProgramId(info.Id), prior = (await this.query(`SELECT "SlotKey" FROM ${this.tables.initial} WHERE "Key"=$1`, [idKey(id)])).rows[0];
      const consume = async existing => {
        const result = await materializeGuideProgram(info, { existing, channel: this.channel, now: this.now, metadataChanged: this.metadataChanged });
        const slot = await this.cohort.captureSlot(result.item);
        if (result.isNew) await this.newOccurrences.appendSlot(slot, { ordinal: ++this.#counts.new });
        else if (result.isUpdated) await this.updatedOccurrences.appendSlot(slot, { ordinal: ++this.#counts.updated });
        await this.query(`INSERT INTO ${this.tables.seen} VALUES($1,$2)`, [++this.#ordinal, nativeTextBytes(result.item.Id)]);
        this.#counts.seen++;
        for (const [flag, field] of [['isMovie', 'IsMovie'], ['isSeries', 'IsSeries'], ['isSports', 'IsSports'], ['isNews', 'IsNews'], ['isKids', 'IsKids']]) this.#flags[flag] ||= info[field] === true;
        return Object.freeze({ Id: result.item.Id, isNew: result.isNew, isUpdated: result.isUpdated, SlotKey: slot });
      };
      return prior ? await this.cohort.withSlot(prior.SlotKey, consume) : await consume(null);
    } catch (error) { this.#failure = error; throw error; }
    finally { this.#busy = false; }
  }

  seal() {
    this.#active(); if (this.#busy) throw new TypeError('A guide program consumer is still active.');
    if (this.#failure) throw this.#failure;
    this.#sealed = true; return this;
  }

  async #each(view, operation) {
    await view.flush(); const plan = view.orderedPlan();
    for (let after = 0n; ;) {
      const rows = (await this.query(`/* guide-occurrence-page */ SELECT * FROM (${plan.text}) selected WHERE "Ordinal">$${plan.values.length + 1}
        ORDER BY "Ordinal" LIMIT 128`, [...plan.values, after])).rows;
      if (!rows.length) return;
      for (const row of rows) await view.withSlot(row.SlotKey, item => operation(item, row));
      after = BigInt(rows.at(-1).Ordinal);
    }
  }

  async #winners(view) {
    await view.flush(); const source = view.orderedPlan(), guidKey = nativeTextSql(this.session.schemaName).guidKey;
    return view.view({ session: this.session, plan: { text: `WITH ranked AS (
      SELECT *,row_number() OVER(PARTITION BY ${guidKey('"Id"')} ORDER BY "Ordinal") AS first,
        first_value("SlotKey") OVER(PARTITION BY ${guidKey('"Id"')} ORDER BY "Ordinal" DESC) AS last_slot
      FROM (${source.text}) occurrences)
      SELECT "Ordinal",last_slot AS "SlotKey" FROM ranked WHERE first=1 ORDER BY "Ordinal"`, values: [...source.values] } });
  }

  async #save(view, { signal, register }) {
    const winners = await this.#winners(view); let failure;
    try {
      await this.query(`TRUNCATE ${this.tables.fresh}`);
      await this.store.transaction(async db => {
        await db.client.query('SET CONSTRAINTS ALL DEFERRED');
        await this.#each(winners, async item => {
          const loaded = await this.loadContext(item.Id, { draft: item }); let contextFailure;
          try {
            Object.defineProperty(item, 'NativeTopParentId', { value: itemTopParentId(item, loaded.parents), enumerable: false, writable: true, configurable: true });
            loaded.creationIntent = 'library-save';
            if (!loaded.snapshot) await this.query(`INSERT INTO ${this.tables.fresh} VALUES($1,$2) ON CONFLICT("Key") DO NOTHING`, [idKey(item.Id), nativeTextBytes(item.Id)]);
            await persistMetadataInDatabase(db, loaded, { Item: item }, { signal });
          } catch (error) { contextFailure = error; throw error; }
          finally { await cleanup(contextFailure, [() => loaded.dispose()]); }
        });
        await orderNativeItemSelection(db, { text: `SELECT "Id" FROM ${this.tables.fresh}`, values: [] });
        signal?.throwIfAborted();
      }, { signal });
      // Repository frames and registration become visible only after COMMIT.
      await this.#each(view, async item => {
        const snapshot = (await this.session.rows('BaseItems', { where: { Id: item.Id } }))[0];
        this.library.itemCreation.recordRepositorySnapshot(item, snapshot);
        if (register) this.library.itemCreation.registerItem(item);
      });
    } catch (error) { failure = error; throw error; }
    finally { await cleanup(failure, [() => winners.release()]); }
  }

  async saveNew({ signal } = {}) {
    this.#saving(); if (this.#newSaved) throw new TypeError('New guide programs have already been saved.');
    if (this.#counts.new) await this.store.serializeWrites(() => this.#save(this.newOccurrences, { signal, register: true }), { signal });
    this.#newSaved = true;
  }

  async saveUpdated({ signal } = {}) {
    this.#saving(); if (!this.#newSaved || this.#updatedSaved) throw new TypeError('Save new guide programs once before updated guide programs.');
    if (!this.#counts.updated) { this.#updatedSaved = true; return; }
    await this.store.serializeWrites(async () => {
      // RunMetadataSavers has no request token. Every occurrence observes the
      // same existing slot's latest state, including earlier saver mutations.
      await this.#each(this.updatedOccurrences, async item => {
        const loaded = await this.loadContext(item.Id, { draft: item }); let failure;
        try {
          loaded.parent = this.channel;
          loaded.context.images = item.ImageInfos.map(image => ({ ...image, Blurhash: image.BlurHash == null ? null : Buffer.from(image.BlurHash, 'utf8') }));
          item.DateLastSaved = stamp(this.now);
          await this.updates.runMetadataSavers(loaded, ItemUpdateType.MetadataImport);
          item.DateLastSaved = stamp(this.now);
        } catch (error) { failure = error; throw error; }
        finally { await cleanup(failure, [() => loaded.dispose()]); }
      });
      await this.#save(this.updatedOccurrences, { signal, register: false });
    });
    this.#updatedSaved = true;
  }

  async close(primary) {
    if (this.#closed) return; this.#closed = true;
    await cleanup(primary, [() => this.updatedOccurrences?.release(), () => this.newOccurrences?.release(), () => this.cohort.release(),
      async () => {
        try { for (const name of Object.values(this.tables)) await this.query(`DROP TABLE IF EXISTS ${name}`); }
        catch (error) { this.session.discardConnection(error); throw error; }
      }]);
  }
}

/** Own one channel's captured existing dictionary, mutable typed slots and
 * occurrence lists in PostgreSQL. The callback controls native save/precache
 * phases; merely consuming or sealing never writes business rows. */
export function withGuideProgramBatch(options, operation) {
  const { store, library, linkedChildren, channel, loadContext, updates, metadataChanged } = options ?? {};
  if (typeof store?.run !== 'function' || typeof store?.transaction !== 'function' || typeof library?.load !== 'function'
    || typeof library?.itemCreation?.recordRepositorySnapshot !== 'function' || !linkedChildren || !channel
    || typeof loadContext !== 'function' || typeof updates?.runMetadataSavers !== 'function' || typeof metadataChanged !== 'function' || typeof operation !== 'function') {
    throw new TypeError('Guide program batches require SQL ownership, actual persistence, savers, channel and metadata consumers.');
  }
  return store.run(async session => {
    if (!session.connectionSession || session.inTransaction) throw new TypeError('Guide program capture requires a nontransaction PostgreSQL session.');
    const cohort = await createNativeItemCohort({ linkedChildren, resolveLiveItem: id => library.itemCreation.getCachedItemById(id) });
    const batch = new GuideProgramBatch({ ...options, now: options.now ?? (() => new Date()) }, session, cohort); let failure;
    try { await batch.initialize(); return await operation(batch); }
    catch (error) { failure = error; throw error; }
    finally { await batch.close(failure); }
  });
}
