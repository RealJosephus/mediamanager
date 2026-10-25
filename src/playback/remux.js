import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ProbeReadBridge } from '../storage/probe-bridge.js';
import { StorageError } from '../storage/errors.js';
import { subtitleInputIndex } from './extraction.js';
import { videoColorRange } from '../library/media-streams.js';
import { encoderVersionAtLeast, getEncodingThreadCount } from './media-encoder.js';

const failure = (code, message, cause) => Object.assign(new StorageError(code, message), cause === undefined ? {} : { cause });
const checkAbort = signal => { if (signal?.aborted) throw failure('cancelled', 'Remuxing was cancelled.', signal.reason); };
const operationFailure = errors => errors.length === 1 ? errors[0]
  : Object.assign(new AggregateError(errors, errors[0]?.message ?? 'Remux cleanup failed.', { cause: errors[0] }),
    Object.fromEntries(['code', 'status', 'statusCode'].filter(key => errors[0]?.[key] !== undefined).map(key => [key, errors[0][key]])));
const containers = {
  mp4: { muxer: 'mp4', mime: 'video/mp4', video: ['h264', 'hevc', 'av1', 'vp9', 'mpeg4'], audio: ['aac', 'ac3', 'eac3', 'mp3', 'alac'], subtitle: ['mov_text'] },
  mkv: { muxer: 'matroska', mime: 'video/x-matroska', video: ['h264', 'hevc', 'av1', 'vp8', 'vp9', 'mpeg1video', 'mpeg2video', 'mpeg4', 'mjpeg'], audio: ['aac', 'ac3', 'eac3', 'mp3', 'flac', 'alac', 'opus', 'vorbis', 'dts', 'truehd', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le'], subtitle: ['subrip', 'srt', 'ass', 'ssa', 'pgssub', 'dvdsub'] },
  ts: { muxer: 'mpegts', mime: 'video/mp2t', video: ['h264', 'hevc', 'mpeg1video', 'mpeg2video', 'mpeg4'], audio: ['aac', 'ac3', 'eac3', 'mp2', 'mp3'], subtitle: ['dvbsub'] },
  webm: { muxer: 'webm', mime: 'video/webm', video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'], subtitle: ['webvtt'] },
  m4a: { muxer: 'mp4', mime: 'audio/mp4', audio: ['aac', 'alac', 'ac3', 'eac3', 'mp3'] },
  mp3: { muxer: 'mp3', mime: 'audio/mpeg', audio: ['mp3'] },
  aac: { muxer: 'adts', mime: 'audio/aac', audio: ['aac'] },
  flac: { muxer: 'flac', mime: 'audio/flac', audio: ['flac'] },
  ogg: { muxer: 'ogg', mime: 'audio/ogg', audio: ['vorbis', 'opus', 'flac'] },
  wav: { muxer: 'wav', mime: 'audio/wav', audio: ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_u8', 'pcm_f32le', 'pcm_f64le'] },
};
const matches = (requested, actual) => !requested || requested.toLowerCase().split(',').includes(actual?.toLowerCase()) || requested.toLowerCase() === 'copy';
const finite = value => value == null || Number.isFinite(Number(value));

export function remuxPlan(source, options = {}) {
  options = { ...options };
  if (source.IsInfiniteStream || source.RequiresOpening || source.RequiresClosing || source.VideoType && !['VideoFile', 'Iso'].includes(source.VideoType)
    || /^(?:hls|applehttp|dash)$/i.test(source.Container)) throw failure('not-supported', 'Remuxing requires a finite, opened media file.');
  const container = options.Container?.toLowerCase();
  const output = containers[container];
  if (!output) throw failure('not-supported', 'The requested container has no audited packet-copy muxer.');
  const select = (type, index) => index == null ? source.MediaStreams.find(stream => stream.Type === type && !stream.IsAttachedPic && (type !== 'Audio' || stream.Index === source.DefaultAudioStreamIndex))
    ?? source.MediaStreams.find(stream => stream.Type === type && !stream.IsAttachedPic) : source.MediaStreams.find(stream => stream.Type === type && stream.Index === index);
  const video = options.MediaType === 'Audio' ? undefined : select('Video', options.VideoStreamIndex);
  const audio = options.AudioStreamIndex === -1 ? undefined : select('Audio', options.AudioStreamIndex);
  const subtitle = options.SubtitleStreamIndex >= 0 && options.SubtitleMethod === 'Embed' ? select('Subtitle', options.SubtitleStreamIndex) : undefined;
  const streamOptions = options.StreamOptions ?? {};
  const codecOption = (stream, name) => streamOptions[`${stream?.Codec?.toLowerCase()}-${name}`] ?? streamOptions[name];
  for (const [name, option, stream] of [['MaxVideoBitDepth', 'videobitdepth', video], ['MaxAudioBitDepth', 'audiobitdepth', audio], ['MaxRefFrames', 'maxrefframes', video], ['MaxAudioChannels', 'audiochannels', audio], ['Level', 'level', video]]) {
    const value = codecOption(stream, option);
    if (value != null) options[name] = options[name] == null ? Number(value) : Math.min(Number(options[name]), Number(value));
  }
  options.Profile ??= codecOption(video, 'profile');
  options.DeInterlace ||= codecOption(video, 'deinterlace')?.toLowerCase() === 'true';
  if (codecOption(audio, 'profile') && !matches(codecOption(audio, 'profile'), audio?.Profile)) throw failure('not-supported', 'The requested audio profile requires encoding.');
  for (const [name, value] of [['rangetype', video ? video.VideoRangeType ?? videoColorRange(video)[1] : undefined], ['rotation', video?.Rotation ?? 0], ['codectag', video?.CodecTag]]) {
    if (codecOption(video, name) && !matches(codecOption(video, name), String(value ?? ''))) throw failure('not-supported', 'The requested video parameters cannot be met by packet copy.');
  }
  const separateHlsSubtitle = options.HlsManifest === true && options.SubtitleMethod === 'Hls';
  if (!video && !audio || options.MediaType !== 'Audio' && !video || options.AudioStreamIndex >= 0 && !audio || options.VideoStreamIndex >= 0 && !video
    || options.SubtitleStreamIndex >= 0 && (!['External', 'Drop', 'Embed'].includes(options.SubtitleMethod) && !separateHlsSubtitle || options.AlwaysBurnInSubtitleWhenTranscoding)) throw failure('not-supported', 'The selected streams require an unavailable processing branch.');
  for (const [stream, kind] of [[video, 'video'], [audio, 'audio'], [subtitle, 'subtitle']]) {
    if (!stream) continue;
    const flacAudioMp4 = container === 'mp4' && options.MediaType === 'Audio' && kind === 'audio'
      && stream.Codec?.toLowerCase() === 'flac' && !source.MediaStreams.some(value => value.Type === 'Video');
    if (stream.IsExternal || stream.Path || !output[kind]?.includes(stream.Codec?.toLowerCase()) && !flacAudioMp4) throw failure('not-supported', 'The selected stream cannot be copied into this container.');
  }
  if (options.SubtitleStreamIndex >= 0 && options.SubtitleMethod === 'Embed' && !subtitle) throw failure('not-found', 'The selected subtitle stream does not exist.');
  if (video && (options.AllowVideoStreamCopy === false || !matches(options.VideoCodec, video.Codec))
    || audio && (options.AllowAudioStreamCopy === false || !matches(options.AudioCodec, audio.Codec))) throw failure('not-supported', 'The requested codec would require encoding.');
  if (options.EnableAutoStreamCopy === false && (video && options.VideoCodec !== 'copy' || audio && options.AudioCodec !== 'copy')
    || subtitle && !matches(options.SubtitleCodec, subtitle.Codec)) throw failure('not-supported', 'The request disables stream copy.');
  if (options.DeInterlace && video?.IsInterlaced || options.RequireNonAnamorphic && video?.IsAnamorphic || options.RequireAvc && video?.IsAVC === false) throw failure('not-supported', 'The requested video processing requires decoding.');
  const limits = [[options.MaxWidth, video?.Width], [options.MaxHeight, video?.Height], [options.MaxFramerate, video?.AverageFrameRate ?? video?.RealFrameRate],
    [options.MaxVideoBitDepth, video?.BitDepth], [options.MaxAudioBitDepth, audio?.BitDepth], [options.MaxRefFrames, video?.RefFrames],
    [options.VideoBitRate, video?.BitRate], [options.AudioBitRate, audio?.BitRate], [options.MaxAudioChannels, audio?.Channels], [options.TranscodingMaxAudioChannels, audio?.Channels]];
  if (limits.some(([maximum, value]) => !finite(maximum) || maximum != null && (value == null || Number(value) > Number(maximum)))) throw failure('not-supported', 'The requested limit cannot be met by packet copy.');
  for (const [required, value] of [[options.Width, video?.Width], [options.Height, video?.Height], [options.Framerate, video?.AverageFrameRate ?? video?.RealFrameRate], [options.AudioChannels, audio?.Channels], [options.AudioSampleRate, audio?.SampleRate]]) {
    if (required != null && (!finite(required) || Number(required) !== Number(value))) throw failure('not-supported', 'Changing media parameters requires encoding.');
  }
  if (options.Profile && video && !matches(options.Profile.replaceAll(' ', ''), video.Profile?.replaceAll(' ', ''))
    || options.Level != null && video && (!finite(options.Level) || video.Level == null || Number(video.Level) > Number(options.Level))) throw failure('not-supported', 'The requested video profile requires encoding.');
  let start = BigInt(options.StartTimeTicks ?? 0);
  if (start < 0n || start > 9223372036854775807n) throw failure('invalid-request', 'The start time must be a nonnegative Int64.');
  // EncodingHelper leaves five seconds before EOF so the muxer receives packets.
  if (start > 0n && source.RunTimeTicks > 0) {
    const maximum = BigInt(source.RunTimeTicks) > 50000000n ? BigInt(source.RunTimeTicks) - 50000000n : 0n;
    if (start > maximum) start = maximum;
  }
  return { container, ...output, streams: [video, audio, subtitle].filter(Boolean).map(stream => ({ type: stream.Type, codec: stream.Codec, index: stream.Type === 'Subtitle' ? subtitleInputIndex(source, stream) : stream.Index })),
    start, seek: BigInt(options.StartTimeTicks ?? 0) > 0n, copyTimestamps: options.CopyTimestamps === true, m2ts: options.EnableMpegtsM2TsMode === true, mediaType: options.MediaType ?? 'Video' };
}

export function remuxArguments(url, plan, threads, version) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/.test(url)) throw new TypeError('Remuxing requires a private VFS input.');
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'http,tcp'];
  if (plan.seek) {
    const milliseconds = plan.start / 10000n;
    args.push('-ss', `${String(milliseconds / 3600000n % 24n).padStart(2, '0')}:${String(milliseconds / 60000n % 60n).padStart(2, '0')}:${String(milliseconds / 1000n % 60n).padStart(2, '0')}.${String(milliseconds % 1000n).padStart(3, '0')}`);
  }
  if (plan.streams.some(stream => stream.type === 'Video')) args.push('-fflags', '+genpts');
  args.push('-i', url, '-threads', String(threads));
  for (const stream of plan.streams) args.push('-map', `0:${stream.index}`);
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-c', 'copy');
  const audioCodec = plan.streams.find(stream => stream.type === 'Audio')?.codec?.toLowerCase();
  if (['opus', 'dts', 'truehd'].includes(audioCodec) || audioCodec === 'flac' && !encoderVersionAtLeast(version, 6)) args.push('-strict', '-2');
  if (!plan.streams.some(stream => stream.type === 'Video')) args.push('-vn');
  if (!plan.streams.some(stream => stream.type === 'Audio')) args.push('-an');
  if (!plan.streams.some(stream => stream.type === 'Subtitle')) args.push('-sn');
  args.push('-dn');
  if (plan.container === 'ts') {
    const video = plan.streams.find(stream => stream.type === 'Video');
    if (['h264', 'hevc'].includes(video?.codec)) args.push('-bsf:v', `${video.codec}_mp4toannexb`);
    if (plan.m2ts) args.push('-mpegts_m2ts_mode', '1');
  }
  if (plan.copyTimestamps) args.push('-copyts', '-avoid_negative_ts', 'disabled', '-start_at_zero');
  if (plan.muxer === 'mp4') args.push('-movflags', plan.mediaType === 'Audio' ? 'empty_moov+delay_moov' : 'frag_keyframe+empty_moov+delay_moov');
  args.push('-f', plan.muxer, 'pipe:1');
  return args;
}

export class RemuxService {
  #closed = false;
  #closing;
  #jobs = new Set();
  #cleanupErrors = [];
  constructor({ vfs, bridge, mediaEncoder, timeoutMs = 21600000, maxConcurrentRemuxes = 4, onProcess = () => {} }) {
    if (!vfs) throw new TypeError('Remuxing requires VFS.');
    if (!mediaEncoder) throw new TypeError('Remuxing requires its startup media encoder.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxConcurrentRemuxes) || maxConcurrentRemuxes < 1) throw new TypeError('Positive remux limits are required.');
    Object.assign(this, { vfs, bridge: bridge ?? new ProbeReadBridge(vfs), ownsBridge: !bridge, mediaEncoder, timeoutMs, maxConcurrentRemuxes, onProcess });
  }
  get available() { return this.mediaEncoder.ready; }
  supports(source, options) {
    if (!this.available || this.#closed) return false;
    try { remuxPlan(source, options); return true; } catch { return false; }
  }
  async stream(source, virtualPath, options, request, response, { signal } = {}) {
    const plan = remuxPlan(source, options), threads = getEncodingThreadCount(this.mediaEncoder.getEncodingOptions(), options.CpuCoreLimit);
    if (!this.available) throw failure('unavailable', 'The ffmpeg remux process is unavailable.');
    if (this.#closed) throw failure('closed', 'Remuxing is closed.');
    checkAbort(signal);
    response.setHeader('Accept-Ranges', 'none');
    response.setHeader('Content-Type', plan.mime);
    if (request.method === 'HEAD') { response.end(); return; }
    if (this.#jobs.size >= this.maxConcurrentRemuxes) throw failure('busy', 'The remux concurrency limit has been reached.');
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const job = { controller };
    this.#jobs.add(job);
    const timer = setTimeout(() => controller.abort(failure('timeout', 'Remuxing timed out.')), this.timeoutMs); timer.unref();
    job.done = this.#stream(virtualPath, plan, threads, response, controller.signal);
    try { await job.done; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#jobs.delete(job); }
  }
  async #stream(virtualPath, plan, threads, response, signal) {
    const before = await this.vfs.stat(virtualPath, { signal });
    const lease = await this.bridge.lease(virtualPath, { signal, version: before.version, expiresInMs: this.timeoutMs });
    let child, done, failed, primary, killTimer;
    const cleanupErrors = [];
    const kill = () => { try { child?.kill(); } catch (error) { cleanupErrors.push(error); } };
    const abort = () => { failed ??= signal.reason?.code === 'timeout' ? signal.reason : failure('cancelled', 'Remuxing was cancelled.', signal.reason); kill(); };
    try {
      checkAbort(signal);
      const args = remuxArguments(lease.url, plan, threads, this.mediaEncoder.version);
      try { child = spawn(this.mediaEncoder.encoderPath, args, { shell: false, windowsHide: true, env: this.mediaEncoder.environment, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { throw failure('unavailable', 'The remux process could not start.', error); }
      const started = Promise.withResolvers();
      done = new Promise(resolve => {
        child.once('spawn', started.resolve);
        child.once('error', error => {
          const startup = failure('unavailable', 'The remux process could not start.', error);
          failed = failed === undefined ? startup : operationFailure([failed, startup]); started.reject(failed);
        });
        child.once('close', resolve);
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stderr.on('data', () => {});
      try {
        await started.promise;
        this.onProcess({ pid: child.pid, args: args.map(value => value === lease.url ? '[private source]' : value) });
        let received = false;
        for await (const bytes of child.stdout) {
          checkAbort(signal); received = true;
          if (!response.write(bytes)) await once(response, 'drain', { signal });
        }
        await done;
        if (failed) throw failed;
        if (child.exitCode !== 0 || !received) throw failure('invalid-response', 'The selected streams could not be remuxed.');
        const after = await this.vfs.stat(virtualPath, { signal });
        if (before.version != null && before.version !== after.version) throw failure('version-changed', 'The source changed during remuxing.');
        response.end();
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          kill(); killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (error) { cleanupErrors.push(error); } }, 1000); killTimer.unref();
        }
        await done;
      }
    } catch (error) { primary = failed?.code === 'timeout' && error.code !== 'timeout' ? operationFailure([failed, error]) : error; }
    finally {
      clearTimeout(killTimer); signal.removeEventListener('abort', abort);
      if (done) await done;
      try { await lease.release(); } catch (error) { cleanupErrors.push(error); }
      this.#cleanupErrors.push(...cleanupErrors);
    }
    const errors = primary === undefined ? cleanupErrors : [primary, ...cleanupErrors];
    if (errors.length) throw operationFailure(errors);
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const completion = Promise.withResolvers(); this.#closing = completion.promise;
    for (const job of this.#jobs) job.controller.abort(failure('closed', 'Remuxing is closed.'));
    (async () => {
      await Promise.allSettled([...this.#jobs].map(job => job.done));
      const errors = [...this.#cleanupErrors];
      if (this.ownsBridge) try { await this.bridge.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw operationFailure(errors);
    })().then(completion.resolve, completion.reject);
    return this.#closing;
  }
}
