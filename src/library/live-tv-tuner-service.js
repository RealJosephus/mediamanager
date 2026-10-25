import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { libraryError } from './records.js';
import { validateNativeLiveTvSource } from '../plugins/live-tv-contract.js';

const unimplemented = () => Object.assign(libraryError(500, 'The method or operation is not implemented.'), { code: 'not-implemented' });

/** Retained default-service readers and owned original-stream consumers. */
export class LiveTvTunerService {
  #lifetime = new AbortController();
  #work = new Set();
  #closing;
  #streams = [];
  #owned = new WeakMap();
  #streamTail = Promise.resolve();
  #closeFailures = [];

  constructor({ plugins, sources, onError = () => {} } = {}) {
    if (typeof plugins?.entries !== 'function' || typeof sources?.addProviderMetadata !== 'function'
      || typeof sources?.getPrograms !== 'function') throw new TypeError('Live TV tuners require providers and listings management.');
    Object.assign(this, { plugins, sources, onError, name: 'Emby' });
  }

  #tuners() { return this.plugins.entries('tuner').filter(provider => provider.isSupported !== false); }
  #report(cause) { try { void Promise.resolve(this.onError(cause)).catch(() => {}); } catch { /* Provider diagnostics do not replace their result. */ } }
  #run(signal, operation) {
    if (this.#lifetime.signal.aborted) return Promise.reject(libraryError(503, 'Live TV tuners are closing.'));
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    const pending = Promise.resolve().then(() => operation(combined));
    return this.#track(pending);
  }
  #track(pending) {
    this.#work.add(pending);
    const finished = () => this.#work.delete(pending); pending.then(finished, finished);
    return pending;
  }
  #streamOperation(operation) {
    const pending = this.#streamTail.then(operation); this.#streamTail = pending.catch(() => {}); return pending;
  }

  async #channels(enableCache, signal) {
    const channels = [];
    for (const tuner of this.#tuners()) {
      try { channels.push(...await tuner.getChannels(enableCache, { signal })); }
      catch (cause) { this.#report(cause); }
    }
    await this.sources.addProviderMetadata(channels, { enableCache, signal });
    return channels;
  }

  getChannels({ enableCache = false, signal } = {}) {
    return this.#run(signal, combined => this.#channels(enableCache, combined));
  }

  getPrograms(channelId, startDateUtc, endDateUtc, { signal } = {}) {
    return this.#run(signal, async combined => {
      const channels = await this.#channels(true, combined);
      const channel = channels.find(value => value.Id == null || channelId == null
        ? value.Id == null && channelId == null : ordinalIgnoreCaseEquals(value.Id, channelId));
      if (!channel) throw libraryError(500, 'Sequence contains no matching element.');
      return this.sources.getPrograms(channel, startDateUtc, endDateUtc, { signal: combined });
    });
  }

  getChannelStreamMediaSources(channelId, { signal } = {}) {
    return this.#run(signal, async combined => {
      if (channelId == null || clrTrim(channelId) === '') throw libraryError(400, "Value cannot be null. (Parameter 'channelId')");
      for (const tuner of this.#tuners()) {
        try {
          const sources = await tuner.getChannelStreamMediaSources(channelId, { signal: combined });
          if (sources.length) return sources;
        } catch (cause) { if (cause.code !== 'not-implemented') throw cause; }
      }
      throw unimplemented();
    });
  }

  #snapshots(groups) {
    return groups.map(group => ({ OriginalStreamId: group.originalStreamId, ConsumerCount: group.leases.size,
      TunerHostId: group.tunerHostId,
      EnableStreamSharing: !this.#lifetime.signal.aborted && group.leases.size > 0 && group.input?.enabled === true,
      MediaSource: structuredClone(group.source) }));
  }
  getLiveStreams() { return this.#snapshots(this.#streams); }

  #visibleGroups(consumers) {
    if (!Array.isArray(consumers)) throw new TypeError('Opening a tuner requires the current visible owned live streams.');
    const groups = [];
    for (const consumer of consumers) {
      const owned = consumer != null && this.#owned.get(consumer);
      if (!owned || owned.state.closed) throw new TypeError('A visible live stream must be an active consumer owned by this tuner service.');
      if (!groups.includes(owned.group)) groups.push(owned.group);
    }
    return groups;
  }

  async #rejectLease(lease, cause) {
    try { await lease.close(); } catch (cleanup) {
      this.#closeFailures.push(cleanup); throw new AggregateError([cause, cleanup], 'A rejected original stream failed to close.');
    }
    throw cause;
  }

  #ownLease(lease, group, signal) {
    if (group.readLifetime.signal.aborted) group.readLifetime = new AbortController();
    const state = { closed: false }; group.leases.add(state);
    const aborted = () => { void close().catch(() => {}); };
    let closing;
    const close = () => {
      if (closing) return closing;
      state.closed = true; signal.removeEventListener('abort', aborted);
      // A byte reader is a hold on this input, not another public consumer.
      // Revoke those holds immediately when the last public consumer closes,
      // even when a pending provider retain is ahead of registry cleanup.
      if ([...group.leases].every(consumer => consumer.closed)) group.readLifetime.abort();
      // Start releasing bytes immediately, while serializing registry changes
      // with subsequent opens like the native media-source manager's locker.
      const released = Promise.resolve().then(() => lease.close()); void released.catch(() => {});
      return closing = this.#track(this.#streamOperation(async () => {
        group.leases.delete(state);
        if (!group.leases.size) {
          const index = this.#streams.indexOf(group); if (index >= 0) this.#streams.splice(index, 1);
        }
        const readers = !group.leases.size ? [...group.readers].map(reader => reader.close()) : [];
        const results = await Promise.allSettled([released, ...readers]);
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Original stream ownership failed to drain.');
      }).catch(cause => { this.#closeFailures.push(cause); throw cause; }));
    };
    state.close = close;
    const iterator = lease.stream?.[Symbol.asyncIterator]();
    const available = () => { if (state.closed || this.#lifetime.signal.aborted) throw libraryError(503, 'The original stream consumer is closed.'); signal.throwIfAborted(); };
    const stream = iterator && { [Symbol.asyncIterator]() { return this; }, next: (...args) => this.#track(Promise.resolve().then(() => {
      available(); return iterator.next(...args);
    }).then(async value => { available(); if (value.done) await close(); return value; }).catch(async cause => { await close(); throw cause; })),
    return: value => close().then(() => ({ done: true, value })) };
    signal.addEventListener('abort', aborted, { once: true });
    const consumer = Object.freeze({ mode: 'native', ...(lease.profile === undefined ? {} : { profile: lease.profile }),
      tunerHostId: group.tunerHostId,
      originalStreamId: group.originalStreamId, mediaSource: structuredClone(lease.mediaSource), ...(stream ? { stream } : {}),
      ...(group.sharing ? { sharing: group.sharing } : {}), forkRead: options => this.#forkRead(group, options), close });
    this.#owned.set(consumer, { group, state }); return consumer;
  }

  async #retain(group, signal) {
    signal.throwIfAborted();
    if (!group.leases.size || group.input?.enabled !== true) throw libraryError(503, 'The original stream input is unavailable.');
    const lease = await group.input.retain({ signal });
    if (signal.aborted || this.#lifetime.signal.aborted) return this.#rejectLease(lease, signal.reason ?? libraryError(503, 'Live TV tuners are closing.'));
    if (lease.mediaSource.Id !== group.source.Id || lease.tunerHostId !== group.tunerHostId) {
      return this.#rejectLease(lease, new TypeError('A retained original stream changed its source or tuner host.'));
    }
    return this.#ownLease(lease, group, signal);
  }

  #forkRead(group, { signal } = {}) {
    return this.#run(signal, request => {
      const combined = AbortSignal.any([request, group.readLifetime.signal]);
      return (async () => {
        combined.throwIfAborted();
        if (![...group.leases].some(lease => !lease.closed) || group.input?.enabled !== true) {
          throw libraryError(503, 'The original stream input is unavailable.');
        }
        const lease = await group.input.retain({ signal: combined });
        if (combined.aborted) return this.#rejectLease(lease, combined.reason);
        if (lease.mediaSource.Id !== group.source.Id || lease.tunerHostId !== group.tunerHostId) {
          return this.#rejectLease(lease, new TypeError('An original stream reader changed its source or tuner host.'));
        }
        const state = { close: null };
        let closing;
        const aborted = () => { void close().catch(() => {}); };
        const close = () => closing ??= this.#track(Promise.resolve().then(async () => {
          combined.removeEventListener('abort', aborted);
          try { await lease.close(); } finally { group.readers.delete(state); }
        }).catch(error => { this.#closeFailures.push(error); throw error; }));
        state.close = close; group.readers.add(state);
        const iterator = lease.stream?.[Symbol.asyncIterator]();
        const stream = iterator && { [Symbol.asyncIterator]() { return this; },
          next: (...args) => this.#track(Promise.resolve().then(() => {
            combined.throwIfAborted(); if (closing) throw libraryError(503, 'The original stream reader is closed.');
            return iterator.next(...args);
          }).then(async value => { if (value.done) await close(); return value; }).catch(async error => { await close(); throw error; })),
          return: value => close().then(() => ({ done: true, value })),
        };
        combined.addEventListener('abort', aborted, { once: true });
        if (combined.aborted) { await close(); combined.throwIfAborted(); }
        return Object.freeze({ mode: 'native', tunerHostId: group.tunerHostId, mediaSource: structuredClone(lease.mediaSource),
          ...(stream ? { stream } : {}), close });
      })();
    });
  }

  getChannelStream(channelId, originalStreamId, { source, currentLiveStreams, signal } = {}) {
    const visible = currentLiveStreams?.slice();
    return this.#run(signal, combined => this.#streamOperation(async () => {
      combined.throwIfAborted(); validateNativeLiveTvSource(source);
      const groups = this.#visibleGroups(visible);
      const existing = originalStreamId == null || originalStreamId === '' ? null
        : groups.find(group => group.originalStreamId != null && ordinalIgnoreCaseEquals(group.originalStreamId, originalStreamId));
      // Only the first matching original identity is considered for reuse.
      if (existing?.input?.enabled === true) return this.#retain(existing, combined);
      for (const tuner of this.#tuners()) {
        let lease;
        try { lease = await tuner.getChannelStream(channelId, originalStreamId, this.#snapshots(groups), { source, signal: combined }); }
        catch (cause) {
          combined.throwIfAborted();
          if (cause.code === 'ENOENT' || cause.code === 'ABORT_ERR' || cause.name === 'AbortError') continue;
          throw cause;
        }
        if (combined.aborted || this.#lifetime.signal.aborted) return this.#rejectLease(lease, combined.reason ?? libraryError(503, 'Live TV tuners are closing.'));
        const group = { originalStreamId, tunerHostId: lease.tunerHostId, input: lease.sharing, source: structuredClone(lease.mediaSource),
          leases: new Set(), readers: new Set(), readLifetime: new AbortController() };
        const consumer = this;
        if (group.input) group.sharing = Object.freeze({ get enabled() { return !consumer.#lifetime.signal.aborted && group.leases.size > 0 && group.input.enabled; },
          retain: options => this.#run(options?.signal, request => this.#streamOperation(() => this.#retain(group, request))) });
        this.#streams.push(group); return this.#ownLease(lease, group, combined);
      }
      throw libraryError(404, 'Tuner not found.');
    }));
  }

  close() {
    this.#lifetime.abort();
    return this.#closing ??= (async () => {
      while (this.#work.size) await Promise.allSettled([...this.#work]);
      if (this.#closeFailures.length) throw new AggregateError(this.#closeFailures, 'Original stream consumers failed to close.');
    })();
  }
}
