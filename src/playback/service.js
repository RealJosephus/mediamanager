import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { negotiateSource } from './profile.js';
import { decodeSubtitle, convertSubtitle } from './subtitles.js';
import { normalizeSubtitleBytes } from './subtitle-charset.js';
import { HttpResult, httpError, notFound } from '../http/binding.js';
import { vfsStreamResult, BinaryResult } from '../http/binary-result.js';
import { remoteStaticStreamResult } from './remote-static.js';
import { StorageError, checkAbort } from '../storage/errors.js';
import { hlsPlan, masterPlaylist, mainPlaylist, storedKeyframeData, subtitlePlaylist } from './hls.js';
import { MatroskaKeyframeService } from './matroska-keyframes.js';
import { guid } from '../library/records.js';
import { substitutePath } from '../library/path-substitution.js';
import { selectDefaultTracks } from '../library/media-streams.js';
import { readUserData } from '../sessions/user-data.js';
import { getMimeType } from '../http/mime-types.js';

const mimeTypes = { mkv: 'video/x-matroska', mks: 'video/x-matroska', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo',
  ts: 'video/mp2t', mpegts: 'video/mp2t', mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', flac: 'audio/flac', wav: 'audio/wav',
  aac: 'audio/aac', ogg: 'audio/ogg', srt: 'application/x-subrip', vtt: 'text/vtt', webvtt: 'application/octet-stream', ass: 'text/x-ssa', ssa: 'text/x-ssa',
  json: 'application/json', jpg: 'image/jpeg', png: 'image/png', txt: 'text/plain', ttml: 'application/ttml+xml' };
export const mimeType = filename => mimeTypes[path.win32.extname(filename ?? '').slice(1).toLowerCase()] ?? 'application/octet-stream';

export class PlaybackService {
  constructor(options) {
    const { library, vfs, identityMap, sessions, configuration = {}, getEncodingOptions,
      getNetworkConfiguration = () => ({ BaseUrl: '' }),
      getSmartApiUrl = request => `${request.socket?.encrypted ? 'https' : 'http'}://${request.headers.host}`,
      serverVersion = '13.0.0', isLocalNetwork, probe, extraction, remux, hls, keyframes, getLiveTvMediaSources, getLiveStreams } = options;
    if (typeof getEncodingOptions !== 'function') throw new TypeError('Playback requires current encoding configuration.');
    Object.assign(this, { library, vfs, identityMap, sessions, getEncodingOptions, getNetworkConfiguration, getSmartApiUrl, serverVersion, isLocalNetwork, probe, extraction, remux, hls, getLiveTvMediaSources, getLiveStreams });
    Object.defineProperty(this, 'configuration', { get() { const { configuration: current = configuration } = options; return current; } });
    this.keyframes = keyframes ?? (library?.store && vfs ? new MatroskaKeyframeService({ store: library.store, vfs, onError: error => hls?.onError?.(error) }) : undefined);
  }

  accessPath(item, identityPath = item.Path, bindItem = true) {
    if (!this.vfs || !this.identityMap) throw httpError(503, 'Media storage has not been configured.');
    return this.identityMap.resolve({ itemId: bindItem ? item.Id.replaceAll('-', '').toLowerCase() : undefined,
      identityPath, style: /^(?:[a-z]:|\\\\)/i.test(identityPath ?? '') ? 'windows' : 'posix' });
  }

  #canResolveSource(source) {
    if (!this.vfs || !this.identityMap) return false;
    try {
      this.vfs.resolve(this.accessPath({ Id: source.Id, Path: source.Path }));
      return true;
    } catch (error) {
      if (error instanceof StorageError && ['invalid-path', 'not-found'].includes(error.code)) return false;
      throw error;
    }
  }

  async sources(item, user, { signal } = {}) {
    const dynamicSources = await this.getLiveTvMediaSources?.()?.getMediaSources(item, { signal }) ?? [];
    let sources = await this.library.getMediaSources(item.Id, { user, dynamicSources });
    const primary = sources[0];
    const shortcut = /\.strm$/iu.test(item.Path ?? '');
    if (primary && primary.Type !== 'Placeholder' && (shortcut || !primary.MediaStreams.some(stream => stream.Type === item.MediaType))) {
      if (!this.probe) throw httpError(503, 'Media probing has not been configured.');
      await this.probe.refresh(item.Id, { force: true, signal, enableRemoteContentProbe: shortcut, metadataRefreshMode: 'FullRefresh' });
      sources = await this.library.getMediaSources(item.Id, { user });
    }
    return sources;
  }

  async info(itemId, { user, auth, posted = false, remoteEndPoint, request, signal, ...options }) {
    const item = await this.library.getItemRecord(itemId, { user });
    let sources;
    if (options.LiveStreamId?.trim()) {
      const source = this.getLiveStreams?.()?.getLiveStream(options.LiveStreamId);
      if (!source) throw httpError(500, 'The requested live stream is unavailable.');
      sources = [source];
    } else {
      sources = await this.sources(item, user, { signal });
      if (options.MediaSourceId?.trim()) sources = sources.filter(source => source.Id.toLowerCase() === options.MediaSourceId.toLowerCase());
    }
    if (!sources.length) return { MediaSources: [], ErrorCode: 'NoCompatibleStream' };
    const result = { MediaSources: sources, PlaySessionId: randomUUID().replaceAll('-', '') };
    const profile = posted ? options.DeviceProfile ?? this.sessions.getDeviceCapabilities(auth.DeviceId)?.DeviceProfile : null;
    if (profile) {
      if (!user) throw httpError(404, 'User not found.');
      await this.hls?.initialize();
      const limit = user.RemoteClientBitrateLimit > 0 ? user.RemoteClientBitrateLimit : this.configuration.RemoteClientBitrateLimit;
      if (limit > 0 && this.isLocalNetwork && !this.isLocalNetwork(remoteEndPoint)) options.MaxStreamingBitrate = Math.min(options.MaxStreamingBitrate ?? limit, limit);
      for (const source of sources) {
        const specific = options.MediaSourceId?.toLowerCase() === source.Id.toLowerCase();
        negotiateSource(source, item, profile, { ...options, AccessToken: auth.Token, DeviceId: auth.DeviceId, PlaySessionId: result.PlaySessionId,
          EnableSubtitleExtraction: this.getEncodingOptions().EnableSubtitleExtraction,
          EnableRemuxing: user.Policy.EnablePlaybackRemuxing && user.Policy.EnableMediaPlayback,
          CanRemux: (source, requested) => !source.RequiresOpening && !source.LiveStreamId && this.remux?.supports(source, requested) === true && this.#canResolveSource(source),
          CanHls: (source, requested) => !source.RequiresOpening && !source.LiveStreamId && this.hls?.supports(source, { ...requested,
            CanDeliverHlsSubtitle: stream => this.canDeliverHlsSubtitle(source, stream) }) === true && this.#canResolveSource(source),
          CanExtractSubtitle: (stream, format) => this.extraction?.supportsSubtitle(source, stream, format) === true, AudioStreamIndex: specific ? options.AudioStreamIndex : undefined,
          SubtitleStreamIndex: specific ? options.SubtitleStreamIndex : undefined });
        if (item.MediaType === 'Audio' && !user.Policy.EnableAudioPlaybackTranscoding) {
          source.SupportsTranscoding = false;
          delete source.TranscodingUrl;
        }
        if (source.IsRemote && user.Policy.ForceRemoteSourceTranscoding) { source.SupportsDirectPlay = false; source.SupportsDirectStream = false; }
      }
    }
    if (item.Type === 'LiveTvChannel' && item.SourceType === 'LiveTV') for (const source of sources) {
      source.SupportsTranscoding = false; delete source.TranscodingUrl; delete source.TranscodingContainer;
    }
    // Storage checks and negotiation above use the persistent identity path.
    for (const source of sources) if (source.Protocol === 'File') source.Path = substitutePath(source.Path, this.configuration.PathSubstitutions);
    for (const source of sources) this.#publishedLivePath(source, request);
    if (posted && options.AutoOpenLiveStream === true) {
      const source = options.MediaSourceId?.trim() ? sources.find(value => value.Id === options.MediaSourceId) : sources[0];
      if (source?.RequiresOpening && !source.LiveStreamId?.trim()) {
        const opened = await this.openLiveStream({ ...options, OpenToken: source.OpenToken, ItemId: itemId, PlaySessionId: result.PlaySessionId },
          { user, auth, remoteEndPoint, request, signal });
        result.MediaSources = [opened.MediaSource];
      }
    }
    return result;
  }

  #publishedLivePath(source, request) {
    if (!source.LiveStreamId || source.Protocol !== 'Http' || !request) return;
    let parsed; try { parsed = new URL(source.Path); } catch { return; }
    const base = this.getNetworkConfiguration().BaseUrl;
    let relative = parsed.pathname + parsed.search;
    if (base) {
      if (!relative.toLowerCase().startsWith((base + '/').toLowerCase())) return;
      relative = relative.slice(base.length);
    }
    if (!relative.toLowerCase().startsWith('/livetv/livestreamfiles/')) return;
    let published = this.getSmartApiUrl(request).replace(/\/+$/u, '');
    if (base) {
      let includes = false;
      try { includes = decodeURIComponent(new URL(published).pathname).replace(/\/+$/u, '').toLowerCase().endsWith(base.toLowerCase()); } catch { /* The configured address is validated separately. */ }
      if (!includes) published += base;
    }
    source.Path = published + relative;
  }

  async openLiveStream(options, { user, auth, remoteEndPoint, request, signal } = {}) {
    const liveStreams = this.getLiveStreams?.();
    if (!liveStreams) throw httpError(503, 'Live streams have not been configured.');
    const result = await liveStreams.open(options, { signal });
    {
      if (options.UserId && !/^0{32}$/u.test(options.UserId.replaceAll('-', '')) && !user) throw httpError(500, 'Object reference not set to an instance of an object.');
      const itemId = options.ItemId && !/^0{32}$/u.test(options.ItemId.replaceAll('-', '')) ? options.ItemId : null;
      const profile = options.DeviceProfile ?? this.sessions.getDeviceCapabilities(auth.DeviceId)?.DeviceProfile;
      const item = itemId ? await this.library.getItemRecord(itemId) : null;
      if (user) {
        const data = item ? await this.library.store.run(db => readUserData(db, user.Id, item)) : {};
        selectDefaultTracks(result.MediaSource, item ?? { MediaType: 'Video' }, user, data);
      }
      this.#publishedLivePath(result.MediaSource, request);
      if (profile) {
        if (!itemId) throw httpError(400, "Guid can't be empty. (Parameter 'id')");
        if (!item) throw httpError(404, 'Item not found.');
        if (!user) throw httpError(404, 'User not found.');
        const limit = user.RemoteClientBitrateLimit > 0 ? user.RemoteClientBitrateLimit : this.configuration.RemoteClientBitrateLimit;
        const max = limit > 0 && this.isLocalNetwork && !this.isLocalNetwork(remoteEndPoint)
          ? Math.min(options.MaxStreamingBitrate ?? limit, limit) : options.MaxStreamingBitrate;
        negotiateSource(result.MediaSource, item, profile, { ...options, MaxStreamingBitrate: max, AccessToken: auth.Token,
          DeviceId: auth.DeviceId, EnableRemuxing: false, CanRemux: () => false, CanHls: () => false, CanExtractSubtitle: () => false });
      }
      if (result.MediaSource.Container) result.MediaSource.Container = result.MediaSource.Container.split(',')[0];
      result.MediaSource.SupportsTranscoding = false; delete result.MediaSource.TranscodingUrl; delete result.MediaSource.TranscodingContainer;
      return result;
    }
  }

  closeLiveStream(id) {
    const service = this.getLiveStreams?.(); if (!service) throw httpError(503, 'Live streams have not been configured.');
    return service.closeLiveStream(id);
  }
  liveStreamFile(id, container) {
    const service = this.getLiveStreams?.(); if (!service) return notFound();
    try { return service.streamFile(id, getMimeType('file.' + container)); }
    catch (error) { if (error.status === 404) return notFound(); throw error; }
  }

  async file(itemId, { user, mediaSourceId, filename = false, playback = false } = {}) {
    let item = await this.library.getItemRecord(itemId, { user });
    if (playback && user && !user.Policy.EnableMediaPlayback) throw httpError(403, 'Media playback is not allowed.');
    if (mediaSourceId && mediaSourceId.toLowerCase() !== item.Id.replaceAll('-', '').toLowerCase()) {
      const source = (await this.library.getMediaSources(itemId, { user })).find(source => source.Id.toLowerCase() === mediaSourceId.toLowerCase());
      if (!source) throw httpError(404, 'Media source not found.');
      item = await this.library.getItemRecord(source.Id, { user });
    }
    if (playback) {
      // Static playback resolves media sources without probing. Native Video
      // shortcuts use their URL; Audio and /Items/{id}/File retain the file.
      const source = (await this.library.getMediaSources(item.Id, { user }))
        .find(value => value.Id.toLowerCase() === item.Id.replaceAll('-', '').toLowerCase());
      if (source?.Protocol === 'Http') return remoteStaticStreamResult(source.Path, source.RequiredHttpHeaders, this.serverVersion);
      if (source && source.Protocol !== 'File') throw httpError(400, `Input protocol ${source.Protocol} cannot be streamed statically`);
    }
    return vfsStreamResult(this.vfs, this.accessPath(item), { contentType: mimeType(item.Path), filename: filename ? path.win32.basename(item.Path).replaceAll('"', '') : undefined });
  }

  async remuxStream(itemId, { user, ...options } = {}) {
    const item = await this.library.getItemRecord(itemId, { user });
    if (user && (!user.Policy.EnableMediaPlayback || !user.Policy.EnablePlaybackRemuxing)) throw httpError(403, 'Media remuxing is not allowed.');
    const sources = await this.sources(item, user);
    const source = options.MediaSourceId ? sources.find(value => value.Id.toLowerCase() === options.MediaSourceId.toLowerCase()) : sources[0];
    if (!source) throw httpError(404, 'Media source not found.');
    if (!this.remux) throw httpError(503, 'Media remuxing has not been configured.');
    const accessPath = this.accessPath({ Id: source.Id, Path: source.Path });
    return new BinaryResult(async (request, response) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once('aborted', abort); response.once('close', abort);
      try { await this.remux.stream(source, accessPath, options, request, response, { signal: controller.signal }); }
      catch (error) {
        if (response.headersSent || controller.signal.aborted) { response.destroy(); return; }
        error.status ??= ({ 'not-supported': 400, 'invalid-request': 400, 'not-found': 404, 'permission-denied': 403, 'authentication-required': 403, 'version-changed': 412,
          busy: 429, closed: 503, cancelled: 503, unavailable: 503, timeout: 504 })[error.code] ?? 502;
        throw error;
      } finally { request.removeListener('aborted', abort); response.removeListener('close', abort); }
    });
  }

  async hlsStream(itemId, kind, { user, ...options } = {}) {
    // StreamingHelpers resolves the source without a user visibility filter.
    // The HLS controller requires authentication; PlaybackInfo applies policy.
    const item = await this.library.getItemRecord(itemId);
    const sources = await this.sources(item, null);
    const source = options.MediaSourceId ? sources.find(value => value.Id.toLowerCase() === options.MediaSourceId.toLowerCase()) : sources[0];
    if (!source) throw httpError(404, 'Media source not found.');
    if (!this.hls) throw httpError(503, 'HLS has not been configured.');
    options.CanDeliverHlsSubtitle = stream => this.canDeliverHlsSubtitle(source, stream);
    let keyframeRequest;
    if (kind !== 'master' && options.MediaSourceId?.trim() && source.MediaStreams.some(stream => stream.Type === 'Video')) {
      const encoding = this.hls.getEncodingOptions();
      const allowed = encoding?.AllowOnDemandMetadataBasedKeyframeExtractionForExtensions ?? ['mkv'];
      const extension = path.win32.extname(source.Path ?? '').slice(1).toLowerCase();
      if (extension && allowed.some(value => extension.toLowerCase() === String(value).replace(/^\.+/, '').toLowerCase())) {
        keyframeRequest = { itemId: guid(source.Id), extension, extract: kind === 'main' && extension === 'mkv' };
      }
    }
    return new BinaryResult(async (request, response) => {
      const controller = new AbortController(), abort = () => { if (!response.writableFinished) controller.abort(); };
      request.once('aborted', abort); response.once('close', abort);
      try {
        if (!await this.hls.initialize()) throw httpError(503, 'The HLS process is unavailable.');
        if (keyframeRequest) {
          // The native playlist invokes metadata extraction only for a video
          // remux. Current HLS supports packet copy only, so a successful video
          // plan is the equivalent gate and prevents failed requests from
          // reading or persisting source metadata.
          const plan = hlsPlan(source, options);
          if (plan.video) {
            const row = await this.library.store.run(async db => (await db.rows('KeyframeData', { where: { ItemId: keyframeRequest.itemId }, limit: 1 }))[0]);
            options.KeyframeData = storedKeyframeData(row);
            if (!options.KeyframeData && keyframeRequest.extract && this.keyframes) {
              options.KeyframeData = await this.keyframes.get(keyframeRequest.itemId,
                this.accessPath({ Id: source.Id, Path: source.Path }), { signal: controller.signal });
            }
          }
        }
        if (kind === 'segment') await this.hls.segment(source, this.accessPath({ Id: source.Id, Path: source.Path }), options, options.SegmentIndex, request, response, { signal: controller.signal });
        else {
          const text = kind === 'master' ? masterPlaylist(source, options, options.QueryString) : mainPlaylist(source, options, options.QueryString);
          const bytes = Buffer.from(kind === 'master' && request.method === 'HEAD' ? '' : text);
          response.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); response.setHeader('Content-Length', bytes.length);
          if (kind === 'master') response.setHeader('Expires', '0');
          response.end(request.method === 'HEAD' ? undefined : bytes);
        }
      } catch (error) {
        if (response.headersSent || controller.signal.aborted) { response.destroy(); return; }
        error.status ??= ({ 'not-supported': 400, 'invalid-request': 400, 'not-found': 404, 'permission-denied': 403, 'authentication-required': 403, 'version-changed': 412,
          busy: 429, closed: 503, cancelled: 503, unavailable: 503, timeout: 504 })[error.code] ?? 502;
        throw error;
      } finally { request.removeListener('aborted', abort); response.removeListener('close', abort); }
    });
  }

  async stopHls(deviceId, playSessionId) { await this.hls?.stop(deviceId, playSessionId); }

  canDeliverHlsSubtitle(source, stream) {
    if (!stream.IsTextSubtitleStream) return false;
    if (!stream.IsExternal || /\.mks$/i.test(stream.Path ?? '')) return this.extraction?.supportsSubtitle(source, stream, 'vtt') === true;
    const format = path.win32.extname(stream.Path ?? '').slice(1).toLowerCase() || stream.Codec?.toLowerCase();
    return ['srt', 'subrip', 'vtt', 'webvtt', 'ass', 'ssa'].includes(format);
  }

  async subtitleHlsPlaylist(itemId, mediaSourceId, segmentLength, { user, accessToken } = {}) {
    const item = await this.library.getItemRecord(itemId, { user });
    if (item.MediaType !== 'Video') throw httpError(404, 'Video item not found.');
    const source = (await this.library.getMediaSources(item.Id, { user })).find(source => source.Id.toLowerCase() === mediaSourceId.toLowerCase());
    if (!source) throw httpError(404, 'Media source not found.');
    let text;
    try { text = subtitlePlaylist(source, segmentLength, accessToken); }
    catch (error) { error.status ??= error.code === 'invalid-request' ? 400 : 500; throw error; }
    const bytes = Buffer.from(text);
    return BinaryResult.bytes(bytes, 'application/vnd.apple.mpegurl');
  }

  async subtitle(itemId, mediaSourceId, index, format, options = {}) {
    const item = await this.library.getItemRecord(itemId, { user: options.user });
    const source = (await this.library.getMediaSources(item.Id, { user: options.user })).find(source => source.Id.toLowerCase() === mediaSourceId.toLowerCase());
    const stream = source?.MediaStreams.find(stream => stream.Type === 'Subtitle' && stream.Index === index);
    if (!stream) throw httpError(404, 'Subtitle stream not found.');
    if (!format) {
      if (!stream.Path) throw httpError(404, 'Subtitle stream file not found.');
      return vfsStreamResult(this.vfs, this.accessPath(item, stream.Path, false), { contentType: mimeType(stream.Path) });
    }
    const embedded = !stream.IsExternal || /\.mks$/i.test(stream.Path ?? '');
    if (embedded && !this.extraction) throw httpError(503, 'Media extraction has not been configured.');
    const identityPath = embedded ? stream.Path || source.Path : stream.Path;
    const accessPath = embedded && !stream.Path ? this.accessPath({ Id: source.Id, Path: source.Path }) : this.accessPath(item, identityPath, false);
    format = format.toLowerCase() === 'js' ? 'json' : format.toLowerCase();
    let inputFormat = path.win32.extname(stream.Path ?? '').slice(1).toLowerCase() || stream.Codec;
    inputFormat = ({ subrip: 'srt', webvtt: 'vtt', hdmv_pgs_subtitle: 'pgssub', sup: 'pgssub' })[inputFormat] ?? inputFormat;
    return new BinaryResult(async (request, response) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once('aborted', abort);
      response.once('close', abort);
      let handle;
      try {
        let bytes;
        if (embedded) {
          const extracted = await this.extraction.subtitle(source, stream, accessPath, { signal: controller.signal });
          bytes = extracted.bytes;
          inputFormat = extracted.format;
        } else {
          handle = await this.vfs.openRead(accessPath, { signal: controller.signal });
          const chunks = [];
          let length = 0;
          for await (const chunk of handle.stream) {
            length += chunk.length;
            if (length > 32 * 1024 * 1024) throw httpError(413, 'Subtitle exceeds the supported in-memory size.');
            chunks.push(chunk);
          }
          bytes = Buffer.concat(chunks);
        }
        checkAbort(controller.signal);
        if (inputFormat === 'mks' && /^(?:dvdsub|vobsub)$/i.test(format)) throw httpError(400, 'Unsupported file extension: mks.');
        if (stream.IsTextSubtitleStream) bytes = normalizeSubtitleBytes(bytes);
        const text = stream.IsTextSubtitleStream ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) : null;
        if (inputFormat !== format && !(inputFormat === 'ssa' && format === 'ass')) bytes = Buffer.from(convertSubtitle(text ?? decodeSubtitle(bytes), inputFormat, format, options));
        if (format === 'vtt' && options.addVttTimeMap) bytes = Buffer.from(bytes.toString('utf8').replaceAll('WEBVTT', 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000'));
        await BinaryResult.bytes(bytes, mimeType(`subtitle.${format}`), { knownLength: format !== 'json' }).send(request, response);
      } catch (error) {
        if (!controller.signal.aborted && ['subtitle-start-failure', 'subtitle-timeout', 'invalid-subtitle-timeout', 'cancelled'].includes(error.code)) error.status ??= 404;
        this.extractionError(error, controller.signal);
      }
      finally { request.removeListener('aborted', abort); response.removeListener('close', abort); await handle?.close(); }
    });
  }

  async attachment(itemId, mediaSourceId, index, { user } = {}) {
    let item;
    try { item = await this.library.getItemRecord(itemId, { user }); }
    catch (error) {
      if (error.status !== 404) throw error;
      return notFound();
    }
    const source = (await this.library.getMediaSources(item.Id, { user })).find(source => source.Id.toLowerCase() === mediaSourceId.toLowerCase());
    if (!source) return new HttpResult(404, `MediaSource ${mediaSourceId} not found`);
    const attachment = source.MediaAttachments.find(value => value.Index === index);
    if (!attachment) return new HttpResult(404, `MediaSource ${mediaSourceId} has no attachment with stream index ${index}`);
    if (attachment.Codec?.toLowerCase() === 'mjpeg') return new HttpResult(404, `Attachment with stream index ${index} can't be extracted for MediaSource ${mediaSourceId}`);
    if (!this.extraction) throw httpError(503, 'Media extraction has not been configured.');
    const accessPath = this.accessPath({ Id: source.Id, Path: source.Path });
    return new BinaryResult(async (request, response) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once('aborted', abort);
      response.once('close', abort);
      try {
        const result = await this.extraction.attachment(source, attachment, accessPath, { signal: controller.signal });
        checkAbort(controller.signal);
        await BinaryResult.bytes(result.bytes, attachment.MimeType?.trim() ? attachment.MimeType : 'application/octet-stream').send(request, response);
      } catch (error) { this.extractionError(error, controller.signal); }
      finally { request.removeListener('aborted', abort); response.removeListener('close', abort); }
    });
  }

  extractionError(error, signal) {
    if (signal.aborted) return;
    error.status ??= ({ 'not-found': 404, 'permission-denied': 403, 'authentication-required': 403, 'version-changed': 412,
      'not-supported': 501, unavailable: 503, timeout: 504 })[error.code] ?? 500;
    throw error;
  }
}
