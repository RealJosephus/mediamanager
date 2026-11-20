import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { negotiateSource, universalAudioHlsCopyContainer } from './profile.js';
import { decodeSubtitle, convertSubtitle } from './subtitles.js';
import { normalizeSubtitleBytes } from './subtitle-charset.js';
import { isExternalSubtitleFallback, subtitleInputFormat } from './subtitle-source.js';
import { identityPathStyle } from '../storage/uri.js';
import { HttpResult, httpError, notFound } from '../http/binding.js';
import { vfsStreamResult, BinaryResult } from '../http/binary-result.js';
import { remoteStaticStreamResult } from './remote-static.js';
import { StorageError, checkAbort } from '../storage/errors.js';
import { masterPlaylist, mainPlaylist, storedKeyframeData, subtitlePlaylist } from './hls.js';
import { MatroskaKeyframeService } from './matroska-keyframes.js';
import { guid, nonemptyId } from '../library/records.js';
import { canDownloadItem } from '../library/download-permission.js';
import { substitutePath } from '../library/path-substitution.js';
import { selectDefaultTracks } from '../library/media-streams.js';
import { readUserData } from '../sessions/user-data.js';
import { getMimeType } from '../http/mime-types.js';

function universalAudioProfile(containers, options) {
  const conditions = [];
  for (const [property, value] of [['AudioSampleRate', options.MaxAudioSampleRate],
    ['AudioBitDepth', options.MaxAudioBitDepth], ['AudioChannels', options.MaxAudioChannels]]) {
    if (value != null) conditions.push({ Condition: 'LessThanEqual', Property: property, Value: String(value), IsRequired: false });
  }
  return {
    DirectPlayProfiles: containers.map(value => {
      const [Container, ...codecs] = value.split('|').filter(Boolean);
      if (!Container) throw httpError(500, 'The audio device profile is invalid.');
      return { Type: 'Audio', Container, AudioCodec: codecs.length ? codecs.join(',') : null };
    }),
    CodecProfiles: conditions.length ? [{ Type: 'Audio', Container: containers.join(','), Conditions: conditions }] : [],
  };
}

function selectUniversalAudioSource(sources, itemId, bitrate) {
  const preferred = itemId.replaceAll('-', '').toLowerCase();
  const order = source => [source.Id.toLowerCase() === preferred ? 0 : 1,
    source.SupportsDirectPlay && source.Protocol === 'File' ? 0 : 1,
    source.SupportsDirectPlay || source.SupportsDirectStream ? 0 : 1, source.Protocol === 'File' ? 0 : 1,
    bitrate != null && source.Bitrate != null ? source.Bitrate <= bitrate ? 0 : 2 : 1];
  return sources.map(source => ({ source, rank: order(source) })).sort((left, right) => {
    for (let index = 0; index < left.rank.length; index++) {
      const difference = left.rank[index] - right.rank[index];
      if (difference) return difference;
    }
    return 0;
  })[0]?.source;
}

export class PlaybackService {
  #subtitleOwner = new AbortController();
  #subtitlePreparations = new Set();

  beginClose() { this.#subtitleOwner.abort(new StorageError('closed', 'Subtitle delivery is closing.')); }

  async drainSubtitlePreparations() {
    while (this.#subtitlePreparations.size) await Promise.allSettled([...this.#subtitlePreparations]);
  }

  #prepareSubtitle(operation) {
    const work = Promise.resolve().then(() => { this.#subtitleOwner.signal.throwIfAborted(); return operation(); });
    this.#subtitlePreparations.add(work);
    void work.finally(() => this.#subtitlePreparations.delete(work)).catch(() => {});
    return work;
  }

  constructor(options) {
    const { library, vfs, identityMap, sessions, activities, configuration = {}, getEncodingOptions,
      getNetworkConfiguration = () => ({ BaseUrl: '' }),
      getSmartApiUrl = request => `${request.socket?.encrypted ? 'https' : 'http'}://${request.headers.host}`,
      serverVersion = '13.0.0', isLocalNetwork, probe, extraction, remux, hls, keyframes, getLiveTvMediaSources, getLiveStreams } = options;
    if (typeof getEncodingOptions !== 'function') throw new TypeError('Playback requires current encoding configuration.');
    Object.assign(this, { library, vfs, identityMap, sessions, activities, getEncodingOptions, getNetworkConfiguration, getSmartApiUrl, serverVersion, isLocalNetwork, probe, extraction, remux, hls, getLiveTvMediaSources, getLiveStreams });
    Object.defineProperty(this, 'configuration', { get() { const { configuration: current = configuration } = options; return current; } });
    this.keyframes = keyframes ?? (library?.store && vfs ? new MatroskaKeyframeService({ store: library.store, vfs, onError: error => hls?.onError?.(error) }) : undefined);
  }

  accessPath(item, identityPath = item.Path, bindItem = true) {
    if (!this.vfs || !this.identityMap) throw httpError(503, 'Media storage has not been configured.');
    return this.identityMap.resolve({ itemId: bindItem ? item.Id.replaceAll('-', '').toLowerCase() : undefined,
      identityPath, style: identityPathStyle(identityPath) });
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

  async universalAudio(itemId, { user, auth, remoteEndPoint, signal, ...options }) {
    let item;
    try { item = await this.library.getItemRecord(itemId, { user }); }
    catch (error) { if (error?.status === 404) return notFound(); throw error; }
    const profile = universalAudioProfile(options.Containers, options);
    let sources = await this.sources(item, user, { signal });
    const requestedId = options.MediaSourceId?.trim() ? options.MediaSourceId : null;
    if (requestedId) sources = sources.filter(source => source.Id.toLowerCase() === requestedId.toLowerCase());
    if (!sources.length) throw httpError(500, 'No audio source was selected.');
    if (!user) throw httpError(404, 'User not found.');
    if (!user.Policy.EnableMediaPlayback) throw httpError(403, 'Media playback is not allowed.');

    const limit = user.RemoteClientBitrateLimit > 0 ? user.RemoteClientBitrateLimit : this.configuration.RemoteClientBitrateLimit;
    const maxBitrate = limit > 0 && this.isLocalNetwork && !this.isLocalNetwork(remoteEndPoint)
      ? Math.min(options.MaxStreamingBitrate ?? limit, limit) : options.MaxStreamingBitrate;
    const hls = options.TranscodingProtocol === 'hls';
    const requestedContainer = options.TranscodingContainer?.toLowerCase();
    const requestedSegmentContainer = requestedContainer === 'mp4' ? 'mp4' : 'ts';
    const hlsCopyContainers = new Map();
    for (const source of sources) {
      if (hls && item.MediaType === 'Audio') {
        hlsCopyContainers.set(source, universalAudioHlsCopyContainer(source, profile, maxBitrate ?? 8000000, requestedSegmentContainer));
      }
      negotiateSource(source, item, profile, { MaxStreamingBitrate: maxBitrate, MaxAudioChannels: options.MaxAudioChannels,
        EnableTranscoding: false });
      if (source.IsRemote && user.Policy.ForceRemoteSourceTranscoding) {
        source.SupportsDirectPlay = false;
        source.SupportsDirectStream = false;
      }
    }
    const source = selectUniversalAudioSource(sources, item.Id, options.MaxStreamingBitrate);
    if (source.SupportsDirectPlay && source.Protocol === 'Http' && source.IsRemote
      && options.EnableRedirection !== false && options.EnableRemoteMedia === true) {
      return new BinaryResult(async (_request, response) => {
        response.writeHead(302, { Location: source.Path });
        response.end();
      });
    }
    if (source.SupportsDirectStream) {
      if (source.Protocol === 'Http') return remoteStaticStreamResult(this.vfs, this.accessPath(item, source.Path, false),
        { headers: source.RequiredHttpHeaders, serverVersion: this.serverVersion });
      if (source.Protocol !== 'File') throw httpError(400, `Input protocol ${source.Protocol} cannot be streamed statically`);
      return vfsStreamResult(this.vfs, this.accessPath(source, source.Path), { contentType: getMimeType(source.Path) });
    }

    if (!user.Policy.EnableAudioPlaybackTranscoding || source.IsRemote && user.Policy.ForceRemoteSourceTranscoding) {
      throw httpError(400, 'No compatible audio stream is available.');
    }
    const copyContainer = hlsCopyContainers.get(source);
    const container = hls ? copyContainer ?? requestedSegmentContainer : requestedContainer ?? 'mp3';
    const stream = {
      MediaType: 'Audio', MediaSourceId: source.Id, Container: container, SegmentContainer: hls ? container : undefined,
      AudioCodec: copyContainer ? 'copy' : options.AudioCodec ?? 'mp3', AudioSampleRate: options.MaxAudioSampleRate,
      AudioBitRate: options.AudioBitRate ?? maxBitrate, MaxAudioChannels: options.MaxAudioChannels,
      AudioChannels: hls ? undefined : options.MaxAudioChannels,
      TranscodingMaxAudioChannels: options.TranscodingAudioChannels, MaxAudioBitDepth: options.MaxAudioBitDepth,
      StartTimeTicks: options.StartTimeTicks, CopyTimestamps: !hls, EnableAudioVbrEncoding: options.EnableAudioVbrEncoding,
      DeviceId: options.DeviceId ?? auth.DeviceId, PlaySessionId: randomUUID().replaceAll('-', ''),
    };
    const service = hls ? this.hls : this.remux;
    if (hls) await this.hls?.initialize();
    if (!service?.supports(source, stream) || !this.#canResolveSource(source)) {
      throw httpError(400, 'No compatible audio stream is available.');
    }
    if (!hls) return this.#remuxSource(source, stream);

    const query = new URLSearchParams(Object.entries({
      MediaSourceId: source.Id, ApiKey: auth.Token, DeviceId: stream.DeviceId, PlaySessionId: stream.PlaySessionId,
      SegmentContainer: container, AudioCodec: stream.AudioCodec, AudioBitRate: stream.AudioBitRate, AudioSampleRate: stream.AudioSampleRate,
      MaxAudioChannels: stream.MaxAudioChannels, TranscodingMaxAudioChannels: stream.TranscodingMaxAudioChannels,
      MaxAudioBitDepth: stream.MaxAudioBitDepth, EnableAudioVbrEncoding: stream.EnableAudioVbrEncoding,
    }).filter(([, value]) => value != null));
    return this.#hlsPlaylist(source, 'master', { ...stream, QueryString: query.toString() });
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
        const policy = user.Policy;
        const mediaEncoder = this.hls?.mediaEncoder ?? this.remux?.mediaEncoder;
        negotiateSource(source, item, profile, { ...options, AccessToken: auth.Token, DeviceId: auth.DeviceId, PlaySessionId: result.PlaySessionId,
          EnableSubtitleExtraction: this.getEncodingOptions().EnableSubtitleExtraction,
          EnableRemuxing: policy.EnableMediaPlayback && (item.MediaType === 'Audio' ? policy.EnableAudioPlaybackTranscoding
            : policy.EnablePlaybackRemuxing || policy.EnableAudioPlaybackTranscoding || policy.EnableVideoPlaybackTranscoding),
          PermitAudioEncoding: policy.EnableAudioPlaybackTranscoding === true, PermitVideoEncoding: policy.EnableVideoPlaybackTranscoding === true,
          CanEncodeAudio: mediaEncoder?.canEncodeAudio?.bind(mediaEncoder),
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
      if (source?.Protocol === 'Http') return remoteStaticStreamResult(this.vfs, this.accessPath(item, source.Path, false),
        { headers: source.RequiredHttpHeaders, serverVersion: this.serverVersion });
      if (source && source.Protocol !== 'File') throw httpError(400, `Input protocol ${source.Protocol} cannot be streamed statically`);
    }
    return vfsStreamResult(this.vfs, this.accessPath(item), { contentType: getMimeType(item.Path), filename: filename ? path.win32.basename(item.Path).replaceAll('"', '') : undefined });
  }

  async download(itemId, { user, auth = {} } = {}) {
    if (!nonemptyId(itemId)) throw httpError(400, "Guid can't be empty. (Parameter 'id')");
    let item;
    try { item = await this.library.getItemRecord(itemId, { user }); }
    catch (error) { if (error?.status === 404) return notFound(); throw error; }
    if (!canDownloadItem(item, user)) throw httpError(400, 'Item does not support downloading');
    if (user) {
      // LibraryController commits this best-effort activity before preparing
      // the file response, including failed and partial media requests.
      await this.activities.downloading(user, item, auth);
    }
    if (item.Path == null || item.Path === '') throw httpError(400, 'A download path is required.');
    const filename = path.basename(item.Path).replaceAll('"', '');
    const options = { contentType: getMimeType(item.Path), filename, serverVersion: this.serverVersion };
    const accessPath = this.accessPath(item);
    return /^https?:\/\//iu.test(item.Path)
      ? remoteStaticStreamResult(this.vfs, accessPath, options)
      : vfsStreamResult(this.vfs, accessPath, options);
  }

  async remuxStream(itemId, { user, ...options } = {}) {
    const item = await this.library.getItemRecord(itemId, { user });
    if (user && (!user.Policy.EnableMediaPlayback || !user.Policy.EnablePlaybackRemuxing
      && !user.Policy.EnableAudioPlaybackTranscoding && !user.Policy.EnableVideoPlaybackTranscoding)) throw httpError(403, 'Media remuxing is not allowed.');
    options.PermitAudioEncoding = user?.Policy.EnableAudioPlaybackTranscoding;
    options.PermitVideoEncoding = user?.Policy.EnableVideoPlaybackTranscoding;
    const sources = await this.sources(item, user);
    const source = options.MediaSourceId ? sources.find(value => value.Id.toLowerCase() === options.MediaSourceId.toLowerCase()) : sources[0];
    if (!source) throw httpError(404, 'Media source not found.');
    if (!this.remux) throw httpError(503, 'Media remuxing has not been configured.');
    return this.#remuxSource(source, options);
  }

  #remuxSource(source, options) {
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
    options.PermitAudioEncoding = user?.Policy.EnableAudioPlaybackTranscoding;
    options.PermitVideoEncoding = user?.Policy.EnableVideoPlaybackTranscoding;
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
          const plan = this.hls.plan(source, options);
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
        else await this.#hlsPlaylist(source, kind, options).send(request, response);
      } catch (error) {
        if (response.headersSent || controller.signal.aborted) { response.destroy(); return; }
        error.status ??= ({ 'not-supported': 400, 'invalid-request': 400, 'not-found': 404, 'permission-denied': 403, 'authentication-required': 403, 'version-changed': 412,
          busy: 429, closed: 503, cancelled: 503, unavailable: 503, timeout: 504 })[error.code] ?? 502;
        throw error;
      } finally { request.removeListener('aborted', abort); response.removeListener('close', abort); }
    });
  }

  #hlsPlaylist(source, kind, options) {
    return new BinaryResult(async (request, response) => {
      const tools = { configuration: this.hls.getEncodingOptions(), capabilities: this.hls.mediaEncoder.capabilities };
      const text = kind === 'master' ? masterPlaylist(source, options, options.QueryString, tools) : mainPlaylist(source, options, options.QueryString, tools);
      const bytes = Buffer.from(kind === 'master' && request.method === 'HEAD' ? '' : text);
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      response.setHeader('Content-Length', bytes.length);
      if (kind === 'master') response.setHeader('Expires', '0');
      response.end(request.method === 'HEAD' ? undefined : bytes);
    });
  }

  async stopHls(deviceId, playSessionId) { await this.hls?.stop(deviceId, playSessionId); }

  async externalAudio(itemId, mediaSourceId, index, { user } = {}) {
    if (!nonemptyId(itemId)) throw httpError(400, "Guid can't be empty. (Parameter 'id')");
    let item;
    try { item = await this.library.getItemRecord(itemId, { user }); }
    catch (error) {
      if (error?.status === 404) return new HttpResult(404, 'Item not found.', { text: true });
      throw error;
    }
    const source = (await this.library.getMediaSources(item.Id)).find(candidate => candidate.Id === mediaSourceId);
    if (!source) return new HttpResult(404, 'Media source not found.', { text: true });
    const stream = source.MediaStreams.find(candidate => candidate.Type === 'Audio' && candidate.Index === index);
    if (!stream) return new HttpResult(404, 'Audio stream not found.', { text: true });
    if (!stream.Path) return new HttpResult(404, 'Audio stream file not found.', { text: true });

    const contentType = getMimeType(stream.Path);
    const result = vfsStreamResult(this.vfs, this.accessPath(item, stream.Path, false), {
      contentType, requestHeaders: { 'User-Agent': `Jellyfin-Server/${this.serverVersion}` },
    });
    return new BinaryResult(async (request, response) => {
      try { await result.send(request, response); }
      catch (error) {
        if (!(error instanceof StorageError) || error.code !== 'not-found' || response.headersSent) throw error;
        response.statusCode = 404;
        response.setHeader('Accept-Ranges', 'none');
        await BinaryResult.bytes(Buffer.alloc(0), contentType).send(request, response);
      }
    });
  }

  canDeliverHlsSubtitle(source, stream) {
    if (!stream.IsTextSubtitleStream) return false;
    if (!stream.IsExternal || /\.mks$/i.test(stream.Path ?? '') || isExternalSubtitleFallback(stream)) return this.extraction?.supportsSubtitle(source, stream, 'vtt') === true;
    const format = subtitleInputFormat(stream);
    return ['srt', 'subrip', 'vtt', 'webvtt', 'ass', 'ssa', 'smi'].includes(format);
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
      const accessPath = this.accessPath(item, stream.Path, false), contentType = getMimeType(stream.Path);
      return /^https?:\/\//iu.test(stream.Path)
        ? remoteStaticStreamResult(this.vfs, accessPath, { serverVersion: this.serverVersion, contentType })
        : vfsStreamResult(this.vfs, accessPath, { contentType });
    }
    const embedded = !stream.IsExternal || /\.mks$/i.test(stream.Path ?? '');
    const textFallback = isExternalSubtitleFallback(stream);
    if ((embedded || textFallback) && !this.extraction) throw httpError(503, 'Media extraction has not been configured.');
    const identityPath = embedded ? stream.Path || source.Path : stream.Path;
    const accessPath = embedded && !stream.Path ? this.accessPath({ Id: source.Id, Path: source.Path }) : this.accessPath(item, identityPath, false);
    format = format.toLowerCase() === 'js' ? 'json' : format.toLowerCase();
    let inputFormat = subtitleInputFormat(stream);
    return new BinaryResult((request, response) => this.#prepareSubtitle(async () => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once('aborted', abort);
      response.once('close', abort);
      if (request.aborted || response.destroyed) abort();
      let handle, failed = false, primary, cleanupFailed = false;
      try {
        let bytes;
        if (embedded || textFallback) {
          const extracted = await this.extraction.subtitle(source, stream, accessPath, { signal: this.#subtitleOwner.signal });
          bytes = extracted.bytes;
          inputFormat = extracted.format;
        } else {
          handle = await this.vfs.openRead(accessPath, { signal: this.#subtitleOwner.signal });
          const chunks = [];
          let length = 0;
          for await (const chunk of handle.stream) {
            checkAbort(this.#subtitleOwner.signal);
            length += chunk.length;
            if (length > 32 * 1024 * 1024) throw httpError(413, 'Subtitle exceeds the supported in-memory size.');
            chunks.push(chunk);
          }
          bytes = Buffer.concat(chunks);
        }
        checkAbort(this.#subtitleOwner.signal);
        if (inputFormat === 'mks' && /^(?:dvdsub|vobsub)$/i.test(format)) throw httpError(400, 'Unsupported file extension: mks.');
        if (stream.IsTextSubtitleStream) bytes = normalizeSubtitleBytes(bytes);
        const text = stream.IsTextSubtitleStream ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) : null;
        if (textFallback && !['srt', 'subrip', 'vtt', 'webvtt', 'json', 'ass', 'ssa', 'ttml'].includes(format)) throw httpError(400, `Unsupported format: ${format}`);
        if (inputFormat !== format && !(inputFormat === 'ssa' && format === 'ass')) bytes = Buffer.from(convertSubtitle(text ?? decodeSubtitle(bytes), inputFormat, format, options));
        if (format === 'vtt' && options.addVttTimeMap) bytes = Buffer.from(bytes.toString('utf8').replaceAll('WEBVTT', 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000'));
        checkAbort(controller.signal);
        await BinaryResult.bytes(bytes, getMimeType(`subtitle.${format}`), { knownLength: format !== 'json' }).send(request, response);
      } catch (error) { failed = true; primary = error; }
      finally {
        request.removeListener('aborted', abort); response.removeListener('close', abort);
        try { await handle?.close(); }
        catch (error) {
          if (!failed) {
            if (error === null || !['object', 'function'].includes(typeof error)) error = new Error('Subtitle source cleanup failed.', { cause: error });
            throw error;
          }
          cleanupFailed = true;
          primary = Object.assign(new AggregateError([primary, error], primary?.message ?? 'Subtitle preparation and source cleanup failed.', { cause: primary }),
            Object.fromEntries(['code', 'status', 'statusCode'].filter(key => primary?.[key] !== undefined).map(key => [key, primary[key]])));
        }
      }
      if (failed) {
        let error = primary;
        if (error === null || !['object', 'function'].includes(typeof error)) error = new Error('Subtitle preparation failed.', { cause: error });
        if (textFallback) {
          error.status ??= error.code === 'invalid-subtitle-timeout' ? 400 : 500;
        }
        else if (/^https?:\/\//iu.test(stream.Path ?? '')) {
          error.status ??= 500;
        }
        else if (!controller.signal.aborted && ['subtitle-start-failure', 'subtitle-timeout', 'invalid-subtitle-timeout', 'cancelled'].includes(error.code)) error.status ??= 404;
        if (cleanupFailed && controller.signal.aborted) throw error;
        this.extractionError(error, controller.signal);
      }
    }));
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
