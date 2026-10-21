import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { md5Guid } from '../core/identity.js';
import { ordinalIgnoreCaseEquals, ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { guid, libraryError } from '../library/records.js';
import { normalizeLiveTvMediaSource } from '../library/live-tv-media-sources.js';
import { addLiveMediaInfo } from './live-stream-probe.js';
import { BinaryResult } from '../http/binary-result.js';
import { cloneNativeValue } from '../core/json.js';

const providerId = md5Guid('Jellyfin.LiveTv.LiveTvMediaSourceProvider');
const serviceId = md5Guid('Jellyfin.LiveTv.DefaultLiveTvService');
const key = ordinalIgnoreCaseKey;

/** Public MediaSourceManager registry. Public opens own tuner leases; byte
 * readers only retain those inputs, and do not change the public close count. */
export class LiveStreamsService {
  #entries = new Map();
  #unique = new Map();
  #retired = new Set();
  #lifetime = new AbortController();
  #work = new Set();
  #tail = Promise.resolve();
  #closing;
  constructor({ tuners, library, probe, getLocalApiUrl, onError = () => {} } = {}) {
    if (typeof tuners?.getChannelStream !== 'function' || typeof library?.itemCreation?.getItemById !== 'function'
      || typeof probe?.addMediaInfo !== 'function' || typeof getLocalApiUrl !== 'function') throw new TypeError('Public live streams require typed library, original tuners and probing.');
    Object.assign(this, { tuners, library, probe, getLocalApiUrl, onError });
  }
  #track(work) { this.#work.add(work); const done = () => this.#work.delete(work); work.then(done, done); return work; }
  #serial(operation) { const pending = this.#tail.then(operation); this.#tail = pending.catch(() => {}); return pending; }
  #admit(operation) {
    if (this.#lifetime.signal.aborted) return Promise.reject(libraryError(503, 'Live streams are closing.'));
    return this.#track(Promise.resolve().then(operation));
  }
  #report(error) { try { void Promise.resolve(this.onError(error)).catch(() => {}); } catch { /* Diagnostics preserve native fallback. */ } }
  snapshot() { return [...this.#entries.values()].map(entry => ({ LiveStreamId: entry.source.LiveStreamId, UniqueId: entry.uniqueId,
    ConsumerCount: entry.owners.length, TunerHostId: entry.owners.at(-1)?.lease.tunerHostId ?? null, ReaderCount: entry.readers.size })); }
  getLiveStream(id) {
    if (typeof id !== 'string' || !id) throw libraryError(400, 'Live stream id cannot be empty.');
    const entry = this.#entries.get(key(id)); return entry ? cloneNativeValue(entry.source) : null;
  }

  open(request, { signal } = {}) {
    return this.#admit(async () => {
      signal?.throwIfAborted();
      const lifetime = new AbortController(), combined = AbortSignal.any([lifetime.signal, this.#lifetime.signal]);
      let registered = false, entry, owner;
      const cancel = () => { if (!registered) lifetime.abort(signal.reason); }; signal?.addEventListener('abort', cancel, { once: true });
      try {
        ({ entry, owner } = await this.#serial(async () => {
          combined.throwIfAborted();
          if (typeof request.OpenToken !== 'string' || !request.OpenToken) throw libraryError(400, 'Open token cannot be empty.');
          const prefixEnd = request.OpenToken.indexOf('_');
          if (prefixEnd < 0 || !ordinalIgnoreCaseEquals(request.OpenToken.slice(0, prefixEnd), providerId)) throw libraryError(500, 'The media source provider is unavailable.');
          const token = request.OpenToken.slice(prefixEnd + 1), first = token.indexOf('_'), second = token.indexOf('_', first + 1);
          if (first < 0) throw libraryError(500, 'The live stream opening token has no channel.');
          const channelId = second < 0 ? token.slice(first + 1) : token.slice(first + 1, second);
          let originalStreamId = second < 0 ? null : token.slice(second + 1);
          if (ordinalIgnoreCaseEquals(channelId, originalStreamId ?? '')) originalStreamId = null;
          const channel = await this.library.itemCreation.getItemById(guid(channelId));
          if (channel?.Type !== 'LiveTvChannel') throw libraryError(500, 'The requested item is not a live TV channel.');
          if (!ordinalIgnoreCaseEquals(channel.ServiceName, this.tuners.name)) throw libraryError(500, 'Sequence contains no matching element.');
          const candidates = await this.tuners.getChannelStreamMediaSources(channel.ExternalId, { signal: combined });
          const selected = candidates.find(source => ordinalIgnoreCaseEquals(source.mediaSource.Id, originalStreamId ?? '')) ?? candidates[0];
          if (!selected) throw libraryError(500, 'The channel has no original media source.');
          const lease = await this.tuners.getChannelStream(channel.ExternalId, originalStreamId, { source: selected,
            currentLiveStreams: [...this.#entries.values()].map(value => value.owners.at(-1).lease), signal: combined });
          if (combined.aborted) { await lease.close(); combined.throwIfAborted(); }
          let source;
          try { source = normalizeLiveTvMediaSource(structuredClone(lease.mediaSource), channel.ChannelType === 'TV'); }
          catch (error) { await lease.close(); throw error; }
          source.RequiresClosing = true; source.LiveStreamId = providerId + '_' + serviceId + '_' + source.Id;
          if (source.SupportsDirectStream) source.SupportsDirectStream = source.Protocol === 'File'
            || source.Protocol === 'Http' && source.Path != null && !source.Path.toLowerCase().includes('.m3u');
          // This server admits the original source only. No encoded execution
          // or server remux URL is published by a live stream.
          source.SupportsTranscoding = false; delete source.TranscodingUrl; delete source.TranscodingContainer;
          const identity = key(source.LiveStreamId);
          let current = this.#entries.get(identity);
          if (current && (!lease.sharing || current.owners.at(-1).lease.sharing !== lease.sharing)) {
            // Native replaces the dictionary value for a fresh input with the
            // same source Id. Keep its invisible ownership solely for shutdown.
            this.#retired.add(current); this.#unique.delete(key(current.uniqueId)); current = null;
          }
          if (!current) {
            current = { identity, uniqueId: randomUUID().replaceAll('-', ''), source, owners: [], readers: new Set(), probes: new Set(), lifetime: new AbortController() };
            this.#entries.set(identity, current); this.#unique.set(key(current.uniqueId), current);
          }
          if (lease.stream) { source.Protocol = 'Http'; source.Path = this.getLocalApiUrl().replace(/\/$/u, '') + '/LiveTv/LiveStreamFiles/' + current.uniqueId + '/stream.ts'; }
          current.source = source;
          const opened = { lease, lifetime }; current.owners.push(opened);
          registered = true; signal?.removeEventListener('abort', cancel);
          return { entry: current, owner: opened };
        }));
        const ownedLifetime = AbortSignal.any([combined, entry.lifetime.signal]);
        const combinedProbe = signal ? AbortSignal.any([ownedLifetime, signal]) : ownedLifetime;
        const probing = Promise.resolve().then(() => this.probe.addMediaInfo(entry.source, { cacheKey: request.OpenToken, signal: combinedProbe,
          ...(owner.lease.stream ? { openRead: options => this.#read(entry, options) } : {}) }));
        entry.probes.add(probing); const finished = () => entry.probes.delete(probing); probing.then(finished, finished);
        try { await probing; }
        catch (error) { if (!ownedLifetime.aborted) { this.#report(error); addLiveMediaInfo(entry.source); } else throw error; }
        ownedLifetime.throwIfAborted();
        return { MediaSource: cloneNativeValue(entry.source) };
      } catch (error) {
        // MediaSourceManager registers before probing/cloning. A later native
        // failure leaves that public ownership registered for explicit Close.
        // Shutdown and a revoked last public owner still drain immediately.
        if (!registered || combined.aborted || entry?.lifetime.signal.aborted) {
          lifetime.abort();
          if (entry && owner) await this.#serial(() => this.#release(entry, owner));
        }
        throw error;
      } finally { signal?.removeEventListener('abort', cancel); }
    });
  }

  #read(entry, { signal } = {}) {
    return this.#admit(async () => {
      const combined = AbortSignal.any([this.#lifetime.signal, entry.lifetime.signal, ...(signal ? [signal] : [])]);
      combined.throwIfAborted();
      const owner = entry.owners.at(-1); if (!owner) throw libraryError(404, 'Live stream not found.');
      const lease = await owner.lease.forkRead({ signal: combined });
      if (combined.aborted) { await lease.close(); combined.throwIfAborted(); }
      const state = { close: null }; let closing;
      const close = () => closing ??= this.#track(Promise.resolve().then(async () => {
        try { await lease.close(); } finally { entry.readers.delete(state); }
      }));
      state.close = close; entry.readers.add(state);
      return Object.freeze({ ...(lease.stream ? { stream: lease.stream } : {}), close });
    });
  }

  async #release(entry, owner) {
    const index = entry.owners.indexOf(owner); if (index < 0) return;
    entry.owners.splice(index, 1);
    const last = entry.owners.length === 0;
    if (last) {
      if (this.#entries.get(entry.identity) === entry) this.#entries.delete(entry.identity);
      this.#unique.delete(key(entry.uniqueId)); this.#retired.delete(entry); entry.lifetime.abort();
    }
    const tasks = [owner.lease.close(), ...(last ? [...entry.readers].map(reader => reader.close()) : [])];
    const results = await Promise.allSettled(tasks);
    if (last) await Promise.allSettled([...entry.probes]);
    owner.lifetime.abort();
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Live stream ownership failed to close.');
  }
  closeLiveStream(id) {
    return this.#admit(() => this.#serial(async () => {
      if (typeof id !== 'string' || !id) throw libraryError(400, 'Live stream id cannot be empty.');
      const entry = this.#entries.get(key(id)); if (entry) await this.#release(entry, entry.owners.at(-1));
    }));
  }

  streamFile(uniqueId, contentType) {
    const entry = this.#unique.get(key(uniqueId)); if (!entry) throw libraryError(404, 'Live stream not found.');
    return new BinaryResult(async (request, response) => {
      const lifetime = new AbortController(), signal = AbortSignal.any([lifetime.signal, entry.lifetime.signal]);
      let reader;
      const aborted = () => { lifetime.abort(); void Promise.resolve(reader?.close()).catch(() => {}); };
      request.once('aborted', aborted); response.once('close', aborted);
      try {
        reader = await this.#read(entry, { signal }); signal.throwIfAborted();
        if (!reader.stream) throw libraryError(404, 'The original tuner reservation has no retained byte stream.');
        response.setHeader('Content-Type', contentType);
        if (request.method === 'HEAD') { response.end(); return; }
        for await (const bytes of reader.stream) {
          signal.throwIfAborted(); if (!response.write(bytes)) await once(response, 'drain', { signal });
        }
        response.end();
      } catch (error) { if (response.headersSent || signal.aborted) response.destroy(); else throw error; }
      finally { request.removeListener('aborted', aborted); response.removeListener('close', aborted); await reader?.close(); }
    });
  }

  close() {
    this.#lifetime.abort();
    return this.#closing ??= (async () => {
      const failures = [];
      await this.#serial(async () => {
        for (const entry of [...this.#entries.values(), ...this.#retired]) for (const owner of [...entry.owners]) {
          try { await this.#release(entry, owner); } catch (error) { failures.push(error); }
        }
      });
      while (this.#work.size) await Promise.allSettled([...this.#work]);
      if (failures.length) throw new AggregateError(failures, 'Live streams failed to drain.');
    })();
  }
}
