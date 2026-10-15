import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { idKey, nonemptyId, cleanValue, libraryError } from './records.js';
import { nativeItemTypes, nativeItemDescriptor, acquireNativeItemLinkOwner } from './native-item-entity.js';
import { cachedFolderChildrenSnapshot } from './folder-cache.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { metadataChildSequence } from './metadata-child-sequence.js';
import { createPostgresCollectionMembership } from './postgres-collection-membership.js';
import { resolvePostgresLinkedChildren } from './postgres-linked-child-resolution.js';
import { buildPostgresSeriesEpisodePageQuery } from './postgres-series-episodes-query.js';
import { queryPostgresItemPage } from '../database/postgres-item-query.js';
import { createPresentationUniqueKey } from './presentation-key.js';
import { resolveSeriesAsync } from './series-reference.js';
import { nativeContainsSubPath } from './native-path.js';
import path from 'node:path';

const plan = (text, values = []) => Object.freeze({ text, values: Object.freeze(values) });
const encoded = value => value == null ? null : nativeTextBytes(value);
const type = (sql, alias) => `substring(${sql.projection(`${alias}."Type"`)} from '[^.]+$')`;
const folders = nativeItemTypes.filter(value => nativeItemDescriptor(value).family === 'folder').map(nativeTextBytes);
const rebase = (source, offset) => source.text.replace(/\$(\d+)\b/gu, (_, number) => '$' + (Number(number) + offset));

async function cleanupResources(primary, operations, message) {
  const failures = [];
  for (const operation of operations) {
    try { await operation(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(primary ? [primary, ...failures] : failures,
    primary?.message ?? message, primary ? { cause: primary } : undefined);
}

async function physicalPlan(session, parent, recursive, { linkedChildren, library }) {
  const sql = nativeTextSql(session.schemaName), items = `${q(session.schemaName)}."BaseItems"`;
  const dataPath=library.options.dataPath??(library.options.programDataPath&&path.join(library.options.programDataPath,'data'));
  const empty=()=>plan('SELECT NULL::bytea AS "Id", 0::bigint AS "Ordinal" WHERE FALSE');
  if(parent.Type==='Playlist')return empty();
  if(parent.Type==='BoxSet'&&(!parent.Path||await linkedChildren.count(parent.LinkedChildren)>0n||dataPath&&nativeContainsSubPath(parent.Path,dataPath)))return empty();
  const values = [encoded(parent.Id), folders, encoded(dataPath), encoded('MediaBrowser.Controller.Entities.Movies.BoxSet'), encoded('MediaBrowser.Controller.Playlists.Playlist')];
  const present = expression => `${expression} IS NOT NULL AND octet_length(${expression})>0 AND ${sql.guidKey(expression)}<>'00000000000000000000000000000000'`;
  const visible = alias => `(NOT (${present(`${alias}."OwnerId"`)}) OR ${alias}."ExtraType" IS NOT NULL)
    AND (NOT (${present(`${alias}."PrimaryVersionId"`)}) OR NOT EXISTS(SELECT 1 FROM ${items} primary_item
      WHERE ${sql.guidKey('primary_item."Id"')}=${sql.guidKey(`${alias}."PrimaryVersionId"`)}
        AND ${sql.guidKey('primary_item."TopParentId"')} IS NOT DISTINCT FROM ${sql.guidKey(`${alias}."TopParentId"`)}))`;
  if (parent.Type === 'MusicArtist' && !nonemptyId(parent.ParentId)) return plan('SELECT NULL::bytea AS "Id", 0::bigint AS "Ordinal" WHERE FALSE');
  const ordered = `ordered AS (SELECT item.*, row_number() OVER(PARTITION BY ${sql.guidKey('item."ParentId"')}
    ORDER BY item."SortName" ASC NULLS FIRST,item."Id") AS position FROM ${items} item WHERE ${visible('item')})`;
  if (!recursive) return plan(`WITH ${ordered} SELECT "Id",position AS "Ordinal" FROM ordered
    WHERE ${sql.guidKey('"ParentId"')}=${sql.guidKey('$1::bytea')} ORDER BY position`, values.slice(0, 1));
  return plan(`WITH RECURSIVE ${ordered}, walk AS (
    SELECT item."Id",item."Type",ARRAY[item.position] AS path,ARRAY[${sql.guidKey('$1::bytea')},${sql.guidKey('item."Id"')}] AS seen,
      ${sql.guidKey('item."Id"')}=${sql.guidKey('$1::bytea')} AS cycle
    FROM ordered item WHERE ${sql.guidKey('item."ParentId"')}=${sql.guidKey('$1::bytea')}
    UNION ALL SELECT item."Id",item."Type",walk.path||item.position,walk.seen||${sql.guidKey('item."Id"')},
      ${sql.guidKey('item."Id"')}=ANY(walk.seen) AS cycle
    FROM walk JOIN ordered item ON ${sql.guidKey('item."ParentId"')}=${sql.guidKey('walk."Id"')}
    WHERE NOT walk.cycle AND walk."Type"=ANY($2::bytea[]) AND walk."Type"<>$5::bytea
      AND (walk."Type"<>$4::bytea OR EXISTS(SELECT 1 FROM ordered container WHERE container."Id"=walk."Id"
        AND container."Path" IS NOT NULL AND octet_length(container."Path")>0
        AND NOT EXISTS(SELECT 1 FROM ${q(session.schemaName)}."LinkedChildren" link WHERE ${sql.guidKey('link."ParentId"')}=${sql.guidKey('container."Id"')})
        AND ($3::bytea IS NULL OR NOT (octet_length(${sql.ordinalIgnoreCaseKey('container."Path"')})>octet_length(${sql.ordinalIgnoreCaseKey('$3::bytea')})
          AND substring(${sql.ordinalIgnoreCaseKey('container."Path"')} from 1 for octet_length(${sql.ordinalIgnoreCaseKey('$3::bytea')}))=${sql.ordinalIgnoreCaseKey('$3::bytea')}
          AND substring(${sql.ordinalIgnoreCaseKey('container."Path"')} from octet_length(${sql.ordinalIgnoreCaseKey('$3::bytea')})+1 for 2)=ANY(ARRAY[decode('002f','hex'),decode('005c','hex')])))))
  ) SELECT "Id",row_number() OVER(ORDER BY path) AS "Ordinal",cycle FROM walk ORDER BY path`, values);
}

/** SQL owns each complete membership and its order. All repository rows are
 * mapped into an owned typed cohort before metadata mutations can begin. */
export function createMetadataChildren({ store, library, linkedChildren, configuration = {}, libraryOptions = {} }) {
  if (!store || !library || !linkedChildren) throw new TypeError('Metadata children require the native store, library and shared relation repository.');
  const itemCreation = () => {
    if (!library.itemCreation) throw new TypeError('Metadata children require the authoritative item creation cache.');
    return library.itemCreation;
  };
  const keyFor = item => item.PresentationUniqueKey ?? createPresentationUniqueKey(item, { libraryOptions });
  const findByPath = async identity => store.run(async db => {
    const stored = library.options?.reversePath?.(identity) ?? identity;
    const result = await queryPostgresItemPage(db, { sortby: ['DateCreated'], sortorder: ['Descending'], limit: 1, enabletotalrecordcount: false },
      { groupByPresentationKey: false, itemIdsPlan: plan(`SELECT "Id" FROM ${q(db.schemaName)}."BaseItems" WHERE "Path"=$1`, [encoded(stored)]) });
    return result.rows.length ? itemCreation().getItemById(result.rows[0].Id) : null;
  }, { readOnly: true });

  async function capturePlan(session, source, cohort, target, { offset = 0n, predicate = () => true } = {}) {
    const selected = q('mm_metadata_children_' + randomUUID().replaceAll('-', ''));
    const sql = nativeTextSql(session.schemaName);
    await session.client.query({ text: `CREATE TEMP TABLE ${selected} AS SELECT source."Ordinal",item.*,
      COALESCE(to_jsonb(source)->>'cycle','false')::boolean AS cycle FROM (${source.text}) source
      JOIN ${q(session.schemaName)}."BaseItems" item ON ${sql.guidKey('item."Id"')}=${sql.guidKey('source."Id"')}`, values: source.values });
    let failure;
    try {
      if ((await session.client.query(`SELECT EXISTS(SELECT 1 FROM ${selected} WHERE cycle) AS cycle`)).rows[0].cycle) throw libraryError(409, 'The metadata folder hierarchy contains a cycle.');
      const columns = tableDefinition('BaseItems').columns;
      for (let after = 0n; ;) {
        const rows = (await session.client.query(`SELECT * FROM ${selected} WHERE "Ordinal">$1 ORDER BY "Ordinal" LIMIT 128`, [after])).rows;
        if (!rows.length) return;
        const baseRows = rows.map(row => Object.fromEntries(columns.map(column => [column.name, decodeValue(column, row[column.name], 'postgres')])));
        const state = await library.load(session, null, { baseRows, includeManualLinks: false, includeFolderLinks: false, includeLinkGraph: false });
        let rowFailure;
        try {
          for (const row of rows) {
            const item = state.byId.get(idKey(decodeNativeTextBytes(row.Id)));
            if (!item || !predicate(item)) continue;
            const ordinal = offset + BigInt(row.Ordinal), slot = await cohort.capture(item, { ordinal });
            await session.client.query(`INSERT INTO ${target}("Ordinal","Id","SlotKey") VALUES ($1,$2,$3)`, [ordinal, row.Id, slot]);
          }
        } catch (error) { rowFailure = error; throw error; }
        finally { await cleanupResources(rowFailure, [() => state.dispose({ session }), () => linkedChildren.flushReleases({ session })],
          'Metadata child page cleanup failed.'); }
        after = BigInt(rows.at(-1).Ordinal);
      }
    } catch (error) { failure = error; throw error; }
    finally { await cleanupResources(failure, [() => session.client.query(`DROP TABLE ${selected}`)],
      'Metadata child capture table cleanup failed.'); }
  }

  async function capturePhysicalChildren(session, parent, recursive, cohort, target, predicate) {
    if (cachedFolderChildrenSnapshot(parent) === undefined) {
      return capturePlan(session, await physicalPlan(session, parent, recursive, { linkedChildren, library }), cohort, target, { predicate });
    }
    const ancestry = q('mm_metadata_cached_path_' + randomUUID().replaceAll('-', ''));
    await session.client.query(`CREATE TEMP TABLE ${ancestry}(key text PRIMARY KEY)`);
    const cursor = { value: 0n };
    async function captureChildren(current) {
      const cached = cachedFolderChildrenSnapshot(current);
      if (cached === undefined) {
        await capturePlan(session, await physicalPlan(session, current, recursive, { linkedChildren, library }), cohort, target,
          { predicate, offset: cursor.value });
        cursor.value = BigInt((await session.client.query(`SELECT COALESCE(max("Ordinal"),0) AS value FROM ${target}`)).rows[0].value);
        return;
      }
      const key = idKey(current.Id);
      const entered = await session.client.query(`INSERT INTO ${ancestry}(key) VALUES($1) ON CONFLICT DO NOTHING`, [key]);
      if (!entered.rowCount) throw libraryError(409, 'The metadata folder hierarchy contains a cycle.');
      let failure;
      try {
        // This is the already captured native Children iterable, not a newly
        // materialized collection. Each exact child is owned across SQL awaits.
        for (const child of cached) {
          const owner = acquireNativeItemLinkOwner(child);
          let childFailure;
          try {
            if (predicate(child)) {
              const ordinal = ++cursor.value, slot = await cohort.capture(child, { ordinal });
              await session.client.query(`INSERT INTO ${target}("Ordinal","Id","SlotKey") VALUES($1,$2,$3)`,
                [ordinal, encoded(child.Id), slot]);
            }
            if (recursive && child.IsFolder) await captureChildren(child);
          } catch (error) { childFailure = error; throw error; }
          finally { await cleanupResources(childFailure, [() => owner.release(), () => linkedChildren.flushReleases({ session })],
            'Cached metadata child ownership cleanup failed.'); }
        }
      } catch (error) { failure = error; throw error; }
      finally { await cleanupResources(failure, [() => session.client.query(`DELETE FROM ${ancestry} WHERE key=$1`, [key])],
        'Cached metadata child ancestry cleanup failed.'); }
    }
    let failure;
    try { await captureChildren(parent); }
    catch (error) { failure = error; throw error; }
    finally { await cleanupResources(failure, [() => session.client.query(`DROP TABLE ${ancestry}`)],
      'Cached metadata child path table cleanup failed.'); }
  }

  async function captureLinks(session, item, cohort, target, offset = 0n, predicate = () => true) {
    if (nativeItemDescriptor(item.NativeType).family !== 'folder') return;
    const membership = await createPostgresCollectionMembership(session, { collectionId: item.Id, linksPlan: linkedChildren.plan(item.LinkedChildren) });
    let captured, failure;
    try {
      captured = await createNativeItemCohort({ linkedChildren });
      await resolvePostgresLinkedChildren({ session, item, library, links: item.LinkedChildren, linkedChildren,
        itemCreation: itemCreation(), findByPath, membership, cohort: captured });
      for (let after = 0n; ;) {
        const page = await captured.page({ after });
        let pageFailure;
        try {
          if (!page.entries.length) break;
          for (const entry of page.entries) if (predicate(entry.item)) {
            const ordinal = offset + entry.Ordinal, slot = await cohort.capture(entry.item, { ordinal });
            await session.client.query(`INSERT INTO ${target}("Ordinal","Id","SlotKey") VALUES($1,$2,$3)`, [ordinal, encoded(entry.item.Id), slot]);
          }
          after = page.entries.at(-1).Ordinal;
        } catch (error) { pageFailure = error; throw error; }
        finally { await cleanupResources(pageFailure, [() => page.release()], 'Metadata linked child page cleanup failed.'); }
      }
    } catch (error) { failure = error; throw error; }
    finally {
      const errors = [];
      for (const cleanup of [() => captured?.release(), () => membership.dispose()]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors,
        failure?.message ?? 'Metadata linked child cleanup failed.', failure ? { cause: failure } : undefined);
    }
  }

  async function selected(item, mode, { series, physicalSeriesId, includeLinkedChildren = true, preserveDuplicates = false } = {}) {
    let cohort = await createNativeItemCohort({ linkedChildren }), view;
    try {
      view = await store.run(async session => {
        const target = q('mm_metadata_selection_' + randomUUID().replaceAll('-', ''));
        await session.client.query(`CREATE TEMP TABLE ${target}("Ordinal" bigint,"Id" bytea,"SlotKey" uuid)`);
        let failure;
        try {
          if (mode === 'linked') await captureLinks(session, item, cohort, target);
          else if (mode === 'season' || mode === 'series') {
            if (mode === 'season' && !series) {
              series = await resolveSeriesAsync(item, id => itemCreation().getItemById(id));
            }
            if (mode === 'series' || series && series.SourceType !== 'Channel' && series.SourceType !== 1) {
              const query = buildPostgresSeriesEpisodePageQuery(session, { mode: mode === 'series' ? 'series' : 'season',
                seasonId: mode === 'season' ? item.Id : undefined, seriesKey: keyFor(mode === 'series' ? item : series),
                includeMissing: true, includeSpecials: configuration.DisplaySpecialsWithinSeasons ?? true, groupByPresentationKey: false });
              let relation = query.relation;
              if (nonemptyId(physicalSeriesId)) {
                const sql = nativeTextSql(session.schemaName), index = relation.values.length + 1;
                relation = plan(`WITH RECURSIVE candidates AS (${relation.text}), ancestry AS (
                  SELECT "Id" AS item_id,"Id",ARRAY[${sql.guidKey('"Id"')}] AS seen FROM candidates
                  UNION ALL SELECT ancestry.item_id,parent."Id",ancestry.seen||${sql.guidKey('parent."Id"')}
                  FROM ancestry JOIN ${q(session.schemaName)}."BaseItems" current ON ${sql.guidKey('current."Id"')}=${sql.guidKey('ancestry."Id"')}
                  JOIN ${q(session.schemaName)}."BaseItems" parent ON ${sql.guidKey('parent."Id"')}=${sql.guidKey('current."ParentId"')}
                  WHERE NOT ${sql.guidKey('parent."Id"')}=ANY(ancestry.seen)
                ) SELECT * FROM candidates WHERE EXISTS(SELECT 1 FROM ancestry WHERE
                  ${sql.guidKey('ancestry.item_id')}=${sql.guidKey('candidates."Id"')} AND ${sql.guidKey('ancestry."Id"')}=$${index})
                  ORDER BY "Ordinal"`, [...relation.values, idKey(physicalSeriesId)]);
              }
              await capturePlan(session, relation, cohort, target);
            }
          } else if (mode === 'artist-by-name') {
            const sql = nativeTextSql(session.schemaName), items = `${q(session.schemaName)}."BaseItems"`;
            const source = plan(`SELECT item."Id",row_number() OVER(ORDER BY item."SortName" ASC NULLS FIRST,item."Id") AS "Ordinal"
              FROM ${items} item WHERE ${type(sql, 'item')} IN ('Audio','MusicVideo','MusicAlbum') AND item."IsFolder" IS NOT TRUE
              AND EXISTS(SELECT 1 FROM ${q(session.schemaName)}."ItemValuesMap" map JOIN ${q(session.schemaName)}."ItemValues" value
                ON ${sql.guidKey('value."ItemValueId"')}=${sql.guidKey('map."ItemValueId"')}
                WHERE ${sql.guidKey('map."ItemId"')}=${sql.guidKey('item."Id"')}
                  AND value."Type" IN(0,1) AND value."CleanValue"=$1)`, [encoded(cleanValue(item.Name))]);
            await capturePlan(session, source, cohort, target);
          } else {
            const predicate = mode === 'albums' ? value => value.Type==='MusicAlbum' : mode === 'tracks' ? value => ['Audio', 'AudioBook'].includes(value.Type)
              : item.Type === 'MusicArtist' && mode === 'children' ? value => ['Audio', 'AudioBook', 'MusicAlbum', 'MusicVideo'].includes(value.Type) && !value.IsFolder : () => true;
            await capturePhysicalChildren(session, item, mode !== 'physical', cohort, target, predicate);
            if (mode !== 'physical' && includeLinkedChildren) {
              const offset = BigInt((await session.client.query(`SELECT COALESCE(max("Ordinal"),0) AS value FROM ${target}`)).rows[0].value);
              await captureLinks(session, item, cohort, target, offset, predicate);
            }
          }
          const sql = nativeTextSql(session.schemaName);
          const selection = mode === 'linked' || preserveDuplicates ? `SELECT row_number() OVER(ORDER BY "Ordinal") AS "Ordinal","SlotKey" FROM ${target} ORDER BY "Ordinal"`
            : `WITH ranked AS (SELECT *,row_number() OVER(PARTITION BY ${sql.guidKey('"Id"')} ORDER BY "Ordinal") AS first,
              first_value("SlotKey") OVER(PARTITION BY ${sql.guidKey('"Id"')} ORDER BY "Ordinal" DESC) AS last_slot FROM ${target})
              SELECT row_number() OVER(ORDER BY "Ordinal") AS "Ordinal",last_slot AS "SlotKey" FROM ranked WHERE first=1 ORDER BY "Ordinal"`;
          view = await cohort.view({ session, plan: plan(selection) });
          return view;
        } catch (error) { failure = error; throw error; }
        finally { await cleanupResources(failure, [() => session.client.query(`DROP TABLE ${target}`)],
          'Metadata child selection table cleanup failed.'); }
      });
      await cohort.release(); cohort = null;
      return metadataChildSequence(view, linkedChildren, store);
    } catch (error) {
      await cleanupResources(error, [() => view?.release(), () => cohort?.release()], 'Metadata child selection ownership cleanup failed.');
      throw error;
    }
  }

  async function libraryFolderIds(item) {
    const queue = q('mm_boxset_queue_' + randomUUID().replaceAll('-', '')), visited = q('mm_boxset_seen_' + randomUUID().replaceAll('-', '')),
      output = q('mm_boxset_folders_' + randomUUID().replaceAll('-', ''));
    return store.run(async session => {
      await session.client.query(`CREATE TEMP TABLE ${queue}(path bigint[] PRIMARY KEY,id bytea,done boolean DEFAULT FALSE);
        CREATE TEMP TABLE ${visited}(id text PRIMARY KEY); CREATE TEMP TABLE ${output}(id bytea,key text PRIMARY KEY,path bigint[])`);
      let failure;
      try {
        await session.client.query(`INSERT INTO ${queue}(path,id) VALUES (ARRAY[0::bigint],$1)`, [encoded(item.Id)]);
        for (;;) {
          const row = (await session.client.query(`SELECT * FROM ${queue} WHERE NOT done ORDER BY path LIMIT 1`)).rows[0];
          if (!row) break;
          await session.client.query(`UPDATE ${queue} SET done=TRUE WHERE path=$1`, [row.path]);
          const id = decodeNativeTextBytes(row.id), value = idKey(id) === idKey(item.Id) ? item : await itemCreation().getItemById(id);
          if (!value) continue;
          const owner = acquireNativeItemLinkOwner(value);
          let itemFailure;
          try {
          if (value.Type === 'BoxSet') {
            if (!(await session.client.query(`INSERT INTO ${visited}(id) VALUES($1) ON CONFLICT DO NOTHING`, [idKey(value.Id)])).rowCount) continue;
            const children = await selected(value, 'linked');
            let childFailure;
            try { let ordinal = 0n; for await (const page of children.pages()) for (const child of page) {
              await session.client.query(`INSERT INTO ${queue}(path,id) VALUES($1,$2)`, [[...row.path, String(++ordinal)], encoded(child.Id)]);
            } } catch (error) { childFailure = error; throw error; }
            finally { await cleanupResources(childFailure, [() => children.close()], 'BoxSet affiliation child sequence cleanup failed.'); }
          } else {
            let ordinal = 0n;
            for (const folder of await library.getCollectionFolders(value)) await session.client.query(`INSERT INTO ${output}(id,key,path) VALUES($1,$2,$3)
              ON CONFLICT(key) DO NOTHING`, [encoded(folder.Id), idKey(folder.Id), [...row.path, String(++ordinal)]]);
          }
          } catch (error) { itemFailure = error; throw error; }
          finally { await cleanupResources(itemFailure, [() => owner.release(), () => linkedChildren.flushReleases({ session })],
            'BoxSet affiliation entity ownership cleanup failed.'); }
        }
        const result = [];
        for (let after = 0n; ;) {
          const page = (await session.client.query(`SELECT * FROM (SELECT id,row_number() OVER(ORDER BY path) AS ordinal FROM ${output}) value
            WHERE ordinal>$1 ORDER BY ordinal LIMIT 128`, [after])).rows;
          if (!page.length) return result;
          for (const row of page) result.push(decodeNativeTextBytes(row.id));
          after = BigInt(page.at(-1).ordinal);
        }
      } catch (error) { failure = error; throw error; }
      finally { await cleanupResources(failure, [() => session.client.query(`DROP TABLE ${queue},${visited},${output}`)],
        'BoxSet affiliation selection cleanup failed.'); }
    });
  }
  return Object.freeze({
    children: item => selected(item, item.Type === 'BoxSet' ? 'linked' : item.Type === 'Season' ? 'season'
      : item.Type === 'MusicArtist' && !nonemptyId(item.ParentId) ? 'artist-by-name' : item.Type === 'MusicAlbum' ? 'tracks' : 'children'),
    physical: (item, options) => selected(item, 'physical', options), recursive: (item,options) => selected(item, 'recursive',options),
    seasonEpisodes: (item, options) => selected(item, 'season', options), seriesEpisodes: item => selected(item, 'series'),
    tracks: item => selected(item, 'tracks'), albums: item => selected(item, 'albums'), libraryFolderIds
  });
}
