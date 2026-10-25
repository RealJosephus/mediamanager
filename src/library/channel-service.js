import { getNewItemId } from '../core/identity.js';
import { equalsIgnoreCase, nativeGuid } from '../users/native.js';
import { EMPTY_ID, dtoId, libraryError, nonemptyId, sameId } from './records.js';
import { ChannelItemCache } from './channel-item-cache.js';
import { materializeChannelItem } from './channel-items.js';

const deletionArgument = message => Object.assign(libraryError(400, message), { code: 'invalid-channel-argument' });
const required = (value, name) => {
  if (value == null) throw libraryError(400, `Value cannot be null. (Parameter '${name}')`);
  return value;
};

/** Installed external Channel providers are independent of retained Channel
 * rows and of the default Live TV tuner service. */
export class ChannelService {
  #closing = false;
  #closePromise;
  #readers = new Set();
  #itemCache;

  constructor(options) {
    const { plugins, library, users, getMetadata = () => undefined, onError = () => {} } = options;
    if (typeof plugins?.entries !== 'function' || !library || typeof users?.getUser !== 'function') {
      throw new TypeError('Channel providers require the plugin inventory, library and users.');
    }
    Object.assign(this, { plugins, library, users, getMetadata, onError, pathOptions: options });
  }
  get cachePath() { return this.pathOptions.cachePath; }

  admitOperation() {
    if (this.#closing) throw libraryError(503, 'Channel providers are closing.');
    const metadata = this.getMetadata(), metadataAccess = metadata?.admitShutdownDrain();
    const done = Promise.withResolvers(), pending = new Set(); let active = true, closing;
    const reader = { done: done.promise }; this.#readers.add(reader);
    const track = task => {
      pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {}); return task;
    };
    const call = operation => {
      if (!active) return Promise.reject(libraryError(503, 'The channel read scope is released.'));
      return track(Promise.resolve().then(() => metadataAccess ? metadataAccess.run(operation) : operation()));
    };
    const itemCall = work => {
      if (!active) return Promise.reject(libraryError(503, 'The channel read scope is released.'));
      // Library admission is synchronous, before any provider/cache await.
      // Release waits this entire frame even if it is still acquiring SQL.
      try { return track(this.library.withChannelItemOperation(access, () => metadataAccess ? metadataAccess.run(work) : work())); }
      catch (error) { return Promise.reject(error); }
    };
    const access = Object.freeze({
      getChannels: query => call(() => this.#getChannels(query, metadata)),
      getChannelsInternal: query => call(() => this.#getChannelsInternal(query, metadata)),
      getAllChannelFeatures: () => call(() => this.library.readChannelFeatures(channel => this.#features(channel))),
      getChannelFeatures: id => call(() => this.#getChannelFeatures(id)),
      canDelete: item => call(() => this.#canDelete(item)),
      deleteItem: item => call(() => this.#deleteItem(item)),
      getChannelItems: query => itemCall(() => this.#getChannelItems(query, metadata, access)),
      getLatestChannelItems: query => itemCall(() => this.#getLatestChannelItems(query, metadata, access)),
      withLatestChannelItems: (query, consume) => itemCall(async () => {
        const prepared = await this.#prepareLatestChannelItems(query, metadata, access);
        return consume(prepared?.query ?? null, prepared?.user ?? null);
      }),
      release: () => closing ??= (async () => {
        active = false;
        try { while (pending.size) await Promise.allSettled([...pending]); }
        finally { try { metadataAccess?.release(); } finally { this.#readers.delete(reader); done.resolve(); } }
      })(),
    });
    return access;
  }

  async #read(method, value) {
    const reader = this.admitOperation();
    try { return await reader[method](value); }
    finally { await reader.release(); }
  }
  getChannels(query = {}) { return this.#read('getChannels', query); }
  getChannelsInternal(query = {}) { return this.#read('getChannelsInternal', query); }
  getAllChannelFeatures() { return this.#read('getAllChannelFeatures'); }
  getChannelFeatures(id) { return this.#read('getChannelFeatures', id); }
  canDelete(item) { return this.#read('canDelete', item); }
  deleteItem(item) { return this.#read('deleteItem', item); }
  getChannelItems(query = {}) { return this.#read('getChannelItems', query); }
  getLatestChannelItems(query = {}) { return this.#read('getLatestChannelItems', query); }

  #providers() { return this.plugins.entries('channel'); }
  #identity(provider) {
    return getNewItemId('Channel ' + provider.name, 'MediaBrowser.Controller.Channels.Channel', {
      programDataPath: this.library.options.programDataPath,
      enableCaseSensitiveItemIds: this.library.options.configuration.EnableCaseSensitiveItemIds,
    });
  }
  async #provider(channel, providers) {
    required(channel, 'channel');
    providers ??= await this.library.orderChannelProviders(this.#providers());
    const provider = providers.find(value => sameId(this.#identity(value), channel.ChannelId) || equalsIgnoreCase(value.name, channel.Name));
    if (!provider) throw libraryError(404, 'No channel provider found for channel ' + (channel.Name ?? ''));
    return provider;
  }
  enableMediaSourceDisplay(_item, channel) {
    // Unlike GetChannelProvider, this native predicate retains registration
    // order, uses the referent's own Id, and has no name fallback.
    const providers = this.#providers();
    if (providers.length && !channel) throw libraryError(500, 'Object reference not set to an instance of an object.');
    const provider = providers.find(value => sameId(this.#identity(value), channel.Id));
    return provider?.disableMediaSourceDisplay !== true;
  }
  #canDelete(item) {
    return this.library.withChannelEntity(item.ChannelId, reference => {
      const providers = this.#providers();
      if (providers.length && !reference) throw libraryError(500, 'Object reference not set to an instance of an object.');
      const provider = providers.find(value => sameId(this.#identity(value), reference.Id));
      return typeof provider?.canDelete === 'function' ? provider.canDelete(item) : false;
    });
  }
  #deleteItem(item) {
    const channelId = nativeGuid(item.ChannelId);
    if (!nonemptyId(channelId)) throw deletionArgument("Guid can't be empty (Parameter 'id')");
    return this.library.withChannelEntity(channelId, reference => {
      if (!reference) throw deletionArgument('ChannelId');
      const provider = this.#providers().find(value => sameId(this.#identity(value), reference.Id));
      if (typeof provider?.deleteItem !== 'function') throw deletionArgument('channel');
      // LibraryManager passes CancellationToken.None. Public request abort is
      // not forwarded; the admitted operation drains before plugin shutdown.
      return provider.deleteItem(item.ExternalId);
    });
  }
  /** MetadataRefreshHost already owns this operation and drains before the
   * inventory's library/plugin dependencies close. Do not admit a second
   * public reader during an existing refresh's shutdown drain. */
  getMetadataProvider(item) { return this.#provider(item); }
  async #features(channel) {
    const provider = await this.#provider(channel), features = await provider.getChannelFeatures();
    const list = value => {
      if (value === null) throw libraryError(500, 'Object reference not set to an instance of an object.');
      return value ?? [];
    };
    return { Name: channel.Name, Id: dtoId(channel.Id), CanSearch: false,
      CanFilter: features.MaxPageSize == null,
      ContentTypes: [...list(features.ContentTypes)],
      DefaultSortFields: [...list(features.DefaultSortFields)],
      MaxPageSize: features.MaxPageSize ?? null,
      MediaTypes: [...list(features.MediaTypes)],
      SupportsSortOrderToggle: features.SupportsSortOrderToggle ?? false,
      SupportsLatestMedia: typeof provider.getLatestMedia === 'function',
      SupportsContentDownloading: features.SupportsContentDownloading ?? false,
      AutoRefreshLevels: features.AutoRefreshLevels ?? null };
  }
  #getChannelFeatures(id) {
    required(id, 'id');
    return this.library.withChannelEntity(id, item => this.#features(item?.Type === 'Channel' ? item : null));
  }
  async #user(query) { return Object.hasOwn(query, 'User') ? query.User : nonemptyId(query.UserId ?? EMPTY_ID) ? this.users.getUser(query.UserId) : null; }
  async #getChannels(query = {}, metadata) {
    const user = await this.#user(query);
    return this.#catalog(query, user, metadata, false);
  }
  async #getChannelsInternal(query = {}, metadata) {
    return this.#catalog(query, await this.#user(query), metadata, true);
  }
  async #catalog(query, user, metadata, internal) {
    const providers = await this.library.orderChannelProviders(this.#providers());
    return this.library.readChannelCatalog(query, { providers, user, internal,
      ensureEntity: provider => {
        const id = this.#identity(provider);
        // GetAllChannelEntitiesAsync keeps an existing typed Channel intact;
        // only a missing/wrongly typed root enters GetChannel(provider).
        return this.library.withChannelEntity(id, item => item?.Type === 'Channel'
          ? item : this.library.ensureChannel(provider, id, { metadata }));
      },
      markers: async (item, key) => {
        try {
          const provider = await this.#provider(item, providers);
          if (key === 'IsRecordingsFolder') return provider.attributes?.some(value => equalsIgnoreCase(value, 'Recordings')) ?? false;
          if (key === 'SupportsLatestItems') return typeof provider.getLatestMedia === 'function';
          return typeof provider.deleteItem === 'function';
        } catch { return null; }
      },
      isEnabledFor: async (item, current) => {
        try { return await (await this.#provider(item, providers)).isEnabledFor(dtoId(current.Id)); }
        catch { return false; }
      } });
  }
  #cache() {
    const service = this;
    return this.#itemCache ??= new ChannelItemCache({ get cachePath() { return service.cachePath; }, fileSystem: this.library.options.fileSystem,
      getChannelId: provider => this.#identity(provider), onError: this.onError });
  }
  async #getChannelItems(query = {}, metadata, channelAccess) {
    return this.#items({ ...query, ChannelIds: [...(query.ChannelIds ?? [])] }, await this.#user(query), metadata, channelAccess);
  }
  async #items(query, user, metadata, channelAccess, { project = true } = {}) {
    return this.library.withChannelEntity(query.ChannelIds[0], async channel => {
      const provider = await this.#provider(channel?.Type === 'Channel' ? channel : null);
      const consume = async parent => {
        if (parent == null) throw libraryError(500, 'Object reference not set to an instance of an object.');
        const result = await this.#cache().get(provider, user, parent.Type === 'Channel' ? null : parent.ExternalId);
        if (!nonemptyId(query.ParentId)) query.ParentId = channel.Id;
        query.ChannelIds = []; query.GroupByPresentationUniqueKey = false;
        if (result !== null) {
          if (result.Items == null) throw libraryError(500, 'Object reference not set to an instance of an object.');
          const ids = [];
          for (const info of result.Items) ids.push((await materializeChannelItem(info, { provider, channel, parent,
            library: this.library, metadata, onError: this.onError })).Id);
          await this.library.deleteStaleChannelItems(query, ids, { user, parent, channelAccess });
        }
        return this.library.queryChannelItems(query, { user, channelAccess, project });
      };
      return nonemptyId(query.ParentId) ? this.library.withChannelEntity(query.ParentId, consume) : consume(channel);
    });
  }
  async #getLatestChannelItems(input = {}, metadata, channelAccess) {
    const prepared = await this.#prepareLatestChannelItems(input, metadata, channelAccess);
    if (!prepared) return { Items: [], TotalRecordCount: 0, StartIndex: input.StartIndex ?? 0 };
    return this.library.queryChannelItems(prepared.query, { user: prepared.user, channelAccess });
  }
  async #prepareLatestChannelItems(input = {}, metadata, channelAccess) {
    const query = { ...input, ChannelIds: [...(input.ChannelIds ?? [])] }, user = await this.#user(query);
    let providers = (await this.library.orderChannelProviders(this.#providers())).filter(provider => typeof provider.getLatestMedia === 'function');
    if (query.ChannelIds.length) providers = providers.filter(provider => query.ChannelIds.some(id => sameId(id, this.#identity(provider))));
    if (!providers.length) return null;
    for (const provider of providers) {
      const channel = await this.library.ensureChannel(provider, this.#identity(provider), { metadata });
      const selected = await this.#items({ ParentId: channel.Id, ChannelIds: [channel.Id], EnableTotalRecordCount: false }, null, metadata, channelAccess, { project: false });
      let failure;
      try {
        // The root selection is immutable before refreshing any folder. A
        // folder refresh cannot alter the next page's identities or offsets.
        for (let offset = 0;; offset += 128) {
          const page = await selected.page({ offset, limit: 128 });
          if (page.endOfSelection) break;
          for (const folder of page.rows) if (folder.IsTypedFolder) {
            const child = await this.#items({ ParentId: folder.Id, ChannelIds: [channel.Id], EnableTotalRecordCount: false }, null,
              metadata, channelAccess, { project: false });
            await child.close();
          }
        }
      } catch (error) { failure = error; throw error; }
      finally { await selected.close(failure); }
    }
    query.IsFolder = false;
    query.OrderBy = providers.length === 1 && providers[0].type.split('.').at(-1).includes('Trailer')
      ? [['PremiereDate', 'Descending'], ['ProductionYear', 'Descending'], ['DateCreated', 'Descending']]
      : [['DateCreated', 'Descending']];
    return { query, user };
  }
  close() {
    this.#closing = true;
    return this.#closePromise ??= (async () => {
      while (this.#readers.size) await Promise.all([...this.#readers].map(reader => reader.done));
      await this.#itemCache?.close();
    })();
  }
}
