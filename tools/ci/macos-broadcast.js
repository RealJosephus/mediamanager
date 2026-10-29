import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, failure, hash } from './macos-broadcast-policy-terminal.js';
import { darwinProcessInspector, sameProcessBirth } from './macos-process-identity.js';

// This owner uses the filter-only, ordinary-UID route-to policy exercised by
// macos-broadcast-policy-proof.js. It never writes or replays a global route.
// A final quick block prevents fallback when the private target is unavailable.
// https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
assert.equal(process.platform, 'darwin'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
const inspector = await darwinProcessInspector(), identity = inspector.identity;
assert.notEqual(process.getuid(), 0, 'Business sockets must retain the ordinary runner UID.');
const mode = process.argv[2]; assert.ok(['setup', 'strict', 'cleanup'].includes(mode)); assert.equal(process.argv.length, 3);
const repository = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
assert.equal(await realpath(process.cwd()), repository);
const outputRoot = process.env.MEDIAMANAGER_VALIDATION_OUTPUT_ROOT;
assert.ok(path.isAbsolute(outputRoot ?? ''));
const directory = path.join(outputRoot, 'provisioning'), filename = path.join(directory, 'broadcast-policy.json');
await mkdir(directory, { recursive: true });
const candidateHead = command('/usr/bin/git', ['rev-parse', 'HEAD']).trim(), uid = process.getuid();
const helper = path.join(directory, 'broadcast-interface-reader');
const source = path.join(repository, 'tools/ci/macos-broadcast-policy-capture.c');
let record, interrupted, cancelSockets, child, sequence = 0;
const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
  interrupted = signal; cancelSockets?.(new Error('Broadcast operation interrupted by ' + signal));
  if (child?.pid) child.kill(signal === 'SIGHUP' ? 'SIGTERM' : signal);
}]));
for (const [signal, handler] of handlers) process.on(signal, handler);
const checkInterrupted = () => { if (interrupted) throw new Error('Broadcast operation interrupted by ' + interrupted); };
async function publish() {
  const temporary = filename + '.pending-' + process.pid + '-' + ++sequence;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(record, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, filename);
  const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
}
function run(file, args, { allowFailure = false } = {}) {
  const operation = { file, args, startedAt: new Date().toISOString() }; record.operations.push(operation);
  const result = spawnSync(file, args, { cwd: repository, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
  Object.assign(operation, { pid: result.pid, code: result.status, signal: result.signal, stdout: result.stdout ?? '',
    stderr: result.stderr ?? '', error: result.error ? failure(result.error) : null, finishedAt: new Date().toISOString() });
  if (!allowFailure) assert.ok(result.status === 0 && result.signal === null && !result.error, JSON.stringify(operation));
  return operation;
}
const sudo = args => run('/usr/bin/sudo', ['-n', ...args]);
const pf = (args, options) => run('/usr/bin/sudo', ['-n', '/sbin/pfctl', ...args], options);
const interfaceIndex = name => JSON.parse(run(helper, ['interface-index', name]).stdout).interfaceIndex;
function snapshot(label) {
  return { label, at: new Date().toISOString(), route: run('/sbin/route', ['-n', 'get', '255.255.255.255'], { allowFailure: true }),
    routes: run('/usr/sbin/netstat', ['-rn', '-f', 'inet']), interfaces: run('/sbin/ifconfig', ['-a']),
    rootFilter: pf(['-sr']), rootTranslation: pf(['-sn']), references: pf(['-s', 'References'], { allowFailure: true }) };
}
function assertRootHook() {
  const rootFilter = pf(['-sr']);
  const filter = rootFilter.stdout.trim().split('\n').map(line => line.trim()).filter(Boolean).filter(line => !line.startsWith('scrub-anchor '));
  assert.deepEqual(filter, ['anchor "com.apple/*" all'], 'An existing unrestricted Apple filter child-anchor entry is required.');
  return rootFilter;
}
function anchorContents() {
  return Object.fromEntries([['filter', ['-sr']], ['translation', ['-sn']], ['tables', ['-s', 'Tables']], ['children', ['-s', 'Anchors']]]
    .map(([name, args]) => [name, pf(['-a', record.anchor, ...args])]));
}
function assertEmpty(contents) {
  for (const [name, value] of Object.entries(contents)) assert.equal(value.stdout.trim(), '', 'Owned policy content remained: ' + name);
}
async function readOwner() {
  const stat = await lstat(filename); assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.uid, uid);
  record = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(record.schemaVersion, 1); assert.equal(record.kind, 'macos-limited-broadcast-policy');
  assert.equal(record.candidateHead, candidateHead); assert.equal(record.uid, uid);
  assert.equal(record.runId, process.env.GITHUB_RUN_ID); assert.equal(record.runAttempt, process.env.GITHUB_RUN_ATTEMPT);
  assert.match(record.nonce, /^[0-9a-f]{32}$/u); assert.equal(record.anchor, 'com.apple/000000.mm-validation-' + record.nonce);
  if (record.helperSha256) assert.equal(hash(await readFile(helper)), record.helperSha256);
  else assert.deepEqual(record.interfaceCreationAttempts, [], 'Interface mutation requires its bound helper.');
  if (record.helperSourceSha256) assert.equal(hash(await readFile(source)), record.helperSourceSha256);
}
function subnetRange(text) {
  if (!/^\d+(?:\.\d+){0,3}(?:\/\d+)?$/u.test(text)) return null;
  const [address, mask] = text.split('/'), parts = address.split('.').map(Number), prefix = mask === undefined ? parts.length * 8 : Number(mask);
  if (parts.some(value => value > 255) || prefix < 1 || prefix > 32) return null;
  const value = Array.from({ length: 4 }, (_, index) => parts[index] ?? 0).reduce((sum, octet) => sum * 256 + octet, 0);
  const span = 2 ** (32 - prefix), first = Math.floor(value / span) * span; return [first, first + span - 1];
}
async function verifyPolicy(stage) {
  checkInterrupted();
  assert.equal(record.installed, true); assert.equal(record.cleanupCompleted, false);
  const observation = { stage, at: new Date().toISOString(), rootFilter: assertRootHook(), contents: anchorContents(),
    interfaceIndices: Object.fromEntries([record.interface, record.peer].map(name => [name, interfaceIndex(name)])),
    references: pf(['-s', 'References']), route: run('/sbin/route', ['-n', 'get', '255.255.255.255'], { allowFailure: true }) };
  (record.verifications ??= []).push(observation); await publish();
  assert.equal(observation.contents.filter.stdout, record.installedRules.stdout, 'The owned isolation policy changed.');
  for (const name of ['translation', 'tables', 'children']) assert.equal(observation.contents[name].stdout.trim(), '');
  assert.deepEqual(observation.interfaceIndices, record.interfaceIdentities, 'A private interface no longer has its captured kernel identity.');
  assert.match(observation.references.stdout, new RegExp('\\b' + record.enableToken + '\\b', 'u'));
}
async function verifyPackets(stage) {
  for (const port of [65001, 7359]) {
    checkInterrupted();
    const receiver = dgram.createSocket('udp4'), sender = dgram.createSocket('udp4');
    const nonce = randomBytes(48), reply = Buffer.concat([Buffer.from('actual UDP reply:'), nonce]);
    const sample = { stage, port, uid, pid: process.pid, nonceHex: nonce.toString('hex'), replyHex: reply.toString('hex'),
      startedAt: new Date().toISOString(), requestReceived: false, replyReceived: false, allSocketsClosed: false, receipts: [] };
    (record.packets ??= []).push(sample);
    const pending = Promise.withResolvers(); pending.promise.catch(() => {}); let timeout, problem;
    cancelSockets = pending.reject;
    const bind = socket => new Promise((resolve, reject) => {
      socket.once('error', reject); socket.bind(socket === receiver ? port : 0, '0.0.0.0', () => { socket.removeListener('error', reject); resolve(); });
    });
    for (const socket of [receiver, sender]) socket.on('error', pending.reject);
    receiver.on('message', (bytes, remote) => {
      sample.receipts.push({ role: 'receiver', hex: bytes.toString('hex'), remote });
      if (bytes.equals(nonce)) { sample.requestReceived = true; receiver.send(reply, remote.port, remote.address, error => { if (error) pending.reject(error); }); }
    });
    sender.on('message', (bytes, remote) => {
      sample.receipts.push({ role: 'sender', hex: bytes.toString('hex'), remote });
      if (bytes.equals(reply)) { sample.replyReceived = true; pending.resolve(); }
    });
    try {
      await bind(receiver); checkInterrupted(); await bind(sender); checkInterrupted(); sender.setBroadcast(true);
      sample.receiver = receiver.address(); sample.sender = sender.address();
      timeout = setTimeout(() => pending.reject(new Error('Actual limited-broadcast UDP reply did not arrive.')), 5000);
      sender.send(nonce, port, '255.255.255.255', error => { if (error) pending.reject(error); });
      await pending.promise; assert.equal(sample.requestReceived, true); assert.equal(sample.replyReceived, true);
    } catch (error) { problem = error; sample.error = failure(error); }
    finally {
      cancelSockets = undefined; clearTimeout(timeout);
      const closures = await Promise.allSettled([receiver, sender].map(socket => new Promise((resolve, reject) => {
        try { socket.close(resolve); } catch (error) { if (error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') resolve(); else reject(error); }
      })));
      sample.allSocketsClosed = closures.every(value => value.status === 'fulfilled'); sample.finishedAt = new Date().toISOString();
      const errors = closures.filter(value => value.status === 'rejected').map(value => value.reason);
      try { await publish(); } catch (error) { errors.push(error); }
      if (errors.length) problem = new AggregateError([...(problem ? [problem] : []), ...errors], 'The actual UDP precheck sockets did not close.');
    }
    if (problem) throw problem;
  }
}
async function assertProducersDrained() {
  const owners = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory() && /^network-context-(setup|strict)-/u.test(entry.name)) {
    const ownerFile = path.join(directory, entry.name, 'owner.json'), owner = JSON.parse(await readFile(ownerFile, 'utf8'));
    assert.equal(owner.head, candidateHead); assert.equal(owner.uid, uid);
    assert.ok(!owner.launchInvoked || owner.cleanupCompleted || owner.forcedCleanupReclaimed, 'A Terminal producer has no completed tree-drain receipt.');
    const processes = [owner.terminal, owner.workerIdentity, owner.childBirthReceipt?.identity, ...(owner.ownedProcesses ?? []), ...(owner.terminalDescendantsBeforeClose ?? [])].filter(Boolean);
    for (const value of processes) assert.ok(!sameProcessBirth(identity(value.pid), value), 'An owned producer remained alive before policy release.');
    owners.push({ path: ownerFile, cleanupCompleted: owner.cleanupCompleted, forcedCleanupReclaimed: owner.forcedCleanupReclaimed ?? false });
  }
  assert.ok(owners.some(owner => /network-context-setup-/u.test(owner.path)), 'The setup Terminal ownership receipt is required.');
  record.producerDrainReceipts = owners;
}
async function cleanup({ setupFailure = false } = {}) {
  const errors = [];
  const retain = async () => { try { await publish(); } catch (error) { errors.push(error); } };
  if (!setupFailure) await assertProducersDrained();
  else assert.ok((record.packets ?? []).every(sample => sample.allSocketsClosed), 'Setup sockets may still send.');
  record.producersDrained = true; await retain();
  if (record.anchorInstallationAttempted && !record.anchorRulesReleased) try {
    const contents = record.anchorBeforeRelease = anchorContents();
    for (const name of ['translation', 'tables', 'children']) assert.equal(contents[name].stdout.trim(), '', 'A foreign object appeared in the owned anchor.');
    const lines = contents.filter.stdout.trim().split('\n').filter(Boolean);
    assert.ok(lines.every(line => ['link', 'route', 'block'].some(suffix => line.includes('label "mm-policy-' + record.nonce + '-' + suffix + '"'))),
      'The nonce anchor contains a filter rule not bound to this owner.');
    pf(['-a', record.anchor, '-F', 'rules']); assertEmpty(record.anchorAfterRelease = anchorContents()); record.anchorRulesReleased = true; await retain();
  } catch (error) { errors.push(error); }
  for (const attempt of record.interfaceCreationAttempts) if (!attempt.boundInterfaceIndex) errors.push(new Error('An interface creation attempt has no bound kernel identity: ' + attempt.name));
  for (const name of [...record.createdInterfaces].reverse()) if (!record.destroyedInterfaces.includes(name)) try {
    const current = interfaceIndex(name);
    if (current) { assert.equal(current, record.interfaceIdentities[name], 'A private name now belongs to a foreign interface.'); sudo(['/sbin/ifconfig', name, 'destroy']); }
    assert.equal(interfaceIndex(name), 0); record.destroyedInterfaces.push(name); await retain();
  } catch (error) { errors.push(error); }
  if (record.enableToken && !record.tokenReleased && (!record.anchorInstallationAttempted || record.anchorRulesReleased)) try {
    record.referencesBeforeRelease = pf(['-s', 'References']);
    assert.match(record.referencesBeforeRelease.stdout, new RegExp('\\b' + record.enableToken + '\\b', 'u'));
    pf(['-X', record.enableToken]); record.tokenReleased = true;
    record.referencesAfterRelease = pf(['-s', 'References'], { allowFailure: true });
    assert.doesNotMatch(record.referencesAfterRelease.stdout, new RegExp('\\b' + record.enableToken + '\\b', 'u')); await retain();
  } catch (error) { errors.push(error); }
  if (record.enableMayHaveStarted && !record.enableToken) errors.push(new Error('PF enable may have committed without a recoverable owned token.'));
  try { record.after = snapshot('after-owned-cleanup'); } catch (error) { errors.push(error); }
  record.cleanupErrors = errors.map(failure); record.cleanupCompleted = errors.length === 0; record.cleanedAt = new Date().toISOString();
  try { await publish(); }
  catch (error) { errors.push(error); record.cleanupCompleted = false; record.cleanupErrors = errors.map(failure); }
  if (errors.length) throw new AggregateError(errors, 'Owned broadcast policy cleanup failed.');
}
async function setup() {
  await assert.rejects(lstat(filename), { code: 'ENOENT' });
  const nonce = randomBytes(16).toString('hex');
  record = { schemaVersion: 1, kind: 'macos-limited-broadcast-policy', candidateHead, uid, gid: process.getgid(), nonce,
    anchor: 'com.apple/000000.mm-validation-' + nonce, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    createdAt: new Date().toISOString(), operations: [], createdInterfaces: [], destroyedInterfaces: [], interfaceCreationAttempts: [],
    interfaceIdentities: {}, globalRouteMutations: [], verified: false, cleanupCompleted: false };
  await publish();
  try {
    record.before = snapshot('before-owned-resources'); assertRootHook();
    const anchors = pf(['-a', 'com.apple', '-s', 'Anchors']); assert.ok(!anchors.stdout.includes(path.basename(record.anchor)));
    const names = new Set(run('/sbin/ifconfig', ['-l']).stdout.trim().split(/\s+/u));
    const pair = Array.from({ length: 128 }, (_, index) => ['feth' + (600 + index * 2), 'feth' + (601 + index * 2)])
      .find(values => values.every(value => !names.has(value))); assert.ok(pair, 'An absent private feth pair is required.');
    const ranges = record.before.routes.stdout.split('\n').map(line => subnetRange(line.trim().split(/\s+/u)[0])).filter(Boolean);
    const subnet = Array.from({ length: 128 }, (_, index) => index + 64).find(index => {
      const wanted = subnetRange('198.19.' + index + '.0/30'); return ranges.every(value => wanted[1] < value[0] || wanted[0] > value[1]);
    }); assert.notEqual(subnet, undefined, 'An unused private /30 is required.');
    record.interface = pair[0]; record.peer = pair[1]; record.address = '198.19.' + subnet + '.1'; record.peerAddress = '198.19.' + subnet + '.2';
    record.compilation = run('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-O2', source, '-o', helper, '-lpcap']);
    record.helperSha256 = hash(await readFile(helper)); record.helperSourceSha256 = hash(await readFile(source)); await publish();
    for (const name of pair) {
      checkInterrupted(); assert.equal(interfaceIndex(name), 0);
      const attempt = { name, mutationMayHaveStarted: true }; record.interfaceCreationAttempts.push(attempt); await publish();
      sudo(['/sbin/ifconfig', name, 'create']); record.createdInterfaces.push(name);
      record.interfaceIdentities[name] = attempt.boundInterfaceIndex = interfaceIndex(name); assert.ok(attempt.boundInterfaceIndex > 0); await publish();
    }
    sudo(['/sbin/ifconfig', pair[0], 'peer', pair[1]]);
    sudo(['/sbin/ifconfig', pair[0], 'inet', record.address, 'netmask', '255.255.255.252', 'up']);
    sudo(['/sbin/ifconfig', pair[1], 'inet', record.peerAddress, 'netmask', '255.255.255.252', 'up']);
    const label = 'mm-policy-' + nonce;
    const rules = [
      `pass out quick on ${pair[0]} inet proto udp from any to 255.255.255.255 user ${uid} no state label "${label}-link"`,
      `pass out quick on ! ${pair[0]} route-to (${pair[0]} ${record.peerAddress}) inet proto udp from any to 255.255.255.255 user ${uid} no state label "${label}-route"`,
      `block drop out quick inet proto udp from any to 255.255.255.255 user ${uid} label "${label}-block"`,
    ].join('\n') + '\n';
    const rulesFile = path.join(directory, 'broadcast-policy.pf'); await writeFile(rulesFile, rules, { flag: 'wx', mode: 0o600 });
    record.rulesSha256 = hash(Buffer.from(rules)); pf(['-n', '-R', '-a', record.anchor, '-f', rulesFile]); checkInterrupted();
    record.enableMayHaveStarted = true; await publish(); const enabled = pf(['-E']);
    const token = /Token\s*:\s*(\d+)/iu.exec(enabled.stdout + '\n' + enabled.stderr); assert.ok(token, 'An exact owned PF-enable token is required.');
    record.enableToken = token[1]; await publish();
    record.anchorInstallationAttempted = true; await publish(); pf(['-R', '-a', record.anchor, '-f', rulesFile]); record.installed = true;
    record.installedRules = pf(['-a', record.anchor, '-sr']); await publish();
    await verifyPolicy('setup'); await verifyPackets('setup'); checkInterrupted(); record.verified = true; await publish(); checkInterrupted();
  } catch (error) {
    record.error = failure(error); const errors = [error];
    try { await publish(); } catch (publicationError) { errors.push(publicationError); }
    try { await cleanup({ setupFailure: true }); }
    catch (cleanupError) { errors.push(cleanupError); }
    throw errors.length === 1 ? error : new AggregateError(errors, 'Broadcast setup and owned-resource cleanup failed.');
  }
}
async function strict() {
  await readOwner(); assert.equal(record.verified, true); await verifyPolicy('before-strict'); await verifyPackets('before-strict'); checkInterrupted();
  let exit, spawnError;
  try {
    child = spawn(process.execPath, [path.join(repository, 'tools/ci/run.js')], { cwd: repository, env: process.env, stdio: 'inherit' });
    exit = await new Promise(resolve => {
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => resolve({ pid: child.pid ?? null, code, signal, error: spawnError ? failure(spawnError) : null }));
    });
    (record.strictExecutions ??= []).push({ ...exit, closedAt: new Date().toISOString() }); await publish();
  } finally { child = undefined; }
  await verifyPolicy('after-strict'); await verifyPackets('after-strict'); checkInterrupted();
  if (spawnError) throw spawnError;
  assert.equal(exit.signal, null, 'The actual strict child was terminated by a signal.'); process.exitCode = Number.isInteger(exit.code) ? exit.code : 2;
}
try {
  if (mode === 'setup') await setup();
  else if (mode === 'strict') await strict();
  else {
    try { await readOwner(); }
    catch (error) { if (error.code === 'ENOENT' && !(await readdir(directory)).includes(path.basename(filename))) process.exit(0); throw error; }
    try { await cleanup(); }
    catch (error) { record.cleanupError = failure(error); await publish(); throw error; }
  }
} finally { for (const [signal, handler] of handlers) process.removeListener(signal, handler); }
