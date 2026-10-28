import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackTransportSummary, projectHlsRequestIdentities, projectPlaybackRequestUrl, projectPlaybackTransportBody } from '../helpers/playback-transport-projection.js';

test('playback transport summaries bind real URL identities while retaining opaque values and field roles', () => {
  const identities = { token: 'actual-token', playSessionId: 'actual-session' };
  const url = '/Videos/item/stream.mp4?ApiKey=actual-token&PlaySessionId=actual-session&Title=actual-token';
  const opaque = { PlaySessionId: 'provider-session', Title: 'actual-token', Url: url };
  const body = { PlaySessionId: identities.playSessionId, MediaSources: [{ TranscodingUrl: url, Name: url,
    RequiredHttpHeaders: opaque, Unknown: { ...opaque } }], Unknown: opaque };
  const original = structuredClone(body), projected = playbackTransportSummary(body, identities.token);
  assert.equal(Object.hasOwn(projected, 'PlaySessionId'), false);
  assert.equal(projected.MediaSources[0].TranscodingUrl, '/Videos/item/stream.mp4?ApiKey=<token>&PlaySessionId=<session>&Title=actual-token');
  assert.equal(projected.MediaSources[0].Name, url);
  assert.deepEqual(projected.MediaSources[0].RequiredHttpHeaders, opaque); assert.deepEqual(projected.Unknown, opaque);
  const missing = structuredClone(body); delete missing.PlaySessionId;
  assert.throws(() => playbackTransportSummary(missing, identities.token));
  assert.throws(() => projectPlaybackRequestUrl(url, { ...identities, token: 'wrong' }));
  assert.throws(() => projectPlaybackRequestUrl(url, { ...identities, playSessionId: 'wrong' }));
  for (const field of Object.keys(opaque)) {
    const changed = structuredClone(body); changed.MediaSources[0].RequiredHttpHeaders[field] += '-changed';
    assert.notDeepEqual(playbackTransportSummary(changed, identities.token), projected, field);
  }
  assert.deepEqual(body, original);
});

test('complete playback transport bodies retain session presence and bind only declared stream URLs and paths', () => {
  const token = 'actual-token', playSessionId = 'actual-session';
  const url = '/Videos/item/Subtitles/5/Stream.vtt?api_key=actual-token';
  const opaque = { DeliveryUrl: url, Path: 'Z:\\Sidecars\\fixture.srt', PlaySessionId: playSessionId, traceId: token };
  const body = { PlaySessionId: playSessionId, MediaSources: [{ MediaStreams: [{ Path: opaque.Path, DeliveryUrl: url,
    Title: token, Unknown: structuredClone(opaque) }], RequiredHttpHeaders: structuredClone(opaque) }], Unknown: structuredClone(opaque) };
  const project = value => projectPlaybackTransportBody(value, { status: 200, token, path: value => value.replace('Z:\\Sidecars', '<sidecars>') });
  const projected = project(body);
  assert.equal(projected.PlaySessionId, '$play-session');
  assert.equal(projected.MediaSources[0].MediaStreams[0].Path, '<sidecars>\\fixture.srt');
  assert.equal(projected.MediaSources[0].MediaStreams[0].DeliveryUrl, '/Videos/item/Subtitles/5/Stream.vtt?api_key=<token>');
  assert.deepEqual(projected.MediaSources[0].MediaStreams[0].Unknown, opaque);
  assert.deepEqual(projected.MediaSources[0].RequiredHttpHeaders, opaque); assert.deepEqual(projected.Unknown, opaque);
  const absent = structuredClone(body); delete absent.PlaySessionId;
  assert.notDeepEqual(project(absent), projected);
  const changed = structuredClone(body); changed.MediaSources[0].MediaStreams[0].Title = 'different-token';
  assert.notDeepEqual(project(changed), projected);
  const invalid = structuredClone(body); invalid.MediaSources[0].MediaStreams[0].DeliveryUrl = url + '-wrong';
  assert.throws(() => project(invalid));
  assert.deepEqual(projectPlaybackTransportBody(body, { status: 400, token }), body);
});

test('HLS fixture identity bindings affect URI roles rather than titles or extension metadata', () => {
  const identities = { token: 'actual-token', playSessionId: 'actual-session' };
  const url = 'segment.ts?api_key=actual-token&PlaySessionId=actual-session';
  const text = '#EXTM3U\r\n#EXT-X-MAP:URI="' + url + '"\r\n#EXTINF:4,Title ' + url
    + '\r\n#EXT-X-SESSION-DATA:DATA-ID="literal",VALUE="' + url + '"\r\n' + url + '\r\n';
  const projected = projectHlsRequestIdentities(text, identities), mapped = 'segment.ts?api_key=<token>&PlaySessionId=<session>';
  assert.equal(projected, '#EXTM3U\r\n#EXT-X-MAP:URI="' + mapped + '"\r\n#EXTINF:4,Title ' + url
    + '\r\n#EXT-X-SESSION-DATA:DATA-ID="literal",VALUE="' + url + '"\r\n' + mapped + '\r\n');
  assert.notEqual(projectHlsRequestIdentities(text.replace('Title ', 'Changed '), identities), projected);
  const extensions = '#EXT-X-MAP:X-URI="' + url + '",CUSTOM="literal,URI=opaque",URI="' + url + '"\n';
  assert.equal(projectHlsRequestIdentities(extensions, identities),
    '#EXT-X-MAP:X-URI="' + url + '",CUSTOM="literal,URI=opaque",URI="' + mapped + '"\n');
});
