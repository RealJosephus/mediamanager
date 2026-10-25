import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { withPostgresNativeQueryJitOff } from '../database/postgres-native-query-jit.js';
import { nativeGuid } from '../users/native.js';
import { makeNativeAbsolutePath } from '../metadata/playlist-items.js';
import { acquireNativeItemLinkOwner, publishNativeItemLinks } from './native-item-entity.js';
import { EMPTY_ID, libraryError } from './records.js';
import { nativeItemQueryColumns } from './postgres-native-item-query-projection.js';
import { createPostgresFolderLinksQuery } from './postgres-folder-links-query.js';
import { findPostgresLinkedChildByPath } from './postgres-linked-child-resolution.js';

const movie = nativeTextBytes('MediaBrowser.Controller.Entities.Movies.Movie');
const series = nativeTextBytes('MediaBrowser.Controller.Entities.TV.Series');
const boxSet = nativeTextBytes('MediaBrowser.Controller.Entities.Movies.BoxSet');

/** Materialize Folder's already filtered input before observing the collection
 * catalogue. PostgreSQL owns the dictionary, membership, replacement order and
 * final page; Node only resolves the next raw null-ID link selected by SQL.
 * Every repository/cohort read crossing into Node is bounded to 128 entries. */
export async function createPostgresFolderCollectionCollapse({ session, library, source, sourcePlan,
  query, options, user, prepareVisibility }) {
  const sql = nativeTextSql(session.schemaName), { linkedChildren } = library.options;
  const { itemCreation } = library;
  const prefix = 'mm_folder_collapse_' + randomUUID().replaceAll('-', '');
  const input = q(prefix + '_input'), result = q(prefix + '_result'), matches = q(prefix + '_matches');
  const tables = [], groupedTypes = options.collapseTypes.map(type => type === 'Movie' ? movie : series);
  let root, catalogue, cataloguePlan, closing;
  const close = primary => closing ??= (async () => {
    const failures = [];
    for (const release of [() => catalogue?.close(primary), () => root?.close(primary),
      ...tables.toReversed().map(table => () => session.client.query(`DROP TABLE ${table}`))]) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(primary ? [primary, ...failures] : failures,
      primary?.message ?? 'Collection collapse cleanup failed.', primary ? { cause: primary } : undefined);
  })();
  try {
    const beforeCollapse = { ...query, sortby: [], startindex: 0 };
    delete beforeCollapse.limit; delete beforeCollapse.adjacentto;
    const filter = buildPostgresItemPageQuery(session, beforeCollapse, { ...options,
      nativeItemsPlan: sourcePlan, visibility: undefined, collapseTypes: null, memoryPresort: null });
    await withPostgresNativeQueryJitOff(session, db => db.client.query({ text: `CREATE TEMP TABLE ${input} AS
      SELECT item.* FROM (${sourcePlan.text}) item WHERE EXISTS (
        SELECT 1 FROM (${filter.text.replace(/\$(\d+)\b/gu, (_, n) => '$' + (Number(n) + sourcePlan.values.length))}) selected
        WHERE selected."__SlotKey"=item."__SlotKey")`, values: [...sourcePlan.values, ...filter.values] }));
    tables.push(input);
    await session.client.query(`CREATE TEMP TABLE ${result} ("Key" text PRIMARY KEY,"SlotKey" uuid NOT NULL,
      "Collection" boolean NOT NULL,"Position" bigint GENERATED ALWAYS AS IDENTITY)`);
    tables.push(result);
    await session.client.query(`CREATE TEMP TABLE ${matches} ("Ordinal" bigint PRIMARY KEY,"SlotKey" uuid NOT NULL,"Id" bytea NOT NULL)`);
    tables.push(matches);
    const allTypes = groupedTypes.length === 2;
    const hasGrouped = allTypes || (await session.client.query(`SELECT EXISTS(SELECT 1 FROM ${input}
      WHERE "Type"=ANY($1::bytea[])) AS present`, [groupedTypes])).rows[0].present;
    if (hasGrouped && options.collapseCollectionPath !== null) {
      if (!library.rootHost) throw libraryError(500, 'Folder grouping requires the aggregate root host.');
      const aggregate = await library.rootHost.getAggregateFolder();
      root = await createPostgresFolderLinksQuery({ session, library, item: aggregate, user: null });
      const rootPlan = await root.prepare({}, { ...options, visibility: undefined, collapseTypes: null });
      const parent = (await session.client.query({ text: `SELECT item."__SlotKey" FROM (${rootPlan.text}) item
        WHERE item."IsFolder" IS TRUE AND ${sql.pathWithin(`$${rootPlan.values.length + 1}::bytea`, 'item."Path"')}
        ORDER BY item."__SourceOrdinal" LIMIT 1`, values: [...rootPlan.values, nativeTextBytes(options.collapseCollectionPath)] })).rows[0];
      if (parent) await root.withSlot(parent.__SlotKey, async item => {
        catalogue = await createPostgresFolderLinksQuery({ session, library, item, user });
        cataloguePlan = await catalogue.prepare({}, { ...options, collapseTypes: null }, { prepareVisibility });
      });
    }

    // The native loop visits source items, then every visible collection. A
    // positive cached ID never loads its target; only an earlier null-ID link
    // can trigger lookup and publish a cache prefix before a later failure.
    async function visitCollection(candidate, collection) {
      await catalogue.withSlot(collection.__SlotKey, async item => {
        const owner = acquireNativeItemLinkOwner(item);
        let operation;
        try {
          if (!item.LinkedChildrenLoaded) publishNativeItemLinks(item, await linkedChildren.load(session, item.Id));
          operation = linkedChildren.admitHandleOperation(item.LinkedChildren);
          let after = 0n;
          for (;;) {
            const raw = linkedChildren.plan(operation.handle), offset = raw.values.length;
            const next = (await session.client.query({ text: `SELECT link.* FROM (${raw.text}) link
              WHERE link."Ordinal">$${offset + 2} AND (link."ItemId" IS NULL
                OR ${sql.guidKey('link."ItemId"')}=${sql.guidKey(`$${offset + 1}::bytea`)})
              ORDER BY link."Ordinal" LIMIT 1`, values: [...raw.values, candidate.Id, after] })).rows[0];
            if (!next) return;
            if (next.ItemId !== null) {
              await session.client.query(`INSERT INTO ${matches}("Ordinal","SlotKey","Id") VALUES ($1,$2,$3)`,
                [collection.__SourceOrdinal, collection.__SlotKey, collection.Id]);
              return;
            }
            const path = next.Path == null ? null : decodeNativeTextBytes(next.Path);
            const libraryId = next.LibraryItemId == null ? null : decodeNativeTextBytes(next.LibraryItemId);
            const publish = async child => {
              await linkedChildren.recordResolution(operation.handle, BigInt(next.Ordinal), child?.Id ?? EMPTY_ID, { session });
              // A null lookup is false for this invocation, even if a later
              // call can compare its newly cached Guid.Empty directly.
              if (!child) after = BigInt(next.Ordinal);
            };
            if (path) await publish(await findPostgresLinkedChildByPath({ library, store: library.store, itemCreation },
              makeNativeAbsolutePath(item.Path, path)));
            else if (libraryId) {
              let id;
              try { id = nativeGuid(libraryId); }
              catch (error) {
                if (error?.status !== 400) throw error;
                throw Object.assign(libraryError(500, 'Unrecognized Guid format.'), { cause: error });
              }
              await itemCreation.withItem(id, publish);
            } else await publish(null);
          }
        } finally {
          try { await operation?.release(); }
          finally { owner.release(); await linkedChildren.flushReleases({ session }); }
        }
      });
    }

    for (let after = 0n;;) {
      const candidates = (await session.client.query(`SELECT "Id","__SlotKey","__SourceOrdinal",
          "Type"=ANY($4::bytea[]) AS "SupportsGrouping","Type"=$5::bytea AS "Video"
        FROM ${input} WHERE "__SourceOrdinal">$1 AND ($2 OR "Type"=ANY($3::bytea[]))
        ORDER BY "__SourceOrdinal" LIMIT 128`, [after, allTypes, groupedTypes, [movie, series], movie])).rows;
      if (!candidates.length) break;
      for (const candidate of candidates) {
        await session.client.query(`TRUNCATE ${matches}`);
        if (candidate.SupportsGrouping && cataloguePlan) {
          for (let collectionAfter = 0n;;) {
            const offset = cataloguePlan.values.length;
            const collections = (await session.client.query({ text: `SELECT "Id","__SlotKey","__SourceOrdinal"
              FROM (${cataloguePlan.text}) item WHERE "Type"=$${offset + 1}::bytea
                AND "__SourceOrdinal">$${offset + 2} ORDER BY "__SourceOrdinal" LIMIT 128`,
            values: [...cataloguePlan.values, boxSet, collectionAfter] })).rows;
            if (!collections.length) break;
            for (const collection of collections) await visitCollection(candidate, collection);
            collectionAfter = BigInt(collections.at(-1).__SourceOrdinal);
          }
        }
        await session.client.query(`INSERT INTO ${result}("Key","SlotKey","Collection")
          SELECT ${sql.guidKey('"Id"')},"SlotKey",TRUE FROM ${matches} ORDER BY "Ordinal"
          ON CONFLICT("Key") DO NOTHING`);
        await session.client.query(`INSERT INTO ${result}("Key","SlotKey","Collection")
          SELECT ${sql.guidKey('item."Id"')},item."__SlotKey",FALSE FROM ${input} item
          WHERE item."__SourceOrdinal"=$1 AND NOT EXISTS(SELECT 1 FROM ${matches})
            AND (NOT $2 OR NOT EXISTS(SELECT 1 FROM ${q(session.schemaName)}."LinkedChildren" alternate
              JOIN ${result} previous ON previous."Key"=${sql.guidKey('alternate."ChildId"')}
              WHERE alternate."ChildType"=2 AND ${sql.guidKey('alternate."ParentId"')}=${sql.guidKey('item."Id"')}))
          ON CONFLICT("Key") DO UPDATE SET "SlotKey"=EXCLUDED."SlotKey","Collection"=FALSE`,
        [candidate.__SourceOrdinal, candidate.Video]);
      }
      after = BigInt(candidates.at(-1).__SourceOrdinal);
    }
    const chosen = `SELECT item.*,chosen."Position" AS "Position",0 AS "Category"
      FROM ${input} item JOIN ${result} chosen ON chosen."SlotKey"=item."__SlotKey" AND NOT chosen."Collection"
      ${cataloguePlan ? `UNION ALL SELECT item.*,chosen."Position",0 FROM (${cataloguePlan.text}) item
        JOIN ${result} chosen ON chosen."SlotKey"=item."__SlotKey" AND chosen."Collection"` : ''}
      ${allTypes ? '' : `UNION ALL SELECT item.*,item."__SourceOrdinal",1 FROM ${input} item
        WHERE NOT (item."Type"=ANY($${(cataloguePlan?.values.length ?? 0) + 1}::bytea[]))`}`;
    const plan = Object.freeze({ text: `SELECT ${nativeItemQueryColumns('chosen')},
      row_number() OVER(ORDER BY chosen."Category",chosen."Position") AS "__SourceOrdinal"
      FROM (${chosen}) chosen`, values: Object.freeze([...(cataloguePlan?.values ?? []), ...(allTypes ? [] : [groupedTypes])]) });
    return Object.freeze({ plan, async withSlot(slot, callback) {
      const collection = (await session.client.query(`SELECT EXISTS(SELECT 1 FROM ${result}
        WHERE "SlotKey"=$1 AND "Collection") AS present`, [slot])).rows[0].present;
      return (collection ? catalogue : source).withSlot(slot, callback);
    }, close });
  } catch (error) { await close(error); throw error; }
}
