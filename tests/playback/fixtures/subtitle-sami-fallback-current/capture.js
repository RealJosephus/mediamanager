import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { assertIsolatedOutput, validationExecutable } from '../../../../tools/validation/paths.js';
import { nativeSourcePaths, subtitleSamiFallbackInput } from './input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
export const errorValue = value => value == null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(errorValue)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(value), ...(value instanceof Error ? ['name', 'message', 'code', 'status', 'cause', 'errors', 'stack'] : [])])]
    .map(key => [key, errorValue(value[key])]));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const fileValue = value => value.exists ? { exists: true, bytes: value.bytes, base64: value.base64, sha256: value.sha256 } : { exists: false };
const stateValue = value => ({ source: { ...fileValue(value.source), ...(value.source.exists ? { modifiedTicks: value.source.modifiedTicks } : {}) },
  cache: fileValue(value.cache), meta: fileValue(value.meta) });

// Absolute input roots, PIDs, clocks, CLR errors and encoding-confidence details
// remain in the originals. The independent-repeat comparison concerns bytes,
// persistent source stamps, public responses and actual process closure.
export const functionalSamiFallback = native => native.cases.map(sample => ({ name: sample.name, protocol: sample.protocol,
  actions: sample.actions.map(action => ({ name: action.name, op: action.op, before: stateValue(action.before), after: stateValue(action.after),
    ...(action.wire ? { wire: action.wire } : {}),
    ...(action.cancellation ? { cancelledAfterActualRead: action.cancellation.triggered } : {}),
  })),
}));

async function assertFileBytes(value) {
  if (!value.exists) return;
  const bytes = Buffer.from(value.base64, 'base64');
  assert.equal(bytes.length, value.bytes, value.filename);
  assert.equal(hash(bytes), value.sha256, value.filename);
}

async function assertOriginals(native, input, build, capture) {
  assert.equal(native.actualExecution, true);
  assert.equal(native.startupAccepted, true, 'Actual MediaEncoder accepted the same-run media tool.');
  assert.equal(native.errorEnvironment, 'Production');
  assert.deepEqual(native.failures, [], 'Harness failures cannot establish a Native behavior baseline.');
  for (const flag of ['inputHostStarted', 'inputHostClosed', 'inputClientsClosed', 'subtitleEncoderDisposed', 'protocolManagerDisposed', 'mediaEncoderDisposed'])
    assert.equal(native[flag], true, flag);
  assert.deepEqual(native.emergencyCleanup, [], 'A process surviving the domain call is not hidden by emergency fixture cleanup.');
  assert.deepEqual(native.cases.map(sample => sample.name), input.cases.map(sample => sample.name));
  for (const assembly of native.assemblies) assert.equal((await describeFile(path.join(build.runtime, assembly.name + '.dll'))).sha256, assembly.sha256, assembly.name);
  const cancelled = new Set(native.cases.flatMap(sample => sample.actions.filter(action => action.cancellation?.triggered).flatMap(action => action.traceFiles)));
  const completed = new Set(native.completedRequests);
  for (const trace of native.traces) {
    assert.equal(trace.value.harnessError, undefined, 'Apphost control failure is not a domain failure.');
    if (trace.value.forwarded && !cancelled.has(trace.filename)) {
      assert.equal(Number.isInteger(trace.value.exitCode), true, 'The real forwarded process produced its close result.');
      assert.equal(typeof trace.value.closedUtc, 'string');
      assert.equal(trace.stdout.exists, true); assert.equal(trace.stderr.exists, true);
    }
    for (const value of [trace.stdout, trace.stderr]) await assertFileBytes(value);
    if (trace.value.pipeErrors) assert.deepEqual(trace.value.pipeErrors, []);
  }
  for (const definition of input.cases) {
    const sample = native.cases.find(sample => sample.name === definition.name);
    const original = Buffer.from(input.sources.find(source => source.name === definition.source).base64, 'base64');
    assert.equal(sample.actions[0].before.source.sha256, hash(original), definition.name + ': exact declared original bytes');
    assert.deepEqual(sample.actions.map(action => ({ name: action.name, op: action.op })), definition.actions.map(action => ({ name: action.name, op: action.op })));
    for (const action of sample.actions) {
      assert.equal(action.harnessError, undefined);
      for (const state of [action.before, action.after]) for (const value of [state.source, state.cache, state.meta]) await assertFileBytes(value);
      if (action.wire) {
        assert.equal(Buffer.from(action.wire.base64, 'base64').length, action.wire.bytes);
        assert.equal(hash(Buffer.from(action.wire.base64, 'base64')), action.wire.sha256);
        if (action.streamAcquired) assert.equal(action.streamDisposed, true, 'The actual returned subtitle stream closed.');
        if (sample.protocol === 'File' && action.after.source.exists && action.after.cache.bytes > 0 && action.after.meta.exists)
          assert.equal(action.after.meta.text, `${action.after.source.bytes}:${action.after.source.modifiedTicks}`, 'Native persistent source size/mtime metadata bytes.');
      }
      if (action.after.cache.exists) assert.equal(action.cacheReopenedExclusively, true, 'The actual persistent cache was usable after consumption.');
      for (const process of action.processesAfter) assert.equal(process.Alive, false, 'The actual action process closed.');
      for (const request of action.sourceRequests) {
        assert.equal(request.finished, true, 'The actual input response drained or aborted.');
        await assertFileBytes(request.source);
        if (!request.aborted) assert.ok(completed.has(request.requestId), 'The actual input HTTP response completed.');
        if (request.heldForCancellation) {
          assert.equal(action.cancellation?.triggered, true);
          assert.equal(request.bodyWritten, 0, 'Cancellation followed a real held FFmpeg read, before fixture source delivery.');
        }
      }
    }
  }
  for (const sample of native.filesAfterClose) for (const value of [sample.snapshot.source, sample.snapshot.cache, sample.snapshot.meta]) {
    await assertFileBytes(value);
    if (value.exists) assert.equal((await describeFile(value.filename)).sha256, value.sha256, 'Original persistent bytes after Native close.');
  }
  const pids = [...new Set([native.pid, ...native.processesAfter.map(process => process.Pid)])];
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline && pids.some(alive)) await delay(20);
  capture.processesAfter = pids.map(pid => ({ pid, alive: alive(pid) }));
  assert.ok(capture.processesAfter.every(process => !process.alive), 'The actual consumer, media tools and apphosts exited.');
  for (const process of native.processesAfter) assert.equal(process.Alive, false);
}

/** The caller holds native-media-5244 once around both recordings and its Node
 * consumer. Each recording writes independent source/config/cache/process roots.
 * Run only under the supplied Actions validation environment. */
export async function captureCurrentSamiFallback({ output, inputFile, signal }) {
  assertIsolatedOutput(output);
  await fs.mkdir(output, { recursive: true });
  const report = { schemaVersion: 1, scope: 'Current external .sami FFmpeg/SRT fallback; original public responses, persistent cache/meta, real media-process and input-host closure. HTTP Native observations do not advertise production HTTP identity support.',
    inputs: [], sourceBindings: [], captures: [], actualNativeExecuted: false, componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false };
  let failed = false, primary;
  try {
    signal?.throwIfAborted();
    for (const name of ['Program.cs', 'Oracle.csproj', 'input.js', 'capture.js', '.gitattributes', 'README.md'])
      report.inputs.push({ role: 'current-fixture-source', actual: await describeFile(fileURLToPath(new URL(name, import.meta.url))) });
    report.inputs.push({ role: 'unchanged-unmarked-single-cedilla-input-source', actual: await describeFile(fileURLToPath(new URL('../subtitle-sami-boundaries-current/input.js', import.meta.url))) });
    if (!inputFile) {
      inputFile = path.join(output, 'input.json');
      await fs.writeFile(inputFile, json(subtitleSamiFallbackInput()), { flag: 'wx' });
    }
    const bytes = await fs.readFile(inputFile), input = JSON.parse(bytes);
    report.input = await describeFile(inputFile);
    const build = await verifyNativeBuild();
    report.nativeBuild = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256 };
    const manifest = JSON.parse(await fs.readFile(path.join(build.sourceOfferRoot, 'jellyfin-source-manifest.json')));
    for (const relative of nativeSourcePaths) {
      const expected = manifest.files.find(entry => entry.path === relative); assert.ok(expected, relative);
      const actual = await describeFile(path.join(build.sourceRoot, relative)); assert.equal(actual.sha256, expected.sha256, relative);
      report.sourceBindings.push({ relative, expected, actual });
    }
    const tools = { ffmpeg: validationExecutable('ffmpeg'), ffprobe: validationExecutable('ffprobe') };
    report.tools = { ffmpeg: await describeFile(tools.ffmpeg), ffprobe: await describeFile(tools.ffprobe) };
    const captures = [];
    for (const label of ['initial', 'repeat']) {
      signal?.throwIfAborted();
      const directory = path.join(output, label), capture = { label };
      report.captures.push(capture);
      capture.record = await recordOracle({ project: fileURLToPath(new URL('Oracle.csproj', import.meta.url)), output: directory,
        args: [inputFile, '{output}/native.json', tools.ffmpeg, tools.ffprobe] });
      const filename = path.join(directory, 'native.json'), native = JSON.parse(await fs.readFile(filename));
      capture.observation = await describeFile(filename); assert.equal(native.inputSha256, hash(bytes));
      assert.equal(native.tools.ffmpeg.sha256, report.tools.ffmpeg.sha256);
      assert.equal(native.tools.ffprobe.sha256, report.tools.ffprobe.sha256);
      await assertOriginals(native, input, build, capture);
      captures.push(native);
    }
    assert.deepEqual(functionalSamiFallback(captures[0]), functionalSamiFallback(captures[1]),
      'Independent Native source/cache/meta bytes, public bodies and cancellation outcomes.');
    assert.equal(hash(await fs.readFile(inputFile)), hash(bytes), 'Neutral input bytes stayed unchanged.');
    report.actualNativeExecuted = true;
    return { input, native: captures[0], repeat: captures[1], report, output };
  } catch (error) { failed = true; primary = error; report.failure = errorValue(error); throw error; }
  finally {
    try { await fs.writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
    catch (error) { if (failed) throw new AggregateError([primary, error], 'SAMI fallback capture and original-report persistence failed.', { cause: primary }); throw error; }
  }
}
