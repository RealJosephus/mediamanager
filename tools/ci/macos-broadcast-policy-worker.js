import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { command, failure, hash, maybeJson, save, terminalProgram } from './macos-broadcast-policy-terminal.js';
import { darwinProcessInspector, sameProcessIdentity as sameIdentity } from './macos-process-identity.js';

const inspector = await darwinProcessInspector(), identity = inspector.identity;

const ownFile = fileURLToPath(import.meta.url);
assert.equal(process.platform, 'darwin'); assert.equal(process.argv.length, 3);
const scopeFile = process.argv[2], scopeBytes = await readFile(scopeFile), scope = JSON.parse(scopeBytes);
const stat = await lstat(scopeFile);
assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o777, 0o600);
assert.equal(process.getuid(), scope.uid); assert.notEqual(scope.uid, 0); assert.equal(process.getgid(), scope.gid);
assert.equal(await realpath(process.cwd()), scope.repository); assert.equal(await realpath(process.execPath), scope.nodeExecutable);
assert.equal(hash(await readFile(ownFile)), scope.workerSha256); assert.equal(hash(await readFile(process.execPath)), scope.nodeSha256);
assert.equal(command('/usr/bin/git', ['-C', scope.repository, 'rev-parse', 'HEAD']).trim(), scope.head);
const ancestors = []; let next = process.ppid;
for (let count = 0; count < 12 && next > 1; count++) {
  const parent = identity(next); if (!parent) break; ancestors.push(parent); next = parent.parentPid;
}
const terminal = ancestors.find(value => value.executable === terminalProgram);
assert.ok(terminal && terminal.uid === scope.uid);
assert.equal(hash(await readFile(terminalProgram)), scope.terminalSha256);
const self = identity(process.pid), samples = [], active = new Set();
let interrupted, activeCancel;
const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
  interrupted = signal; activeCancel?.(new Error('The ordinary packet worker was interrupted by ' + signal));
}]));
for (const [signal, handler] of handlers) process.on(signal, handler);
async function waitFor(filename) {
  const deadline = Date.now() + 15000;
  for (;;) {
    if (interrupted) throw new Error('The ordinary worker was interrupted before phase admission.');
    const value = await maybeJson(filename); if (value) { assert.equal(value.nonce, scope.nonce); return value; }
    assert.ok(Date.now() < deadline, 'The proof owner did not admit the next packet phase.'); await delay(50);
  }
}
const bind = (socket, port, address) => new Promise((resolve, reject) => {
  const ready = () => { socket.removeListener('error', reject); resolve(); };
  socket.once('error', reject); socket.once('listening', ready); socket.bind(port, address);
});
async function sample(phase, port, kind) {
  if (interrupted) throw new Error('No socket may start after interruption.');
  const nonce = randomBytes(48), reply = Buffer.concat([Buffer.from('owned-policy-reply:'), nonce]);
  const receiver = dgram.createSocket('udp4'), sender = dgram.createSocket('udp4');
  active.add(receiver); active.add(sender);
  const item = { phase, kind, port, uid: process.getuid(), pid: process.pid, nonceHex: nonce.toString('hex'),
    expectedReplyHex: reply.toString('hex'), requestReceived: false, replyReceived: false, receipts: [], socketErrors: [],
    startedAt: new Date().toISOString() }; samples.push(item);
  let timeout, finish, rejectWait;
  const pending = new Promise((resolve, reject) => { finish = resolve; rejectWait = reject; });
  pending.catch(() => {}); activeCancel = rejectWait;
  for (const [role, socket] of [['receiver', receiver], ['sender', sender]]) socket.on('error', error => {
    item.socketErrors.push({ role, error: failure(error) });
    if (phase === 'target-destroyed' && kind === 'broadcast' && role === 'sender') finish(); else rejectWait(error);
  });
  receiver.on('message', (bytes, remote) => {
    item.receipts.push({ role: 'receiver', hex: bytes.toString('hex'), remote });
    if (!bytes.equals(nonce)) return;
    item.requestReceived = true;
    receiver.send(reply, remote.port, remote.address, error => { item.replySend = error ? { error: failure(error) } : { code: 0 }; if (error) rejectWait(error); });
  });
  sender.on('message', (bytes, remote) => {
    item.receipts.push({ role: 'sender', hex: bytes.toString('hex'), remote });
    if (bytes.equals(reply)) { item.replyReceived = true; finish(); }
  });
  try {
    await bind(receiver, kind === 'loopback-control' ? 0 : port, kind === 'loopback-control' ? '127.0.0.1' : '0.0.0.0');
    if (interrupted) throw new Error('No sender socket may start after interruption.');
    await bind(sender, 0, kind === 'loopback-control' ? '127.0.0.1' : '0.0.0.0'); sender.setBroadcast(true);
    item.receiver = receiver.address(); item.sender = sender.address();
    item.destination = kind === 'loopback-control' ? '127.0.0.1' : '255.255.255.255';
    item.destinationPort = kind === 'loopback-control' ? item.receiver.port : port;
    if (interrupted) throw new Error('No packet may be sent after interruption.');
    timeout = setTimeout(() => phase === 'target-destroyed' && kind === 'broadcast' ? finish() : rejectWait(new Error('Actual UDP reply did not arrive.')), phase === 'target-destroyed' && kind === 'broadcast' ? 1000 : 5000);
    await new Promise((resolve, reject) => sender.send(nonce, item.destinationPort, item.destination, error => {
      item.send = error ? { error: failure(error) } : { code: 0 };
      // A failed target may return an error or consume/drop the packet. The
      // absence of actual egress is independently checked from captured bytes.
      if (error && !(phase === 'target-destroyed' && kind === 'broadcast')) reject(error); else resolve();
    }));
    await pending;
    if (phase === 'target-destroyed' && kind === 'broadcast') { assert.equal(item.requestReceived, false); assert.equal(item.replyReceived, false); }
    else { assert.equal(item.requestReceived, true); assert.equal(item.replyReceived, true); }
  } finally {
    clearTimeout(timeout); activeCancel = undefined; item.closed = [];
    for (const socket of [receiver, sender]) await new Promise((resolve, reject) => {
      const closed = () => { active.delete(socket); item.closed.push(true); resolve(); }; socket.once('close', closed);
      try { socket.close(); }
      catch (error) { socket.removeListener('close', closed); if (error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') { active.delete(socket); item.closed.push(true); resolve(); } else reject(error); }
    });
    item.finishedAt = new Date().toISOString();
  }
}
let problem;
try {
  await save(scope.startedFile, { nonce: scope.nonce, head: scope.head, uid: scope.uid, identity: self, terminal,
    ancestors, scopeSha256: hash(scopeBytes), nodeSha256: scope.nodeSha256, startedAt: new Date().toISOString() });
  const admission = await waitFor(scope.admissionFile);
  assert.ok(sameIdentity(admission.worker, self) && sameIdentity(admission.terminal, terminal));
  await sample('alive', 0, 'loopback-control');
  for (const port of scope.broadcastPorts) await sample('alive', port, 'broadcast');
  await save(scope.aliveFile, { nonce: scope.nonce, identity: self, samples, allSocketsClosed: active.size === 0 });
  await waitFor(scope.targetDestroyedFile);
  for (const port of scope.broadcastPorts) await sample('target-destroyed', port, 'broadcast');
  await sample('target-destroyed', 0, 'loopback-control');
} catch (error) { problem = error; }
finally {
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  const result = { nonce: scope.nonce, head: scope.head, identity: self, uid: process.getuid(), terminal, samples,
    code: problem || interrupted || active.size ? 2 : 0, signal: null, interrupted: interrupted ?? null,
    allSocketsClosed: active.size === 0, error: problem ? failure(problem) : null,
    nativeDiscoveryExecuted: false, fullAcceptance: false, releaseAcceptance: false, finishedAt: new Date().toISOString() };
  await save(scope.exitFile, result); process.exitCode = result.code;
}
