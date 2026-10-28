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
import { nativeSourcePaths, subtitleHttpInput } from './input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
export const errorValue = value => value == null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(errorValue)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(value), ...(value instanceof Error ? ['name', 'message', 'code', 'status', 'cause', 'errors', 'stack'] : [])])]
    .map(key => [key, errorValue(value[key])]));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const fileValue = value => value.exists ? { exists: true, bytes: value.bytes, base64: value.base64, sha256: value.sha256 } : { exists: false };
const stateValue = value => ({ source: fileValue(value.source), cache: fileValue(value.cache), meta: fileValue(value.meta),
  sourceOnline: value.sourceOnline, sourceMode: value.sourceMode });
const publicHeaders = headers => Object.fromEntries(['allow', 'content-type', 'content-length', 'accept-ranges', 'content-range', 'content-disposition',
  'content-encoding', 'etag', 'last-modified', 'cache-control', 'vary', 'location']
  .filter(name => Object.hasOwn(headers, name)).map(name => [name, headers[name]]));

export const functionalHttpSubtitles = native => ({ profiles: native.profiles,
  cases: native.cases.map(sample => ({ name: sample.name, mediaProtocol: sample.mediaProtocol,
    subtitlePath: sample.subtitlePath, subtitleProtocol: sample.subtitleProtocol,
    actions: sample.actions.map(action => ({ name: action.name, op: action.op, before: stateValue(action.before), after: stateValue(action.after),
      ...(action.wire ? { wire: { status: action.wire.status, headers: publicHeaders(action.wire.headers), base64: action.wire.base64, partial: action.wire.partial } } : {}),
      ...(action.cancellation ? { cancellation: { stage: action.cancellation.stage, triggered: action.cancellation.triggered } } : {}),
    })),
  })),
});

function checkBytes(value) {
  if (!value.exists) return;
  const bytes = Buffer.from(value.base64, 'base64');
  assert.equal(bytes.length, value.bytes, value.filename); assert.equal(hash(bytes), value.sha256, value.filename);
}

async function verifyOriginals(native, input, build, capture) {
  assert.equal(native.actualExecution, true); assert.equal(native.startupAccepted, true);
  assert.equal(native.errorEnvironment, 'Production'); assert.deepEqual(native.failures, []);
  assert.deepEqual(native.emergencyCleanup, [], 'Emergency fixture cleanup cannot hide a media-process survivor.');
  for (const name of ['sourceHostClosed', 'publicHostClosed', 'inputClientsClosed', 'subtitleEncoderDisposed', 'protocolManagerDisposed', 'mediaEncoderDisposed'])
    assert.equal(native[name], true, name);
  for (const assembly of native.assemblies) assert.equal((await describeFile(path.join(build.runtime, assembly.name + '.dll'))).sha256, assembly.sha256, assembly.name);
  for (const assembly of native.frameworkAssemblies) assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256, assembly.name);
  assert.deepEqual(native.profiles.map(row => row.name), input.profiles.map(row => row.name), 'Every declared real StreamBuilder profile invocation completed.');
  assert.deepEqual(native.cases.map(row => row.name), input.cases.map(row => row.name));
  const cancelledTraces = new Set(native.cases.flatMap(sample => sample.actions.filter(action => action.cancellation?.stage === 'ffmpeg').flatMap(action => action.traceFiles)));
  for (const trace of native.traces) {
    assert.equal(trace.value.harnessError, undefined);
    for (const value of [trace.stdout, trace.stderr]) checkBytes(value);
    if (trace.value.forwarded && !cancelledTraces.has(trace.filename)) {
      assert.equal(Number.isInteger(trace.value.exitCode), true, 'The actual forwarded tool reached its observed close.');
      assert.equal(typeof trace.value.closedUtc, 'string'); assert.equal(trace.stdout.exists, true); assert.equal(trace.stderr.exists, true);
    }
    if (trace.value.pipeErrors) assert.deepEqual(trace.value.pipeErrors, []);
  }
  for (const definition of input.cases) {
    const sample = native.cases.find(value => value.name === definition.name);
    assert.equal(sample.subtitlePath, 'http://127.0.0.1:5244' + definition.sourceTarget, 'The original stored HTTP URL is retained.');
    assert.equal(sample.subtitleProtocol, 'Http'); assert.equal(sample.mediaProtocol, definition.mediaProtocol);
    const source = input.sources.find(value => value.name === definition.source);
    assert.equal(sample.actions[0].before.source.sha256, hash(Buffer.from(source.base64, 'base64')));
    assert.deepEqual(sample.actions.map(row => ({ name: row.name, op: row.op })), definition.actions.map(row => ({ name: row.name, op: row.op })));
    for (const action of sample.actions) {
      const declared = definition.actions.find(value => value.name === action.name);
      assert.equal(action.harnessError, undefined);
      for (const state of [action.before, action.after]) for (const value of [state.source, state.cache, state.meta]) checkBytes(value);
      if (action.wire) {
        assert.equal(action.wire.base64, action.wire.bodyBase64); const bytes = Buffer.from(action.wire.base64, 'base64');
        assert.equal(bytes.length, action.wire.bytes); assert.equal(hash(bytes), action.wire.sha256);
        if (action.op === 'raw') {
          if (declared.method === 'HEAD') {
            assert.equal(action.actualMethodRouting, true); assert.equal(action.actualRawController, false);
            assert.equal(action.actualResultExecutor, false);
          } else { assert.equal(action.actualRawController, true); assert.equal(action.actualResultExecutor, true); }
        }
        if (action.streamAcquired) assert.equal(action.streamDisposed, true);
      }
      if (action.op === 'format' && !declared.cancelAt) assert.equal(action.actualFormatController, true);
      if (declared.clientDisconnectAfterRead) {
        assert.equal(action.cancellation?.stage, 'controller-disconnect'); assert.equal(action.cancellation.serverRequestAborted, true);
        assert.equal(action.wire, undefined, 'No response is fabricated after the actual controller client disconnect.');
      }
      if (action.after.cache.exists) assert.equal(action.cacheReopenedExclusively, true);
      for (const process of action.processesAfter) assert.equal(process.Alive, false);
      for (const request of action.sourceRequests) {
        assert.equal(request.finished, true, 'Every actual owned upstream request drained or aborted.'); checkBytes(request.source);
        if (request.responseBody) { assert.equal(Buffer.from(request.responseBody.base64, 'base64').length, request.responseBody.bytes);
          assert.equal(hash(Buffer.from(request.responseBody.base64, 'base64')), request.responseBody.sha256); }
        if (request.heldAt) assert.equal(action.cancellation?.triggered, true, 'Held actual reads were followed by the declared cancellation.');
      }
    }
  }
  for (const sample of native.filesAfterClose) for (const value of [sample.snapshot.source, sample.snapshot.cache, sample.snapshot.meta]) {
    checkBytes(value); if (value.exists) assert.equal((await describeFile(value.filename)).sha256, value.sha256, 'Original source/cache/meta bytes after actual close.');
  }
  const pids = [...new Set([native.pid, ...native.processesAfter.map(row => row.Pid)])];
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline && pids.some(alive)) await delay(20);
  capture.processesAfter = pids.map(pid => ({ pid, alive: alive(pid) }));
  assert.ok(capture.processesAfter.every(row => !row.alive), 'The consumer, apphosts and actual media tools exited.');
  for (const process of native.processesAfter) assert.equal(process.Alive, false);
}

/** Caller holds native-media-5244 across both recordings and its Node consumers. */
export async function captureCurrentHttpSubtitles({ output, inputFile, signal }) {
  assertIsolatedOutput(output); await fs.mkdir(output, { recursive: true });
  const report = { schemaVersion: 1, scope: 'True HTTP subtitle identities: actual controller/helper/executor for raw and normal format, actual MVC method routing for HEAD, separate ISubtitleEncoder caller-token components and real default HTTP client behavior. No full MVC binding, authentication, PlaybackInfo or full-instance claim.',
    inputs: [], sourceBindings: [], captures: [], actualNativeExecuted: false, componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false };
  let failed = false, primary;
  try {
    signal?.throwIfAborted();
    for (const name of ['Program.cs', 'Oracle.csproj', 'input.js', 'capture.js', '.gitattributes', 'README.md'])
      report.inputs.push({ role: 'current-http-recorder-source', actual: await describeFile(fileURLToPath(new URL(name, import.meta.url))) });
    for (const name of ['../subtitle-text-current/input.js', '../subtitle-ass-reference.json', '../subtitle-sami-fallback-current/input.js', '../subtitle-sami-boundaries-current/input.js'])
      report.inputs.push({ role: 'declared-input-byte-provenance', actual: await describeFile(fileURLToPath(new URL(name, import.meta.url))) });
    if (!inputFile) { inputFile = path.join(output, 'input.json'); await fs.writeFile(inputFile, json(subtitleHttpInput()), { flag: 'wx' }); }
    const bytes = await fs.readFile(inputFile), input = JSON.parse(bytes); report.input = await describeFile(inputFile);
    const build = await verifyNativeBuild(); report.nativeBuild = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256 };
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
      signal?.throwIfAborted(); const directory = path.join(output, label), capture = { label }; report.captures.push(capture);
      capture.record = await recordOracle({ project: fileURLToPath(new URL('Oracle.csproj', import.meta.url)), output: directory,
        args: [inputFile, '{output}/native.json', tools.ffmpeg, tools.ffprobe] });
      const filename = path.join(directory, 'native.json'), native = JSON.parse(await fs.readFile(filename)); capture.observation = await describeFile(filename);
      assert.equal(native.inputSha256, hash(bytes));
      for (const name of ['ffmpeg', 'ffprobe']) assert.equal(native.tools[name].sha256, report.tools[name].sha256);
      await verifyOriginals(native, input, build, capture); captures.push(native);
    }
    assert.deepEqual(functionalHttpSubtitles(captures[0]), functionalHttpSubtitles(captures[1]), 'Independent Native public results, durable bytes, source identity and lifecycle outcomes.');
    assert.equal(hash(await fs.readFile(inputFile)), hash(bytes)); report.actualNativeExecuted = true;
    return { output, input, native: captures[0], repeat: captures[1], report };
  } catch (error) { failed = true; primary = error; report.failure = errorValue(error); throw error; }
  finally {
    try { await fs.writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
    catch (error) { if (failed) throw new AggregateError([primary, error], 'HTTP subtitle capture and original-report persistence failed.', { cause: primary }); throw error; }
  }
}
