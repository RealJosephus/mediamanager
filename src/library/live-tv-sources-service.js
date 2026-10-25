import path from 'node:path';
import { randomUUID } from 'node:crypto';
import model from '../core/resources/live-tv-configuration-model.json' with { type: 'json' };
import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { libraryError } from './records.js';

const blank = value => value == null || clrTrim(value) === '';
const equals = (left, right) => left == null || right == null ? left == null && right == null : ordinalIgnoreCaseEquals(left, right);
const guidFileId = value => typeof value === 'string' && /^[a-f\d]{32}$/iu.test(clrTrim(value)) ? clrTrim(value).toLowerCase() : null;
const missing = type => libraryError(404, `Couldn't find provider of type ${type ?? ''}`);
const sequence = values => {
  if (values == null) throw libraryError(400, "Value cannot be null. (Parameter 'source')");
  return values;
};
const ioCodes = new Set(['EIO', 'ENOSPC', 'EDQUOT', 'EBUSY', 'EROFS', 'ENOTEMPTY', 'ENOTDIR', 'EMFILE', 'ENFILE', 'ENAMETOOLONG', 'ELOOP']);
const isIo = error => ioCodes.has(error.code);
const isUnauthorized = error => ['EACCES', 'EPERM', 'EISDIR', 'permission-denied', 'authentication-required'].includes(error.code);
const first = (values, predicate) => {
  const value = sequence(values).find(predicate);
  if (value === undefined) throw libraryError(500, 'Sequence contains no matching element.');
  return value;
};

export function defaultListingsProviderInfo() { return structuredClone(model.definitions.ListingsProviderInfo.defaults); }

function cloneTuner(info) {
  if (info == null) throw libraryError(500, 'The tuner host is null.');
  const clone = structuredClone(model.definitions.TunerHostInfo.defaults);
  for (const name of Object.keys(clone)) if (Object.hasOwn(info, name)) clone[name] = info[name];
  return clone;
}

function epgChannels(channels) {
  const ids = new Map(), numbers = new Map(), names = new Map();
  for (const channel of channels) {
    if (channel.Id == null) throw libraryError(400, 'Value cannot be null.');
    ids.set(ordinalIgnoreCaseKey(channel.Id), channel);
    if (channel.Number != null && channel.Number !== '') numbers.set(ordinalIgnoreCaseKey(channel.Number), channel);
    const name = (channel.Name ?? '').replaceAll(' ', '').replaceAll('-', '');
    if (!blank(name)) names.set(ordinalIgnoreCaseKey(name), channel);
  }
  return { ids, numbers, names };
}

function mappedChannel(channel, mappings, epg) {
  const mapped = value => {
    const mapping = sequence(mappings).find(mapping => equals(mapping.Name, value));
    return !blank(mapping?.Value) ? mapping.Value : value;
  };
  if (!blank(channel.Id)) {
    const found = epg.ids.get(ordinalIgnoreCaseKey(mapped(channel.Id)));
    if (found) return found;
  }
  if (!blank(channel.TunerChannelId)) {
    let id = channel.TunerChannelId;
    if (/\.json\.schedulesdirect\.org/iu.test(id)) id = id.replace(/\.json\.schedulesdirect\.org/giu, '').replace(/^I+/u, '');
    const found = epg.ids.get(ordinalIgnoreCaseKey(mapped(id)));
    if (found) return found;
  }
  if (!blank(channel.Number)) {
    const found = epg.numbers.get(ordinalIgnoreCaseKey(mapped(channel.Number)));
    if (found) return found;
  }
  if (!blank(channel.Name)) return epg.names.get(ordinalIgnoreCaseKey(channel.Name.replaceAll(' ', '').replaceAll('-', ''))) ?? null;
  return null;
}

function tunerMapping(channel, mappings, providerChannels) {
  const provider = mappedChannel(channel, mappings, epgChannels(providerChannels));
  return { Id: channel.Id, Name: !blank(channel.Number) ? channel.Number + ' ' + (channel.Name ?? '') : channel.Name,
    ProviderChannelId: provider?.Id ?? null, ProviderChannelName: provider?.Name ?? null };
}

/** Source management preserves configuration and provider failure prefixes. */
export class LiveTvSourcesService {
  #closed = false;
  #closing;
  #operations = new Set();
  #epgChannels = new Map();

  constructor(options = {}) {
    const { liveTv, plugins, fileSystem, cachePath, refreshGuide, getSchedulesDirectCountries,
      getCulture = () => 'en-US', newId = () => randomUUID().replaceAll('-', ''), onError = () => {} } = options;
    if (typeof liveTv?.admitMutation !== 'function' || typeof liveTv?.admitRead !== 'function'
      || typeof plugins?.entries !== 'function' || typeof refreshGuide !== 'function' || typeof getCulture !== 'function'
      || typeof fileSystem?.unlink !== 'function' || !path.isAbsolute(cachePath ?? '')) {
      throw new TypeError('Live TV sources require configuration admission, plugins, mapped caches and guide refresh.');
    }
    Object.assign(this, { liveTv, plugins, fileSystem, refreshGuide, getSchedulesDirectCountries, getCulture, newId, onError, pathOptions: options });
  }
  get cachePath() { return this.pathOptions.cachePath; }

  #report(error) { try { void Promise.resolve(this.onError(error)).catch(() => {}); } catch { /* Provider errors are diagnostic. */ } }
  #tuners() { return this.plugins.entries('tuner').filter(tuner => tuner.isSupported !== false); }
  #provider(type) { return this.plugins.entries('listings').find(provider => equals(provider.type, type)) ?? (() => { throw missing(type); })(); }

  #run(mutation, operation) {
    if (this.#closed) return Promise.reject(libraryError(503, 'Live TV source management is closing.'));
    const access = mutation ? this.liveTv.admitMutation() : this.liveTv.admitRead();
    const task = Promise.resolve().then(() => operation(access)).finally(() => access.release());
    this.#operations.add(task);
    void task.finally(() => this.#operations.delete(task)).catch(() => {});
    return task;
  }

  getTunerHostTypes() {
    return this.#run(false, () => {
      const compare = new Intl.Collator(this.getCulture(), { numeric: false }).compare;
      return this.#tuners().map((provider, ordinal) => ({ provider, ordinal }))
        .sort((left, right) => compare(left.provider.name, right.provider.name) || left.ordinal - right.ordinal)
        .map(({ provider }) => ({ Name: provider.name, Id: provider.type }));
    });
  }

  saveTunerHost(input, { dataSourceChanged = true } = {}) {
    return this.#run(true, async access => {
      const info = cloneTuner(input);
      const provider = this.#tuners().find(provider => equals(provider.type, info.Type));
      if (!provider) throw missing(info.Type);
      if (provider.validate) await provider.validate(info);
      const configuration = await access.getConfiguration();
      const index = sequence(configuration.TunerHosts).findIndex(tuner => equals(tuner.Id, info.Id));
      if (index === -1 || blank(info.Id)) {
        info.Id = this.newId(); configuration.TunerHosts = [...configuration.TunerHosts, info];
      } else configuration.TunerHosts[index] = info;
      await access.saveConfiguration(configuration);
      if (dataSourceChanged) await this.refreshGuide();
      return info;
    });
  }

  deleteTunerHost(id = null) {
    return this.#run(true, async access => {
      const configuration = await access.getConfiguration();
      configuration.TunerHosts = sequence(configuration.TunerHosts).filter(tuner => !equals(tuner.Id, id));
      await access.saveConfiguration(configuration);
      const safeId = guidFileId(id);
      if (safeId) {
        try { await this.fileSystem.unlink(path.join(this.cachePath, safeId + '_channels')); }
        catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'not-found') {
            if (!isIo(error) || isUnauthorized(error)) throw error;
            this.#report(error);
          }
        }
      }
      await this.refreshGuide();
    });
  }

  async #discover(provider, options) {
    try { return await provider.discoverDevices(3000, options); }
    catch (error) { this.#report(error); return []; }
  }

  discoverTuners(newDevicesOnly = false) {
    return this.#run(false, async access => {
      const configured = sequence((await access.getConfiguration()).TunerHosts).filter(tuner => !blank(tuner.DeviceId)).map(tuner => tuner.DeviceId);
      const result = [];
      for (const provider of this.#tuners()) for (const tuner of await this.#discover(provider)) {
        if (!newDevicesOnly || !configured.some(id => equals(id, tuner.DeviceId))) result.push(tuner);
      }
      return result;
    });
  }

  scanForTunerDeviceChanges({ signal } = {}) {
    return this.#run(true, async access => {
      for (const provider of this.#tuners()) {
        const discovered = await this.#discover(provider, { signal });
        const configured = sequence((await access.getConfiguration()).TunerHosts).filter(tuner => equals(tuner.Type, provider.type));
        for (const device of discovered) {
          const existing = configured.find(tuner => equals(tuner.DeviceId, device.DeviceId));
          if (existing && !equals(device.Url, existing.Url)) {
            existing.Url = device.Url;
            const info = cloneTuner(existing);
            if (provider.validate) await provider.validate(info);
            const configuration = await access.getConfiguration();
            const index = sequence(configuration.TunerHosts).findIndex(tuner => equals(tuner.Id, info.Id));
            if (index === -1 || blank(info.Id)) { info.Id = this.newId(); configuration.TunerHosts = [...configuration.TunerHosts, info]; }
            else configuration.TunerHosts[index] = info;
            await access.saveConfiguration(configuration); await this.refreshGuide();
          }
        }
      }
    });
  }

  saveListingProvider(info, { validateLogin = false, validateListings = false } = {}) {
    return this.#run(true, async access => {
      if (info == null) throw libraryError(400, "Value cannot be null. (Parameter 'info')");
      await this.#provider(info.Type).validate(info, validateLogin, validateListings);
      const configuration = await access.getConfiguration();
      const index = sequence(configuration.ListingProviders).findIndex(provider => equals(provider.Id, info.Id));
      if (index === -1 || blank(info.Id)) { info.Id = this.newId(); configuration.ListingProviders = [...configuration.ListingProviders, info]; }
      else configuration.ListingProviders[index] = info;
      await access.saveConfiguration(configuration);
      await this.#invalidate(info.Id);
      await this.refreshGuide();
      return info;
    });
  }

  async #invalidate(id) {
    if (id == null) throw libraryError(400, 'Value cannot be null.');
    this.#epgChannels.delete(ordinalIgnoreCaseKey(id));
    const safeId = guidFileId(id);
    if (!safeId) return;
    const filename = path.join(this.cachePath, 'xmltv', safeId + '.xml');
    try {
      try { if (!(await this.fileSystem.stat(filename)).isFile()) return; }
      catch (error) { if (['ENOENT', 'not-found'].includes(error.code) || isIo(error) || isUnauthorized(error)) return; throw error; }
      await this.fileSystem.unlink(filename);
    } catch (error) { if (isIo(error) || isUnauthorized(error) || error.code === 'ENOENT') this.#report(error); else throw error; }
  }

  deleteListingsProvider(id = null) {
    return this.#run(true, async access => {
      const configuration = await access.getConfiguration();
      configuration.ListingProviders = sequence(configuration.ListingProviders).filter(provider => !equals(provider.Id, id));
      await access.saveConfiguration(configuration);
      if (id != null && id !== '') await this.#invalidate(id);
      await this.refreshGuide();
    });
  }

  getLineups({ type = null, id = null, country = null, location = null } = {}) {
    return this.#run(false, async access => {
      if (blank(id)) return this.#provider(type).getLineups(null, country, location);
      const info = sequence((await access.getConfiguration()).ListingProviders).find(provider => equals(provider.Id, id));
      if (!info) throw missing(type);
      return this.#provider(info.Type).getLineups(info, country, location);
    });
  }

  async #providers(access) {
    return sequence((await access.getConfiguration()).ListingProviders).map(info => ({ info,
      provider: this.plugins.entries('listings').find(provider => equals(provider.type, info.Type)) })).filter(value => value.provider);
  }

  async #epg(provider, info, enableCache, options) {
    if (enableCache && info.Id == null) throw libraryError(400, 'Value cannot be null.');
    const key = info.Id == null ? null : ordinalIgnoreCaseKey(info.Id);
    if (enableCache && this.#epgChannels.has(key)) return this.#epgChannels.get(key);
    const channels = epgChannels(await provider.getChannels(info, options));
    if (key === null) throw libraryError(400, 'Value cannot be null.');
    this.#epgChannels.set(key, channels);
    return channels;
  }

  getPrograms(channel, startDateUtc, endDateUtc, { signal } = {}) {
    return this.#run(false, async access => {
      if (channel == null) throw libraryError(400, "Value cannot be null. (Parameter 'channel')");
      for (const { provider, info } of await this.#providers(access)) {
        if (!this.#enabled(info, channel.TunerHostId)) continue;
        const selected = mappedChannel(channel, info.ChannelMappings, await this.#epg(provider, info, true, { signal }));
        if (!selected) continue;
        const programs = await provider.getPrograms(info, selected.Id, startDateUtc, endDateUtc, { signal });
        for (const program of programs) {
          program.ChannelId = channel.Id;
          program.Id = (program.Id ?? '') + '_' + (channel.Id ?? '');
        }
        if (programs.length) return programs;
      }
      return [];
    });
  }

  addProviderMetadata(channels, { enableCache = true, signal } = {}) {
    return this.#run(false, async access => {
      if (channels == null) throw libraryError(400, "Value cannot be null. (Parameter 'channels')");
      for (const { provider, info } of await this.#providers(access)) {
        const enabled = channels.filter(channel => this.#enabled(info, channel.TunerHostId));
        if (!enabled.length) continue;
        try {
          const epg = await this.#epg(provider, info, enableCache, { signal });
          for (const channel of enabled) {
            const selected = mappedChannel(channel, info.ChannelMappings, epg);
            if (selected && !blank(selected.ImageUrl)) channel.ImageUrl = selected.ImageUrl;
          }
        } catch (error) { if (error.code !== 'not-supported') this.#report(error); }
      }
    });
  }

  #enabled(info, id) {
    if (info.EnableAllTuners) return true;
    if (blank(id)) throw libraryError(400, 'The tuner host identifier is required.');
    return sequence(info.EnabledTuners).some(value => equals(value, id));
  }

  async #tunerChannels(info) {
    const channels = [];
    for (const tuner of this.#tuners()) {
      try { channels.push(...(await tuner.getChannels(false)).filter(channel => this.#enabled(info, channel.TunerHostId))); }
      catch (error) { this.#report(error); }
    }
    return channels;
  }

  getChannelMappingOptions(id = null) {
    return this.#run(false, async access => {
      const info = first((await access.getConfiguration()).ListingProviders, provider => equals(provider.Id, id));
      const provider = this.#provider(info.Type);
      const tunerChannels = await this.#tunerChannels(info);
      const providerChannels = await provider.getChannels(info);
      return { TunerChannels: tunerChannels.map(channel => tunerMapping(channel, info.ChannelMappings, providerChannels)),
        ProviderChannels: providerChannels.map(channel => ({ Name: channel.Name, Id: channel.Id })),
        Mappings: info.ChannelMappings, ProviderName: provider.name };
    });
  }

  setChannelMapping(providerId, tunerChannelId, providerChannelId) {
    return this.#run(true, async access => {
      const configuration = await access.getConfiguration();
      const info = first(configuration.ListingProviders, provider => equals(provider.Id, providerId));
      const exists = sequence(info.ChannelMappings).some(mapping => equals(mapping.Name, tunerChannelId) && equals(mapping.Value, providerChannelId));
      info.ChannelMappings = sequence(info.ChannelMappings).filter(mapping => !equals(mapping.Name, tunerChannelId));
      if (!equals(tunerChannelId, providerChannelId) && !exists) {
        info.ChannelMappings = [...info.ChannelMappings, { Name: tunerChannelId, Value: providerChannelId }];
      }
      await access.saveConfiguration(configuration);
      const channels = await this.#tunerChannels(info);
      const providerChannels = await this.#provider(info.Type).getChannels(info);
      const mappings = channels.map(channel => tunerMapping(channel, info.ChannelMappings, providerChannels));
      await this.refreshGuide();
      return first(mappings, mapping => equals(mapping.Id, tunerChannelId));
    });
  }

  getCountries() {
    return this.#run(false, () => {
      if (typeof this.getSchedulesDirectCountries !== 'function') throw libraryError(501, 'Schedules Direct country discovery requires its provider client.');
      return this.getSchedulesDirectCountries();
    });
  }

  close() {
    this.#closed = true;
    return this.#closing ??= (async () => { while (this.#operations.size) await Promise.allSettled([...this.#operations]); this.#epgChannels.clear(); })();
  }
}
