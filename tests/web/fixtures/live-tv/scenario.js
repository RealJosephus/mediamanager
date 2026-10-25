import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMediaTool } from '../../../helpers/media-tool.js';
import { stringifyNativeJson } from '../../../../src/core/json.js';
import { refreshGuideTaskId } from '../../../../src/tasks/refresh-guide-task.js';
import { loadPostgresUserDataRows } from '../../../../src/sessions/postgres-user-data-mutation.js';
import { nativeModel } from '../../../../src/database/model.js';

export { runMediaTool };

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const location = value => {
  const url = new URL(value);
  return { origin: url.origin, path: url.pathname, queryKeys: [...new Set(url.searchParams.keys())].sort() };
};
export async function until(read, matches, description, milliseconds = 60000) {
  const deadline = Date.now() + milliseconds;
  while (true) {
    const result = await read();
    if (matches(result)) return result;
    assert.ok(Date.now() < deadline, 'Timed out waiting for ' + description + '.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** Observe the real upgraded net sockets without reading bytes or closing them. */
export function observeProductionUpgrades(report) {
  const servers = new Map(), sockets = new Map(); let closing;
  report.productionUpgradeSockets = [];
  report.productionUpgradeServers = [];
  return {
    attach(server, label) {
      assert.equal(closing, undefined, 'Upgrade observation cannot attach after cleanup begins.');
      if (servers.has(server)) return;
      const owner = { label, attachedAt: new Date().toISOString() };
      report.productionUpgradeServers.push(owner);
      const listener = (request, socket) => {
        if (sockets.has(socket)) return;
        const record = { server: label, sequence: report.productionUpgradeSockets.length + 1,
          upgradedAt: new Date().toISOString(), path: (request.url ?? '').split(/[?#]/u, 1)[0],
          tuple: { localAddress: socket.localAddress ?? null, localPort: socket.localPort ?? null,
            remoteAddress: socket.remoteAddress ?? null, remotePort: socket.remotePort ?? null, remoteFamily: socket.remoteFamily ?? null },
          closeObserved: false };
        const closed = new Promise(resolve => socket.once('close', hadError => {
          record.closedAt = new Date().toISOString(); record.hadError = hadError; record.closeObserved = true;
          record.destroyed = socket.destroyed; record.closed = socket.closed; resolve();
        }));
        sockets.set(socket, { closed, record }); report.productionUpgradeSockets.push(record);
      };
      server.on('upgrade', listener); servers.set(server, { owner, listener });
    },
    close() {
      return closing ??= (async () => {
        const drain = report.productionUpgradeDrain = { startedAt: new Date().toISOString(), timeoutMilliseconds: 10000,
          sockets: sockets.size, allSocketCloseEventsObserved: false, observerDetached: false };
        let timer;
        try {
          // Browser and production runtime cleanup precede this observer. It
          // never sends a close frame, ends/destroys a socket or affects bytes.
          await Promise.race([Promise.all([...sockets.values()].map(value => value.closed)),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Actual production upgrade sockets did not emit close after browser/runtime shutdown.')), drain.timeoutMilliseconds); })]);
          for (const { record } of sockets.values()) {
            assert.equal(record.closeObserved, true); assert.ok(record.closedAt);
            assert.equal(record.destroyed, true); assert.equal(record.closed, true);
          }
          for (const [server, { owner }] of servers) {
            owner.listeningAfterCleanup = server.listening; assert.equal(server.listening, false);
          }
          drain.allSocketCloseEventsObserved = true;
        } finally {
          clearTimeout(timer);
          for (const [server, { listener }] of servers) server.off('upgrade', listener);
          drain.observerDetached = true; drain.finishedAt = new Date().toISOString();
        }
      })();
    },
  };
}

/** Only the fixture changes the container; every selected compressed packet is checked. */
export async function prepareOriginal(report, { signal } = {}) {
  signal?.throwIfAborted();
  const source = fileURLToPath(new URL('../../../playback/fixtures/vobsub-delivery/source.mkv', import.meta.url));
  const manifest = fileURLToPath(new URL('../../../playback/fixtures/vobsub-delivery/input.json', import.meta.url));
  const input = await readFile(source), declared = JSON.parse(await readFile(manifest));
  assert.equal(input.length, 1896947); assert.equal(input.length, declared.combined.bytes);
  assert.equal(sha256(input), '4a9a6e3be221f0d08506ca6bbd6d3ad73819c82605871e9fd981b7bf14399a6c');
  assert.equal(sha256(input), declared.combined.sha256);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mm-web-live-original-')));
  const filename = path.resolve(root, 'original.mp4');
  const commands = [];
  report.mediaPreparation = { input: { filename: source, bytes: input.length, sha256: sha256(input), manifest, manifestSha256: sha256(await readFile(manifest)),
    provenance: 'Tracked frozen 2026-09-27 VobSub composite; its original compressed H264 and first AAC packets only.' }, commands,
    encodingExecuted: false, productionRemuxExecuted: false, actualNativeSharedHttpStreamOpenExecuted: false };
  const verifySource = async () => { const bytes = await readFile(source); assert.equal(bytes.length, input.length); assert.equal(sha256(bytes), sha256(input)); report.mediaPreparation.inputUnchanged = true; };
  const close = async () => {
    try {
      await verifySource();
      if (report.mediaPreparation.output) {
        const bytes = await readFile(filename); assert.equal(bytes.length, report.mediaPreparation.output.bytes); assert.equal(sha256(bytes), report.mediaPreparation.output.sha256);
        report.mediaPreparation.outputUnchanged = true;
      }
    }
    finally {
      assert.equal(path.dirname(root), await realpath(os.tmpdir())); assert.ok(path.basename(root).startsWith('mm-web-live-original-'));
      await rm(root, { recursive: true, force: true }); report.mediaPreparation.privateInputRemoved = true;
    }
  };
  try {
    assert.equal(path.dirname(filename), root); assert.equal(path.basename(filename), 'original.mp4');
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
      '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'copy', '-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart', filename];
    await runMediaTool('ffmpeg', args, commands, signal);
    const probe = target => runMediaTool('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-show_packets', '-show_data_hash', 'sha256',
      '-show_entries', 'stream=index,codec_name,codec_type,profile,level,width,height,pix_fmt,channels,sample_rate,time_base,duration:format=format_name,duration,size:packet=stream_index,size,data_hash', '-of', 'json', target], commands, signal).then(bytes => JSON.parse(bytes));
    const before = await probe(source), after = await probe(filename), output = await readFile(filename);
    report.mediaPreparation.probes = { source: before, output: after };
    assert.equal(after.streams.length, 2); assert.ok(output.length > 0 && output.length < 16 * 1024 * 1024);
    assert.match(before.format.format_name, /matroska/u); assert.match(after.format.format_name, /mp4/u);
    const packetEvidence = [];
    for (const [type, codec, fields] of [['video', 'h264', ['profile', 'level', 'width', 'height', 'pix_fmt']], ['audio', 'aac', ['profile', 'channels', 'sample_rate']]]) {
      const original = before.streams.find(stream => stream.codec_type === type), copied = after.streams.find(stream => stream.codec_type === type);
      assert.equal(original.codec_name, codec); assert.equal(copied.codec_name, codec);
      for (const field of fields) assert.deepEqual(copied[field], original[field], type + ':' + field);
      const packets = (value, stream) => value.packets.filter(packet => packet.stream_index === stream.index).map(packet => {
        assert.match(packet.data_hash, /^SHA256:[a-f0-9]{64}$/iu); assert.ok(Number(packet.size) > 0); return { size: Number(packet.size), sha256: packet.data_hash.toLowerCase() };
      });
      const expected = packets(before, original), actual = packets(after, copied);
      assert.ok(expected.length > 0); assert.deepEqual(actual, expected, 'Every ' + type + ' compressed packet must retain its payload and order.');
      packetEvidence.push({ type, sourceIndex: original.index, outputIndex: copied.index, count: actual.length, payloadManifestSha256: sha256(Buffer.from(JSON.stringify(actual))), source: original, output: copied });
    }
    assert.ok(Number(after.format.duration) > 12, 'The actual input must be long enough for visible playback progress and a UI stop.');
    assert.ok(Math.abs(Number(after.format.duration) - Number(before.format.duration)) < 1);
    report.mediaPreparation.output = { bytes: output.length, sha256: sha256(output), format: after.format, packetEvidence,
      identity: 'New MP4 container identity; selected compressed source packets are identical, complete file bytes differ.' };
    await verifySource();
    return { bytes: output, filename, close };
  } catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Controlled input preparation and cleanup failed.'); } throw error; }
}

export async function serveOriginal(bytes, records) {
  let origin;
  const responseClosures = [];
  const name = 'Original H264 AAC live channel';
  const server = createServer((request, response) => {
    const record = { at: new Date().toISOString(), method: request.method, route: request.url, range: request.headers.range ?? null,
      userAgent: request.headers['user-agent'] ?? null, status: null, bytes: 0, closed: false, finished: false };
    records.push(record);
    responseClosures.push(new Promise(resolve => response.once('close', () => { record.closed = true; resolve(); })));
    response.once('finish', () => { record.finished = true; });
    response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/channels.m3u' && ['GET', 'HEAD'].includes(request.method)) {
      const playlist = Buffer.from('#EXTM3U\n#EXTINF:-1 tvg-id="web-original" tvg-chno="1",' + name + '\n' + origin + '/original.mp4\n');
      record.status = 200; record.bytes = request.method === 'HEAD' ? 0 : playlist.length; record.sha256 = sha256(playlist);
      response.writeHead(200, { 'Content-Type': 'audio/x-mpegurl', 'Content-Length': playlist.length }); response.end(request.method === 'HEAD' ? undefined : playlist); return;
    }
    if (request.url !== '/original.mp4' || !['GET', 'HEAD'].includes(request.method)) { record.status = 404; response.writeHead(404).end(); return; }
    let start = 0, end = bytes.length - 1, status = 200;
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range);
      if (!match || !match[1] && !match[2]) { record.status = 416; response.writeHead(416, { 'Content-Range': 'bytes */' + bytes.length }).end(); return; }
      start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2])); end = match[1] && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) { record.status = 416; response.writeHead(416, { 'Content-Range': 'bytes */' + bytes.length }).end(); return; }
      status = 206; response.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + bytes.length);
    }
    const payload = bytes.subarray(start, end + 1);
    Object.assign(record, { status, start, end, bytes: request.method === 'HEAD' ? 0 : payload.length, sha256: sha256(payload) });
    response.writeHead(status, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': payload.length }); response.end(request.method === 'HEAD' ? undefined : payload);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, name, close: async () => {
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await Promise.all(responseClosures);
    assert.equal(server.listening, false); assert.ok(records.every(record => record.closed), 'Every original HTTP response must close.');
  } };
}

export async function configureLiveTv(fixture, upstream, report) {
  const cachePath = fixture.application.liveStreamProbe.cachePath;
  await mkdir(cachePath, { recursive: true }); await writeFile(path.join(cachePath, 'sd-countries.json'), '{"Controlled":[]}\n');
  const response = await fixture.administratorRequest('/LiveTv/TunerHosts', { method: 'POST', body: {
    Type: 'm3u', Url: upstream.origin + '/channels.m3u', AllowStreamSharing: false, TunerCount: 0,
  } });
  assert.equal(response.status, 200, await response.clone().text()); report.tuner = await response.json();
  assert.equal(report.tuner.Type, 'm3u'); assert.equal(report.tuner.AllowStreamSharing, false);
  const result = await until(async () => {
    const [task, channels] = await Promise.all([fixture.application.tasks.get(refreshGuideTaskId), fixture.administratorRequest('/LiveTv/Channels?enableImages=false').then(async response => {
      assert.equal(response.status, 200); return response.json();
    })]);
    if (task.State === 'Idle' && task.LastExecutionResult?.Status === 'Failed') throw new Error('Actual Guide failed: ' + stringifyNativeJson(task));
    return { task, channels };
  }, result => result.task.State === 'Idle' && result.task.LastExecutionResult?.Status === 'Completed' && result.channels.Items.length === 1, 'official M3U Guide channel');
  assert.equal(result.channels.Items[0].Name, upstream.name); report.guide = result;
  return result.channels.Items[0];
}

export async function mediaRows(application) {
  return application.store.run(async database => {
    const result = {};
    for (const name of ['BaseItems', 'MediaStreamInfos', 'BaseItemProviders', 'BaseItemImageInfos', 'AncestorIds', 'ItemValues', 'ItemValuesMap']) {
      const rows = await database.rows(name); assert.ok(rows.length < 256, name + ' remains a controlled bounded input.');
      result[name] = rows.map(row => stringifyNativeJson(row)).sort();
    }
    return result;
  });
}

// Observe the extra public descriptor GET independently from the actual client.
// Hash every native table value without publishing authentication/password rows.
export async function descriptorSnapshot(application) {
  const database = await application.store.run(async database => {
    const tables = {};
    for (const table of nativeModel.tables) {
      const rows = await database.rows(table.name); assert.ok(rows.length < 512);
      const hashes = rows.map(row => sha256(Buffer.from(stringifyNativeJson(row)))).sort();
      tables[table.name] = { count: rows.length, rowHashes: hashes };
    }
    return tables;
  });
  const files = {};
  for (const [label, root] of [['configuration', application.liveTv.configurationDirectoryPath], ['cache', application.liveStreamProbe.cachePath]]) {
    assert.equal(path.relative(path.toNamespacedPath(path.resolve(root)), path.toNamespacedPath(await realpath(root))), '');
    const entries = [];
    const visit = async (directory, prefix = '') => {
      const info = await lstat(directory); assert.equal(info.isSymbolicLink(), false); assert.equal(info.isDirectory(), true);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        assert.equal(entry.isSymbolicLink(), false);
        const relative = prefix + entry.name, filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(filename, relative + '/');
        else {
          assert.equal(entry.isFile(), true); const bytes = await readFile(filename);
          assert.ok(bytes.length < 16 * 1024 * 1024); entries.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
          assert.ok(entries.length < 512);
        }
      }
    };
    await visit(root); files[label] = entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }
  return { database, files, mediaRows: await mediaRows(application) };
}

// Use the production GUID index selector while retaining every original row
// identity and value in the evidence; no fixture-side GUID rewriting.
export function savedChannelData(fixture, channelId) {
  return fixture.application.store.run(database => loadPostgresUserDataRows(database, fixture.userId, [channelId]));
}
