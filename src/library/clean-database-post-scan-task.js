import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { deletePostgresOrphanItemValues } from '../database/postgres-persistence-query.js';
import { MetadataImageAssets } from '../metadata/image-assets.js';
import { mapRecord } from './records.js';
import { nativePlaylistIsFile, setNativePlaylistFileState } from './native-path.js';

/** Capture selection in PostgreSQL while each ordinary deletion retains its
 * own file, persistence and event boundaries. */
export class CleanDatabasePostScanTask {
  constructor({ store, library, itemCreation, itemDeletion, externalData, vfs, identityMap, logger = {} }) {
    if (!store || typeof library?.getLiveMediaSources !== 'function' || typeof itemCreation?.getItemById !== 'function'
      || typeof itemDeletion?.deleteItem !== 'function' || typeof externalData?.deleteItemFiles !== 'function') {
      throw new TypeError('Database maintenance requires live items, media sources and ordinary deletion.');
    }
    Object.assign(this, { store, library, itemCreation, itemDeletion, externalData, logger, name: 'CleanDatabase' });
    this.assets = new MetadataImageAssets({ fileSystem:library.options.fileSystem, vfs, identityMap, metadataPath: externalData.metadataPath,
      stateRoots: [externalData.dataPath, externalData.trickplayPath].filter(Boolean) });
  }

  run({ signal, reportProgress = () => {} } = {}) {
    // Native selection precedes the first cancellation check, even when empty.
    return this.store.run(async db => {
      const prefix = 'mm_clean_' + randomUUID().replaceAll('-', '');
      const dead = q(prefix + '_dead'), playlists = q(prefix + '_playlists');
      const baseItems = `${q(db.schemaName)}.${q('BaseItems')}`;
      const columns = tableDefinition('BaseItems').columns;
      const selected = query => buildPostgresItemPageQuery(db, query, { groupByPresentationKey: false, includeOrdinal: true });
      const pages = async function* (relation) {
        let ordinal = 0n;
        while (true) {
          const rows = (await db.client.query({ text: `/* database-maintenance-page */ SELECT * FROM ${relation}
            WHERE "__ordinal" > $1 ORDER BY "__ordinal" LIMIT 128`, values: [ordinal] })).rows;
          if (!rows.length) return;
          yield rows;
          ordinal = BigInt(rows.at(-1).__ordinal);
          if (rows.length < 128) return;
        }
      };
      const count = async relation => {
        const value = Number((await db.client.query(`SELECT count(*) AS "Count" FROM ${relation}`)).rows[0].Count);
        if (!Number.isSafeInteger(value)) throw new Error('PostgreSQL returned an invalid maintenance item count.');
        return value;
      };
      try {
        const deadPlan = selected({ hasdeadparentid: true });
        await db.client.query({ text: `/* database-maintenance-dead */ CREATE TEMP TABLE ${dead} AS
          SELECT "Id", "__ordinal" FROM (${deadPlan.text}) selected WHERE "Id" IS NOT NULL`,
          values: deadPlan.values });
        await db.client.query(`CREATE INDEX ON ${dead} ("__ordinal")`);
        const deadCount = await count(dead);
        this.logger.debug?.(`Cleaning ${deadCount + 1} items with dead parents`);
        let completed = 0;
        for await (const rows of pages(dead)) for (const row of rows) {
          signal?.throwIfAborted();
          const item = await this.itemCreation.getItemById(row.Id);
          if (item) {
            this.logger.info?.(`Cleaning item ${item.Name ?? ''} type: ${item.Type} path: ${item.Path ?? ''}`);
            for (const source of await this.library.getLiveMediaSources(item)) {
              const sourceItem = await this.itemCreation.getItemById(source.Id);
              if (!sourceItem) continue;
              await this.externalData.deleteItemFiles(sourceItem, {
                onError: (error, folder) => this.logger.warn?.(`Failed to remove ${folder}: ${error.message}`),
              });
            }
            await this.itemDeletion.deleteItem(item, { DeleteFileLocation: false }, undefined, false);
          }
          reportProgress((++completed / (deadCount + 1) * 100 / 2) * 0.8);
        }
        await this.store.transaction(async transaction => {
          await deletePostgresOrphanItemValues(transaction);
          reportProgress((50 / 2 + 50) * 0.8);
          signal?.throwIfAborted();
        }, { signal });
        reportProgress(80);
        reportProgress(80);

        // GetItemList captures scalar entity values before deleting any member.
        // Keep the full rows in SQL so an earlier deletion cannot replace a
        // later object's source frame, including across a page boundary.
        const playlistPlan = selected({ includeitemtypes: ['Playlist'], recursive: true });
        await db.client.query({ text: `/* database-maintenance-playlists */ CREATE TEMP TABLE ${playlists} AS
          WITH selected AS MATERIALIZED (${playlistPlan.text})
          SELECT item.*, selected."__ordinal" FROM selected JOIN ${baseItems} item ON item."Id" = selected."Id"
          WHERE selected."Id" IS NOT NULL`, values: playlistPlan.values });
        await db.client.query(`CREATE INDEX ON ${playlists} ("__ordinal")`);
        const playlistCount = Math.max(await count(playlists), 1);
        completed = 0;
        for await (const rows of pages(playlists)) for (const row of rows) {
          signal?.throwIfAborted();
          const frame = Object.fromEntries(columns.map(column => [column.name, decodeValue(column, row[column.name], 'postgres')]));
          const item = mapRecord(frame);
          if (item?.Type !== 'Playlist') continue;
          item.Path = this.library.options?.expandPath?.(item.Path) ?? item.Path;
          this.itemCreation.recordRepositorySnapshot(item, frame);
          if (nativePlaylistIsFile(item)) {
            let entry;
            try { entry = await this.assets.stat(item.Path); }
            catch (error) { if (error.code !== 'not-found') throw error; }
            setNativePlaylistFileState(item, entry?.kind !== 'directory');
            if (!entry) {
              this.logger.info?.(`Removing file-based playlist ${item.Name ?? ''} because source file ${item.Path} no longer exists`);
              await this.itemDeletion.deleteItem(item, { DeleteFileLocation: false }, undefined, false);
            }
          }
          reportProgress(80 + (++completed / playlistCount * 100) * 0.2);
        }
        reportProgress(100);
      } finally { await db.client.query(`DROP TABLE IF EXISTS ${playlists}, ${dead}`); }
    });
  }
}
