import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseLosslessJson } from '../../../src/core/json.js';
import { hlsManifestProjection, subtitleLayoutProjection } from '../../playback/layout-projection.js';

export const samiMediaFilename = 'feature.ko.smi';
export const samiFallbackMediaFilename = 'feature.it.sami';
export const samiMediaBytes = updated => Buffer.from('\uFEFF' + [
  '<SAMI>', '<HEAD><TITLE>Discovered SAMI subtitle</TITLE></HEAD>', '<BODY>',
  '<SYNC Start=0><P Class=KRCC>' + (updated ? 'Native changed subtitle 中文' : 'Node discovered subtitle 中文'),
  '<SYNC Start=500><P Class=KRCC>&nbsp;',
  '<SYNC Start=600><P Class=KRCC>Before <i>italic</i><br>After &amp; text',
  '<SYNC Start=1000><P Class=KRCC>&nbsp;', '</BODY>', '</SAMI>', '',
].join('\r\n'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function cacheFile(filename) {
  let bytes;
  try { bytes = await readFile(filename); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { exists: false }; throw error; }
  return { exists: true, bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') };
}
const profile = {
  Name: 'Discovered SAMI external text', MaxStreamingBitrate: 100000000,
  DirectPlayProfiles: [{ Type: 'Video', Container: 'mkv', VideoCodec: 'mpeg2video', AudioCodec: 'ac3' }],
  SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }],
};

/** Observe the public consumers of an actually probed and saved external stream. */
export function observeSamiMediaConsumer(options) {
  return observeConsumer({ ...options, filename: samiMediaFilename, language: 'kor', fallback: false });
}

export function observeSamiFallbackMediaConsumer(options) {
  return observeConsumer({ ...options, filename: samiFallbackMediaFilename, language: 'ita', fallback: true });
}

async function observeConsumer({ stage, database, origin, token, itemId, identityRoot, source, signal, observations, filename, language, fallback, dataPath }) {
  const observation = { stage, input: { filename, bytes: source.length, sha256: sha(source), base64: source.toString('base64') }, requests: [] };
  observations.push(observation);
  const identity = path.join(identityRoot, filename);
  const streams = await database.rows('MediaStreamInfos', { where: { ItemId: itemId } });
  const stream = streams.find(value => value.Path === identity);
  observation.savedStreams = streams;
  assert.ok(stream, stage + ': normal external discovery saved the SAMI stream');
  assert.equal(stream.StreamType, 2); assert.equal(stream.IsExternal, true);
  assert.equal(stream.Codec, 'sami'); assert.equal(stream.Language, language);
  const id = itemId.replaceAll('-', '').toLowerCase();
  const request = async (route, options = {}, textual = false, expectedStatus = 200) => {
    signal?.throwIfAborted();
    const record = { route, method: options.method ?? 'GET', ...(options.body ? { body: options.body } : {}) };
    observation.requests.push(record);
    const response = await fetch(new URL(route, origin), { ...options, headers: { Authorization: `MediaBrowser Token="${token}"`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, signal });
    const bytes = Buffer.from(await response.arrayBuffer());
    Object.assign(record, { status: response.status, headers: Object.fromEntries(response.headers), bytes: bytes.length, sha256: sha(bytes),
      ...(textual ? { bodyText: bytes.toString('utf8') } : { base64: bytes.toString('base64') }) });
    assert.equal(response.status, expectedStatus, stage + ': ' + new URL(route, origin).pathname + '\n'
      + bytes.toString('utf8').replaceAll(token, '[isolated credential redacted]'));
    if (response.headers.has('content-length')) assert.equal(Number(response.headers.get('content-length')), bytes.length);
    return { record, bytes };
  };
  const info = await request(`/Items/${id}/PlaybackInfo`, { method: 'POST',
    body: JSON.stringify({ MediaSourceId: id, SubtitleStreamIndex: stream.StreamIndex, DeviceProfile: profile }) }, true);
  const mediaSource = parseLosslessJson(info.record.bodyText).MediaSources.find(value => value.Id.toLowerCase() === id);
  assert.ok(mediaSource, stage + ': PlaybackInfo contains the saved media source');
  const delivered = mediaSource.MediaStreams.find(value => value.Index === stream.StreamIndex);
  assert.ok(delivered); assert.equal(delivered.Codec, 'sami'); assert.equal(delivered.IsExternal, true);
  assert.equal(delivered.IsTextSubtitleStream, true); assert.equal(delivered.DeliveryMethod, 'External');
  assert.equal(delivered.Language, language); assert.equal(typeof delivered.DeliveryUrl, 'string');
  const deliveryUrl = new URL(delivered.DeliveryUrl, origin);
  assert.equal(deliveryUrl.origin, new URL(origin).origin);
  assert.match(deliveryUrl.pathname, /\/Subtitles\/\d+\/0\/Stream\.vtt$/u);
  const route = format => `/Videos/${id}/${id}/Subtitles/${stream.StreamIndex}/Stream.${format}?copyTimestamps=true`;
  if (fallback) {
    assert.equal(typeof dataPath, 'string', stage + ': the persistent subtitle cache belongs to the current instance');
    const guid = itemId.toLowerCase();
    const cachePath = path.join(dataPath, 'subtitles', guid.slice(0, 2), guid, String(stream.StreamIndex) + '.srt');
    const before = { cache: await cacheFile(cachePath), metadata: await cacheFile(cachePath + '.meta') };
    const unsupported = await request(route('sami'), {}, true, 400);
    const cacheBytes = await readFile(cachePath), metadataBytes = await readFile(cachePath + '.meta');
    assert.ok(cacheBytes.length > 0, stage + ': unsupported SAMI writer leaves a readable persistent SRT');
    assert.match(metadataBytes.toString('utf8'), /^\d+:\d+$/u);
    observation.unsupported = unsupported.record;
    observation.cache = { path: cachePath, before, bytes: cacheBytes.length, sha256: sha(cacheBytes), base64: cacheBytes.toString('base64'),
      metadata: { bytes: metadataBytes.length, sha256: sha(metadataBytes), base64: metadataBytes.toString('base64') } };
    const srt = await request(route('srt'));
    assert.equal(srt.record.headers['content-type'], 'application/x-subrip');
    observation.cache.afterSrtConsumer = { cache: await cacheFile(cachePath), metadata: await cacheFile(cachePath + '.meta') };
    assert.deepEqual(Buffer.from(observation.cache.afterSrtConsumer.cache.base64, 'base64'), cacheBytes,
      stage + ': SRT consumption preserves the persistent cache bytes');
    assert.deepEqual(Buffer.from(observation.cache.afterSrtConsumer.metadata.base64, 'base64'), metadataBytes,
      stage + ': SRT consumption preserves the persistent source fingerprint');
    observation.srt = srt.record;
  } else {
    const original = await request(route('smi'));
    assert.deepEqual(original.bytes, source, stage + ': original SAMI bytes retain their explicit UTF-8 BOM');
    observation.original = original.record;
  }
  const vtt = await request(route('vtt')), cues = await request(route('json')), negotiated = await request(deliveryUrl.href);
  assert.equal(vtt.record.headers['content-type'], 'text/vtt');
  assert.equal(cues.record.headers['content-type'], 'application/json');
  assert.deepEqual(subtitleLayoutProjection(negotiated.bytes.toString('utf8'), 'vtt'), subtitleLayoutProjection(vtt.bytes.toString('utf8'), 'vtt'));
  const playlistRoute = `/Videos/${id}/${id}/Subtitles/${stream.StreamIndex}/subtitles.m3u8?SegmentLength=1`;
  const playlist = await request(playlistRoute, {}, true);
  assert.equal(playlist.record.headers['content-type'], 'application/vnd.apple.mpegurl');
  const segment = playlist.record.bodyText.split(/\r\n|\n/u).find(line => line && !line.startsWith('#'));
  assert.equal(typeof segment, 'string', stage + ': the actual subtitle playlist contains a segment');
  const segmentUrl = new URL(segment, new URL(playlistRoute, origin));
  assert.equal(segmentUrl.origin, new URL(origin).origin);
  assert.equal(segmentUrl.searchParams.get('StartPositionTicks'), '0');
  assert.equal(segmentUrl.searchParams.get('CopyTimestamps'), 'true');
  assert.equal(segmentUrl.searchParams.get('AddVttTimeMap'), 'true');
  const hlsSegment = await request(segmentUrl.href);
  assert.equal(hlsSegment.record.headers['content-type'], 'text/vtt');
  assert.match(hlsSegment.bytes.toString('utf8'), /^WEBVTT\r?\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00\.000\r?\n/u);
  Object.assign(observation, { vtt: vtt.record, cues: cues.record, negotiated: negotiated.record,
    hlsPlaylist: playlist.record, hlsSegment: hlsSegment.record });
  return observation;
}

export function assertSameSamiMediaConsumer(actual, expected) {
  assert.equal(actual.input.sha256, expected.input.sha256);
  assert.deepEqual(subtitleLayoutProjection(Buffer.from(actual.vtt.base64, 'base64').toString('utf8'), 'vtt'),
    subtitleLayoutProjection(Buffer.from(expected.vtt.base64, 'base64').toString('utf8'), 'vtt'), actual.stage + ': actual generated WebVTT');
  const cues = value => {
    const parsed = parseLosslessJson(Buffer.from(value.cues.base64, 'base64').toString('utf8'));
    return { ...parsed, TrackEvents: parsed.TrackEvents.map(cue => ({ ...cue, Text: cue.Text.split(/\r\n|\r|\n/u) })) };
  };
  assert.deepEqual(cues(actual), cues(expected), actual.stage + ': complete public cue timing, text and markup');
  assert.deepEqual(hlsManifestProjection(actual.hlsPlaylist.bodyText), hlsManifestProjection(expected.hlsPlaylist.bodyText),
    actual.stage + ': complete actual subtitle playlist');
  assert.deepEqual(subtitleLayoutProjection(Buffer.from(actual.hlsSegment.base64, 'base64').toString('utf8'), 'vtt'),
    subtitleLayoutProjection(Buffer.from(expected.hlsSegment.base64, 'base64').toString('utf8'), 'vtt'),
    actual.stage + ': actual HLS segment text, timestamps and timestamp map');
  if (actual.srt || expected.srt) {
    assert.equal(actual.unsupported.status, expected.unsupported.status);
    assert.equal(actual.unsupported.headers['content-type'], expected.unsupported.headers['content-type']);
    assert.equal(actual.unsupported.bodyText, expected.unsupported.bodyText);
    assert.equal(actual.srt.headers['content-type'], expected.srt.headers['content-type']);
    assert.deepEqual(subtitleLayoutProjection(Buffer.from(actual.srt.base64, 'base64').toString('utf8'), 'srt'),
      subtitleLayoutProjection(Buffer.from(expected.srt.base64, 'base64').toString('utf8'), 'srt'), actual.stage + ': actual converted SRT consumer');
  }
}

export async function assertRestoredSamiCache({ stage, dataPath, expected, observations }) {
  const guid = expected.savedStreams.find(stream => stream.Codec === 'sami'
    && path.basename(stream.Path ?? '') === samiFallbackMediaFilename).ItemId.toLowerCase();
  const filename = path.join(dataPath, 'subtitles', guid.slice(0, 2), guid, path.basename(expected.cache.path));
  const bytes = await readFile(filename), metadata = await readFile(filename + '.meta');
  const observation = { stage, filename, bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64'),
    metadata: { bytes: metadata.length, sha256: sha(metadata), base64: metadata.toString('base64') },
    sourceCacheSha256: expected.cache.sha256, sourceMetadataSha256: expected.cache.metadata.sha256 };
  observations.push(observation);
  assert.deepEqual(bytes, Buffer.from(expected.cache.base64, 'base64'), stage + ': state package retains the complete converted SRT');
  assert.deepEqual(metadata, Buffer.from(expected.cache.metadata.base64, 'base64'), stage + ': state package retains the exact source fingerprint');
}
