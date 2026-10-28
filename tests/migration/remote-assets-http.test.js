import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { captureRemoteAssets, inspectRemoteAssets, restoreRemoteAssets } from '../../src/migration/remote-assets.js';
import { errorObservation } from '../helpers/error-observation.js';
import { ownedConditionalHttpFixture as fixture } from '../helpers/conditional-http-state.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inventory = ['first', 'second'].map(assetId => ({ assetId, virtualPath: '/remote/source/' + assetId + '.nfo',
  restorePath: assetId + '.nfo', kind: 'nfo' }));
const payloads = [Buffer.from('<movie><title>原始 NFO é e\u0301</title><unknown traceId="opaque">\u0000</unknown></movie>'),
  Buffer.from('{"unknown":9007199254740993,"Path":"literal","traceId":"retain bytes"}\n')];

function assertNaturalDrain(observation) {
  assert.ok(Number.isInteger(observation.pid) && observation.pid > 0);
  assert.equal(observation.closed.type, 'closed');
  assert.equal(observation.closed.activeRequests, 0); assert.equal(observation.closed.openDescriptors, 0);
  assert.deepEqual(observation.result, { code: 0, signal: null });
  assert.equal(observation.portRebound, true);
  assert.notEqual(observation.forcedCleanup, true); assert.notEqual(observation.normalShutdownFailed, true);
}

function controlledContext(t, controller) {
  return { signal: AbortSignal.any([t.signal, controller.signal]), after: callback => t.after(callback) };
}

test('remote assets retain bytes and conditional generations through a real HTTP backend restart and idempotent restore', { timeout: 60000 }, async t => {
  const f = await fixture(t), first = await f.openServer(), source = await f.openVfs(first);
  for (const [index, asset] of inventory.entries()) await f.put(first, '/source/' + asset.assetId + '.nfo', payloads[index]);
  const plan = await inspectRemoteAssets({ vfs: source.vfs, assets: inventory, signal: t.signal });
  for (const [headers, expected] of [[{}, 428], [{ 'If-Match': '"stale-generation"' }, 412]]) {
    const denied = await fetch(first.origin + '/source/first.nfo', { method: 'PUT', body: Buffer.from('Must not publish.'), headers, signal: t.signal });
    assert.equal(denied.status, expected); await denied.body?.cancel();
  }
  const directory = await f.packageDirectory();
  const files = await captureRemoteAssets({ plan, destination: directory, signal: t.signal });
  for (const [index, file] of files.entries()) {
    assert.equal(file.sha256, hash(payloads[index]));
    assert.deepEqual(await readFile(path.join(directory, 'files', file.path)), payloads[index]);
  }
  await source.registry.close(); await first.close();
  const restarted = await f.openServer(), target = await f.openVfs(restarted);
  assert.equal(restarted.observation.ready.revision, 2);
  for (const [index, asset] of inventory.entries()) {
    const metadata = await target.vfs.stat(asset.virtualPath);
    assert.equal(metadata.version, plan.assets[index].version);
  }
  const options = { directory, manifest: { generation: 'real-http-restart', remoteAssets: files }, vfs: target.vfs,
    targets: { first: '/remote/target/first.nfo', second: '/remote/target/second.nfo' }, signal: t.signal };
  const restored = await restoreRemoteAssets(options);
  assert.equal(restored.complete, true); assert.ok(restored.completed.every(value => value.reused === false));
  const repeated = await restoreRemoteAssets(options);
  assert.equal(repeated.complete, true); assert.ok(repeated.completed.every(value => value.reused === true));
  const receipt = await restarted.command({ type: 'snapshot' });
  assert.equal(receipt.revision, 4);
  assert.equal(receipt.requests.filter(request => request.method === 'PUT').length, 2);
  assert.ok(receipt.requests.filter(request => request.method === 'GET').every(request => request.ifMatch !== null));
  await target.registry.close(); await restarted.close();
  Object.assign(f.report.assertions, { capturedBytes: true, sourceVersionsSurviveProcessExit: true,
    writePreconditionsEnforcedByServer: true, newAtomicTargetsVerified: true,
    repeatedRestoreDoesNotWrite: true, normalShutdownBeforeFixtureCleanup: true });
});

test('real HTTP capture rejects changed generations and truncated streams without exposing partial assets, then recovers', { timeout: 60000 }, async t => {
  const f = await fixture(t), worker = await f.openServer(), source = await f.openVfs(worker);
  await f.put(worker, '/source/first.nfo', payloads[0]);
  const plan = await inspectRemoteAssets({ vfs: source.vfs, assets: inventory.slice(0, 1) });
  const changed = Buffer.from('External source edit with a new durable generation.');
  await f.put(worker, '/source/first.nfo', changed, plan.assets[0].version);
  const directory = await f.packageDirectory();
  await assert.rejects(captureRemoteAssets({ plan, destination: directory }), /changed during generation capture/u);
  assert.deepEqual(await readdir(path.join(directory, 'files', 'remote-assets')), []);
  const fresh = await inspectRemoteAssets({ vfs: source.vfs, assets: inventory.slice(0, 1) });
  await worker.command({ type: 'truncate', path: '/source/first.nfo' });
  await assert.rejects(captureRemoteAssets({ plan: fresh, destination: directory }), error => {
    f.report.truncatedFailure = errorObservation(error); return true;
  });
  assert.deepEqual(await readdir(path.join(directory, 'files', 'remote-assets')), []);
  const recovered = await captureRemoteAssets({ plan: fresh, destination: directory });
  assert.deepEqual(await readFile(path.join(directory, 'files', recovered[0].path)), changed);
  await source.registry.close();
  const receipt = await worker.close(); assert.ok(receipt.requests.some(request => request.status === 412));
  Object.assign(f.report.assertions, { staleReadRejectedByServer: true, truncatedReadRejected: true,
    privateTemporariesRemoved: true, nextCaptureRecoversOriginalCurrentBytes: true, normalShutdownBeforeFixtureCleanup: true });
});

test('real HTTP restore detects an external edit after an earlier verified write and preserves the committed prefix', { timeout: 60000 }, async t => {
  const f = await fixture(t), worker = await f.openServer(), storage = await f.openVfs(worker);
  for (const [index, asset] of inventory.entries()) await f.put(worker, '/source/' + asset.assetId + '.nfo', payloads[index]);
  const directory = await f.packageDirectory();
  const files = await captureRemoteAssets({ vfs: storage.vfs, assets: inventory, destination: directory });
  const changed = Buffer.from('External edit after the first target was verified.');
  const write = storage.adapter.write.bind(storage.adapter);
  const mutation = t.mock.method(storage.adapter, 'write', async (...args) => {
    const result = await write(...args);
    if (args[0] === '/target/second.nfo') {
      const current = await storage.adapter.stat('/target/first.nfo');
      await f.put(worker, '/target/first.nfo', changed, current.version);
    }
    return result;
  });
  const options = { directory, manifest: { generation: 'real-http-interleaved', remoteAssets: files }, vfs: storage.vfs,
    targets: { first: '/remote/target/first.nfo', second: '/remote/target/second.nfo' } };
  try {
    await assert.rejects(restoreRemoteAssets(options), error => {
      assert.match(error.message, /target changed before completion/u);
      assert.equal(error.remoteRestoreProgress.complete, false);
      assert.deepEqual(error.remoteRestoreProgress.completed.map(value => value.assetId), ['first', 'second']);
      f.report.partialProgress = error.remoteRestoreProgress; return true;
    });
  } finally { mutation.mock.restore(); }
  await assert.rejects(restoreRemoteAssets(options), /overwrite different target content/u);
  const first = await storage.adapter.stat('/target/first.nfo');
  const actual = await fetch(worker.origin + '/target/first.nfo', { signal: t.signal });
  assert.deepEqual(Buffer.from(await actual.arrayBuffer()), changed);
  await f.put(worker, '/target/first.nfo', payloads[0], first.version);
  const restored = await restoreRemoteAssets(options);
  assert.equal(restored.complete, true); assert.ok(restored.completed.every(value => value.reused));
  await storage.registry.close(); await worker.close();
  Object.assign(f.report.assertions, { externalEditDetectedAtCompletion: true, externalBytesRetained: true,
    committedSecondTargetRetained: true, freshRestoreRechecksEveryTarget: true, normalShutdownBeforeFixtureCleanup: true });
});

test('conditional HTTP initialization failure drains its actual already-open listener and descriptor', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'conditional-http-initialization-failure');
  await assert.rejects(f.openServer({ startup: 'fail-after-listener' }), error => {
    assert.equal(error.code, 'controlled-http-initialization');
    assert.equal(error.cause.code, 'controlled-http-initialization'); return true;
  });
  assert.equal(f.report.servers.length, 1);
  const observation = f.report.servers[0];
  assert.equal(observation.ready.type, 'initialization-failed');
  assert.equal(observation.ready.listenerListening, true); assert.equal(observation.ready.openDescriptors, 1);
  assert.equal(observation.initializationError.code, 'controlled-http-initialization');
  assertNaturalDrain(observation);
  Object.assign(f.report.assertions, { initializationFailurePreserved: true, actualListenerAndDescriptorAcquired: true,
    failedInitializationNaturallyDrained: true, normalShutdownBeforeFixtureCleanup: true });
});

test('conditional HTTP cancellation before readiness preserves its primary and drains the real initializing owner', { timeout: 60000 }, async t => {
  const controller = new AbortController(), primary = 0;
  const f = await fixture(controlledContext(t, controller), 'conditional-http-initialization-abort');
  const opening = f.openServer({ startup: 'ready-with-descriptor' });
  controller.abort(primary);
  await assert.rejects(opening, error => { assert.equal(error, primary); return true; });
  assert.equal(f.report.servers.length, 1);
  const observation = f.report.servers[0];
  assert.equal(observation.ready.listenerListening, true); assert.equal(observation.ready.openDescriptors, 1);
  assert.equal(observation.initializationError, primary);
  assertNaturalDrain(observation);
  Object.assign(f.report.assertions, { cancellationBeforeReadyPreservesFalsyPrimary: true,
    actualInitializingListenerAndDescriptorDrained: true, normalShutdownBeforeFixtureCleanup: true });
});

test('an already-cancelled conditional HTTP owner naturally closes its real descriptor after actual versioned HTTP reads', { timeout: 60000 }, async t => {
  const controller = new AbortController();
  const f = await fixture(controlledContext(t, controller), 'conditional-http-cancelled-drain');
  const worker = await f.openServer({ startup: 'ready-with-descriptor' }), source = await f.openVfs(worker);
  assert.equal(worker.observation.ready.listenerListening, true); assert.equal(worker.observation.ready.openDescriptors, 1);
  await f.put(worker, '/source/first.nfo', payloads[0]);
  const metadata = await source.vfs.stat('/remote/source/first.nfo', { signal: t.signal });
  const handle = await source.vfs.openRead('/remote/source/first.nfo', { ifMatch: metadata.version, signal: t.signal });
  try {
    const chunks = []; for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), payloads[0]);
  } finally { await handle.close(); }
  const before = await worker.command({ type: 'snapshot' });
  assert.ok(before.openDescriptors >= 1, 'The independently owned real initialization FD remains open before cancellation.');
  controller.abort(new Error('Controlled business cancellation after the actual HTTP read.'));
  assert.equal(controller.signal.aborted, true);
  await source.registry.close();
  const closed = await worker.close();
  assert.ok(closed.requests.some(request => request.method === 'GET' && request.status === 200 && request.ifMatch === metadata.version));
  assertNaturalDrain(worker.observation);
  Object.assign(f.report.assertions, { actualConditionalHttpBytesRead: true, descriptorLiveBeforeCancellation: true,
    independentCleanupAfterBusinessAbort: true, normalShutdownBeforeFixtureCleanup: true });
});
