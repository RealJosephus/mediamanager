import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, link, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { ProbeReadBridge } from '../../src/storage/probe-bridge.js';
import { probeRaw } from '../../src/storage/ffprobe.js';
import { normalizeProbe } from '../../src/storage/probe-normalizer.js';
import { readBlurayDiscInfo, verifyBlurayDiscInfo } from '../../src/storage/bluray-disc-info.js';
import { blurayMediaStreams, mergeBlurayProbe } from '../../src/storage/bluray-probe-info.js';
import { dateTicks } from '../../src/library/records.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { blurayReferenceInputs } from '../../tools/validation/bluray-reference-inputs.js';
import { compileOracle } from '../../tools/validation/oracle.js';
import { describeFile, sha256 } from '../../tools/validation/inventory.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { declareFileTestResource } from '../helpers/file-test-resource.js';
import { functionalJson, probeValues } from './fixtures/real-dvd-current/scenario.js';
import { errorObservation } from '../helpers/error-observation.js';

export const requiredValidationServices = ['blurayReference', 'dotnet', 'jellyfinDll'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_BLURAY_REFERENCE && process.env.MEDIAMANAGER_JELLYFIN_DLL);
const mediaLease = declareFileTestResource('native-media-5244', { enabled });
const streamFields = { Video: ['Type', 'Codec', 'Index', 'Width', 'Height', 'IsInterlaced', 'IsHearingImpaired', 'AverageFrameRate', 'RealFrameRate', 'BitRate'],
  Audio: ['Type', 'Codec', 'Index', 'Language', 'SampleRate', 'Channels', 'ChannelLayout', 'BitRate', 'IsInterlaced', 'IsHearingImpaired'],
  Subtitle: ['Type', 'Codec', 'Index', 'Language', 'IsInterlaced', 'IsHearingImpaired'] };
const streams = values => values.map(value => Object.fromEntries(streamFields[value.Type].map(key => [key,
  value[key] == null ? null : key.endsWith('FrameRate') ? Math.fround(value[key]) : value[key]])));

test('complete original Sintel BDMV matches the actual Native BDInfo/MediaEncoder through an independent read-only Node VFS', {
  skip: !enabled, timeout: 900000,
}, async t => mediaLease.run(async () => {
  const destination = path.join(validationOutputRoot(), 'real-bluray-components-' + randomUUID());
  const output = await createPrivateFilterOutput(destination); await mkdir(output.root);
  const root = await realpath(output.root), report = { scope: 'complete-original-sintel-components',
    actualScan: false, databaseExchange: false, completeLibraryVerified: false, fullInstanceVerified: false,
    productionScaleVerified: false, phaseAcceptance: false, releaseAcceptance: false, components: [], nodeProbes: [], cleanup: {} };
  let registry, bridge, failed = false, failure;
  try {
    const supply = await blurayReferenceInputs(); report.original = { receipt: supply.receipt, manifest: supply.manifest };
    const refusal = path.join(root, 'receipt-only'), falseRoot = path.join(refusal, 'mediamanager-bluray-reference');
    await mkdir(falseRoot, { recursive: true }); await cp(supply.evidence, path.join(falseRoot, 'evidence'), { recursive: true });
    await mkdir(path.join(falseRoot, 'media')); await mkdir(path.join(falseRoot, 'work'));
    const falseReceipt = { ...supply.receipt, mediaRoot: path.join(falseRoot, 'media'), discRoot: path.join(falseRoot, 'media'),
      bdmvRoot: path.join(falseRoot, 'media', 'BDMV'), originalIso: path.join(falseRoot, 'work', path.basename(supply.receipt.originalIso)) };
    await link(supply.receipt.originalIso, falseReceipt.originalIso);
    await writeFile(path.join(falseRoot, 'evidence/receipt.json'), JSON.stringify(falseReceipt) + '\n');
    await assert.rejects(blurayReferenceInputs({ ...process.env, RUNNER_TEMP: refusal,
      MEDIAMANAGER_TEST_BLURAY_REFERENCE: path.join(falseRoot, 'evidence/receipt.json') }),
    error => Array.isArray(error.actual) && error.actual.length === 0 && error.expected.length === supply.manifest.length);
    report.receiptWithoutOriginalPayloadRejected = true;
    const input = { files: supply.manifest.filter(member => member.kind === 'file').map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
      originalIsoSha256: supply.receipt.download.sha256, ffprobe: validationExecutable('ffprobe') };
    const bytes = Buffer.from(JSON.stringify(input, null, 2) + '\n'), filename = path.join(root, 'input.json');
    await writeFile(filename, bytes, { flag: 'wx' });
    report.componentInput = { bytes: bytes.length, sha256: sha256(bytes), base64: bytes.toString('base64') };
    const oracle = await compileOracle({ project: 'tests/library/fixtures/real-bluray-current/Oracle.csproj', output: path.join(root, 'build') });
    for (const label of ['native', 'native-repeat']) {
      const nativeRoot = path.join(root, label);
      const receipt = await oracle.record({ output: nativeRoot,
        args: [filename, supply.discRoot, validationExecutable('ffmpeg'), '{output}'] });
      const raw = await readFile(path.join(nativeRoot, 'native.json'));
      const observation = { label, receipt, raw: { bytes: raw.length, sha256: sha256(raw), base64: raw.toString('base64') } };
      report.components.push(observation);
      const capture = parseLosslessJson(raw.toString('utf8')); observation.capture = capture;
      assert.equal(receipt.passed, true); assert.equal(capture.inputSha256, sha256(bytes));
      assert.equal(receipt.outputs.find(file => path.basename(file.filename) === 'native.json').sha256, sha256(raw));
      for (const key of ['actualManagedFileSystem', 'actualMediaEncoder', 'actualFfprobe', 'actualNativeBdInfo']) assert.equal(capture[key], true);
      assert.equal(capture.proxy.closed, true);
      assert.deepEqual(functionalJson(capture.sourceFiles), input.files);
      for (const assembly of capture.assemblies) assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256);
      for (const probe of capture.probes) assert.ok(capture.proxy.requests.some(request => request.Method === 'GET' && request.file === probe.file));
    }
    const native = report.components[0].capture;
    assert.deepEqual(functionalJson(report.components[1].capture.plan), functionalJson(native.plan));
    assert.deepEqual(streams(report.components[1].capture.actualDiscInfo.MediaStreams), streams(native.actualDiscInfo.MediaStreams));
    registry = new StorageRegistry(); registry.registerType('original-bluray', configuration => LocalAdapter.open(configuration));
    await registry.createInstance('sintel', 'original-bluray', { root: supply.discRoot, writable: false });
    const vfs = new VirtualFileSystem(registry); vfs.mount({ path: '/sintel', instanceId: 'sintel', capabilities: {} });
    assert.equal(vfs.capabilities('/sintel').create, false);
    bridge = new ProbeReadBridge(vfs);
    const plan = await readBlurayDiscInfo(vfs, '/sintel', { signal: t.signal });
    report.nodePlan = plan;
    const relative = value => value.slice('/sintel/'.length);
    const projected = { playlistName: plan.playlistName, runTimeTicks: plan.runTimeTicks, chapters: plan.chapters,
      files: plan.files.map(file => ({ virtualPath: relative(file.virtualPath), timeIn: file.timeIn,
        timeOut: file.timeOut, relativeTimeIn: file.relativeTimeIn })) };
    assert.deepEqual(functionalJson(projected), functionalJson(native.plan));
    assert.deepEqual(plan.files.map(file => relative(file.virtualPath)), native.selections[0].files);
    for (const selected of plan.files) {
      const result = await probeRaw(bridge, selected.virtualPath, { executable: validationExecutable('ffprobe'), extractChapters: true, signal: t.signal });
      const original = native.probes.find(probe => probe.file === relative(selected.virtualPath)); assert.ok(original);
      assert.deepEqual(probeValues(normalizeProbe(result.raw, { path: path.join(supply.discRoot, ...original.file.split('/')), isAudio: false })), probeValues(original.information));
      report.nodeProbes.push({ file: original.file, result });
    }
    const reference = await probeRaw(bridge, plan.referenceFile.virtualPath, { executable: validationExecutable('ffprobe'), signal: t.signal });
    const completed = blurayMediaStreams(plan, reference.raw); report.nodeCompletedStreams = completed; report.referenceProbe = reference;
    assert.deepEqual(streams(completed), streams(native.actualDiscInfo.MediaStreams));
    const firstProbe = report.nodeProbes.find(probe => probe.file === relative(plan.files[0].virtualPath)); assert.ok(firstProbe);
    const merged = mergeBlurayProbe(plan, normalizeProbe(firstProbe.result.raw, {
      path: path.join(supply.discRoot, ...firstProbe.file.split('/')), isAudio: false }), reference.raw);
    report.nodeMergedChapters = merged.Chapters;
    const chapters = values => values.map(chapter => ({ StartPositionTicks: String(chapter.StartPositionTicks),
      ImageDateModifiedTicks: dateTicks(chapter.ImageDateModified).toString(),
      ImagePath: chapter.ImagePath ?? null, Name: chapter.Name ?? null }));
    assert.deepEqual(chapters(merged.Chapters), chapters(native.chapterDefaults));
    await verifyBlurayDiscInfo(vfs, plan, { signal: t.signal });
    assert.deepEqual((await blurayReferenceInputs()).inputs, supply.inputs);
    report.originalInputsUnchanged = true;
    t.signal.throwIfAborted();
  } catch (error) { failed = true; failure = error; report.error = errorObservation(error); }
  finally {
    const failures = [];
    try { await bridge?.close(); report.cleanup.bridgeClosed = true; } catch (error) { failures.push(error); }
    try { await registry?.close(); report.cleanup.storageOwnerClosed = true; } catch (error) { failures.push(error); }
    if (t.signal.aborted && !failed) {
      failed = true; failure = t.signal.reason; report.error = errorObservation(failure);
    }
    report.cleanup.errors = failures.map(error => errorObservation(error));
    if (failures.length) {
      const reasons = failed ? [failure, ...failures] : failures;
      failure = reasons.length === 1 ? reasons[0] : new AggregateError(reasons,
        'Original Blu-ray component validation and cleanup failed', { cause: reasons[0] });
      failed = true;
    }
    report.passed = !failed;
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report));
    if (report.cleanup.bridgeClosed && report.cleanup.storageOwnerClosed) await output.publishAndClose();
    else {
      await mkdir(destination);
      await writeFile(path.join(destination, 'report.json'), filterEvidenceJson({ ...report, privateRootRetained: true }));
    }
  }
  if (failed) {
    if (failure === null || !['object', 'function'].includes(typeof failure)) throw failure;
    throw output.publicError(failure);
  }
}, { signal: t.signal }));
