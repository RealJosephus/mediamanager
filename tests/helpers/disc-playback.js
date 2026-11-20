import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runMediaTool } from './media-tool.js';

const playlistUris = text => text.split(/\r?\n/u).filter(line => line && !line.startsWith('#'));

export async function captureDiscPlayback({ origin, token, itemId, detail, root, label, report, signal }) {
  const authorization = `MediaBrowser Client="Disc fixture", Device="Isolated", DeviceId="fixture-oracle", Version="1", Token="${token}"`;
  const request = async (uri, options) => {
    const url = new URL(uri, origin);
    assert.equal(url.origin, origin);
    const response = await fetch(url, { ...options, redirect: 'error', signal, headers: { Authorization: authorization, ...options?.headers } });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, mime: response.headers.get('content-type')?.split(';')[0], bytes };
  };
  const sourceVideo = detail.MediaStreams.find(stream => stream.Type === 'Video');
  const sourceAudio = detail.MediaStreams.find(stream => stream.Type === 'Audio');
  assert.ok(sourceVideo);
  const result = {};
  for (const protocol of ['http', 'hls']) {
    const videoCodec = protocol === 'hls' ? 'h264' : sourceVideo.Codec;
    const body = { MediaSourceId: itemId, SubtitleStreamIndex: -1, EnableDirectPlay: false, EnableDirectStream: false,
      AudioStreamIndex: sourceAudio?.Index ?? -1, DeviceProfile: { MaxStreamingBitrate: 120000000,
        TranscodingProfiles: [{ Type: 'Video', Context: 'Streaming', Protocol: protocol, Container: 'ts',
          VideoCodec: videoCodec, AudioCodec: sourceAudio?.Codec ?? 'ac3' }] } };
    const response = await request(`/Items/${itemId}/PlaybackInfo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, response.bytes.toString());
    const playback = JSON.parse(response.bytes);
    const source = playback.MediaSources[0];
    assert.equal(source.VideoType, detail.VideoType);
    assert.equal(source.SupportsTranscoding, true);
    assert.ok(source.TranscodingUrl);
    const stream = new URL(source.TranscodingUrl, origin);
    assert.equal(stream.searchParams.get('VideoCodec'), videoCodec);
    const observed = report[protocol] = { profile: body.DeviceProfile, videoType: source.VideoType, commands: [] };
    try {
      const head = await request(stream, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.bytes.length, 0);
      let mediaUrl = stream;
      if (protocol === 'hls') {
        const master = await request(stream);
        assert.equal(master.status, 200, master.bytes.toString());
        const variant = new URL(playlistUris(master.bytes.toString())[0], stream);
        const playlist = await request(variant);
        assert.equal(playlist.status, 200, playlist.bytes.toString());
        assert.match(playlist.bytes.toString(), /^#EXTM3U/u);
        mediaUrl = new URL(playlistUris(playlist.bytes.toString())[0], variant);
        observed.segmentCount = playlistUris(playlist.bytes.toString()).length;
      }
      const media = await request(mediaUrl);
      assert.equal(media.status, 200, media.bytes.subarray(0, 180).toString());
      assert.ok(media.bytes.length > 188);
      observed.mime = media.mime;
      observed.bytes = media.bytes.length;
      const filename = path.join(root, `${label}-${protocol}.ts`);
      await writeFile(filename, media.bytes, { flag: 'wx', signal });
      const decoded = await runMediaTool('ffmpeg', ['-v', 'error', '-i', filename, '-map', '0:v:0', '-an', '-sn',
        '-fps_mode', 'passthrough', '-f', 'framemd5', '-'], observed.commands, signal);
      const frames = decoded.toString().split(/\r?\n/u).filter(line => /^0\s*,/u.test(line)).map(line => line.split(',').at(-1).trim());
      assert.ok(frames.length > 1, 'Playback yielded multiple decodable frames.');
      if (protocol === 'http') assert.ok(frames.length > (sourceVideo.RealFrameRate ?? 30) * 2,
        'Progressive playback decodes frames beyond a single compact disc clip.');
      result[protocol] = { frames, codec: videoCodec };
    } finally {
      const stop = await request('/Videos/ActiveEncodings?' + new URLSearchParams({ deviceId: 'fixture-oracle', playSessionId: playback.PlaySessionId }),
        { method: 'DELETE' });
      assert.equal(stop.status, 204);
      observed.stop = stop.status;
    }
  }
  return result;
}
