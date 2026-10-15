import { randomUUID } from 'node:crypto';
import { quoteIdentifier as q, tableDefinition } from '../database/model.js';
import { decodeValue } from '../database/values.js';
import { buildPostgresItemPageQuery } from '../database/postgres-item-query.js';
import { buildPostgresItemDeletionPlan, deletePostgresItemRowsFromPlan } from '../database/postgres-persistence-query.js';
import { MetadataImageAssets, imagePathApi } from '../metadata/image-assets.js';
import {createNativeItemCohort} from './native-item-cohort.js';
import {nativeTextSql} from '../database/native-text-sql.js';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { nativeContainingFolderPath, nativeFileNameWithoutExtension } from './native-path.js';
import { retainedUserDataItemId } from './item-persistence.js';
import { idKey, mapRecord, nonemptyId, VIDEO_TYPES } from './records.js';
import { requireCapability } from '../storage/errors.js';

const extensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tbn', '.gif', '.svg', '.nfo', '.xml',
  '.srt', '.vtt', '.sub', '.sup', '.idx', '.txt', '.edl', '.bif', '.smi', '.ttml', '.lrc', '.elrc'].map(ordinalIgnoreCaseKey));
const optionalFileError = error => ['IOException', 'UnauthorizedAccessException'].includes(error.nativeException)
  || ['io', 'not-found', 'permission-denied', 'unavailable', 'timeout', 'ENOENT', 'ENOTDIR', 'EIO', 'EACCES', 'EPERM'].includes(error.code);
const serialize = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry);

/** UnsafeFast deliberately keeps whole-batch file work ahead of one SQL
 * persistence boundary. SQL snapshots carry its root entities and paths. */
export class UnsafeItemDeletionService {
  constructor({ store, library, itemCreation, externalData, vfs, identityMap, metadataIdentityMap = identityMap, logger = {}, now = () => new Date().toISOString() }) {
    if (!store || !library || !itemCreation || !externalData) throw new TypeError('Unsafe item deletion requires native lifecycle services.');
    Object.assign(this, { store, library, itemCreation, externalData, logger, now });
    this.assets = new MetadataImageAssets({ fileSystem:library.options.fileSystem, vfs, identityMap, metadataPath: externalData.metadataPath,
      stateRoots: [externalData.dataPath, externalData.trickplayPath].filter(Boolean) });
    this.metadataAssets = new MetadataImageAssets({ ...this.assets, identityMap: metadataIdentityMap });
  }

  async #sourcePaths(item, storage = 'media') {
    const assets = storage === 'metadata' ? this.metadataAssets : this.assets;
    if (typeof item.Path !== 'string') throw new TypeError('A source deletion path is required.');
    let path = item.Path, directory;
    if (VIDEO_TYPES.has(item.Type) && item.Type !== 'Episode' && !item.IsInMixedFolder) {
      path = nativeContainingFolderPath(item); directory = true;
    } else if (item.Type === 'Episode') directory = item.IsFolder;
    const location = await assets.resolve(path, { literalIdentity: /^file:/iu.test(path) });
    if (location.accessPath) requireCapability(assets.vfs.resolve(location.accessPath), 'delete');
    if (directory === undefined) {
      try { directory = (await assets.stat(path)).kind === 'directory'; }
      catch (error) { if (error.code !== 'not-found') throw error; directory = false; }
    }
    const paths = [{ path, directory, storage }];
    if (storage === 'media' && location.accessPath) {
      const metadataLocation = await this.metadataAssets.resolve(path, { literalIdentity: /^file:/iu.test(path) });
      if (metadataLocation.accessPath !== location.accessPath) paths.push(...await this.#sourcePaths(item, 'metadata'));
    }
    if (!item.IsFolder && item.IsInMixedFolder) {
      const api = imagePathApi(item.Path), folder = api.dirname(item.Path);
      let entries;
      try { entries = await assets.list(folder); } catch (error) { if (error.code !== 'not-found') throw error; return paths; }
      const filename = nativeFileNameWithoutExtension(api.basename(item.Path));
      for (const entry of entries) if (entry.kind === 'file' && extensions.has(ordinalIgnoreCaseKey(api.extname(entry.name)))) {
        const stem = nativeFileNameWithoutExtension(entry.name);
        if (ordinalIgnoreCaseEquals(stem.slice(0, filename.length), filename)) paths.push({ path: entry.Path, directory: false, storage });
      }
    }
    return paths;
  }

  async #deletePath(target) {
    const assets = target.storage === 'metadata' ? this.metadataAssets : this.assets;
    try { await assets.stat(target.path); } catch (error) { if (!optionalFileError(error)) throw error; return; }
    try {
      if (target.directory) await assets.deleteDirectory(target.path);
      else await assets.delete(target.path);
    } catch (error) { if (!optionalFileError(error)) throw error; }
  }

  deleteQueryItems(query, { deleteSourceFiles = false, itemIdsPlan, onSelectedItem } = {}) {
    return this.store.serializeWrites(async db => {
      const prefix = 'mm_unsafe_' + randomUUID().replaceAll('-', '');
      const roots = q(prefix + '_roots'), work = q(prefix + '_work');
      const table = `${q(db.schemaName)}.${q('BaseItems')}`;
      const selected = buildPostgresItemPageQuery(db, query, { groupByPresentationKey: false, includeOrdinal: true, itemIdsPlan });
      const columns = tableDefinition('BaseItems').columns;
      const readRows = rows => rows.map(row => Object.fromEntries(columns.map(column => [column.name, decodeValue(column, row[column.name], 'postgres')])));
      const pages = async function* (relation, fields) {
        let ordinal = 0n;
        while (true) {
          const page = (await db.client.query({ text: `SELECT ${fields} FROM ${relation}
            WHERE "__ordinal" > $1 ORDER BY "__ordinal" LIMIT 128`, values: [ordinal] })).rows;
          if (!page.length) return;
          yield page; ordinal = BigInt(page.at(-1).__ordinal);
          if (page.length < 128) return;
        }
      };
      const cohort=await createNativeItemCohort({linkedChildren:this.itemCreation.linkedChildren});
      const consume=async operation=>{for(let after=0n;;){const page=await cohort.page({after,limit:128});try{if(!page.entries.length)break;for(const entry of page.entries)await operation(entry.item);after=page.entries.at(-1).Ordinal;}finally{await page.release();}}};
      try {
        await db.client.query({ text: `CREATE TEMP TABLE ${roots} AS WITH selected AS MATERIALIZED (${selected.text})
          SELECT item.*, selected."__ordinal" FROM selected JOIN ${table} item ON item."Id" = selected."Id"
          WHERE selected."Id" IS NOT NULL`, values: selected.values });
        await db.client.query(`CREATE INDEX ON ${roots} ("__ordinal")`);
        if (onSelectedItem) for await (const page of pages(roots, '*')) {
          for (const row of readRows(page)) await onSelectedItem(mapRecord(row));
        }
        await db.client.query(`CREATE TEMP TABLE ${work} ("__ordinal" bigint PRIMARY KEY, "SlotKey" uuid NOT NULL,
          "InternalPaths" text NOT NULL, "SourcePaths" text NOT NULL)`);
        for await (const page of pages(roots, '*')) {
          const state = await this.library.load(db, null, { includeUserData: false, includeFolderLinks:true, includeLinkGraph:false, baseRows: readRows(page) });
          try { for (let index=0;index<page.length;index++) {
            const item = state.byId.get(idKey(readRows([page[index]])[0].Id));
            if (!item) throw new TypeError('Unsafe deletion could not hydrate its selected root.');
            const slot=await cohort.capture(item,{ordinal:BigInt(page[index].__ordinal)});
            const internalPaths = this.externalData.internalPaths(item);
            const sourcePaths = deleteSourceFiles ? await this.#sourcePaths(item) : [];
            await db.client.query({ text: `INSERT INTO ${work} VALUES ($1, $2, $3, $4)`,
              values: [page[index].__ordinal, slot, serialize(internalPaths), serialize(sourcePaths)] });
          } } finally {await state.dispose();}
        }
        for await (const page of pages(work, '*')) for (const row of page) {
          for (const path of JSON.parse(row.InternalPaths)) {
            let info; try { info = await this.assets.stat(path); } catch (error) { if (!optionalFileError(error)) throw error; continue; }
            if (info.kind !== 'directory') continue;
            try { await this.assets.deleteDirectory(path); } catch (error) { this.logger.error?.(error, `Error deleting ${path}`); }
          }
          for (const target of JSON.parse(row.SourcePaths)) await this.#deletePath(target);
        }
        await consume(item=>this.externalData.deleteItemFiles(item));
        const count = Number((await db.client.query(`SELECT count(*) AS "Count" FROM ${work}`)).rows[0].Count);
        if (!Number.isSafeInteger(count)) throw new Error('Unsafe deletion returned an invalid root count.');
        if (!count) return;
        const scope = buildPostgresItemDeletionPlan(db, { text: `SELECT ${nativeTextSql(db.schemaName).guidKey('"Id"')} AS "Key" FROM ${roots}`, values: [] });
        await this.store.transaction(transaction => deletePostgresItemRowsFromPlan(transaction, scope, {
          retainedItemId: retainedUserDataItemId, retentionDate: this.now(),
        }));
        await consume(async item=>{
          this.itemCreation.unregisterItem(item.Id);
          const report=parent=>this.library.reportItemRemoved(item,parent||null);
          if(nonemptyId(item.OwnerId))await this.itemCreation.withItem(item.OwnerId,async owner=>{
            if(owner)report(owner);else if(nonemptyId(item.ParentId))await this.itemCreation.withItem(item.ParentId,report);else report(null);
          });else if(nonemptyId(item.ParentId))await this.itemCreation.withItem(item.ParentId,report);else report(null);
        });
      } finally { try {await cohort.release();} finally {await db.client.query(`DROP TABLE IF EXISTS ${work}, ${roots}`);} }
    });
  }
}
