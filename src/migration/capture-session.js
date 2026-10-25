import { validateInstanceStateSnapshot, validateWriteBarrierSnapshot } from './instance-state.js';

const sessions = new WeakMap();
const receiptKeys = ['pid', 'shutdownStatus', 'forced', 'exitCode', 'signalCode', 'stopped'];

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}

function exactOptions(options, required, optional, label) {
  plainRecord(options, label);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(options);
  if (required.some(key => !Object.hasOwn(options, key)) || keys.some(key => !allowed.has(key))) {
    throw new TypeError(`Invalid ${label} options`);
  }
  return options;
}

function exactReceipt(receipt) {
  plainRecord(receipt, 'stopped-service receipt');
  const keys = Object.keys(receipt).sort();
  const expected = [...receiptKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('Invalid stopped-service receipt');
  }
  return receipt;
}

function deepFreeze(value, visited = new WeakSet()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  return Object.freeze(value);
}

function createSession(evidence, instanceState, record) {
  const validated = deepFreeze(validateWriteBarrierSnapshot(evidence, instanceState));
  const session = Object.freeze({ evidence: validated });
  sessions.set(session, { ...record, evidence: validated });
  return session;
}

/** Create a live capability for a test-owned, isolated offline instance copy. */
export function createIsolatedOfflineCopyCaptureSession(options) {
  exactOptions(options, ['instanceState', 'ownerId', 'assertHeld'], ['recordedAt'], 'isolated capture session');
  const { ownerId, assertHeld } = options;
  if (typeof assertHeld !== 'function') throw new TypeError('Isolated capture session assertHeld must be a function');
  const state = validateInstanceStateSnapshot(options.instanceState);
  const evidence = {
    kind: 'isolated-offline-copy',
    identityDigest: state.identity.digest,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
    isolatedCopy: {
      owner: { kind: 'test-fixture', id: ownerId },
      source: { identityDigest: state.identity.digest, serverId: state.identity.serverId },
    },
  };
  return createSession(evidence, state, { kind: evidence.kind, assertHeld });
}

/** Create a live capability bound to one clean shutdown receipt from an owned native process. */
export function createStoppedServiceCaptureSession(options) {
  exactOptions(options, ['instanceState', 'receipt', 'assertStopped'], ['recordedAt'], 'stopped-service capture session');
  if (typeof options.assertStopped !== 'function') throw new TypeError('Stopped-service assertStopped must be a function');
  const state = validateInstanceStateSnapshot(options.instanceState);
  const receipt = deepFreeze(structuredClone(exactReceipt(options.receipt)));
  const evidence = {
    kind: 'stopped-service',
    identityDigest: state.identity.digest,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
    ownedProcess: {
      pid: receipt.pid,
      shutdown: { kind: 'http', statusCode: receipt.shutdownStatus },
      forced: receipt.forced,
      exitCode: receipt.exitCode,
      signalCode: receipt.signalCode,
      stopped: receipt.stopped,
    },
  };
  return createSession(evidence, state, { kind: evidence.kind, assertStopped: options.assertStopped, receipt });
}

function assertSameReceipt(actual, expected) {
  exactReceipt(actual);
  if (receiptKeys.some(key => !Object.is(actual[key], expected[key]))) {
    throw new Error('Stopped-service assertStopped did not return the bound shutdown receipt');
  }
}

/** Revalidate a branded session and its live hold before either capture boundary. */
export async function assertCaptureSessionHeld(session, instanceState, phase) {
  if (!['pre', 'post'].includes(phase)) throw new TypeError('Capture session phase must be pre or post');
  const record = sessions.get(session);
  if (!record) throw new TypeError('A branded capture session is required');
  validateWriteBarrierSnapshot(record.evidence, instanceState);
  if (record.kind === 'isolated-offline-copy') await record.assertHeld(phase);
  else {
    const receipt = await record.assertStopped(phase);
    assertSameReceipt(receipt, record.receipt);
  }
  validateWriteBarrierSnapshot(record.evidence, instanceState);
  return structuredClone(record.evidence);
}
