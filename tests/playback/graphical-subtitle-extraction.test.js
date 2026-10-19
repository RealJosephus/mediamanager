import { validationExecutable } from '../../tools/validation/paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { ExtractionService } from '../../src/playback/extraction.js';
import { PlaybackService } from '../../src/playback/service.js';
import { negotiateSource } from '../../src/playback/profile.js';
import { decodeSubtitle, convertSubtitle } from '../../src/playback/subtitles.js';
import { extractionFixture } from './extraction-fixture.js';
import reference from './fixtures/graphical-subtitle-reference.json' with { type: 'json' };

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const files = () => Object.fromEntries(reference.sources.map(entry => ['/' + entry.name, Buffer.from(entry.media, 'base64')]));

function probe(bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(validationExecutable('ffprobe'), [
      '-v', 'error', '-show_packets', '-show_streams', '-show_data_hash', 'sha256',
      '-show_entries', 'stream=codec_name,width,height:packet=pts,dts,duration,size,flags,data_hash',
      '-of', 'json', '-i', 'pipe:0',
    ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve(JSON.parse(Buffer.concat(stdout)))
      : reject(new Error(`ffprobe exited ${code}: ${Buffer.concat(stderr)}`)));
    child.stdin.end(bytes);
  });
}

function packetProjection(value) {
  return {
    streams: value.streams.map(stream => ({
      codec_name: stream.codec_name,
      width: stream.width,
      height: stream.height,
      default: stream.disposition.default,
      language: stream.tags?.language,
    })),
    packets: value.packets.map(packet => ({
      pts: packet.pts,
      dts: packet.dts,
      duration: packet.duration,
      size: packet.size,
      flags: packet.flags,
      data_hash: packet.data_hash,
    })),
  };
}

test('actual PGS, VobSub and S_TEXT/SSA containers match the frozen extraction oracle', async t => {
  const fixtureFiles = files();
  const fixture = await extractionFixture(fixtureFiles);
  const service = new ExtractionService({ vfs: fixture.vfs });
  t.after(async () => { await service.close(); await fixture.close(); });
  assert.equal(await service.initialize(), true, 'A real ffmpeg executable is required for graphical subtitle verification.');

  for (const expected of reference.outputs) {
    const entry = reference.sources.find(value => value.name === expected.source);
    const stream = entry.source.MediaStreams.find(value => value.Index === expected.index);
    const result = await service.subtitle(entry.source, stream, '/' + entry.name);
    assert.equal(result.format, expected.format, `${entry.name}: native format casing`);
    if (expected.comparison === 'bytes') {
      assert.equal(result.bytes.length, expected.native.byteLength, `${entry.name}: byte length`);
      assert.equal(digest(result.bytes), expected.native.sha256, `${entry.name}: frozen DLL bytes`);
    } else {
      const actualPackets = packetProjection(await probe(result.bytes));
      const nativePackets = packetProjection(expected.packetProjection);
      assert.deepEqual(actualPackets, nativePackets, `${entry.name}: codec metadata, timestamps and graphical packet bytes`);
    }
  }

  const ssa = reference.sources.find(value => value.name === 'ssa.mks');
  assert.notEqual(Buffer.from(ssa.media, 'base64').indexOf(Buffer.from('S_TEXT/SSA')), -1, 'The fixture must retain the legacy Matroska SSA CodecID.');
  const extracted = await service.subtitle(ssa.source, ssa.source.MediaStreams[0], '/ssa.mks');
  assert.equal(convertSubtitle(decodeSubtitle(extracted.bytes), extracted.format, 'vtt'),
    'WEBVTT\r\n\r\n00:00:01.180 --> 00:00:06.850\r\nLike an angel with pity on nobody');
});

test('VobSub advertisement retains native failure while manual MKS serves native packets', async t => {
  const entry = reference.sources.find(value => value.name === 'vobsub.mks');
  const source = structuredClone(entry.source);
  const profile = { SubtitleProfiles: [{ Format: 'dvdsub', Container: 'mks', Method: 'External' }] };
  negotiateSource(source, { Id: source.Id, MediaType: 'Video' }, profile, { AccessToken: 'isolated-test-token' });
  const delivery = source.MediaStreams[0];
  assert.equal(delivery.DeliveryMethod, 'External');
  assert.equal(delivery.Codec, 'DVDSUB');
  assert.match(delivery.DeliveryUrl, /\/Stream\.dvdsub\?ApiKey=isolated-test-token$/u);
  const fixture = await extractionFixture({ '/vobsub.mks': Buffer.from(entry.media, 'base64') });
  const extraction = new ExtractionService({ vfs: fixture.vfs });
  assert.equal(await extraction.initialize(), true, 'A real ffmpeg executable is required for VobSub HTTP verification.');
  const playback = new PlaybackService({
    library: {
      async getItemRecord() { return { Id: source.Id, MediaType: 'Video', Path: source.Path }; },
      async getMediaSources() { return [source]; },
    },
    vfs: fixture.vfs,
    identityMap: fixture.identityMap,
    extraction,
  });
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      const format = /\/Stream\.([^/]+)$/u.exec(pathname)?.[1] ?? pathname.slice(1);
      const result = await playback.subtitle(source.Id, source.Id, 0, format);
      await result.send(request, response);
    } catch (error) {
      response.statusCode = error.status ?? 500;
      response.setHeader('Content-Type', 'text/plain');
      response.end('Error processing request.');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await extraction.close();
    await fixture.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const advertised = await fetch(origin + delivery.DeliveryUrl);
  assert.equal(advertised.status, 400);
  assert.equal(advertised.headers.get('content-type'), 'text/plain');
  assert.equal(await advertised.text(), 'Error processing request.');
  const manual = await fetch(origin + delivery.DeliveryUrl.replace('/Stream.dvdsub', '/Stream.mks'));
  const bytes = Buffer.from(await manual.arrayBuffer());
  assert.equal(manual.status, 200);
  assert.equal(manual.headers.get('content-type'), 'video/x-matroska');
  assert.deepEqual(packetProjection(await probe(bytes)), packetProjection(reference.outputs.find(value => value.source === 'vobsub.mks').packetProjection));

  const nativeBroken = await fetch(origin + '/vobsub');
  assert.equal(nativeBroken.status, 400);
  assert.equal(nativeBroken.headers.get('content-type'), 'text/plain');
  assert.equal(await nativeBroken.text(), 'Error processing request.');
});
