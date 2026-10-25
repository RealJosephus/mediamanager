import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { nativeGuid } from '../users/native.js';
import { idKey, EMPTY_ID } from './records.js';

const pageSize = 128;
const plan = text => Object.freeze({ text, values: Object.freeze([]) });
const decode = value => value == null ? null : decodeNativeTextBytes(value);
const encode = value => value == null ? null : nativeTextBytes(value);

export function assertPostgresLinkedResolutionInput(session, source) {
  if (session?.dialect !== 'postgres' || !session.connectionSession || typeof session.client?.query !== 'function') {
    throw new TypeError('Linked resolution requires a checked-out PostgreSQL session.');
  }
  if (!source || typeof source.text !== 'string' || !Array.isArray(source.values)) {
    throw new TypeError('Linked resolution requires a SQL relation with bound values.');
  }
}

function cursor({ after = 0n, limit = pageSize } = {}) {
  if (typeof after !== 'bigint' || after < 0n || !Number.isSafeInteger(limit) || limit < 1 || limit > pageSize) {
    throw new TypeError('Linked resolution pages require a bigint cursor and a limit from 1 to 128.');
  }
  return { after, limit };
}

/** Own only the SQL raw relation and complete positive-ID lookup batch. Parent
 * existence and collection mutations belong to their business consumer. */
export async function createPostgresLinkedResolutionWorkspace(session, { linksPlan }) {
  assertPostgresLinkedResolutionInput(session, linksPlan);
  const key = nativeTextSql(session.schemaName), suffix = randomUUID().replaceAll('-', '');
  const raw = q('mm_link_resolution_raw_' + suffix), batch = q('mm_link_resolution_batch_' + suffix);
  const items = `${q(session.schemaName)}.${q('BaseItems')}`;
  let closing, batched = false, captureStarted = false, sealed = false;
  const active = () => { if (closing) throw new Error('The linked resolution workspace has been disposed.'); };
  const dispose = primary => closing ??= (async () => {
    try { await session.client.query(`DROP TABLE IF EXISTS ${batch}, ${raw}`); }
    catch (error) {
      // The owning transaction rolls back the TEMP creation after its original
      // query failure. A real DROP failure must never return TEMP rows to a pool.
      if (primary && session.inTransaction && error.code === '25P02') return;
      session.discardConnection(error); throw error;
    }
  })();
  const rawPlan = () => {
    active(); return plan(`SELECT "Ordinal", "ItemId", "Type", "Path", "LibraryItemId" FROM ${raw}`);
  };
  const decodeBaseRow = row => Object.fromEntries(tableDefinition('BaseItems').columns
    .map(column => [column.name, decodeValue(column, row[column.name], 'postgres')]));
  try {
    await session.client.query(`CREATE TEMP TABLE ${raw} (
      "Ordinal" bigint PRIMARY KEY CHECK ("Ordinal" > 0), "ItemId" bytea, "Type" integer NOT NULL,
      "Path" bytea, "LibraryItemId" bytea, "ResolvedId" bytea, "SlotKey" uuid)`);
    await session.client.query({ text: `INSERT INTO ${raw} ("Ordinal", "ItemId", "Type", "Path", "LibraryItemId")
      SELECT "Ordinal", "ItemId", "Type", "Path", "LibraryItemId"
      FROM (${linksPlan.text}) source ORDER BY "Ordinal"`, values: linksPlan.values });
    await session.client.query(`CREATE INDEX ON ${raw} ((${key.guidKey('"ResolvedId"')}))`);
  } catch (error) {
    try { await dispose(error); } catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
    throw error;
  }
  return Object.freeze({
    dispose, linksPlan: rawPlan,
    /** This trusted quoted TEMP descriptor belongs to this session and owner.
     * Collection SQL mutates it directly; no second raw relation is introduced. */
    sqlRelation() { active(); return raw; },
    sealResolution() { active(); sealed = true; },
    resolvedItemsPlan() {
      active(); return plan(`SELECT "Ordinal", "SlotKey", "ResolvedId" AS "Id" FROM ${raw}
        WHERE "ResolvedId" IS NOT NULL ORDER BY "Ordinal"`);
    },
    initialIdsPlan() {
      active(); return plan(`SELECT DISTINCT "ItemId" AS "Id" FROM ${raw} WHERE "ItemId" IS NOT NULL
        AND ${key.guidKey('"ItemId"')} <> '${idKey(EMPTY_ID)}'`);
    },
    async captureInitialBatch(selection, { capturePage } = {}) {
      active(); assertPostgresLinkedResolutionInput(session, selection);
      if (typeof capturePage !== 'function') throw new TypeError('Initial repository hydration requires a typed page capture.');
      if (captureStarted || sealed) throw new Error('Initial linked lookup is captured only once, before mutation requests.');
      captureStarted = true;
      await session.client.query({ text: `CREATE TEMP TABLE ${batch} AS
        SELECT selected."__ordinal" AS "BatchOrdinal", NULL::uuid AS "SlotKey", item.* FROM (${selection.text}) selected
        JOIN ${items} item ON item."Id" = selected."Id"`, values: selection.values });
      await session.client.query(`CREATE INDEX ON ${batch} ((${key.guidKey('"Id"')}));
        CREATE INDEX ON ${batch} ("BatchOrdinal")`);
      // Native resolves and deserializes the complete repository batch before
      // any raw occurrence can publish its fallback cache prefix.
      for (let after = 0n; ;) {
        const rows = (await session.client.query({ text: `SELECT * FROM ${batch}
          WHERE "BatchOrdinal" > $1 ORDER BY "BatchOrdinal" LIMIT ${pageSize}`, values: [after] })).rows;
        if (!rows.length) break;
        await capturePage(rows.map(row => ({ ordinal: BigInt(row.BatchOrdinal), baseRow: decodeBaseRow(row) })),
          async (ordinal, slotKey) => {
            if (typeof slotKey !== 'string') throw new TypeError('A captured native repository slot is required.');
            const result = await session.client.query(`UPDATE ${batch} SET "SlotKey"=$2 WHERE "BatchOrdinal"=$1`, [ordinal, slotKey]);
            if (result.rowCount !== 1) throw new Error('The initial repository row is absent.');
          });
        after = BigInt(rows.at(-1).BatchOrdinal);
      }
      batched = true;
    },
    async initialSlot(id) {
      active(); if (!batched) throw new Error('The positive-ID linked lookup must be fully captured first.');
      const row = (await session.client.query({ text: `SELECT "Id", "SlotKey" FROM ${batch}
        WHERE ${key.guidKey('"Id"')}=$1 ORDER BY "BatchOrdinal" DESC LIMIT 1`, values: [idKey(id)] })).rows[0];
      return row?.SlotKey ? { id: decode(row.Id), slotKey: row.SlotKey } : null;
    },
    async readLinksPage(options) {
      active(); const { after, limit } = cursor(options);
      return (await session.client.query({ text: `SELECT * FROM ${raw} WHERE "Ordinal">$1 ORDER BY "Ordinal" LIMIT $2`,
        values: [after, limit] })).rows.map(row => ({ ...row, Ordinal: BigInt(row.Ordinal),
        ItemId: decode(row.ItemId), Path: decode(row.Path), LibraryItemId: decode(row.LibraryItemId) }));
    },
    async count() {
      active(); const count = Number((await session.client.query(`SELECT count(*) AS "Count" FROM ${raw}`)).rows[0].Count);
      if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Invalid linked resolution count.');
      return count;
    },
    async recordResolution(ordinal, { itemId, resolvedId = null, slotKey = null }) {
      active(); if (sealed) throw new Error('Initial linked resolution must precede mutation requests.');
      cursor({ after: ordinal });
      const result = await session.client.query({ text: `UPDATE ${raw} SET "ItemId"=$2,
        "ResolvedId"=$3, "SlotKey"=$4 WHERE "Ordinal"=$1`,
      values: [ordinal, encode(itemId), resolvedId == null ? null : nativeTextBytes(nativeGuid(resolvedId)), slotKey] });
      if (result.rowCount !== 1) throw new Error('Linked resolution refers to an absent raw link.');
    },
  });
}
