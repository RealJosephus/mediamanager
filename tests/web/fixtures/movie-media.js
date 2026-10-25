import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareOriginal, runMediaTool, sha256 } from './live-tv/scenario.js';

const subtract = (left, right) => ({ n: left.n * right.d - right.n * left.d, d: left.d * right.d });
const add = (left, right) => ({ n: left.n * right.d + right.n * left.d, d: left.d * right.d });
const time = (ticks, clock) => {
  const [n, d] = clock.split('/').map(BigInt);
  return { n: BigInt(ticks) * n, d };
};
const decimalTime = value => {
  assert.match(value, /^\d+(?:\.\d+)?$/u);
  const [whole, fraction = ''] = value.split('.'), d = 10n ** BigInt(fraction.length);
  return { n: BigInt(whole) * d + BigInt(fraction || '0'), d };
};
function sameTime(expected, actual, resolution, label) {
  const difference = subtract(actual, expected);
  const magnitude = difference.n < 0n ? -difference.n : difference.n;
  assert.ok(magnitude * resolution.d <= resolution.n * difference.d, label);
}

/** Repeat existing compressed packets into a longer, independently identified MP4. */
export async function prepareMovieMedia({ root, filename, preparation, signal }) {
  const originalReport = {}, commands = [];
  const evidence = preparation.mediaPreparation = { original: originalReport, commands,
    encodingExecuted: false, productionRemuxExecuted: false };
  let original, failed = false, failure;
  try {
    signal?.throwIfAborted();
    original = await prepareOriginal(originalReport, { signal });
    signal?.throwIfAborted();
    const relative = path.relative(await realpath(root), path.resolve(filename));
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    assert.equal(path.basename(filename), 'Web feature (2026).mp4');
    const probe = async target => JSON.parse(await runMediaTool('ffprobe', ['-v', 'error', '-show_streams', '-show_format',
      '-show_packets', '-show_data_hash', 'sha256', '-show_entries',
      'stream=index,codec_name,codec_type,profile,level,width,height,pix_fmt,channels,sample_rate,time_base,duration:format=format_name,duration,size:packet=stream_index,pts,dts,duration,size,flags,data_hash',
      '-of', 'json', target], commands, signal));
    const source = await probe(original.filename), duration = Number(source.format.duration);
    assert.ok(Number.isFinite(duration) && duration > 12);
    const repetitions = Math.ceil(90 / duration);
    assert.ok(repetitions > 0 && repetitions <= 8);
    const list = path.join(path.dirname(original.filename), 'movie.ffconcat');
    const declaredDuration = source.format.duration, durationTime = decimalTime(declaredDuration);
    const body = 'ffconcat version 1.0\n' + ("file 'original.mp4'\nduration " + declaredDuration + '\n').repeat(repetitions);
    await writeFile(list, body, { flag: 'wx' });
    evidence.concat = { repetitions, duration: declaredDuration, bytes: Buffer.byteLength(body), sha256: sha256(Buffer.from(body)) };
    await runMediaTool('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-f', 'concat',
      '-auto_convert', '0', '-i', list, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'copy',
      '-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart', filename], commands, signal);
    const output = await probe(filename), bytes = await readFile(filename);
    evidence.probes = { source, output };
    assert.equal(output.streams.length, 2);
    assert.ok(bytes.length > 0 && bytes.length < 16 * 1024 * 1024);
    assert.ok(Number(output.format.duration) >= 90, 'The real movie must support the unchanged resume policy and UI playback window.');
    const videoBefore = source.streams.find(stream => stream.codec_type === 'video'), videoAfter = output.streams.find(stream => stream.codec_type === 'video');
    const originalVideo = source.packets.filter(packet => packet.stream_index === videoBefore.index);
    const copiedVideo = output.packets.filter(packet => packet.stream_index === videoAfter.index);
    assert.ok(originalVideo.length > 0); assert.equal(copiedVideo.length, originalVideo.length * repetitions);
    const originalOrigin = time(originalVideo[0].pts, videoBefore.time_base);
    const copiedOrigin = time(copiedVideo[0].pts, videoAfter.time_base);
    evidence.concat.timeline = [];
    for (let repeat = 0; repeat < repetitions; repeat++) {
      const first = copiedVideo[repeat * originalVideo.length];
      const actual = subtract(time(first.pts, videoAfter.time_base), copiedOrigin);
      const expected = { ...durationTime, n: durationTime.n * BigInt(repeat) };
      const resolution = add(time(2, videoAfter.time_base), { n: BigInt(repeat), d: durationTime.d });
      sameTime(expected, actual, resolution, 'Repeated video packets must follow the declared concat timeline.');
      evidence.concat.timeline.push({ repeat, videoPts: first.pts, videoTimeBase: videoAfter.time_base,
        expectedElapsed: expected.n + '/' + expected.d, actualElapsed: actual.n + '/' + actual.d });
    }
    const packetEvidence = [];
    for (const type of ['video', 'audio']) {
      const before = source.streams.find(stream => stream.codec_type === type), after = output.streams.find(stream => stream.codec_type === type);
      for (const key of ['codec_name', 'profile', ...(type === 'video' ? ['level', 'width', 'height', 'pix_fmt'] : ['channels', 'sample_rate'])]) {
        assert.deepEqual(after[key], before[key], type + ':' + key);
      }
      const originals = source.packets.filter(packet => packet.stream_index === before.index);
      const copied = output.packets.filter(packet => packet.stream_index === after.index);
      assert.ok(originals.length > 0); assert.equal(copied.length, originals.length * repetitions);
      const resolution = add(add(time(1, before.time_base), time(1, after.time_base)),
        add(time(1, videoBefore.time_base), time(1, videoAfter.time_base)));
      for (let repeat = 0; repeat < repetitions; repeat++) {
        const reference = time(copiedVideo[repeat * originalVideo.length].pts, videoAfter.time_base);
        for (let index = 0; index < originals.length; index++) {
          const expected = originals[index], actual = copied[repeat * originals.length + index];
          assert.equal(actual.size, expected.size); assert.equal(actual.data_hash, expected.data_hash);
          assert.equal(actual.flags, expected.flags);
          for (const field of ['pts', 'dts']) sameTime(subtract(time(expected[field], before.time_base), originalOrigin),
            subtract(time(actual[field], after.time_base), reference), resolution, type + ':' + repeat + ':' + index + ':' + field);
          assert.ok(BigInt(actual.duration) > 0n);
          const previous = copied[repeat * originals.length + index - 1];
          if (previous) assert.ok(BigInt(actual.dts) > BigInt(previous.dts), 'Repeated packets must retain a progressing decode timeline.');
        }
      }
      packetEvidence.push({ type, sourcePackets: originals.length, outputPackets: copied.length,
        payloadManifestSha256: sha256(Buffer.from(JSON.stringify(copied.map(packet => ({ size: packet.size, hash: packet.data_hash }))))),
        source: before, output: after });
    }
    evidence.output = { bytes: bytes.length, sha256: sha256(bytes), format: output.format, packetEvidence,
      identity: 'New repeated MP4 container and timeline; each occurrence preserves the selected original compressed packets.' };
  } catch (error) { failed = true; failure = error; }
  finally {
    try { await original?.close(); }
    catch (error) {
      failure = failed ? new AggregateError([failure, error], 'Movie input preparation and cleanup failed.') : error;
      failed = true;
    }
  }
  if (failed) throw failure;
  return evidence;
}
