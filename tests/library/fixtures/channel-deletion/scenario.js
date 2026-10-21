import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../../../database/postgres-fixture.js';
import { testFileSystem } from '../../../storage/plugin-files.js';
import { tableDefinition, quoteIdentifier as q } from '../../../../src/database/model.js';
import { DomainStore } from '../../../../src/database/domain-store.js';
import { nativeGuid } from '../../../../src/users/native.js';
import { idKey } from '../../../../src/library/records.js';
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
import { LiveTvRecordingsService } from '../../../../src/library/live-tv-recordings-service.js';
import { PluginHost } from '../../../../src/plugins/host.js';
import { dtoOptions, projectItem } from '../../../../src/library/dto.js';
import { canDeleteItem } from '../../../../src/library/delete-permission.js';
import { setFolderChildren, cachedFolderChildrenSnapshot } from '../../../../src/library/folder-cache.js';
import { createApplication } from '../../../../src/http/application.js';
import { AuthenticationService } from '../../../../src/users/authentication-service.js';
import { targetId, userId, parentId, missingId } from './input.js';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const errorRecord = error => ({ type: error.nativeException ?? error.name, status: error.status ?? error.statusCode ?? 500, Message: error.message, StackTrace: error.stack });
export async function observe(operation) { try { return { value: await operation() }; } catch (error) { return { failure: errorRecord(error) }; } }
export function comparable(value) { return value?.failure ? { failure: { type: value.failure.type, status: value.failure.status, Message: value.failure.Message } } : value; }
export async function removeOwned(owner, target) {
  const root = path.resolve(owner), value = path.resolve(target), relative = path.relative(root, value);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Deletion fixture cleanup escaped its owner.');
  await rm(value, { recursive: true, force: true });
}
export async function within(promise, label) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 30000); })]); }
  finally { clearTimeout(timer); }
}

const packageCode = `
export async function activate(context) {
  const spec=context.options.sample;
  const supported={type:'supported',name:'Supported',getChannelFeatures:()=>({}),isEnabledFor:()=>true,
    getChannelItems(){throw new Error('External catalog execution is forbidden.');},getChannelImage:()=>null,getSupportedChannelImages:()=>[]};
  if(spec.provider==='empty')return;
  if(spec.provider==='duplicate-plain-first')await context.register('channel',{...supported,type:'plain-first'});
  if(spec.provider!=='plain')Object.assign(supported,{
    async canDelete(item,options){context.options.record({kind:'canDelete',name:'Supported',id:item.Id.replaceAll('-','').toLowerCase(),Name:item.Name,ExternalId:item.ExternalId});
      await context.options.permission?.(item,options);if(typeof spec.result==='string')throw Object.assign(new Error('Controlled permission failure.'),{nativeException:'InvalidOperationException',status:500});return spec.result!==false;},
    async deleteItem(externalId,options){context.options.record({kind:'delete',name:'Supported',externalId,pluginSignal:options.signal instanceof AbortSignal,signalAborted:options.signal.aborted});await context.options.deleting?.(externalId,options);
      const failure=({argument:['ArgumentException','Controlled provider argument.',400],'argument-null':['ArgumentNullException',"Value cannot be null. (Parameter 'externalId')",400],io:['IOException','Controlled provider I/O failure.',500],failure:['InvalidOperationException','Controlled provider failure.',500]})[spec.outcome];
      if(failure){
        const error=Object.assign(new Error(failure[1]),{nativeException:failure[0],status:failure[2]});
        context.options.failed(error,import.meta.url);throw error;
      }}});
  await context.register('channel',supported);
}
`;

export async function openScenario(sample, expected, root, { permission, deleting } = {}) {
  let database, store, links, library, items, metadata, plugins, channels, closing;
  const calls = [], diagnostics = [], eventReads = [], providerFailures = [], providerConsumerCalls = [];
  const drainEvents = async () => {
    const results = await Promise.allSettled(eventReads), errors = results.filter(value => value.status === 'rejected').map(value => value.reason);
    if (errors.length) throw new AggregateError(errors, 'Deletion event observations failed to drain.');
  };
  const close = () => closing ??= (async () => {
    const failures = [], attempt = async action => { try { await action(); } catch (error) { failures.push(error); } };
    const pending = channels?.close(); metadata?.cancel(); await attempt(() => pending);
    await attempt(drainEvents);
    for (const action of [() => metadata?.close(), () => items?.close(), () => library?.close(), () => plugins?.close(),
      () => links?.flushReleases(), () => links?.close(), () => store?.close(), () => dropPostgresTestDatabase(database)]) await attempt(action);
    if (failures.length) throw new AggregateError(failures, 'Channel deletion owners failed to close.');
  })();
  try {
    await mkdir(root, { recursive: true }); database = await createPostgresTestDatabase(null, 'channel_delete'); store = new DomainStore(database);
    links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
    const metadataPath = path.join(root, 'metadata'), dataPath = path.join(root, 'data'), logger = { error: error => diagnostics.push(error), warn: error => diagnostics.push(error) };
    library = new LibraryService({ store, linkedChildren: links, serverId: 'channel-deletion', programDataPath: root, dataPath, metadataPath,
      fileSystem: testFileSystem, configuration: { CacheSize: 64, EnableCaseSensitiveItemIds: true }, onError: logger.error,
      userRoot: { Id: userId, NativeType: 'MediaBrowser.Controller.Entities.UserRootFolder', Type: 'MediaBrowser.Controller.Entities.UserRootFolder', Name: 'User root', Path: null, IsFolder: true, IsRoot: true } });
    const original = createMetadataContextLoader({ store, library, linkedChildren: links, fileSystem: testFileSystem, vfs: testFileSystem.vfs, identityMap: testFileSystem.identityMap,
      configuration: library.options.configuration, spoolRoot: path.join(root, 'spool'), logger });
    const loadContext = Object.assign(async (...args) => { const loaded = await original(...args); loaded.reversePath = value => value; loaded.reloadMetadataContext = loadContext; return loaded; }, original);
    loadContext.withContext = async (id, options, callback) => { const loaded = await loadContext(id, options); try { return await callback(loaded); } finally { await loaded.dispose(); } };
    items = library.itemCreation = new ItemCreationService({ store, library, loadContext, linkedChildren: links });
    metadata = new MetadataRefreshHost({ store, loadContext, linkedChildren: links, registry: new MetadataRegistry(), logger, vfs: testFileSystem.vfs });
    const columns = new Map(tableDefinition('BaseItems').columns.map(column => [column.name, column]));
    const rows = expected.beforeRows.map(source => postgresTestRow('BaseItems', Object.fromEntries(Object.entries(source).filter(([name]) => columns.has(name))
      .map(([name, value]) => [name, value != null && columns.get(name).clrType.replace('?', '') === 'Guid' ? nativeGuid(value)
        : name === 'Path' && typeof value === 'string' && value.startsWith(expected.root) ? root + value.slice(expected.root.length) : value]))));
    await database.transaction(async db => { await db.client.query('SET CONSTRAINTS ALL DEFERRED'); for (const row of rows) await db.insert('BaseItems', row); });
    await database.insert('Users', postgresTestRow('Users', { Id: nativeGuid(userId), Username: 'channel-delete', NormalizedUsername: 'CHANNEL-DELETE', InternalId: 1,
      AuthenticationProviderId: 'controlled', PasswordResetProviderId: 'controlled' }));
    const user = { Id: nativeGuid(userId), Policy: { EnableAllFolders: true, EnableAllChannels: true, BlockedTags: [], AllowedTags: [], BlockUnratedItems: [],
      EnableContentDeletion: sample.policy === 'content', IsAdministrator: sample.policy === 'admin',
      EnableContentDeletionFromFolders: sample.policy === 'channel' ? [expected.providerId] : sample.policy === 'wrong-folder' ? [missingId] : [] },
      Configuration: { GroupedFolders: [], MyMediaExcludes: [], OrderedViews: [] } };
    library.options.isActiveRecording = () => sample.active === true;
    const target = await items.getItemById(targetId), parent = await items.getItemById(parentId);
    assert.ok(target); assert.ok(parent); setFolderChildren(parent, [target]); parent.UserData = [];
    if (target.IsFolder) setFolderChildren(target, []);
    if (sample.warmName) target.Name = sample.warmName;
    const source = path.join(root, 'media', 'target.bin'); await mkdir(path.dirname(source), { recursive: true }); await writeFile(source, Buffer.from([1, 3, 5, 7]));
    const assets = new MetadataImageAssets({ fileSystem: testFileSystem, metadataPath, stateRoots: [dataPath, path.join(root, 'external')] });
    const internalMarker = path.join(internalImagePath(target, metadataPath), 'marker'), externalMarker = path.join(root, 'external', 'marker');
    await assets.write(internalMarker, Buffer.from('internal')); await assets.write(externalMarker, Buffer.from('external'));
    const state = async () => ({ source: await exists(() => testFileSystem.stat(source)), internalMetadata: await exists(() => assets.stat(internalMarker)),
      externalMetadata: await exists(() => assets.stat(externalMarker)), row: (await store.run(db => db.rows('BaseItems', { where: { Id: target.Id }, limit: 1 }))).length !== 0,
      cached: await items.getItemById(target.Id) !== null });
    const external = new ExternalDataManager({ fileSystem: testFileSystem, store, dataPath, metadataPath, logger });
    external.paths = () => [path.dirname(externalMarker)];
    const deleteFiles = external.deleteItemFiles.bind(external);
    external.deleteItemFiles = async (item, options) => { calls.push({ kind: 'external', id: idKey(item.Id), state: await state() }); return deleteFiles(item, options); };
    const references = new LinkedChildReferenceService({ store, itemCreation: items, loadContext, updates: metadata.updates });
    const deletion = library.itemDeletion = new ItemDeletionService({ store, library, loadContext, itemCreation: items, updates: metadata.updates,
      externalData: external, linkedChildReferences: references, vfs: testFileSystem.vfs, metadataVfs: testFileSystem.vfs, logger });
    const persist = deletion.deleteItems.bind(deletion);
    deletion.deleteItems = async (...args) => { calls.push({ kind: 'persist', ids: [targetId], state: await state() }); return persist(...args); };
    library.on('ItemRemoved', value => {
      const entry = { kind: 'event', id: idKey(value.Item.Id), parentId: value.Parent ? idKey(value.Parent.Id) : null }; calls.push(entry);
      const reading = state().then(value => { entry.state = value; }); eventReads.push(reading); void reading.catch(() => {});
    });
    const sourceDirectory = path.join(root, 'package'); await mkdir(sourceDirectory);
    await writeFile(path.join(sourceDirectory, 'package.json'), JSON.stringify({ name: '@fixture/channel-delete', version: '0.1.0', type: 'module', mediamanager: { id: 'channel-delete', name: 'Controlled channel deletion', entry: 'index.js' } }));
    await writeFile(path.join(sourceDirectory, 'index.js'), packageCode);
    plugins = await PluginHost.open({ directory: path.join(root, 'host'), preinstalled: false, options: { 'channel-delete': { sample, record: value => calls.push(value), permission, deleting,
      failed: (error, entryUrl) => providerFailures.push({ error: errorRecord(error), entryUrl, consumerIndex: providerConsumerCalls.length - 1 }) } }, onError: logger.error });
    await plugins.install(sourceDirectory);
    channels = library.channels = new ChannelService({ plugins, library, users: { getUser: async () => user }, getMetadata: () => metadata }); deletion.channelManager = channels;
    const admitOperation = channels.admitOperation.bind(channels);
    channels.admitOperation = () => {
      const operation = admitOperation();
      return Object.freeze({ ...operation, deleteItem(item) {
        // Observe the synchronous production consumer before returning its
        // original promise. Do not catch/rethrow or manufacture async frames
        // on the provider's original Error object.
        providerConsumerCalls.push({ id: idKey(item.Id), externalId: item.ExternalId, StackTrace: new Error('Observed Channel deletion consumer.').stack });
        return operation.deleteItem(item);
      } });
    };
    const released = async () => {
      await drainEvents();
      await links.flushReleases(); const result = await database.client.query(`SELECT (SELECT count(*) FROM ${q(links.schemaName)}.item_states)::integer AS states, (SELECT count(*) FROM ${q(links.schemaName)}.item_cohorts)::integer AS cohorts`);
      assert.deepEqual(result.rows[0], { states: 0, cohorts: 0 }); return result.rows[0];
    };
    return { database, store, links, library, items, metadata, plugins, channels, target, parent, user, calls, diagnostics, state, released, close,
      providerFailures, providerConsumerCalls, providerDirectory: path.join(root, 'host', 'packages'), providerSourceHash: hash(Buffer.from(packageCode)),
      providerErrorLine: packageCode.split('\n').findIndex(line => line.includes('const error=Object.assign(new Error(failure[1])')) + 1,
      drainEvents,
      async permissions() {
        const operation = channels.admitOperation(), currentUser = sample.user ? user : null;
        try {
          const options = { isActiveRecording: library.options.isActiveRecording, collectionFolders: () => [], channelCanDelete: item => operation.canDelete(item) };
          const direct = await observe(() => canDeleteItem(target, currentUser, options));
          const precomputed = await observe(() => canDeleteItem(target, currentUser, { ...options, precomputedFolders: true }));
          return await store.run(async db => {
            const state = await library.load(db, currentUser, { baseRows: rows, channelAccess: operation });
            try {
              state.byId.set(idKey(target.Id), target);
              const selected = dtoOptions({ fields: ['CanDelete'], enableimages: false, enableuserdata: false });
              const project = selected => observe(async () => { const dto = await projectItem(target, state, currentUser, selected, library.options); return { CanDelete: dto.CanDelete, ChannelName: dto.ChannelName ?? null }; });
              return { direct, precomputed, projected: await project(selected), projectedDetail: await project({ ...selected, precomputedDeleteFolders: false }) };
            } finally { await state.dispose({ session: db }); }
          });
        } finally { await operation.release(); }
      },
      async deleteDirect() { const options = { DeleteFileLocation: true, DeleteFromExternalProvider: sample.deleteFromExternalProvider }; await library.deleteItem(target, options, parent, true); return { DeleteFileLocation: options.DeleteFileLocation }; },
      async http(operation, { userRequest = sample.userRequest === true } = {}) {
        const authentication = new AuthenticationService({ store, users: { getUser: async () => user }, serverId: 'channel-delete', isLocalNetwork: () => true });
        authentication.authenticate = async () => ({ IsAuthenticated: true, IsAdministrator: true, IsApiKey: !userRequest && sample.recordingController !== true,
          UserId: userRequest || sample.recordingController ? user.Id : '0'.repeat(32), User: userRequest || sample.recordingController ? user : null });
        const liveTvRecordings = new LiveTvRecordingsService({ liveTv: { admitRead: () => { throw new Error('Configuration reads are outside this deletion action.'); } }, library, mediaAssets: assets, dataPath });
        const errors = []; const app = await createApplication({ configuration: { IsStartupWizardCompleted: true }, authentication, library, channels, liveTvRecordings, users: { getUser: async () => user }, onError: error => errors.push(errorRecord(error)) });
        try {
          await new Promise((resolve, reject) => { const failed = error => reject(error); app.server.once('error', failed);
            app.server.listen(0, '127.0.0.1', () => { app.server.off('error', failed); resolve(); }); });
          return await operation('http://127.0.0.1:' + app.server.address().port, errors);
        } finally { app.beginClose(); await app.drainRequests(); if (app.server.listening) await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); }
      },
      parentState: () => ({ parentChildrenInvalidated: cachedFolderChildrenSnapshot(parent) == null, parentUserDataInvalidated: parent.UserData == null }),
    };
  } catch (error) { await close(); throw error; }
}
async function exists(operation) { try { await operation(); return true; } catch (error) { if (['ENOENT', 'not-found'].includes(error.code)) return false; throw error; } }
