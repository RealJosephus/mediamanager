import test from 'node:test';
import { createTestMediaEncoder } from '../helpers/media-encoder.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { NamedConfigurationStore } from '../../src/core/named-configuration-store.js';
import { createTestApplication } from '../helpers/application.js';
import { PlaybackService } from '../../src/playback/service.js';
import { ExtractionService } from '../../src/playback/extraction.js';
import { subtitleProfile } from '../../src/playback/profile.js';
import { ProbeReadBridge } from '../../src/storage/probe-bridge.js';
import { extractionFixture } from './extraction-fixture.js';
import { currentSubtitleConfiguration, subtitleInput, subtitleFailure, subtitleFailurePayload, subtitleJson } from './encoding-subtitle-current.js';
import { validationExecutable } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const enabled = Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const profileValue = value => value === null ? null : ({ Method: value.Method, Format: value.Format });
const wireValue = value => ({ status: value.status, contentType: value.contentType?.split(';')[0].toLowerCase() ?? null, bytes: value.bytes });

test('current named EnableSubtitleExtraction affects only the native subtitle negotiation branch', { skip: !enabled, timeout: 300000 }, async () => {
  const captured = await currentSubtitleConfiguration();
  const report = { scope: 'Actual MediaEncoder capability plus StreamBuilder subtitle profile; Node current named values.',
    comparisons: [], phaseAcceptance: false, releaseAcceptance: false, componentAcceptance: false };
  const directory = path.join(captured.output, 'node-profile-config'); await mkdir(directory);
  const store = new NamedConfigurationStore({ configurationDirectoryPath: directory }); let failure;
  try {
    for (const [index, sample] of subtitleInput.profiles.entries()) {
      await store.saveConfiguration('encoding', { ...defaultConfiguration('encoding'), EnableSubtitleExtraction: sample.enabled });
      const expected = captured.native.profiles[index], repeated = captured.repeat.profiles[index];
      const result = subtitleProfile(sample.source, sample.stream, { SubtitleProfiles: sample.profiles }, sample.container,
        { PlayMethod: sample.playMethod, EnableSubtitleExtraction: store.getCurrentConfiguration('encoding').EnableSubtitleExtraction, CanExtractSubtitle: () => true });
      report.comparisons.push({ sample, actual: result, expected, repeated });
      assert.deepEqual(profileValue(repeated.result), profileValue(expected.result), sample.name + ': independent Native value');
      assert.deepEqual(profileValue(result), profileValue(expected.result), sample.name + ': complete selected method and format');
    }
    report.componentAcceptance = true;
  } catch (error) { failure = error; report.failure = subtitleFailure(error); }
  finally { await store.close(); await writeFile(path.join(captured.output, 'profile-comparison.json'), subtitleJson(report), { flag: 'wx' }); }
  if (failure) throw failure;
});

async function nodeCase(sample, root, t) {
  await mkdir(root); const directory = path.join(root, 'config'); await mkdir(directory);
  const original = Buffer.from(subtitleInput.source.media, 'base64'), source = structuredClone(subtitleInput.source.source);
  source.Id = 'f83a0000-0000-0000-0000-000000000001'.replaceAll('-', '');
  const stream = source.MediaStreams.find(stream => stream.Type === 'Subtitle');
  const store = new NamedConfigurationStore({ configurationDirectoryPath: directory });
  await store.saveConfiguration('encoding', { ...defaultConfiguration('encoding'), EnableSubtitleExtraction: sample.enabled ?? true,
    SubtitleExtractionTimeoutMinutes: sample.minutes });
  const fixture = await extractionFixture({ '/media.mkv': original }, { delayMs: sample.holdBody ? 2000 : 0 });
  const bridge = new ProbeReadBridge(fixture.vfs), urls = [], pids = [], diagnostics = [], unowned = [];
  const lease = bridge.lease.bind(bridge); bridge.lease = async (...arguments_) => { const value = await lease(...arguments_); urls.push(value.url); return value; };
  const getEncodingOptions = () => store.getCurrentConfiguration('encoding');
  const executable = validationExecutable('ffmpeg'), linkedBin = path.join(root, 'encoder-bin');
  if (sample.executableMissing) await symlink(path.dirname(executable), linkedBin, process.platform === 'win32' ? 'junction' : 'dir');
  const mediaEncoder = await createTestMediaEncoder(t, { startupFFmpegPath: sample.executableMissing ? path.join(linkedBin, path.basename(executable)) : executable });
  const service = new ExtractionService({ vfs: fixture.vfs, bridge, mediaEncoder, getEncodingOptions,
    onProcess: process => pids.push(structuredClone(process)) });
  const actualFailures = [], subtitleOperation = service.subtitle.bind(service);
  service.subtitle = async (...arguments_) => {
    try { return await subtitleOperation(...arguments_); }
    catch (error) {
      actualFailures.push({ phase: 'actual-subtitle-operation', sourceId: arguments_[0].Id, index: arguments_[1].Index,
        accessPath: arguments_[2], beforeHttpClassification: subtitleFailure(error), error });
      throw error;
    }
  };
  let application, request, response, primary, normalClose = false, active = true;
  const inputEntered = Promise.withResolvers(), inputReleased = Promise.withResolvers(), readEntered = Promise.withResolvers();
  let hold = Object.hasOwn(sample, 'nextMinutes');
  const originalStat = fixture.adapter.stat.bind(fixture.adapter), originalRead = fixture.adapter.openRead.bind(fixture.adapter);
  fixture.adapter.stat = async (...arguments_) => {
    const value = await originalStat(...arguments_);
    if (hold) { hold = false; inputEntered.resolve(); await inputReleased.promise; } return value;
  };
  fixture.adapter.openRead = async (...arguments_) => { readEntered.resolve(); return originalRead(...arguments_); };
  const releaseOnAbort = () => inputReleased.resolve(); t.signal.addEventListener('abort', releaseOnAbort);
  try {
    if (sample.executableMissing) await rename(linkedBin, linkedBin + '-removed');
    const playback = new PlaybackService({ library: { async getItemRecord() { return { Id: source.Id, Path: source.Path, MediaType: 'Video' }; },
      async getMediaSources() { return [source]; } }, vfs: fixture.vfs, identityMap: fixture.identityMap, extraction: service, getEncodingOptions });
    application = await createTestApplication({ configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true }, playback,
      authentication: { async authenticate() { return { IsAuthenticated: true, IsApiKey: true, IsAdministrator: true }; }, authorize() {} },
      onError: error => (active ? diagnostics : unowned).push({ phase: active ? 'response' : 'background-or-close', failure: subtitleFailure(error) }) });
    await new Promise((resolve, reject) => { application.server.once('error', reject); application.server.listen(0, '127.0.0.1', () => {
      application.server.off('error', reject); resolve();
    }); });
    request = (async () => {
      const result = await fetch('http://127.0.0.1:' + application.server.address().port
        + `/Videos/${source.Id}/${source.Id}/Subtitles/${stream.Index}/Stream.srt`, { signal: t.signal });
      const bytes = Buffer.from(await result.arrayBuffer());
      response = { status: result.status, contentType: result.headers.get('content-type'), headers: Object.fromEntries(result.headers),
        bytes: bytes.toString('base64'), text: bytes.toString() }; return response;
    })(); void request.catch(() => {});
    if (Object.hasOwn(sample, 'nextMinutes')) {
      await Promise.race([inputEntered.promise, request.then(() => { throw new Error('Actual admitted input lookup did not wait for replacement.'); })]);
      await store.saveConfiguration('encoding', { ...defaultConfiguration('encoding'), SubtitleExtractionTimeoutMinutes: sample.nextMinutes }); inputReleased.resolve();
    }
    if (sample.cancelAfterRead) {
      await Promise.race([readEntered.promise, request.then(() => { throw new Error('A valid long timeout ended before the real input read.'); })]);
      const actual = pids.find(process => !process.args.includes('-version')); assert.ok(actual && alive(actual.pid), 'The actual copy process remains active under the long valid configuration.');
      await service.close(); normalClose = true;
    }
    await request; active = false;
    for (const diagnostic of diagnostics) {
      assert.ok(response.status >= 400, 'A successful request cannot classify a process failure.');
      const bound = actualFailures.some(original => {
        if (original.sourceId !== source.Id || original.index !== stream.Index || original.accessPath !== '/media.mkv') return false;
        try { assert.deepEqual(subtitleFailurePayload(diagnostic.failure), subtitleFailurePayload(original.error)); return true; } catch { return false; }
      });
      assert.ok(bound, 'Every optional HTTP diagnostic must retain this actual subtitle operation failure payload.');
    }
    await service.close(); normalClose = true;
    for (const process of pids) assert.equal(alive(process.pid), false, 'The actual executor PID must have exited.');
    for (const url of urls) assert.equal((await fetch(url)).status, 404, 'The actual operation lease must be revoked.');
    fixture.setDelay(0); const retained = await fixture.vfs.openRead('/media.mkv'); const chunks = [];
    try { for await (const chunk of retained.stream) chunks.push(chunk); } finally { await retained.close(); }
    assert.deepEqual(Buffer.concat(chunks), original);
    return { name: sample.name, response, current: structuredClone(getEncodingOptions()), diagnostics,
      actualFailures: actualFailures.map(({ error, ...observation }) => ({ ...observation, afterHttpClassification: subtitleFailure(error) })), pids, urls,
      sourceBefore: original.toString('base64'), sourceAfter: Buffer.concat(chunks).toString('base64'), normalClose };
  } catch (error) { primary = error; throw error; }
  finally {
    active = false; inputReleased.resolve(); t.signal.removeEventListener('abort', releaseOnAbort);
    const errors = [];
    try { await service.close(); } catch (error) { errors.push(error); }
    await Promise.allSettled([request]);
    try { application?.beginClose(); await application?.drainRequests(); if (application?.server.listening) await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve())); } catch (error) { errors.push(error); }
    try { await bridge.close(); } catch (error) { errors.push(error); }
    try { await fixture.close(); } catch (error) { errors.push(error); }
    try { await store.close(); } catch (error) { errors.push(error); }
    try { assert.deepEqual(unowned, []); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(primary ? [primary, ...errors] : errors, primary?.message ?? 'Subtitle component cleanup failed.', { cause: primary ?? errors[0] });
  }
}

test('current subtitle timeout and public stream failures match actual Native helper and public boundaries', { skip: !enabled, timeout: 300000 }, async t => {
  const captured = await currentSubtitleConfiguration(), report = { scope: 'Actual original-container subtitle copy, separate native helper/public stream middleware and Node route.',
    excluded: ['full native controller authorization', 'long wall-clock waits'], comparisons: [], differences: [], componentAcceptance: false,
    phaseAcceptance: false, releaseAcceptance: false };
  let failure;
  try {
    for (const [index, sample] of subtitleInput.timeout.entries()) {
      const expected = captured.native.extractions.find(row => row.name === sample.name && row.boundary === 'public');
      const repeated = captured.repeat.extractions.find(row => row.name === sample.name && row.boundary === 'public');
      const actual = await nodeCase(sample, path.join(captured.output, 'node-' + index), t);
      report.comparisons.push({ sample, actual, expected });
      for (const row of [expected, repeated]) {
        assert.equal(row.sourceBefore, row.sourceAfter);
        for (const process of row.processes) assert.equal(process.activeAfterFixtureCleanup, false);
      }
      for (const [label, value] of [['Native repeat', repeated.wire], ['Node public route', actual.response]]) {
        try { assert.deepEqual(wireValue(value), wireValue(expected.wire), sample.name + ': ' + label); }
        catch (error) { report.differences.push({ name: sample.name, label, actual: value, expected: expected.wire, error: subtitleFailure(error) }); }
      }
    }
    assert.deepEqual(report.differences, [], subtitleJson(report.differences.slice(0, 5))); report.componentAcceptance = true;
  } catch (error) { failure = error; report.failure = subtitleFailure(error); }
  finally { await writeFile(path.join(captured.output, 'stream-comparison.json'), subtitleJson(report), { flag: 'wx' }); }
  if (failure) throw failure;
});

test('actual extraction preserves ordered operation/release failures and cancellation reasons while revoking resources', { skip: !enabled, timeout: 300000 }, async t => {
  const captured = await currentSubtitleConfiguration(), root = path.join(captured.output, 'node-release-errors'); await mkdir(root);
  const original = Buffer.from(subtitleInput.source.media, 'base64'), source = structuredClone(subtitleInput.source.source);
  const stream = source.MediaStreams.find(stream => stream.Type === 'Subtitle');
  const primary = Object.assign(new Error('Controlled current encoding read failed.', { cause: new Error('Original configuration source failure.') }), {
    code: 'EIO', status: 503, errors: [new Error('First original input failure.'), new Error('Second original input failure.')],
  });
  const release = Object.assign(new Error('Controlled release failed after actual revocation.', { cause: new Error('Original release failure.') }), {
    code: 'EIO', status: 507, errors: [new Error('First original release failure.'), new Error('Second original release failure.')],
  });
  const report = { scope: 'Actual spawned subtitle process, real lease revocation, original source and ordered complete Node failures.',
    primary: subtitleFailure(primary), release: subtitleFailure(release), operations: [], componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false };
  const fixture = await extractionFixture({ '/media.mkv': original }, { delayMs: 2000 });
  const bridge = new ProbeReadBridge(fixture.vfs), urls = [], pids = []; const lease = bridge.lease.bind(bridge);
  bridge.lease = async (...arguments_) => {
    const value = await lease(...arguments_); urls.push(value.url); const actualRelease = value.release;
    return { ...value, async release() {
      await actualRelease(); const response = await fetch(value.url); report.operations.push({ phase: 'actual-release', status: response.status });
      assert.equal(response.status, 404); throw release;
    } };
  };
  const service = new ExtractionService({ vfs: fixture.vfs, bridge, mediaEncoder: await createTestMediaEncoder(t), getEncodingOptions() { throw primary; }, onProcess: process => pids.push(process) });
  let failure;
  try {
    let actual;
    await assert.rejects(service.subtitle(source, stream, '/media.mkv'), error => {
      actual = error; assert.deepEqual(subtitleFailurePayload(error.cause), subtitleFailurePayload(primary));
      assert.deepEqual(error.errors.map(subtitleFailurePayload), [primary, release].map(subtitleFailurePayload));
      assert.equal(error.code, 'EIO'); assert.equal(error.status, 503); return true;
    });
    report.rejected = subtitleFailure(actual); await service.close();
    for (const process of pids) assert.equal(alive(process.pid), false);
    for (const url of urls) assert.equal((await fetch(url)).status, 404);
    fixture.setDelay(0); const handle = await fixture.vfs.openRead('/media.mkv'); const chunks = [];
    try { for await (const chunk of handle.stream) chunks.push(chunk); } finally { await handle.close(); }
    assert.deepEqual(Buffer.concat(chunks), original); report.originalAfter = Buffer.concat(chunks).toString('base64');
    report.pids = pids; report.componentAcceptance = true;
  } catch (error) { failure = error; report.failure = subtitleFailure(error); }
  finally {
    const errors = [];
    try { await service.close(); } catch (error) { errors.push(error); }
    try { await bridge.close(); } catch (error) { errors.push(error); }
    try { await fixture.close(); } catch (error) { errors.push(error); }
    report.cleanup = errors.map(subtitleFailure); await writeFile(path.join(root, 'comparison.json'), subtitleJson(report), { flag: 'wx' });
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, failure?.message ?? 'Controlled extraction cleanup failed.', { cause: failure ?? errors[0] });
  }
  if (failure) throw failure;
});

test('explicit attachments ignore subtitle-only settings and actual cancellation retains the reader reason', { skip: !enabled, timeout: 300000 }, async t => {
  const captured = await currentSubtitleConfiguration(), root = path.join(captured.output, 'node-explicit-and-cancel'); await mkdir(root);
  const original = Buffer.from(subtitleInput.source.media, 'base64'), source = structuredClone(subtitleInput.source.source);
  const fixture = await extractionFixture({ '/media.mkv': original });
  let encoding = { ...defaultConfiguration('encoding'), EnableSubtitleExtraction: false, SubtitleExtractionTimeoutMinutes: 0 };
  const pids = [], getEncodingOptions = () => encoding;
  const service = new ExtractionService({ vfs: fixture.vfs, mediaEncoder: await createTestMediaEncoder(t), getEncodingOptions, onProcess: process => pids.push(process) });
  const reason = Object.assign(new Error('The real subtitle reader stopped.'), { code: 'reader-stopped', cause: new Error('Original caller cancellation.') });
  const report = { scope: 'Actual attachment bytes and cancellation through a long valid current subtitle timeout.',
    reason: subtitleFailure(reason), componentAcceptance: false, phaseAcceptance: false, releaseAcceptance: false };
  let failure;
  try {
    const attachment = await service.attachment(source, source.MediaAttachments[0], '/media.mkv');
    assert.equal(attachment.bytes.toString('base64'), subtitleInput.attachmentBase64); report.attachment = attachment.bytes.toString('base64');
    encoding = { ...encoding, SubtitleExtractionTimeoutMinutes: 71582 };
    fixture.replace('/media.mkv', original); fixture.setDelay(2000);
    const entered = Promise.withResolvers(), open = fixture.adapter.openRead.bind(fixture.adapter);
    fixture.adapter.openRead = (...arguments_) => { entered.resolve(); return open(...arguments_); };
    const controller = new AbortController(), work = service.subtitle(source, source.MediaStreams.find(stream => stream.Type === 'Subtitle'), '/media.mkv', { signal: controller.signal });
    void work.catch(() => {});
    const abort = () => controller.abort(t.signal.reason); t.signal.addEventListener('abort', abort);
    try {
      await Promise.race([entered.promise, work.then(() => { throw new Error('The real source read did not remain active.'); })]);
      controller.abort(reason);
      await assert.rejects(work, error => { report.cancelled = subtitleFailure(error); assert.equal(error.code, 'cancelled');
        assert.deepEqual(subtitleFailurePayload(error.cause), subtitleFailurePayload(reason)); return true; });
      await service.close();
    } finally { controller.abort(reason); t.signal.removeEventListener('abort', abort); await Promise.allSettled([work]); }
    const bridge = new ProbeReadBridge(fixture.vfs), stopped = new AbortController(); stopped.abort(reason);
    try { await assert.rejects(bridge.lease('/media.mkv', { expiresInMs: null, signal: stopped.signal }), error => {
      report.alreadyAborted = subtitleFailure(error); assert.deepEqual(subtitleFailurePayload(error.cause), subtitleFailurePayload(reason)); return true;
    }); } finally { await bridge.close(); }
    for (const process of pids) assert.equal(alive(process.pid), false); report.pids = pids; report.componentAcceptance = true;
  } catch (error) { failure = error; report.failure = subtitleFailure(error); }
  finally {
    const errors = [];
    try { await service.close(); } catch (error) { errors.push(error); }
    try { await fixture.close(); } catch (error) { errors.push(error); }
    report.cleanup = errors.map(subtitleFailure); await writeFile(path.join(root, 'comparison.json'), subtitleJson(report), { flag: 'wx' });
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, failure?.message ?? 'Explicit extraction cleanup failed.', { cause: failure ?? errors[0] });
  }
  if (failure) throw failure;
});
