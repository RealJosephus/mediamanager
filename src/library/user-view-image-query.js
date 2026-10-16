import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { decodeValue } from '../database/values.js';
import { collectionType } from './user-view-query.js';
import { mapRecord } from './records.js';
import { nativeItemTypes, releaseNativeItemLinks } from './native-item-entity.js';

const columns = tableDefinition('BaseItems').columns;
const encode = nativeTextBytes;

/** Keep the complete query and shuffled image candidates in PostgreSQL. The
 * consumer reads bounded pages; decoding stops at its first valid picture. */
export function withUserViewImageCandidates(library, view, user, operation) {
  return library.withItemQueryPlan({ ParentId: view.Id, Recursive: collectionType(view) !== 'playlists',
    CollapseBoxSetItems: false, ExcludeItemTypes: 'UserView,CollectionFolder,Person', EnableImages: false,
    EnableUserData: false, EnableTotalRecordCount: false }, { user }, async (db, plan) => {
    const suffix = randomUUID().replaceAll('-', ''), source = q('mm_view_image_source_' + suffix), selected = q('mm_view_images_' + suffix);
    const sql = nativeTextSql(db.schemaName), items = `${q(db.schemaName)}."BaseItems"`, images = `${q(db.schemaName)}."BaseItemImageInfos"`;
    const kind = alias => sql.projection(`${alias}."Type"`);
    const present = expression => `${expression} IS NOT NULL AND octet_length(${expression})>0 AND ${sql.guidKey(expression)}<>'00000000000000000000000000000000'`;
    let primaryError;
    try {
      await db.client.query({ text: `/* user-view-image-query-snapshot */ CREATE TEMP TABLE ${source} AS
        SELECT chosen."__ordinal",item.* FROM (${plan.text}) chosen JOIN ${items} item
          ON ${sql.guidKey('item."Id"')}=${sql.guidKey('chosen."Id"')}`, values: plan.values });
      // GetItemList hydrates its entire result before GetItemsWithImages starts.
      // Preserve typed-data errors while retaining only one bounded page.
      for (let after = 0n; ;) {
        const rows = (await db.client.query(`SELECT * FROM ${source} WHERE "__ordinal">$1 ORDER BY "__ordinal" LIMIT 128`, [after])).rows;
        if (!rows.length) break;
        for (const row of rows) {
          const item = mapRecord(Object.fromEntries(columns.map(column => [column.name, decodeValue(column, row[column.name], 'postgres')])));
          if (item) releaseNativeItemLinks(item);
        }
        after = BigInt(rows.at(-1).__ordinal);
      }
      await db.client.query({ text: `/* user-view-image-candidates */ CREATE TEMP TABLE ${selected} AS
        WITH RECURSIVE ancestors AS (
          SELECT child."Id" AS child_id,parent."Id",parent."ParentId",parent."Type",1 AS depth,
            CASE WHEN ${kind('child')} IN ('MediaBrowser.Controller.Entities.TV.Episode','MediaBrowser.Controller.Entities.TV.Season')
              THEN 'MediaBrowser.Controller.Entities.TV.Series' ELSE 'MediaBrowser.Controller.Entities.Audio.MusicAlbum' END AS target_type,
            ARRAY[${sql.guidKey('child."Id"')},${sql.guidKey('parent."Id"')}] AS seen
          FROM ${source} child JOIN ${items} parent ON ${sql.guidKey('parent."Id"')}=${sql.guidKey('child."ParentId"')}
          WHERE (${kind('child')} IN ('MediaBrowser.Controller.Entities.TV.Episode','MediaBrowser.Controller.Entities.TV.Season')
            AND NOT (${present('child."SeriesId"')}))
            OR ${kind('child')} IN ('MediaBrowser.Controller.Entities.Audio.Audio','MediaBrowser.Controller.Entities.AudioBook')
          UNION ALL SELECT ancestors.child_id,parent."Id",parent."ParentId",parent."Type",ancestors.depth+1,
            ancestors.target_type,
            ancestors.seen||${sql.guidKey('parent."Id"')}
          FROM ancestors JOIN ${items} parent ON ${sql.guidKey('parent."Id"')}=${sql.guidKey('ancestors."ParentId"')}
          WHERE ${kind('ancestors')}<>ancestors.target_type AND NOT ${sql.guidKey('parent."Id"')}=ANY(ancestors.seen)
        ), resolved AS (
          SELECT source."__ordinal",COALESCE(series."Id",album."Id",source."Id") AS "Id"
          FROM ${source} source
          LEFT JOIN LATERAL (
            SELECT item."Id" FROM ${items} item WHERE ${kind('item')}='MediaBrowser.Controller.Entities.TV.Series'
              AND ${kind('source')} IN ('MediaBrowser.Controller.Entities.TV.Episode','MediaBrowser.Controller.Entities.TV.Season')
              AND ((${present('source."SeriesId"')} AND ${sql.guidKey('item."Id"')}=${sql.guidKey('source."SeriesId"')})
                OR (NOT (${present('source."SeriesId"')}) AND item."Id"=(SELECT ancestor."Id" FROM ancestors ancestor
                  WHERE ancestor.child_id=source."Id" AND ${kind('ancestor')}='MediaBrowser.Controller.Entities.TV.Series' ORDER BY depth LIMIT 1)))
            LIMIT 1
          ) series ON TRUE
          LEFT JOIN LATERAL (
            SELECT item."Id" FROM ${items} item WHERE ${kind('item')}='MediaBrowser.Controller.Entities.Audio.MusicAlbum'
              AND ${kind('source')} IN ('MediaBrowser.Controller.Entities.Audio.Audio','MediaBrowser.Controller.Entities.AudioBook')
              AND item."Id"=(SELECT ancestor."Id" FROM ancestors ancestor WHERE ancestor.child_id=source."Id"
                AND ${kind('ancestor')}='MediaBrowser.Controller.Entities.Audio.MusicAlbum' ORDER BY depth LIMIT 1)
              AND EXISTS(SELECT 1 FROM ${images} image WHERE image."ItemId"=item."Id" AND image."ImageType"=0) LIMIT 1
          ) album ON TRUE WHERE source."Type"=ANY($1::bytea[])
        ), distinct_items AS (
          SELECT DISTINCT ON (${sql.guidKey('"Id"')}) "Id" FROM resolved ORDER BY ${sql.guidKey('"Id"')},"__ordinal"
        ), candidates AS (
          SELECT chosen."Id",first_local."Path" FROM distinct_items chosen
          LEFT JOIN LATERAL (
            SELECT first_image."Path" FROM (
              SELECT DISTINCT ON (image."ImageType") image."ImageType",image."Path"
              FROM ${images} image JOIN ${q(db.controlSchema)}."image_order" sequence ON sequence.image_id=image."Id"
              WHERE image."ItemId"=chosen."Id" AND image."ImageType" IN (0,2,5)
              ORDER BY image."ImageType",sequence.position
            ) first_image WHERE ${sql.projection('first_image."Path"')} !~* '^http'
              AND octet_length(first_image."Path")>0
            ORDER BY CASE first_image."ImageType" WHEN 2 THEN 0 WHEN 0 THEN 1 ELSE 2 END LIMIT 1
          ) first_local ON TRUE
          WHERE EXISTS(SELECT 1 FROM ${images} image WHERE image."ItemId"=chosen."Id" AND image."ImageType" IN (0,5))
        ) SELECT row_number() OVER(ORDER BY random()) AS "Ordinal",* FROM candidates`, values: [nativeItemTypes.map(encode)] });
      return await operation({
        async hasItems() { return (await db.client.query(`SELECT EXISTS(SELECT 1 FROM ${selected}) AS present`)).rows[0].present; },
        async *paths() {
          for (let after = 0n; ;) {
            const rows = (await db.client.query(`SELECT * FROM ${selected} WHERE "Ordinal">$1 AND "Path" IS NOT NULL ORDER BY "Ordinal" LIMIT 128`, [after])).rows;
            if (!rows.length) return;
            for (const row of rows) yield library.options.expandPath?.(decodeNativeTextBytes(row.Path)) ?? decodeNativeTextBytes(row.Path);
            after = BigInt(rows.at(-1).Ordinal);
          }
        }
      });
    } catch (error) { primaryError = error; throw error; }
    finally {
      if (!db.connectionReleaseError) try { await db.client.query(`DROP TABLE IF EXISTS ${selected},${source}`); }
      catch (error) {
        if (!(primaryError && db.inTransaction && error.code === '25P02')) {
          db.discardConnection(error);
          throw primaryError ? new AggregateError([primaryError,error], primaryError.message, { cause:primaryError }) : error;
        }
      }
    }
  });
}
