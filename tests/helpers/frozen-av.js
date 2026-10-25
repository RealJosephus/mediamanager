import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { runMediaTool } from './media-tool.js';

const manifestUrl = new URL('../fixtures/frozen-av/input.json', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readFrozenAv(asset = 'source.m2ts', { signal } = {}) {
  signal?.throwIfAborted();
  const manifest = JSON.parse(await readFile(manifestUrl));
  const source = manifest.files.find(file => file.filename === asset);
  assert.ok(source);
  const sources = new Map([
    ['source.m2ts', new URL('../fixtures/frozen-av/source.m2ts', import.meta.url)],
    ['dual-avc.m2ts', new URL('../fixtures/frozen-av/dual-avc.m2ts', import.meta.url)]
  ]);
  assert.ok(sources.has(asset));
  const filename = fileURLToPath(sources.get(asset));
  const bytes = await readFile(filename);
  signal?.throwIfAborted();
  assert.equal(bytes.length, source.bytes); assert.equal(sha256(bytes), source.sha256);
  return { filename, bytes, source, manifest };
}

/** Only the fixture container and metadata change; selected media payloads stay original. */
export async function prepareFrozenVideo(directory, { container = 'matroska', metadata = {}, metadataFile,
  includeAudio = false, name = 'original', signal } = {}) {
  signal?.throwIfAborted();
  assert.ok(['matroska', 'vob', 'mp4'].includes(container)); assert.match(name, /^[a-zA-Z0-9_-]+$/u);
  const source = await readFrozenAv('source.m2ts', { signal });
  const filename = path.join(directory, name + (container === 'matroska' ? '.mkv' : '.' + container));
  const report = { input: { filename: source.filename, ...source.source, historicalSource: source.manifest.source },
    output: { filename }, commands: [], encodingExecuted: false };
  const evidenceDirectory = validationOutputRoot(); await mkdir(evidenceDirectory, { recursive: true });
  const evidence = path.join(evidenceDirectory, 'frozen-video-copy-' + randomUUID() + '.json');
  const run = (tool, args) => runMediaTool(tool, args, report.commands, signal);
  const probe = async target => JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-show_packets',
    '-show_data_hash', 'sha256', '-of', 'json', target]));
  let failed = false, failure;
  try {
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-i', source.filename];
    if (metadataFile) {
      const bytes = await readFile(metadataFile);
      report.metadataInput = { filename: metadataFile, bytes: bytes.length, sha256: sha256(bytes), text: bytes.toString('utf8') };
      args.push('-f', 'ffmetadata', '-i', metadataFile);
    }
    args.push('-map', '0:v:0', '-c:v', 'copy');
    if (includeAudio) args.push('-map', '0:a:0', '-c:a', 'copy');
    else args.push('-an');
    args.push('-sn', '-dn', '-map_metadata', metadataFile ? '1' : '-1');
    if (metadataFile) args.push('-map_chapters', '1');
    for (const [key, value] of Object.entries(metadata)) args.push('-metadata', key + '=' + value);
    if (container === 'mp4') args.push('-movflags', '+faststart+use_metadata_tags');
    args.push('-f', container, filename);
    await run('ffmpeg', args);
    const before = await probe(source.filename), after = await probe(filename), bytes = await readFile(filename);
    report.probes = { source: before, output: after };
    assert.equal(after.streams.length, includeAudio ? 2 : 1);
    const packets = (value, stream) => value.packets.filter(packet => packet.stream_index === stream.index);
    const payloads = values => values.map(packet => {
      assert.ok(Number(packet.size) > 0); assert.match(packet.data_hash, /^SHA256:[a-f0-9]{64}$/iu);
      return { bytes: Number(packet.size), sha256: packet.data_hash.toLowerCase() };
    });
    const seconds = (value, stream) => {
      const [numerator, denominator] = stream.time_base.split('/').map(Number);
      return Number(value) * numerator / denominator;
    };
    const videoBefore = before.streams.find(stream => stream.codec_type === 'video');
    const videoAfter = after.streams.find(stream => stream.codec_type === 'video');
    const reference = (value, stream) => {
      const first = packets(value, stream).find(packet => packet.pts != null);
      assert.ok(first); return seconds(first.pts, stream);
    };
    const originBefore = reference(before, videoBefore), originAfter = reference(after, videoAfter);
    const packetEvidence = [];
    for (const type of includeAudio ? ['video', 'audio'] : ['video']) {
      const original = before.streams.find(stream => stream.codec_type === type);
      const copied = after.streams.find(stream => stream.codec_type === type);
      for (const key of ['codec_type', 'codec_name', 'width', 'height', 'pix_fmt', 'channels', 'sample_rate']) {
        assert.equal(copied[key], original[key], type + ':' + key);
      }
      const originalPackets = packets(before, original), copiedPackets = packets(after, copied);
      const expected = payloads(originalPackets), actual = payloads(copiedPackets);
      assert.ok(expected.length > 0); assert.deepEqual(actual, expected, type + ' packet payloads and order must remain unchanged.');
      const resolution = seconds(1, original) + seconds(1, copied), timing = [];
      for (let index = 0; index < originalPackets.length; index++) for (const field of ['pts', 'dts', 'duration']) {
        const left = originalPackets[index][field], right = copiedPackets[index][field];
        if (left == null || right == null) continue;
        const expectedTime = seconds(left, original) - (field === 'duration' ? 0 : originBefore);
        const actualTime = seconds(right, copied) - (field === 'duration' ? 0 : originAfter);
        assert.ok(Math.abs(actualTime - expectedTime) <= resolution + 1e-12, type + ' packet ' + index + ':' + field);
        timing.push({ index, field, expected: expectedTime, actual: actualTime });
      }
      packetEvidence.push({ type, packetCount: actual.length, packetManifestSha256: sha256(Buffer.from(JSON.stringify(actual))),
        sourceTimeBase: original.time_base, outputTimeBase: copied.time_base, timestampResolutionSeconds: resolution, timing });
    }
    const duration = Number(after.format.duration);
    assert.ok(Number.isFinite(duration) && duration > 0);
    const runTimeTicks = BigInt(Math.trunc(duration * 10000000));
    report.output = { ...report.output, bytes: bytes.length, sha256: sha256(bytes), packetEvidence, runTimeTicks: runTimeTicks.toString() };
    assert.equal(sha256(await readFile(source.filename)), source.source.sha256);
    report.inputUnchanged = true;
    signal?.throwIfAborted();
    return { bytes, filename, probe: after, runTimeTicks, evidence };
  } catch (error) {
    failed = true; failure = error; throw error;
  } finally {
    try { await writeFile(evidence, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) {
      if (failed) throw new AggregateError([failure, error], 'Frozen media preparation and evidence write failed.');
      throw error;
    }
  }
}
