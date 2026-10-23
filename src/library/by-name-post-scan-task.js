import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { idKey } from './records.js';

const musicTypes = ['MediaBrowser.Controller.Entities.Audio.Audio', 'MediaBrowser.Controller.Entities.MusicVideo',
  'MediaBrowser.Controller.Entities.Audio.MusicAlbum', 'MediaBrowser.Controller.Entities.Audio.MusicArtist'];
const cancellation = error => error?.name === 'AbortError' || error?.code === 'cancelled';
const descriptors = {
  Genre: { name: 'Genres', lookup: 'getGenre', valueType: 2, cleanupTypes: ['Genre', 'MusicGenre'], predicate: 'isdeadgenre' },
  Studio: { name: 'Studios', lookup: 'getStudio', valueType: 3, cleanupTypes: ['Studio'], predicate: 'isdeadstudio' },
};

// Initial IDs and names remain independent of subsequent creation and refresh.
// PostgreSQL owns both snapshots, the name grouping and the cleanup selection.
class ByNamePostScanTask {
  constructor(kind, { store, library, metadataScanner, logger = {} }) {
    const descriptor = descriptors[kind];
    if (!store || typeof library?.[descriptor.lookup] !== 'function' || typeof library?.deleteQueryItemsUnsafeFast !== 'function'
      || typeof metadataScanner?.refreshLiveItem !== 'function') throw new TypeError('By-name maintenance requires lookup, live refresh and batch deletion.');
    Object.assign(this, { kind, store, library, metadataScanner, logger, descriptor, name: descriptor.name });
  }

  run({ signal, reportProgress = () => {} } = {}) {
    return this.store.run(async db => {
      const prefix = 'mm_by_name_' + randomUUID().replaceAll('-', '');
      const names = q(prefix + '_names'), initial = q(prefix + '_initial'), spellings = q(prefix + '_spellings');
      const table = name => `${q(db.schemaName)}.${q(name)}`;
      const sql = nativeTextSql(db.schemaName);
      const nameKey = value => sql.ordinalIgnoreCaseKey(value);
      const plan = buildPostgresItemPageQuery(db, { includeitemtypes: [this.kind] }, { includeOrdinal: true });
      try {
        await db.client.query({ text: `/* by-name-maintenance-names */ CREATE TEMP TABLE ${names} AS
          SELECT row_number() OVER (ORDER BY selected."CleanValue" NULLS FIRST) AS "Ordinal", selected."Name"
          FROM (SELECT DISTINCT ON (value."CleanValue") value."CleanValue", value."Value" AS "Name"
            FROM ${table('ItemValues')} value WHERE value."Type" = $1 AND EXISTS (
              SELECT 1 FROM ${table('ItemValuesMap')} map JOIN ${table('BaseItems')} item ON item."Id" = map."ItemId"
              WHERE map."ItemValueId" = value."ItemValueId" AND ($2::boolean OR NOT (item."Type" = ANY($3::bytea[])))
            ) ORDER BY value."CleanValue", value."Value") selected`, values: [this.descriptor.valueType, this.kind === 'Studio', musicTypes.map(nativeTextBytes)] });
        await db.client.query({ text: `CREATE TEMP TABLE ${initial} AS
          SELECT ${sql.guidKey('selected."Id"')} AS "Id" FROM (${plan.text}) selected
          WHERE selected."Id" IS NOT NULL`, values: plan.values });
        await db.client.query({ text: `CREATE TEMP TABLE ${spellings} AS
          SELECT ${sql.guidKey('item."Id"')} AS "Id", item."Name",
            ${nameKey('item."Name"')} AS "NameKey", selected."__ordinal" AS "Ordinal"
          FROM (${plan.text}) selected JOIN ${table('BaseItems')} item ON item."Id" = selected."Id"`, values: plan.values });
        if ((await db.client.query(`SELECT EXISTS (SELECT 1 FROM ${spellings} WHERE "Name" IS NULL) AS "Present"`)).rows[0].Present) {
          throw new TypeError('An existing by-name item requires a name.');
        }
        await db.client.query(`CREATE INDEX ON ${names} ("Ordinal"); CREATE INDEX ON ${initial} ("Id");
          CREATE INDEX ON ${spellings} ("NameKey", "Ordinal")`);
        const count = Number((await db.client.query(`SELECT count(*) AS "Count" FROM ${names}`)).rows[0].Count);
        if (!Number.isSafeInteger(count)) throw new Error('PostgreSQL returned an invalid by-name count.');
        let ordinal = 0n, completed = 0;
        while (true) {
          const page = (await db.client.query({ text: `/* by-name-maintenance-page */ SELECT "Ordinal", "Name" FROM ${names}
            WHERE "Ordinal" > $1 ORDER BY "Ordinal" LIMIT 128`, values: [ordinal] })).rows;
          for (const row of page) {
            ordinal = BigInt(row.Ordinal);
            try {
              if (row.Name == null) throw new TypeError('A by-name lookup requires a name.');
              const existing = (await db.client.query({ text: `SELECT "Id" FROM ${spellings}
                WHERE "NameKey" = ${nameKey('$1::bytea')} ORDER BY "Ordinal" LIMIT 1`, values: [row.Name] })).rows[0];
              const item = existing ?? await this.library[this.descriptor.lookup](decodeNativeTextBytes(row.Name));
              const present = (await db.client.query({ text: `SELECT EXISTS (SELECT 1 FROM ${initial} WHERE "Id" = $1) AS "Present"`,
                values: [idKey(item.Id)] })).rows[0].Present;
              if (!present) await this.metadataScanner.refreshLiveItem(item, { signal });
            } catch (error) {
              if (cancellation(error)) throw error;
              this.logger.error?.(error, `Error refreshing ${row.Name == null ? row.Name : decodeNativeTextBytes(row.Name)}`);
            }
            reportProgress(++completed / count * 100);
          }
          if (page.length < 128) break;
        }
        await this.library.deleteQueryItemsUnsafeFast({ includeitemtypes: this.descriptor.cleanupTypes,
          [this.descriptor.predicate]: true, islocked: false }, { deleteSourceFiles: true });
        reportProgress(100);
      } finally { await db.client.query(`DROP TABLE IF EXISTS ${spellings}, ${initial}, ${names}`); }
    });
  }
}

export class GenresPostScanTask extends ByNamePostScanTask {
  constructor(options) { super('Genre', options); }
}

export class StudiosPostScanTask extends ByNamePostScanTask {
  constructor(options) { super('Studio', options); }
}
