import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { idKey } from './records.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';

const sourceTypes = ['MediaBrowser.Controller.Entities.Audio.Audio', 'MediaBrowser.Controller.Entities.MusicVideo',
  'MediaBrowser.Controller.Entities.Audio.MusicAlbum', 'MediaBrowser.Controller.Entities.Audio.MusicArtist'];
const cancellation = error => error?.name === 'AbortError' || error?.code === 'cancelled';

/** Reconcile music-genre metadata after a scan. The repository name relation
 * and initial MusicGenre IDs are snapshots in PostgreSQL, not library-sized
 * JavaScript lists. New lookups do not extend the initial refresh baseline. */
export class MusicGenresPostScanTask {
  constructor({ store, library, metadataScanner, logger = { error() {} } }) {
    if (!store || typeof library?.getMusicGenre !== 'function' || typeof metadataScanner?.refreshItem !== 'function') {
      throw new TypeError('Music genre maintenance requires persistence, lookup and metadata refresh.');
    }
    Object.assign(this, { store, library, metadataScanner, logger });
    this.name = 'MusicGenres';
  }

  run({ signal, reportProgress = () => {} } = {}) {
    return this.store.run(async db => {
      const prefix = 'mm_music_genres_' + randomUUID().replaceAll('-', '');
      const names = q(prefix + '_names'), initial = q(prefix + '_initial');
      const sql = nativeTextSql(db.schemaName);
      const table = name => `${q(db.schemaName)}.${q(name)}`;
      const plan = buildPostgresItemPageQuery(db, { includeitemtypes: ['MusicGenre'] }, { groupByPresentationKey: false });
      try {
        await db.client.query({ text: `/* music-genre-maintenance-names */
          CREATE TEMP TABLE ${names} AS
          SELECT row_number() OVER (ORDER BY selected."CleanValue" NULLS FIRST) AS "Ordinal", selected."Name"
          FROM (SELECT DISTINCT ON (value."CleanValue") value."CleanValue", value."Value" AS "Name"
            FROM ${table('ItemValues')} value
            WHERE value."Type" = 2 AND EXISTS (
              SELECT 1 FROM ${table('ItemValuesMap')} map JOIN ${table('BaseItems')} item
                ON item."Id" = map."ItemId"
              WHERE map."ItemValueId" = value."ItemValueId" AND item."Type" = ANY($1::bytea[])
            ) ORDER BY value."CleanValue", value."Value") selected`, values: [sourceTypes.map(nativeTextBytes)] });
        await db.client.query({ text: `CREATE TEMP TABLE ${initial} AS
          SELECT ${sql.guidKey('selected."Id"')} AS "Id" FROM (${plan.text}) selected`, values: plan.values });
        await db.client.query(`CREATE INDEX ON ${names} ("Ordinal"); CREATE INDEX ON ${initial} ("Id")`);
        const count = Number((await db.client.query(`SELECT count(*) AS "Count" FROM ${names}`)).rows[0].Count);
        if (!Number.isSafeInteger(count)) throw new Error('PostgreSQL returned an invalid music genre count.');
        let completed = 0, ordinal = 0n;
        while (true) {
          const page = await db.client.query({ text: `/* music-genre-maintenance-page */
            SELECT "Ordinal", "Name" FROM ${names} WHERE "Ordinal" > $1 ORDER BY "Ordinal" LIMIT 128`, values: [ordinal] });
          for (const row of page.rows) {
            ordinal = BigInt(row.Ordinal);
            try {
              const item = await this.library.getMusicGenre(row.Name == null ? null : decodeNativeTextBytes(row.Name));
              const exists = (await db.client.query({ text: `SELECT EXISTS (
                SELECT 1 FROM ${initial} WHERE "Id" = $1) AS "Present"`, values: [idKey(item.Id)] })).rows[0].Present;
              if (!exists) await this.metadataScanner.refreshItem(item.Id, { signal });
            } catch (error) {
              if (cancellation(error)) throw error;
              this.logger.error(error, `Error refreshing ${row.Name == null ? row.Name : decodeNativeTextBytes(row.Name)}`);
            }
            reportProgress(++completed / count * 100);
          }
          if (page.rows.length < 128) break;
        }
        reportProgress(100);
      } finally { await db.client.query(`DROP TABLE IF EXISTS ${initial}, ${names}`); }
    });
  }
}
