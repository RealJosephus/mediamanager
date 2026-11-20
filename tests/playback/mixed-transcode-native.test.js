import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { probeStreamRow } from '../../src/library/probe-service.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { normalizeProbe } from '../../src/storage/probe-normalizer.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { nativeGuid } from '../../src/users/native.js';
import { keyframeExtractionTaskId } from '../../src/tasks/keyframe-extraction-task.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestRow } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { readFrozenAv } from '../helpers/frozen-av.js';
import { startOwnedMediaProxy } from '../helpers/library-exchange-media-proxy.js';
import { runMediaTool } from '../helpers/media-tool.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { projectHlsRequestIdentities } from '../helpers/playback-transport-projection.js';
import { createTestRuntime } from '../helpers/runtime.js';
import { extractionFixture } from './extraction-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES);
const nativeCase = declareNativeHttpTestFile({ enabled });
const mediaLease = declareFileTestResource('native-media-5244', { enabled });
const deviceId = 'fixture-oracle';
const itemId = '92500000000000000000000000000001';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const linesWithUris = text => text.split(/\r?\n/u).filter(line => line && !line.startsWith('#'));

async function probe(filename, evidence, signal) {
  return JSON.parse(await runMediaTool('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-show_packets',
    '-show_data_hash', 'sha256', '-of', 'json', filename], evidence.commands, signal));
}

function packets(result, type) {
  const stream = result.streams.find(value => value.codec_type === type);
  assert.ok(stream, type);
  return result.packets.filter(packet => packet.stream_index === stream.index).map(packet => ({
    hash: packet.data_hash, pts: packet.pts_time, dts: packet.dts_time, duration: packet.duration_time,
  }));
}

async function seed(referenceRoot, evidence, signal) {
  const { dataPath, serverId } = await readInstanceConfiguration(referenceRoot);
  const asset = await readFrozenAv('dual-avc.m2ts', { signal });
  const mediaFolder = path.join(referenceRoot, 'transcode-fixture');
  const filename = path.join(mediaFolder, 'dual-avc.m2ts');
  const subtitle = path.join(mediaFolder, 'dual-avc.en.srt');
  const subtitleBytes = Buffer.from('1\n00:00:00,350 --> 00:00:01,300\nTimed subtitle\n');
  await mkdir(mediaFolder);
  await writeFile(filename, asset.bytes);
  await writeFile(subtitle, subtitleBytes);
  const raw = await probe(filename, evidence, signal);
  assert.equal(raw.streams.filter(stream => stream.codec_type === 'video').length, 2);
  const media = normalizeProbe(raw, { path: filename, protocol: 'File' });
  const databasePath = path.join(dataPath, 'jellyfin.db');
  const database = new SqliteDatabase(databasePath, { requireMigrationHistory: true });
  try {
    const folder = nativeGuid('92500000000000000000000000000002');
    const item = nativeGuid(itemId);
    const aggregate = database.rows('BaseItems', { where: { Type: 'MediaBrowser.Controller.Entities.AggregateFolder' } })[0];
    assert.ok(aggregate);
    const date = '2026-10-01 00:00:00';
    const addItem = entry => database.insert('BaseItems', postgresTestRow('BaseItems', {
      DateCreated: date, DateModified: date, DateLastSaved: date, MediaType: 'Unknown',
      ChannelId: nativeGuid('00000000000000000000000000000000'), Data: '{}', ...entry,
    }));
    database.transaction(() => {
      addItem({ Id: folder, ParentId: aggregate.Id, TopParentId: folder, Type: 'MediaBrowser.Controller.Entities.Folder',
        IsFolder: true, Name: 'Transcode Fixture', Path: mediaFolder });
      addItem({ Id: item, ParentId: folder, TopParentId: folder, Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
        IsMovie: true, MediaType: 'Video', Name: 'Dual AVC', Path: filename, Size: media.Size, TotalBitrate: media.Bitrate,
        RunTimeTicks: media.RunTimeTicks, Data: JSON.stringify({ VideoType: 'VideoFile', Container: media.Container, DefaultVideoStreamIndex: 0 }) });
      for (const [ItemId, ParentItemId] of [[folder, aggregate.Id], [item, aggregate.Id], [item, folder]]) {
        database.insert('AncestorIds', { ItemId, ParentItemId });
      }
      for (const stream of media.MediaStreams) {
        // The transport stream has no signalled per-video rate. Populate the
        // usual persisted field from the payload measured on each track.
        if (stream.Type === 'Video' && stream.BitRate == null) {
          const bytes = raw.packets.filter(packet => packet.stream_index === stream.Index).reduce((sum, packet) => sum + Number(packet.size), 0);
          stream.BitRate = Math.ceil(bytes * 8 / Number(raw.format.duration));
        }
        database.insert('MediaStreamInfos', probeStreamRow(item, stream));
      }
      database.insert('MediaStreamInfos', probeStreamRow(item, {
        Type: 'Subtitle', Codec: 'subrip', Index: 3, Language: 'eng', IsExternal: true, Path: subtitle,
      }));
    });
  } finally { database.close(); }
  return { filename, subtitle, subtitleBytes, databasePath, serverId, asset: asset.source, raw };
}

function portAvailable(port) {
  const server = createServer();
  return new Promise(resolve => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(error => resolve(!error)));
  });
}

async function playback(origin, authorization, protocol, scenario, report, signal) {
  const request = async (uri, init = {}) => {
    const headers = { Authorization: authorization, ...init.headers };
    const response = await fetch(new URL(uri, origin), { ...init, headers, signal });
    return { status: response.status, mime: response.headers.get('content-type'), bytes: Buffer.from(await response.arrayBuffer()) };
  };
  const direct = scenario === 'direct';
  const event = scenario === 'event';
  const burned = scenario === 'burn';
  const scaled = scenario === 'scale' || burned;
  const codec = direct || scaled ? 'ac3' : 'aac';
  const profile = {
    MaxStreamingBitrate: 8000000,
    DirectPlayProfiles: [{ Type: 'Video', Container: 'ts', VideoCodec: 'h264', AudioCodec: codec }],
    TranscodingProfiles: [{ Type: 'Video', Context: 'Streaming', Protocol: protocol, Container: 'ts', VideoCodec: 'h264', AudioCodec: codec }],
  };
  if (scaled) profile.CodecProfiles = [{ Type: 'Video', Codec: 'h264',
    Conditions: [{ Property: 'Width', Condition: 'LessThanEqual', Value: '360' }] }];
  if (burned) profile.SubtitleProfiles = [{ Format: 'srt', Method: 'Encode' }];
  if (direct) {
    const capabilities = await request('/Sessions/Capabilities?PlayableMediaTypes=Video', { method: 'POST' });
    assert.equal(capabilities.status, 204, capabilities.bytes.toString());
  }
  const response = await request(`/Items/${itemId}/PlaybackInfo`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ MediaSourceId: itemId, AudioStreamIndex: 2, SubtitleStreamIndex: burned ? 3 : -1, DeviceProfile: profile }) });
  assert.equal(response.status, 200, response.bytes.toString());
  const info = JSON.parse(response.bytes);
  report.playbackInfo = info;
  assert.equal(info.MediaSources.length, 1);
  const [source] = info.MediaSources;
  assert.equal(source.DefaultAudioStreamIndex, 2);
  assert.equal(source.SupportsTranscoding, true);
  assert.equal(source.SupportsDirectPlay, direct);
  if (direct) {
    assert.equal(source.TranscodingUrl, undefined);
    return;
  }
  const url = new URL(source.TranscodingUrl, origin);
  assert.equal(url.searchParams.get('VideoCodec'), 'h264');
  assert.equal(url.searchParams.get('AudioCodec'), codec);
  assert.equal(url.searchParams.get('TranscodeReasons'), burned ? 'SubtitleCodecNotSupported,VideoResolutionNotSupported'
    : scaled ? 'VideoResolutionNotSupported' : 'AudioCodecNotSupported');
  if (burned) {
    assert.equal(url.searchParams.get('SubtitleStreamIndex'), '3');
    assert.equal(url.searchParams.get('SubtitleMethod'), 'Encode');
  }
  if (scaled) assert.equal(url.searchParams.get('MaxWidth'), '360');
  const head = await request(url, { method: 'HEAD' });
  report.head = { status: head.status, mime: head.mime, length: head.bytes.length };
  assert.equal(head.status, 200); assert.equal(head.bytes.length, 0);
  let mediaUrl = url;
  if (protocol === 'hls') {
    const master = await request(url);
    assert.equal(master.status, 200, master.bytes.toString()); report.master = master.bytes.toString();
    if (scaled) {
      assert.match(report.master, /RESOLUTION=360x240/u);
      assert.match(report.master, /CODECS="avc1\.[^,"]+,ac-3"/u);
    } else assert.match(report.master, /CODECS="avc1\.[^,"]+,mp4a\.40\.2"/u);
    const variant = new URL(linesWithUris(report.master)[0], url);
    if (event) {
      variant.pathname = variant.pathname.replace(/\/main\.m3u8$/u, '/live.m3u8');
      variant.searchParams.set('MinSegments', '1');
    }
    const playlist = await request(variant);
    assert.equal(playlist.status, 200, playlist.bytes.toString()); report.playlist = playlist.bytes.toString();
    if (event) assert.match(report.playlist, /#EXT-X-PLAYLIST-TYPE:EVENT/u);
    mediaUrl = new URL(linesWithUris(report.playlist)[0], variant);
  }
  const media = await request(mediaUrl);
  assert.equal(media.status, 200, media.bytes.subarray(0, 150).toString());
  report.stream = { mime: media.mime, size: media.bytes.length, sha256: sha256(media.bytes) };
  if (protocol === 'hls') {
    const session = await request('/Sessions?DeviceId=' + deviceId);
    assert.equal(session.status, 200);
    const sessions = JSON.parse(session.bytes);
    report.sessions = sessions;
    report.transcodingInfo = sessions.find(value => value.DeviceId === deviceId)?.TranscodingInfo;
    assert.ok(report.transcodingInfo);
    assert.equal(report.transcodingInfo.IsAudioDirect, scaled);
    assert.equal(report.transcodingInfo.IsVideoDirect, !scaled);
  }
  const stop = '/Videos/ActiveEncodings?' + new URLSearchParams({ deviceId, playSessionId: info.PlaySessionId });
  report.stop = (await request(stop, { method: 'DELETE' })).status;
  assert.equal(report.stop, 204);
  return media.bytes;
}

async function extractKeyframes(origin, authorization, signal) {
  const headers = { Authorization: authorization };
  const task = '/ScheduledTasks/' + keyframeExtractionTaskId;
  const start = await fetch(origin + '/ScheduledTasks/Running/' + keyframeExtractionTaskId, { method: 'POST', headers, signal });
  assert.equal(start.status, 204, await start.text());
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(origin + task, { headers, signal });
    assert.equal(response.status, 200);
    const info = await response.json();
    if (info.State === 'Idle' && info.LastExecutionResult) {
      assert.equal(info.Key, 'KeyframeExtraction');
      assert.equal(info.LastExecutionResult.Status, 'Completed', JSON.stringify(info.LastExecutionResult));
      return info;
    }
    await delay(50, undefined, { signal });
  }
  assert.fail('The keyframe extraction task did not complete.');
}

test('real mixed playback, HLS scaling and subtitles, and scheduled keyframes match the designated server', {
  skip: !enabled, timeout: 300000,
}, nativeCase((t, port) => mediaLease.run(async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'mixed-transcode-' + randomUUID()));
  const root = output.root;
  const referenceRoot = path.join(root, 'reference');
  const nativeOrigin = 'http://127.0.0.1:' + port;
  const evidence = { commands: [], native: {}, node: {}, nodeProcesses: [], diagnostics: [], scenarioErrors: [] };
  let current, native, proxy, nodeMedia, database, runtime, authorization, failure;
  async function stopNative() {
    if (!native) return;
    const instance = native;
    native = undefined;
    evidence.nativeShutdown = await instance.stop(async () => {
      const response = await fetch(nativeOrigin + '/System/Shutdown', { method: 'POST', headers: { Authorization: authorization, Connection: 'close' },
        signal: AbortSignal.timeout(15000) });
      await response.arrayBuffer();
      return response.status;
    }, () => portAvailable(port));
    assert.equal(evidence.nativeShutdown.cleanShutdown, true);
    assert.equal(evidence.nativeShutdown.pidGone, true);
  }
  async function capture(origin, label) {
    const results = evidence[label];
    for (const [protocol, scenario] of [['hls', 'direct'], ['hls', 'hls'], ['http', 'http'], ['hls', 'scale'], ['hls', 'burn'], ['hls', 'event']]) {
      const result = results[scenario] = {};
      try {
        const bytes = await playback(origin, authorization, protocol, scenario, result, t.signal);
        if (!bytes) continue;
        const filename = path.join(root, label + '-' + scenario + '.ts');
        await writeFile(filename, bytes);
        result.probe = await probe(filename, evidence, t.signal);
        const audio = result.probe.streams.find(stream => stream.codec_type === 'audio');
        const scaled = scenario === 'scale' || scenario === 'burn';
        assert.equal(audio.codec_name, scaled ? 'ac3' : 'aac');
        assert.equal(audio.channels, 2);
        assert.equal(audio.sample_rate, '48000');
        if (scaled) {
          const video = result.probe.streams.find(stream => stream.codec_type === 'video');
          assert.deepEqual([video.codec_name, video.width, video.height, video.pix_fmt], ['h264', 360, 240, 'yuv420p']);
          result.decoded = (await runMediaTool('ffmpeg', ['-v', 'error', '-i', filename, '-map', '0:v:0',
            '-f', 'framemd5', '-'], evidence.commands, t.signal)).toString('utf8');
        }
        await runMediaTool('ffmpeg', ['-v', 'error', '-i', filename, '-map', '0:v', '-map', '0:a', '-f', 'null', '-'], evidence.commands, t.signal);
      } catch (error) {
        t.signal.throwIfAborted();
        result.error = output.publicError(error).message;
        evidence.scenarioErrors.push({ label, scenario, error: result.error });
      }
    }
  }
  try {
    await mkdir(root);
    current = await currentNativeReference();
    output.addSecret(current.accessToken);
    output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
    authorization = `MediaBrowser Client="Mixed transcode fixture", Device="Isolated", DeviceId="${deviceId}", Version="1", Token="${current.accessToken}"`;
    evidence.reference = current.preparation;
    evidence.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Helpers/MediaInfoHelper.cs',
      'Jellyfin.Api/Helpers/StreamingHelpers.cs', 'Jellyfin.Api/Controllers/DynamicHlsController.cs',
      'Jellyfin.Api/Helpers/FileStreamResponseHelpers.cs', 'MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs']);
    await cp(current.sourceRoot, referenceRoot, { recursive: true });
    await current.prepareClone(referenceRoot, port);
    const fixture = await seed(referenceRoot, evidence, t.signal);
    evidence.source = fixture.asset;
    proxy = await startOwnedMediaProxy([
      { filename: fixture.filename, contentType: 'video/mp2t', expected: fixture.asset },
      { filename: fixture.subtitle, contentType: 'application/x-subrip',
        expected: { bytes: fixture.subtitleBytes.length, sha256: sha256(fixture.subtitleBytes) } },
    ]);
    database = await createPostgresTestDatabase(null, 'mixed_transcode');
    const snapshot = new SqliteDatabase(fixture.databasePath, { readOnly: true, requireMigrationHistory: true });
    try {
      evidence.transfer = await transferDatabase(snapshot, database, { instanceBinding: { serverId: fixture.serverId,
        originIdentityDigest: sha256(await readFile(fixture.databasePath)) } });
    } finally { snapshot.close(); }
    native = current.start({ referenceRoot, outputRoot: root, label: 'native', origin: nativeOrigin });
    await native.ready();
    await capture(nativeOrigin, 'native');
    evidence.native.keyframeTask = await extractKeyframes(nativeOrigin, authorization, t.signal);
    await stopNative();
    const persisted = new SqliteDatabase(fixture.databasePath, { readOnly: true, requireMigrationHistory: true });
    const itemKey = nativeGuid(itemId);
    try { evidence.native.keyframes = persisted.rows('KeyframeData', { where: { ItemId: itemKey } })[0]; }
    finally { persisted.close(); }
    assert.ok(evidence.native.keyframes, 'Native stored keyframes from the scheduled transport-stream scan.');
    for (const entry of await readdir(path.join(referenceRoot, 'log'))) {
      if (entry.startsWith('FFmpeg.') || entry.startsWith('FFmpeg-')) {
        (evidence.nativeFfmpeg ??= []).push({ filename: entry, text: await readFile(path.join(referenceRoot, 'log', entry), 'utf8') });
      }
    }
    await writeFile(path.join(referenceRoot, 'config/network.xml'),
      '<NetworkConfiguration><InternalHttpPort>0</InternalHttpPort><AutoDiscovery>false</AutoDiscovery></NetworkConfiguration>');
    nodeMedia = await extractionFixture({ '/dual-avc.m2ts': await readFile(fixture.filename), '/dual-avc.en.srt': fixture.subtitleBytes });
    const identityMap = new IdentityAccessMap();
    identityMap.addPrefix({ identityRoot: path.dirname(fixture.filename), accessRoot: '/',
      style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'Isolated transcode media.' });
    identityMap.bind(itemId, '/dual-avc.m2ts');
    runtime = await createTestRuntime({ ...await readInstanceConfiguration(referenceRoot), database,
      vfs: nodeMedia.vfs, identityMap,
      hlsOptions: { onProcess: entry => evidence.nodeProcesses.push(entry) },
      remuxOptions: { onProcess: entry => evidence.nodeProcesses.push(entry) },
      onError: error => evidence.diagnostics.push({ message: error.message, details: error.details }),
    });
    const nodeOrigin = 'http://127.0.0.1:' + runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port;
    await capture(nodeOrigin, 'node');
    evidence.node.keyframeTask = await extractKeyframes(nodeOrigin, authorization, t.signal);
    evidence.node.keyframes = (await database.rows('KeyframeData', { where: { ItemId: itemKey } }))[0];
    assert.deepEqual(evidence.node.keyframes, evidence.native.keyframes);
    assert.deepEqual(evidence.scenarioErrors, []);
    assert.notEqual(evidence.native.burn.decoded, evidence.native.scale.decoded, 'The timed cue changed decoded video frames.');
    for (const protocol of ['direct', 'hls', 'http', 'scale', 'burn', 'event']) {
      const expected = evidence.native[protocol], actual = evidence.node[protocol];
      const normalize = info => {
        const copy = structuredClone(info);
        const identities = { token: current.accessToken, playSessionId: copy.PlaySessionId };
        copy.PlaySessionId = '<session>';
        for (const source of copy.MediaSources) if (source.TranscodingUrl) source.TranscodingUrl = projectHlsRequestIdentities(source.TranscodingUrl, identities);
        return copy;
      };
      assert.deepEqual(normalize(actual.playbackInfo), normalize(expected.playbackInfo), protocol);
      if (protocol === 'direct') continue;
      assert.deepEqual(actual.head, expected.head, protocol);
      if (protocol === 'event') {
        const project = value => value.replace(/hls\/([a-f0-9]{32})\/\1/g, 'hls/<playlist>/<playlist>');
        assert.equal(project(actual.playlist), project(expected.playlist));
      }
      if (protocol === 'scale' || protocol === 'burn') {
        assert.equal(actual.decoded, expected.decoded, protocol + ' video frames and decoded timestamps');
        assert.deepEqual(packets(actual.probe, 'audio'), packets(expected.probe, 'audio'), 'Copied audio payload and timeline');
        continue;
      }
      assert.deepEqual(packets(actual.probe, 'video'), packets(expected.probe, 'video'), protocol + ' video payload and timeline');
      assert.deepEqual(packets(actual.probe, 'audio'), packets(expected.probe, 'audio'), protocol + ' AAC payload and timeline');
      assert.deepEqual(packets(actual.probe, 'video').map(packet => packet.hash), packets(fixture.raw, 'video').map(packet => packet.hash),
        protocol + ' original video payloads');
    }
    assert.equal(evidence.nodeProcesses.length, 5);
    for (const { args } of evidence.nodeProcesses) {
      assert.ok(!args.includes('-hwaccel') && !args.includes('-init_hw_device'));
      if (args.includes('-vf')) assert.equal(args[args.indexOf('-codec:v:0') + 1], 'libx264');
      else assert.notEqual(args[args.indexOf('-codec:a:0') + 1], 'copy');
    }
  } catch (error) { failure = output.publicError(error); evidence.error = failure.message; }
  finally {
    const errors = failure ? [failure] : [];
    for (const cleanup of [stopNative, () => runtime?.close(), () => proxy?.close(), () => nodeMedia?.close(), () => dropPostgresTestDatabase(database)]) {
      try { await cleanup(); } catch (error) { errors.push(output.publicError(error)); }
    }
    try { await writeFile(path.join(root, 'capture.json'), JSON.stringify(evidence, (_key, value) => typeof value === 'bigint' ? value.toString() : value)); }
    finally { await output.publishAndClose(); }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Mixed transcode validation failed.');
  }
}, { signal: t.signal })));
