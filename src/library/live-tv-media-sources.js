import { md5Guid } from '../core/identity.js';
import { idKey, libraryError } from './records.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { projectLiveStream } from './media-streams.js';

const prefix = md5Guid('Jellyfin.LiveTv.LiveTvMediaSourceProvider') + '_';
const stream = (Type, IsInterlaced = false) => ({ Type, Index: -1, IsInterlaced, IsDefault: false,
  IsForced: false, IsHearingImpaired: false, IsOriginal: false, IsExternal: false, SupportsExternalStream: false });

export function inferLiveTvBitrate(source) {
  if (source.Bitrate != null || source.MediaStreams == null) return;
  const bitrate = source.MediaStreams.reduce((sum, value) => value.IsExternal ? sum : (sum + (value.BitRate ?? 0)) | 0, 0);
  if (bitrate > 0) source.Bitrate = bitrate;
}

export function normalizeLiveTvMediaSource(source, isVideo) {
  source.IsInfiniteStream = true;
  source.TranscodingSubProtocol ??= 'http';
  if (!source.MediaStreams.length) source.MediaStreams = isVideo ? [stream('Video', true), stream('Audio')] : [stream('Audio')];
  for (const stream of source.MediaStreams) for (const name of ['BitRate', 'Channels', 'AverageFrameRate', 'RealFrameRate', 'Width', 'Height', 'SampleRate', 'Level']) {
    if (stream[name] != null && stream[name] <= 0) stream[name] = null;
  }
  if (new Set(source.MediaStreams.map(stream => stream.Index)).size !== source.MediaStreams.length) {
    for (const stream of source.MediaStreams) stream.Index = -1;
  }
  source.MediaStreams = source.MediaStreams.map(projectLiveStream);
  inferLiveTvBitrate(source);
  return source;
}

/** Read-only LiveTvMediaSourceProvider, before the independent open operation. */
export class LiveTvMediaSources {
  #closed = false;
  #closing;
  #work = new Set();
  constructor({ tuners, library, getLocalApiUrl, onError = () => {} } = {}) {
    if (typeof tuners?.getChannelStreamMediaSources !== 'function' || typeof library?.getLiveMediaSources !== 'function'
      || typeof library?.itemCreation?.getItemById !== 'function' || typeof getLocalApiUrl !== 'function' || typeof onError !== 'function') {
      throw new TypeError('Live TV media sources require the default tuner service, typed library and local API address.');
    }
    Object.assign(this, { tuners, library, getLocalApiUrl, onError });
  }

  getMediaSources(item, { signal } = {}) {
    if (this.#closed) return Promise.reject(libraryError(503, 'Live TV media source discovery has closed.'));
    const pending = Promise.resolve().then(async () => {
      if (item.Type !== 'LiveTvChannel' || item.SourceType !== 'LiveTV' || item.Path) return [];
      try {
        let sources, forceOpening = false;
        try {
          if (!ordinalIgnoreCaseEquals(item.ServiceName, this.tuners.name)) throw libraryError(500, 'Sequence contains no matching element.');
          sources = (await this.tuners.getChannelStreamMediaSources(item.ExternalId, { signal })).map(source =>
            normalizeLiveTvMediaSource(structuredClone(source.mediaSource), item.ChannelType === 'TV'));
          if (!sources.length) throw Object.assign(new Error('The method or operation is not implemented.'), { code: 'not-implemented' });
        } catch (error) {
          if (error.code !== 'not-implemented') throw error;
          const live = await this.library.itemCreation.getItemById(item.Id);
          sources = await this.library.getLiveMediaSources(live); forceOpening = true;
        }
        for (const source of sources) {
          source.Type = 'Default'; source.BufferMs ??= 1500;
          if (forceOpening) source.RequiresOpening = true;
          if (source.RequiresOpening) source.OpenToken = item.Type + '_' + idKey(item.Id) + '_' + (source.Id ?? '');
          if (!source.Path && source.Protocol === 'Http') source.Path = this.getLocalApiUrl();
          if (source.OpenToken && !source.OpenToken.toLowerCase().startsWith(prefix)) source.OpenToken = prefix + source.OpenToken;
          if (source.LiveStreamId && !source.LiveStreamId.toLowerCase().startsWith(prefix)) source.LiveStreamId = prefix + source.LiveStreamId;
          inferLiveTvBitrate(source);
        }
        return sources;
      } catch (error) {
        try { void Promise.resolve(this.onError(error)).catch(() => {}); } catch { /* Dynamic provider diagnostics do not change the empty fallback. */ }
        return [];
      }
    });
    this.#work.add(pending);
    const finished = () => this.#work.delete(pending); pending.then(finished, finished);
    return pending;
  }

  close() {
    this.#closed = true;
    return this.#closing ??= (async () => { while (this.#work.size) await Promise.allSettled([...this.#work]); })();
  }
}
