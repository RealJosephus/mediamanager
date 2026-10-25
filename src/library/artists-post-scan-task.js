import { randomUUID } from 'node:crypto';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { serialize, deserialize } from 'node:v8';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { buildPostgresArtistBatchLookupQuery } from './postgres-artist-maintenance.js';
import { captureNativeItemState, restoreNativeItemState, acquireNativeItemLinkOwner } from './native-item-entity.js';
import { cloneNativeItemValue } from './native-item-value.js';
import { dateTicks, idKey, mapRecord } from './records.js';

const cancellation = error => error?.name === 'AbortError' || error?.code === 'cancelled';
const artistType = 'MediaBrowser.Controller.Entities.Audio.MusicArtist';

/** Freeze the native batch objects before any refresh. PostgreSQL holds their
 * shared mutable state between names, as well as the initial and live ID sets. */
export class ArtistsPostScanTask {
  constructor({ store, library, linkedChildren, metadataScanner, logger = {} }) {
    if (!store || typeof library?.getArtist !== 'function' || typeof library?.deleteQueryItemsUnsafeFast !== 'function'
      || typeof metadataScanner?.refreshLiveItem !== 'function') {
      throw new TypeError('Artist maintenance requires lookup, live metadata refresh and batch deletion.');
    }
    Object.assign(this, { store, library, linkedChildren, metadataScanner, logger, name: 'Artists' });
  }

  run({ signal, reportProgress = () => {} } = {}) {
    return this.store.run(async db => {
      const scopeId = randomUUID();
      const prefix = 'mm_artists_' + randomUUID().replaceAll('-', '');
      const names = q(prefix + '_names'), initial = q(prefix + '_initial'), matched = q(prefix + '_matched');
      const state = q(prefix + '_state'), live = q(prefix + '_live');
      const table = name => `${q(db.schemaName)}.${q(name)}`;
      const sql = nativeTextSql(db.schemaName);
      const initialPlan = buildPostgresItemPageQuery(db, { includeitemtypes: ['MusicArtist'] }, { groupByPresentationKey: false });
      const matchedPlan = buildPostgresArtistBatchLookupQuery(db, { text: `SELECT "Ordinal", "Name" FROM ${names}`, values: [] });
      const columns = tableDefinition('BaseItems').columns;
      let completed = 0, refreshed = 0, unresolved = 0, ordinal = 0n;
      try {
        await db.client.query(`/* artist-maintenance-names */ CREATE TEMP TABLE ${names} AS
          SELECT row_number() OVER (ORDER BY selected."CleanValue" NULLS FIRST) AS "Ordinal", selected."Name"
          FROM (SELECT DISTINCT ON (value."CleanValue") value."CleanValue", value."Value" AS "Name"
            FROM ${table('ItemValues')} value WHERE value."Type" IN (0, 1) AND EXISTS (
              SELECT 1 FROM ${table('ItemValuesMap')} map JOIN ${table('BaseItems')} item ON item."Id" = map."ItemId"
              WHERE map."ItemValueId" = value."ItemValueId"
            ) ORDER BY value."CleanValue" NULLS FIRST,value."Value" NULLS LAST) selected`);
        await db.client.query({ text: `CREATE TEMP TABLE ${initial} AS
          SELECT ${sql.guidKey('selected."Id"')} AS "Id" FROM (${initialPlan.text}) selected`, values: initialPlan.values });
        await db.client.query({ text: `CREATE TEMP TABLE ${matched} AS ${matchedPlan.text}`, values: matchedPlan.values });
        await db.client.query(`CREATE TEMP TABLE ${state} ("Id" text PRIMARY KEY, "Payload" bytea NOT NULL);
          CREATE TEMP TABLE ${live} ("Id" text PRIMARY KEY);
          CREATE INDEX ON ${matched} ("__ordinal"); CREATE INDEX ON ${initial} ("Id")`);
        const count = Number((await db.client.query(`SELECT count(*) AS "Count" FROM ${names}`)).rows[0].Count);
        if (!Number.isSafeInteger(count)) throw new Error('PostgreSQL returned an invalid Artist name count.');
        while (true) {
          const page = (await db.client.query({ text: `/* artist-maintenance-page */ SELECT * FROM ${matched}
            WHERE "__ordinal" > $1 ORDER BY "__ordinal" LIMIT 128`, values: [ordinal] })).rows;
          for (const row of page) {
            ordinal = BigInt(row.__ordinal);
            const matchedId = row.Id == null ? null : idKey(decodeNativeTextBytes(row.Id, 'runtime'));
            const name = row.__name == null ? null : decodeNativeTextBytes(row.__name, 'runtime');
            let item, itemOwner;
            try {
              if (matchedId) {
                const saved = (await db.client.query({ text: `SELECT "Payload" FROM ${state} WHERE "Id" = $1`, values: [matchedId] })).rows[0];
                if (saved) item = await restoreNativeItemState(deserialize(saved.Payload), this.library.options, { linkedChildren: this.linkedChildren, session: db });
                else {
                  item = mapRecord(Object.fromEntries(columns.map(column => [column.name, decodeValue(column, row[column.name], 'postgres')])));
                  item.Path = this.library.options?.expandPath?.(item.Path) ?? item.Path;
                }
              } else item = await this.library.getArtist(name);
              if (item) {
                itemOwner = acquireNativeItemLinkOwner(item);
                await db.client.query({ text: `INSERT INTO ${live} VALUES ($1) ON CONFLICT DO NOTHING`, values: [idKey(item.Id)] });
                const present = (await db.client.query({ text: `SELECT EXISTS (
                  SELECT 1 FROM ${initial} WHERE "Id" = $1) AS "Present"`, values: [idKey(item.Id)] })).rows[0].Present;
                if (!present || dateTicks(item.DateLastRefreshed) === 0n) {
                  await this.metadataScanner.refreshLiveItem(item, { signal });
                  refreshed++;
                }
              }
            } catch (error) {
              if (signal?.aborted || cancellation(error)) throw error;
              unresolved++;
              this.logger.error?.(error, `Error refreshing ${name}`);
            } finally {
              try {
              if (matchedId && item) {
                const captured = await captureNativeItemState(item, { linkedChildren: this.linkedChildren, session: db, scopeId, slotId: matchedId });
                // SQL ownership can observe nested mutable values through Proxies.
                // Store their values; link ownership remains in the captured token.
                await db.client.query({ text: `INSERT INTO ${state} VALUES ($1, $2)
                  ON CONFLICT ("Id") DO UPDATE SET "Payload" = EXCLUDED."Payload"`,
                  values: [matchedId, serialize(cloneNativeItemValue(captured))] });
              }
              } finally {
                itemOwner?.release();
                await this.linkedChildren.flushReleases({ session: db });
              }
            }
            reportProgress(++completed / count * 100);
          }
          if (page.length < 128) break;
        }
        this.logger.info?.(`Refreshed metadata for ${refreshed} new artists out of ${count} total`);
        if (unresolved) {
          this.logger.warn?.(`Not removing dead artists: ${unresolved} of ${count} names could not be resolved this run`);
        } else {
          await this.library.deleteQueryItemsUnsafeFast({ includeitemtypes: ['MusicArtist'], islocked: false }, {
            deleteSourceFiles: true,
            itemIdsPlan: { text: `SELECT item."Id" FROM ${table('BaseItems')} item
              WHERE item."Type" = $1 AND (item."ParentId" IS NULL
                OR ${sql.guidKey('item."ParentId"')} = '00000000000000000000000000000000')
                AND NOT EXISTS (SELECT 1 FROM ${live} alive WHERE alive."Id" = ${sql.guidKey('item."Id"')})`, values: [nativeTextBytes(artistType)] },
            onSelectedItem: item => this.logger.info?.(`Deleting dead ${item.Type} ${idKey(item.Id)} ${item.Name}`),
          });
        }
        reportProgress(100);
      } finally {
        await this.linkedChildren.releaseStateScope(scopeId, { session: db });
        await this.linkedChildren.flushReleases({ session: db });
        await db.client.query(`DROP TABLE IF EXISTS ${live}, ${state}, ${matched}, ${initial}, ${names}`);
      }
    });
  }
}
