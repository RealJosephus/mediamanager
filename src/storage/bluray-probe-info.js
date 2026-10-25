import { StorageError } from './errors.js';

const audioCodecs = new Map([
  [3, ['mp1']], [4, ['mp2']], [15, ['aac']], [17, ['aac']],
  [128, ['pcm_bluray']], [129, ['ac3']], [130, ['dts']], [131, ['truehd']],
  [132, ['eac3']], [133, ['dts']], [134, ['dts']], [161, ['eac3']], [162, ['dts']],
]);
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

function lfeCount(layout) {
  if (typeof layout !== 'string' || !layout) return null;
  if (/^(?:mono|stereo|stereo downmix|quad(?:\(side\))?|hexagonal|octagonal|hexadecagonal|downmix)$/u.test(layout)) return 0;
  const named = /^(\d+)\.(\d+)(?:\.\d+)?(?:\([^)]*\))?$/u.exec(layout);
  if (named) return Number(named[2]);
  // ffprobe can also return explicit channel names instead of a layout alias.
  if (/^[A-Z][A-Z0-9]*(?:\+[A-Z][A-Z0-9]*)+$/u.test(layout)) {
    return layout.split('+').filter(channel => /^LFE\d*$/u.test(channel)).length;
  }
  return null;
}

/** Complete the fields BdInfoExaminer consumes from the reference clip. Keep
 * raw audio bitrates: normalizeProbe deliberately estimates missing bitrates,
 * while BDInfo leaves those values unset. Playlist/CLPI owns order and language. */
export function blurayMediaStreams(plan, referenceRaw) {
  let entries = plan.streams;
  if (plan.referenceSsif && !entries.some(stream => stream.pid === 4114)
    && (referenceRaw.streams ?? []).some(stream => Number(stream.id) === 4114
      && stream.codec_type === 'video' && Number(stream.codec_tag) === 0x20)) {
    // LoadStreamClips appends the M2TS-only MVC stream to the video group and
    // SortedStreams gives it the same angle copies as every other video. The
    // native MVC scanner does not extract dimensions, frame rate or bitrate.
    const mvc = Array.from({ length: (plan.angleCount ?? 0) + 1 }, (_, angleIndex) => ({
      pid: 4114, streamType: 0x20, angleIndex,
      mediaStream: { Type: 'Video', Codec: 'MVC', Height: 0, IsInterlaced: false },
    }));
    const boundary = entries.findIndex(stream => stream.mediaStream.Type !== 'Video');
    const index = boundary < 0 ? entries.length : boundary;
    entries = [...entries.slice(0, index), ...mvc, ...entries.slice(index)];
  }
  return entries.map(({ pid, streamType, mediaStream }, Index) => {
    const stream = { ...mediaStream, Index };
    if (stream.Type === 'Video') return { ...stream, Width: 0, BitRate: 0 };
    if (stream.Type !== 'Audio') return stream;
    const raw = (referenceRaw.streams ?? []).find(value => Number(value.id) === pid
      && value.codec_type === 'audio' && audioCodecs.get(streamType)?.includes(value.codec_name));
    // LoadStreamClips retains the CLPI baseline when its reference StreamFile
    // has no matching PID/type. CLPI carries no channel count or bitrate.
    if (!raw) return { ...stream, Channels: 0, ChannelLayout: '0.0', BitRate: null };
    const channels = positive(raw.channels), lfe = lfeCount(raw.channel_layout);
    if (channels == null || lfe == null || lfe > channels) {
      throw new StorageError('not-supported', 'The Blu-ray reference audio has no explicit supported channel layout.');
    }
    // TrueHD and DTS-HD MA quick-scan headers do not supply a fixed bitrate.
    const bitrate = [131, 134].includes(streamType) ? null : positive(raw.bit_rate);
    // BdInfoExaminer uses CodecShortName for TrueHD, but normalizes E-AC3 and
    // DTS to fixed codecs regardless of their extensions. It does not set Profile.
    const codec = streamType === 131 && raw.profile === 'Dolby TrueHD + Dolby Atmos' ? 'Atmos' : stream.Codec;
    return { ...stream, Codec: codec, Channels: channels, ChannelLayout: `${channels - lfe}.${lfe}`,
      SampleRate: Math.max(stream.SampleRate ?? 0, positive(raw.sample_rate) ?? 0), BitRate: bitrate };
  });
}

/** FFProbeVideoInfo.FetchBdInfo's merge. First-file information remains the
 * source for scalar metadata, attachments and transport timestamp. MPLS times
 * are seconds; persisted RunTimeTicks and chapter positions are 100 ns ticks. */
export function mergeBlurayProbe(plan, firstInfo, referenceRaw) {
  const streams = blurayMediaStreams(plan, referenceRaw);
  const original = firstInfo.MediaStreams.find(stream => stream.Type === 'Video');
  const video = streams.find(stream => stream.Type === 'Video');
  if (video && original) {
    video.Codec = original.Codec;
    for (const field of ['BitRate', 'Width', 'Height']) if (!video[field]) video[field] = original[field];
    for (const field of ['ColorRange', 'ColorSpace', 'ColorTransfer', 'ColorPrimaries', 'BitDepth', 'PixelFormat']) video[field] = original[field];
  }
  return { ...firstInfo, MediaStreams: streams,
    RunTimeTicks: plan.runTimeTicks > 0n ? plan.runTimeTicks : firstInfo.RunTimeTicks,
    Chapters: plan.chapters.map(seconds => ({ StartPositionTicks: BigInt(Math.trunc(seconds * 10000000)) })) };
}
