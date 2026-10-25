import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import {
  assertCaptureSessionHeld,
  createIsolatedOfflineCopyCaptureSession,
  createStoppedServiceCaptureSession,
} from '../../src/migration/capture-session.js';
import { createInstanceFixture } from './instance-fixture.js';

const recordedAt = '2026-10-04T01:02:03.000Z';
const receipt = Object.freeze({ pid: 4321, shutdownStatus: 204, forced: false, exitCode: 0, signalCode: null, stopped: true });

async function state(t, prefix = 'capture-session-') {
  const fixture = await createInstanceFixture(t, { prefix });
  return discoverInstanceState({ instanceRoot: fixture.root });
}

test('isolated offline sessions retain immutable evidence and are held at pre and post boundaries', async t => {
  const instanceState = await state(t, 'capture-isolated-');
  const phases = [];
  const session = createIsolatedOfflineCopyCaptureSession({
    instanceState,
    ownerId: 'capture-session fixture',
    recordedAt,
    assertHeld: async phase => { phases.push(phase); },
  });
  assert.deepEqual(Object.keys(session), ['evidence']);
  assert.deepEqual(session.evidence, {
    kind: 'isolated-offline-copy',
    identityDigest: instanceState.identity.digest,
    recordedAt,
    isolatedCopy: {
      owner: { kind: 'test-fixture', id: 'capture-session fixture' },
      source: { identityDigest: instanceState.identity.digest, serverId: instanceState.identity.serverId },
    },
  });
  try { session.evidence.isolatedCopy.owner.id = 'changed'; } catch { }
  assert.equal(session.evidence.isolatedCopy.owner.id, 'capture-session fixture');

  const before = await assertCaptureSessionHeld(session, instanceState, 'pre');
  const after = await assertCaptureSessionHeld(session, instanceState, 'post');
  assert.deepEqual(phases, ['pre', 'post']);
  assert.deepEqual(before, session.evidence);
  assert.deepEqual(after, session.evidence);
  try { before.isolatedCopy.owner.id = 'changed returned evidence'; } catch { }
  assert.equal(session.evidence.isolatedCopy.owner.id, 'capture-session fixture');
  assert.equal(after.isolatedCopy.owner.id, 'capture-session fixture');
});

test('capture-session brands reject JSON, structured clones, forged objects and unknown phases', async t => {
  const instanceState = await state(t, 'capture-brand-');
  let calls = 0;
  const session = createIsolatedOfflineCopyCaptureSession({
    instanceState,
    ownerId: 'brand fixture',
    assertHeld: () => { calls++; },
  });
  for (const forged of [
    JSON.parse(JSON.stringify(session)),
    structuredClone(session),
    { evidence: session.evidence },
    Object.freeze({ evidence: session.evidence }),
  ]) await assert.rejects(assertCaptureSessionHeld(forged, instanceState, 'pre'), /branded capture session/u);
  for (const phase of ['before', 'after', 'PRE', '', null, undefined]) {
    await assert.rejects(assertCaptureSessionHeld(session, instanceState, phase), /phase must be pre or post/u);
  }
  assert.equal(calls, 0);

  const otherState = await state(t, 'capture-other-state-');
  await assert.rejects(assertCaptureSessionHeld(session, otherState, 'pre'), /Invalid or unbound write barrier/u);
  assert.equal(calls, 0);
});

test('isolated factory has an exact option surface and revalidates state after assertHeld', async t => {
  const instanceState = await state(t, 'capture-isolated-options-');
  const valid = { instanceState, ownerId: 'exact fixture', assertHeld() {}, recordedAt };
  assert.throws(() => createIsolatedOfflineCopyCaptureSession({ ...valid, evidence: {} }), /Invalid isolated capture session options/u);
  assert.throws(() => createIsolatedOfflineCopyCaptureSession({ instanceState, ownerId: 'missing callback' }), /options/u);
  assert.throws(() => createIsolatedOfflineCopyCaptureSession({ ...valid, assertHeld: true }), /must be a function/u);
  assert.throws(() => createIsolatedOfflineCopyCaptureSession({ ...valid, ownerId: '' }), /requires test ownership/u);
  assert.throws(() => createIsolatedOfflineCopyCaptureSession({ ...valid, recordedAt: 'not-a-date' }), /recordedAt/u);

  const mutableState = structuredClone(instanceState);
  const session = createIsolatedOfflineCopyCaptureSession({
    instanceState: mutableState,
    ownerId: 'post validation fixture',
    recordedAt,
    assertHeld: () => { mutableState.identity.digest = 'f'.repeat(64); },
  });
  await assert.rejects(assertCaptureSessionHeld(session, mutableState, 'pre'), /identity digest does not match|Invalid or unbound write barrier/u);
});

test('stopped-service sessions map and continuously verify one clean native receipt', async t => {
  const instanceState = await state(t, 'capture-stopped-');
  const phases = [];
  let observed = { ...receipt };
  const session = createStoppedServiceCaptureSession({
    instanceState,
    receipt,
    recordedAt,
    assertStopped: async phase => { phases.push(phase); return { ...observed }; },
  });
  assert.deepEqual(session.evidence, {
    kind: 'stopped-service',
    identityDigest: instanceState.identity.digest,
    recordedAt,
    ownedProcess: {
      pid: receipt.pid,
      shutdown: { kind: 'http', statusCode: receipt.shutdownStatus },
      forced: false,
      exitCode: 0,
      signalCode: null,
      stopped: true,
    },
  });
  try { session.evidence.ownedProcess.shutdown.statusCode = 500; } catch { }
  assert.equal(session.evidence.ownedProcess.shutdown.statusCode, 204);
  assert.deepEqual(await assertCaptureSessionHeld(session, instanceState, 'pre'), session.evidence);
  assert.deepEqual(await assertCaptureSessionHeld(session, instanceState, 'post'), session.evidence);
  assert.deepEqual(phases, ['pre', 'post']);

  observed = { ...receipt, pid: receipt.pid + 1 };
  await assert.rejects(assertCaptureSessionHeld(session, instanceState, 'post'), /bound shutdown receipt/u);
  observed = { ...receipt, extra: true };
  await assert.rejects(assertCaptureSessionHeld(session, instanceState, 'post'), /Invalid stopped-service receipt/u);
});

test('stopped-service factory rejects invalid options, receipts and assertion results', async t => {
  const instanceState = await state(t, 'capture-stopped-options-');
  const valid = { instanceState, receipt, assertStopped: () => receipt, recordedAt };
  assert.throws(() => createStoppedServiceCaptureSession({ ...valid, writeBarrier: {} }), /Invalid stopped-service capture session options/u);
  assert.throws(() => createStoppedServiceCaptureSession({ instanceState, receipt }), /options/u);
  assert.throws(() => createStoppedServiceCaptureSession({ ...valid, assertStopped: false }), /must be a function/u);
  assert.throws(() => createStoppedServiceCaptureSession({ ...valid, receipt: { ...receipt, extra: true } }), /Invalid stopped-service receipt/u);
  assert.throws(() => createStoppedServiceCaptureSession({ ...valid, receipt: { ...receipt, forced: true } }), /clean HTTP 204 shutdown/u);
  assert.throws(() => createStoppedServiceCaptureSession({ ...valid, receipt: { ...receipt, shutdownStatus: 500 } }), /clean HTTP 204 shutdown/u);

  const failure = new Error('native stop ownership was lost');
  const failing = createStoppedServiceCaptureSession({ ...valid, assertStopped: async () => { throw failure; } });
  await assert.rejects(assertCaptureSessionHeld(failing, instanceState, 'pre'), { message: failure.message });
  const missing = createStoppedServiceCaptureSession({ ...valid, assertStopped: async () => undefined });
  await assert.rejects(assertCaptureSessionHeld(missing, instanceState, 'pre'), /Invalid stopped-service receipt/u);
});
