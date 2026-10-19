import { releaseCachedFolderChildren } from './folder-cache.js';
import { deletePersistedItems, updateInheritedValues } from './item-persistence.js';
import { idKey, sameId, nonemptyId, libraryError } from './records.js';
import { sameNativePath } from './native-path.js';
import path from 'node:path';
import { getNewItemId } from '../core/identity.js';
import { nativeGuid } from '../users/native.js';
import { queryPostgresItemPage } from '../database/postgres-item-query.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { randomUUID } from 'node:crypto';
import { mapRecord } from './records.js';
import { loadPostgresNavigationRows, loadPostgresPageGraph,
  loadPostgresRowsByIds } from './postgres-library-query.js';

const itemType = item => String(item?.NativeType ?? item?.Type ?? '').split('.').at(-1);

/** Concrete host for the native library-scan lifecycle. */
export class LibraryScanHost {
  #roots = new Map();
  constructor({ store, library, itemCreation, metadataScanner, topLevelValidation, ignoreRule,
    now = () => new Date().toISOString() } = {}) {
    if (!store || !library || !itemCreation || !metadataScanner || !topLevelValidation) {
      throw new TypeError('Library scan hosting requires persistence, library, metadata and top-level validation services.');
    }
    Object.assign(this, { store, library, itemCreation, metadataScanner, topLevelValidation, ignoreRule, now });
    this.capabilities = Object.freeze({
      reconcilesTopLevelConfiguration: topLevelValidation.capabilities?.reconcilesTopLevelConfiguration === true,
      runsPostScanTasks: false
    });
  }

  async #root(type) {
    if (this.#roots.has(type)) return this.#roots.get(type).item;
    const resolved = await this.store.run(async db => {
      const canonicalPath = type === 'AggregateFolder' && this.library.options.programDataPath
        ? path.join(path.resolve(this.library.options.programDataPath), 'root') : null;
      const canonicalId = type === 'UserRootFolder' ? this.library.options.userRoot?.Id
        : canonicalPath && nativeGuid(getNewItemId(canonicalPath, 'MediaBrowser.Controller.Entities.AggregateFolder', {
          programDataPath: path.resolve(this.library.options.programDataPath),
          enableCaseSensitiveItemIds: this.library.options.configuration?.EnableCaseSensitiveItemIds,
        }));
      const baseRows = canonicalId ? await loadPostgresRowsByIds(db, [canonicalId])
        : type === 'UserRootFolder' ? []
          : (await queryPostgresItemPage(db, { includeitemtypes: [type], limit: 1 }, { groupByPresentationKey: false })).rows;
      const state = await this.library.load(db, null, { includeUserData: false, baseRows });
      try {
      const selectedId = type === 'UserRootFolder' ? this.library.options.userRoot?.Id : canonicalId;
      const item = selectedId ? state.byId.get(idKey(selectedId))
        : state.items.find(value => itemType(value) === type
          && (canonicalPath == null || sameNativePath(value.Path, canonicalPath)));
      if (!item) throw Object.assign(new Error(`${type} is not initialized.`), { status: 500 });
      const owner = this.itemCreation.retainItem(item);
      try { return { item, owner, persisted: (await db.rows('BaseItems', { where: { Id: item.Id } })).length > 0 }; }
      catch (error) { owner.release(); throw error; }
      } finally { await state.dispose({ session: db }); }
    }, { readOnly: true, lockTimeoutMs: 250 });
    // UserRootFolder is a registered singleton before its first repository
    // row exists. Establish that native-save baseline so ordinary metadata
    // persistence can perform the following refresh update safely.
    try {
      if (type === 'UserRootFolder' && !resolved.persisted) {
        await this.itemCreation.saveItems([resolved.item], { creationIntent: 'library-save' });
      }
      if (this.#roots.has(type)) { resolved.owner.release(); return this.#roots.get(type).item; }
      this.#roots.set(type, resolved);
      return resolved.item;
    } catch (error) { resolved.owner.release(); await this.itemCreation.linkedChildren.flushReleases(); throw error; }
  }

  getAggregateFolder() { return this.#root('AggregateFolder'); }

  getUserRootFolder() { return this.#root('UserRootFolder'); }

  withCollectionFolder(id, operation) {
    if (!nonemptyId(id)) throw libraryError(400, 'A nonempty library ID is required.');
    return this.itemCreation.withItem(id, item => operation(itemType(item) === 'CollectionFolder' ? item : null));
  }

  async refreshPhysicalFolders(collection) {
    // GetPhysicalFolders uses the stored ID cache and preserves duplicates.
    // Resolve one captured ID at a time without expanding the whole library.
    for (const id of collection.PhysicalFolderIds) {
      if (!nonemptyId(id)) throw libraryError(400, 'A physical folder ID cannot be empty.');
      await this.itemCreation.withItem(id, async child => {
        if (!child?.IsFolder) return;
        const options = { MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', IsAutomated: true,
          ReplaceAllMetadata: false, ReplaceAllImages: false, ForceSave: false, RemoveOldMetadata: false, RefreshPaths: [] };
        await this.refreshMetadata(child, options);
        await this.validateChildren(child, { ...options, recursive: true, refreshChildMetadata: true,
          allowRemoveRoot: false, reportProgress() {} });
      });
    }
  }

  clearIgnoreRuleCache() {
    if (!this.ignoreRule || this.ignoreRule.directoryCache?.size === 0) return;
    this.ignoreRule.clearDirectoryCache();
  }

  invalidateChildren(item) { releaseCachedFolderChildren(item); }

  refreshMetadata(item, options) { return this.metadataScanner.refreshItem(item.Id, options); }

  validateChildren(item, options) {
    return this.topLevelValidation.supports(item)
      ? this.topLevelValidation.validateChildren(item, options)
      : this.library.validateChildren(item, options);
  }

  async getChildren(parent) {
    return this.store.run(async db => {
      const navigationRows = await loadPostgresNavigationRows(db, parent.Id);
      const childRows = await db.rows('BaseItems', { where: { ParentId: parent.Id },
        orderBy: [{ column: 'SortName', direction: 'ASC' }] });
      const graphRows = await loadPostgresPageGraph(db,
        [...await loadPostgresRowsByIds(db, [parent.Id]), ...childRows], navigationRows);
      const state = await this.library.load(db, null, { includeUserData: false, baseRows: graphRows });
      try { return state.items.filter(item => sameId(item.ParentId, parent.Id)); }
      finally { await state.dispose({ session: db }); }
    }, { readOnly: true, lockTimeoutMs: 250 });
  }

  async getCachedChildren(parent) {
    return this.store.run(async db => {
      // Folder.Children uses the repository's default owned and alternate
      // selection, before CollectionPosterVerify filters collection types.
      const children = await queryPostgresItemPage(db, {}, { scope: { parentId: parent.Id }, groupByPresentationKey: false });
      const graph = await loadPostgresPageGraph(db, [...await loadPostgresRowsByIds(db, [parent.Id]), ...children.rows],
        await loadPostgresNavigationRows(db, parent.Id));
      const state = await this.library.load(db, null, { includeUserData: false, baseRows: graph });
      try { return children.rows.map(row => state.byId.get(idKey(row.Id))).filter(Boolean); }
      finally { await state.dispose({ session: db }); }
    }, { readOnly: true, lockTimeoutMs: 250 });
  }

  async getCachedChildrenPage(parent, { startIndex = 0, limit = 128 } = {}) {
    if (!Number.isSafeInteger(startIndex) || startIndex < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
      throw new TypeError('Cached child pages require a nonnegative offset and a limit from 1 to 128.');
    }
    return this.store.run(async db => {
      const children = await queryPostgresItemPage(db, { startindex: startIndex, limit },
        { scope: { parentId: parent.Id }, groupByPresentationKey: false });
      const graph = await loadPostgresPageGraph(db, [...await loadPostgresRowsByIds(db, [parent.Id]), ...children.rows]);
      const state = await this.library.load(db, null, { includeUserData: false, baseRows: graph });
      // Hydration can omit removed-plugin types without exhausting the SQL page.
      try { return { items: children.rows.map(row => state.byId.get(idKey(row.Id))).filter(Boolean),
        hasMore: children.rows.length === limit }; }
      finally { await state.dispose({ session: db }); }
    }, { readOnly: true, lockTimeoutMs: 250 });
  }

  /** Configuration reads the native initial child cohort before inspecting
   * directory files. Keep that snapshot in SQL and project just its first
   * matching child; an unrelated late hydration error must precede file work. */
  withCachedChildren(parent, operation) {
    return this.store.run(async db => {
      const temporary = q('mm_cached_children_' + randomUUID().replaceAll('-', ''));
      const sql = nativeTextSql(db.schemaName), table = `${q(db.schemaName)}.${q('BaseItems')}`;
      const selection = buildPostgresItemPageQuery(db, {}, {
        scope: { parentId: parent.Id }, groupByPresentationKey: false, includeOrdinal: true });
      const decodeRow = raw => Object.fromEntries(tableDefinition('BaseItems').columns
        .map(column => [column.name, decodeValue(column, raw[column.name], 'postgres')]));
      try {
        await db.client.query({ text: `CREATE TEMP TABLE ${temporary} AS
          SELECT selected."__ordinal" AS "ChildOrdinal", FALSE AS "Hydrated", item.*
          FROM (${selection.text}) selected JOIN ${table} item ON item."Id"=selected."Id"`, values: selection.values });
        await db.client.query(`CREATE INDEX ON ${temporary} ("ChildOrdinal");
          CREATE INDEX ON ${temporary} ((${sql.ordinalIgnoreCaseKey('"Path"')}))`);
        for (let after = 0n; ; ) {
          const rows = (await db.client.query({ text: `SELECT * FROM ${temporary}
            WHERE "ChildOrdinal">$1 ORDER BY "ChildOrdinal" LIMIT 128`, values: [after] })).rows;
          if (!rows.length) break;
          const hydrated = rows.filter(row => mapRecord(decodeRow(row)) != null).map(row => row.ChildOrdinal);
          if (hydrated.length) await db.client.query({ text: `UPDATE ${temporary} SET "Hydrated"=TRUE
            WHERE "ChildOrdinal"=ANY($1::bigint[])`, values: [hydrated] });
          after = BigInt(rows.at(-1).ChildOrdinal);
        }
        return await operation(Object.freeze({ firstByPath: async directory => {
          const row = (await db.client.query({ text: `SELECT * FROM ${temporary} WHERE "Hydrated"
            AND ${sql.ordinalIgnoreCaseKey('"Path"')}=${sql.ordinalIgnoreCaseKey('$1::bytea')}
            ORDER BY "ChildOrdinal" LIMIT 1`, values: [nativeTextBytes(this.library.options.reversePath?.(directory) ?? directory)] })).rows[0];
          if (!row) return null;
          const state = await this.library.load(db, null, { includeUserData: false, includeLinkGraph: false,
            baseRows: [decodeRow(row)] });
          try { return state.byId.get(idKey(decodeRow(row).Id)) ?? null; }
          finally { await state.dispose({ session: db }); }
        } }));
      } finally { await db.client.query(`DROP TABLE IF EXISTS ${temporary}`); }
    });
  }

  async collectionDirectoryExists(item) {
    try {
      return await this.topLevelValidation.loadContext.withContext(item.Id, {},
        async loaded => (await loaded.fileSystemMetadata())?.exists === true);
    } catch (error) {
      if (['not-found', 'unmapped-path', 'permission-denied', 'authentication-required'].includes(error?.code)
        || error?.status === 404) return false;
      throw error;
    }
  }

  async deleteCollections(ids) {
    if (!ids.length) return;
    const deleted = await deletePersistedItems(this.store, ids, { now: this.now });
    for (const id of deleted) this.itemCreation.unregisterItem(id);
  }

  updateInheritedValues() { return updateInheritedValues(this.store); }
  async close() {
    for (const root of this.#roots.values()) root.owner.release();
    this.#roots.clear();
    await this.itemCreation.linkedChildren.flushReleases();
  }
}

/** No watcher is active yet, but the lifecycle still owns a truthful gate. */
export class InertLibraryDirectoryMonitor {
  async stop() {}
  async start() {}
  reportFileSystemChangeBeginning() {}
  reportFileSystemChangeComplete() {}
}
