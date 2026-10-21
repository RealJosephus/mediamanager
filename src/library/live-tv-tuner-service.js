import { clrTrim } from '../metadata/whitespace.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { libraryError } from './records.js';

const nativeError = (type, message, status = 500) => Object.assign(libraryError(status, message), { nativeException: type });
const kind = cause => cause?.nativeException ?? cause?.name;

/** The retained DefaultLiveTvService channel/listings readers. Raw stream
 * sharing requires the separately owned core lease consumer. */
export class LiveTvTunerService {
  #lifetime = new AbortController();
  #work = new Set();
  #closing;

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
    this.#work.add(pending);
    const finished = () => this.#work.delete(pending); pending.then(finished, finished);
    return pending;
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
      if (!channel) throw nativeError('InvalidOperationException', 'Sequence contains no matching element.');
      return this.sources.getPrograms(channel, startDateUtc, endDateUtc, { signal: combined });
    });
  }

  getChannelStreamMediaSources(channelId, { signal } = {}) {
    return this.#run(signal, async combined => {
      if (channelId == null || clrTrim(channelId) === '') throw nativeError('ArgumentNullException', "Value cannot be null. (Parameter 'channelId')", 400);
      for (const tuner of this.#tuners()) {
        try {
          const sources = await tuner.getChannelStreamMediaSources(channelId, { signal: combined });
          if (sources.length) return sources;
        } catch (cause) { if (kind(cause) !== 'NotImplementedException') throw cause; }
      }
      throw nativeError('NotImplementedException', 'The method or operation is not implemented.');
    });
  }

  close() {
    this.#lifetime.abort();
    return this.#closing ??= (async () => { while (this.#work.size) await Promise.allSettled([...this.#work]); })();
  }
}
