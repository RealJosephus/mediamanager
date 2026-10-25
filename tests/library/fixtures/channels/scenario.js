import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../../../database/postgres-fixture.js';
import { testFileSystem } from '../../../storage/plugin-files.js';
import { tableDefinition, quoteIdentifier as q } from '../../../../src/database/model.js';
import { DomainStore } from '../../../../src/database/domain-store.js';
import { LibraryService } from '../../../../src/library/library-service.js';
import { ItemCreationService } from '../../../../src/library/item-creation-service.js';
import { PostgresLinkedChildrenStore } from '../../../../src/library/postgres-linked-children.js';
import { createMetadataContextLoader } from '../../../../src/library/metadata-context.js';
import { MetadataRefreshHost } from '../../../../src/metadata/refresh-host.js';
import { MetadataRegistry } from '../../../../src/metadata/registry.js';
import { ChannelService } from '../../../../src/library/channel-service.js';
import { PluginHost } from '../../../../src/plugins/host.js';
import { nativeGuid } from '../../../../src/users/native.js';
import { idKey } from '../../../../src/library/records.js';
import { stringifyNativeJson } from '../../../../src/core/json.js';
import { newNativeItemEntity, bindNativeItemChannelAccess } from '../../../../src/library/native-item-entity.js';
import { createChannelDynamicImagePlugin } from '../../../../src/metadata/channel-dynamic-image-provider.js';
import { dtoFields, userId } from './input.js';
import { createTestApplication } from '../../../helpers/application.js';
import { AuthenticationService } from '../../../../src/users/authentication-service.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const errorRecord = error => ({ type: error.nativeException ?? error.name, status: error.status ?? error.statusCode ?? 500, Message: error.message, StackTrace: error.stack });
export async function observe(operation) { try { return { value: await operation() }; } catch (error) { return { failure: errorRecord(error) }; } }
export function comparable(observation) {
  return observation?.failure ? { failure: { status: observation.failure.status,
    ...(observation.failure.status === 400 ? { Message: observation.failure.Message } : {}) } } : observation;
}
export const plain = value => value instanceof Map ? Object.fromEntries([...value].map(([key, entry]) => [key, plain(entry)]))
  : Array.isArray(value) ? value.map(plain) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry)])) : value;
export const projectDto = dto => Object.fromEntries(dtoFields.map(field => [field, plain(dto[field] ?? null)]));
export const projectInternal = result => ({ ...result, Items: result.Items.map(item => ({ Id: idKey(item.Id), Name: item.Name, SortName: item.SortName })) });
export const projectCatalog = result => ({ ...result, Items: result.Items.map(projectDto) });
const packageCode = `
import {validateLiveTvExtension} from '@mediamanager/plugin-sdk/live-tv/contract';
export async function activate(context) {
  for (const [index,spec] of context.options.providers.entries()) {
    const extension={type:'catalog-'+index,name:spec.name,description:spec.description,parentalRating:spec.parentalRating,
      ...(spec.kind==='all'?{attributes:spec.attributes??[]}:{}),
      ...(['all','display'].includes(spec.kind)?{disableMediaSourceDisplay:true}:{}),
      async getChannelFeatures(options){context.options.record({kind:'features',name:spec.name});await context.options.features?.(spec,options);return structuredClone(spec.features);},
      async isEnabledFor(userId,options){context.options.record({kind:'enabled',name:spec.name,userId});await context.options.enabled?.(spec,options);if(spec.failEnabled)throw new Error('Controlled enablement failure.');return spec.enabled!==false;},
      getChannelItems(){throw new Error('Channel items are outside this catalog component.');},
      getChannelImage(type){if(spec.recordImages)context.options.record({kind:'image',name:spec.name,type});return spec.imageBase64?{bytes:Buffer.from(spec.imageBase64,'base64'),mimeType:'image/png'}:null;},
      getSupportedChannelImages(){if(spec.recordImages)context.options.record({kind:'supported',name:spec.name});return spec.supportedImages??[];}};
    if(['all','latest'].includes(spec.kind))extension.getLatestMedia=()=>{throw new Error('Latest execution is outside this component.');};
    if(spec.kind==='all'){extension.canDelete=()=>{throw new Error('Deletion is outside this component.');};extension.deleteItem=extension.canDelete;}
    validateLiveTvExtension('channel',extension);await context.register('channel',extension);
  }
}
`;

export async function observeHttp(fixture, input) {
  const diagnostics = [], users = { getUser: async id => idKey(id) === userId ? fixture.user : null };
  const authentication = new AuthenticationService({ store: fixture.store, users, serverId: 'channel-http', isLocalNetwork: () => true });
  authentication.authenticate = async request => {
    const identity = request.headers['x-identity'] ?? 'admin', apiKey = identity === 'apiKey';
    return { IsAuthenticated: identity !== 'anonymous', IsApiKey: apiKey, IsAdministrator: ['admin', 'apiKey'].includes(identity),
      UserId: apiKey ? '0'.repeat(32) : userId, User: apiKey ? null : fixture.user };
  };
  const application = await createTestApplication({ configuration: { IsStartupWizardCompleted: true }, authentication, users, channels: fixture.channels,
    library: fixture.library, onError: error => diagnostics.push(errorRecord(error)) });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const observations = [];
  try {
    for (const sample of input) {
      diagnostics.length = 0;
      const response = await fetch(`http://127.0.0.1:${application.server.address().port}${sample.path}`, {
        headers: { Accept: 'application/json', 'X-Identity': sample.identity ?? 'admin' },
      });
      const body = await response.text(); let json = null; try { json = JSON.parse(body); } catch { }
      observations.push({ name: sample.name, path: sample.path, status: response.status, body, json,
        contentType: response.headers.get('content-type'), diagnostics: [...diagnostics] });
    }
    return { observations };
  } finally { application.beginClose(); await application.drainRequests(); await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve())); }
}

export async function removeOwnedDirectory(owner, target) {
  const owned = path.resolve(owner), absolute = path.resolve(target), relative = path.relative(owned, absolute);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Fixture cleanup escapes its owned directory.');
  await rm(absolute, { recursive: true, force: true });
}

export async function openScenario(sample, expected, root, { enabled, features } = {}) {
  let database, store, links, library, metadata, items, plugins, channels;
  const diagnostics = [], calls = [], creates = [], refreshes = [], pages = [], contexts = new Set();
  const close = async () => {
    const errors = [], attempt = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
    const draining = channels?.close(); metadata?.cancel(); await attempt(() => draining);
    await attempt(() => metadata?.close()); await attempt(() => items?.close()); await attempt(() => library?.close());
    for (const context of [...contexts]) await attempt(() => context.dispose());
    await attempt(() => plugins?.close()); await attempt(() => links?.flushReleases()); await attempt(() => links?.close());
    await attempt(() => store?.close()); await attempt(() => dropPostgresTestDatabase(database));
    if (errors.length) throw new AggregateError(errors, 'Channel catalog owners failed to close.');
  };
  try {
    await mkdir(root, { recursive: true });
    database = await createPostgresTestDatabase(null, 'channels'); store = new DomainStore(database);
    links = new PostgresLinkedChildrenStore({ database }); await links.initialize();
    const configuration = { MetadataCountryCode: 'US', EnableFolderView: false, EnableCaseSensitiveItemIds: true, CacheSize: 8 };
    const logger = { error: error => diagnostics.push(error) };
    library = new LibraryService({ store, linkedChildren: links, serverId: 'metadata-children', configuration,
      fileSystem: testFileSystem, metadataPath: expected.metadataPath, programDataPath: root,
      userRoot: { Id: 'cf100000000000000000000000000099', Type: 'MediaBrowser.Controller.Entities.UserRootFolder', Name: 'User root', Path: null, IsFolder: true, IsRoot: true },
      onError: logger.error });
    const originalLoader = createMetadataContextLoader({ store, library, linkedChildren: links, fileSystem: testFileSystem,
      vfs: testFileSystem.vfs, identityMap: testFileSystem.identityMap, configuration, spoolRoot: path.join(root, 'spool'), logger });
    const loadContext = Object.assign(async (...args) => {
      const loaded = await originalLoader(...args), dispose = loaded.dispose.bind(loaded); contexts.add(loaded);
      loaded.reversePath = value => value; loaded.reloadMetadataContext = loadContext;
      loaded.dispose = async () => { try { await dispose(); } finally { contexts.delete(loaded); } }; return loaded;
    }, originalLoader);
    loadContext.withContext = async (id, options, callback) => { const context = await loadContext(id, options); try { return await callback(context); } finally { await context.dispose(); } };
    items = library.itemCreation = new ItemCreationService({ store, library, linkedChildren: links, loadContext });
    metadata = new MetadataRefreshHost({ registry: new MetadataRegistry(), store, linkedChildren: links, loadContext,
      vfs: testFileSystem.vfs, logger, now: () => '2026-10-22T00:00:00.0000000Z' });
    const create = items.createItems.bind(items);
    items.createItems = async (values, parent, options) => {
      for (const item of values) if (item.Type === 'Channel') creates.push({ id: idKey(item.Id), Name: item.Name, Path: item.Path, channelId: idKey(item.ChannelId), parentId: idKey(item.ParentId), Overview: item.Overview, OfficialRating: item.OfficialRating });
      return create(values, parent, options);
    };
    const refresh = metadata.refreshLiveItem.bind(metadata);
    metadata.refreshLiveItem = async (item, options) => { refreshes.push({ id: idKey(item.Id), ForceSave: options.ForceSave }); return refresh(item, options); };
    const columns = new Map(tableDefinition('BaseItems').columns.map(column => [column.name, column]));
    const records = expected.beforeRows.map(row => postgresTestRow('BaseItems', Object.fromEntries(Object.entries(row).filter(([name]) => columns.has(name))
      .map(([name, value]) => [name, value != null && columns.get(name).clrType.replace('?', '') === 'Guid' ? nativeGuid(value) : value]))));
    await database.transaction(async db => { await db.client.query('SET CONSTRAINTS ALL DEFERRED'); for (const record of records) await db.insert('BaseItems', record); });
    await database.insert('Users', postgresTestRow('Users', { Id: nativeGuid(userId), Username: 'channel-catalog', NormalizedUsername: 'CHANNEL-CATALOG', InternalId: 1,
      AuthenticationProviderId: 'controlled', PasswordResetProviderId: 'controlled' }));
    const initialIds = new Set(records.map(row => idKey(row.Id)));
    for (const value of expected.userData ?? []) if (initialIds.has(idKey(value.id))) await database.insert('UserData', postgresTestRow('UserData', { ItemId: nativeGuid(value.id), UserId: nativeGuid(userId), CustomDataKey: value.Key, IsFavorite: value.IsFavorite }));
    const ids = new Map(expected.identities.map(value => [value.name, value.id]));
    const policy = { EnableAllFolders: true, EnableAllChannels: true, BlockedChannels: [], EnabledChannels: [], BlockedMediaFolders: [], EnabledFolders: [], BlockedTags: [], AllowedTags: [], BlockUnratedItems: [], ...sample.policy };
    for (const [field, target] of [['BlockedProviderNames', 'BlockedChannels'], ['EnabledProviderNames', 'EnabledChannels']]) if (sample.policy?.[field]) policy[target] = sample.policy[field].map(name => ids.get(name));
    const user = { Id: nativeGuid(userId), Username: 'channel-catalog', Policy: policy, Configuration: { GroupedFolders: [], MyMediaExcludes: [], OrderedViews: [] } };
    for (const seed of sample.seeds) if (seed.WarmName || seed.WarmImage) {
      const item = await items.getItemById(seed.Id ?? ids.get(seed.providerName));
      if (seed.WarmName) item.Name = seed.WarmName;
      if (seed.WarmImage) item.ImageInfos = [{ Type: 'Primary', Path: path.join(expected.metadataPath, 'warm.png'), DateModified: '2026-10-21T01:02:03.0000000Z', Width: 64, Height: 32, BlurHash: null }];
    }
    const source = path.join(root, 'package'); await mkdir(source);
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@fixture/channels', version: '0.1.0', type: 'module', dependencies: { '@mediamanager/plugin-sdk': '0.1.0' },
      mediamanager: { id: 'channel-catalog', name: 'Controlled channel catalog', entry: 'index.js' } }));
    await writeFile(path.join(source, 'index.js'), packageCode);
    plugins = await PluginHost.open({ directory: path.join(root, 'host'), preinstalled: false,
      options: { 'channel-catalog': { providers: sample.providers, record: value => calls.push(value), enabled, features } }, onError: logger.error });
    await plugins.install(source);
    channels = library.channels = new ChannelService({ plugins, library, users: { getUser: async id => idKey(id) === userId ? user : null }, getMetadata: () => metadata });
    metadata.registry.register(createChannelDynamicImagePlugin({ channels }));
    const originalQuery = database.client.query;
    database.client.query = async (...args) => { const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
      const values = typeof args[0] === 'string' ? args[1] : args[0]?.values;
      if (text.includes('/* page-relationship-graph */')) pages.push(values?.[0]?.length ?? 0);
      return originalQuery(...args); };
    const query = { ...sample.query, UserId: sample.user ? userId : '00000000000000000000000000000000' };
    const released = async () => {
      await links.flushReleases();
      const result = await database.client.query(`SELECT (SELECT count(*) FROM ${q(links.schemaName)}.item_states)::integer AS states, (SELECT count(*) FROM ${q(links.schemaName)}.item_cohorts)::integer AS cohorts`);
      assert.deepEqual(result.rows[0], { states: 0, cohorts: 0 }); assert.equal(contexts.size, 0);
      await database.withConnection(async db => { const leaked = await db.client.query("SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND (relname LIKE 'mm_channels_%' OR relname LIKE 'mm_channel_features_%')"); assert.deepEqual(leaked.rows, []); });
      return result.rows[0];
    };
    return { database, store, library, metadata, items, plugins, channels, query, user, calls, creates, refreshes, diagnostics, pages, released, close,
      display(sample, expectedDisplay) {
        const item = newNativeItemEntity(sample.reference === 'empty' ? 'MediaBrowser.Controller.Channels.Channel' : 'MediaBrowser.Controller.Entities.Video'); item.ChannelId = expectedDisplay.channelId;
        bindNativeItemChannelAccess(item, value => channels.enableMediaSourceDisplay(value, expectedDisplay.channel));
        return item.EnableMediaSourceDisplay;
      },
      async snapshot() { return (await database.rows('BaseItems')).map(row => stringifyNativeJson(row)).sort(); },
      async observeAll() { return { internalResult: await observe(async () => projectInternal(await channels.getChannelsInternal(query))),
        catalog: await observe(async () => projectCatalog(await channels.getChannels(query))),
        allFeatures: await observe(() => channels.getAllChannelFeatures()),
        feature: sample.featureId || expected.identities.length ? await observe(() => channels.getChannelFeatures(sample.featureId ?? expected.identities[0].id)) : null,
        views: await observe(async () => (await library.getViews({}, { user })).Items.map(item => ({ Id: item.Id, Name: item.Name }))) }; }
    };
  } catch (error) { await close(); throw error; }
}

export async function within(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 30000); })]); }
  finally { clearTimeout(timer); }
}
