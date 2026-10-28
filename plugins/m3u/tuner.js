import path from 'node:path';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { md5Guid } from '@mediamanager/plugin-sdk/core/identity';
import { validateNativeLiveTvSource } from '@mediamanager/plugin-sdk/live-tv/contract';
import { ordinalIgnoreCaseEquals } from '@mediamanager/plugin-sdk/storage/ordinal-comparer';
import { decodeM3u, parseM3uText } from './parser.js';
import { createMediaSource } from './source.js';
import { NativeHttpInput, NativeReservationInput } from '@mediamanager/plugin-sdk/live-tv/raw-input';

// Channel ordering/cache behavior follows the designated Jellyfin
// BaseTunerHost.cs and M3UTunerHost.cs (GPL-2.0-only).

const unavailable = () => Object.assign(new Error('The M3U tuner is unavailable.'), { status: 503 });
const conflict = () => Object.assign(new Error('Unable to find host to play channel.'), { status: 409 });
const ioError = error => ['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(error.code);
const equals = (left, right) => left == null || right == null ? left == null && right == null : ordinalIgnoreCaseEquals(left, right);
const channelPrefix = info => 'm3u_' + md5Guid(info.Url);

export class M3uTuner {
  type = 'm3u'; name = 'M3U Tuner'; isSupported = true;
  #memory = new Map(); #operations = new Set(); #hubs = new Set();
  #controller = new AbortController(); #closed = false; #closing;
  #cacheWrites = new Set(); #pathOptions;
  constructor(pathOptions = {}) {
    this.#pathOptions = pathOptions;
    const { fetch = globalThis.fetch, logger = { error() {}, warn() {} }, isLocalNetwork } = pathOptions;
    Object.assign(this, { fetch, logger, networkOverride: isLocalNetwork });
  }
  get cachePath() { return this.#pathOptions.cachePath; }
  connect({ liveTv, fileSystem, users } = {}) {
    if (this.#closed) throw unavailable();
    if (typeof liveTv?.admitRead !== 'function' || typeof fileSystem?.openRead !== 'function') throw new TypeError('M3U requires admitted configuration and mapped storage.');
    Object.assign(this, { liveTv, fileSystem, users });
  }
  #run(options, operation, configuration = true) {
    if (this.#closed || !this.fileSystem || !this.liveTv) throw unavailable();
    const signal = options?.signal ? AbortSignal.any([options.signal, this.#controller.signal]) : this.#controller.signal;
    signal.throwIfAborted();
    const access = configuration ? this.liveTv.admitRead() : null;
    const work = Promise.resolve().then(async () => operation(configuration ? await access.getConfiguration() : null, signal))
      .finally(() => access?.release());
    this.#operations.add(work); void work.finally(() => this.#operations.delete(work)).catch(() => {}); return work;
  }
  #report(error) { try { this.logger.error(error); } catch { /* Diagnostics cannot replace a source result. */ } }
  #cacheFile(info) {
    const cachePath = this.cachePath;
    if (!path.isAbsolute(cachePath ?? '')) throw new TypeError('M3U channel cache requires an absolute mapped cache root.');
    if (info.Id != null && /[\\/:\0]/u.test(info.Id)) throw new TypeError('A tuner cache identity must be a single file-name component.');
    return path.join(cachePath, (info.Id ?? '') + '_channels');
  }
  async #listing(info, signal) {
    if (!info || typeof info.Url !== 'string') throw new TypeError('A tuner URL is required.');
    if (/^http/iu.test(info.Url)) {
      const response = await this.fetch(info.Url, { signal, headers: info.UserAgent ? { 'User-Agent': info.UserAgent } : {} });
      if (!response.ok) { await response.body?.cancel(); throw new Error('The M3U source returned HTTP ' + response.status + '.'); }
      return { stream: response.body ?? [], close: async () => { try { await response.body?.cancel(); } catch (error) { if (error.code !== 'ERR_INVALID_STATE') throw error; } } };
    }
    return this.fileSystem.openRead(info.Url, { signal });
  }
  async #channels(info, enableCache, signal) {
    if (enableCache && info.Id && this.#memory.has(info.Id)) return this.#memory.get(info.Id);
    const source = await this.#listing(info, signal); let channels;
    try { channels = parseM3uText(await decodeM3u(source.stream, { signal }), { channelIdPrefix: channelPrefix(info), tunerHostId: info.Id }); }
    finally { await source.close(); }
    if (info.Id && channels.length) this.#memory.set(info.Id, channels);
    return channels;
  }
  async #writeCache(filename, channels, signal) {
    if (this.#cacheWrites.has(filename)) throw Object.assign(new Error('The tuner cache is in use.'), { code: 'EBUSY' });
    this.#cacheWrites.add(filename); let file;
    try {
      signal.throwIfAborted();
      await this.fileSystem.mkdir(path.dirname(filename), { recursive: true });
      try { file = await this.fileSystem.open(filename, 'r+'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; file = await this.fileSystem.open(filename, 'wx'); }
      // Native AsyncFile.OpenWrite uses OpenOrCreate, preserving an old suffix
      // when a shorter JSON list overwrites the beginning of an existing file.
      signal.throwIfAborted();
      await file.writeFile(JSON.stringify(channels.map(channel => ({ ...channel, ChannelType: 0 }))));
    } finally { try { await file?.close(); } finally { this.#cacheWrites.delete(filename); } }
  }
  getChannels(enableCache, options) {
    return this.#run(options, async (configuration, signal) => {
      const result = [];
      for (const info of configuration.TunerHosts.filter(info => equals(info.Type, this.type))) {
        const filename = this.#cacheFile(info);
        try {
          const channels = await this.#channels(info, enableCache, signal);
          // Native deduplicates against earlier hosts, not inside this batch.
          const fresh = channels.filter(channel => !result.some(value => equals(value.Id, channel.Id))); result.push(...fresh);
          if (!enableCache) try {
            await this.#writeCache(filename, channels, signal);
          } catch (error) { if (!ioError(error) && !['EBUSY', 'EEXIST'].includes(error.code)) throw error; }
        } catch (error) {
          signal.throwIfAborted(); this.#report(error);
          if (enableCache) try {
            const cache = JSON.parse(await this.fileSystem.readFile(filename, { encoding: 'utf8', signal }));
            if (!Array.isArray(cache)) throw new TypeError('A tuner channel cache must be an array.');
            result.push(...cache.map(channel => ({ ...channel, ChannelType: channel.ChannelType === 0 ? 'TV' : channel.ChannelType === 1 ? 'Radio' : channel.ChannelType })));
          } catch (fallback) { if (!ioError(fallback)) throw fallback; }
        }
      }
      return result;
    });
  }
  async #local(hostname) {
    if (this.networkOverride) return this.networkOverride(hostname);
    if (hostname.toLowerCase() === 'localhost') return true;
    const host = hostname.replace(/^\[|\]$/gu, '');
    if (isIP(host)) return this.users?.isLocalNetwork(host) ?? false;
    try { return (await lookup(host, { all: true })).some(address => this.users?.isLocalNetwork(address.address)); }
    catch { return false; }
  }
  async #find(configuration, channelId, signal, first = false) {
    if (typeof channelId !== 'string' || !channelId) throw new TypeError('A channel identity is required.');
    if (!/^m3u_/iu.test(channelId)) return [];
    const matches = [];
    for (const info of configuration.TunerHosts.filter(info => equals(info.Type, this.type))) try {
      const channel = (await this.#channels(info, true, signal)).find(channel => equals(channel.Id, channelId));
      if (channel) { matches.push({ info, channel }); if (first) return matches; }
    } catch (error) { signal.throwIfAborted(); this.#report(error); }
    return matches;
  }
  getChannelStreamMediaSources(channelId, options) {
    return this.#run(options, async (configuration, signal) => {
      const [match] = await this.#find(configuration, channelId, signal, true);
      return match ? [{ mode: 'native', mediaSource: await createMediaSource(match.info, match.channel, { isLocalNetwork: host => this.#local(host) }) }] : [];
    });
  }
  async #ownedInput(input, source, signal) {
    if (!input.sharing) {
      const tuner = this;
      input.sharing = Object.freeze({
        get enabled() { return !tuner.#closed && input.enabled; },
        retain(options) { return tuner.#run(options, (_configuration, combined) => tuner.#ownedInput(input, source, combined), false); },
      });
    }
    return { ...source, tunerHostId: input.tunerHostId ?? null, ...await input.acquire(signal), sharing: input.sharing };
  }
  getChannelStream(channelId, streamId, currentLiveStreams, options) {
    return this.#run(options, async (configuration, signal) => {
      if (typeof channelId !== 'string' || !channelId) throw new TypeError('A channel identity is required.');
      if (!/^m3u_/iu.test(channelId)) throw Object.assign(new Error('The M3U channel was not found.'), { code: 'ENOENT', status: 404 });
      for (const { info, channel } of await this.#find(configuration, channelId, signal)) try {
        const mediaSource = await createMediaSource(info, channel, { isLocalNetwork: host => this.#local(host) });
        const source = validateNativeLiveTvSource({ mode: 'native', mediaSource });
        signal.throwIfAborted();
        validateNativeLiveTvSource(options?.source);
        if (options.source.mediaSource.Id !== mediaSource.Id) throw new TypeError('The M3U source selection changed.');
        const checkLimit = () => {
          const suppliedCount = currentLiveStreams.filter(value => equals(value.tunerHostId ?? value.TunerHostId, info.Id)).length;
          if (info.TunerCount > 0 && suppliedCount >= info.TunerCount) throw conflict();
        };
        checkLimit();
        let nativeSharedHttpStream = false;
        if (mediaSource.Protocol === 'Http' && info.AllowStreamSharing && !info.EnableStreamLooping) {
          const extension = path.extname(new URL(mediaSource.Path).pathname).toLowerCase();
          nativeSharedHttpStream = ['.ts', '.tsv', '.m2t'].includes(extension);
          if (!extension) try {
            const head = await this.fetch(mediaSource.Path, { method: 'HEAD', signal });
            nativeSharedHttpStream = head.ok && head.headers.get('content-type')?.split(';')[0].toLowerCase() === 'video/mp2t'; await head.body?.cancel();
          } catch (error) { signal.throwIfAborted(); this.#report(error); }
        }
        if (!nativeSharedHttpStream) {
          // Native LiveStream.Open reserves/describes its source. It does not
          // open HTTP, manifest, looped, RTSP, RTP or UDP network bytes.
          const reservation = new NativeReservationInput(input => this.#hubs.delete(input));
          reservation.tunerHostId = info.Id; this.#hubs.add(reservation);
          return await this.#ownedInput(reservation, source, signal);
        }
        signal.throwIfAborted();
        // Fresh provider opens are independent. DefaultLiveTvService decides
        // reuse by its ordered OriginalStreamId registry; retain owns a new
        // consumer of precisely this input without reopening its upstream.
        const input = new NativeHttpInput(async upstreamSignal => {
          const response = await this.fetch(mediaSource.Path, { signal: upstreamSignal, headers: mediaSource.RequiredHttpHeaders });
          return response;
        }, input => this.#hubs.delete(input), { primeFirstBytes: true });
        input.tunerHostId = info.Id; this.#hubs.add(input);
        return await this.#ownedInput(input, source, signal);
      } catch (error) { signal.throwIfAborted(); this.#report(error); }
      throw conflict();
    });
  }
  validate(info, options) { return this.#run(options, async (_configuration, signal) => { const source = await this.#listing(info, signal); await source.close(); }, false); }
  discoverDevices(_duration, options) { return this.#run(options, () => [], false); }
  close() {
    if (this.#closing) return this.#closing; this.#closed = true; this.#controller.abort();
    return this.#closing = (async () => {
      const results = await Promise.allSettled([...this.#hubs].map(hub => hub.close()));
      while (this.#operations.size) await Promise.allSettled([...this.#operations]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'M3U resources failed to close.');
    })();
  }
}
