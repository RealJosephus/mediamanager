import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { command, failure, hash, identity, maybeJson, runPolicyTerminal, sameIdentity, save, terminalProgram } from './macos-broadcast-policy-terminal.js';
import { policyPackets, verifyPolicyPacketEvidence } from './macos-broadcast-policy-packets.js';

// Separate pre-release experiment. The formal CI network path is unchanged.
// No root ruleset reload, global state flush, global-route write or foreign
// token/interface removal is available through this coordinator.
assert.equal(process.platform, 'darwin'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.argv.length, 2); assert.notEqual(process.getuid(), 0);
const ownFile = fileURLToPath(import.meta.url), repository = await realpath(path.resolve(path.dirname(ownFile), '../..'));
assert.equal(await realpath(process.cwd()), repository);
const requestedRoot = path.resolve(process.env.MEDIAMANAGER_POLICY_PROOF_ROOT ?? '');
const temporaryRoot = await realpath(process.env.RUNNER_TEMP);
assert.equal(await realpath(path.dirname(requestedRoot)), temporaryRoot);
const root = path.join(temporaryRoot, path.basename(requestedRoot));
assert.match(path.basename(root), /^mediamanager-policy-proof-\d+-\d+$/u);
await mkdir(root, { mode: 0o700 });
const uid = process.getuid(), gid = process.getgid(), nonce = randomBytes(16).toString('hex');
const head = command('/usr/bin/git', ['rev-parse', 'HEAD']).trim(), tree = command('/usr/bin/git', ['rev-parse', 'HEAD^{tree}']).trim();
assert.equal(command('/usr/bin/git', ['status', '--porcelain=v1']), '');
const anchor = 'com.apple/000000.mm-proof-' + nonce;
const record = { schemaVersion: 1, kind: 'separate-macos-pf-broadcast-proof', head, tree, nonce, uid, gid, anchor,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, operations: [], createdInterfaces: [],
  interfaceIdentities: {}, interfaceCreationAttempts: [], destroyedInterfaces: [], tokenReleased: false, cleanupCompleted: false,
  formalPathChanged: false, globalRouteMutations: [], fullAcceptance: false, phaseAcceptance: false, releaseAcceptance: false,
  longRunDriftFixed: false, nativeDiscoveryExecuted: false, startedAt: new Date().toISOString() };
const reportFile = path.join(root, 'proof.json');
const publish = async () => {
  await writeFile(reportFile + '.pending', JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  await rename(reportFile + '.pending', reportFile);
};
function run(file, args, { allowFailure = false } = {}) {
  const operation = { file, args, startedAt: new Date().toISOString() }; record.operations.push(operation);
  const result = spawnSync(file, args, { cwd: repository, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
  Object.assign(operation, { pid: result.pid, code: result.status, signal: result.signal, stdout: result.stdout ?? '',
    stderr: result.stderr ?? '', error: result.error ? failure(result.error) : null, finishedAt: new Date().toISOString() });
  if (!allowFailure) assert.ok(result.status === 0 && result.signal === null && !result.error, JSON.stringify(operation));
  return operation;
}
const sudo = args => run('/usr/bin/sudo', ['-n', ...args]);
const pf = (args, options) => run('/usr/bin/sudo', ['-n', '/sbin/pfctl', ...args], options);
const abort = new AbortController();
const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => abort.abort(new Error('Policy proof interrupted by ' + signal))]));
for (const [signal, handler] of handlers) process.on(signal, handler);
const helper = path.join(root, 'read-only-capture'), captureFile = path.join(root, 'original-packets.pcap');
const helperSource = path.join(repository, 'tools/ci/macos-broadcast-policy-capture.c');
let capture, captureClosed, captureIdentity, token, installed = false, scope, worker, problem;
const interfaceIndex = name => JSON.parse(run(helper, ['interface-index', name]).stdout).interfaceIndex;
function subnetRange(text) {
  if (!/^\d+(?:\.\d+){0,3}(?:\/\d+)?$/u.test(text)) return null;
  const [address, mask] = text.split('/'), parts = address.split('.').map(Number), prefix = mask === undefined ? parts.length * 8 : Number(mask);
  if (parts.some(value => value < 0 || value > 255) || prefix < 1 || prefix > 32) return null;
  const value = Array.from({ length: 4 }, (_, index) => parts[index] ?? 0).reduce((sum, part) => sum * 256 + part, 0);
  const span = 2 ** (32 - prefix), first = Math.floor(value / span) * span; return [first, first + span - 1];
}
function snapshot(label) {
  return { label, at: new Date().toISOString(), route: run('/sbin/route', ['-n', 'get', '255.255.255.255'], { allowFailure: true }),
    routes: run('/usr/sbin/netstat', ['-rn', '-f', 'inet']), interfaces: run('/sbin/ifconfig', ['-a']),
    rootFilter: pf(['-sr']), rootTranslation: pf(['-sn']), anchors: pf(['-s', 'Anchors']),
    references: pf(['-s', 'References'], { allowFailure: true }), info: pf(['-si']), states: pf(['-ss']) };
}
function observeOwnedAnchor(label) {
  const observation = { label, at: new Date().toISOString(),
    filter: pf(['-a', anchor, '-sr'], { allowFailure: true }),
    translation: pf(['-a', anchor, '-sn'], { allowFailure: true }),
    tables: pf(['-a', anchor, '-s', 'Tables'], { allowFailure: true }),
    children: pf(['-a', anchor, '-s', 'Anchors'], { allowFailure: true }),
    all: pf(['-a', anchor, '-s', 'all'], { allowFailure: true }) };
  observation.allReadsSucceeded = ['filter', 'translation', 'tables', 'children', 'all'].every(key =>
    observation[key].code === 0 && observation[key].signal === null && !observation[key].error);
  return observation;
}
function assertOwnedPolicyEmpty(observation) {
  for (const category of ['filter', 'translation', 'tables', 'children']) {
    const read = observation[category];
    assert.equal(read.code, 0, 'Owned policy release must be observable: ' + category);
    assert.equal(read.signal, null); assert.equal(read.error, null);
    assert.equal(read.stdout.trim(), '', 'Owned policy content remained: ' + category);
  }
}
function observeGlobalRoute(label) {
  const names = [record.interface, record.peer];
  const indicesBefore = Object.fromEntries(names.map(name => [name, interfaceIndex(name)]));
  const route = run('/sbin/route', ['-n', 'get', '255.255.255.255'], { allowFailure: true });
  const indicesAfter = Object.fromEntries(names.map(name => [name, interfaceIndex(name)]));
  return { label, at: new Date().toISOString(), route, ownedKernelIndices: record.interfaceIdentities,
    indicesBefore, indicesAfter, selectedInterface: /^\s*interface:\s*(\S+)/mu.exec(route.stdout)?.[1] ?? null,
    globalRouteMutationRequested: false };
}
async function stopCapture() {
  if (!capture) return;
  if (!captureClosed) capture.stdin.end();
  const deadline = Date.now() + 5000;
  while (!captureClosed && Date.now() < deadline) await delay(50);
  if (!captureClosed) {
    record.captureForcedTermination = true;
    assert.ok(captureIdentity && sameIdentity(identity(captureIdentity.pid), captureIdentity), 'The live capture has no bound owner identity.');
    sudo(['/bin/kill', '-TERM', String(captureIdentity.pid)]);
    const forcedDeadline = Date.now() + 3000;
    while (!captureClosed && Date.now() < forcedDeadline) await delay(50);
  }
  assert.ok(captureClosed, 'The owned packet capture did not close.');
  record.captureExit = captureClosed;
  assert.ok(!captureIdentity || !sameIdentity(identity(captureIdentity.pid), captureIdentity), 'The packet capture process remained alive.');
  assert.equal(captureClosed.code, 0); assert.equal(captureClosed.signal, null); assert.ok(!record.captureForcedTermination);
}
try {
  record.sources = [];
  for (const relative of ['tools/ci/macos-broadcast-policy-proof.js', 'tools/ci/macos-broadcast-policy-terminal.js',
    'tools/ci/macos-broadcast-policy-worker.js', 'tools/ci/macos-broadcast-policy-packets.js',
    'tools/ci/macos-broadcast-policy-capture.c', '.github/workflows/macos-broadcast-policy-proof.yml']) {
    const bytes = await readFile(path.join(repository, relative)); record.sources.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  record.platform = { uname: run('/usr/bin/uname', ['-a']), node: process.version, compiler: run('/usr/bin/clang', ['--version']) };
  // Retain the actual hosted grammar/documentation and policy before mutation.
  record.manuals = [run('/usr/bin/man', ['-P', '/bin/cat', '5', 'pf.conf'], { allowFailure: true }),
    run('/usr/bin/man', ['-P', '/bin/cat', '8', 'pfctl'], { allowFailure: true })];
  record.before = snapshot('before-owned-resources');
  const rootRules = record.before.rootFilter.stdout.trim().split('\n').map(value => value.trim()).filter(Boolean);
  const filterRules = rootRules.filter(value => !value.startsWith('scrub-anchor '));
  assert.deepEqual(filterRules, ['anchor "com.apple/*" all'], 'The proof needs the existing unrestricted Apple filter child-anchor entry and never rewrites a foreign root ruleset.');
  assert.ok(!record.before.anchors.stdout.includes(anchor));
  const names = new Set(run('/sbin/ifconfig', ['-l']).stdout.trim().split(/\s+/u));
  const pair = Array.from({ length: 128 }, (_, index) => ['feth' + (600 + index * 2), 'feth' + (601 + index * 2)])
    .find(values => values.every(value => !names.has(value)));
  assert.ok(pair, 'An absent owned interface pair is required.');
  const ranges = record.before.routes.stdout.split('\n').map(line => subnetRange(line.trim().split(/\s+/u)[0])).filter(Boolean);
  const subnet = Array.from({ length: 128 }, (_, index) => index + 64).find(index => {
    const wanted = subnetRange('198.19.' + index + '.0/30'); return ranges.every(value => wanted[1] < value[0] || wanted[0] > value[1]);
  });
  assert.notEqual(subnet, undefined);
  record.interface = pair[0]; record.peer = pair[1]; record.address = '198.19.' + subnet + '.1'; record.peerAddress = '198.19.' + subnet + '.2';
  record.compilation = run('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-O2', helperSource, '-o', helper, '-lpcap']);
  record.helperSha256 = hash(await readFile(helper)); record.helperSourceSha256 = hash(await readFile(helperSource));
  for (const name of pair) {
    abort.signal.throwIfAborted();
    assert.equal(interfaceIndex(name), 0, 'The selected name was claimed before interface creation.');
    const attempt = { name, mutationMayHaveStarted: true }; record.interfaceCreationAttempts.push(attempt); await publish();
    sudo(['/sbin/ifconfig', name, 'create']); record.createdInterfaces.push(name);
    record.interfaceIdentities[name] = interfaceIndex(name); assert.ok(record.interfaceIdentities[name] > 0); await publish();
    attempt.boundInterfaceIndex = record.interfaceIdentities[name]; await publish();
  }
  sudo(['/sbin/ifconfig', pair[0], 'peer', pair[1]]);
  sudo(['/sbin/ifconfig', pair[0], 'inet', record.address, 'netmask', '255.255.255.252', 'up']);
  sudo(['/sbin/ifconfig', pair[1], 'inet', record.peerAddress, 'netmask', '255.255.255.252', 'up']);
  record.afterInterfaceSetupRoute = observeGlobalRoute('after-owned-interface-setup-before-PF');
  const label = 'mm-policy-' + nonce, rules = [
    `pass out quick on ${pair[0]} inet proto udp from any to 255.255.255.255 user ${uid} no state label "${label}-link"`,
    `pass out quick on ! ${pair[0]} route-to (${pair[0]} ${record.peerAddress}) inet proto udp from any to 255.255.255.255 user ${uid} no state label "${label}-route"`,
    `block drop out quick inet proto udp from any to 255.255.255.255 user ${uid} label "${label}-block"`,
  ].join('\n') + '\n';
  const rulesFile = path.join(root, 'owned-anchor.pf'); await writeFile(rulesFile, rules, { flag: 'wx', mode: 0o600 });
  record.ruleFileSha256 = hash(Buffer.from(rules));
  // The actual hosted pfctl(8) manual defines -R as filter-only loading.
  // This owner has no translation, table, option or queue rules to install.
  pf(['-n', '-R', '-a', anchor, '-f', rulesFile]);
  abort.signal.throwIfAborted();
  const enabled = pf(['-E']); record.enableOperation = enabled;
  const matched = /Token\s*:\s*(\d+)/iu.exec(enabled.stdout + '\n' + enabled.stderr); assert.ok(matched, 'The exact owned PF-enable token is required.');
  token = record.enableToken = matched[1]; await publish();
  // Persist the unique-anchor intent before asking PF to commit its transaction.
  record.anchorInstallationAttempted = true; await publish();
  pf(['-R', '-a', anchor, '-f', rulesFile]); installed = true;
  record.installedRules = pf(['-a', anchor, '-sr']); await publish(); record.referencesWithToken = pf(['-s', 'References']);
  record.installedAnchorCategories = observeOwnedAnchor('after-filter-only-install');
  assert.match(record.referencesWithToken.stdout, new RegExp('\\b' + token + '\\b', 'u'));
  record.rootFilterAfterInstall = pf(['-sr']); assert.equal(record.rootFilterAfterInstall.stdout, record.before.rootFilter.stdout);
  record.skipInterfaces = pf(['-v', '-s', 'Interfaces']);
  const scopeFile = path.join(root, 'scope.json');
  scope = { schemaVersion: 1, head, tree, nonce, uid, gid, repository, interface: pair[0], peer: pair[1],
    interfaceIndex: record.interfaceIdentities[pair[0]], broadcastPorts: [65001, 7359],
    nodeExecutable: await realpath(process.execPath), nodeSha256: hash(await readFile(process.execPath)),
    workerFile: path.join(repository, 'tools/ci/macos-broadcast-policy-worker.js'),
    workerSha256: record.sources.find(entry => entry.path.endsWith('policy-worker.js')).sha256,
    terminalHelperSha256: record.sources.find(entry => entry.path.endsWith('policy-terminal.js')).sha256,
    terminalSha256: hash(await readFile(terminalProgram)), launchFloorEpochMs: Math.floor(Date.now() / 1000) * 1000,
    startedFile: path.join(root, 'worker-started.json'), admissionFile: path.join(root, 'worker-admitted.json'),
    aliveFile: path.join(root, 'worker-alive.json'), targetDestroyedFile: path.join(root, 'target-destroyed.json'),
    exitFile: path.join(root, 'worker-exit.json'), stdoutFile: path.join(root, 'worker-stdout.txt'), stderrFile: path.join(root, 'worker-stderr.txt'),
    actualCloseFile: path.join(root, 'worker-actual-close.json'),
    terminalRecordFile: path.join(root, 'terminal-owner.json') };
  await save(scopeFile, scope); record.scopeSha256 = hash(await readFile(scopeFile));
  assert.equal(hash(await readFile(helper)), record.helperSha256);
  capture = spawn('/usr/bin/sudo', ['-n', helper, 'capture', captureFile, String(uid), String(gid)],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' } });
  record.captureCommand = { file: '/usr/bin/sudo', args: ['-n', helper, 'capture', captureFile, String(uid), String(gid)] };
  let captureOut = '', captureErr = '';
  capture.stdout.on('data', bytes => { captureOut += bytes.toString(); }); capture.stderr.on('data', bytes => { captureErr += bytes.toString(); });
  capture.stdin.on('error', error => { record.captureStdinError = failure(error); });
  capture.once('error', error => { record.captureSpawnError = failure(error); });
  capture.once('close', (code, signal) => { captureClosed = { code, signal, at: new Date().toISOString() }; });
  record.captureOutput = () => ({ stdout: captureOut, stderr: captureErr });
  const readyDeadline = Date.now() + 15000;
  while (!captureOut.includes('\n')) {
    abort.signal.throwIfAborted(); assert.ok(!captureClosed && Date.now() < readyDeadline, 'The real capture never became ready.'); await delay(50);
  }
  const ready = JSON.parse(captureOut.split('\n')[0]); assert.equal(ready.capturing, true); assert.equal(ready.uid, 0);
  assert.equal(ready.datalink, ready.pktapDatalink, 'The live capture must retain SDK PKTAP interface metadata before any proof packet is sent.');
  captureIdentity = identity(ready.pid); assert.ok(captureIdentity && captureIdentity.uid === 0 && captureIdentity.executable === helper);
  let ancestor = captureIdentity; const ancestry = [];
  while (ancestor && ancestor.pid !== process.pid && ancestry.length < 8) { ancestry.push(ancestor); ancestor = identity(ancestor.parentPid); }
  assert.equal(ancestor?.pid, process.pid); record.captureIdentity = captureIdentity; record.captureAncestry = ancestry;
  record.terminalAttempted = true; await publish();
  worker = await runPolicyTerminal(scope, scopeFile, async alive => {
    abort.signal.throwIfAborted(); assert.equal(alive.allSocketsClosed, true);
    record.aliveRules = pf(['-a', anchor, '-vvsr']); record.aliveStates = pf(['-ss']);
    record.aliveGlobalRoute = observeGlobalRoute('after-actual-alive-packets-before-target-removal');
    for (const observation of [record.afterInterfaceSetupRoute, record.aliveGlobalRoute]) {
      assert.deepEqual(observation.indicesBefore, record.interfaceIdentities);
      assert.deepEqual(observation.indicesAfter, record.interfaceIdentities);
      assert.equal(observation.route.code, 0);
      assert.ok(observation.selectedInterface && !pair.includes(observation.selectedInterface),
        'Private capture paths cannot prove PF redirection if the global broadcast route itself selected an owned interface.');
    }
    assert.equal(interfaceIndex(pair[0]), record.interfaceIdentities[pair[0]]);
    sudo(['/sbin/ifconfig', pair[0], 'destroy']); record.destroyedInterfaces.push(pair[0]);
    assert.equal(interfaceIndex(pair[0]), 0); record.rulesAfterTargetRemoval = pf(['-a', anchor, '-sr']);
    await publish(); await save(scope.targetDestroyedFile, { nonce, head, removedInterface: pair[0],
      formerIndex: record.interfaceIdentities[pair[0]], at: new Date().toISOString() });
  }, abort.signal);
  await stopCapture();
  const lines = captureOut.trim().split('\n').map(line => JSON.parse(line)); record.captureReceipts = lines;
  const stopped = lines.at(-1); assert.equal(stopped.capturing, false); assert.equal(stopped.eofRequested, true);
  assert.equal(stopped.dropped, 0); assert.equal(stopped.interfaceDropped, 0); assert.equal(stopped.captureErrno, 0); assert.equal(stopped.statsError, 0);
  assert.equal(stopped.byteLimitReached, false); assert.equal(stopped.durationLimitReached, false);
  const packetBytes = await readFile(captureFile); assert.equal(packetBytes.length, stopped.bytes);
  const captured = policyPackets(packetBytes, ready.pktapDatalink); assert.equal(captured.records.length, stopped.packets);
  record.packetVerification = verifyPolicyPacketEvidence(captured, worker, scope);
  await save(path.join(root, 'decoded-packets.json'), captured);
  record.statesAfterActualPackets = pf(['-ss']); record.proofFunctionsPassed = true;
} catch (error) { problem = error; record.error = failure(error); }
finally {
  const errors = [];
  try { await stopCapture(); } catch (error) { errors.push(error); }
  if (capture) {
    const output = record.captureOutput?.(); delete record.captureOutput;
    if (output) { await writeFile(path.join(root, 'capture-stdout.txt'), output.stdout, { flag: 'wx', mode: 0o600 }); await writeFile(path.join(root, 'capture-stderr.txt'), output.stderr, { flag: 'wx', mode: 0o600 }); }
  }
  try { record.beforeCleanup = snapshot('after-producers-before-owned-cleanup'); } catch (error) { errors.push(error); }
  let producersDrained = !record.terminalAttempted;
  if (record.terminalAttempted) try {
    const terminal = await maybeJson(scope.terminalRecordFile); record.terminalCleanupReceipt = terminal;
    assert.equal(terminal?.cleanupCompleted, true, 'Policy release requires the real producer tree to have drained.');
    assert.ok(!terminal.worker || !sameIdentity(identity(terminal.worker.pid), terminal.worker));
    assert.ok(!terminal.terminal || !sameIdentity(identity(terminal.terminal.pid), terminal.terminal));
    producersDrained = true;
  } catch (error) { errors.push(error); }
  record.producersDrained = producersDrained;
  if (!producersDrained) errors.push(new Error('Owned policy and interfaces are retained because a producer may still send.'));
  if (producersDrained && record.anchorInstallationAttempted) try {
    const current = pf(['-a', anchor, '-sr']);
    record.anchorBeforeReleaseCategories = observeOwnedAnchor('before-owned-filter-release');
    // Removing our target can change pfctl's interface rendering. Ownership
    // follows this initially absent nonce child and its own rule labels.
    assert.ok(current.stdout.trim() === '' || current.stdout.trim().split('\n').every(line =>
      ['link', 'route', 'block'].some(suffix => line.includes('label "mm-policy-' + nonce + '-' + suffix + '"'))),
    'The nonce anchor contains a rule that is not bound to this owner.');
    pf(['-a', anchor, '-F', 'rules']); record.anchorRulesReleased = true;
    record.anchorAfterRelease = pf(['-a', anchor, '-sr'], { allowFailure: true });
    if (record.anchorAfterRelease.code === 0) assert.equal(record.anchorAfterRelease.stdout.trim(), '');
    record.anchorAfterReleaseCategories = observeOwnedAnchor('after-owned-filter-release');
    assertOwnedPolicyEmpty(record.anchorAfterReleaseCategories);
    record.childAnchorsAfterRelease = pf(['-a', 'com.apple', '-s', 'Anchors']);
  } catch (error) { errors.push(error); }
  for (const attempt of record.interfaceCreationAttempts) if (!attempt.boundInterfaceIndex) {
    errors.push(new Error('An attempted interface creation has no bound kernel identity: ' + attempt.name));
  }
  for (const name of [...record.createdInterfaces].reverse()) if (producersDrained && !record.destroyedInterfaces.includes(name)) try {
    assert.equal(hash(await readFile(helper)), record.helperSha256);
    assert.equal(interfaceIndex(name), record.interfaceIdentities[name], 'A feth name no longer refers to the kernel interface created by this proof.');
    sudo(['/sbin/ifconfig', name, 'destroy']); record.destroyedInterfaces.push(name); assert.equal(interfaceIndex(name), 0);
  } catch (error) { errors.push(error); }
  if (producersDrained && token) try {
    record.referencesBeforeRelease = pf(['-s', 'References']);
    assert.match(record.referencesBeforeRelease.stdout, new RegExp('\\b' + token + '\\b', 'u'));
    pf(['-X', token]); record.tokenReleased = true;
    record.referencesAfterRelease = pf(['-s', 'References'], { allowFailure: true });
    assert.doesNotMatch(record.referencesAfterRelease.stdout, new RegExp('\\b' + token + '\\b', 'u'));
  } catch (error) { errors.push(error); }
  if (record.anchorInstallationAttempted) try {
    record.anchorAfterAllResourcesReleasedCategories = observeOwnedAnchor('after-all-owned-release-attempts');
    assertOwnedPolicyEmpty(record.anchorAfterAllResourcesReleasedCategories);
    record.childAnchorsAfterAllResourcesReleased = pf(['-a', 'com.apple', '-s', 'Anchors'], { allowFailure: true });
    record.emptyAnchorNameRetained = record.childAnchorsAfterAllResourcesReleased.stdout.includes(path.basename(anchor));
  } catch (error) { errors.push(error); }
  try {
    record.after = snapshot('after-owned-cleanup');
    assert.equal(record.after.rootFilter.stdout, record.before.rootFilter.stdout);
    assert.equal(record.after.rootTranslation.stdout, record.before.rootTranslation.stdout);
    assert.deepEqual([...record.destroyedInterfaces].sort(), [...record.createdInterfaces].sort());
    record.foreignGlobalRouteNeverReplayed = true;
    record.foreignRouteObservationsAreNotAnExpiryRestorationClaim = true;
    assert.equal(command('/usr/bin/git', ['status', '--porcelain=v1']), '');
    for (const source of record.sources) assert.equal(hash(await readFile(path.join(repository, source.path))), source.sha256);
  } catch (error) { errors.push(error); }
  record.cleanupErrors = errors.map(failure); record.cleanupCompleted = errors.length === 0;
  record.passed = Boolean(record.proofFunctionsPassed && !problem && !errors.length && installed && record.anchorRulesReleased && record.tokenReleased);
  record.finishedAt = new Date().toISOString(); await publish();
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  if (errors.length) problem = new AggregateError([...(problem ? [problem] : []), ...errors], 'Owned PF proof cleanup failed.');
}
if (problem) throw problem;
assert.equal(record.passed, true, 'The independent PF proof is incomplete.');
process.stdout.write(JSON.stringify({ proof: reportFile, passed: record.passed, fullAcceptance: false, releaseAcceptance: false }) + '\n');
