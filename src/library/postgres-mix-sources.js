import { nativeTextSql } from '../database/native-text-sql.js';
import { decodeNativeTextBytes } from '../database/native-text.js';
import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q } from '../database/model.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { clrTrim } from '../metadata/whitespace.js';
import { idKey } from './records.js';

const normalizedId = (database, expression) => nativeTextSql(database.schemaName).guidKey(expression);
const offsetParameters = (text, offset) => text.replace(/\$(\d+)/gu, (_, index) => `$${Number(index) + offset}`);

/** Folder.AddChildren visits each folder once, emits its matching children,
 * then descends through visible folders in cached/linked child order. Keep
 * its traversal state in PostgreSQL, including DAGs and cycles, and expose
 * only bounded genre pages to the lookup consumer. */
export async function* postgresFolderMixGenres(database, item, {
  user, visibility, collectionRoots = [], configuration = {},
}) {
  const prefix = 'mm_mix_source_' + randomUUID().replaceAll('-', '');
  const edges = q(prefix + '_edges'), queue = q(prefix + '_queue');
  const visited = q(prefix + '_visited'), sources = q(prefix + '_sources');
  const base = `${q(database.schemaName)}.${q('BaseItems')}`;
  const links = `${q(database.schemaName)}.${q('LinkedChildren')}`;
  const rootDefinitions = collectionRoots.flatMap(collection => collection.ids.map((id, index) => ({
    parent: idKey(collection.Id), physical: idKey(id), ordinal: index,
  })));
  const itemIdsPlan = {
    text: `WITH RECURSIVE collection_roots AS (
        SELECT * FROM jsonb_to_recordset($2::jsonb) AS root(parent text, physical text, ordinal bigint)
      ), scope("Id") AS (
        SELECT $1::text COLLATE "C"
        UNION
        SELECT ${normalizedId(database, 'edge."Id"')} COLLATE "C"
        FROM scope current JOIN ${base} parent ON ${normalizedId(database, 'parent."Id"')} = current."Id"
        CROSS JOIN LATERAL (
          SELECT child."Id" FROM ${base} child WHERE ${normalizedId(database, 'child."ParentId"')} = current."Id"
          UNION
          SELECT child."Id" FROM collection_roots root JOIN ${base} child
            ON ${normalizedId(database, 'child."ParentId"')} = root.physical WHERE root.parent = current."Id"
          UNION
          SELECT link."ChildId" FROM ${links} link WHERE ${normalizedId(database, 'link."ParentId"')} = current."Id"
        ) edge WHERE parent."IsFolder"
      ) SELECT selected."Id" FROM scope JOIN ${base} selected
          ON ${normalizedId(database, 'selected."Id"')} = scope."Id"`,
    values: [idKey(item.Id), JSON.stringify(rootDefinitions)],
  };
  const cached = buildPostgresItemPageQuery(database, {}, { groupByPresentationKey: false, itemIdsPlan });
  const visible = buildPostgresItemPageQuery(database, {}, {
    userId: user.Id, includeOwnedItems: true, includeAlternateVersions: true,
    groupByPresentationKey: false, resumableMode: 'memory',
    memorySortConfiguration: configuration, memoryUserViewFilter: true, visibility, itemIdsPlan,
  });
  const values = [...cached.values, ...visible.values];
  const roots = values.push(JSON.stringify(rootDefinitions));
  const requested = values.push(idKey(item.Id));
  try {
    await database.client.query({ text: `/* folder-mix-source-edges */
      CREATE TEMP TABLE ${edges} AS
      WITH RECURSIVE cached AS (${cached.text}), visible AS (${offsetParameters(visible.text, cached.values.length)}),
      collection_roots AS (
        SELECT * FROM jsonb_to_recordset($${roots}::jsonb) AS root(parent text, physical text, ordinal bigint)
      ), raw_edges AS (
        SELECT ${normalizedId(database, 'child."ParentId"')} AS "ParentId",
          child."Id" AS "ChildId", child."IsFolder", child."Type", child."Genres",
          0 AS "Group", 0::bigint AS "RootOrdinal", child."SortName", 0::bigint AS "LinkOrder"
        FROM ${base} child
        JOIN cached ON cached."Id" = child."Id"
        UNION ALL
        SELECT root.parent, child."Id", child."IsFolder", child."Type", child."Genres",
          0, root.ordinal, child."SortName", 0::bigint
        FROM collection_roots root JOIN ${base} child ON root.physical = ${normalizedId(database, 'child."ParentId"')}
        JOIN cached ON cached."Id" = child."Id"
        UNION ALL
        SELECT ${normalizedId(database, 'link."ParentId"')}, child."Id", child."IsFolder", child."Type", child."Genres",
          1, 0, NULL, link."SortOrder"::bigint
        FROM ${links} link JOIN ${base} child ON child."Id" = link."ChildId"
      ), reach("Id") AS (
        SELECT $${requested}::text COLLATE "C"
        UNION
        SELECT ${normalizedId(database, 'edge."ChildId"')} COLLATE "C"
        FROM reach parent JOIN raw_edges edge ON edge."ParentId" = parent."Id"
        JOIN visible ON visible."Id" = edge."ChildId"
        WHERE edge."IsFolder"
      )
      SELECT edge.*, row_number() OVER (PARTITION BY edge."ParentId"
        ORDER BY edge."Group", edge."RootOrdinal", edge."SortName" ASC NULLS FIRST,
          edge."LinkOrder", edge."ChildId") AS "Ordinal"
      FROM raw_edges edge JOIN reach parent ON parent."Id" = edge."ParentId"
      JOIN visible ON visible."Id" = edge."ChildId"`, values });
    await database.client.query(`CREATE INDEX ON ${edges} ("ParentId", "Ordinal");
      CREATE TEMP TABLE ${queue} ("Id" text, "Path" bigint[]);
      CREATE INDEX ON ${queue} ("Path", "Id");
      CREATE TEMP TABLE ${visited} ("Id" text PRIMARY KEY);
      CREATE TEMP TABLE ${sources} ("Id" bytea PRIMARY KEY, "Genres" bytea,
        "Ordinal" bigint GENERATED ALWAYS AS IDENTITY);`);
    await database.client.query({ text: `INSERT INTO ${queue} VALUES ($1, ARRAY[]::bigint[])`, values: [idKey(item.Id)] });
    await database.client.query(`DO $folder_mix$
      DECLARE frame record;
      BEGIN
        LOOP
          SELECT ctid AS "Row", "Id", "Path" INTO frame FROM ${queue} ORDER BY "Path", "Id" LIMIT 1;
          EXIT WHEN NOT FOUND;
          DELETE FROM ${queue} WHERE ctid = frame."Row";
          IF NOT EXISTS (SELECT 1 FROM ${visited} WHERE "Id" = frame."Id") THEN
            INSERT INTO ${visited} VALUES (frame."Id");
            INSERT INTO ${sources} ("Id", "Genres")
              SELECT edge."ChildId", edge."Genres" FROM ${edges} edge
              WHERE edge."ParentId" = frame."Id"
                AND edge."Type" = 'MediaBrowser.Controller.Entities.Audio.Audio'
              ORDER BY edge."Ordinal" ON CONFLICT ("Id") DO NOTHING;
            INSERT INTO ${queue}
              SELECT ${normalizedId(database, 'edge."ChildId"')}, frame."Path" || edge."Ordinal"
              FROM ${edges} edge WHERE edge."ParentId" = frame."Id" AND edge."IsFolder"
                AND NOT EXISTS (SELECT 1 FROM ${visited} WHERE "Id" = ${normalizedId(database, 'edge."ChildId"')});
          END IF;
        END LOOP;
      END $folder_mix$;`);
    let ordinal = 0n;
    while (true) {
      const result = await database.client.query({ text: `/* folder-mix-genre-page */
        SELECT "Ordinal", "Genres" FROM ${sources} WHERE "Ordinal" > $1 ORDER BY "Ordinal" LIMIT 128`, values: [ordinal] });
      for (const row of result.rows) {
        ordinal = BigInt(row.Ordinal);
        const genres = row.Genres == null ? null : decodeNativeTextBytes(row.Genres);
        if (genres && clrTrim(genres)) {
          yield genres.split('|');
        }
      }
      if (result.rows.length < 128) break;
    }
  } finally {
    await database.client.query(`DROP TABLE IF EXISTS ${sources}, ${visited}, ${queue}, ${edges}`);
  }
}
