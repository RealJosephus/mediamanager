import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../../../database/postgres-fixture.js';
import { testFileSystem } from '../../../storage/plugin-files.js';
import { DomainStore } from '../../../../src/database/domain-store.js';
import { tableDefinition } from '../../../../src/database/model.js';
import { LibraryService } from '../../../../src/library/library-service.js';
import { ItemCreationService } from '../../../../src/library/item-creation-service.js';
import { ItemDeletionService } from '../../../../src/library/item-deletion-service.js';
import { ExternalDataManager } from '../../../../src/library/external-data.js';
import { LinkedChildReferenceService } from '../../../../src/library/linked-child-reference-service.js';
import { PostgresLinkedChildrenStore } from '../../../../src/library/postgres-linked-children.js';
import { createMetadataContextLoader } from '../../../../src/library/metadata-context.js';
import { MetadataRefreshHost } from '../../../../src/metadata/refresh-host.js';
import { MetadataRegistry } from '../../../../src/metadata/registry.js';
import { ChannelService } from '../../../../src/library/channel-service.js';
import { PluginHost } from '../../../../src/plugins/host.js';
import { nativeGuid } from '../../../../src/users/native.js';
import { idKey } from '../../../../src/library/records.js';
import { stringifyNativeJson, parseLosslessJson } from '../../../../src/core/json.js';
import { fields, userId } from './input.js';
import { createApplication } from '../../../../src/http/application.js';
import { AuthenticationService } from '../../../../src/users/authentication-service.js';
import { defaultUserData, hydrateItem, saveUserData, userDataKeys } from '../../../../src/sessions/user-data.js';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const errorRecord = error => ({ type: error.nativeException ?? error.name, status: error.status ?? error.statusCode ?? 500, Message: error.message, StackTrace: error.stack });
export async function observe(operation) { try { return { value: await operation() }; } catch (error) { return { failure: errorRecord(error) }; } }
export const comparable = value => value?.failure ? { failure: { status: value.failure.status,
  ...(value.failure.status === 400 ? { Message: value.failure.Message } : {}) } } : value;
export function normalize(value, root) {
  if (typeof value === 'string') return value.replaceAll(root, '<ROOT>').replaceAll(root.replaceAll('\\', '/'), '<ROOT>');
  if (Array.isArray(value)) return value.map(item => normalize(item, root));
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, normalize(item, root)]));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, root)]));
  return value;
}
const projectDto = item => parseLosslessJson(stringifyNativeJson(item));
const jsonValue = value => parseLosslessJson(JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry));
const projectItem = item => jsonValue({ Id: idKey(item.Id), Name: item.Name, Path: item.Path, ExternalId: item.ExternalId ?? null,
  RunTimeTicks: item.RunTimeTicks, Genres: item.Genres, Tags: item.Tags, Overview: item.Overview,
  channelId: idKey(item.ChannelId), parentId: idKey(item.ParentId), type: item.NativeType,
  artists: item.Artists ?? null, albumArtists: item.AlbumArtists ?? null });

const packageCode = `
export async function activate(context) {
  for(const spec of context.options.providers) {
    const offsets=new Map();
    const extension={type:spec.type,name:spec.name,dataVersion:spec.dataVersion,description:'Controlled original catalog',supportsMediaProbe:spec.probe===true,
      getChannelFeatures:()=>({}),isEnabledFor:()=>true,getChannelImage:()=>null,getSupportedChannelImages:()=>[],
      getCacheKey(userId){context.options.record({kind:'key',name:spec.name,userId});return spec.cacheKey;},
      async getChannelItems(query,options){
        context.options.record({kind:'items',name:spec.name,...query,canBeCanceled:false});await context.options.fetching?.(spec,query,options);
        const key=query.FolderId??'root',values=spec.responses[key],index=offsets.get(key)??0;offsets.set(key,index+1);
        return structuredClone(values[Math.min(index,values.length-1)]);
      }};
    if(spec.latest)extension.getLatestMedia=()=>{throw new Error('The marker callback must never execute.');};
    await context.register('channel',extension);
  }
}
`;

export async function openScenario(sample, expected, root, { fetching } = {}) {
  let database, store, links, library, items, metadata, channels, plugins, application, closing;
  const calls = [], queue = [], diagnostics = [], contexts = new Set(), events = [];
  const logger = { error: error => diagnostics.push(error) };
  const close = () => closing ??= (async () => {
    const errors = [], attempt = async work => { try { await work(); } catch (error) { errors.push(error); } };
    application?.beginClose(); await attempt(() => application?.drainRequests());
    if (application?.server.listening) await attempt(() => new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve())));
    const channelClosing = channels?.close(); metadata?.cancel(); await attempt(() => channelClosing);
    for (const operation of [() => metadata?.close(), () => items?.close(), () => library?.close(), () => plugins?.close(),
      () => links?.flushReleases(), () => links?.close(), () => store?.close(), () => dropPostgresTestDatabase(database)]) await attempt(operation);
    if (errors.length) throw new AggregateError(errors, 'Channel Items owners failed to close.');
  })();
  try {
    await mkdir(root, { recursive: true }); database = await createPostgresTestDatabase(null, 'channel_items'); store = new DomainStore(database);
    links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
    const metadataPath = path.join(root, 'metadata'), cachePath = path.join(root, 'cache');
    const configuration = { CacheSize: 128, EnableCaseSensitiveItemIds: true, MetadataCountryCode: 'US' };
    library = new LibraryService({ store, linkedChildren: links, fileSystem: testFileSystem, programDataPath: root, metadataPath,
      configuration, serverId: 'channel-items', onError: logger.error,
      userRoot: { Id: 'ce100000000000000000000000000099', Type: 'MediaBrowser.Controller.Entities.UserRootFolder', Name: 'User root', IsFolder: true, IsRoot: true, Path: null } });
    const original = createMetadataContextLoader({ store, library, linkedChildren: links, fileSystem: testFileSystem,
      vfs: testFileSystem.vfs, identityMap: testFileSystem.identityMap, configuration, spoolRoot: path.join(root, 'spool'), logger });
    const loadContext = Object.assign(async (...args) => {
      const loaded = await original(...args), dispose = loaded.dispose.bind(loaded); contexts.add(loaded);
      loaded.reversePath = value => value; loaded.reloadMetadataContext = loadContext;
      loaded.dispose = async () => { try { await dispose(); } finally { contexts.delete(loaded); } }; return loaded;
    }, original);
    loadContext.withContext = async (id, options, work) => { const loaded = await loadContext(id, options); try { return await work(loaded); } finally { await loaded.dispose(); } };
    items = library.itemCreation = new ItemCreationService({ store, library, loadContext, linkedChildren: links });
    metadata = new MetadataRefreshHost({ store, linkedChildren: links, loadContext, registry: new MetadataRegistry(), logger, vfs: testFileSystem.vfs });
    // The native provider manager is controlled at exactly these two metadata
    // execution boundaries. Creation/repository update/SQL/source cache stay real.
    metadata.refreshLiveItem = async () => 1;
    metadata.queue = (id, _options, priority) => { queue.push({ id: idKey(id), priority: ['High', 'Normal', 'Low'][priority] }); return Promise.resolve(); };
    const externalData = new ExternalDataManager({ store, fileSystem: testFileSystem, metadataPath, dataPath: path.join(root, 'data'), logger });
    const references = new LinkedChildReferenceService({ store, itemCreation: items, loadContext, updates: metadata.updates });
    const deletion = library.itemDeletion = new ItemDeletionService({ store, library, loadContext, itemCreation: items, updates: metadata.updates,
      externalData, linkedChildReferences: references, vfs: testFileSystem.vfs, metadataVfs: testFileSystem.vfs, logger });
    const columns = new Map(tableDefinition('BaseItems').columns.map(column => [column.name, column]));
    const rows = expected.beforeRows.map(row => postgresTestRow('BaseItems', Object.fromEntries(Object.entries(row).filter(([name]) => columns.has(name))
      .map(([name, value]) => [name, value != null && columns.get(name).clrType.replace('?', '') === 'Guid' ? nativeGuid(value)
        : name === 'Path' && typeof value === 'string' && value.startsWith(expected.root) ? root + value.slice(expected.root.length) : value]))));
    await database.transaction(async db => { await db.client.query('SET CONSTRAINTS ALL DEFERRED'); for (const row of rows) await db.insert('BaseItems', row); });
    await database.insert('Users', postgresTestRow('Users', { Id: nativeGuid(userId), Username: 'channel-items', NormalizedUsername: 'CHANNEL-ITEMS', InternalId: 1,
      AuthenticationProviderId: 'controlled', PasswordResetProviderId: 'controlled' }));
    const user = { Id: nativeGuid(userId), Policy: { EnableAllFolders: true, EnableAllChannels: true, BlockedTags: [], AllowedTags: [], BlockUnratedItems: [],
      BlockedMediaFolders: [], BlockedChannels: [], EnabledFolders: [], EnabledChannels: [] }, Configuration: {
        GroupedFolders: [], MyMediaExcludes: [], OrderedViews: [], LatestItemsExcludes: [], HidePlayedInLatest: false } };
    const source = path.join(root, 'package'); await mkdir(source);
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@fixture/channel-items', version: '0.1.0', type: 'module',
      mediamanager: { id: 'channel-items', name: 'Controlled original Channel Items', entry: 'index.js' } }));
    await writeFile(path.join(source, 'index.js'), packageCode);
    plugins = await PluginHost.open({ directory: path.join(root, 'host'), preinstalled: false, options: { 'channel-items': {
      providers: sample.providers, record: value => calls.push(value), fetching } }, onError: logger.error }); await plugins.install(source);
    channels = library.channels = new ChannelService({ plugins, library, cachePath, users: { getUser: async () => user }, getMetadata: () => metadata, onError: logger.error }); deletion.channelManager = channels;
    for (const name of ['ItemAdded', 'ItemUpdated', 'ItemRemoved']) library.on(name, event => events.push({ name, id: idKey(event.Item.Id) }));
    const ids = new Map(expected.identities.map(value => [value.name, value.id]));
    const http = async (step, query) => {
      const wireErrors = [];
      if (!application) {
        const authentication = new AuthenticationService({ store, users: { getUser: async () => user }, serverId: 'channel-items', isLocalNetwork: () => true });
        authentication.authenticate = async () => ({ IsAuthenticated: true, IsAdministrator: true, IsApiKey: false, UserId: userId, User: user });
        application = await createApplication({ configuration: { IsStartupWizardCompleted: true }, authentication, library, channels,
          users: { getUser: async () => user }, onError: error => application.requestErrors.push(errorRecord(error)) });
        application.requestErrors = [];
        await new Promise((resolve, reject) => { application.server.once('error', reject); application.server.listen(0, '127.0.0.1', () => { application.server.off('error', reject); resolve(); }); });
      }
      application.requestErrors.length = 0;
      const values = new URLSearchParams({ fields: (step.fields ?? fields).join(',') });
      values.set('parentId', query.ChannelIds[0]);
      if (query.Limit != null) values.set('limit', String(query.Limit));
      if (query.IsPlayed != null) values.set('isPlayed', String(query.IsPlayed));
      if (query.GroupItems != null) values.set('groupItems', String(query.GroupItems));
      if (query.IncludeItemTypes) values.set('includeItemTypes', query.IncludeItemTypes.join(','));
      const route = '/Items/Latest?' + values;
      const response = await fetch('http://127.0.0.1:' + application.server.address().port + route);
      const body = await response.text(); wireErrors.push(...application.requestErrors);
      const wire = { route, status: response.status, contentType: response.headers.get('content-type'), body, diagnostics: wireErrors };
      if (!response.ok) {
        assert.equal(wireErrors.length, 1, 'A business error has one exact request diagnostic.');
        return { action: { failure: wireErrors[0] }, wire };
      }
      assert.deepEqual(wireErrors, []); const value = parseLosslessJson(body);
      // This is already the complete actual wire JSON. Re-serializing it as a
      // DTO would lose explicit nulls emitted by native Guid converters.
      return { action: { value }, wire };
    };
    const state = async () => store.run(async db => {
      const raw = (await db.rows('BaseItems')).filter(row => row.Type !== 'PLACEHOLDER'), selected = await library.load(db, null, { baseRows: raw, includeUserData: false });
      try {
        const cold = [...selected.byId.values()].filter(item => raw.some(row => idKey(row.Id) === idKey(item.Id))).sort((left, right) => idKey(left.Id).localeCompare(idKey(right.Id)));
        return { persisted: cold.map(projectItem), userData: await db.rows('UserData'),
          calls: structuredClone(calls), queue: structuredClone(queue) };
      } finally { await selected.dispose({ session: db }); }
    });
    return { root, database, store, library, channels, metadata, items, calls, queue, diagnostics, events, state, close,
      async step(step) {
        let wire;
        const action = await observe(async () => {
          if (step.kind === 'policy') {
            if (step.hidePlayed !== undefined) user.Configuration.HidePlayedInLatest = step.hidePlayed;
            if (step.blockedTags !== undefined) user.Policy.BlockedTags = [...step.blockedTags];
            if (step.allowedTags !== undefined) user.Policy.AllowedTags = [...step.allowedTags];
            if (step.enableAllChannels !== undefined) user.Policy.EnableAllChannels = step.enableAllChannels;
            return true;
          }
          if (step.kind === 'played') {
            for (const externalId of step.externalIds) {
              const matches = await database.rows('BaseItems', { where: { ExternalId: externalId } });
              assert.equal(matches.length, 1);
              const item = await hydrateItem(database, matches[0]), [key] = await userDataKeys(database, item);
              await saveUserData(database, user.Id, item, { ...defaultUserData(key), Played: true, PlayCount: 1 });
            }
            return true;
          }
          const query = { ...step.query, Fields: step.fields ?? fields, UserId: userId, ChannelIds: [ids.get(step.provider)] };
          if (step.kind === 'parent-latest') { const observed = await http(step, query); wire = observed.wire; if (observed.action.failure) throw Object.assign(new Error(observed.action.failure.Message), {
            nativeException: observed.action.failure.type, status: observed.action.failure.status, stack: observed.action.failure.StackTrace }); return observed.action.value; }
          const value = await channels[step.kind === 'channel-latest-types' ? 'getLatestChannelItems' : 'getChannelItems'](query);
          return { ...value, Items: value.Items.map(projectDto) };
        });
        return { kind: step.kind, action, ...(wire ? { wire } : {}), ...await state() };
      } };
  } catch (error) { await close(); throw error; }
}
export async function removeOwned(owner, target) {
  const owned = path.resolve(owner), absolute = path.resolve(target), relative = path.relative(owned, absolute);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Channel Items cleanup escaped its owner.');
  await rm(absolute, { recursive: true, force: true });
}
