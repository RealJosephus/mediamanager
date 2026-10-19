import test from 'node:test';
import assert from 'node:assert/strict';
import { negotiateSource } from '../../src/playback/profile.js';
import { PlaybackService } from '../../src/playback/service.js';
import { remuxPlan, remuxArguments } from '../../src/playback/remux.js';
import { StorageError } from '../../src/storage/errors.js';
import reference from './fixtures/remux-reference.json' with { type: 'json' };

test('native StreamBuilder remux URLs match for 31 copy-compatible profiles', () => {
  for (const entry of reference.profiles) {
    const source = structuredClone(reference.sources.find(source => source.name === entry.sourceName).source);
    negotiateSource(source, { Id: source.Id, MediaType: entry.mediaType }, entry.profile, { ...entry.options,
      CanRemux: (source, options) => { try { remuxPlan(source, options); return true; } catch { return false; } }, DeviceId: 'remux-fixture', PlaySessionId: 'fixture-session', AccessToken: 'fixture-token' });
    const native = reference.oracle.find(value => value.name === entry.name);
    if (['no-video-copy', 'no-audio-copy', 'wrong-codec', 'bitrate', 'video-RefFrames', 'video-VideoRotation'].includes(entry.name)) {
      assert.ok(native.url); assert.equal(source.SupportsTranscoding, false); assert.equal(source.TranscodingUrl, undefined);
    } else assert.equal(source.TranscodingUrl, native.url, entry.name);
  }
});

test('copy plans enforce stream identity, container constraints and native EOF seek clamp', () => {
  const source = reference.sources[0].source;
  for (const options of [{ Container: 'hls' }, { Container: 'mp4', AudioStreamIndex: 99 }, { Container: 'webm' }, { Container: 'mp4', MaxAudioChannels: 1 },
    { Container: 'mp4', VideoCodec: 'hevc' }, { Container: 'mp4', AudioSampleRate: 48000 }, { Container: 'mp4', StreamOptions: { 'h264-level': '1' } }, { Container: 'mp4', EnableAutoStreamCopy: false }]) assert.throws(() => remuxPlan(source, options), { code: 'not-supported' });
  const plan = remuxPlan(source, { Container: 'mp4', StartTimeTicks: 20000000 });
  assert.equal(plan.start, BigInt(source.RunTimeTicks) - 50000000n);
  const args = remuxArguments('http://127.0.0.1:1/' + 'a'.repeat(64), plan);
  assert.equal(args[args.indexOf('-c') + 1], 'copy');
  assert.equal(args[args.indexOf('-fflags') + 1], '+genpts');
  assert.throws(() => remuxArguments('file:///source.mkv', plan));
  const audio = remuxPlan(reference.sources[1].source, { Container: 'm4a', MediaType: 'Audio' });
  assert.deepEqual(audio.streams.map(stream => stream.type), ['Audio']);
  const sparse = { ...source, MediaStreams: source.MediaStreams.filter(stream => stream.Index !== 1), DefaultAudioStreamIndex: 2 };
  assert.deepEqual(remuxPlan(sparse, { Container: 'mp4' }).streams.map(stream => stream.index), [0, 2]);
  assert.deepEqual(remuxPlan({ ...source, VideoType: 'Iso', IsoType: 'BluRay' }, { Container: 'mp4' }),
    remuxPlan(source, { Container: 'mp4' }), 'ISO sources use the same audited packet-copy limits');
  assert.throws(() => remuxPlan({ ...source, VideoType: 'Iso' }, { Container: 'mp4', VideoCodec: 'hevc' }), { code: 'not-supported' });
});

test('PlaybackInfo advertises remux and HLS only for sources resolvable through identity mapping and VFS', async () => {
  const fixture = reference.sources[0].source;
  const item = { Id: '22222222-2222-2222-2222-222222222222', MediaType: 'Video' };
  const source = { ...structuredClone(fixture), Path: 'https://media.invalid/source.mkv', Protocol: 'Http', IsRemote: true };
  let mapped = false, mounted = false;
  const library = {
    getItemRecord: async () => item,
    getMediaSources: async () => [structuredClone(source)],
  };
  const identityMap = { resolve: () => {
    if (!mapped) throw new StorageError('invalid-path', 'The remote source has no access mapping.');
    return '/media/source.mkv';
  } };
  const vfs = { resolve: () => {
    if (!mounted) throw new StorageError('not-found', 'The access path is not mounted.');
    return { path: '/source.mkv' };
  } };
  const copyExecutor = { initialize: async () => {}, supports: () => true };
  const service = new PlaybackService({ library, identityMap, vfs, remux: copyExecutor, hls: copyExecutor, sessions: {} });
  const user = { Policy: { EnablePlaybackRemuxing: true, EnableMediaPlayback: true, RemoteClientBitrateLimit: 0 } };
  const info = profile => service.info(item.Id, { user, auth: { Token: 'token', DeviceId: 'device' }, posted: true,
    DeviceProfile: profile, EnableDirectPlay: false });
  const profile = protocol => ({ DirectPlayProfiles: [], TranscodingProfiles: [{ Type: 'Video', Context: 'Streaming', Protocol: protocol,
    Container: protocol === 'hls' ? 'ts' : 'mp4', VideoCodec: 'h264', AudioCodec: 'aac' }] });
  const sourceInfo = async protocol => (await info(profile(protocol))).MediaSources[0];

  for (const protocol of ['http', 'hls']) {
    const unresolved = await sourceInfo(protocol);
    assert.equal(unresolved.SupportsTranscoding, false, `${protocol}: unmapped source`);
    assert.equal(unresolved.TranscodingUrl, undefined, `${protocol}: unmapped source URL`);
  }
  mapped = true;
  for (const protocol of ['http', 'hls']) {
    const unresolved = await sourceInfo(protocol);
    assert.equal(unresolved.SupportsTranscoding, false, `${protocol}: unmounted access path`);
    assert.equal(unresolved.TranscodingUrl, undefined, `${protocol}: unmounted access path URL`);
  }
  mounted = true;
  for (const protocol of ['http', 'hls']) {
    const resolved = await sourceInfo(protocol);
    assert.equal(resolved.SupportsTranscoding, true, `${protocol}: resolved source`);
    assert.ok(resolved.TranscodingUrl, `${protocol}: executable URL`);
  }
});
