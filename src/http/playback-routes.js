import { HttpResult, BindingError, member, queryValue, booleanValue, integerValue, guidValue, httpError } from './binding.js';
import { validatePlaybackBody } from './playback-binding.js';
import { bindOpenLiveStreamBody, bindOpenLiveStreamQuery, openLiveStreamOptions, bindCloseLiveStreamQuery,
  bindLiveStreamFileContainer } from './live-stream-binding.js';

export function longValue(value, name, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean' || typeof value === 'object' || !/^[+-]?\d+$/.test(String(value).trim())) throw new BindingError(name, `The value '${value}' is not valid.`);
  const result = BigInt(value);
  if (result < -9223372036854775808n || result > 9223372036854775807n) throw new BindingError(name, `The value '${value}' is not valid.`);
  return result;
}

export function bindPlayback(context) {
  const body = context.body ?? {};
  const result = {};
  const types = { UserId: 'guid', MaxStreamingBitrate: 'int', StartTimeTicks: 'long', AudioStreamIndex: 'int', SubtitleStreamIndex: 'int', MaxAudioChannels: 'int',
    MediaSourceId: 'string', LiveStreamId: 'string', AutoOpenLiveStream: 'bool', EnableDirectPlay: 'bool', EnableDirectStream: 'bool', EnableTranscoding: 'bool',
    AllowVideoStreamCopy: 'bool', AllowAudioStreamCopy: 'bool', AlwaysBurnInSubtitleWhenTranscoding: 'bool' };
  for (const [name, type] of Object.entries(types)) {
    const fromBody = member(body, name);
    const queryInput = name === 'AlwaysBurnInSubtitleWhenTranscoding' ? undefined : queryValue(context.query, name);
    const value = (queryInput?.trim() ? queryInput : undefined) ?? fromBody;
    if (value == null) continue;
    const parameter = name[0].toLowerCase() + name.slice(1);
    if (type === 'guid') result[name] = guidValue(String(value), parameter);
    else if (type === 'int') result[name] = integerValue(String(value), parameter);
    else if (type === 'long') result[name] = longValue(value, parameter);
    else if (type === 'bool') result[name] = booleanValue(String(value), parameter);
    else result[name] = String(value);
  }
  const profile = member(body, 'DeviceProfile');
  if (profile != null) result.DeviceProfile = profile;
  return result;
}

export function bindStreaming(context, kind) {
  const query = (context, name) => queryValue(context.query, name);
  const options = { MediaType: kind === 'Audio' ? 'Audio' : 'Video', Container: context.params.container ?? query(context, 'container'), MediaSourceId: query(context, 'mediaSourceId') };
  for (const name of ['VideoCodec', 'AudioCodec', 'SubtitleCodec', 'SubtitleMethod', 'Profile', 'Level', 'DeviceId', 'PlaySessionId', 'SegmentContainer', 'TranscodeReasons']) options[name] = query(context, name);
  for (const name of ['AudioStreamIndex', 'VideoStreamIndex', 'SubtitleStreamIndex', 'AudioSampleRate', 'AudioChannels', 'MaxAudioChannels', 'TranscodingMaxAudioChannels', 'Width', 'Height', 'MaxWidth', 'MaxHeight', 'VideoBitRate', 'AudioBitRate', 'MaxVideoBitDepth', 'MaxAudioBitDepth', 'MaxRefFrames', 'SegmentLength', 'MinSegments']) options[name] = integerValue(query(context, name), name[0].toLowerCase() + name.slice(1));
  for (const name of ['AllowVideoStreamCopy', 'AllowAudioStreamCopy', 'EnableAutoStreamCopy', 'CopyTimestamps', 'DeInterlace', 'RequireAvc', 'RequireNonAnamorphic', 'EnableMpegtsM2TsMode', 'AlwaysBurnInSubtitleWhenTranscoding', 'EnableSubtitlesInManifest']) options[name] = booleanValue(query(context, name), name[0].toLowerCase() + name.slice(1));
  options.StreamOptions = Object.fromEntries([...context.query].filter(([name]) => /^[a-z0-9_]+-(?:profile|level|audiochannels|videobitdepth|audiobitdepth|maxrefframes|deinterlace|rangetype|rotation|codectag)$/i.test(name)).map(([name, value]) => [name.toLowerCase(), value]));
  if (options.SubtitleMethod != null) {
    const methods = ['Encode', 'Embed', 'External', 'Hls', 'Drop'];
    options.SubtitleMethod = methods.find(value => value.toLowerCase() === options.SubtitleMethod.toLowerCase()) ?? methods[integerValue(options.SubtitleMethod, 'subtitleMethod')];
    if (!options.SubtitleMethod) throw new BindingError('subtitleMethod', `The value '${query(context, 'SubtitleMethod')}' is invalid.`);
  }
  for (const name of ['Framerate', 'MaxFramerate']) if (query(context, name) != null) {
    const value = Number(query(context, name));
    if (!Number.isFinite(value)) throw new BindingError(name[0].toLowerCase() + name.slice(1), `The value '${query(context, name)}' is not valid.`);
    options[name] = value;
  }
  options.StartTimeTicks = longValue(query(context, 'startTimeTicks'), 'startTimeTicks', 0n);
  if (query(context, 'params') || query(context, 'liveStreamId')) throw httpError(400, 'The requested streaming source is unavailable.');
  return options;
}

export function registerPlaybackRoutes(add, { playback, users }) {
  if (!playback) return;
  const query = (context, name) => queryValue(context.query, name);
  const itemId = context => guidValue(context.params.itemId, 'itemId');
  async function user(context, requested) {
    let id = requested ?? guidValue(query(context, 'userId'), 'userId', context.auth.UserId);
    if (/^0{32}$/.test(id ?? '')) id = context.auth.UserId;
    if (/^0{32}$/.test(id ?? '')) id = null;
    if (id && id !== context.auth.UserId && !context.auth.IsAdministrator) throw httpError(403, 'Forbidden');
    return id ? users.getUser(id) : null;
  }
  for (const method of ['GET', 'POST']) add(method, '/Items/{itemId}/PlaybackInfo', async context => {
    const options = method === 'POST' ? bindPlayback(context) : {};
    return playback.info(itemId(context), { ...options, auth: context.auth, user: await user(context, options.UserId),
      posted: method === 'POST', remoteEndPoint: context.remoteEndPoint, request: context.request, signal: context.signal });
  }, { body: method === 'POST', optionalBody: true, bindBody: validatePlaybackBody });
  add('POST', '/LiveStreams/Open', async context => {
    const options = openLiveStreamOptions(context);
    return playback.openLiveStream(options, { user: await user(context, options.UserId), auth: context.auth,
      remoteEndPoint: context.remoteEndPoint, request: context.request, signal: context.signal });
  }, { body: true, optionalBody: true, bindBody: bindOpenLiveStreamBody, bindQuery: bindOpenLiveStreamQuery,
    bodyType: 'Jellyfin.Api.Models.MediaInfoDtos.OpenLiveStreamDto' });
  add('POST', '/LiveStreams/Close', async context => {
    await playback.closeLiveStream(context.queryInput); return new HttpResult(204);
  }, { bindQuery: bindCloseLiveStreamQuery });
  add('GET', '/LiveTv/LiveStreamFiles/{streamId}/stream.{container}', context => playback.liveStreamFile(context.params.streamId,
    bindLiveStreamFileContainer(context.params.container)), { public: true });
  add('GET', '/Videos/{videoId}/{mediaSourceId}/Attachments/{index}', context => playback.attachment(guidValue(context.params.videoId,'videoId'),
    context.params.mediaSourceId, integerValue(context.params.index,'index'), { user: context.auth.User }), { public:true });
  add('GET', '/Items/{itemId}/File', context => playback.file(itemId(context), { user: context.auth.User }));
  for (const kind of ['Videos', 'Audio']) for (const method of ['GET', 'HEAD']) {
    add(method, [`/${kind}/{itemId}/stream`, `/${kind}/{itemId}/stream.{container}`], async context => {
      const selected = await user(context);
      if (booleanValue(query(context, 'static'), 'static', false)) return playback.file(itemId(context), { user: selected, mediaSourceId: query(context, 'mediaSourceId'), playback: true });
      const options = { ...bindStreaming(context, kind), user: selected };
      return playback.remuxStream(itemId(context), options);
    }, { public: context => booleanValue(query(context, 'static'), 'static', false) });
  }
  add('DELETE', '/Videos/ActiveEncodings', async context => {
    const deviceId = query(context, 'deviceId'), playSessionId = query(context, 'playSessionId');
    const missing = Object.entries({ deviceId, playSessionId }).filter(([, value]) => !value?.trim());
    if (missing.length) { const error = new BindingError(missing[0][0], `The ${missing[0][0]} field is required.`); error.errors = Object.fromEntries(missing.map(([name]) => [name, [`The ${name} field is required.`]])); throw error; }
    await playback.stopHls(deviceId, playSessionId);
    return new HttpResult(204);
  });
  for (const kind of ['Videos', 'Audio']) for (const method of ['GET', 'HEAD']) {
    for (const playlist of method === 'HEAD' ? ['master'] : ['master', 'main']) add(method, `/${kind}/{itemId}/${playlist}.m3u8`, async context => {
      if (kind === 'Audio' && playlist === 'master' && !query(context, 'mediaSourceId')?.trim()) throw new BindingError('mediaSourceId', 'The mediaSourceId field is required.');
      return playback.hlsStream(itemId(context), playlist, { ...bindStreaming(context, kind), user: context.auth.User, AccessToken: context.auth.Token, QueryString: context.url.search.slice(1) });
    });
    if (method === 'HEAD') continue;
    add(method, `/${kind}/{itemId}/hls1/{playlistId}/{segmentId}.{container}`, async context => {
      const options = { ...bindStreaming(context, kind), user: context.auth.User, SegmentIndex: integerValue(context.params.segmentId, 'segmentId'), SegmentContainer: query(context, 'segmentContainer') ?? context.params.container };
      const errors = {};
      for (const [queryName, optionName] of [['runtimeTicks', 'CurrentRuntimeTicks'], ['actualSegmentLengthTicks', 'ActualSegmentLengthTicks']]) {
        try { if (!query(context, queryName)?.trim()) throw new BindingError(queryName, `The ${queryName} field is required.`); options[optionName] = longValue(query(context, queryName), queryName); }
        catch (error) { if (!(error instanceof BindingError)) throw error; Object.assign(errors, error.errors); }
      }
      if (Object.keys(errors).length) { const error = new BindingError('', 'Invalid HLS parameters.'); error.errors = errors; throw error; }
      return playback.hlsStream(itemId(context), 'segment', options);
    });
  }
  add('GET', '/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/subtitles.m3u8', context => {
    integerValue(context.params.index, 'index');
    const segmentLength = integerValue(query(context, 'segmentLength'), 'segmentLength');
    if (segmentLength == null) throw new BindingError('segmentLength', 'The segmentLength field is required.');
    return playback.subtitleHlsPlaylist(itemId(context), context.params.mediaSourceId, segmentLength, { user: context.auth.User, accessToken: context.auth.Token });
  });
  for (const route of ['/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream.{format}', '/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/{startPositionTicks}/Stream.{format}']) {
    add('GET', route, async context => playback.subtitle(guidValue(query(context, 'itemId') ?? context.params.itemId, 'itemId'),
      query(context, 'mediaSourceId') ?? context.params.mediaSourceId, integerValue(query(context, 'index') ?? context.params.index, 'index'),
      query(context, 'format') ?? context.params.format, { user: context.auth.User,
        startPositionTicks: longValue(query(context, 'startPositionTicks') ?? context.params.startPositionTicks, 'startPositionTicks', 0n),
        endPositionTicks: longValue(query(context, 'endPositionTicks'), 'endPositionTicks', 0n),
        copyTimestamps: booleanValue(query(context, 'copyTimestamps'), 'copyTimestamps', false),
        addVttTimeMap: booleanValue(query(context, 'addVttTimeMap'), 'addVttTimeMap', false) }));
  }
}
