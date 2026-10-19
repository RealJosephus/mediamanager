import test from 'node:test';
import assert from 'node:assert/strict';
import { blurayMediaStreams, mergeBlurayProbe } from '../../src/storage/bluray-probe-info.js';

const plan = {
  runTimeTicks: 35000000n, chapters: [0, 1.5], streams: [
    { pid: 4113, streamType: 2, mediaStream: { Type: 'Video', Codec: 'mpeg2video', Height: 480 } },
    { pid: 4113, streamType: 2, angleIndex: 1, mediaStream: { Type: 'Video', Codec: 'mpeg2video', Height: 480 } },
    { pid: 4352, streamType: 129, mediaStream: { Type: 'Audio', Codec: 'AC3', SampleRate: 48000, Language: 'eng' } },
  ],
};

test('Blu-ray merge retains first-file metadata and fills only the first playlist video', () => {
  const first = { Size: 777n, Bitrate: 1000000, Container: 'ts', Name: 'First title', Timestamp: 'Valid', RunTimeTicks: 90000000n,
    MediaAttachments: [{ FileName: 'first.ttf' }], Chapters: [{ StartPositionTicks: 50000000n }],
    MediaStreams: [{ Type: 'Video', Codec: 'mpeg2video', Width: 720, Height: 576, BitRate: 500000, PixelFormat: 'yuv420p',
      Profile: 'Main', ColorSpace: 'bt470bg', BitDepth: 8 }, { Type: 'Audio', Channels: 1 }] };
  const reference = { format: { size: '999', duration: '100', tags: { title: 'Wrong title' } }, streams: [
    { id: '0x1101', codec_type: 'audio', codec_name: 'ac3', channels: 1, channel_layout: 'mono', bit_rate: '64000' },
    { id: '0x1100', codec_type: 'audio', codec_name: 'ac3', channels: 6, channel_layout: '5.1(side)', bit_rate: '448000', sample_rate: '48000' },
  ] };
  const merged = mergeBlurayProbe(plan, first, reference);
  assert.deepEqual([merged.Size, merged.Bitrate, merged.Container, merged.Name, merged.Timestamp], [777n, 1000000, 'ts', 'First title', 'Valid']);
  assert.deepEqual(merged.MediaAttachments, [{ FileName: 'first.ttf' }]);
  assert.equal(merged.RunTimeTicks, 35000000n);
  assert.deepEqual(merged.Chapters, [{ StartPositionTicks: 0n }, { StartPositionTicks: 15000000n }]);
  assert.deepEqual(merged.MediaStreams.map(stream => [stream.Width ?? null, stream.Height ?? null, stream.BitRate]),
    [[720, 480, 500000], [0, 480, 0], [null, null, 448000]]);
  assert.equal(merged.MediaStreams[0].PixelFormat, 'yuv420p');
  assert.equal(merged.MediaStreams[0].Profile, undefined);
  assert.equal(merged.MediaStreams[1].PixelFormat, undefined);
  assert.deepEqual([merged.MediaStreams[2].Channels, merged.MediaStreams[2].ChannelLayout, merged.MediaStreams[2].Language], [6, '5.1', 'eng']);
  assert.equal(first.RunTimeTicks, 90000000n); assert.equal(plan.streams[0].mediaStream.Width, undefined);
});

test('Blu-ray reference audio never estimates bitrate or LFE from a channel count', () => {
  const audioPlan = { streams: [
    { pid: 4352, streamType: 131, mediaStream: { Type: 'Audio', Codec: 'TrueHD', SampleRate: 48000 } },
    { pid: 4353, streamType: 129, mediaStream: { Type: 'Audio', Codec: 'AC3', SampleRate: 48000 } },
  ] };
  const raw = { streams: [
    { id: '0x1100', codec_type: 'audio', codec_name: 'ac3', channels: 2, channel_layout: 'stereo', bit_rate: '192000' },
    { id: '0x1100', codec_type: 'audio', codec_name: 'truehd', channels: 8, channel_layout: '7.1', sample_rate: '96000', bit_rate: '9000000' },
    { id: '0x1101', codec_type: 'audio', codec_name: 'ac3', channels: 6, channel_layout: 'FL+FR+FC+LFE+SL+SR' },
  ] };
  const streams = blurayMediaStreams(audioPlan, raw);
  assert.deepEqual(streams.map(stream => [stream.Channels, stream.ChannelLayout, stream.SampleRate, stream.BitRate]),
    [[8, '7.1', 96000, null], [6, '5.1', 48000, null]]);
  raw.streams[1].profile = 'Dolby TrueHD + Dolby Atmos';
  const atmos = blurayMediaStreams(audioPlan, raw)[0];
  assert.equal(atmos.Codec, 'Atmos'); assert.equal(atmos.Profile, undefined);
  const eac3 = blurayMediaStreams({ streams: [{ ...audioPlan.streams[0], streamType: 132,
    mediaStream: { ...audioPlan.streams[0].mediaStream, Codec: 'eac3' } }] }, { streams: [
    { ...raw.streams[1], codec_name: 'eac3', profile: 'Dolby Digital Plus + Dolby Atmos' }
  ] })[0];
  assert.equal(eac3.Codec, 'eac3'); assert.equal(eac3.Profile, undefined);
  delete raw.streams[2].channel_layout;
  assert.throws(() => blurayMediaStreams(audioPlan, raw), { code: 'not-supported' });
  assert.deepEqual(blurayMediaStreams(audioPlan, { streams: [] }).map(stream => [stream.Channels, stream.ChannelLayout, stream.BitRate]),
    [[0, '0.0', null], [0, '0.0', null]]);
});

test('Blu-ray MVC requires the reference SSIF and explicit transport type, and preserves native video order and empty fields', () => {
  const mvcPlan = { ...plan, angleCount: 1, referenceSsif: '/disc/BDMV/STREAM/SSIF/00002.ssif' };
  const raw = { streams: [{ id: '0x1012', codec_type: 'video', codec_name: 'h264', codec_tag: '0x0020',
    width: 1920, height: 1080, r_frame_rate: '24/1', bit_rate: '9000000', profile: 'High', pix_fmt: 'yuv420p' }] };
  const completed = blurayMediaStreams(mvcPlan, raw);
  assert.deepEqual(completed.map(stream => [stream.Index, stream.Type, stream.Codec]),
    [[0, 'Video', 'mpeg2video'], [1, 'Video', 'mpeg2video'], [2, 'Video', 'MVC'], [3, 'Video', 'MVC'], [4, 'Audio', 'AC3']]);
  for (const stream of completed.slice(2, 4)) assert.deepEqual(stream,
    { Type: 'Video', Codec: 'MVC', Height: 0, IsInterlaced: false, Index: stream.Index, Width: 0, BitRate: 0 });
  const first = { MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 720, Height: 480, PixelFormat: 'yuv420p' }] };
  assert.deepEqual(mergeBlurayProbe(mvcPlan, first, raw).MediaStreams.slice(2, 4), completed.slice(2, 4));
  assert.equal(blurayMediaStreams({ ...mvcPlan, referenceSsif: null }, raw).length, plan.streams.length);
  assert.equal(blurayMediaStreams(mvcPlan, { streams: [{ ...raw.streams[0], codec_tag: '0x001b' }] })
    .some(stream => stream.Codec === 'MVC'), false, 'an ordinary AVC PID is not an MVC declaration');
  assert.equal(blurayMediaStreams({ ...mvcPlan, streams: [...plan.streams, { pid: 4114, streamType: 0x1b,
    mediaStream: { Type: 'Video', Codec: 'AVC', Height: 480 } }] }, raw).length, plan.streams.length + 1);
});
