import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextBytes, decodeNativeTextBytes, nativeRatingCountryContext } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { nativeGuid } from '../users/native.js';
import { idKey, libraryError, EMPTY_ID } from './records.js';

const pageSize = 128;
const table = (db, name) => `${q(db.schemaName)}.${q(name)}`;
const plan = text => Object.freeze({ text, values: Object.freeze([]) });
const decode = value => value == null ? null : decodeNativeTextBytes(value);
const encode = value => value == null ? null : nativeTextBytes(value);
function checkedSession(db) {
  if (db?.dialect !== 'postgres' || !db.connectionSession || typeof db.client?.query !== 'function') {
    throw new TypeError('Collection membership requires a checked-out PostgreSQL session.');
  }
}
function checkedPlan(source) {
  if (!source || typeof source.text !== 'string' || !Array.isArray(source.values)) {
    throw new TypeError('Collection membership requires a SQL relation with bound values.');
  }
}
function cursor({ after = 0n, limit = pageSize } = {}) {
  if (typeof after !== 'bigint' || after < 0n || !Number.isSafeInteger(limit) || limit < 1 || limit > pageSize) {
    throw new TypeError('Collection membership pages require a bigint cursor and a limit from 1 to 128.');
  }
  return { after, limit };
}
function count(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RangeError('Invalid collection membership count.');
  return number;
}

/** Operation TEMP rows are private to this checked-out session. Retained live
 * links and events must be published into the shared relation before disposal.
 * All native TEXT cells, including GUIDs and paths, are bytea at SQL boundaries. */
export async function createPostgresCollectionMembership(db, { collectionId, linksPlan }) {
  checkedSession(db); checkedPlan(linksPlan);
  const key = nativeTextSql(db.schemaName), suffix = randomUUID().replaceAll('-', '');
  const raw = q('mm_collection_raw_' + suffix), requests = q('mm_collection_requests_' + suffix);
  const batch = q('mm_collection_batch_' + suffix);
  const items = table(db, 'BaseItems');
  const parent = (await db.client.query({ text: `SELECT "Id" FROM ${items}
    WHERE ${key.guidKey('"Id"')} = $1 LIMIT 1`, values: [idKey(nativeGuid(collectionId))] })).rows[0];
  if (!parent) throw libraryError(400, 'No collection exists with the supplied collectionId ' + collectionId);
  let disposed = false, prepared = false, requestTable = false, appended = false, batched = false;
  const active = () => { if (disposed) throw new Error('Collection membership has been disposed.'); };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await db.client.query(`DROP TABLE IF EXISTS ${requests}, ${batch}, ${raw}`);
  };
  const page = async (source, options) => {
    active(); const { after, limit } = cursor(options), index = source.values.length;
    return (await db.client.query({ text: `SELECT * FROM (${source.text}) source
      WHERE "Ordinal" > $${index + 1} ORDER BY "Ordinal" LIMIT $${index + 2}`,
    values: [...source.values, after, limit] })).rows;
  };
  const rawPlan = () => { active(); return plan(`SELECT "Ordinal", "ItemId", "Type", "Path", "LibraryItemId" FROM ${raw}`); };
  const decodeBaseRow = row => Object.fromEntries(tableDefinition('BaseItems').columns
    .map(column => [column.name, decodeValue(column, row[column.name], 'postgres')]));
  const createRequests = async () => {
    active(); if (requestTable) throw new Error('A collection operation can prepare requests only once.');
    await db.client.query(`CREATE TEMP TABLE ${requests} (
      "Ordinal" bigint PRIMARY KEY CHECK ("Ordinal" > 0), "Id" bytea NOT NULL,
      "ResolvedId" bytea, "SlotKey" uuid, "Addition" boolean NOT NULL DEFAULT FALSE,
      "RemoveOrdinal" bigint)`);
    requestTable = true;
  };
  const addCount = async () => count((await db.client.query(`SELECT count(*) AS "Count" FROM ${requests} WHERE "Addition"`)).rows[0].Count);
  const markAdditions = async () => {
    await db.client.query(`UPDATE ${requests} request SET "Addition" = NOT EXISTS (
      SELECT 1 FROM ${raw} initial WHERE initial."ResolvedId" IS NOT NULL
        AND ${key.guidKey('initial."ResolvedId"')} = ${key.guidKey('request."Id"')})`);
    prepared = true; return addCount();
  };
  const resolve = async (requested, ordinal, resolveMember) => {
    const id = nativeGuid(requested), resolved = await resolveMember(id, { ordinal });
    if (!resolved) throw libraryError(400, 'No item exists with the supplied Id ' + id);
    return { id, ...resolved };
  };
  const eventPlan = () => {
    active(); if (!prepared) throw new Error('Collection requests have not been prepared.');
    return plan(`SELECT "Ordinal", "SlotKey" FROM ${requests}
      WHERE "Addition" ORDER BY "Ordinal"`);
  };
  try {
    await db.client.query(`CREATE TEMP TABLE ${raw} (
      "Ordinal" bigint PRIMARY KEY CHECK ("Ordinal" > 0), "ItemId" bytea, "Type" integer NOT NULL,
      "Path" bytea, "LibraryItemId" bytea, "ResolvedId" bytea, "SlotKey" uuid)`);
    await db.client.query({ text: `INSERT INTO ${raw} ("Ordinal", "ItemId", "Type", "Path", "LibraryItemId")
      SELECT "Ordinal", "ItemId", "Type", "Path", "LibraryItemId"
      FROM (${linksPlan.text}) source ORDER BY "Ordinal"`, values: linksPlan.values });
    await db.client.query(`CREATE INDEX ON ${raw} ((${key.guidKey('"ResolvedId"')}))`);
  } catch (error) {
    try { await dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); }
    throw error;
  }

  return Object.freeze({
    dispose, linksPlan: rawPlan, eventPlan,
    resolvedItemsPlan() {
      active();
      return plan(`SELECT "Ordinal", "SlotKey", "ResolvedId" AS "Id" FROM ${raw}
        WHERE "ResolvedId" IS NOT NULL ORDER BY "Ordinal"`);
    },
    initialIdsPlan() {
      active();
      return plan(`SELECT DISTINCT "ItemId" AS "Id" FROM ${raw} WHERE "ItemId" IS NOT NULL
        AND ${key.guidKey('"ItemId"')} <> '${idKey(EMPTY_ID)}'`);
    },
    async captureInitialBatch(selection, { capturePage } = {}) {
      active(); checkedPlan(selection);
      if (typeof capturePage !== 'function') throw new TypeError('Initial repository hydration requires a typed page capture.');
      if (batched || prepared) throw new Error('Initial collection lookup is captured only once, before request validation.');
      await db.client.query({ text: `CREATE TEMP TABLE ${batch} AS
        SELECT selected."__ordinal" AS "BatchOrdinal", NULL::uuid AS "SlotKey", item.* FROM (${selection.text}) selected
        JOIN ${items} item ON item."Id" = selected."Id"`, values: selection.values });
      await db.client.query(`CREATE INDEX ON ${batch} ((${key.guidKey('"Id"')}));
        CREATE INDEX ON ${batch} ("BatchOrdinal")`);
      // Native ResolveLinkedChildren deserializes the entire positive-ID
      // repository batch before its first fallback. A malformed late item
      // must therefore fail before any earlier fallback cache publication.
      for (let after = 0n; ; ) {
        const rows = (await db.client.query({ text: `SELECT * FROM ${batch}
          WHERE "BatchOrdinal" > $1 ORDER BY "BatchOrdinal" LIMIT ${pageSize}`, values: [after] })).rows;
        if (!rows.length) break;
        await capturePage(rows.map(row => ({ ordinal: BigInt(row.BatchOrdinal), baseRow: decodeBaseRow(row) })),
          async (ordinal, slotKey) => {
            if (typeof slotKey !== 'string') throw new TypeError('A captured native repository slot is required.');
            const result = await db.client.query(`UPDATE ${batch} SET "SlotKey"=$2 WHERE "BatchOrdinal"=$1`, [ordinal, slotKey]);
            if (result.rowCount !== 1) throw new Error('The initial repository row is absent.');
          });
        after = BigInt(rows.at(-1).BatchOrdinal);
      }
      batched = true;
    },
    async initialSlot(id) {
      active(); if (!batched) throw new Error('Initial positive-ID collection lookup must be fully captured first.');
      const row = (await db.client.query({ text: `SELECT "Id", "SlotKey" FROM ${batch}
        WHERE ${key.guidKey('"Id"')} = $1 ORDER BY "BatchOrdinal" DESC LIMIT 1`, values: [idKey(id)] })).rows[0];
      return row?.SlotKey ? { id: decode(row.Id), slotKey: row.SlotKey } : null;
    },
    async readLinksPage(options) {
      return (await page(rawPlan(), options)).map(row => ({ ...row, Ordinal: BigInt(row.Ordinal),
        ItemId: decode(row.ItemId), Path: decode(row.Path), LibraryItemId: decode(row.LibraryItemId) }));
    },
    async count() { active(); return count((await db.client.query(`SELECT count(*) AS "Count" FROM ${raw}`)).rows[0].Count); },
    async recordResolution(ordinal, { itemId, resolvedId = null, slotKey = null }) {
      active(); if (prepared) throw new Error('Initial resolution must precede requests.');
      cursor({ after: ordinal });
      const result = await db.client.query({ text: `UPDATE ${raw} SET "ItemId" = $2,
        "ResolvedId" = $3, "SlotKey" = $4 WHERE "Ordinal" = $1`,
      values: [ordinal, encode(itemId),
        resolvedId == null ? null : nativeTextBytes(nativeGuid(resolvedId)), slotKey] });
      if (result.rowCount !== 1) throw new Error('Collection resolution refers to an absent raw link.');
    },
    async prepareAddFromQuery(source, { resolveMember }) {
      active(); checkedPlan(source); await createRequests();
      await db.client.query({ text: `INSERT INTO ${requests} ("Ordinal", "Id")
        SELECT "Ordinal", "Id" FROM (${source.text}) source ORDER BY "Ordinal"`, values: source.values });
      for (let after = 0n; ; ) {
        const rows = await page(plan(`SELECT "Ordinal", "Id" FROM ${requests}`), { after });
        if (!rows.length) break;
        for (const row of rows) {
          const { resolvedId, slotKey } = await resolve(decode(row.Id), BigInt(row.Ordinal), resolveMember);
          await db.client.query({ text: `UPDATE ${requests} SET "ResolvedId" = $2,
            "SlotKey" = $3 WHERE "Ordinal" = $1`,
          values: [row.Ordinal, nativeTextBytes(nativeGuid(resolvedId)), slotKey] });
        }
        after = BigInt(rows.at(-1).Ordinal);
      }
      return markAdditions();
    },
    /** Parse and look up each input before advancing its iterator. A later
     * invalid GUID must not erase the earlier native lookup/cache prefix. */
    async prepareAddFromIterable(ids, { resolveMember }) {
      await createRequests(); let ordinal = 0n, rows = [];
      const flush = async () => {
        if (!rows.length) return;
        await db.client.query({ text: `INSERT INTO ${requests} ("Ordinal", "Id", "ResolvedId", "SlotKey")
          SELECT * FROM unnest($1::bigint[], $2::bytea[], $3::bytea[], $4::uuid[])`,
        values: [rows.map(row => row.ordinal), rows.map(row => row.id), rows.map(row => row.resolved), rows.map(row => row.slotKey)] });
        rows = [];
      };
      for (const value of ids) {
        ordinal++;
        const { id, resolvedId, slotKey } = await resolve(value, ordinal, resolveMember);
        rows.push({ ordinal, id: nativeTextBytes(id), resolved: nativeTextBytes(nativeGuid(resolvedId)), slotKey });
        if (rows.length === pageSize) await flush();
      }
      await flush(); return markAdditions();
    },
    async appendAdditions() {
      active(); if (!prepared || appended) throw new Error('Collection additions must be prepared and appended once.');
      await db.client.query(`INSERT INTO ${raw} ("Ordinal", "ItemId", "Type", "ResolvedId", "SlotKey")
        SELECT (SELECT COALESCE(max("Ordinal"), 0) FROM ${raw}) + row_number() OVER (ORDER BY "Ordinal"),
          "ResolvedId", 0, "ResolvedId", "SlotKey" FROM ${requests} WHERE "Addition" ORDER BY "Ordinal"`);
      appended = true;
    },
    /** Removal does not resolve or mutate the existing link cache. Each input
     * performs its item lookup before selecting the first original raw link.
     * Duplicate requests repeat event entries but remove that first link once. */
    async prepareRemoveFromIterable(ids, { withMember, captureItem, warnMissing }) {
      await createRequests(); let ordinal = 0n;
      for (const value of ids) {
        const requested = nativeGuid(value);
        await withMember(requested, async item => {
          const child = (await db.client.query({ text: `SELECT "Ordinal" FROM ${raw}
            WHERE "ItemId" IS NOT NULL AND ${key.guidKey('"ItemId"')} = $1 ORDER BY "Ordinal" LIMIT 1`, values: [idKey(requested)] })).rows[0];
          if (!child) { warnMissing?.(); return; }
          ordinal++;
          const slotKey = item ? await captureItem(item, { ordinal, session: db }) : null;
          await db.client.query({ text: `INSERT INTO ${requests} ("Ordinal", "Id", "ResolvedId", "Addition", "RemoveOrdinal", "SlotKey")
            VALUES ($1, $2, $3, $4, $5, $6)`, values: [ordinal, nativeTextBytes(requested),
            item ? nativeTextBytes(nativeGuid(item.Id)) : null, item != null, child.Ordinal, slotKey] });
        });
      }
      const result = await db.client.query(`DELETE FROM ${raw} WHERE "Ordinal" IN (SELECT "RemoveOrdinal" FROM ${requests})`);
      prepared = true;
      return { removed: result.rowCount, eventCount: await addCount() };
    },
    async selectOfficialRating({ ratingsPlan, metadataCountryCode, defaultCountryCode = 'US' } = {}) {
      active();
      checkedPlan(ratingsPlan);
      const offset = ratingsPlan.values.length;
      const country = '$' + (offset + 1) + '::jsonb';
      const result = await db.client.query({ text: `WITH first_ratings AS MATERIALIZED (
        SELECT DISTINCT ON (${key.ordinalIgnoreCaseKey('captured."OfficialRating"')}) raw."Ordinal", captured."OfficialRating" AS "Rating"
        FROM ${raw} raw JOIN (${ratingsPlan.text}) captured ON captured."SlotKey" = raw."SlotKey"
        WHERE raw."ResolvedId" IS NOT NULL AND captured."OfficialRating" IS NOT NULL AND octet_length(captured."OfficialRating") > 0
        ORDER BY ${key.ordinalIgnoreCaseKey('captured."OfficialRating"')}, raw."Ordinal"
      ), scored AS MATERIALIZED (SELECT *, ${key.ratingScore('"Rating"', country)} AS "Score" FROM first_ratings)
      SELECT "Rating" FROM scored ORDER BY CASE WHEN "Score" IS NULL THEN 1001 ELSE "Score"[1] END,
        CASE WHEN "Score" IS NULL THEN 1001 ELSE "Score"[2] END NULLS FIRST, "Ordinal" LIMIT 1`,
      values: [...ratingsPlan.values, nativeRatingCountryContext(metadataCountryCode ?? null, defaultCountryCode)] });
      return result.rows[0] ? decode(result.rows[0].Rating) : undefined;
    }
  });
}

export async function withPostgresCollectionMembership(db, options, operation) {
  const membership = await createPostgresCollectionMembership(db, options);
  let failure;
  try { return await operation(membership); }
  catch (error) { failure = error; throw error; }
  finally {
    try { await membership.dispose(); }
    catch (cleanup) { if (failure) throw new AggregateError([failure, cleanup], failure.message, { cause: failure }); throw cleanup; }
  }
}
