import { releaseCachedFolderChildren } from './folder-cache.js';
import { updateInheritedValues } from './item-persistence.js';
import { ItemDeletionScope } from './item-deletion-scope.js';
import { createMetadataChildren } from './metadata-children.js';
import { idKey, nonemptyId, libraryError } from './records.js';
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
import { loadPostgresPageGraph, loadPostgresRowsByIds } from './postgres-library-query.js';

const itemType = item => String(item?.NativeType ?? item?.Type ?? '').split('.').at(-1);

async function releaseResources(primary, operations) {
  const errors = [];
  for (const operation of operations) {
    try { await operation(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(primary ? [primary, ...errors] : errors,
    primary?.message ?? 'Library child cleanup failed.', primary ? { cause: primary } : undefined);
}

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
      ...library.folderValidation?.capabilities,
      resolvesProductionMediaFiles: library.folderValidation?.resolverPipeline?.capabilities.resolvesProductionMediaFiles === true,
      productionMediaScopes: library.folderValidation?.resolverPipeline?.capabilities.productionMediaScopes ?? Object.freeze([]),
      runsMetadataProbeRefresh: typeof metadataScanner.refreshAccessibleChildren === 'function',
      reconcilesTopLevelConfiguration: topLevelValidation.capabilities?.reconcilesTopLevelConfiguration === true
    });
  }

  async #root(type) {
    if (this.#roots.has(type)) return this.#roots.get(type).item;
    const resolved = await this.store.run(async db => {
      const programDataPath = this.library.options.programDataPath;
      const canonicalPath = type === 'UserRootFolder'
        ? this.library.options.userRoot?.Path ?? this.library.options.userRootPath
          ?? (programDataPath ? path.join(path.resolve(programDataPath), 'root', 'default') : null)
        : type === 'AggregateFolder' && programDataPath ? path.join(path.resolve(programDataPath), 'root') : null;
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
      // LibraryManager.CreateRootFolder/GetUserRootFolder reset the registered
      // root Path after moving program data. Reusing an existing row or an
      // already parented playlists child does not suppress that live reset.
      if (canonicalPath && itemType(item) === type) item.Path = canonicalPath;
      const owner = this.itemCreation.retainItem(item);
      return { item, owner };
      } finally { await state.dispose({ session: db }); }
    }, { readOnly: true, lockTimeoutMs: 250 });
    try {
      if (type === 'AggregateFolder') {
        const dataPath = this.library.options.dataPath ?? path.join(this.library.options.programDataPath, 'data');
        const playlistPath = path.join(dataPath, 'playlists');
        const playlistId = nativeGuid(getNewItemId(playlistPath, 'Emby.Server.Implementations.Playlists.PlaylistsFolder', {
          programDataPath: path.resolve(this.library.options.programDataPath),
          enableCaseSensitiveItemIds: this.library.options.configuration?.EnableCaseSensitiveItemIds
        }));
        const playlist = await this.itemCreation.getItemById(playlistId);
        if (!playlist || itemType(playlist) !== 'PlaylistsFolder' || !sameNativePath(playlist.Path, playlistPath)) {
          throw new Error('The registered playlists folder is not initialized.');
        }
        const playlistOwner = this.itemCreation.retainItem(playlist);
        resolved.virtualOwners = [playlistOwner];
        resolved.item.VirtualChildren.splice(0, resolved.item.VirtualChildren.length, playlist);
      }
      if (this.#roots.has(type)) {
        for (const owner of resolved.virtualOwners ?? []) owner.release();
        resolved.owner.release(); return this.#roots.get(type).item;
      }
      this.#roots.set(type, resolved);
      return resolved.item;
    } catch (error) {
      for (const owner of resolved.virtualOwners ?? []) owner.release();
      resolved.owner.release(); await this.itemCreation.linkedChildren.flushReleases(); throw error;
    }
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

  refreshMetadata(item, options) { return this.metadataScanner.refreshLiveItem(item, options); }

  validateChildren(item, options) {
    return this.topLevelValidation.supports(item)
      ? this.topLevelValidation.validateChildren(item, options)
      : this.library.validateChildren(item, options);
  }

  async withChildSnapshot(parent, operation, { includeItemTypes } = {}) {
    // Capture every typed child before refreshing any of them. The cohort
    // keeps membership and mutable entity state in SQL, with owned pages.
    const children = await createMetadataChildren({ store: this.store, library: this.library,
      linkedChildren: this.itemCreation.linkedChildren,
      configuration: this.library.options.configuration }).physical(parent, { preserveDuplicates: true, includeItemTypes });
    let failure;
    try {
      return await operation(children);
    } catch (error) { failure = error; throw error; }
    finally { await releaseResources(failure, [() => children.close()]); }
  }

  async withChildren(parent, operation) {
    return this.withChildSnapshot(parent, children => this.store.run(async db => {
      const pending = q('mm_scan_missing_' + randomUUID().replaceAll('-', ''));
      const deletion = new ItemDeletionScope({ store: this.store, database: db });
      let active = true, deleted = false, callbackFailure;
      const assertActive = () => { if (!active) throw new Error('The library child scope has been released.'); };
      try {
        await db.client.query(`CREATE TEMP TABLE ${pending}("Key" text PRIMARY KEY)`);
        return await operation(Object.freeze({
          pages: children.pages,
          markForDeletion: async id => {
            assertActive();
            if (deleted) throw new Error('Library child deletions have already completed.');
            if (!nonemptyId(id)) throw new TypeError('A nonempty library child ID is required.');
            await db.client.query(`INSERT INTO ${pending}("Key") VALUES($1) ON CONFLICT DO NOTHING`, [idKey(id)]);
          },
          deleteMarked: async () => {
            assertActive();
            if (deleted) throw new Error('Library child deletions have already completed.');
            deleted = true;
            if (!(await db.client.query(`SELECT EXISTS(SELECT 1 FROM ${pending}) AS present`)).rows[0].present) return;
            const plan = { text: `SELECT "Key" FROM ${pending}`, values: [] };
            await this.store.ensureSerializedWrites(async () => {
              await deletion.capturePlan(plan);
              await deletion.persistPlan(plan, { now: this.now, publishDeletedPage: page => {
                for (const row of page) this.itemCreation.unregisterItem(row.Key);
              } });
            });
          }
        }));
      } catch (error) { callbackFailure = error; throw error; }
      finally {
        active = false;
        const cleanupSql = async operation => {
          if (db.connectionReleaseError) return;
          try { await operation(); }
          catch (error) { db.discardConnection(error); throw error; }
        };
        await releaseResources(callbackFailure, [() => cleanupSql(() => deletion.close()),
          () => cleanupSql(() => db.client.query(`DROP TABLE IF EXISTS ${pending}`))]);
      }
    }));
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

  updateInheritedValues() { return updateInheritedValues(this.store); }
  async close() {
    for (const root of this.#roots.values()) {
      for (const owner of root.virtualOwners ?? []) owner.release();
      root.owner.release();
    }
    this.#roots.clear();
    await this.itemCreation.linkedChildren.flushReleases();
  }
}
