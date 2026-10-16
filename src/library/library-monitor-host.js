import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { nativeTextBytes, decodeNativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { buildPostgresItemPageQuery, queryPostgresItemPage } from '../database/postgres-item-query.js';
import { idKey, nonemptyId, mapRecord } from './records.js';
import { nativeDirectoryName, nativePathWithin } from './native-path.js';
import { nativeItemDescriptor } from './native-item-entity.js';
import { createNativeItemCohort } from './native-item-cohort.js';
import { metadataChildSequence } from './metadata-child-sequence.js';
import { resolvePostgresSearchCollation } from './postgres-search-provider.js';
import { defaultLibraryOptions } from './options.js';

const itemType = item => String(item?.NativeType ?? item?.Type ?? '').split('.').at(-1);
const folder = item => item?.NativeType ? nativeItemDescriptor(item.NativeType)?.family === 'folder' : item?.IsFolder === true;
const pluginFolder = item => ['BasePluginFolder', 'PlaylistsFolder'].includes(itemType(item));
const optionsForChange = () => ({ MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', IsAutomated: true,
  ReplaceAllMetadata: false, ReplaceAllImages: false, ForceSave: false, RemoveOldMetadata: false, RefreshPaths: [] });
const missing = error => ['ENOENT', 'ENOTDIR', 'not-found', 'not-directory'].includes(error?.code);

/** Connect native monitor policy to the authoritative query, storage and
 * shared provider queue. Each lookup remains bounded and retains its entity
 * until FileRefresher has admitted every selected item to the queue. */
export class LibraryMonitorHost {
  constructor({ store, library, itemCreation, scanHost, metadata, metadataScanner,
    fileSystem = library?.options?.fileSystem, vfs = fileSystem?.vfs, identityMap = fileSystem?.identityMap,
    scheduler, logger = {} } = {}) {
    if (!store || !library || !itemCreation || !scanHost || !metadata || !metadataScanner
      || !fileSystem || !vfs || !identityMap) throw new TypeError('Library monitoring requires query, storage and metadata owners.');
    Object.assign(this, { store, library, itemCreation, scanHost, metadata, metadataScanner,
      fileSystem, vfs, identityMap, scheduler, logger, events: library });
  }

  async #enabled(item) {
    if (pluginFolder(item)) return false;
    // Native GetLibraryOptions reads collection membership and options only.
    // Media access belongs to watch setup; an unavailable mount must not turn
    // this configuration lookup into a metadata load or prevent startup.
    const collection = itemType(item) === 'CollectionFolder' ? item
      : (await this.library.getCollectionFolders(item)).find(folder => itemType(folder) === 'CollectionFolder');
    const configured = this.library.options.libraryOptions;
    const options = collection && (configured instanceof Map ? configured.get(idKey(collection.Id))
      : configured?.[idKey(collection.Id)]) || defaultLibraryOptions();
    return options?.EnableRealtimeMonitor === true;
  }

  async getWatchPath(item) { return await this.#enabled(item) ? item.Path : null; }

  async *getWatchPaths() {
    const first = Promise.withResolvers();
    let closed = false;
    const worker = this.store.run(async db => {
      const name = q('mm_monitor_paths_' + randomUUID().replaceAll('-', ''));
      let cursor = first, collation, failure;
      try {
        await db.client.query(`CREATE TEMP TABLE ${name}(ordinal bigint GENERATED ALWAYS AS IDENTITY, path bytea UNIQUE)`);
        const root = await this.scanHost.getAggregateFolder();
        await this.scanHost.withChildSnapshot(root, async children => {
          for await (const page of children.pages()) for (const item of page) {
            if (!await this.#enabled(item) || !folder(item)) continue;
            const locations = item.PhysicalLocations ?? (/^[a-z][a-z0-9+.-]*:\/\//iu.test(item.Path ?? '') ? [] : [item.Path]);
            for (const identity of locations) await db.client.query(`INSERT INTO ${name}(path) VALUES($1) ON CONFLICT(path) DO NOTHING`,
              [identity == null ? null : nativeTextBytes(identity)]);
          }
        });
        collation = await resolvePostgresSearchCollation(db, this.library.options.configuration?.UICulture || 'en-US');
        const sql = nativeTextSql(db.schemaName);
        for (let after = 0n; !closed;) {
          const page = (await db.client.query(`/* monitor-watch-path-page */ SELECT * FROM (
            SELECT path,row_number() OVER(ORDER BY ${sql.projection('path')} COLLATE ${q(collation.schema)}.${q(collation.name)} NULLS FIRST,ordinal) AS position
            FROM ${name}) paths WHERE position>$1 ORDER BY position LIMIT 128`, [after])).rows;
          if (!page.length) break;
          const next = Promise.withResolvers(), acknowledged = Promise.withResolvers();
          cursor.resolve({ values: page.map(row => row.path == null ? null : decodeNativeTextBytes(row.path)), next: next.promise, acknowledged });
          await acknowledged.promise;
          cursor = next;
          after = BigInt(page.at(-1).position);
        }
      } catch (error) { failure = error; }
      finally {
        try { await collation?.release(failure); await db.client.query(`DROP TABLE IF EXISTS ${name}`); }
        catch (error) { failure ??= error; db.discardConnection?.(error); }
        cursor.resolve(failure ? { error: failure } : null);
      }
    }).catch(error => first.resolve({ error }));
    let current = first.promise, chunk;
    try {
      while ((chunk = await current)) {
        if (chunk.error) throw chunk.error;
        current = chunk.next;
        try { yield* chunk.values; }
        finally { chunk.acknowledged.resolve(); }
      }
    } finally { closed = true; chunk?.acknowledged?.resolve(); await worker; }
  }

  async watchPath(identity, { signal, onChange, onError } = {}) {
    const style = /^[A-Za-z]:[\\/]|^\\\\/u.test(identity) ? 'windows' : 'posix';
    const access = this.identityMap.resolve({ identityPath: identity, style });
    const api = style === 'windows' ? path.win32 : path.posix;
    return this.vfs.watch(access, { signal, onError, onChange: event => {
      const relative = path.posix.relative(access, event.path);
      if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
        onError?.(new Error('A storage watch event escaped its watched root.'), Object.freeze({ terminal: false })); return;
      }
      onChange?.({ ...event, path: relative ? api.join(identity, ...relative.split('/')) : identity });
    } });
  }

  async getFileInfo(identity) {
    try {
      if (typeof this.identityMap.resolve === 'function') {
        let access;
        try { access = this.identityMap.resolve({ identityPath: identity,
          style: /^[A-Za-z]:[\\/]|^\\\\/u.test(identity) ? 'windows' : 'posix' }); }
        catch (error) {
          const stateRoots = ['programDataPath', 'dataPath', 'metadataPath'].map(name => this.library.options[name]).filter(Boolean);
          if (!['not-found', 'unmapped-path'].includes(error.code)
            || !stateRoots.some(root => nativePathWithin(identity, root))) throw error;
        }
        if (access !== undefined) {
          const entry = await this.vfs.stat(access);
          return { isDirectory: entry.kind === 'directory', exists: entry.kind === 'directory' || entry.kind === 'file' };
        }
      }
      const entry = await this.fileSystem.stat(identity);
      return { isDirectory: entry.isDirectory(), exists: entry.isDirectory() || entry.isFile() };
    } catch (error) { if (missing(error)) return { isDirectory: false, exists: false }; throw error; }
  }

  // DirectoryService instances belong to individual refresh operations. There
  // is no shared directory-result cache to invalidate in this host.
  invalidate() {}

  async #findByPath(identity) {
    const stored = this.library.options.reversePath?.(identity) ?? identity;
    const id = await this.store.run(async db => {
      const result = await queryPostgresItemPage(db, { sortby: ['DateCreated'], sortorder: ['Descending'], limit: 1,
        enabletotalrecordcount: false }, { groupByPresentationKey: false,
        itemIdsPlan: { text: `SELECT "Id" FROM ${q(db.schemaName)}."BaseItems" WHERE "Path"=$1`, values: [nativeTextBytes(stored)] } });
      return result.rows[0]?.Id;
    }, { readOnly: true });
    return id ? this.itemCreation.getItemById(id) : null;
  }

  async resolveAffectedItem(identity) {
    let item = null, owner;
    const release = async () => { owner?.release(); owner = undefined; await this.itemCreation.linkedChildren.flushReleases(); };
    try {
      for (let current = identity; !item && current; current = nativeDirectoryName(current)) item = await this.#findByPath(current);
      const visited = new Set();
      while (item) {
        if (visited.has(idKey(item.Id))) throw new Error('The affected item owner chain contains a cycle.');
        visited.add(idKey(item.Id)); owner = this.itemCreation.retainItem(item);
        if (item.Path && (await this.getFileInfo(item.Path)).exists) {
          let disposed = false;
          return { item, dispose: async () => { if (disposed) return; disposed = true; await release(); } };
        }
        let parent = nonemptyId(item.OwnerId) ? await this.itemCreation.getItemById(item.OwnerId) : null;
        parent ??= nonemptyId(item.ParentId) ? await this.itemCreation.getItemById(item.ParentId) : null;
        await release(); item = parent;
      }
      return null;
    } catch (error) { await release(); throw error; }
  }

  changedExternally(item) {
    // Queue admission is synchronous; FileRefresher must not wait for the work.
    const task = this.metadata.queue(item.Id, optionsForChange(), 0);
    void Promise.resolve(task).catch(error => {
      try { void Promise.resolve(this.logger.error?.(error, 'Error refreshing item')).catch(() => {}); } catch { /* Logging is an observer. */ }
    });
  }

  async runQueuedBatch(operation, { signal } = {}) {
    signal?.throwIfAborted();
    // ProviderManager owns this cache boundary for the entire shared queue,
    // including work admitted while an earlier entry is still refreshing.
    await this.scanHost.clearIgnoreRuleCache();
    try { return await operation(); }
    finally { if (!signal?.aborted) await this.scanHost.clearIgnoreRuleCache(); }
  }

  async refreshQueuedItem(reference, options = {}) {
    const id = typeof reference === 'string' ? reference : reference.Id;
    return this.itemCreation.withItem(id, async item => {
      if (!item) return;
      if (itemType(item) === 'MusicArtist') return this.#refreshArtist(item, options);
      await this.metadataScanner.refreshLiveItem(item, options);
      if (itemType(item) === 'CollectionFolder') {
        for (const physicalId of item.PhysicalFolderIds) await this.itemCreation.withItem(physicalId, async child => {
          if (!child || !folder(child)) return;
          await this.metadataScanner.refreshLiveItem(child, options);
          await this.scanHost.validateChildren(child, { ...options, recursive: true, refreshChildMetadata: true,
            allowRemoveRoot: false, reportProgress() {} });
        });
      } else if (folder(item)) await this.scanHost.validateChildren(item, { ...options, recursive: true,
        refreshChildMetadata: true, allowRemoveRoot: false, reportProgress() {} });
    });
  }

  async #albumArtist(album) {
    let parentId = album.ParentId;
    const seen = new Set([idKey(album.Id)]);
    while (nonemptyId(parentId)) {
      if (seen.has(idKey(parentId))) throw new Error('The album parent chain contains a cycle.');
      seen.add(idKey(parentId));
      const parent = await this.itemCreation.getItemById(parentId);
      if (!parent) break;
      if (itemType(parent) === 'MusicArtist') return parent;
      parentId = parent.ParentId;
    }
    const name = album.AlbumArtists?.[0];
    return name ? this.library.getArtist(name) : null;
  }

  async #refreshArtist(item, options) {
    const linkedChildren = this.itemCreation.linkedChildren;
    const albums = await createNativeItemCohort({ linkedChildren });
    let artists;
    try {
      artists = await createNativeItemCohort({ linkedChildren });
      await this.store.run(async db => {
        const prefix = 'mm_monitor_artist_' + randomUUID().replaceAll('-', '');
        const selected = q(prefix + '_albums'), seen = q(prefix + '_seen');
        const plan = buildPostgresItemPageQuery(db, { includeitemtypes: ['MusicAlbum'], artistids: [item.Id] },
          { includeOrdinal: true, groupByPresentationKey: false });
        try {
          await db.client.query({ text: `CREATE TEMP TABLE ${selected} AS WITH selected AS MATERIALIZED (${plan.text})
            SELECT item.*,selected."__ordinal" FROM selected JOIN ${q(db.schemaName)}."BaseItems" item ON item."Id"=selected."Id"`, values: plan.values });
          await db.client.query(`CREATE TEMP TABLE ${seen}(id text PRIMARY KEY)`);
          for (let after = 0n;;) {
            const page = (await db.client.query(`/* monitor-artist-album-page */ SELECT * FROM ${selected}
              WHERE "__ordinal">$1 ORDER BY "__ordinal" LIMIT 128`, [after])).rows;
            if (!page.length) break;
            for (const row of page) {
              const album = mapRecord(Object.fromEntries(tableDefinition('BaseItems').columns.map(column =>
                [column.name, decodeValue(column, row[column.name], 'postgres')])));
              if (album) await albums.capture(album, { ordinal: BigInt(row.__ordinal) });
            }
            after = BigInt(page.at(-1).__ordinal);
          }
          let ordinal = 0n;
          for (let after = 0n;;) {
            const page = await albums.page({ after, limit: 128 });
            try {
              if (!page.entries.length) break;
              for (const entry of page.entries) {
                const artist = await this.#albumArtist(entry.item);
                if (artist && (await db.client.query(`INSERT INTO ${seen} VALUES($1) ON CONFLICT DO NOTHING`, [idKey(artist.Id)])).rowCount) {
                  await artists.capture(artist, { ordinal: ++ordinal });
                }
              }
              after = page.entries.at(-1).Ordinal;
            } finally { await page.release(); }
          }
        } finally { await db.client.query(`DROP TABLE IF EXISTS ${seen},${selected}`); }
      });
      const sequence = metadataChildSequence(artists.retain(), linkedChildren, this.store);
      const failures = [];
      try {
        if (!this.scheduler) throw new TypeError('Artist refresh requires the shared library scheduler.');
        // ProviderManager awaits every physical artist's ValidateChildren task.
        // Let that operation observe cancellation after its accessibility guard;
        // scheduler cancellation would silently skip it and lose this boundary.
        await this.scheduler.enqueue(sequence, artist => this.scanHost.validateChildren(artist, { ...options,
          recursive: true, refreshChildMetadata: true, allowRemoveRoot: false, reportProgress() {} }),
        { onError: error => failures.push(error) });
        if (failures.length) throw failures[0];
      } finally { await sequence.close(); }
      try { await this.metadataScanner.refreshLiveItem(item, options); }
      catch (error) { this.logger.error?.(error, 'Error refreshing library'); }
    } finally { try { await albums.release(); } finally { await artists?.release(); } }
  }
}
