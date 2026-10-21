import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Infrastructure diagnosis only. Neither root success, timeout nor failure can
// grant acceptance or replace macos-broadcast's ordinary-UID nonce/reply gate.
// No app/test imports, socket shim, synthetic packets or network policy changes.
assert.equal(process.platform, 'darwin'); assert.equal(process.argv.length, 5); assert.equal(process.argv[2], '--worker');
const scopeFile = process.argv[3], outputFile = process.argv[4], ownFile = fileURLToPath(import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const failure = error => ({ name: error.name, message: error.message, code: error.code, errno: error.errno, syscall: error.syscall });
const scope = JSON.parse(await readFile(scopeFile, 'utf8'));
assert.equal(scope.schemaVersion, 1); assert.match(scope.runId, /^\d+$/u);
assert.ok(Number.isInteger(scope.userId) && scope.userId > 0);
assert.ok([0, scope.userId].includes(process.getuid()));
assert.equal(outputFile, process.getuid() === 0 ? scope.rootOutput : scope.userOutput);
assert.equal(await realpath(process.execPath), scope.nodeExecutable); assert.equal(sha(await readFile(ownFile)), scope.scriptSha256);
assert.equal(sha(await readFile(process.execPath)), scope.nodeSha256);
assert.ok(path.isAbsolute(scope.provisioningDirectory)); assert.equal(await realpath(scope.provisioningDirectory), scope.provisioningDirectory);
for (const filename of [scopeFile, outputFile, scope.userOutput, scope.rootOutput]) {
  assert.ok(path.isAbsolute(filename)); assert.equal(path.dirname(filename), scope.provisioningDirectory);
  const stat = await lstat(filename); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.uid, scope.userId);
  assert.equal(stat.mode & 0o777, 0o600); assert.equal(await realpath(filename), filename);
}
assert.match(scope.interface, /^feth\d+$/u); assert.match(scope.peer, /^feth\d+$/u); assert.notEqual(scope.interface, scope.peer);
const subnet = /^198\.19\.(\d+)\.1$/u.exec(scope.address); assert.ok(subnet && Number(subnet[1]) >= 64 && Number(subnet[1]) < 192);
assert.equal(scope.peerAddress, '198.19.' + subnet[1] + '.2'); assert.equal(scope.directedBroadcast, '198.19.' + subnet[1] + '.3');
function capture(file, args, timeout = 5000) {
  try { return { file, args, code: 0, stdout: execFileSync(file, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (error) { return { file, args, code: error.status ?? null, signal: error.signal ?? null, error: failure(error),
    stdout: error.stdout?.toString() ?? '', stderr: error.stderr?.toString() ?? '' }; }
}
const topology = [scope.interface, scope.peer].map(name => capture('/sbin/ifconfig', [name]));
for (const [index, result] of topology.entries()) {
  assert.equal(result.code, 0); assert.ok(result.stdout.includes('inet ' + [scope.address, scope.peerAddress][index] + ' '));
  assert.ok(result.stdout.includes('peer: ' + [scope.peer, scope.interface][index]));
  assert.match(result.stdout, /<[^>]*\bBROADCAST\b[^>]*>/u); assert.match(result.stdout, /status: active/u);
}
const targets = ['127.0.0.1', scope.peerAddress, scope.directedBroadcast, '255.255.255.255'];
const counters = () => ['ip', 'udp', 'arp'].map(protocol => capture('/usr/sbin/netstat', ['-s', '-p', protocol]));
function snapshot() {
  return { at: new Date().toISOString(), interfaces: capture('/sbin/ifconfig', ['-a']), routes: capture('/usr/sbin/netstat', ['-rn', '-f', 'inet']),
    routeLookups: targets.flatMap(target => [capture('/sbin/route', ['-n', 'get', target]), capture('/sbin/route', ['-n', 'get', '-ifscope', scope.interface, target])]),
    sysctl: ['kern.osrelease', 'net.inet.ip.forwarding', 'net.inet.ip.check_interface', 'net.inet.ip.scopedroute', 'net.inet.udp.checksum',
      'net.inet.udp.log.enable', 'net.inet.udp.log.enable_usage', 'net.inet.udp.log.remote_port_included', 'net.necp.drop_all_level',
      'net.necp.restrict_multicast'].map(key => capture('/usr/sbin/sysctl', [key])), counters: counters() };
}
let interrupted, activeCancel;
const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => { interrupted = signal; activeCancel?.(); }]));
for (const [signal, handler] of handlers) process.on(signal, handler);
async function sample(sourceAddress, destination) {
  const item = { sourceAddress, destination, destinationPort: 65001, startedAt: new Date().toISOString(), countersBefore: counters(), receipts: [], errors: [] };
  const nonce = randomBytes(32), reply = Buffer.concat([Buffer.from('actual UDP diagnostic reply:'), nonce]);
  item.nonceHex = nonce.toString('hex'); item.expectedReplyHex = reply.toString('hex');
  const receiver = dgram.createSocket('udp4'), sender = dgram.createSocket('udp4'), sockets = [receiver, sender];
  let timer, finish, settled = false;
  const pending = new Promise(resolve => { finish = reason => { if (!settled) { settled = true; item.completion = reason; resolve(); } }; });
  activeCancel = () => finish('interrupted');
  const bind = (socket, port, address) => new Promise((resolve, reject) => {
    const onError = error => { socket.removeListener('listening', onListening); reject(error); };
    const onListening = () => { socket.removeListener('error', onError); resolve(); };
    socket.once('error', onError); socket.once('listening', onListening); socket.bind(port, address);
  });
  sockets.forEach((socket, index) => socket.on('error', error => { item.errors.push({ role: index ? 'sender' : 'receiver', error: failure(error) }); finish('socket-error'); }));
  receiver.on('message', (bytes, remote) => {
    item.receipts.push({ role: 'receiver', at: new Date().toISOString(), hex: bytes.toString('hex'), remote });
    if (bytes.equals(nonce)) receiver.send(reply, remote.port, remote.address, error => {
      item.replySendCallback = error ? { error: failure(error) } : { code: 0 };
      if (error) finish('reply-send-error');
    });
  });
  sender.on('message', (bytes, remote) => {
    item.receipts.push({ role: 'sender', at: new Date().toISOString(), hex: bytes.toString('hex'), remote });
    if (bytes.equals(reply)) { item.actualReplyReceived = true; finish('actual-reply'); }
  });
  try {
    if (interrupted) { finish('interrupted-before-bind'); return item; }
    await bind(receiver, 65001, '0.0.0.0'); await bind(sender, 0, sourceAddress); sender.setBroadcast(true);
    item.receiverAddress = receiver.address(); item.senderAddress = sender.address();
    timer = setTimeout(() => finish('timeout'), 750);
    if (interrupted) finish('interrupted-before-send');
    else await new Promise(resolve => sender.send(nonce, 65001, destination, error => {
      item.sendCallback = error ? { error: failure(error) } : { code: 0 };
      if (error) finish('send-error'); resolve();
    }));
    await pending;
  } catch (error) { item.errors.push({ role: 'setup', error: failure(error) }); finish('setup-error'); }
  finally {
    clearTimeout(timer); activeCancel = undefined; item.socketClose = [];
    for (const [index, socket] of sockets.entries()) {
      await new Promise(resolve => {
        const closed = () => { item.socketClose.push({ role: index ? 'sender' : 'receiver', closeEvent: true }); resolve(); };
        socket.once('close', closed);
        try { socket.close(); }
        catch (error) { socket.removeListener('close', closed); item.socketClose.push({ role: index ? 'sender' : 'receiver', closeEvent: false, error: failure(error), noRunningSocket: error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING' }); resolve(); }
      });
    }
    item.allSocketsClosed = item.socketClose.every(value => value.closeEvent || value.noRunningSocket);
    item.countersAfter = counters(); item.finishedAt = new Date().toISOString();
  }
  return item;
}
const output = { schemaVersion: 1, kind: 'actual-udp-diagnostic-only', runId: scope.runId, head: scope.head,
  pid: process.pid, parentPid: process.ppid, uid: process.getuid(), gid: process.getgid(), nodeExecutable: process.execPath,
  nodeSha256: scope.nodeSha256, scriptSha256: scope.scriptSha256, scopeSha256: sha(await readFile(scopeFile)), startedAt: new Date().toISOString(), topology,
  phaseAcceptance: false, releaseAcceptance: false, nativeDiscoveryExecuted: false, officialOrdinaryUidGateStillRequired: true, samples: [] };
try {
  output.before = snapshot();
  matrix: for (const sourceAddress of ['0.0.0.0', scope.address]) for (const target of targets) {
    output.samples.push(await sample(sourceAddress, target));
    if (interrupted) break matrix;
  }
  output.after = snapshot();
  // Actual available records only. Missing/empty logs cannot prove no policy
  // denial; preserve command errors and counter snapshots instead of guessing.
  const pid = String(process.pid);
  output.kernelRecords = capture('/usr/bin/log', ['show', '--last', '1m', '--style', 'json', '--predicate',
    '(process == "kernel" OR process == "nehelper" OR process == "networkd") AND (eventMessage MATCHES "(?s).*process: [^:]+:' + pid
      + ' .*") AND (eventMessage CONTAINS ":65001]")'], 10000);
} catch (error) { output.error = failure(error); }
finally {
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  output.interrupted = interrupted ?? null; output.finishedAt = new Date().toISOString();
  output.allSocketsClosed = output.samples.every(value => value.allSocketsClosed);
  await writeFile(outputFile, JSON.stringify(output, null, 2) + '\n');
}
process.exitCode = output.error || interrupted || !output.allSocketsClosed ? 2 : 0;
