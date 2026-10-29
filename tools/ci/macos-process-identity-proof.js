import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { darwinProcessInspector, sameProcessBirth, sameProcessIdentity } from './macos-process-identity.js';
import { signalProcess } from './macos-process-signal.js';

assert.equal(process.platform, 'darwin');
async function ownerProcess(t, options = {}) {
  const filename = fileURLToPath(new URL('../../tests/helpers/macos-process-owner.js', import.meta.url));
  const child = spawn(process.execPath, [filename], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: process.env, ...options });
  let diagnostics = '';
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-65536); });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const admitted = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('message', message => message?.kind === 'ready' ? resolve(message.identity)
      : reject(new Error('Unexpected independent owner message.')));
    child.once('exit', () => reject(new Error('An independent owner exited before admission: ' + diagnostics)));
  });
  let next = 0;
  const request = body => new Promise((resolve, reject) => {
    const requestId = ++next;
    const message = value => {
      if (value.requestId !== requestId) return;
      cleanup(); value.error ? reject(Object.assign(new Error(value.error.message), value.error)) : resolve(value.value);
    };
    const closed = () => { cleanup(); reject(new Error('The independent owner closed during an admitted request: ' + diagnostics)); };
    const cleanup = () => { child.removeListener('message', message); child.removeListener('close', closed); };
    child.on('message', message); child.once('close', closed); child.send({ ...body, requestId });
  });
  return { child, admitted, request, exited };
}

test('actual Darwin owners prove cross-UID reads, fresh signals, forced exit and unrelated process survival', { timeout: 30000 }, async t => {
  const inspector = await darwinProcessInspector(), self = inspector.identity(process.pid);
  assert.equal(self.pid, process.pid); assert.equal(self.uid, process.getuid()); assert.equal(self.gid, process.getgid());
  assert.match(self.uniqueId, /^\d+$/u); assert.match(self.parentUniqueId, /^\d+$/u);
  assert.match(self.executableUuid, /^[a-f0-9]{32}$/u);
  const peerUid = process.env.MEDIAMANAGER_TEST_PROCESS_PEER_UID,
    peerGid = process.env.MEDIAMANAGER_TEST_PROCESS_PEER_GID;
  assert.equal(Boolean(peerUid), Boolean(peerGid));
  const crossUid = Boolean(peerUid);
  if (crossUid) { assert.equal(process.getuid(), 0); assert.ok(Number(peerUid) > 0); }
  const peer = await ownerProcess(t, crossUid ? { uid: Number(peerUid), gid: Number(peerGid) } : {});
  assert.ok(sameProcessIdentity(inspector.identity(peer.child.pid), peer.admitted));
  assert.equal(peer.admitted.parentPid, process.pid); assert.equal(peer.admitted.parentUniqueId, self.uniqueId);
  assert.ok(sameProcessIdentity(await peer.request({ kind: 'inspect', pid: process.pid }), self));
  const target = await peer.request({ kind: 'spawn', name: 'signal-target' });
  const unrelated = await peer.request({ kind: 'spawn', name: 'unrelated-control' });
  assert.equal(target.uid, peer.admitted.uid); assert.equal(target.parentUniqueId, peer.admitted.uniqueId);
  assert.ok(inspector.descendants(peer.admitted).some(value => sameProcessBirth(value, target)));
  assert.deepEqual(inspector.descendants(target), []);
  const rejected = [];
  for (const change of [{ uniqueId: String(BigInt(target.uniqueId) + 1n) }, { pidVersion: target.pidVersion + 1 },
    { executable: target.executable + '.unbound' }]) {
    const result = await peer.request({ kind: 'signal', identity: { ...target, ...change }, signal: 'SIGKILL' });
    assert.equal(result, false); assert.ok(sameProcessIdentity(inspector.identity(target.pid), target)); rejected.push(change);
  }
  assert.equal(await peer.request({ kind: 'signal', identity: target, signal: 'SIGTERM' }), true);
  assert.deepEqual(await peer.request({ kind: 'wait', name: 'signal-target' }), { code: null, signal: 'SIGTERM' });
  assert.equal(inspector.identity(target.pid), null);
  assert.ok(sameProcessIdentity(inspector.identity(unrelated.pid), unrelated));
  const elevated = await ownerProcess(t);
  assert.ok(sameProcessIdentity(await peer.request({ kind: 'inspect', pid: elevated.child.pid }), elevated.admitted));
  assert.equal(await peer.request({ kind: 'signal', identity: elevated.admitted, signal: 'SIGKILL' }), true);
  assert.deepEqual(await elevated.exited, { code: null, signal: 'SIGKILL' });
  assert.equal(inspector.identity(elevated.child.pid), null);
  assert.equal(signalProcess(inspector, { ...unrelated, uniqueId: String(BigInt(unrelated.uniqueId) + 1n) }, 'SIGKILL'), false);
  assert.ok(sameProcessIdentity(inspector.identity(unrelated.pid), unrelated));
  assert.equal(await peer.request({ kind: 'signal', identity: unrelated, signal: 'SIGTERM' }), true);
  assert.deepEqual(await peer.request({ kind: 'wait', name: 'unrelated-control' }), { code: null, signal: 'SIGTERM' });
  const close = await peer.request({ kind: 'close' });
  assert.equal(close.closedChildren, 2); assert.deepEqual(await peer.exited, { code: 0, signal: null });
  assert.equal(inspector.identity(peer.child.pid), null);
  const result = { self, peer: peer.admitted, target, unrelated, elevated: elevated.admitted, rejected,
    crossUidReadAndElevatedSignalExecuted: crossUid, ordinaryTargetExit: { code: null, signal: 'SIGTERM' },
    elevatedTargetExit: { code: null, signal: 'SIGKILL' }, unrelatedSurvivedTargetSignals: true,
    allActualOwnersClosed: true };
  const bytes = Buffer.from(JSON.stringify(result));
  t.diagnostic('Actual process ownership SHA256 ' + createHash('sha256').update(bytes).digest('hex'));
  if (process.env.MEDIAMANAGER_TEST_PROCESS_EVIDENCE_ROOT) {
    const output = process.env.MEDIAMANAGER_TEST_PROCESS_EVIDENCE_ROOT;
    await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'owners.json'), bytes, { flag: 'wx' });
  }
});

test('actual Darwin exec retains process birth while refreshing executable identity before signal delivery', { timeout: 30000 }, async t => {
  const inspector = await darwinProcessInspector(), helper = fileURLToPath(new URL('../../tests/helpers/macos-process-owner.js', import.meta.url));
  const child = spawn('/bin/sh', ['-c', 'printf \'%s\\n\' "$$"; IFS= read -r gate; exec "$@"',
    'owned-process-exec', process.execPath, helper, '--exec-report'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  let buffered = '', diagnostics = ''; const lines = [], waiting = [];
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-65536); });
  child.stdout.on('data', bytes => {
    buffered += bytes.toString();
    for (;;) { const end = buffered.indexOf('\n'); if (end < 0) break;
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (waiting.length) waiting.shift().resolve(line); else lines.push(line);
    }
  });
  child.once('error', reason => { for (const waiter of waiting.splice(0)) waiter.reject(reason); });
  child.once('close', () => { for (const waiter of waiting.splice(0)) waiter.reject(new Error('Exec owner closed before its receipt: ' + diagnostics)); });
  const nextLine = () => lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  assert.equal(Number(await nextLine()), child.pid);
  const before = inspector.identity(child.pid); assert.ok(before); child.stdin.write('admit\n');
  const reported = JSON.parse(await nextLine()); assert.equal(reported.kind, 'executed');
  const after = inspector.identity(child.pid); assert.ok(sameProcessIdentity(after, reported.identity));
  assert.ok(sameProcessBirth(before, after)); assert.equal(sameProcessIdentity(before, after), false);
  assert.notEqual(before.pidVersion, after.pidVersion); assert.notEqual(before.executable, after.executable);
  assert.equal(signalProcess(inspector, before, 'SIGKILL'), false);
  assert.ok(sameProcessIdentity(inspector.identity(child.pid), after));
  assert.equal(signalProcess(inspector, after, 'SIGTERM'), true);
  const actualExit = await exited;
  assert.deepEqual(actualExit, { code: null, signal: 'SIGTERM' }); assert.equal(inspector.identity(child.pid), null);
  const observation = { before, reported: reported.identity, after, staleSignalRejected: true,
    freshSignalDelivered: true, actualExit, processAbsentAfterClose: true };
  t.diagnostic('Actual exec identity: ' + JSON.stringify(observation));
  if (process.env.MEDIAMANAGER_TEST_PROCESS_EVIDENCE_ROOT) {
    const output = process.env.MEDIAMANAGER_TEST_PROCESS_EVIDENCE_ROOT;
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'exec.json'), JSON.stringify(observation), { flag: 'wx' });
  }
});
