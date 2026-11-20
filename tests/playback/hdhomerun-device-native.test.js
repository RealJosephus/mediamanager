import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { captureMediaProcess } from '../../src/media-execution/process.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput } from '../../tools/compat/filter-reference-output.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { readFrozenAv } from '../helpers/frozen-av.js';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import { createTestRuntime } from '../helpers/runtime.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES);
const nativeCase = declareNativeHttpTestFile({ enabled });
const controlPort = declareFileTestResource('hdhomerun-control-tcp-65001', { enabled });
const describe = bytes => ({ length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const mediaUris = manifest => manifest.split(/\r?\n/u).filter(line => line && !line.startsWith('#'));
const deviceProfile = 'internet360';
const processingOptions = args => Object.fromEntries(['-codec:v:0', '-codec:a:0', '-hls_time', '-fflags', '-force_key_frames', '-g', '-vf', '-start_number',
  '-b:a', '-b:a:0', '-ar', '-copyts'].filter(name => args.includes(name)).map(name => [name, args[args.indexOf(name) + 1]]));

async function awaitObservation(read, matches, description, signal) {
  const limit = Date.now() + 45000;
  while (true) {
    const value = await read();
    if (matches(value)) return value;
    assert.ok(Date.now() < limit, description);
    await delay(100, undefined, { signal });
  }
}

async function legacyDevice(transport) {
  const udp = createSocket('udp4'), messages = [], sockets = new Set(), errors = [];
  const tcp = createTcpServer(socket => {
    sockets.add(socket);
    let bytes = Buffer.alloc(0), key, sending;
    socket.once('close', () => { clearInterval(sending); sockets.delete(socket); });
    socket.on('error', error => errors.push(error));
    socket.on('data', chunk => {
      try {
        bytes = Buffer.concat([bytes, chunk]);
        while (bytes.length >= 8 && bytes.length >= bytes.readUInt16BE(2) + 8) {
          const length = bytes.readUInt16BE(2) + 8, packet = bytes.subarray(0, length);
          bytes = bytes.subarray(length);
          assert.equal(packet.readUInt16BE(), 4);
          assert.equal(packet.readUInt32LE(packet.length - 4), crc32(packet.subarray(0, -4)));
          assert.equal(packet[4], 3);
          const routeEnd = 6 + packet[5], route = packet.toString('utf8', 6, routeEnd - 1);
          const hasValue = packet[routeEnd] === 4;
          const valueEnd = hasValue ? routeEnd + 2 + packet[routeEnd + 1] : routeEnd;
          const value = hasValue ? packet.toString('utf8', routeEnd + 2, valueEnd - 1) : undefined;
          const locked = packet[valueEnd] === 21;
          if (locked) assert.equal(packet.readUInt32BE(valueEnd + 2), key);
          let response = value;
          if (!hasValue) response = route === '/tuner0/lockkey' ? 'busy' : 'none';
          else if (route.endsWith('/lockkey') && value !== 'none') { key = Number(value); assert.ok(key >= 0 && key < 0x80000000); }
          else if (route.endsWith('/target')) {
            clearInterval(sending);
            if (value !== 'none') {
              const address = new URL(value);
              assert.equal(address.hostname, '127.0.0.1');
              assert.equal(address.protocol, 'rtp:');
              let offset = 0, sequence = 0;
              sending = setInterval(() => {
                const end = Math.min(offset + 188 * 7, transport.length), header = Buffer.alloc(12);
                header[0] = 0x80; header[1] = 33; header.writeUInt16BE(sequence++, 2);
                udp.send(Buffer.concat([header, transport.subarray(offset, end)]), Number(address.port), '127.0.0.1');
                offset = end === transport.length ? 0 : end;
              }, 4);
            }
          }
          messages.push({ route, value: value === undefined ? 'get' : route.endsWith('/lockkey') && value !== 'none' ? 'acquire'
            : value.startsWith('rtp://') ? 'rtp' : value, locked });
          const valueBody = Buffer.from(response + '\0'), name = packet.subarray(4, routeEnd);
          const reply = Buffer.alloc(8 + name.length + 2 + valueBody.length);
          reply.writeUInt16BE(5); reply.writeUInt16BE(reply.length - 8, 2);
          name.copy(reply, 4); reply[4 + name.length] = 4; reply[5 + name.length] = valueBody.length;
          valueBody.copy(reply, 6 + name.length); reply.writeUInt32LE(crc32(reply.subarray(0, -4)), reply.length - 4);
          socket.write(reply);
        }
      } catch (error) { errors.push(error); socket.destroy(); }
    });
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    if (tcp.listening) await new Promise(resolve => tcp.close(resolve));
    await new Promise(resolve => udp.close(resolve));
  };
  try {
    await new Promise((resolve, reject) => udp.once('error', reject).bind(0, '127.0.0.1', resolve));
    await new Promise((resolve, reject) => tcp.once('error', reject).listen(65001, '127.0.0.1', resolve));
  } catch (error) { await close(); throw error; }
  return { messages, errors, close };
}

test('HDHomeRun HTTP profiles and legacy RTP feed the retained playback pipeline', { skip: !enabled, timeout: 240000 }, nativeCase((t, port) => controlPort.run(async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), 'hdhomerun-device-' + randomUUID()));
  const root = output.root, referenceRoot = path.join(root, 'reference'), nativeOrigin = 'http://127.0.0.1:' + port;
  const observations = {}, upstream = [];
  let oracle, native, source, legacy, database, runtime, authorization, failure;
  const request = async (origin, route, { method = 'GET', body, status = 200 } = {}) => {
    const response = await fetch(new URL(route, origin), { method, signal: AbortSignal.any([t.signal, AbortSignal.timeout(35000)]),
      headers: { Authorization: authorization, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${route} ${text}`);
    return text && response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text;
  };
  const stopNative = async () => {
    if (!native) return;
    const instance = native; native = undefined;
    const stopped = await instance.stop(async () => {
      const response = await fetch(nativeOrigin + '/System/Shutdown', { method: 'POST', headers: { Authorization: authorization, Connection: 'close' },
        signal: AbortSignal.timeout(15000) });
      await response.arrayBuffer(); return response.status;
    }, () => new Promise(resolve => {
      const listener = createServer(); listener.once('error', () => resolve(false));
      listener.listen(port, '127.0.0.1', () => listener.close(error => resolve(!error)));
    }));
    assert.ok(stopped.cleanShutdown && stopped.pidGone && stopped.portAvailable);
  };
  const readPrefix = async (url, length) => {
    const response = await fetch(url, { headers: { Authorization: authorization }, signal: AbortSignal.any([t.signal, AbortSignal.timeout(25000)]) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), pieces = [];
    try {
      for (let read = 0; read < length;) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        pieces.push(Buffer.from(chunk.value)); read += chunk.value.length;
      }
      return Buffer.concat(pieces).subarray(0, length);
    } finally { await reader.cancel(); }
  };
  try {
    await mkdir(root);
    oracle = await currentNativeReference();
    output.addSecret(root); output.addSecret(oracle.accessToken); output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
    authorization = `MediaBrowser Client="HDHomeRun fixture", Device="Isolated", DeviceId="fixture-hdhr", Version="1", Token="${oracle.accessToken}"`;
    observations.reference = oracle.preparation;
    observations.bindings = await oracle.sourceBindings(['src/Jellyfin.LiveTv/TunerHosts/HdHomerun/HdHomerunHost.cs',
      'src/Jellyfin.LiveTv/TunerHosts/HdHomerun/HdHomerunManager.cs', 'src/Jellyfin.LiveTv/TunerHosts/HdHomerun/HdHomerunUdpStream.cs',
      'src/Jellyfin.LiveTv/TunerHosts/SharedHttpStream.cs', 'src/Jellyfin.LiveTv/TunerHosts/LiveStream.cs']);
    await cp(oracle.sourceRoot, referenceRoot, { recursive: true }); await oracle.prepareClone(referenceRoot, port);
    await writeFile(path.join(referenceRoot, 'config/livetv.xml'), '<LiveTvOptions><TunerHosts /><ListingProviders /></LiveTvOptions>');
    const input = path.join(root, 'input.m2ts'), { bytes } = await readFrozenAv('dual-avc.m2ts', { signal: t.signal });
    await writeFile(input, bytes);
    const media = await captureMediaProcess(validationExecutable('ffmpeg'), ['-nostdin', '-v', 'error', '-stream_loop', '8', '-i', input,
      '-map', '0:v:0', '-map', '0:a:0', '-vf', 'scale=640:360', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '48', '-c:a', 'copy',
      '-f', 'mpegts', 'pipe:1'], { signal: t.signal, timeoutMs: 30000, maxOutputBytes: 16 * 1024 * 1024 });
    assert.equal(media.exitCode, 0);
    const transport = media.stdout;
    assert.ok(transport.length > 20000 && transport.length % 188 === 0);
    legacy = await legacyDevice(transport);
    let sourceOrigin;
    source = createServer((incoming, response) => {
      if (incoming.url === '/discover.json' || incoming.url === '/lineup.json') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(incoming.url === '/discover.json' ? { FriendlyName: 'Controlled device', ModelNumber: 'HDTC-2US',
          DeviceID: '00AABBCC', TunerCount: 2, BaseURL: sourceOrigin, LineupURL: sourceOrigin + '/lineup.json' }
          : [{ GuideNumber: '31.1', GuideName: 'Device profile fixture', HD: 1, VideoCodec: 'mpeg2', AudioCodec: 'ac3', URL: sourceOrigin + '/auto/v31.1' },
            { GuideNumber: '34.3', GuideName: 'Legacy RTP fixture', HD: 1, VideoCodec: 'h264', AudioCodec: 'ac3', URL: 'hdhomerun://127.0.0.1/tuner0/ch34-3' }]));
        return;
      }
      if (incoming.url !== '/auto/v31.1?transcode=' + deviceProfile) { response.writeHead(404).end(); return; }
      const frame = { sent: 0, opened: Date.now(), closed: false };
      upstream.push(frame);
      response.setHeader('Content-Type', 'video/mp2t');
      const timer = setInterval(() => {
        const end = Math.min(frame.sent + 188 * 112, transport.length);
        response.write(transport.subarray(frame.sent, end)); frame.sent = end;
        if (end === transport.length) clearInterval(timer);
      }, 50);
      response.once('close', () => { frame.closed = true; clearInterval(timer); });
    });
    await new Promise((resolve, reject) => source.once('error', reject).listen(0, '127.0.0.1', resolve));
    sourceOrigin = 'http://127.0.0.1:' + source.address().port;
    native = oracle.start({ referenceRoot, outputRoot: root, label: 'native-device', origin: nativeOrigin });
    await native.ready();
    await request(nativeOrigin, '/LiveTv/TunerHosts', { method: 'POST',
      body: { Type: 'hdhomerun', Url: sourceOrigin, AllowHWTranscoding: true, AllowStreamSharing: true, TunerCount: 2 } });
    const channels = await awaitObservation(() => request(nativeOrigin, '/LiveTv/Channels').then(value => value.Items),
      values => ['Device profile fixture', 'Legacy RTP fixture'].every(name => values.some(item => item.Name === name)),
      'Both tuner channels must appear in the Native guide.', t.signal);
    const channel = channels.find(item => item.Name === 'Device profile fixture');
    const legacyChannel = channels.find(item => item.Name === 'Legacy RTP fixture');
    const observe = async (origin, engine) => {
      const route = '/Items/' + channel.Id + '/PlaybackInfo';
      const initial = (await request(origin, route)).MediaSources;
      const profiles = initial.map(value => value.Id.split('_')[0]);
      assert.deepEqual(profiles, ['heavy', 'native', 'mobile', 'internet540', 'internet480', 'internet360', 'internet240']);
      const input = initial.find(value => value.Id.startsWith(deviceProfile + '_'));
      assert.equal(input.MediaStreams.find(value => value.Type === 'Video').Width, 640);
      const canPlay = { Name: 'Controlled direct client', MaxStreamingBitrate: 30000000,
        DirectPlayProfiles: [{ Type: 'Video', Container: 'ts', VideoCodec: 'h264', AudioCodec: 'ac3' }], TranscodingProfiles: [],
        ContainerProfiles: [], CodecProfiles: [], SubtitleProfiles: [] };
      const body = { AutoOpenLiveStream: true, MediaSourceId: input.Id, DeviceProfile: canPlay };
      const [{ Path: directPath, LiveStreamId: directId, SupportsDirectPlay: direct }] = (await request(origin, route, { method: 'POST', body })).MediaSources;
      const close = id => request(origin, '/LiveStreams/Close?liveStreamId=' + encodeURIComponent(id), { method: 'POST', status: 204 });
      assert.ok(direct && directId);
      const feed = upstream.at(-1);
      const first = await readPrefix(directPath, 188 * 20);
      assert.deepEqual(first, transport.subarray(0, first.length));
      await awaitObservation(() => feed.sent, sent => sent === transport.length, 'The fixture must write every source packet.', t.signal);
      await delay(Math.max(0, 11500 + feed.opened - Date.now()), undefined, { signal: t.signal });
      const late = await readPrefix(directPath, 20000);
      assert.deepEqual(late, transport.subarray(-20000), 'The late consumer must read from the retained tail.');
      assert.equal(feed.closed, false);
      await close(directId);
      await awaitObservation(() => feed.closed, Boolean, 'Closing direct playback must release the tuner.', t.signal);

      const format = { ...canPlay, DirectPlayProfiles: [], TranscodingProfiles: [{ Type: 'Video', Context: 'Streaming', Protocol: 'hls',
        Container: 'ts', VideoCodec: 'h264', AudioCodec: 'aac', MinSegments: 2, SegmentLength: 2 }] };
      const playback = await request(origin, route, { method: 'POST', body: { ...body, DeviceProfile: format,
        EnableDirectPlay: false, EnableDirectStream: false, EnableTranscoding: true, MaxStreamingBitrate: 8000000 } });
      const [opened] = playback.MediaSources;
      assert.ok(opened.LiveStreamId && opened.SupportsTranscoding && opened.TranscodingUrl);
      const master = await request(origin, opened.TranscodingUrl);
      const eventUrl = new URL(mediaUris(master)[0], new URL(opened.TranscodingUrl, origin));
      const event = await request(origin, eventUrl);
      assert.match(event, /#EXT-X-PLAYLIST-TYPE:EVENT/u);
      assert.ok(mediaUris(event).length >= 2 && !upstream.at(-1).closed);
      const segment = await fetch(new URL(mediaUris(event)[0], eventUrl), { signal: t.signal, headers: { Authorization: authorization } });
      assert.equal(segment.status, 200);
      const bytes = Buffer.from(await segment.arrayBuffer());
      assert.equal(bytes[0], 0x47);
      const filename = path.join(root, engine + '-segment.ts');
      await writeFile(filename, bytes);
      const decision = await captureMediaProcess(validationExecutable('ffprobe'), ['-v', 'error', '-show_entries',
        'stream=codec_name,codec_type,width,height,sample_rate,start_time,duration:format=duration', '-of', 'json', filename],
      { signal: t.signal, timeoutMs: 10000, maxOutputBytes: 1024 * 1024 });
      assert.equal(decision.exitCode, 0);
      const ffprobe = JSON.parse(decision.stdout);
      observations[engine + 'Processing'] = { streamInfo: ffprobe.streams, duration: ffprobe.format.duration,
        request: Object.fromEntries([...eventUrl.searchParams].filter(([name]) => /codec|bitrate|segment|copy|maxwidth/iu.test(name))) };
      await request(origin, '/Videos/ActiveEncodings?' + new URLSearchParams({ deviceId: 'fixture-hdhr', playSessionId: playback.PlaySessionId }),
        { method: 'DELETE', status: 204 });
      await close(opened.LiveStreamId);
      await awaitObservation(() => upstream.at(-1).closed, Boolean, 'Stopping HLS must release the selected device input.', t.signal);
      const controlStart = legacy.messages.length;
      const legacyRoute = '/Items/' + legacyChannel.Id + '/PlaybackInfo';
      const [legacySource] = (await request(origin, legacyRoute)).MediaSources;
      assert.equal(legacySource.Protocol, 'Udp');
      const [{ Path: udpPath, LiveStreamId: udpId }] = (await request(origin, legacyRoute, {
        method: 'POST', body: { ...body, MediaSourceId: legacySource.Id },
      })).MediaSources;
      const legacyBytes = await readPrefix(udpPath, 188 * 20);
      assert.deepEqual(legacyBytes, transport.subarray(0, legacyBytes.length));
      await close(udpId);
      const control = await awaitObservation(() => legacy.messages.slice(controlStart), values => {
        const last = values.at(-1);
        return last?.route === '/tuner1/lockkey' && last.value === 'none';
      }, 'The legacy input must clear its RTP target and release the TCP lock.', t.signal);
      assert.deepEqual(control.map(value => [value.route, value.value, value.locked]), [
        ['/tuner0/lockkey', 'get', false], ['/tuner1/lockkey', 'get', false], ['/tuner1/lockkey', 'acquire', false],
        ['/tuner1/channel', '34', true], ['/tuner1/program', '3', true], ['/tuner1/target', 'rtp', true],
        ['/tuner1/target', 'none', true], ['/tuner1/lockkey', 'none', true],
      ]);
      assert.deepEqual(legacy.errors, []);
      return { profiles, direct: describe(first), late: describe(late), event: describe(bytes), legacy: describe(legacyBytes), control };
    };
    observations.native = await observe(nativeOrigin, 'native');
    await stopNative();
    const logDirectory = path.join(referenceRoot, 'log');
    for (const filename of await readdir(logDirectory)) if (filename.startsWith('FFmpeg')) {
      const command = (await readFile(path.join(logDirectory, filename), 'utf8')).split(/\r?\n/u).find(line => line.includes('-hls_time'));
      if (command) observations.nativeProcessing.arguments = processingOptions(command.trim().split(/\s+/u));
    }
    const configuration = await readInstanceConfiguration(referenceRoot);
    database = await createPostgresTestDatabase(null, 'hdhomerun_device');
    const sqlite = new SqliteDatabase(path.join(configuration.dataPath, 'jellyfin.db'), { readOnly: true, requireMigrationHistory: true });
    try { await transferDatabase(sqlite, database); } finally { sqlite.close(); }
    const commands = [];
    runtime = await createTestRuntime({ ...configuration, database, hlsOptions: { onProcess: entry => commands.push(processingOptions(entry.args)) } });
    observations.node = await observe('http://127.0.0.1:' + runtime.networkHost.listeners.find(value => value.scheme === 'http').port, 'node');
    observations.nodeProcessing.arguments = commands.at(-1);
    for (const decision of [observations.nativeProcessing, observations.nodeProcessing]) {
      assert.equal(decision.arguments?.['-codec:v:0'], 'copy');
      assert.equal(decision.streamInfo.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
    }
    assert.deepEqual((await readdir(path.join(configuration.programDataPath, 'cache', 'livetv'))).filter(name => name.startsWith('mediamanager-live-')), []);
    assert.deepEqual(observations.node, observations.native);
    assert.equal(upstream.length, 4);
    await oracle.finish();
  } catch (error) { failure = output.publicError(error); observations.error = failure.message; }
  finally {
    for (const cleanup of [stopNative, () => runtime?.close(), () => database && dropPostgresTestDatabase(database),
      () => source && new Promise(resolve => { source.closeAllConnections(); source.close(resolve); }), () => legacy?.close()]) {
      try { await cleanup(); } catch (error) { failure ??= output.publicError(error); }
    }
    observations.sourceConnections = upstream.map(({ sent, closed }) => ({ sent, closed }));
    try { await writeFile(path.join(root, 'capture.json'), JSON.stringify(observations)); }
    finally { await output.publishAndClose(); }
  }
  if (failure) throw failure;
}, { signal: t.signal })));
