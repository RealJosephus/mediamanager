import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { nativeItemDescriptor } from './native-item-entity.js';
import { idKey } from './records.js';

export function yearsFailure(reasons) {
  if (reasons.length === 1) return reasons[0];
  const primary = reasons[0];
  let message = 'Year source cleanup failed.';
  try { if (primary instanceof Error && typeof primary.message === 'string') message = primary.message; } catch { /* Keep the real reason. */ }
  const failure = new AggregateError(reasons, message, { cause: primary });
  for (const key of ['code', 'status', 'statusCode']) {
    try { if (primary != null && Object.hasOwn(primary, key)) failure[key] = primary[key]; } catch { /* Diagnostics do not replace failures. */ }
  }
  return failure;
}

const checkedCount = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid Year source count.');
  return number;
};

const clientKind = item => item.IsFolder && item.SourceType === 'Channel' && !['Channel', 'Season', 'Series'].includes(item.Type)
  ? 'ChannelFolderItem' : item.Type === 'PlaylistsFolder' ? 'ManualPlaylistsFolder' : item.Type;

/** Own YearsController's occurrence source, traversal queue and Guid winners.
 * Typed objects cross the SQL boundary only in bounded pages; the cohort
 * retains their live values until extraction has consumed every winner. */
export async function createPostgresYearsSource(database, {
  linkedChildren, mode, includeItemTypes = [], excludeItemTypes = [], mediaTypes = [], signal, resolveSourceSlot,
}) {
  if (database?.dialect !== 'postgres' || !database.connectionSession || database.inTransaction) {
    throw new TypeError('Year traversal requires an admitted nontransaction PostgreSQL session.');
  }
  if (!['user-recursive', 'user-direct', 'user-playlist', 'user-playlist-direct', 'userless-recursive', 'userless-direct', 'leaf', 'user-view'].includes(mode)) {
    throw new TypeError('Unknown Year traversal mode.');
  }
  const suffix = randomUUID().replaceAll('-', '');
  const queue = q('mm_year_queue_' + suffix), visited = q('mm_year_visited_' + suffix);
  const occurrences = q('mm_year_occurrences_' + suffix), winners = q('mm_year_winners_' + suffix), years = q('mm_year_values_' + suffix);
  const sql = nativeTextSql(database.schemaName), tables = [winners, years, occurrences, visited, queue];
  let cohort, ordinal = 0n, attempted = false, sealed = false, closing;
  const active = () => { if (closing) throw new Error('The Year source is closed.'); signal?.throwIfAborted(); };
  const close = ({ failed = false } = {}) => closing ??= (async () => {
    const failures = [];
    if (attempted) for (const table of tables) try { await database.client.query(`DROP TABLE IF EXISTS ${table}`); }
    catch (reason) {
      if (!(failed && database.inTransaction && reason?.code === '25P02')) failures.push(reason);
    }
    try { await cohort?.release(); } catch (reason) { failures.push(reason); }
    try { await linkedChildren.flushReleases({ session: database }); } catch (reason) { failures.push(reason); }
    if (failures.length) {
      database.discardConnection(failures[0]); throw yearsFailure(failures);
    }
  })();
  try {
    active();
    cohort = await createNativeItemCohort({ linkedChildren, resolveSourceSlot });
    attempted = true;
    await database.client.query(`CREATE TEMP TABLE ${queue}(path bigint[] PRIMARY KEY,slot uuid NOT NULL,id text NOT NULL,kind text NOT NULL,done boolean NOT NULL DEFAULT FALSE);
      CREATE TEMP TABLE ${visited}(id text PRIMARY KEY);
      CREATE TEMP TABLE ${occurrences}(ordinal bigint PRIMARY KEY,frame uuid NOT NULL,path bigint[] NOT NULL,
        slot uuid NOT NULL,id bytea NOT NULL,kind bytea NOT NULL,runtime_kind bytea NOT NULL,media_type bytea,folder boolean NOT NULL,
        visible boolean NOT NULL,eligible boolean NOT NULL DEFAULT TRUE,matched boolean NOT NULL DEFAULT FALSE);
      CREATE TEMP TABLE ${years}(year integer PRIMARY KEY,position bigint NOT NULL)`);
    const append = async (items, paths, { frame = randomUUID(), visible = !mode.startsWith('user-'), sourceKinds } = {}) => {
      active(); if (sealed) throw new Error('The Year source is already sealed.');
      if (!Array.isArray(items) || !items.length || items.length > 128 || paths.length !== items.length) throw new TypeError('Year occurrences require 1..128 typed items and paths.');
      const slots = await cohort.captureSlots(items);
      active();
      const rows = items.map((item, index) => ({ ordinal: ++ordinal,
        frame, path: paths[index], slot: slots[index], id: nativeTextBytes(item.Id),
        kind: nativeTextBytes(clientKind(item)), runtimeKind: nativeTextBytes(item.Type), media: item.MediaType == null ? null : nativeTextBytes(String(item.MediaType)),
        folder: Boolean(item.IsFolder && nativeItemDescriptor(item.NativeType).family === 'folder'), visible }));
      await database.client.query({ text: `INSERT INTO ${occurrences}(ordinal,frame,path,slot,id,kind,runtime_kind,media_type,folder,visible)
        VALUES ${rows.map((_, index) => '(' + Array.from({ length: 10 }, (_, column) =>
          '$' + (index * 10 + column + 1) + (column === 2 ? '::bigint[]' : '')).join(',') + ')').join(',')}`,
      values: rows.flatMap(row => [row.ordinal, row.frame, row.path, row.slot, row.id, row.kind, row.runtimeKind, row.media, row.folder, row.visible]) });
      if (sourceKinds) await database.client.query(`UPDATE ${occurrences} SET eligible=runtime_kind=ANY($2::bytea[])
        WHERE ordinal=ANY($1::bigint[])`, [rows.map(row => row.ordinal), sourceKinds.map(nativeTextBytes)]);
      await database.client.query({ text: `UPDATE ${occurrences} SET matched=${mode === 'user-view' ? 'TRUE' : `
        (cardinality($2::bytea[])=0 OR kind=ANY($2)) AND NOT(kind=ANY($3::bytea[]))
        AND (cardinality($4::bytea[])=0 OR media_type=ANY($4))`} WHERE ordinal=ANY($1::bigint[])`,
      values: mode === 'user-view' ? [rows.map(row => row.ordinal)]
        : [rows.map(row => row.ordinal), includeItemTypes.map(nativeTextBytes), excludeItemTypes.map(nativeTextBytes), mediaTypes.map(nativeTextBytes)] });
      return rows.map(row => ({ ordinal: row.ordinal, slot: row.slot, id: decodeNativeTextBytes(row.id), folder: row.folder }));
    };
    return Object.freeze({ close, append,
      async capture(item) { active(); return cohort.captureSlot(item); },
      async withSlot(slot, operation) { active(); return cohort.withSlot(slot, operation); },
      async enqueue({ path, slot, id, kind = 'folder' }) {
        active(); await database.client.query(`INSERT INTO ${queue}(path,slot,id,kind) VALUES($1,$2,$3,$4)`, [path, slot, idKey(id), kind]);
      },
      async next() {
        active();
        for (;;) {
          const row = (await database.client.query(`SELECT path,slot,id,kind FROM ${queue} WHERE NOT done ORDER BY path LIMIT 1`)).rows[0];
          if (!row) return null;
          await database.client.query(`UPDATE ${queue} SET done=TRUE WHERE path=$1`, [row.path]);
          if (mode === 'user-recursive' && row.kind === 'folder'
            && !(await database.client.query(`INSERT INTO ${visited}(id) VALUES($1) ON CONFLICT DO NOTHING`, [row.id])).rowCount) continue;
          return { ...row, path: row.path.map(BigInt) };
        }
      },
      async framePage(frame, after = 0n) {
        active(); return (await database.client.query(`SELECT ordinal,slot FROM ${occurrences}
          WHERE frame=$1 AND ordinal>$2 AND eligible ORDER BY ordinal LIMIT 128`, [frame, after])).rows.map(row => ({ ordinal: BigInt(row.ordinal), slot: row.slot }));
      },
      async setVisible(rows, mask) {
        active(); if (rows.length > 128 || rows.length !== mask.length || mask.some(value => typeof value !== 'boolean')) throw new TypeError('Year visibility needs one decision per bounded occurrence.');
        if (!rows.length) return;
        await database.client.query(`UPDATE ${occurrences} source SET visible=decision.visible FROM
          unnest($1::bigint[],$2::boolean[]) decision(ordinal,visible) WHERE source.ordinal=decision.ordinal`, [rows.map(row => row.ordinal), mask]);
      },
      async folders(frame, after = 0n) {
        active(); return (await database.client.query(`SELECT ordinal,slot,id,path FROM ${occurrences}
          WHERE frame=$1 AND ordinal>$2 AND eligible AND visible AND folder ORDER BY ordinal LIMIT 128`, [frame, after])).rows
          .map(row => ({ ordinal: BigInt(row.ordinal), slot: row.slot, id: decodeNativeTextBytes(row.id), path: row.path.map(BigInt) }));
      },
      async withWinners(consume) {
        if (typeof consume !== 'function') throw new TypeError('Year child winners require a consumer.');
        return this.seal(null, { consumeWinners: consume });
      },
      async seal(onYear, { withSortedWinners, beforeExtract, afterExtract, consumeWinners } = {}) {
        active(); if (sealed) throw new Error('Year extraction has already started.'); sealed = true;
        if (typeof onYear !== 'function' && !consumeWinners) throw new TypeError('Year extraction requires its by-name consumer.');
        await cohort.flush();
        let selection;
        if (['userless-direct', 'leaf', 'user-view'].includes(mode)) {
          selection = `SELECT row_number() OVER(ORDER BY ordinal) AS position,slot FROM ${occurrences} WHERE eligible AND matched AND visible`;
        } else {
          const order = mode === 'userless-recursive' ? 'path' : 'ordinal';
          const direct = mode === 'user-direct' || mode === 'user-playlist-direct';
          const predicate = (direct ? 'eligible AND visible' : 'eligible AND visible AND matched')
            + (mode.startsWith('user-playlist') ? ' AND NOT folder' : '');
          selection = `WITH ranked AS (SELECT *, first_value(${order}) OVER(PARTITION BY ${sql.guidKey('id')} ORDER BY ${order}) AS first_position,
            row_number() OVER(PARTITION BY ${sql.guidKey('id')} ORDER BY ${order} DESC) AS rank FROM ${occurrences} WHERE ${predicate})
            SELECT row_number() OVER(ORDER BY first_position) AS position,slot FROM ranked WHERE rank=1${direct ? ' AND matched' : ''}`;
        }
        await database.client.query(`CREATE TEMP TABLE ${winners} AS ${selection}`);
        await database.client.query(`CREATE UNIQUE INDEX ON ${winners}(position)`);
        const plain = Object.freeze({ withSlot: (slot, operation) => cohort.withSlot(slot, operation),
          async page(after = 0n) {
            active(); return (await database.client.query(`SELECT position,slot FROM ${winners}
              WHERE position>$1 ORDER BY position LIMIT 128`, [after])).rows.map(row => ({ position: BigInt(row.position), slot: row.slot }));
          } });
        if (consumeWinners) return consumeWinners(plain);
        const extract = async ordered => {
          await beforeExtract?.();
          for (let after = 0n;;) {
            const rows = await ordered.page(after);
            if (!rows.length) break;
            for (const row of rows) await ordered.withSlot(row.slot, async item => {
              active();
              const year = item.ProductionYear;
              if (year != null && year > 0) {
                const inserted = await database.client.query(`INSERT INTO ${years}(year,position) VALUES($1,$2)
                  ON CONFLICT(year) DO NOTHING RETURNING year`, [year, row.position]);
                if (inserted.rows.length) await onYear(year, row.position);
              }
            });
            after = rows.at(-1).position;
          }
          await afterExtract?.();
        };
        if (withSortedWinners) await withSortedWinners(plain, extract);
        else await extract(plain);
        const total = checkedCount((await database.client.query(mode === 'user-recursive' || mode === 'user-view'
          ? `SELECT count(*) AS total FROM ${occurrences} WHERE eligible AND visible AND matched`
          : mode === 'user-playlist' ? `SELECT count(*) AS total FROM ${winners}`
          : `SELECT count(*) AS total FROM ${years}`)).rows[0].total);
        return Object.freeze({ total, async page(after = 0n) {
          active(); return (await database.client.query(`SELECT year,position FROM ${years} WHERE position>$1 ORDER BY position LIMIT 128`, [after])).rows
            .map(row => ({ year: row.year, position: BigInt(row.position) }));
        } });
      },
    });
  } catch (reason) {
    try { await close({ failed: true }); } catch (cleanup) { throw yearsFailure([reason, cleanup]); }
    throw reason;
  }
}
