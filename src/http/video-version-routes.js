import { HttpResult, commaGuidValues, guidValue, httpError, noContent, notFound } from './binding.js';
import { withCleanup } from '../core/operation-failure.js';
import { nativeTextBytes } from '../database/native-text.js';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { visitPostgresItemPlanPages } from '../database/postgres-item-query.js';
import { setPrimaryVersion, updateLiveItemRepository } from '../library/live-item-repository.js';
import { nativeItemDescriptor, nativeItemTypes } from '../library/native-item-entity.js';
import { VIDEO_TYPES, idKey, nonemptyId, sameId } from '../library/records.js';
import { ItemUpdateType } from '../metadata/save-manager.js';
import { resolvePostgresSearchCollation } from '../library/postgres-search-provider.js';

const videoTypes = nativeItemTypes.filter(type => nativeItemDescriptor(type).family === 'video').map(nativeTextBytes);

function videoQueries(db, culture) {
  const table = name => q(db.schemaName) + '.' + q(name);
  const itemsTable = table('BaseItems'), linksTable = table('LinkedChildren'), streamsTable = table('MediaStreamInfos');
  const sql = nativeTextSql(db.schemaName);
  return {
    async primary(items) {
      const values = [items.map(item => idKey(item.Id)), items.map(item => item.DefaultVideoStreamIndex),
        items.map(item => item.VideoType === 'VideoFile' && item.Video3DFormat == null), videoTypes];
      const rows = (await db.client.query({ text: `WITH ranked AS (
        SELECT candidate.*, COALESCE(stream."Width", 0) AS width,
          (item."PrimaryVersionId" IS NULL AND EXISTS (
            SELECT 1 FROM ${linksTable} link
            JOIN ${itemsTable} child ON child."Id" = link."ChildId"
            WHERE link."ParentId" = item."Id"
              AND (link."ChildType" = 2 OR link."ChildType" = 3 AND child."Type" = ANY($4::bytea[]))
          )) AS existing_group
        FROM unnest($1::text[], $2::int[], $3::bool[]) WITH ORDINALITY AS candidate(key, stream_index, plain, ordinality)
        JOIN ${itemsTable} item ON ${sql.guidKey('item."Id"')} = candidate.key
        LEFT JOIN ${streamsTable} stream ON stream."ItemId" = item."Id" AND stream."StreamIndex" = candidate.stream_index
      ) SELECT ordinality FROM ranked
        ORDER BY existing_group DESC, CASE WHEN NOT existing_group THEN plain END DESC,
          CASE WHEN NOT existing_group THEN width END DESC, key, ordinality LIMIT 1`, values })).rows;
      return items[Number(rows[0]?.ordinality) - 1];
    },
    async visitAlternates(id, visit) {
      const collation = await resolvePostgresSearchCollation(db, culture);
      const sortName = `replace(replace(${sql.projection('child."SortName"')}, chr(1) || '0', ''), chr(1) || '1', '')`;
      const plan = {
        text: `SELECT child."Id", 0 AS "TotalRecordCount" FROM ${linksTable} link
          JOIN ${itemsTable} child ON child."Id" = link."ChildId"
          WHERE ${sql.guidKey('link."ParentId"')} = $1 AND link."ChildType" = 3 AND child."Type" = ANY($2::bytea[])
          ORDER BY ${sortName} COLLATE ${q(collation.schema)}.${q(collation.name)} NULLS FIRST, link."SortOrder"`,
        values: [idKey(id), videoTypes],
      };
      return withCleanup(() => visitPostgresItemPlanPages(db, plan, {}, visit), [() => collation.release()],
        'Video alternate selection cleanup failed.');
    },
  };
}

export function registerVideoVersionRoutes(add, { store, library, itemCreation, metadataUpdates, loadContext, linkedChildReferences }) {
  if (!library) return;
  const policy = 'RequiresElevation';
  const save = item => updateLiveItemRepository(item, { loadContext, itemCreation, updates: metadataUpdates,
    updateReason: ItemUpdateType.MetadataEdit, includeChildren: false });
  const write = (context, operation) => {
    if (!store || !itemCreation || !metadataUpdates || !loadContext || !linkedChildReferences) {
      throw httpError(503, 'Video version persistence is unavailable.');
    }
    return store.serializeWrites(async db => {
      const owners = new Map();
      const load = async (id, visible = false) => {
        if (!nonemptyId(id)) throw httpError(400, "Guid can't be empty. (Parameter 'id')");
        if (visible) {
          try { if (!VIDEO_TYPES.has((await library.getItemRecord(id, { user: context.auth.User })).Type)) return null; }
          catch (error) { if (error?.status === 404) return null; throw error; }
        }
        if (owners.has(idKey(id))) return owners.get(idKey(id)).item;
        const item = await itemCreation.getItemById(id);
        if (!item || !VIDEO_TYPES.has(item.Type)) return null;
        owners.set(idKey(id), { item, owner: itemCreation.retainItem(item) });
        return item;
      };
      const release = () => { for (const { owner } of owners.values()) owner.release(); };
      const culture = library.options.localization?.context?.culture ?? 'en-US';
      return withCleanup(() => operation(videoQueries(db, culture), load),
        [release, () => itemCreation.linkedChildren.flushReleases()], 'Video version operation cleanup failed.');
    });
  };

  add('POST', '/Videos/MergeVersions', context => write(context, async (queries, load) => {
    const items = [];
    for (const id of context.queryInput) {
      const item = await load(id, true);
      if (item) items.push(item);
    }
    if (items.length < 2) return new HttpResult(400, 'Please supply at least two videos to merge.', { text: true });
    const primary = await queries.primary(items);
    if (!primary) return notFound();
    const links = [...primary.LinkedAlternateVersions];
    const linked = new Set(links.map(link => idKey(link.ItemId)));
    const append = link => {
      const id = idKey(link.ItemId);
      if (id && !linked.has(id)) { links.push(link); linked.add(id); }
    };
    // Native orders the secondary writes and reference updates by Guid.
    items.sort((left, right) => idKey(left.Id).localeCompare(idKey(right.Id), 'en-US'));
    for (const item of items) {
      if (sameId(item.Id, primary.Id)) continue;
      setPrimaryVersion(item, primary.Id);
      await save(item);
      await linkedChildReferences.reroute(item.Id, primary.Id);
      append({ ItemId: item.Id, Type: 3 });
      for (const link of item.LinkedAlternateVersions) append(link);
      if (item.LinkedAlternateVersions.length) {
        item.LinkedAlternateVersions = [];
        await save(item);
      }
    }
    primary.LinkedAlternateVersions = links;
    await save(primary);
    return noContent();
  }), { policy, bindQuery: query => commaGuidValues(query, 'ids') });

  add('DELETE', '/Videos/{itemId}/AlternateSources', context => write(context, async (queries, load) => {
    let item = await load(context.queryInput, true);
    if (item && item.LinkedAlternateVersions.length === 0 && item.PrimaryVersionId != null) item = await load(item.PrimaryVersionId);
    if (!item) return notFound();
    await queries.visitAlternates(item.Id, async ({ rows }) => {
      for (const { Id } of rows) {
        await itemCreation.withItem(Id, async alternate => {
          if (!alternate || !VIDEO_TYPES.has(alternate.Type)) return;
          setPrimaryVersion(alternate, null);
          alternate.LinkedAlternateVersions = [];
          await save(alternate);
        });
      }
    });
    item.LinkedAlternateVersions = [];
    setPrimaryVersion(item, null);
    await save(item);
    return noContent();
  }), { policy, bindQuery: (_query, params) => guidValue(params.itemId, 'itemId') });
}
