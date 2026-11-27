import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { channelMediaSourceCachePath } from '../../src/library/channel-static-media-sources.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import { postgresTestRow } from '../database/postgres-fixture.js';
import { createMetadataHttpFixture } from '../helpers/metadata-http-fixture.js';
import { startHttpSource } from '../storage/helpers/http-source.js';

export const requiredValidationServices = ['postgres'];

test('a signed-in listener can use forced remote transcoding through PlaybackInfo, Universal Audio and HLS', { timeout: 120000 }, async t => {
  const { runtime, database, request, reader } = await createMetadataHttpFixture(t);
  const bytes = execFileSync(validationExecutable('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', '-f', 'mp3', 'pipe:1'], { windowsHide: true });
  const upstream = await startHttpSource({ bytes });
  t.after(() => upstream.close());
  const id = 'cb100000-0000-0000-0000-000000000001', channel = 'cb100000-0000-0000-0000-000000000002';
  for (const [recordId, type, name] of [[channel, 'MediaBrowser.Controller.Channels.Channel', 'Audio station'],
    [id, 'MediaBrowser.Controller.Entities.Audio.Audio', 'Remote tone']]) {
    await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: recordId, ChannelId: channel,
      Type: type, Name: name, SortName: name, Data: '{}', IsFolder: recordId === channel,
      MediaType: recordId === channel ? null : 'Audio', PresentationUniqueKey: recordId.replaceAll('-', '') }));
  }
  const cache = channelMediaSourceCachePath({ Id: id, ChannelId: channel, SourceType: 'Channel', Type: 'Audio' }, runtime.applicationPaths.metadataPath);
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, JSON.stringify([{ Id: id.replaceAll('-', ''), Protocol: 'Http', Path: upstream.origin + '/tone.mp3',
    Type: 'Default', Container: 'mp3', IsRemote: true, SupportsTranscoding: true, SupportsDirectPlay: true, SupportsDirectStream: true,
    Bitrate: 96000, RunTimeTicks: 20000000, MediaStreams: [{ Type: 'Audio', Index: 0, Channels: 1, SampleRate: 44100, Codec: 'mp3', BitRate: 96000 }] }]));
  const read = route => request(route, { token: reader, accept: '*/*' });
  const probe = async (route, codec) => {
    const response = await read(route);
    assert.equal(response.status, 200, response.status === 200 ? undefined : response.bytes.toString());
    const info = JSON.parse(execFileSync(validationExecutable('ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', 'pipe:0'],
      { input: response.bytes, encoding: 'utf8', windowsHide: true }));
    assert.deepEqual(info.streams.map(stream => stream.codec_name), [codec]);
  };
  const account = (await request('/Users/Me', { token: reader })).body;
  const update = async allow => {
    const policy = { ...account.Policy, ForceRemoteSourceTranscoding: true, EnableAudioPlaybackTranscoding: allow };
    assert.equal((await request('/Users/' + account.Id + '/Policy', { method: 'POST', body: policy })).status, 204);
    const persisted = (await request('/Users/Me', { token: reader })).body.Policy;
    assert.equal(persisted.ForceRemoteSourceTranscoding, true);
    assert.equal(persisted.EnableAudioPlaybackTranscoding, allow);
  };
  const playbackInfo = async () => {
    const response = await request('/Items/' + id + '/PlaybackInfo', { method: 'POST', token: reader, body: { DeviceProfile: {
      DirectPlayProfiles: [{ Type: 'Audio', Container: 'mp3', AudioCodec: 'mp3' }],
      TranscodingProfiles: [{ Type: 'Audio', Context: 'Streaming', Protocol: 'http', Container: 'wav', AudioCodec: 'pcm_s16le' }],
    } } });
    assert.equal(response.status, 200);
    return response.body.MediaSources[0];
  };
  const route = '/Audio/' + id + '/universal';
  const wav = route + '?Container=wav&AudioCodec=pcm_s16le&TranscodingContainer=wav';
  assert.equal((await playbackInfo()).SupportsDirectPlay, true);
  await probe(wav, 'pcm_s16le');
  await update(true);
  const source = await playbackInfo();
  assert.equal(source.IsRemote, true);
  assert.equal(source.SupportsDirectPlay, false);
  assert.equal(source.SupportsDirectStream, false);
  assert.equal(source.SupportsTranscoding, true);
  const playback = new URL(source.TranscodingUrl, 'http://fixture.invalid');
  assert.equal(playback.searchParams.get('allowAudioStreamCopy'), 'false');
  assert.equal(playback.searchParams.get('allowVideoStreamCopy'), 'false');
  await probe(playback.pathname + playback.search, 'pcm_s16le');
  await probe(wav, 'pcm_s16le');

  assert.equal((await read(route + '?Container=mp3&AudioCodec=copy&TranscodingContainer=mp3')).status, 400);
  const hls = route + '?Container=ts%7Cmp3&TranscodingContainer=ts&TranscodingProtocol=hls&AudioCodec=aac';
  const firstUri = async route => {
    const response = await read(route);
    assert.equal(response.status, 200);
    const lines = response.bytes.toString().split(/\r?\n/u);
    assert.equal(lines[0], '#EXTM3U');
    const next = new URL(lines.find(line => line && !line.startsWith('#')), 'http://fixture.invalid' + route);
    return next.pathname + next.search;
  };
  const variant = await firstUri(hls);
  assert.equal(new URL(variant, 'http://fixture.invalid').searchParams.get('AudioCodec'), 'aac');
  await probe(await firstUri(variant), 'aac');
  await update(false);
  const reads = upstream.events.length, denied = await playbackInfo();
  assert.equal(denied.SupportsDirectPlay, false);
  assert.equal(denied.SupportsTranscoding, false);
  assert.ok(!denied.TranscodingUrl);
  assert.equal((await read(wav)).status, 400);
  assert.equal((await read(hls)).status, 400);
  assert.equal(upstream.events.length, reads);
});
