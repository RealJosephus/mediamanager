import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { idKey, nonemptyId, libraryError } from '../library/records.js';
import { createMetadataChildren } from '../library/metadata-children.js';
import { requireNativeList } from '../library/item-relations.js';
import { acquireNativeItemLinkOwner } from '../library/native-item-entity.js';
import { assertKnownItem } from './editor-service.js';
import { ItemUpdateType, validateMetadataSaves } from './save-manager.js';

/** Capture native Children before any edit can write files or repository rows.
 * SQL retains the traversal, duplicate identities and order; Node owns only a
 * bounded child page and the current folder. A logical CollectionFolder edge
 * never changes the child's persistent physical ParentId. */
export async function captureMetadataEditSelection({ database, library, loadContext, updates,
  root, lockChanged, cohort, relation }) {
  const linkedChildren = library.options.linkedChildren;
  const factory = createMetadataChildren({ store: library.store, library, linkedChildren,
    configuration: library.options.configuration });
  const suffix = randomUUID().replaceAll('-', '');
  const pending = q('mm_edit_pending_' + suffix), captured = q('mm_edit_captured_' + suffix);
  const sql = nativeTextSql(database.schemaName);
  let failure;
  try {
    await database.client.query(`CREATE TEMP TABLE ${pending} (
      route bigint[] PRIMARY KEY, seen text[] NOT NULL, slot uuid NOT NULL, done boolean NOT NULL DEFAULT FALSE);
      CREATE TEMP TABLE ${captured} (route bigint[] PRIMARY KEY, "Id" bytea NOT NULL,
        "ParentId" bytea NOT NULL, "SlotKey" uuid NOT NULL, "Physical" boolean NOT NULL)`);
    const recursive = Boolean(root.IsFolder && lockChanged);
    if (root.IsFolder && (recursive || ['Series', 'Season', 'MusicAlbum'].includes(root.Type))) {
      await database.client.query(`INSERT INTO ${pending}(route,seen,slot) VALUES($1,$2,$3)`,
        [[], [idKey(root.Id)], await cohort.captureSlot(root)]);
    }

    async function preflight(item) {
      const loaded = await loadContext(item.Id, { draft: item, includeChildren: false });
      try {
        assertKnownItem(loaded.item);
        if (loaded.item.NativeType.startsWith('Plugin.')) throw libraryError(501, 'A metadata edit descendant is unsupported.');
        await validateMetadataSaves(loaded, ItemUpdateType.MetadataEdit, updates.registry);
        return await cohort.captureSlot(loaded.item);
      } finally { await loaded.dispose(); }
    }

    async function consume(parent, source, current, cursor, { linked = false } = {}) {
      let sourceFailure;
      try {
        for await (const page of source.pages()) for (const child of page) {
          const route = [...current.route, String(++cursor.value)];
          const slot = await preflight(child);
          await database.client.query(`INSERT INTO ${captured}(route,"Id","ParentId","SlotKey","Physical") VALUES($1,$2,$3,$4,$5)`,
            [route, nativeTextBytes(child.Id), nativeTextBytes(parent.Id), slot, !linked]);
          if (!linked && child.IsFolder && (recursive || root.Type === 'Series' && current.route.length === 0 && child.Type === 'Season')) {
            if ((await database.client.query('SELECT $1::text=ANY($2::text[]) AS cycle',
              [idKey(child.Id), current.seen])).rows[0].cycle) throw libraryError(409, 'The metadata folder hierarchy contains a cycle.');
            await database.client.query(`INSERT INTO ${pending}(route,seen,slot) VALUES($1,$2,$3)`,
              [route, [...current.seen, idKey(child.Id)], slot]);
          }
        }
      } catch (error) { sourceFailure = error; throw error; }
      finally {
        try { await source.close(); }
        catch (cleanup) { throw sourceFailure ? new AggregateError([sourceFailure, cleanup], sourceFailure.message, { cause: sourceFailure }) : cleanup; }
      }
    }

    for (;;) {
      const current = (await database.client.query(`SELECT * FROM ${pending} WHERE NOT done ORDER BY route LIMIT 1`)).rows[0];
      if (!current) break;
      await database.client.query(`UPDATE ${pending} SET done=TRUE WHERE route=$1`, [current.route]);
      await cohort.withSlot(current.slot, async parent => {
        const cursor = { value: 0n };
        const includeItemTypes = recursive || root.Type === 'MusicAlbum' ? undefined : parent.Type === 'Series'
          ? ['MediaBrowser.Controller.Entities.TV.Season'] : ['MediaBrowser.Controller.Entities.TV.Episode'];
        const children = value => factory.physical(value, { preserveDuplicates: true, includeItemTypes });
        if (parent.Type !== 'CollectionFolder') return consume(parent, await children(parent), current, cursor);
        // CollectionFolder.Children concatenates physical Folder.Children. It
        // neither includes those physical folders nor falls back to locations.
        for (const id of requireNativeList(parent.PhysicalFolderIds, 'source')) {
          if (!nonemptyId(id)) throw Object.assign(new TypeError("Guid can't be empty (Parameter 'id')"),
            { status: 500 });
          await library.itemCreation.withItem(id, async physical => {
            if (!physical?.IsFolder) return;
            const owner = acquireNativeItemLinkOwner(physical);
            try { await consume(parent, await children(physical), current, cursor); }
            finally { owner.release(); await linkedChildren.flushReleases(); }
          });
        }
      });
    }

    if (recursive) await consume(root, await factory.linked(root),
      { route: ['9223372036854775807'], seen: [idKey(root.Id)] }, { value: 0n }, { linked: true });

    // Dictionary<Guid,BaseItem> preserves first insertion order and replaces
    // the value on later occurrences, including a root linked-child alias.
    await database.client.query(`CREATE TEMP TABLE ${relation} AS WITH occurrences AS (
      SELECT *,row_number() OVER(PARTITION BY ${sql.guidKey('"Id"')} ORDER BY route) AS first,
        first_value("SlotKey") OVER(PARTITION BY ${sql.guidKey('"Id"')} ORDER BY route DESC) AS last_slot
      FROM ${captured}) SELECT row_number() OVER(ORDER BY route) AS "Ordinal","Id","ParentId","Physical",last_slot AS "SlotKey"
        FROM occurrences WHERE first=1 ORDER BY route`);
    for (let after = 0n; ;) {
      const rows = (await database.client.query(`SELECT "Ordinal","SlotKey" FROM ${relation}
        WHERE "Ordinal">$1 ORDER BY "Ordinal" LIMIT 128`, [after])).rows;
      if (!rows.length) break;
      for (const row of rows) await cohort.appendSlot(row.SlotKey, { ordinal: BigInt(row.Ordinal) });
      after = BigInt(rows.at(-1).Ordinal);
    }
    await cohort.flush();
  } catch (error) { failure = error; throw error; }
  finally {
    try { await database.client.query(`DROP TABLE IF EXISTS ${pending},${captured}`); }
    catch (cleanup) { throw failure ? new AggregateError([failure, cleanup], failure.message, { cause: failure }) : cleanup; }
  }
}
