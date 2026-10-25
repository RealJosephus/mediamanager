import { decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';

const moviePageSize = 1000;
const nodePageSize = 128;
const decode = value => value == null ? null : decodeNativeTextBytes(value);
const rootView = row => ({ ...row, Id: decode(row.Id), Name: decode(row.Name), Type: decode(row.Type),
  Path: decode(row.Path), ParentId: decode(row.ParentId) });

/** Reconcile collection names in first encounter order. All library-sized
 * membership, grouping and captured initial names belong to PostgreSQL. */
export class CollectionPostScanTask {
  constructor({ store, source, collections, logger = {} }) {
    if (typeof store?.run !== 'function' || ['getRootFolder', 'getLibraryOptions', 'rootQuery', 'moviePageQuery', 'boxSetQuery']
      .some(name => typeof source?.[name] !== 'function') || typeof collections?.admitPostScanOperation !== 'function') {
      throw new TypeError('Collection maintenance requires relational selection and membership operations.');
    }
    Object.assign(this, { store, source, collections, logger, name: 'Collections' });
  }

  run({ reportProgress = () => {} } = {}) {
    // The native task does not observe its cancellation token, including when
    // a manager reports cancellation. Such a manager failure is per collection.
    let admission;
    try { admission = this.collections.admitPostScanOperation(); }
    catch (error) { return Promise.reject(error); }
    return Promise.resolve().then(() => this.store.run(db => this.#run(db, admission, reportProgress)))
      .finally(() => admission.release());
  }

  async #run(db, admission, reportProgress) {
    const sql = nativeTextSql(db.schemaName);
    const prefix = 'mm_collection_' + randomUUID().replaceAll('-', '');
    const roots = q(prefix + '_roots'), page = q(prefix + '_page'), members = q(prefix + '_members');
    const groups = q(prefix + '_groups'), initial = q(prefix + '_initial');
    try {
      const root = await this.source.getRootFolder();
      const rootQuery = await this.source.rootQuery(db, root);
      await db.client.query({ text: `/* collection-maintenance-roots */ CREATE TEMP TABLE ${roots} AS ${rootQuery.text}`,
        values: rootQuery.values });
      await db.client.query(`CREATE INDEX ON ${roots} ("Ordinal"); CREATE TEMP TABLE ${members} (
        "Name" bytea NOT NULL, "Id" bytea NOT NULL, "IdKey" text NOT NULL, "RootOrdinal" bigint NOT NULL,
        "MovieOrdinal" bigint NOT NULL, PRIMARY KEY ("Name", "IdKey"))`);
      let rootOrdinal = 0n;
      while (true) {
        const rootPage = (await db.client.query({ text: `/* collection-maintenance-root-page */ SELECT * FROM ${roots}
          WHERE "Ordinal" > $1 ORDER BY "Ordinal" LIMIT ${nodePageSize}`, values: [rootOrdinal] })).rows;
        for (const rawParent of rootPage) {
          const parent = rootView(rawParent);
          rootOrdinal = BigInt(parent.Ordinal);
          const options = await this.source.getLibraryOptions(parent);
          if (!options.AutomaticallyAddToCollection) continue;
          let startIndex = 0;
          while (true) {
            const movieQuery = await this.source.moviePageQuery(db, parent, {
              MediaTypes: ['Video'], IncludeItemTypes: ['Movie'], IsVirtualItem: false,
              OrderBy: [{ name: 'SortName', direction: 'Ascending' }],
              ParentId: parent.Id, StartIndex: startIndex, Limit: moviePageSize, Recursive: true,
            });
            await db.client.query({ text: `/* collection-maintenance-movie-page */ CREATE TEMP TABLE ${page} AS ${movieQuery.text}`,
              values: movieQuery.values });
            const size = Number((await db.client.query(`SELECT count(*) AS "Count" FROM ${page}`)).rows[0].Count);
            if (!Number.isSafeInteger(size) || size < 0 || size > moviePageSize) {
              throw new Error('Collection Movie selection exceeded the native page size.');
            }
            await db.client.query({ text: `INSERT INTO ${members}
              SELECT movie."CollectionName", movie."Id", ${sql.guidKey('movie."Id"')}, $1, $2 + movie."Ordinal"
              FROM ${page} movie WHERE movie."CollectionName" IS NOT NULL AND octet_length(movie."CollectionName") > 0
                AND movie."PrimaryVersionId" IS NULL ORDER BY movie."Ordinal"
              ON CONFLICT ("Name", "IdKey") DO NOTHING`, values: [rootOrdinal, startIndex] });
            await db.client.query(`DROP TABLE ${page}`);
            if (size < moviePageSize) break;
            startIndex += moviePageSize;
            if (!Number.isSafeInteger(startIndex)) throw new Error('Collection Movie offset exceeded the supported range.');
          }
        }
        if (rootPage.length < nodePageSize) break;
      }
      await db.client.query(`/* collection-maintenance-groups */ CREATE TEMP TABLE ${groups} AS
        WITH first_names AS (SELECT DISTINCT ON ("Name") "Name", "RootOrdinal", "MovieOrdinal" FROM ${members}
          ORDER BY "Name", "RootOrdinal", "MovieOrdinal"), counts AS (
          SELECT "Name", count(*) AS "Count" FROM ${members} GROUP BY "Name")
        SELECT row_number() OVER (ORDER BY first_names."RootOrdinal", first_names."MovieOrdinal") AS "Ordinal",
          first_names."Name", counts."Count" FROM first_names JOIN counts USING ("Name");
        CREATE INDEX ON ${groups} ("Ordinal")`);
      const count = Number((await db.client.query(`SELECT count(*) AS "Count" FROM ${groups}`)).rows[0].Count);
      if (!Number.isSafeInteger(count)) throw new Error('PostgreSQL returned an invalid Collection name count.');
      if (!count) { reportProgress(100); return; }
      const boxQuery = await this.source.boxSetQuery(db, { IncludeItemTypes: ['BoxSet'], CollapseBoxSetItems: false, Recursive: true });
      await db.client.query({ text: `/* collection-maintenance-initial */ CREATE TEMP TABLE ${initial} AS
        SELECT selected."Ordinal", selected."Id", selected."Name"
        FROM (${boxQuery.text}) selected`, values: boxQuery.values });
      await db.client.query(`CREATE INDEX ON ${initial} ("Name", "Ordinal")`);
      // Native GetItemList constructs fresh repository entities. Later
      // GetItemById mutations affect a separate cache instance, so these
      // captured names stay frozen throughout this task.
      let ordinal = 0n, completed = 0;
      while (true) {
        const groupPage = (await db.client.query({ text: `/* collection-maintenance-group-page */ SELECT * FROM ${groups}
          WHERE "Ordinal" > $1 ORDER BY "Ordinal" LIMIT ${nodePageSize}`, values: [ordinal] })).rows;
        for (const group of groupPage) {
          ordinal = BigInt(group.Ordinal);
          const itemIdsPlan = Object.freeze({ text: `SELECT row_number() OVER (ORDER BY "RootOrdinal", "MovieOrdinal") AS "Ordinal", "Id" FROM ${members} WHERE "Name" = $1
            ORDER BY "RootOrdinal", "MovieOrdinal"`, values: [group.Name] });
          try {
            let box = (await db.client.query({ text: `SELECT "Id" FROM ${initial}
              WHERE "Name" = $1 ORDER BY "Ordinal" LIMIT 1`, values: [group.Name] })).rows[0];
            if (!box && BigInt(group.Count) >= 2n) box = await admission.create({ Name: decode(group.Name) });
            else if (box) box = { Id: decode(box.Id) };
            if (box) await admission.addFromQuery(box.Id, itemIdsPlan);
            reportProgress(++completed / count * 100);
          } catch (error) { this.logger.error?.(error, `Error refreshing ${decode(group.Name)}`, { itemIdsPlan }); }
        }
        if (groupPage.length < nodePageSize) break;
      }
      reportProgress(100);
    } finally { await db.client.query(`DROP TABLE IF EXISTS ${initial}, ${groups}, ${page}, ${members}, ${roots}`); }
  }
}
