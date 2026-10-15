import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { hlsPlan, hlsArguments } from '../../src/playback/hls.js';
import { negotiateSource } from '../../src/playback/profile.js';
import reference from './fixtures/audio-hls-reference.json' with { type: 'json' };
import oracle from './fixtures/audio-hls-oracle.json' with { type: 'json' };

test('audio HLS uses native StreamBuilder URLs and limits execution to packet copy', () => {
  for (const entry of reference.profiles) {
    const source = structuredClone(entry.source);
    negotiateSource(source, { Id: source.Id, MediaType: 'Audio' }, entry.profile, { ...entry.options,
      CanHls: (source, options) => { try { hlsPlan(source, options); return true; } catch { return false; } },
      DeviceId: 'remux-fixture', PlaySessionId: 'fixture-session', AccessToken: 'fixture-token' });
    const native = oracle.find(value => value.name === entry.name);
    if (['wrong-codec', 'no-audio-copy'].includes(entry.name)) { assert.ok(native.url); assert.equal(source.SupportsTranscoding, false); }
    else assert.equal(source.TranscodingUrl, native.url, entry.name);
  }
  const plan = hlsPlan(reference.source, { MediaType: 'Audio', AudioStreamIndex: 1, SegmentContainer: 'mp4' });
  assert.equal(plan.audio.Index, 0, 'The native audio request selects its first valid stream independently of AudioStreamIndex.');
  assert.equal(plan.segmentLength, 3);
  const args = hlsArguments('http://127.0.0.1:1/' + 'a'.repeat(64), plan, tmpdir(), 2, 60000000n);
  assert.equal(args[args.indexOf('-ss') + 1], '00:00:06.000');
  assert.ok(args.includes('-vn')); assert.equal(args[args.indexOf('-codec:a:0') + 1], 'copy');
  for (const option of ['-fflags', '-start_at_zero', '-hls_segment_options', '-codec:v:0']) assert.ok(!args.includes(option));
  for (const options of [{ AudioCodec: 'ac3' }, { AudioBitRate: 128000 }, { AllowAudioStreamCopy: false }, { AudioChannels: 1 }, { AudioSampleRate: 48000 }]) assert.throws(() => hlsPlan(reference.source, { MediaType: 'Audio', ...options }));
});
