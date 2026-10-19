import { nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { buildPostgresItemDeletionPlan, deletePostgresItemRowsFromPlan } from '../database/postgres-persistence-query.js';
import { retainedUserDataItemId } from './item-persistence.js';
import { idKey, nonemptyId, sameId } from './records.js';
import { nativeItemDescriptor, nativeItemTypes } from './native-item-entity.js';

// Cacheability follows native constructors rather than stored IsFolder flags.
// MusicArtist remains cacheable in its by-name form.
const cacheableTypes = nativeItemTypes.filter(type => {
  const descriptor = nativeItemDescriptor(type);
  return descriptor.family === 'folder' || descriptor.family === 'video';
});

/** SQL owns the persistence closure. Its initial cache classification remains
 * separate from the final closure observed after file/provider side effects. */
export class ItemDeletionScope {
  constructor({ store, database }) {
    Object.assign(this, { store, database });
    const prefix = 'mm_item_delete_' + randomUUID().replaceAll('-', '');
    this.initial = q(prefix + '_initial'); this.final = q(prefix + '_final');
  }

  #plan(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !nonemptyId(id) || sameId(id, retainedUserDataItemId))) {
      throw new TypeError('Deletion requires nonempty item ids other than the retention placeholder.');
    }
    return {
      text: 'SELECT DISTINCT value AS "Key" FROM unnest($1::text[]) value', values: [[...new Set(ids.map(idKey))]],
    };
  }

  capture(ids) { return this.capturePlan(this.#plan(ids)); }

  async #validatedPlan(idsPlan) {
    const plan = buildPostgresItemDeletionPlan(this.database, idsPlan);
    const invalid = await this.database.client.query({
      text: `SELECT EXISTS (SELECT 1 FROM (${idsPlan.text}) requested
        WHERE requested."Key" IS NULL OR requested."Key" = ''
          OR requested."Key" = ANY($${idsPlan.values.length + 1}::text[])) AS "Invalid"`,
      values: [...idsPlan.values, [idKey('00000000-0000-0000-0000-000000000000'), idKey(retainedUserDataItemId)]],
    });
    if (invalid.rows[0].Invalid) throw new TypeError('Deletion requires nonempty item ids other than the retention placeholder.');
    return plan;
  }

  async capturePlan(idsPlan) {
    const plan = await this.#validatedPlan(idsPlan), table = `${q(this.database.schemaName)}.${q('BaseItems')}`;
    await this.database.client.query({ text: `/* item-deletion-initial */ CREATE TEMP TABLE ${this.initial} AS
      WITH scope AS (${plan.text}) SELECT scope."Key", COALESCE(bool_or(item."Type" = ANY($${plan.values.length + 1}::bytea[])), false) AS "WasCacheable"
      FROM scope LEFT JOIN ${table} item ON ${nativeTextSql(this.database.schemaName).guidKey('item."Id"')} = scope."Key"
      GROUP BY scope."Key"`, values: [...plan.values, cacheableTypes.map(nativeTextBytes)] });
    await this.database.client.query(`CREATE UNIQUE INDEX ON ${this.initial} ("Key")`);
    this.count = Number((await this.database.client.query(`SELECT count(*) AS "Count" FROM ${this.initial}`)).rows[0].Count);
    if (!Number.isSafeInteger(this.count)) throw new Error('PostgreSQL returned an invalid deletion scope count.');
  }

  persist(ids, options) { return this.persistPlan(this.#plan(ids), options); }

  async persistPlan(idsPlan, { now, publishDeletedPage }) {
    const plan = await this.#validatedPlan(idsPlan);
    await this.database.client.query({ text: `/* item-deletion-final */ CREATE TEMP TABLE ${this.final} AS ${plan.text}`, values: plan.values });
    await this.database.client.query(`CREATE UNIQUE INDEX ON ${this.final} ("Key")`);
    await this.store.transaction(db => deletePostgresItemRowsFromPlan(db, {
      text: `SELECT "Key" FROM ${this.final}`, values: [],
    }, { retainedItemId: retainedUserDataItemId, retentionDate: now() }));
    let previous = '';
    while (true) {
      const page = (await this.database.client.query({ text: `/* item-deletion-committed-page */
        SELECT deleted."Key", initial."WasCacheable" IS TRUE AS "WasCacheable"
        FROM ${this.final} deleted LEFT JOIN ${this.initial} initial ON initial."Key" = deleted."Key"
        WHERE deleted."Key" COLLATE "C" > $1 COLLATE "C" ORDER BY deleted."Key" COLLATE "C" LIMIT 128`, values: [previous] })).rows;
      if (!page.length) return;
      await publishDeletedPage(page);
      previous = page.at(-1).Key;
      if (page.length < 128) return;
    }
  }

  close() { return this.database.client.query(`DROP TABLE IF EXISTS ${this.final}, ${this.initial}`); }
}
