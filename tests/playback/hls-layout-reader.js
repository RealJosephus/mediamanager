import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validationExecutable } from '../../tools/validation/paths.js';
import { hlsManifestProjection } from './layout-projection.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const packets = probe => ({ format: { duration: probe.format.duration, start_time: probe.format.start_time }, streams: probe.streams.map(stream => Object.fromEntries(
  ['codec_name', 'profile', 'width', 'height', 'pix_fmt', 'sample_rate', 'channels'].filter(key => stream[key] != null).map(key => [key, stream[key]]))),
  packets: probe.packets.map(packet => Object.fromEntries(['stream_index', 'pts_time', 'dts_time', 'duration_time', 'size', 'data_hash', 'flags']
    .filter(key => packet[key] != null).map(key => [key, packet[key]]))) });

async function probe(url) {
  // User-Agent is part of the real job identity. Match the existing HTTP
  // client's value so only manifest layout changes in this consumer probe.
  // Exercise the reader's normal concurrent segment requests as well as layout.
  const args = ['-v', 'error', '-protocol_whitelist', 'http,tcp', '-user_agent', 'node', '-http_multiple', '1',
    '-show_format', '-show_streams', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', url];
  const child = spawn(validationExecutable('ffprobe'), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
  const timer = setTimeout(() => child.kill(), 20000);
  let status, signal;
  try { [status, signal] = await once(child, 'close'); } finally { clearTimeout(timer); }
  const raw = { pid: child.pid, args, status, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  try { assert.equal(status, 0, raw.stderr); assert.equal(signal, null); }
  catch (error) { error.readerObservation = raw; throw error; }
  return { raw, parsed: JSON.parse(raw.stdout) };
}

function absolute(text, base) {
  return text.split(/\r\n|\n/u).map(line => line.startsWith('#')
    ? line.replace(/URI="([^"]+)"/gu, (_, uri) => `URI="${new URL(uri, base)}"`)
    : line ? new URL(line, base).toString() : line).join('\n');
}

export async function readDeliveredHlsLayouts({ masterText, masterUrl, mainText, mainUrl, processCount = () => null, onObservation }) {
  const inputs = new Map([['/master.m3u8', absolute(masterText, masterUrl)], ['/main.m3u8', absolute(mainText, mainUrl)]]);
  const deliveries = [], results = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    let text = inputs.get(url.pathname); assert.ok(text);
    if (url.searchParams.get('layout') !== 'base') {
      text = text.replace(/^#EXTINF:(\d+(?:\.\d+)?),/gmu, (_, duration) => `#EXTINF:${duration.includes('.') ? duration + '000' : duration + '.000'},`)
        .split('\n').join('\n\n');
      if (url.searchParams.get('layout') === 'crlf') text = text.replaceAll('\n', '\r\n');
    }
    const bytes = Buffer.from(text);
    deliveries.push({ path: url.pathname, layout: url.searchParams.get('layout'), text, bytes: bytes.toString('base64'), length: bytes.length });
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': bytes.length }); response.end(bytes);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let failure;
  try {
    for (const pathname of inputs.keys()) {
      let reference, baseProcesses;
      for (const layout of ['base', 'lf', 'crlf']) {
        const url = origin + pathname + '?layout=' + layout;
        const delivered = await fetch(url), bytes = Buffer.from(await delivered.arrayBuffer());
        assert.equal(delivered.status, 200); assert.equal(Number(delivered.headers.get('content-length')), bytes.length);
        assert.deepEqual(hlsManifestProjection(bytes.toString()), hlsManifestProjection(inputs.get(pathname)));
        const actual = await probe(url), semantic = packets(actual.parsed);
        assert.ok(semantic.streams.length); assert.ok(semantic.packets.length);
        reference ??= semantic;
        baseProcesses ??= processCount();
        assert.deepEqual(semantic, reference, pathname + '/' + layout + ' actual reader packets and stream values');
        assert.equal(processCount(), baseProcesses, pathname + '/' + layout + ' must reuse the baseline job/cache identities');
        results.push({ path: pathname, layout, jobProcesses: processCount(), packetHash: sha(JSON.stringify(semantic)), packetCount: semantic.packets.length, process: actual.raw });
      }
    }
  } catch (error) { failure = error; }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const filename = validationExecutable('ffprobe');
  const observed = { inputs: [...inputs], deliveries, results, reader: { filename, sha256: sha(await readFile(filename)) }, serverStopped: !server.listening,
    failure: failure ? { message: failure.message, reader: failure.readerObservation } : null };
  await onObservation?.(observed);
  if (failure) throw failure;
  return observed;
}
