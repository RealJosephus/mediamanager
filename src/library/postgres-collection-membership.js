import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes, decodeNativeTextBytes, nativeRatingCountryContext } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { nativeGuid } from '../users/native.js';
import { idKey, libraryError } from './records.js';
import { assertPostgresLinkedResolutionInput, createPostgresLinkedResolutionWorkspace } from './postgres-linked-resolution-workspace.js';

const pageSize = 128;
const table = (db, name) => `${q(db.schemaName)}.${q(name)}`;
const plan = text => Object.freeze({ text, values: Object.freeze([]) });
const decode = value => value == null ? null : decodeNativeTextBytes(value);
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
  assertPostgresLinkedResolutionInput(db, linksPlan);
  const key = nativeTextSql(db.schemaName), suffix = randomUUID().replaceAll('-', '');
  const requests = q('mm_collection_requests_' + suffix);
  const items = table(db, 'BaseItems');
  const parent = (await db.client.query({ text: `SELECT "Id" FROM ${items}
    WHERE ${key.guidKey('"Id"')} = $1 LIMIT 1`, values: [idKey(nativeGuid(collectionId))] })).rows[0];
  if (!parent) throw libraryError(400, 'No collection exists with the supplied collectionId ' + collectionId);
  const resolution = await createPostgresLinkedResolutionWorkspace(db, { linksPlan });
  const raw = resolution.sqlRelation();
  let closing, prepared = false, requestTable = false, appended = false;
  const active = () => { if (closing) throw new Error('Collection membership has been disposed.'); };
  const dispose = primary => closing ??= (async () => {
    const errors = [];
    try { await db.client.query(`DROP TABLE IF EXISTS ${requests}`); }
    catch (error) {
      if (!(primary && db.inTransaction && error.code === '25P02')) {
        db.discardConnection(error); errors.push(error);
      }
    }
    try { await resolution.dispose(primary); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Collection membership cleanup failed.');
  })();
  const page = async (source, options) => {
    active(); const { after, limit } = cursor(options), index = source.values.length;
    return (await db.client.query({ text: `SELECT * FROM (${source.text}) source
      WHERE "Ordinal" > $${index + 1} ORDER BY "Ordinal" LIMIT $${index + 2}`,
    values: [...source.values, after, limit] })).rows;
  };
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
    prepared = true; resolution.sealResolution(); return addCount();
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
  return Object.freeze({
    dispose, resolution, eventPlan,
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
      prepared = true; resolution.sealResolution();
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
    try { await membership.dispose(failure); }
    catch (cleanup) { if (failure) throw new AggregateError([failure, cleanup], failure.message, { cause: failure }); throw cleanup; }
  }
}
