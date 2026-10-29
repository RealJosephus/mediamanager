import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { darwinProcessInspector, sameProcessBirth, sameProcessIdentity as sameIdentity } from './macos-process-identity.js';
import { signalProcess } from './macos-process-signal.js';

// TN3179 explicitly permits command-line tools run from Terminal, including
// children. Observe that actual ancestry and UID; open(1) returning zero alone
// proves neither execution nor permission. Ordinary-UID 255 nonce/reply and
// actual native discovery remain mandatory. PF owns only the private broadcast
// path; business processes retain the ordinary UID and actual Terminal ancestry.
// https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
// https://support.apple.com/guide/terminal/execute-commands-and-run-tools-apdb66b5242-0d18-49fc-9c47-a2498b7c91d5/mac
assert.equal(process.platform, 'darwin');
const inspector = await darwinProcessInspector(), processIdentity = inspector.identity;
const thisFile = fileURLToPath(import.meta.url), repository = path.resolve(path.dirname(thisFile), '../..');
const terminalBundle = '/System/Applications/Utilities/Terminal.app', terminalProgram = terminalBundle + '/Contents/MacOS/Terminal';
const sha = value => createHash('sha256').update(value).digest('hex');
const save = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const failureRecord = error => ({ name: error.name, message: error.message, code: error.code, status: error.status, stack: error.stack,
  errors: error.errors?.map(failureRecord) });
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 15000,
  env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
const operations = {
  setup: [path.join(repository, 'tools/ci/macos-broadcast.js'), 'setup'],
  strict: [path.join(repository, 'tools/ci/macos-broadcast.js'), 'strict'],
};
function terminalPids() {
  return inspector.namedProcesses('Terminal', process.getuid()).map(value => value.pid);
}
async function readJson(filename) {
  try { const text = await readFile(filename, 'utf8'); try { return JSON.parse(text); } catch { return null; } }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function descriptor(filename) {
  const value = await readJson(filename); if (!value) throw new Error('The private Terminal descriptor could not be decoded.'); return value;
}

async function terminalWorker(filename) {
  const owner = await descriptor(filename);
  assert.equal(owner.environment.GITHUB_ACTIONS, 'true'); assert.ok(Object.hasOwn(operations, owner.operation));
  assert.deepEqual(owner.arguments, operations[owner.operation]);
  assert.equal(process.getuid(), owner.uid); assert.notEqual(process.getuid(), 0, 'Business execution must retain the ordinary runner UID.');
  assert.equal(process.getgid(), owner.gid); assert.equal(await realpath(process.cwd()), owner.workingDirectory);
  assert.equal(await realpath(process.execPath), owner.nodeExecutable);
  const head = command('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD']).trim(); assert.equal(head, owner.head);
  const ancestors = []; let parentPid = process.ppid;
  for (let index = 0; index < 12 && parentPid > 1; index++) {
    const value = processIdentity(parentPid); if (!value) break; ancestors.push(value); parentPid = value.parentPid;
  }
  const terminal = ancestors.find(value => path.basename(value.executable) === 'Terminal');
  assert.ok(terminal, 'The fixed command has no actual Terminal.app ancestor.'); assert.equal(terminal.uid, owner.uid);
  assert.equal(await realpath(terminal.executable), await realpath(terminalProgram));
  assert.equal(sha(await readFile(terminalProgram)), owner.terminalProgramSha256);
  const nodeSha256 = sha(await readFile(process.execPath)); assert.equal(nodeSha256, owner.nodeSha256);
  // Replace only real application/session metadata. Configuration, tools,
  // selection and credentials retain original values in the private descriptor.
  const contextKeys = ['__CFBundleIdentifier', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'TERM', 'XPC_SERVICE_NAME', 'SSH_CLIENT', 'SSH_CONNECTION'];
  const environment = { ...owner.environment };
  for (const key of contextKeys) { delete environment[key]; if (process.env[key] !== undefined) environment[key] = process.env[key]; }
  let child, childIdentity, interrupted, interruptionFailure;
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
    interrupted = signal;
    if (childIdentity) try { signalProcess(inspector, childIdentity, signal === 'SIGHUP' ? 'SIGTERM' : signal); }
    catch (reason) { interruptionFailure = reason; }
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const started = { schemaVersion: 3, context: 'actual-terminal-session', operation: owner.operation,
    pid: process.pid, identity: processIdentity(process.pid), parentPid: process.ppid, uid: process.getuid(), gid: process.getgid(), head, ancestors, terminal,
    workingDirectory: process.cwd(), nodeExecutable: await realpath(process.execPath), nodeSha256,
    environmentKeyCount: Object.keys(environment).length, actualContextKeys: contextKeys.filter(key => process.env[key] !== undefined),
    environmentWrittenToArtifact: false, startedAt: new Date().toISOString(), awaitingOwnerAdmission: true };
  try {
    await save(owner.startedFile, started); let result;
    try {
      const deadline = Date.now() + 15000; let admitted;
      while (!(admitted = await readJson(owner.admissionFile))) {
        if (interrupted) throw new Error('Terminal worker interrupted before child admission.');
        if (Date.now() >= deadline) throw new Error('The owner did not verify the actual Terminal/worker identities.');
        await delay(100);
      }
      assert.equal(admitted.workerPid, process.pid); assert.equal(admitted.head, head);
      assert.ok(sameIdentity(admitted.terminal, terminal));
      if (interrupted) throw new Error('Terminal worker interrupted before child admission.');
      child = spawn(owner.nodeExecutable, owner.arguments, { cwd: owner.workingDirectory, env: environment, stdio: ['ignore', 'inherit', 'inherit'] });
      let spawnError, childBirth = Promise.resolve();
      result = await new Promise(resolve => {
        child.once('spawn', () => {
          childBirth = (async () => {
            const identity = processIdentity(child.pid); assert.ok(identity, 'The actual child has no process identity.');
            childIdentity = identity;
            assert.equal(identity.parentPid, process.pid); assert.equal(identity.uid, owner.uid);
            assert.equal(identity.parentUniqueId, started.identity.uniqueId);
            if (interrupted) signalProcess(inspector, identity, interrupted === 'SIGHUP' ? 'SIGTERM' : interrupted);
            assert.equal(await realpath(identity.executable), owner.nodeExecutable);
            await save(owner.childStartedFile + '.pending', { identity, worker: started.identity, head, nodeSha256, observedAt: new Date().toISOString() });
            await rename(owner.childStartedFile + '.pending', owner.childStartedFile);
          })();
          childBirth.catch(() => {}); // Await after the actual child close, even if evidence I/O fails first.
        });
        child.once('error', error => { spawnError = failureRecord(error); });
        child.once('close', (code, signal) => resolve({ code, signal, childPid: child.pid ?? null, error: spawnError }));
      });
      await childBirth;
      if (interruptionFailure) throw interruptionFailure;
    } catch (error) { result = { code: 2, signal: null, childPid: child?.pid ?? null, actualChildExit: result ?? null, error: failureRecord(error) }; }
    await save(owner.exitFile, { ...started, ...result, awaitingOwnerAdmission: false, interrupted: interrupted ?? null,
      finishedAt: new Date().toISOString(), phaseAcceptance: false, releaseAcceptance: false });
    return interrupted ? 2 : Number.isInteger(result.code) ? result.code : 2;
  } finally { for (const [signal, handler] of handlers) process.removeListener(signal, handler); }
}

if (process.argv[2] === '--terminal') {
  assert.equal(process.argv.length, 4);
  terminalWorker(process.argv[3]).then(code => { process.exitCode = code; }).catch(async error => {
    process.stderr.write(error.stack + '\n'); process.exitCode = 2;
    try { const owner = await descriptor(process.argv[3]); await save(owner.exitFile, { startupFailed: true, code: 2, signal: null,
      pid: process.pid, identity: processIdentity(process.pid), uid: process.getuid(), gid: process.getgid(), error: failureRecord(error), phaseAcceptance: false, releaseAcceptance: false }); }
    catch { /* Missing receipts remain a hard owner failure. */ }
  });
} else {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.argv.length, 3);
  const operation = process.argv[2]; assert.ok(Object.hasOwn(operations, operation)); assert.notEqual(process.getuid(), 0);
  const outputRoot = process.env.MEDIAMANAGER_VALIDATION_OUTPUT_ROOT, temporaryRoot = process.env.RUNNER_TEMP;
  assert.ok(path.isAbsolute(outputRoot ?? '') && path.isAbsolute(temporaryRoot ?? ''));
  const workingDirectory = await realpath(process.cwd()), nodeExecutable = await realpath(process.execPath); assert.equal(workingDirectory, await realpath(repository));
  const uid = process.getuid(), gid = process.getgid(), head = command('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD']).trim();
  const evidence = path.join(outputRoot, 'provisioning', 'network-context-' + operation + '-' + randomUUID()); await mkdir(evidence, { recursive: true });
  const startedFile = path.join(evidence, 'started.json'), childStartedFile = path.join(evidence, 'child-started.json'), exitFile = path.join(evidence, 'exit.json');
  const stdoutFile = path.join(evidence, 'stdout.txt'), stderrFile = path.join(evidence, 'stderr.txt'), recordFile = path.join(evidence, 'owner.json');
  const record = { schemaVersion: 3, context: 'actual-terminal-session', operation, uid, gid, head, workingDirectory, nodeExecutable,
    nodeSha256: sha(await readFile(nodeExecutable)), wrapperSha256: sha(await readFile(thisFile)), arguments: operations[operation],
    environmentWrittenToArtifact: false, originalEnvironmentPreservedExceptActualSessionContext: true,
    createdAt: new Date().toISOString(), phaseAcceptance: false, releaseAcceptance: false };
  const routeObservation = record.routeObservation = { schemaVersion: 1, diagnosticOnly: true, candidateHead: head,
    coverage: 'Read-only boundary snapshots; ordinary-UID broadcast isolation uses an owned PF filter child-anchor and never writes the global route.',
    snapshots: [], errors: [] };
  const publish = async () => { await writeFile(recordFile + '.pending', JSON.stringify(record, null, 2) + '\n', { mode: 0o600 }); await rename(recordFile + '.pending', recordFile); };
  let privateDirectory, descriptorFile, commandFile, admissionFile, interrupted, failure, completed, stdoutOffset = 0, stderrOffset = 0, ownedTreeReleased = false;
  const ownedProcesses = new Map();
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => { interrupted = signal; }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  async function forward() {
    for (const [filename, target, offset] of [[stdoutFile, process.stdout, stdoutOffset], [stderrFile, process.stderr, stderrOffset]]) {
      let file; try { file = await open(filename, 'r'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      let position = offset;
      try {
        const size = (await file.stat()).size;
        while (position < size) { const buffer = Buffer.alloc(Math.min(65536, size - position)); const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break; position += bytesRead; if (!target.write(buffer.subarray(0, bytesRead))) await once(target, 'drain'); }
      } finally { await file.close(); }
      if (filename === stdoutFile) stdoutOffset = position; else stderrOffset = position;
    }
  }
  async function bindOwnedTerminal() {
    if (!record.launchInvoked || record.terminal) return record.terminal;
    const candidates = inspector.namedProcesses('Terminal', uid).filter(value => value.executable === terminalProgram);
    assert.ok(candidates.length <= 1, 'Multiple new Terminal instances make ownership ambiguous.');
    if (candidates.length) {
      assert.equal(await realpath(candidates[0].executable), await realpath(terminalProgram)); record.terminal = candidates[0];
    }
    return record.terminal;
  }
  async function bindChildReceipt() {
    const receipt = await readJson(childStartedFile); if (!receipt) return;
    assert.ok(record.admissionPublished, 'A child birth receipt has no verified worker admission.');
    assert.deepEqual(receipt.worker, record.workerIdentity); assert.equal(receipt.head, head); assert.equal(receipt.nodeSha256, record.nodeSha256);
    assert.equal(receipt.identity.parentPid, receipt.worker.pid); assert.equal(receipt.identity.uid, uid);
    assert.equal(receipt.identity.parentUniqueId, receipt.worker.uniqueId);
    assert.equal(receipt.identity.originalParentPidVersion, receipt.worker.pidVersion);
    const current = processIdentity(receipt.identity.pid);
    if (sameIdentity(current, receipt.identity)) {
      assert.equal(await realpath(current.executable), nodeExecutable); ownedProcesses.set(current.pid, current);
    }
    record.childBirthReceipt = receipt;
  }
  function observeOwnedTree() {
    for (const [pid, identity] of ownedProcesses) {
      const current = processIdentity(pid);
      if (!sameProcessBirth(current, identity)) ownedProcesses.delete(pid); else ownedProcesses.set(pid, current);
    }
    const terminal = record.terminal;
    if (terminal && sameIdentity(processIdentity(terminal.pid), terminal)) ownedProcesses.set(terminal.pid, terminal);
    // Keep previously bound, still-live orphans. A fresh process never becomes
    // owned merely because an old owned PID has been reused.
    const roots = [...ownedProcesses.values()].filter(value => !ownedProcesses.has(value.parentPid));
    for (const root of roots) {
      const descendants = inspector.descendants(root);
      if (!sameProcessBirth(processIdentity(root.pid), root)) continue;
      for (const value of descendants) ownedProcesses.set(value.pid, value);
    }
    record.ownedProcesses = [...ownedProcesses.values()];
    return record.ownedProcesses;
  }
  function signalOwned(identity, signal) {
    if (!identity) return;
    assert.ok(identity.pid > 1 && ownedProcesses.get(identity.pid) === identity, 'Refusing to signal an unbound process.');
    record.cleanupSignals.push({ identity, signal, requestedAt: new Date().toISOString() });
    return signalProcess(inspector, identity, signal);
  }
  async function reclaimFailedTree() {
    ownedTreeReleased = false; record.forcedCleanup = true; record.cleanupSignals = []; record.cleanupSignalErrors = []; await publish();
    await bindOwnedTerminal();
    assert.ok(!record.launchInvoked || record.terminal, 'The launched Terminal could not be bound; refusing to signal any unowned instance.');
    try { await bindChildReceipt(); } catch (error) { record.childReceiptBindingError = failureRecord(error); }
    record.forcedCleanupBefore = observeOwnedTree();
    const descendants = () => observeOwnedTree().filter(value => value.pid !== record.terminal?.pid);
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const deadline = Date.now() + 5000, signalled = new Set(); let remaining;
      do {
        remaining = descendants();
        for (const identity of remaining.toReversed()) {
          const key = JSON.stringify([identity.uniqueId, identity.pidVersion, identity.uid, identity.gid, identity.executableUuid, identity.executable]);
          if (!signalled.has(key)) {
            try { if (signalOwned(identity, signal)) signalled.add(key); }
            catch (error) { record.cleanupSignalErrors.push(failureRecord(error)); }
          }
        }
        if (!remaining.length) break; await delay(100);
      } while (Date.now() < deadline);
      record.forcedDescendantsAfter = descendants(); if (!record.forcedDescendantsAfter.length) break;
    }
    assert.deepEqual(record.forcedDescendantsAfter, [], 'Bound descendants survived failed-owner recovery.');
    // Children have actually exited before the Terminal is ended. A missing
    // receipt stays an error even if this fallback successfully reclaims it.
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const terminal = record.terminal; observeOwnedTree();
      if (!terminal || !sameProcessBirth(processIdentity(terminal.pid), terminal)) break;
      try { signalOwned(ownedProcesses.get(terminal.pid), signal); } catch (error) { record.cleanupSignalErrors.push(failureRecord(error)); }
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && sameProcessBirth(processIdentity(terminal.pid), terminal)) await delay(100);
    }
    record.forcedCleanupAfter = observeOwnedTree(); assert.deepEqual(record.forcedCleanupAfter, [], 'Bound processes survived failed-owner recovery.');
    ownedTreeReleased = true; record.forcedCleanupReclaimed = true;
  }
  async function drainWorker() {
    await bindOwnedTerminal(); await bindChildReceipt(); observeOwnedTree();
    const existingExit = await readJson(exitFile), started = await readJson(startedFile) ?? existingExit;
    if (!started) { if (record.admissionPublished) throw new Error('An admitted Terminal worker has no startup/exit receipt.'); return; }
    assert.ok(started.identity, 'The observed worker has no actual process identity.');
    const worker = processIdentity(started.pid), originalWorkerAlive = sameIdentity(worker, started.identity);
    if (originalWorkerAlive) {
      assert.equal(worker.uid, uid); assert.equal(path.basename(worker.executable), path.basename(nodeExecutable));
      assert.ok(sameIdentity(ownedProcesses.get(worker.pid), worker), 'The actual worker is not bound to this Terminal tree.');
    }
    if (originalWorkerAlive && !existingExit) { signalProcess(inspector, worker, 'SIGTERM'); record.workerTerminationRequested = true; }
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && sameIdentity(processIdentity(started.pid), started.identity)) { observeOwnedTree(); await forward(); await delay(100); }
    record.workerAfterDrain = processIdentity(started.pid); record.exitBeforeTerminalClose = await readJson(exitFile);
    assert.ok(!sameIdentity(record.workerAfterDrain, started.identity), 'The worker did not exit after draining its child.');
    assert.ok(record.exitBeforeTerminalClose, 'The worker exited without its actual child close receipt.');
  }
  async function closeOwnedTerminal() {
    const owned = await bindOwnedTerminal(); if (!owned) return;
    const observedWorker = await readJson(startedFile) ?? await readJson(exitFile);
    if (observedWorker) {
      assert.ok(!sameIdentity(processIdentity(observedWorker.pid), observedWorker.identity), 'Refusing to close Terminal before its worker has drained.');
      assert.ok(record.exitBeforeTerminalClose, 'Refusing to close Terminal without the real child close receipt.');
    }
    const current = processIdentity(owned.pid);
    if (!current) { record.terminalAlreadyExited = true; return; }
    assert.ok(sameIdentity(current, owned), 'Refusing to signal a reused Terminal PID.');
    const descendants = inspector.descendants(owned); record.terminalDescendantsBeforeClose = descendants;
    for (const child of descendants) ownedProcesses.set(child.pid, child);
    signalProcess(inspector, owned, 'SIGTERM'); record.terminalTerminationRequested = true;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && sameProcessBirth(processIdentity(owned.pid), owned)) await delay(100);
    if (sameProcessBirth(processIdentity(owned.pid), owned)) {
      // Force is cleanup of a failed owner, never a successful receipt.
      signalProcess(inspector, owned, 'SIGKILL'); record.forcedTerminalTermination = true;
      const forcedDeadline = Date.now() + 5000;
      while (Date.now() < forcedDeadline && sameProcessBirth(processIdentity(owned.pid), owned)) await delay(100);
    }
    record.terminalAfterClose = processIdentity(owned.pid);
    assert.ok(!sameProcessBirth(record.terminalAfterClose, owned), 'The owned Terminal process survived termination.');
    const childDeadline = Date.now() + 5000; let remaining;
    do { remaining = descendants.filter(value => sameProcessBirth(processIdentity(value.pid), value)); if (!remaining.length) break; await delay(100); } while (Date.now() < childDeadline);
    record.terminalDescendantsAfterClose = remaining; assert.deepEqual(remaining, [], 'Owned Terminal descendants remained alive.');
    if (record.forcedTerminalTermination) throw new Error('The owned Terminal required forced termination.');
  }
  async function snapshotRoute(stage) {
    const snapshot = { stage, requestedAt: new Date().toISOString(), executable: '/sbin/route', arguments: ['-n', 'get', '255.255.255.255'],
      actualChildCloseReceiptPresent: Boolean(record.exitBeforeTerminalClose), terminalAfterClose: record.terminalAfterClose };
    routeObservation.snapshots.push(snapshot);
    let stdout, stderr;
    try {
      const result = spawnSync(snapshot.executable, snapshot.arguments, { timeout: 15000,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
      stdout = result.stdout; stderr = result.stderr; snapshot.code = result.status; snapshot.signal = result.signal;
      if (result.error) snapshot.error = failureRecord(result.error);
    } catch (error) {
      stdout = error.stdout; stderr = error.stderr; snapshot.code = error.status ?? null; snapshot.signal = error.signal ?? null;
      snapshot.error = failureRecord(error);
    }
    for (const [name, value] of [['stdout', stdout], ['stderr', stderr]]) if (value !== undefined && value !== null) try {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), filename = path.join(evidence, 'route-' + stage + '-' + name + '.txt');
      await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); snapshot[name] = { path: filename, bytes: bytes.length, sha256: sha(bytes) };
    } catch (error) { routeObservation.errors.push({ stage: 'snapshot-' + stage + '-' + name, error: failureRecord(error) }); }
    snapshot.finishedAt = new Date().toISOString();
  }
  try {
    await snapshotRoute('before-operation');
    record.terminalBefore = terminalPids(); assert.deepEqual(record.terminalBefore, [], 'An existing Terminal instance prevents isolated ownership.');
    record.consoleOwner = command('/usr/bin/stat', ['-f', '%Su:%u', '/dev/console']).trim();
    assert.equal(Number(record.consoleOwner.split(':').at(-1)), uid, 'No GUI console session belongs to the ordinary runner.');
    command('/bin/launchctl', ['print', 'gui/' + uid]); record.guiBootstrapExists = true; // Never persist the domain's environment.
    assert.equal(command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', terminalBundle + '/Contents/Info.plist']).trim(), 'com.apple.Terminal');
    command('/usr/bin/codesign', ['--verify', '--strict', terminalBundle]); record.terminalProgramSha256 = sha(await readFile(terminalProgram));
    privateDirectory = await mkdtemp(path.join(temporaryRoot, 'mediamanager-terminal-context-')); await chmod(privateDirectory, 0o700);
    const relative = path.relative(await realpath(outputRoot), await realpath(privateDirectory));
    assert.ok(relative === '..' || relative.startsWith('..' + path.sep), 'Private environment files must remain outside uploaded evidence.');
    descriptorFile = path.join(privateDirectory, 'operation.json'); commandFile = path.join(privateDirectory, 'operation.command'); admissionFile = path.join(privateDirectory, 'admitted.json');
    await writeFile(stdoutFile, '', { flag: 'wx', mode: 0o600 }); await writeFile(stderrFile, '', { flag: 'wx', mode: 0o600 });
    record.openRequestedAt = new Date().toISOString();
    await save(descriptorFile, { operation, arguments: operations[operation], uid, gid, head, nodeExecutable, nodeSha256: record.nodeSha256,
      terminalProgramSha256: record.terminalProgramSha256, workingDirectory,
      environment: { ...process.env }, startedFile, childStartedFile, exitFile, admissionFile });
    const source = '#!/bin/sh\ncd ' + shellQuote(workingDirectory) + ' || exit 2\nexec ' + [nodeExecutable, thisFile, '--terminal', descriptorFile].map(shellQuote).join(' ')
      + ' >' + shellQuote(stdoutFile) + ' 2>' + shellQuote(stderrFile) + '\n';
    await writeFile(commandFile, source, { flag: 'wx', mode: 0o700 }); record.commandSha256 = sha(Buffer.from(source));
    record.openRequested = true; await publish(); if (interrupted) throw new Error('Terminal launch interrupted by ' + interrupted);
    record.launchInvoked = true;
    record.openStdout = command('/usr/bin/open', ['-n', '-a', terminalBundle, commandFile]); record.openExitCode = 0;
    const deadline = Date.now() + 60000; let lastHeartbeat = 0;
    while (!(completed = await readJson(exitFile))) {
      if (interrupted) throw new Error('Terminal operation interrupted by ' + interrupted);
      await bindOwnedTerminal(); await bindChildReceipt(); observeOwnedTree(); const started = await readJson(startedFile);
      if (started && !record.admissionPublished) {
        assert.ok(record.terminal); assert.equal(started.uid, uid); assert.equal(started.gid, gid); assert.equal(started.head, head);
        assert.equal(started.nodeSha256, record.nodeSha256); assert.ok(sameIdentity(started.terminal, record.terminal));
        const worker = processIdentity(started.pid); assert.equal(worker?.uid, uid); assert.equal(path.basename(worker.executable), path.basename(nodeExecutable));
        assert.ok(sameIdentity(worker, started.identity));
        assert.ok(inspector.descendants(record.terminal).some(value => sameIdentity(value, worker)), 'The admitted worker must belong to this actual Terminal birth.');
        record.workerIdentity = worker;
        await save(admissionFile, { workerPid: started.pid, terminal: record.terminal, head }); record.admissionPublished = true; await publish();
      }
      if (!started && Date.now() > deadline) throw new Error('Terminal accepted no verified worker; GUI/command execution is unavailable.');
      const terminalLost = record.terminal && !sameIdentity(processIdentity(record.terminal.pid), record.terminal);
      const workerLost = started && !sameIdentity(processIdentity(started.pid), started.identity);
      if (terminalLost || workerLost) {
        // The exit file may have completed just after this iteration's first
        // read. A vanished process without that real receipt is a hard failure.
        completed = await readJson(exitFile); if (completed) break;
        throw new Error(terminalLost ? 'The owned Terminal exited before its command receipt.' : 'The worker exited before its actual child close receipt.');
      }
      await forward();
      if (Date.now() - lastHeartbeat >= 60000) { process.stdout.write('[macOS Terminal context] ' + operation + ' remains owned by PID ' + (record.terminal?.pid ?? 'pending') + '.\n'); lastHeartbeat = Date.now(); }
      await delay(300);
    }
    record.childExit = completed; assert.equal(completed.uid, uid); assert.equal(completed.gid, gid);
    if (!completed.startupFailed) { assert.equal(completed.head, head); assert.equal(completed.nodeSha256, record.nodeSha256); }
    if (completed.childPid !== null && completed.childPid !== undefined) {
      await bindChildReceipt(); assert.equal(record.childBirthReceipt?.identity.pid, completed.childPid, 'The real child has no matching atomic birth receipt.');
    }
    assert.equal(completed.interrupted ?? null, null, 'The Terminal command was interrupted.');
    assert.equal(completed.signal, null, 'The actual child was terminated by a signal.');
  } catch (error) { failure = error; record.error = failureRecord(error); }
  finally {
    const errors = [];
    try { await drainWorker(); } catch (error) { errors.push(error); }
    await snapshotRoute('after-child-drain');
    try { await closeOwnedTerminal(); } catch (error) { errors.push(error); }
    await snapshotRoute('after-terminal-close-attempt');
    try {
      assert.ok(!record.launchInvoked || record.terminal || terminalPids().length === 0, 'An unbound Terminal remains after launch.');
      assert.deepEqual(observeOwnedTree(), [], 'Bound processes remained after normal cleanup.'); ownedTreeReleased = true;
    }
    catch (error) { errors.push(error); }
    if (errors.length) try { await reclaimFailedTree(); } catch (error) { errors.push(error); }
    if (ownedTreeReleased) {
      for (const filename of [descriptorFile, commandFile, admissionFile].filter(Boolean)) {
        try { await unlink(filename); } catch (error) { if (error.code !== 'ENOENT') errors.push(error); }
      }
      if (privateDirectory) try {
        assert.deepEqual(await readdir(privateDirectory), []); await rmdir(privateDirectory); await assert.rejects(lstat(privateDirectory), { code: 'ENOENT' }); record.privateEnvironmentRemoved = true;
      } catch (error) { errors.push(error); }
    } else record.privateEnvironmentRemovalDeferred = true;
    try { await forward(); } catch (error) { errors.push(error); }
    for (const [name, filename] of [['stdout', stdoutFile], ['stderr', stderrFile]]) try {
      const bytes = await readFile(filename); record[name + 'Present'] = true; record[name + 'Bytes'] = bytes.length; record[name + 'Sha256'] = sha(bytes);
    } catch (error) { record[name + 'Present'] = false; record[name + 'Sha256'] = null; if (error.code !== 'ENOENT') errors.push(error); }
    record.interrupted = interrupted ?? null; record.cleanupErrors = errors.map(failureRecord); record.cleanupCompleted = errors.length === 0;
    record.finishedAt = new Date().toISOString();
    if (errors.length) failure = new AggregateError([...(failure ? [failure] : []), ...errors], 'The owned Terminal context failed cleanup.');
    await publish(); for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
  if (failure) throw failure; if (interrupted) throw new Error('The Terminal owner was interrupted by ' + interrupted);
  process.exitCode = completed?.interrupted ? 2 : Number.isInteger(completed?.code) ? completed.code : 2;
}
