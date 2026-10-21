import path from 'node:path';
import * as fileSystem from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { md5Guid } from '../core/identity.js';
import { stringifyNativeJson } from '../core/json.js';
import { normalizeProbe } from '../storage/probe-normalizer.js';
import { probeLiveRaw } from '../storage/ffprobe.js';
import { LiveStreamReadBridge } from './live-stream-bridge.js';
import { liveMediaInfoDefaults, liveMediaStream, readLiveMediaInfoCache } from './live-stream-info.js';

const nullReference = () => Object.assign(new TypeError('Object reference not set to an instance of an object.'), { nativeException: 'NullReferenceException' });
const requiredStreams = streams => {
  if (streams == null) throw Object.assign(new TypeError("Value cannot be null. (Parameter 'source')"), { nativeException: 'ArgumentNullException', parameterName: 'source' });
  return streams;
};
const streamType = stream => { if (stream == null) throw nullReference(); return stream.Type; };

function estimateVideoBitrate(source, clearAvc) {
  const video = requiredStreams(source.MediaStreams).find(stream => streamType(stream) === 'Video');
  if (video) {
    if (video.BitRate == null) {
      const width = video.Width ?? 1920;
      if (width >= 3000) video.BitRate = 30000000;
      else if (width >= 1900) video.BitRate = 20000000;
      else if (width >= 1200) video.BitRate = 8000000;
      else if (width >= 700) video.BitRate = 2000000;
    }
    if (clearAvc) video.IsAVC = null;
  }
}

function inferBitrate(source, force) {
  if (!force && source.Bitrate != null) return;
  let bitrate = 0;
  for (const stream of requiredStreams(source.MediaStreams)) { if (stream == null) throw nullReference(); if (!stream.IsExternal) bitrate = (bitrate + (stream.BitRate ?? 0)) | 0; }
  if (bitrate > 0) source.Bitrate = bitrate;
}

/** MediaSourceManager.AddMediaInfo, also used after an actual failed probe. */
export function addLiveMediaInfo(source) {
  source.DefaultSubtitleStreamIndex = null;
  if (source.IsInfiniteStream) source.RunTimeTicks = null;
  const audio = requiredStreams(source.MediaStreams).find(stream => streamType(stream) === 'Audio');
  source.DefaultAudioStreamIndex = !audio || audio.Index === -1 ? null : audio.Index;
  estimateVideoBitrate(source, false); inferBitrate(source, false); source.MediaStreams = source.MediaStreams.map(liveMediaStream); return source;
}

/** The cache stores MediaInfo before LiveStreamHelper mutates its AV tracks. */
export function applyLiveProbeInfo(source, information, { cacheKey } = {}) {
  const originalRuntime = source.RunTimeTicks;
  if (information == null) throw nullReference();
  let streams = information.MediaStreams;
  if (cacheKey) {
    const video = requiredStreams(streams).find(stream => streamType(stream) === 'Video'), audio = streams.find(stream => streamType(stream) === 'Audio');
    streams = [video, audio].filter(stream => stream !== undefined);
    for (const stream of streams) { stream.Index = -1; stream.Language = null; }
  }
  for (const name of ['Bitrate', 'Container', 'Formats', 'RunTimeTicks', 'Size', 'Timestamp', 'Video3DFormat', 'VideoType']) source[name] = information[name] ?? null;
  source.MediaStreams = streams; source.DefaultSubtitleStreamIndex = null;
  if (originalRuntime == null) source.RunTimeTicks = null;
  const audio = requiredStreams(streams).find(stream => streamType(stream) === 'Audio');
  source.DefaultAudioStreamIndex = !audio || audio.Index === -1 ? null : audio.Index;
  estimateVideoBitrate(source, true); source.AnalyzeDurationMs = 3000; inferBitrate(source, true);
  source.MediaStreams = source.MediaStreams.map(liveMediaStream); return source;
}

export class LiveStreamProbe {
  #bridge;
  #lifetime = new AbortController();
  #work = new Set();
  #closing;
  constructor({ cachePath, probeOptions = {}, probe = probeLiveRaw, probeFile, onError = () => {}, fileSystem: files = fileSystem } = {}) {
    if (!path.isAbsolute(cachePath ?? '')) throw new TypeError('Live probing requires the owned cache path.');
    Object.assign(this, { cachePath, probeOptions, probe, probeFile, onError, files }); this.#bridge = new LiveStreamReadBridge();
  }

  addMediaInfo(source, { cacheKey, openRead, signal, addProbeDelay = true } = {}) {
    if (this.#lifetime.signal.aborted) return Promise.reject(new Error('Live probing is closed.'));
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    const pending = this.#add(source, { cacheKey, openRead, signal: combined, addProbeDelay });
    this.#work.add(pending); const finished = () => this.#work.delete(pending); pending.then(finished, finished); return pending;
  }

  async #add(source, { cacheKey, openRead, signal, addProbeDelay }) {
    signal.throwIfAborted();
    if (requiredStreams(source.MediaStreams).some(stream => { if (stream == null) throw nullReference(); return stream.Index !== -1; }) || source.SupportsProbing === false) return addLiveMediaInfo(source);
    const filename = cacheKey ? path.join(this.cachePath, 'mediainfo', md5Guid(cacheKey) + '.json') : null;
    let information;
    if (filename) try { information = readLiveMediaInfoCache(await this.files.readFile(filename)); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) this.#report(error); }
    if (information == null) {
      if (addProbeDelay) await delay(Math.max(3000, source.AnalyzeDurationMs ?? 0), undefined, { signal });
      source.AnalyzeDurationMs = 3000;
      let lease;
      try {
        const options = { ...this.probeOptions, signal, analyzeDurationMs: 3000, extractChapters: false, requiredHttpHeaders: source.RequiredHttpHeaders };
        if (openRead) {
          lease = await this.#bridge.lease(openRead, { signal });
          information = normalizeProbe((await this.probe(lease.url, options)).raw, { path: source.Path, protocol: source.Protocol, videoType: source.VideoType ?? null, isAudio: false });
        } else if (source.Protocol === 'File') {
          if (!this.probeFile) throw new TypeError('A file tuner source requires mapped probe access.');
          information = await this.probeFile(source, options);
        } else information = normalizeProbe((await this.probe(source.Path, options)).raw, { path: source.Path, protocol: source.Protocol, videoType: source.VideoType ?? null, isAudio: false });
      } finally { await lease?.release(); }
      // MediaInfo inherits the complete MediaSourceInfo constructor. Keep those
      // values in the actual JSON cache, before reducing it to the first AV pair.
      if (information !== null) {
        const { AudioTags: _audioTags, ...normalized } = information;
        information = { ...liveMediaInfoDefaults(), ...normalized,
          MediaStreams: normalized.MediaStreams == null ? normalized.MediaStreams : normalized.MediaStreams.map(stream => stream && liveMediaStream(stream)) };
      }
      if (filename) {
        await this.files.mkdir(path.dirname(filename), { recursive: true });
        let file;
        try {
          try { file = await this.files.open(filename, 'r+'); }
          catch (error) {
            if (error.code !== 'ENOENT') throw error;
            try { file = await this.files.open(filename, 'wx+'); }
            catch (created) { if (created.code !== 'EEXIST') throw created; file = await this.files.open(filename, 'r+'); }
          }
          // AsyncFile.OpenWrite uses OpenOrCreate, intentionally without truncation.
          const bytes = Buffer.from(stringifyNativeJson(information)); let offset = 0;
          while (offset < bytes.length) offset += (await file.write(bytes, offset, bytes.length - offset, offset)).bytesWritten;
        } finally { await file?.close(); }
      }
    }
    signal.throwIfAborted(); return applyLiveProbeInfo(source, information, { cacheKey });
  }
  #report(error) { try { void Promise.resolve(this.onError(error)).catch(() => {}); } catch { /* Probe diagnostics preserve native fallback. */ } }
  close() {
    this.#lifetime.abort();
    return this.#closing ??= (async () => { try { await this.#bridge.close(); } finally { while (this.#work.size) await Promise.allSettled([...this.#work]); } })();
  }
}
