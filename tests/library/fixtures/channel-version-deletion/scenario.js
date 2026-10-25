import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../../../database/postgres-fixture.js';
import { testFileSystem } from '../../../storage/plugin-files.js';
import { tableDefinition, quoteIdentifier as q } from '../../../../src/database/model.js';
import { DomainStore } from '../../../../src/database/domain-store.js';
import { nativeGuid } from '../../../../src/users/native.js';
import { idKey, EMPTY_ID } from '../../../../src/library/records.js';
import { LibraryService } from '../../../../src/library/library-service.js';
import { PostgresLinkedChildrenStore } from '../../../../src/library/postgres-linked-children.js';
import { ItemCreationService } from '../../../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../../../src/library/item-deletion-service.js';
import { ExternalDataManager } from '../../../../src/library/external-data.js';
import { LinkedChildReferenceService } from '../../../../src/library/linked-child-reference-service.js';
import { createMetadataContextLoader } from '../../../../src/library/metadata-context.js';
import { MetadataRefreshHost } from '../../../../src/metadata/refresh-host.js';
import { MetadataRegistry } from '../../../../src/metadata/registry.js';
import { MetadataImageAssets } from '../../../../src/metadata/image-assets.js';
import { internalImagePath } from '../../../../src/metadata/image-paths.js';
import { ChannelService } from '../../../../src/library/channel-service.js';
import { PluginHost } from '../../../../src/plugins/host.js';
import { setFolderChildren, cachedFolderChildrenSnapshot } from '../../../../src/library/folder-cache.js';
import { primaryId, parentId, alternateIds, userId } from './input.js';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const errorRecord = error => ({ ...error, type: error.nativeException ?? error.name, status: error.status ?? error.statusCode ?? 500, Message: error.message, StackTrace: error.stack });
export async function observe(operation) { try { return { value: await operation() }; } catch (error) { return { failure: errorRecord(error) }; } }
export const comparable = value => value?.failure ? { failure: { status: value.failure.status,
  ...(value.failure.status === 400 ? { Message: value.failure.Message } : {}) } } : value;
export async function removeOwned(owner, target) {
  const relative = path.relative(path.resolve(owner), path.resolve(target));
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Version fixture cleanup escaped its owner.');
  await rm(path.resolve(target), { recursive: true, force: true });
}
export async function within(promise, label) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 30000); })]); }
  finally { clearTimeout(timer); }
}
export const projectRows = rows => rows.map(row => ({ Id: idKey(row.Id), Name: row.Name, ParentId: row.ParentId == null ? null : idKey(row.ParentId),
  OwnerId: row.OwnerId == null ? null : idKey(row.OwnerId), PrimaryVersionId: row.PrimaryVersionId == null ? null : idKey(row.PrimaryVersionId) })).sort((a, b) => a.Id < b.Id ? -1 : a.Id > b.Id ? 1 : 0);
const childType = value => typeof value === 'number' ? value : ({ Manual: 0, Shortcut: 1, LocalAlternateVersion: 2, LinkedAlternateVersion: 3 })[value];
export const projectLinks = rows => rows.map(row => ({ ParentId: idKey(row.ParentId), ChildId: idKey(row.ChildId), ChildType: childType(row.ChildType), SortOrder: row.SortOrder }))
  .sort((a, b) => a.ParentId < b.ParentId ? -1 : a.ParentId > b.ParentId ? 1 : a.SortOrder - b.SortOrder);

const packageCode = `
export async function activate(context) {
  const sample=context.options.sample;
  await context.register('channel',{type:'supported',name:'Supported',getChannelFeatures:()=>({}),isEnabledFor:()=>true,
    getChannelItems(){throw new Error('Catalog execution is forbidden.');},getChannelImage(){throw new Error('Image execution is forbidden.');},getSupportedChannelImages:()=>[],
    canDelete(){throw new Error('This direct deletion does not evaluate permissions.');},
    async deleteItem(externalId,options){
      if(!['owned-external-0','owned-external-1'].includes(externalId))throw new Error('Provider deletion escaped the fixture input.');
      await context.options.deleting(externalId,options);
      if(sample.failAt!==Number(externalId.slice(-1)))return;
      const failure=({argument:['Controlled recursive provider argument.',400,'invalid-channel-argument'],io:['Controlled recursive provider I/O failure.',500,'io'],failure:['Controlled recursive provider failure.',500]})[sample.outcome];
      if(failure)throw Object.assign(new Error(failure[0]),{status:failure[1],...(failure[2]?{code:failure[2]}:{})});
    }});
}
`;

export async function openScenario(sample, expected, root, { deleting, beforeContext } = {}) {
  let database, store, links, library, items, metadata, plugins, channels, closing;
  const calls = [], diagnostics = [], eventReads = [];
  const drainEvents = async () => {
    const results = await Promise.allSettled(eventReads), errors = results.filter(value => value.status === 'rejected').map(value => value.reason);
    if (errors.length) throw new AggregateError(errors, 'Version event observations failed to drain.');
  };
  const close = () => closing ??= (async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    const pending = channels?.close(); metadata?.cancel(); await attempt(() => pending); await attempt(drainEvents);
    for (const operation of [() => metadata?.close(), () => items?.close(), () => library?.close(), () => plugins?.close(),
      () => links?.flushReleases(), () => links?.close(), () => store?.close(), () => dropPostgresTestDatabase(database)]) await attempt(operation);
    if (failures.length) throw new AggregateError(failures, 'Version deletion owners failed to close.');
  })();
  try {
    await mkdir(root, { recursive: true }); database = await createPostgresTestDatabase(null, 'channel_version'); store = new DomainStore(database);
    links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
    const metadataPath = path.join(root, 'metadata'), dataPath = path.join(root, 'data'), logger = { error: error => diagnostics.push(error), warn: error => diagnostics.push(error) };
    library = new LibraryService({ store, linkedChildren: links, serverId: 'channel-version-deletion', programDataPath: root, metadataPath, dataPath,
      fileSystem: testFileSystem, configuration: { CacheSize: 64, EnableCaseSensitiveItemIds: true }, onError: logger.error,
      userRoot: { Id: userId, NativeType: 'MediaBrowser.Controller.Entities.UserRootFolder', Type: 'MediaBrowser.Controller.Entities.UserRootFolder', Name: 'User root', Path: null, IsFolder: true, IsRoot: true } });
    const original = createMetadataContextLoader({ store, library, linkedChildren: links, fileSystem: testFileSystem, vfs: testFileSystem.vfs, identityMap: testFileSystem.identityMap,
      configuration: library.options.configuration, spoolRoot: path.join(root, 'spool'), logger });
    const loadContext = Object.assign(async (...args) => {
      await beforeContext?.(...args); const loaded = await original(...args); loaded.reversePath = value => value; loaded.reloadMetadataContext = loadContext; return loaded;
    }, original);
    loadContext.withContext = async (reference, options, callback) => { const loaded = await loadContext(reference, options); try { return await callback(loaded); } finally { await loaded.dispose(); } };
    items = library.itemCreation = new ItemCreationService({ store, library, loadContext, linkedChildren: links });
    metadata = new MetadataRefreshHost({ store, loadContext, linkedChildren: links, registry: new MetadataRegistry(), logger, vfs: testFileSystem.vfs });
    const columns = new Map(tableDefinition('BaseItems').columns.map(column => [column.name, column]));
    const rows = expected.beforeRows.map(source => postgresTestRow('BaseItems', Object.fromEntries(Object.entries(source).filter(([name]) => columns.has(name))
      .map(([name, value]) => [name, value != null && columns.get(name).clrType.replace('?', '') === 'Guid' ? nativeGuid(value)
        : name === 'Path' && typeof value === 'string' && value.startsWith(expected.root) ? root + value.slice(expected.root.length) : value]))));
    const savedLinks = expected.beforeLinks.map(row => postgresTestRow('LinkedChildren', { ParentId: nativeGuid(row.ParentId), ChildId: nativeGuid(row.ChildId), ChildType: childType(row.ChildType), SortOrder: row.SortOrder }));
    await database.transaction(async db => { await db.client.query('SET CONSTRAINTS ALL DEFERRED'); for (const row of rows) await db.insert('BaseItems', row); for (const row of savedLinks) await db.insert('LinkedChildren', row); });
    const tracked = await Promise.all([primaryId, ...alternateIds.slice(0, sample.count)].map(id => items.getItemById(id))), primary = tracked[0], parent = await items.getItemById(parentId);
    assert.ok(tracked.every(Boolean)); assert.ok(parent); setFolderChildren(parent, tracked); parent.UserData = [];
    // Copy the declared unsaved entity frame independently of its actual SQL links.
    primary.LocalAlternateVersions = sample.kind === 'local' ? tracked.slice(1).map(item => item.Path) : [];
    primary.LinkedAlternateVersions = sample.kind === 'linked' ? tracked.slice(1).map(item => ({ ItemId: item.Id })) : [];
    if (sample.clearWarmVersions) { primary.LocalAlternateVersions = []; primary.LinkedAlternateVersions = []; }
    const assets = new MetadataImageAssets({ fileSystem: testFileSystem, metadataPath, stateRoots: [dataPath, path.join(root, 'media')] });
    // Keep the controlled external marker through internal video cleanup by
    // using the actual media-local trickplay directory, deleted externally.
    const externalMarker = item => path.join(root, 'media', path.parse(item.Path).name + '.trickplay', 'marker');
    await mkdir(path.join(root, 'media'), { recursive: true }); await writeFile(primary.Path, Buffer.from([1, 3, 5, 7]));
    if (sample.survivor) await writeFile(tracked[1].Path, Buffer.from([2, 4, 6, 8]));
    for (const item of tracked) { await assets.write(path.join(internalImagePath(item, metadataPath), 'marker'), Buffer.from('internal')); await assets.write(externalMarker(item), Buffer.from('external')); }
    const state = async () => {
      const frame = tracked.map(item => ({ id: idKey(item.Id), parentId: idKey(item.ParentId ?? EMPTY_ID), ownerId: idKey(item.OwnerId ?? EMPTY_ID), primaryVersionId: item.PrimaryVersionId == null ? null : idKey(item.PrimaryVersionId),
        localCount: item.LocalAlternateVersions.length, linkedCount: item.LinkedAlternateVersions.length }));
      const persisted = await store.run(db => db.rows('BaseItems', { whereIn: { Id: tracked.map(item => item.Id) }, columns: ['Id'] }));
      return Promise.all(tracked.map(async (item, index) => ({ ...frame[index], source: await exists(() => testFileSystem.stat(item.Path)),
        internalMetadata: await exists(() => assets.stat(path.join(internalImagePath(item, metadataPath), 'marker'))), externalMetadata: await exists(() => assets.stat(externalMarker(item))),
        row: persisted.some(row => idKey(row.Id) === frame[index].id), cached: await items.getItemById(item.Id) !== null })));
    };
    const external = new ExternalDataManager({ fileSystem: testFileSystem, store, dataPath, metadataPath, logger });
    const deleteFiles = external.deleteItemFiles.bind(external);
    external.deleteItemFiles = async (item, options) => { calls.push({ kind: 'external', id: idKey(item.Id), state: await state() }); return deleteFiles(item, options); };
    const references = new LinkedChildReferenceService({ store, itemCreation: items, loadContext, updates: metadata.updates });
    const deletion = library.itemDeletion = new ItemDeletionService({ store, library, loadContext, itemCreation: items, updates: metadata.updates,
      externalData: external, linkedChildReferences: references, vfs: testFileSystem.vfs, metadataVfs: testFileSystem.vfs, logger });
    const persist = deletion.deleteItems.bind(deletion);
    deletion.deleteItems = async (plan, scope, publish) => {
      const ids = (await scope.database.client.query({ text: 'SELECT "Key" FROM (' + plan.text + ') requested ORDER BY "Ordinal"', values: plan.values })).rows.map(row => row.Key);
      calls.push({ kind: 'persist', ids, state: await state() }); return persist(plan, scope, publish);
    };
    library.on('ItemRemoved', value => {
      const entry = { kind: 'event', id: idKey(value.Item.Id), parentId: value.Parent ? idKey(value.Parent.Id) : null }; calls.push(entry);
      const pending = state().then(snapshot => { entry.state = snapshot; }); eventReads.push(pending); void pending.catch(() => {});
    });
    const sourceDirectory = path.join(root, 'package'); await mkdir(sourceDirectory);
    await writeFile(path.join(sourceDirectory, 'package.json'), JSON.stringify({ name: '@fixture/channel-version-delete', version: '0.1.0', type: 'module', mediamanager: { id: 'channel-version-delete', name: 'Owned external versions', entry: 'index.js' } }));
    await writeFile(path.join(sourceDirectory, 'index.js'), packageCode);
    plugins = await PluginHost.open({ directory: path.join(root, 'host'), preinstalled: false, options: { 'channel-version-delete': { sample,
      deleting: async (externalId, options) => { calls.push({ kind: 'provider', externalId, pluginSignal: options.signal instanceof AbortSignal, signalAborted: options.signal.aborted, state: await state() }); await deleting?.(externalId, options); } } }, onError: logger.error });
    await plugins.install(sourceDirectory); channels = library.channels = new ChannelService({ plugins, library, users: { getUser: async () => null }, getMetadata: () => metadata }); deletion.channelManager = channels;
    const released = async () => {
      await drainEvents(); await links.flushReleases();
      const result = await database.client.query(`SELECT (SELECT count(*) FROM ${q(links.schemaName)}.item_states)::integer AS states, (SELECT count(*) FROM ${q(links.schemaName)}.item_cohorts)::integer AS cohorts`);
      assert.deepEqual(result.rows[0], { states: 0, cohorts: 0 }); return result.rows[0];
    };
    return { database, store, links, library, items, metadata, plugins, channels, primary, parent, tracked, calls, diagnostics, state, drainEvents, released, close,
      operation() { const options = { DeleteFileLocation: false, DeleteFromExternalProvider: sample.outerProvider }; return library.deleteItem(primary, options, parent, true).then(() => ({ DeleteFileLocation: options.DeleteFileLocation, DeleteFromExternalProvider: options.DeleteFromExternalProvider })); },
      rows: async () => projectRows(await store.run(db => db.rows('BaseItems', { columns: ['Id', 'Name', 'ParentId', 'OwnerId', 'PrimaryVersionId'] }))),
      savedLinks: async () => projectLinks(await store.run(db => db.rows('LinkedChildren', {}))),
      parentState: () => ({ parentChildrenInvalidated: cachedFolderChildrenSnapshot(parent) == null, parentUserDataInvalidated: parent.UserData == null }),
    };
  } catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], error.message, { cause: error }); } throw error; }
}
async function exists(operation) { try { await operation(); return true; } catch (error) { if (['ENOENT', 'not-found'].includes(error.code)) return false; throw error; } }
