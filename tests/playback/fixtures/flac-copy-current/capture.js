import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { validationExecutable, validationOutputRoot } from '../../../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const fixture = new URL('./', import.meta.url);
export const profileBytes = await fs.readFile(new URL('input.json', fixture));
export const profile = JSON.parse(profileBytes);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const errorValue = value => value == null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(errorValue)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(value), ...(value instanceof Error ? ['name', 'message', 'code', 'status', 'statusCode', 'cause', 'errors', 'stack'] : [])])]
    .map(key => [key, errorValue(value[key])]));
export const json = value => JSON.stringify(value, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

async function observeProcessExit(native) {
  const pids = [...new Set([...native.traces.flatMap(trace => [trace.value.wrapperPid, trace.value.childPid]),
    native.originalProbe.pid, ...native.cases.flatMap(row => [row.process?.pid, row.probe?.pid])].filter(pid => pid != null))];
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline && pids.some(alive)) await delay(20);
  return pids.map(pid => ({ pid, alive: alive(pid) }));
}

function rational(value, timeBase) {
  if (value == null) return null;
  const [numerator, denominator] = timeBase.split('/').map(BigInt);
  let top = BigInt(value) * numerator, bottom = denominator;
  const gcd = (a, b) => b === 0n ? a : gcd(b, a % b);
  const factor = gcd(top < 0n ? -top : top, bottom); top /= factor; bottom /= factor;
  return `${top}/${bottom}`;
}
export function packets(raw) {
  const streams = new Map(raw.streams.map(stream => [stream.index, stream]));
  return raw.packets.map(packet => ({ codec: streams.get(packet.stream_index).codec_name, dataHash: packet.data_hash,
    size: String(packet.size), pts: rational(packet.pts, streams.get(packet.stream_index).time_base),
    dts: rational(packet.dts, streams.get(packet.stream_index).time_base), duration: rational(packet.duration, streams.get(packet.stream_index).time_base) }));
}
export function audioStreams(raw) {
  return raw.streams.map(stream => ({ codec: stream.codec_name, type: stream.codec_type, sampleRate: stream.sample_rate,
    channels: stream.channels, channelLayout: stream.channel_layout, bitsPerRawSample: stream.bits_per_raw_sample }));
}
export async function inspectPackets(filename, output, signal) {
  const packetProbeExecutable = validationExecutable('ffprobe'), args = ['-v', 'error', '-show_format', '-show_streams', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', filename];
  const result = await new Promise(resolve => {
    const child = execFile(packetProbeExecutable, args, {
      windowsHide: true, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, signal,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }));
  });
  await fs.writeFile(output, result.stdout, { flag: 'wx' });
  await fs.writeFile(output + '.stderr.txt', result.stderr, { flag: 'wx' });
  if (result.error) throw Object.assign(result.error, { originalPacketOutput: output, originalPacketDiagnostics: output + '.stderr.txt',
    originalPacketProcess: { pid: result.pid, exitCode: result.exitCode, signalCode: result.signalCode } });
  return { executable: await describeFile(packetProbeExecutable), args, pid: result.pid, exitCode: result.exitCode, signalCode: result.signalCode,
    output: await describeFile(output), raw: JSON.parse(result.stdout), stderr: result.stderr.toString() };
}

let pending;
export const captureCurrentFlac = () => pending ??= capture();
async function capture() {
  const output = path.join(validationOutputRoot(), 'flac-copy-current-' + randomUUID()); await fs.mkdir(output);
  const assetPath = fileURLToPath(new URL(profile.asset.filename, fixture));
  const report = { schemaVersion: 1, scope: 'Existing original mono FLAC; actual Native audio admission and original packet copy, followed by separate Node formal runtime consumers.',
    sourceBindings: [], inputs: [], captures: [], actualNativeExecuted: false, componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    const asset = await describeFile(assetPath); assert.equal(asset.bytes, profile.asset.bytes); assert.equal(asset.sha256, profile.asset.sha256);
    const originalIndex = JSON.parse(await fs.readFile(new URL('assets/asset-index.json', fixture)));
    for (const expected of originalIndex.files) {
      const filename = fileURLToPath(new URL('assets/upstream/' + expected.path, fixture)), bytes = await fs.readFile(filename);
      const actual = await describeFile(filename);
      assert.equal(actual.bytes, expected.bytes, expected.path); assert.equal(actual.sha256, expected.sha256, expected.path);
      const actualGitBlob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      assert.equal(actualGitBlob, expected.gitBlob, expected.path + ': original Git blob');
      report.inputs.push({ role: 'unchanged-upstream-asset-or-text', originalGitBlob: expected.gitBlob, actualGitBlob, actual });
    }
    for (const name of ['Program.cs', 'Oracle.csproj', 'input.json', 'capture.js', '.gitattributes', 'README.md', 'assets/asset-index.json', 'assets/metadata-index.json']) {
      report.inputs.push({ role: 'actual-checkout-bytes', actual: await describeFile(fileURLToPath(new URL(name, fixture))) });
    }
    const build = await verifyNativeBuild(); report.nativeBuild = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256 };
    const manifest = JSON.parse(await fs.readFile(path.join(build.sourceOfferRoot, 'jellyfin-source-manifest.json')));
    for (const relative of profile.nativeSourcePaths) {
      const expected = manifest.files.find(entry => entry.path === relative); assert.ok(expected, relative);
      const actual = await describeFile(path.join(build.sourceRoot, relative)); assert.equal(actual.sha256, expected.sha256, relative);
      report.sourceBindings.push({ relative, actual, expected });
    }
    const input = path.join(output, 'input.json'), inputBytes = Buffer.from(json({ ...profile, assetPath })); await fs.writeFile(input, inputBytes, { flag: 'wx' });
    const executable = { ffmpeg: validationExecutable('ffmpeg'), ffprobe: validationExecutable('ffprobe') };
    const captures = [];
    for (const label of ['initial', 'repeat']) {
      const directory = path.join(output, label);
      const record = await recordOracle({ project: fileURLToPath(new URL('Oracle.csproj', fixture)), output: directory,
        args: [input, '{output}/native.json', executable.ffmpeg, executable.ffprobe] });
      const filename = path.join(directory, 'native.json'), bytes = await fs.readFile(filename), native = JSON.parse(bytes);
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(native.inputSha256, hash(inputBytes)); assert.deepEqual(native.failures, []);
      assert.equal(native.sourceBefore.sha256, profile.asset.sha256); assert.equal(native.sourceAfter.sha256, profile.asset.sha256);
      for (const flag of ['startupAccepted', 'actualMediaEncoder', 'actualAudioStreamBuilder', 'actualCommandBuilders', 'encoderDisposed', 'inputHostClosed']) assert.equal(native[flag], true, flag);
      for (const assembly of native.assemblies) assert.equal((await describeFile(path.join(build.runtime, assembly.name + '.dll'))).sha256, assembly.sha256);
      for (const sample of profile.cases) {
        const row = native.cases.find(row => row.name === sample.name); assert.ok(row, sample.name);
        assert.equal(row.accepted, sample.execute === true, sample.name + ': complete Native audio copy admission');
        if (!row.accepted) continue;
        assert.equal(row.process.ExitCode, 0); assert.equal(row.probe.ExitCode, 0);
        assert.deepEqual(packets(row.probe.raw), packets(native.originalProbe.raw), sample.name + ': unchanged original packet payload and full timing');
        assert.deepEqual(audioStreams(row.probe.raw), audioStreams(native.originalProbe.raw), sample.name + ': unchanged audio stream parameters');
      }
      const processesAfter = await observeProcessExit(native); report.captures.at(-1).processesAfter = processesAfter;
      assert.ok(processesAfter.every(process => !process.alive), 'All actual Native copy, probe and apphost processes exited.');
      captures.push(native);
    }
    for (const sample of profile.cases.filter(sample => sample.execute)) {
      const first = captures[0].cases.find(row => row.name === sample.name), second = captures[1].cases.find(row => row.name === sample.name);
      assert.deepEqual(packets(first.probe.raw), packets(second.probe.raw), sample.name + ': independent Native packet/timing repeat');
      assert.deepEqual(audioStreams(first.probe.raw), audioStreams(second.probe.raw));
    }
    assert.equal((await describeFile(assetPath)).sha256, profile.asset.sha256); report.actualNativeExecuted = true;
    return { output, assetPath, native: captures[0], repeat: captures[1], report };
  } catch (error) { report.failure = errorValue(error); throw error; }
  finally { await fs.writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}
