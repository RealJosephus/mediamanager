import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { negotiateSource } from './profile.js';
import { decodeSubtitle, convertSubtitle } from './subtitles.js';
import { HttpResult, httpError, notFound } from '../http/binding.js';
import { vfsStreamResult, BinaryResult } from '../http/binary-result.js';
import { remoteStaticStreamResult } from './remote-static.js';
import { StorageError, checkAbort } from '../storage/errors.js';
import { hlsPlan, masterPlaylist, mainPlaylist, storedKeyframeData, subtitlePlaylist } from './hls.js';
import { MatroskaKeyframeService } from './matroska-keyframes.js';
import { guid } from '../library/records.js';

const mimeTypes = { mkv: 'video/x-matroska', mks: 'video/x-matroska', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo',
  ts: 'video/mp2t', mpegts: 'video/mp2t', mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', flac: 'audio/flac', wav: 'audio/wav',
  aac: 'audio/aac', ogg: 'audio/ogg', srt: 'application/x-subrip', vtt: 'text/vtt', webvtt: 'application/octet-stream', ass: 'text/x-ssa', ssa: 'text/x-ssa',
  json: 'application/json', jpg: 'image/jpeg', png: 'image/png', txt: 'text/plain', ttml: 'application/ttml+xml' };
export const mimeType = filename => mimeTypes[path.win32.extname(filename ?? '').slice(1).toLowerCase()] ?? 'application/octet-stream';

export class PlaybackService {
  constructor({ library, vfs, identityMap, sessions, configuration = {}, serverVersion = '13.0.0', isLocalNetwork, probe, extraction, remux, hls, keyframes }) {
    Object.assign(this, { library, vfs, identityMap, sessions, configuration, serverVersion, isLocalNetwork, probe, extraction, remux, hls });
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
    let sources = await this.library.getMediaSources(item.Id, { user });
    const primary = sources[0];
    if (primary && primary.Type !== 'Placeholder' && !primary.MediaStreams.some(stream => stream.Type === item.MediaType)) {
      if (!this.probe) throw httpError(503, 'Media probing has not been configured.');
      await this.probe.refresh(item.Id, { force: true, signal });
      sources = await this.library.getMediaSources(item.Id, { user });
    }
    return sources;
  }

  async info(itemId, { user, auth, posted = false, remoteEndPoint, ...options }) {
    const item = await this.library.getItemRecord(itemId, { user });
    if (options.LiveStreamId?.trim()) throw httpError(501, 'Live media sources are not implemented.');
    let sources = await this.sources(item, user);
    if (options.MediaSourceId?.trim()) sources = sources.filter(source => source.Id.toLowerCase() === options.MediaSourceId.toLowerCase());
    if (!sources.length) return { MediaSources: [], ErrorCode: 'NoCompatibleStream' };
    const result = { MediaSources: sources, PlaySessionId: randomUUID().replaceAll('-', '') };
    const profile = posted ? options.DeviceProfile ?? this.sessions.getDeviceCapabilities(auth.DeviceId)?.DeviceProfile : null;
    if (profile) {
      if (!user) throw httpError(404, 'User not found.');
      await this.remux?.initialize();
      await this.hls?.initialize();
      if (sources.some(source => source.MediaStreams.some(stream => stream.Type === 'Subtitle' && (!stream.IsExternal || /\.mks$/i.test(stream.Path ?? ''))))) await this.extraction?.initialize();
      const limit = user.RemoteClientBitrateLimit > 0 ? user.RemoteClientBitrateLimit : this.configuration.RemoteClientBitrateLimit;
      if (limit > 0 && this.isLocalNetwork && !this.isLocalNetwork(remoteEndPoint)) options.MaxStreamingBitrate = Math.min(options.MaxStreamingBitrate ?? limit, limit);
      for (const source of sources) {
        const specific = options.MediaSourceId?.toLowerCase() === source.Id.toLowerCase();
        negotiateSource(source, item, profile, { ...options, AccessToken: auth.Token, DeviceId: auth.DeviceId, PlaySessionId: result.PlaySessionId,
          EnableRemuxing: user.Policy.EnablePlaybackRemuxing && user.Policy.EnableMediaPlayback,
          CanRemux: (source, requested) => this.remux?.supports(source, requested) === true && this.#canResolveSource(source),
          CanHls: (source, requested) => this.hls?.supports(source, { ...requested,
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
    return result;
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
      // Static playback resolves media sources without probing. A remote .strm
      // is a URL source, while /Items/{id}/File remains the local shortcut file.
      const source = (await this.library.getMediaSources(item.Id, { user }))
        .find(value => value.Id.toLowerCase() === item.Id.replaceAll('-', '').toLowerCase());
      if (source?.Protocol === 'Http') return remoteStaticStreamResult(source.Path, source.RequiredHttpHeaders, this.serverVersion);
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
      const encoding = typeof this.hls.encodingOptions === 'function' ? this.hls.encodingOptions() : this.hls.encodingOptions;
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
        const text = stream.IsTextSubtitleStream ? decodeSubtitle(bytes) : null;
        if (text !== null) bytes = Buffer.from(text);
        if (inputFormat !== format && !(inputFormat === 'ssa' && format === 'ass')) bytes = Buffer.from(convertSubtitle(text ?? decodeSubtitle(bytes), inputFormat, format, options));
        if (format === 'vtt' && options.addVttTimeMap) bytes = Buffer.from(bytes.toString('utf8').replaceAll('WEBVTT', 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000'));
        await BinaryResult.bytes(bytes, mimeType(`subtitle.${format}`), { knownLength: format !== 'json' }).send(request, response);
      } catch (error) { this.extractionError(error, controller.signal); }
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
