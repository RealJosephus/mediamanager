import { randomUUID } from 'node:crypto';
import { withCleanup } from '../core/operation-failure.js';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { visitPostgresRowPlanPages } from '../database/postgres-item-query.js';
import { withPostgresCachedFolderChildren } from './postgres-cached-folder-children.js';
import { resolvePostgresSearchCollation } from './postgres-search-provider.js';

async function visitChildren(children, visit, signal) {
  for (let after = 0n;;) {
    signal?.throwIfAborted();
    const next = await children.withPage({ after }, async page => {
      if (page.entries.length) await visit(page.entries);
      return page.after;
    });
    if (next === after) return;
    after = next;
  }
}

export async function libraryPhysicalPaths(library, host, signal) {
  const item = await host.getAggregateFolder();
  return library.store.run(session => withPostgresCachedFolderChildren({ session, library, item }, async children => {
    const paths = [];
    await visitChildren(children, entries => {
      for (const { item: child } of entries) for (const location of child.PhysicalLocations) paths.push(location);
    }, signal);
    return paths;
  }), { signal });
}

export async function libraryMediaFolders(library, host, optionsStore, isHidden, signal) {
  const item = await host.getUserRootFolder();
  const aggregate = await host.getAggregateFolder();
  const virtualChildren = [...aggregate.VirtualChildren];
  const enabled = async folder => {
    const collection = folder.Type === 'CollectionFolder' ? folder
      : (await library.getCollectionFolders(folder)).find(entry => entry.Type === 'CollectionFolder');
    return collection == null || (await optionsStore.bind(collection.Id, collection.Path)).Enabled;
  };

  return library.store.run(session => withPostgresCachedFolderChildren({ session, library, item }, async children => {
    const name = q('mm_media_folders_' + randomUUID().replaceAll('-', ''));
    const selected = `${q('pg_temp')}.${name}`;
    let collation, creationAttempted = false, position = 0n;
    const append = async entries => {
      const positions = [], slots = [], virtualIndexes = [], sortNames = [], visible = [], hidden = [];
      for (const entry of entries) {
        const folder = entry.item;
        positions.push(++position);
        slots.push(entry.slot ?? null);
        virtualIndexes.push(entry.virtualIndex ?? null);
        const isEnabled = await enabled(folder);
        visible.push(isEnabled);
        hidden.push(folder.IsHidden);
        sortNames.push(isEnabled && folder.SortName != null ? nativeTextBytes(folder.SortName) : null);
      }
      await session.client.query({ text: `INSERT INTO ${selected} SELECT * FROM
        unnest($1::bigint[], $2::uuid[], $3::integer[], $4::bytea[], $5::boolean[], $6::boolean[])`,
      values: [positions, slots, virtualIndexes, sortNames, visible, hidden], signal });
    };

    return withCleanup(async () => {
      collation = await resolvePostgresSearchCollation(session, library.options.localization?.context?.culture ?? 'en-US', { signal });
      creationAttempted = true;
      await session.client.query({ text: `CREATE TEMP TABLE ${name} (position bigint PRIMARY KEY,
        slot uuid, virtual_index integer, sort_name bytea, enabled boolean, hidden boolean)`, signal });
      // Preserve live SortName values and the Children.Concat(VirtualChildren) order.
      // SQL retains the complete candidate set while DTO projection borrows one page.
      await visitChildren(children, append, signal);
      for (let offset = 0; offset < virtualChildren.length; offset += 128) {
        await append(virtualChildren.slice(offset, offset + 128).map((child, index) => ({ item: child, virtualIndex: offset + index })));
      }
      const sql = nativeTextSql(session.schemaName);
      const key = `replace(replace(${sql.projection('sort_name')}, chr(1) || '0', ''), chr(1) || '1', '')`;
      const plan = { text: `SELECT slot, virtual_index, count(*) OVER () AS "TotalRecordCount" FROM ${selected}
        WHERE enabled AND ($1::boolean IS NULL OR hidden = $1)
        ORDER BY ${key} COLLATE ${q(collation.schema)}.${q(collation.name)} ASC NULLS FIRST, position`,
      values: [isHidden ?? null], startIndex: 0 };
      const items = [];
      const { total, startIndex } = await visitPostgresRowPlanPages(session, plan, { signal }, rows =>
        children.withSlots(rows.filter(row => row.slot != null).map(row => row.slot), async physical => {
          let index = 0;
          const page = rows.map(row => row.slot == null ? virtualChildren[row.virtual_index] : physical[index++]);
          items.push(...await library.projectMediaFolderPage(session, page));
        }));
      return { Items: items, TotalRecordCount: total, StartIndex: startIndex };
    }, [async () => {
      if (!creationAttempted || session.connectionReleaseError) return;
      try { await session.client.query(`DROP TABLE IF EXISTS ${selected}`); }
      catch (error) { session.discardConnection(error); throw error; }
    }, () => collation?.release()], 'Media folder selection cleanup failed.');
  }), { signal });
}
