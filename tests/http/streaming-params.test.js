import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createTestApplication } from '../helpers/application.js';
import { HttpResult } from '../../src/http/binding.js';

test('progressive and HLS requests overlay nonempty positional parameters after explicit query binding', async t => {
  const id = '11111111111111111111111111111111';
  let delivered;
  const accept = (route, options) => { delivered = { route, options }; return new HttpResult(204); };
  const app = await createTestApplication({
    configuration: { IsStartupWizardCompleted: true },
    authentication: { authenticate: async () => ({ IsAuthenticated: true }), authorize() {} },
    playback: { remuxStream: (_id, options) => accept('remux', options), hlsStream: (_id, name, options) => accept(name, options),
      file: (_id, options) => accept('file', options.streamOptions) },
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const values = ['ignored', 'device', 'source', 'true', 'hevc', 'aac', '2', '-1', '8000000', ' ', '6', '23.5', '1280', '720',
    '9007199254740993', '4.1', '3', '10', 'main', '', 'session', '', '', '', 'TRUE', 'Hls', '2', 'false', 'tag', 'true', 'srt', 'false', 'true', 'VideoCodecNotSupported'];
  const get = (route, fields, explicit = {}) => fetch(`http://127.0.0.1:${app.server.address().port}/${route}?` +
    new URLSearchParams({ videoCodec: 'h264', audioBitRate: '192000', mediaSourceId: 'explicit', ...explicit, params: fields.join(';') }));
  for (const [route, dispatch] of [[`Videos/${id}/stream.ts`, 'remux'], [`Videos/${id}/main.m3u8`, 'main']]) {
    assert.equal((await get(route, values)).status, 204);
    assert.equal(delivered.route, dispatch);
    const expected = { DeviceId: 'device', MediaSourceId: 'source', Static: true, VideoCodec: 'hevc', AudioCodec: 'aac',
      AudioStreamIndex: 2, SubtitleStreamIndex: -1, VideoBitRate: 8000000, AudioBitRate: 192000, MaxAudioChannels: 6,
      MaxFramerate: 23.5, MaxWidth: 1280, MaxHeight: 720, StartTimeTicks: 9007199254740993n, Level: '4.1', MaxRefFrames: 3,
      MaxVideoBitDepth: 10, Profile: 'main', PlaySessionId: 'session', CopyTimestamps: true, SubtitleMethod: 'Hls',
      TranscodingMaxAudioChannels: 2, EnableSubtitlesInManifest: false, Tag: 'tag', RequireAvc: true, SubtitleCodec: 'srt',
      RequireNonAnamorphic: false, DeInterlace: true, TranscodeReasons: 'VideoCodecNotSupported' };
    for (const [key, value] of Object.entries(expected)) assert.equal(delivered.options[key], value, key);
  }
  assert.equal((await get(`Audio/${id}/stream.aac`, ['', '', '', 'true', 'hevc', 'bad codec!', 'unused'], { audioCodec: 'mp3' })).status, 204);
  assert.equal(delivered.route, 'file');
  assert.equal(delivered.options.AudioCodec, 'mp3');
  assert.equal(delivered.options.VideoCodec, 'h264');
  assert.equal(delivered.options.MediaSourceId, 'explicit');
  assert.equal((await get(`Videos/${id}/main.m3u8`, values, { maxWidth: 'bad' })).status, 400);
});
