import path from 'node:path';
import { validateNativeLiveTvSource } from '@mediamanager/plugin-sdk/live-tv/contract';
import { NativeHttpInput } from '@mediamanager/plugin-sdk/live-tv/raw-input';
import { ordinalIgnoreCaseEquals } from '@mediamanager/plugin-sdk/storage/ordinal-comparer';
import { clrTrim } from '@mediamanager/plugin-sdk/metadata/whitespace';
import { parseModel, parseLineup, parseChannelCache, serializeChannelCache } from './json.js';
import { createMediaSource, getApiUrl, supportsTranscoding } from './source.js';
import { discoverDevices } from './discovery.js';

const legacy = Symbol('HDHomeRun legacy channel');
const blank = value => value == null || clrTrim(value) === '';
const equals = (left, right) => left == null || right == null ? left == null && right == null : ordinalIgnoreCaseEquals(left, right);
const error = (message, extra = {}) => Object.assign(new Error(message), extra);
const nullReference = () => error('Object reference not set to an instance of an object.');
const unavailable = () => error('The HDHomeRun tuner is unavailable.', { status: 503 });
const forbidden = message => error(message, { code: 'not-supported', status: 400, statusCode: 400 });
const conflict = () => error('Unable to find host to play channel', { status: 409 });
const io = cause => ['ENOENT', 'ENOTDIR', 'EIO', 'ENOSPC', 'EDQUOT', 'EBUSY', 'EROFS', 'ENAMETOOLONG', 'ENOTEMPTY', 'EMFILE', 'ENFILE', 'EEXIST'].includes(cause?.code);
const channelDefaults = { Name: null, Number: null, Id: null, Path: null, TunerChannelId: null, CallSign: null, TunerHostId: null,
  ChannelType: 'TV', ChannelGroup: null, ImagePath: null, ImageUrl: null, HasImage: null, IsFavorite: null, IsHD: null, AudioCodec: null, VideoCodec: null, Tags: null };
function defaultTuner(url, model) {
  if (model === null) throw nullReference();
  return { Id: null, Url: url, Type: 'hdhomerun', DeviceId: model.DeviceID, FriendlyName: model.FriendlyName, ImportFavoritesOnly: false,
    AllowHWTranscoding: true, AllowFmp4TranscodingContainer: false, AllowStreamSharing: true, FallbackMaxStreamingBitrate: 30000000,
    EnableStreamLooping: false, Source: null, TunerCount: model.TunerCount, UserAgent: null, IgnoreDts: true, ReadAtNativeFramerate: false };
}

export class HdHomerunTuner {
  type = 'hdhomerun'; name = 'HD Homerun'; isSupported = true;
  #model = new Map(); #channels = new Map(); #inputs = new Set(); #work = new Set(); #cacheWrites = new Set();
  #lifetime = new AbortController(); #closed = false; #closing; #pathOptions;
  constructor(pathOptions = {}) {
    this.#pathOptions = pathOptions;
    const { fetch = globalThis.fetch, logger = { error() {} }, discoveryAddress = '255.255.255.255', discoveryPort = 65001,
      createSocket, httpTimeoutMs = 100000, userAgent } = pathOptions;
    Object.assign(this, { fetch, logger, discoveryAddress, discoveryPort, createSocket, httpTimeoutMs, userAgent });
  }
  get cachePath() { return this.#pathOptions.cachePath; }
  connect({ liveTv, fileSystem } = {}) {
    if (this.#closed) throw unavailable();
    if (typeof liveTv?.admitRead !== 'function' || typeof fileSystem?.open !== 'function' || typeof fileSystem?.readFile !== 'function') throw new TypeError('HDHomeRun requires admitted Live TV configuration and mapped cache storage.');
    Object.assign(this, { liveTv, fileSystem });
  }
  #report(cause) { try { this.logger.error(cause); } catch { /* Diagnostics do not replace native failure prefixes. */ } }
  #run(options, operation, configuration = true) {
    if (this.#closed || !this.liveTv || !this.fileSystem) throw unavailable();
    const signal = options?.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal; signal.throwIfAborted();
    const access = configuration ? this.liveTv.admitRead() : null, completion = Promise.withResolvers(); this.#work.add(completion.promise);
    return (async () => {
      try { return await operation(configuration ? await access.getConfiguration() : null, signal); }
      finally { access?.release(); this.#work.delete(completion.promise); completion.resolve(); }
    })();
  }
  #hosts(configuration) {
    if (configuration.TunerHosts === null) throw error('Value cannot be null. (Parameter source)');
    return configuration.TunerHosts.filter(info => { if (info === null) throw nullReference(); return equals(info.Type, this.type); });
  }
  #cacheFile(info) {
    const cachePath = this.cachePath;
    if (!path.isAbsolute(cachePath ?? '')) throw new TypeError('HDHomeRun channel cache requires an absolute mapped cache root.');
    if (info.Id != null && /[\\/:\0]/u.test(info.Id)) throw new TypeError('A tuner cache identity must be one file-name component.');
    return path.join(cachePath, (info.Id ?? '') + '_channels');
  }
  async #request(url, signal) {
    let uri;
    try { uri = new URL(url); } catch { throw error('An invalid request URI was provided. The request URI must be absolute.'); }
    if (!['http:', 'https:'].includes(uri.protocol)) throw error('Only HTTP and HTTPS requests are supported.', { code: 'not-supported' });
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new DOMException('The HTTP client request timed out.', 'TimeoutError')), this.httpTimeoutMs); timer.unref?.();
    try {
      const response = await this.fetch(url, { signal: AbortSignal.any([signal, deadline.signal]),
        headers: { Accept: 'application/json; q=1.0, application/xml; q=0.9, */*; q=0.8', ...(this.userAgent ? { 'User-Agent': this.userAgent } : {}) } });
      if (signal.aborted || deadline.signal.aborted) { await response.body?.cancel().catch(() => {}); throw signal.reason ?? deadline.signal.reason; }
      return response;
    } finally { clearTimeout(timer); }
  }
  async #json(url, signal, parse, ensureSuccess) {
    const response = await this.#request(url, signal);
    try {
      if (ensureSuccess && !response.ok) throw error(`Response status code ${response.status}.`, { code: 'http-error', httpStatus: response.status });
      const bytes = await response.arrayBuffer(); signal.throwIfAborted();
      const charset = /\bcharset\s*=\s*["']?([^;"'\s]+)/iu.exec(response.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
      const decoder = new TextDecoder(charset, { fatal: /^utf-?8$/iu.test(charset) });
      const text = decoder.decode(bytes);
      return parse(text);
    } finally { await response.body?.cancel().catch(() => {}); }
  }
  async #modelInfo(info, throwAll, signal) {
    if (info.Id && this.#model.has(info.Id)) return this.#model.get(info.Id);
    try {
      const value = await this.#json(getApiUrl(info) + '/discover.json', signal, parseModel, true);
      if (info.Id) this.#model.set(info.Id, value); return value;
    } catch (cause) {
      if (!throwAll && cause.code === 'http-error' && cause.httpStatus === 404) {
        const fallback = parseModel('{"ModelNumber":"HDHR"}'); if (info.Id) this.#model.set(info.Id, fallback); return fallback;
      }
      throw cause;
    }
  }
  async #hostChannels(info, enableCache, signal) {
    if (enableCache && info.Id && this.#channels.has(info.Id)) return this.#channels.get(info.Id);
    const model = await this.#modelInfo(info, false, signal); if (model === null) throw nullReference();
    const lineup = await this.#json(model.LineupURL ?? (model.BaseURL ?? '') + '/lineup.json', signal, parseLineup, false), channels = [];
    for (const entry of lineup) {
      if (entry === null) throw nullReference();
      if (info.ImportFavoritesOnly && !entry.Favorite || entry.DRM) continue;
      const channel = { ...channelDefaults, Name: entry.GuideName, Number: entry.GuideNumber, Id: 'hdhr_' + (entry.GuideNumber ?? ''),
        IsFavorite: entry.Favorite, TunerHostId: info.Id, IsHD: entry.HD, AudioCodec: entry.AudioCodec, VideoCodec: entry.VideoCodec, Path: entry.URL };
      Object.defineProperty(channel, legacy, { value: /^hdhomerun/iu.test(entry.URL ?? '') }); channels.push(channel);
    }
    if (info.Id && channels.length) this.#channels.set(info.Id, channels); return channels;
  }
  async #writeCache(filename, channels, signal) {
    if (this.#cacheWrites.has(filename)) throw Object.assign(new Error('The tuner cache is in use.'), { code: 'EBUSY' });
    this.#cacheWrites.add(filename); let file;
    try {
      await this.fileSystem.mkdir(path.dirname(filename), { recursive: true }); signal.throwIfAborted();
      try { file = await this.fileSystem.open(filename, 'r+'); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; file = await this.fileSystem.open(filename, 'wx'); }
      signal.throwIfAborted(); await file.writeFile(serializeChannelCache(channels));
    } finally { try { await file?.close(); } finally { this.#cacheWrites.delete(filename); } }
  }
  getChannels(enableCache, options) {
    return this.#run(options, async (configuration, signal) => {
      const result = [];
      for (const info of this.#hosts(configuration)) {
        const filename = this.#cacheFile(info);
        try {
          const channels = await this.#hostChannels(info, enableCache, signal);
          result.push(...channels.filter(channel => !result.some(prior => equals(prior.Id, channel.Id))));
          if (!enableCache) try { await this.#writeCache(filename, channels, signal); } catch (cause) { if (!io(cause)) throw cause; }
        } catch (cause) {
          this.#report(cause);
          if (enableCache) try { result.push(...parseChannelCache(await this.fileSystem.readFile(filename, { encoding: 'utf8', signal }))); }
          catch (fallback) { if (!io(fallback)) throw fallback; }
        }
      }
      return result;
    });
  }
  async *#matches(configuration, channelId, signal) {
    if (typeof channelId !== 'string' || !channelId) throw error('The channel identifier cannot be empty.');
    if (!/^hdhr_/iu.test(channelId)) return;
    for (const info of this.#hosts(configuration)) try {
      const channel = (await this.#hostChannels(info, true, signal)).find(value => equals(value.Id, channelId));
      if (channel) yield { info, channel };
    } catch (cause) { this.#report(cause); }
  }
  async #find(configuration, channelId, signal) {
    const matches = []; for await (const match of this.#matches(configuration, channelId, signal)) matches.push(match); return matches;
  }
  getChannelStreamMediaSources(channelId, options) {
    return this.#run(options, async (configuration, signal) => {
      for await (const { info, channel } of this.#matches(configuration, channelId, signal)) try {
        if (!channel[legacy]) await this.#modelInfo(info, false, signal);
        const source = { mode: 'native', profile: 'native', mediaSource: createMediaSource(info, channel) };
        // Model hdtc/AllowHWTranscoding still describe the device. Encoded
        // profiles are deliberately unavailable under the execution boundary.
        if (!channel[legacy] && channel.Path) validateNativeLiveTvSource({ ...source, mediaSource: { ...source.mediaSource, Path: channel.Path } });
        return [validateNativeLiveTvSource(source)];
      } catch (cause) { if (cause.code === 'not-supported') throw cause; this.#report(cause); }
      return [];
    });
  }
  async #owned(input, source, signal) {
    if (!input.sharing) {
      const owner = this;
      input.sharing = Object.freeze({ get enabled() { return !owner.#closed && input.enabled; },
        retain(options) { return owner.#run(options, (_configuration, signal) => owner.#owned(input, source, signal), false); } });
    }
    return { ...source, tunerHostId: input.tunerHostId ?? null, ...await input.acquire(signal), sharing: input.sharing };
  }
  getChannelStream(channelId, streamId, currentLiveStreams, options) {
    return this.#run(options, async (configuration, signal) => {
      validateNativeLiveTvSource(options?.source);
      const profile = (streamId ?? '').split('_')[0];
      if (typeof channelId !== 'string' || !channelId) throw error('The channel identifier cannot be empty.');
      if (!/^hdhr_/iu.test(channelId)) throw error('The channel was not found.', { code: 'ENOENT', status: 404 });
      for (const { info, channel } of await this.#find(configuration, channelId, signal)) try {
        if (info.TunerCount > 0 && currentLiveStreams.filter(value => equals(value.tunerHostId ?? value.TunerHostId, info.Id)).length >= info.TunerCount) throw conflict();
        const model = await this.#modelInfo(info, false, signal); if (model === null) throw nullReference();
        const effective = supportsTranscoding(model) ? profile : 'native';
        if (!blank(effective) && !equals(effective, 'native')) throw forbidden('HDHomeRun encoded profiles cannot execute.');
        const mediaSource = createMediaSource(info, channel, effective);
        if (mediaSource.Id !== options.source.mediaSource.Id) throw new TypeError('The HDHomeRun source selection changed.');
        if (channel[legacy]) throw forbidden('Legacy HDHomeRun UDP execution requires an excluded recording/copy path.');
        if (blank(channel.Path)) throw error('An invalid request URI was provided.');
        mediaSource.Protocol = 'Http'; mediaSource.Path = channel.Path;
        const source = validateNativeLiveTvSource({ mode: 'native', profile: 'native', mediaSource }); signal.throwIfAborted();
        const input = new NativeHttpInput(upstream => this.#request(mediaSource.Path, upstream), value => this.#inputs.delete(value), { primeFirstBytes: true });
        input.tunerHostId = info.Id;
        this.#inputs.add(input); return await this.#owned(input, source, signal);
      } catch (cause) { if (cause.code === 'not-supported') throw cause; this.#report(cause); }
      throw conflict();
    });
  }
  validate(info, options) {
    return this.#run(options, async (_configuration, signal) => {
      this.#model.clear();
      try { const model = await this.#modelInfo(info, true, signal); if (model === null) throw nullReference(); info.DeviceId = model.DeviceID; }
      catch (cause) { if (cause.code !== 'http-error' || cause.httpStatus !== 404) throw cause; }
    }, false);
  }
  discoverDevices(duration, options) {
    return this.#run(options, (_configuration, signal) => {
      this.#model.clear();
      return discoverDevices(duration, { signal, getDevice: async (url, signal) => defaultTuner(url, await this.#modelInfo({ Id: null, Url: url }, false, signal)),
        onError: cause => this.#report(cause), createSocket: this.createSocket, address: this.discoveryAddress, port: this.discoveryPort });
    }, false);
  }
  close() {
    if (this.#closing) return this.#closing; this.#closed = true; this.#lifetime.abort();
    return this.#closing = (async () => {
      const resources = await Promise.allSettled([...this.#inputs].map(input => input.close()));
      while (this.#work.size) await Promise.allSettled([...this.#work]);
      this.#model.clear(); this.#channels.clear();
      const failures = resources.filter(value => value.status === 'rejected').map(value => value.reason);
      if (failures.length) throw new AggregateError(failures, 'HDHomeRun inputs failed to close.');
    })();
  }
}
