import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Apple TN3179 exempts system launchd daemons (including their children) from
// local-network privacy prompts. A runner's LaunchAgent has no such exemption.
// Keep the ordinary runner UID and execute the unchanged setup/strict programs.
// https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
assert.equal(process.platform, 'darwin');
const thisFile = fileURLToPath(import.meta.url), repository = path.resolve(path.dirname(thisFile), '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const save = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const errorRecord = error => ({ name: error.name, message: error.message, stack: error.stack, code: error.code });
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
const operations = {
  setup: [path.join(repository, 'tools/ci/macos-broadcast.js'), 'setup'],
  strict: [path.join(repository, 'tools/ci/run.js')],
};
async function readDescriptor(filename) {
  const text = await readFile(filename, 'utf8');
  try { return JSON.parse(text); }
  catch { throw new Error('The private network-context descriptor could not be decoded.'); }
}

async function daemonWorker(descriptorPath) {
  const descriptor = await readDescriptor(descriptorPath);
  assert.equal(descriptor.environment.GITHUB_ACTIONS, 'true', 'This network context belongs only to Actions.');
  assert.ok(Object.hasOwn(operations, descriptor.operation));
  assert.deepEqual(descriptor.arguments, operations[descriptor.operation]);
  assert.equal(process.ppid, 1, 'The worker must actually be parented by system launchd.');
  assert.equal(process.getuid(), descriptor.uid); assert.notEqual(process.getuid(), 0, 'Validation must retain the ordinary runner identity.');
  assert.equal(process.getgid(), descriptor.gid);
  assert.equal(await realpath(process.cwd()), descriptor.workingDirectory);
  assert.equal(await realpath(process.execPath), descriptor.nodeExecutable);
  const head = command('git', ['-C', repository, 'rev-parse', 'HEAD']).trim(); assert.equal(head, descriptor.head);
  let child, interrupted;
  const onSignal = signal => { interrupted = signal; if (child?.pid) child.kill(signal); };
  const onInt = () => onSignal('SIGINT'), onTerm = () => onSignal('SIGTERM');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  const started = { schemaVersion: 1, operation: descriptor.operation, launchDaemonLabel: descriptor.label,
    pid: process.pid, parentPid: process.ppid, uid: process.getuid(), gid: process.getgid(),
    head, workingDirectory: process.cwd(), nodeExecutable: await realpath(process.execPath),
    nodeSha256: sha(await readFile(process.execPath)), environmentKeyCount: Object.keys(descriptor.environment).length,
    environmentWrittenToArtifact: false, startedAt: new Date().toISOString() };
  await save(descriptor.startedFile, started);
  let result;
  try {
    if (interrupted) throw Object.assign(new Error('The daemon was interrupted before child admission.'), { code: interrupted });
    child = spawn(descriptor.nodeExecutable, descriptor.arguments, { cwd: descriptor.workingDirectory,
      env: descriptor.environment, stdio: ['ignore', 'inherit', 'inherit'] });
    result = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, childPid: child.pid }));
    });
  } catch (error) { result = { code: 2, signal: null, childPid: child?.pid ?? null, error: errorRecord(error) }; }
  finally { process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); }
  await save(descriptor.exitFile, { ...started, ...result, interrupted: interrupted ?? null, finishedAt: new Date().toISOString(),
    phaseAcceptance: false, releaseAcceptance: false });
  return Number.isInteger(result.code) ? result.code : 2;
}

if (process.argv[2] === '--daemon') {
  assert.equal(process.argv.length, 4);
  daemonWorker(process.argv[3]).then(code => { process.exitCode = code; }).catch(async error => {
    // No descriptor/environment content is printed, even on a startup failure.
    process.stderr.write(error.stack + '\n'); process.exitCode = 2;
    try {
      const descriptor = await readDescriptor(process.argv[3]);
      await save(descriptor.exitFile, { code: 2, signal: null, error: errorRecord(error), startupFailed: true,
        pid: process.pid, uid: process.getuid(), gid: process.getgid(), phaseAcceptance: false, releaseAcceptance: false });
    } catch { /* The outer owner diagnoses a missing exit receipt as a failure. */ }
  });
} else {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This network context belongs only to Actions.');
  assert.equal(process.argv.length, 3); const operation = process.argv[2]; assert.ok(Object.hasOwn(operations, operation));
  const outputRoot = process.env.MEDIAMANAGER_VALIDATION_OUTPUT_ROOT, temporaryRoot = process.env.RUNNER_TEMP;
  assert.ok(path.isAbsolute(outputRoot ?? '') && path.isAbsolute(temporaryRoot ?? ''));
  assert.notEqual(process.getuid(), 0, 'The context launcher must be the ordinary runner.');
  const nodeExecutable = await realpath(process.execPath), workingDirectory = await realpath(process.cwd());
  assert.equal(workingDirectory, await realpath(repository));
  const uid = process.getuid(), gid = process.getgid(), username = command('/usr/bin/id', ['-un']).trim(), group = command('/usr/bin/id', ['-gn']).trim();
  assert.match(username, /^[A-Za-z_][A-Za-z0-9_.-]*$/u); assert.match(group, /^[A-Za-z_][A-Za-z0-9_.-]*$/u);
  const unique = randomUUID(), label = 'dev.mediamanager.validation.' + operation + '.' + unique;
  const evidence = path.join(outputRoot, 'provisioning', 'network-context-' + operation + '-' + unique); await mkdir(evidence, { recursive: true });
  // Credentials and all environment values remain only in this private directory,
  // outside the uploaded output root. The launchd plist itself contains no env.
  const privateDirectory = await mkdtemp(path.join(temporaryRoot, 'mediamanager-network-context-')); await chmod(privateDirectory, 0o700);
  const relativePrivate = path.relative(await realpath(outputRoot), await realpath(privateDirectory));
  assert.ok(relativePrivate === '..' || relativePrivate.startsWith('..' + path.sep), 'Private environment files must stay outside uploaded artifacts.');
  const descriptorPath = path.join(privateDirectory, 'operation.json'), privatePlist = path.join(privateDirectory, 'daemon.plist');
  const systemPlist = path.join('/Library/LaunchDaemons', label + '.plist'), target = 'system/' + label;
  const startedFile = path.join(evidence, 'started.json'), exitFile = path.join(evidence, 'exit.json');
  const stdoutFile = path.join(evidence, 'stdout.txt'), stderrFile = path.join(evidence, 'stderr.txt');
  const head = command('git', ['-C', repository, 'rev-parse', 'HEAD']).trim();
  const record = { schemaVersion: 1, operation, label, systemTarget: target, head, username, group, uid, gid,
    workingDirectory, nodeExecutable, nodeSha256: sha(await readFile(nodeExecutable)), wrapperSha256: sha(await readFile(thisFile)),
    arguments: operations[operation], environmentCopiedWithoutModification: true, environmentWrittenToArtifact: false,
    privateEnvironmentDirectoryOutsideArtifacts: true, createdAt: new Date().toISOString(), events: [],
    phaseAcceptance: false, releaseAcceptance: false };
  const recordFile = path.join(evidence, 'owner.json');
  const publish = async () => {
    await writeFile(recordFile + '.pending', JSON.stringify(record, null, 2) + '\n', { mode: 0o600 }); await rename(recordFile + '.pending', recordFile);
  };
  let installed = false, bootstrapped = false, installRequested = false, bootstrapRequested = false;
  let interrupted, failure, completed, stopping, stdoutOffset = 0, stderrOffset = 0;
  const onInt = () => { interrupted = 'SIGINT'; }, onTerm = () => { interrupted = 'SIGTERM'; };
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  const escaped = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  function plist(value) {
    if (typeof value === 'string') return '<string>' + escaped(value) + '</string>';
    if (typeof value === 'number') return '<integer>' + value + '</integer>';
    if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
    if (Array.isArray(value)) return '<array>' + value.map(plist).join('') + '</array>';
    return '<dict>' + Object.entries(value).map(([key, entry]) => '<key>' + escaped(key) + '</key>' + plist(entry)).join('') + '</dict>';
  }
  async function privileged(args, { cleanup = false, onSuccess } = {}) {
    if (interrupted && !cleanup) throw new Error('Context launch interrupted by ' + interrupted);
    const event = { args, requestedAt: new Date().toISOString() }; record.events.push(event); await publish();
    if (interrupted && !cleanup) throw new Error('Context launch interrupted by ' + interrupted);
    try { const value = command('/usr/bin/sudo', args); onSuccess?.(); event.completedAt = new Date().toISOString(); event.stdout = value; await publish(); return value; }
    catch (error) { event.error = errorRecord(error); await publish(); throw error; }
  }
  async function readExit() {
    try { return JSON.parse(await readFile(exitFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }
  function registration() {
    try { return { registered: true, state: command('/bin/launchctl', ['print', target]) }; }
    catch (error) {
      const stderr = error.stderr?.toString() ?? '';
      if (!/Could not find service/iu.test(stderr) || !stderr.includes(label)) throw error;
      return { registered: false, exitStatus: error.status, stderr };
    }
  }
  async function forward() {
    for (const [filename, stream, offset] of [[stdoutFile, process.stdout, stdoutOffset], [stderrFile, process.stderr, stderrOffset]]) {
      const file = await open(filename, 'r'); let position = offset;
      try {
        const size = (await file.stat()).size;
        while (position < size) {
          const buffer = Buffer.alloc(Math.min(65536, size - position)), { bytesRead } = await file.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break; position += bytesRead;
          if (!stream.write(buffer.subarray(0, bytesRead))) await once(stream, 'drain');
        }
      } finally { await file.close(); }
      if (filename === stdoutFile) stdoutOffset = position; else stderrOffset = position;
    }
  }
  async function stopAndDrain() {
    return stopping ??= (async () => {
      // A failed/terminated bootstrap command can still have registered a job.
      // Resolve its actual state before deciding that nothing needs bootout.
      if (!bootstrapped && bootstrapRequested) bootstrapped = registration().registered;
      if (!bootstrapped) return;
      let drainError;
      try {
        if (!await readExit()) {
          // Even an already-crashed worker must reach bootout and plist cleanup.
          try { await privileged(['/bin/launchctl', 'kill', 'SIGTERM', target], { cleanup: true }); }
          catch (error) { record.terminationError = errorRecord(error); }
          const deadline = Date.now() + 25000;
          while (Date.now() < deadline && !await readExit()) { await forward(); await delay(200); }
        }
        record.exitBeforeBootout = await readExit();
      } catch (error) { drainError = error; }
      finally { await privileged(['/bin/launchctl', 'bootout', target], { cleanup: true, onSuccess: () => { bootstrapped = false; } }); }
      record.absenceCheck = registration();
      assert.equal(record.absenceCheck.registered, false, 'The owned system LaunchDaemon remained registered.');
      record.daemonBootedOut = true;
      if (drainError) throw drainError;
      if (!record.exitBeforeBootout) throw new Error('The daemon did not finish owned child cleanup before forced bootout.');
    })();
  }
  try {
    await save(descriptorPath, { operation, arguments: operations[operation], label, uid, gid, head, nodeExecutable,
      workingDirectory, environment: { ...process.env }, startedFile, exitFile });
    await writeFile(stdoutFile, '', { flag: 'wx', mode: 0o600 }); await writeFile(stderrFile, '', { flag: 'wx', mode: 0o600 });
    const definition = { Label: label, ProgramArguments: [nodeExecutable, thisFile, '--daemon', descriptorPath],
      UserName: username, GroupName: group, WorkingDirectory: workingDirectory, StandardOutPath: stdoutFile, StandardErrorPath: stderrFile,
      RunAtLoad: true, KeepAlive: false, ProcessType: 'Background', ExitTimeOut: 30, AbandonProcessGroup: false, Umask: process.umask() };
    await writeFile(privatePlist, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">' + plist(definition) + '</plist>\n', { flag: 'wx', mode: 0o600 });
    await assert.rejects(lstat(systemPlist), { code: 'ENOENT' });
    installRequested = true; record.installRequested = true; await publish();
    await privileged(['/usr/bin/install', '-o', 'root', '-g', 'wheel', '-m', '0600', privatePlist, systemPlist], { onSuccess: () => { installed = true; } });
    bootstrapRequested = true; record.bootstrapRequested = true; await publish();
    await privileged(['/bin/launchctl', 'bootstrap', 'system', systemPlist], { onSuccess: () => { bootstrapped = true; } });
    const launchdState = command('/bin/launchctl', ['print', target]); await writeFile(path.join(evidence, 'launchd-after-bootstrap.txt'), launchdState, { flag: 'wx' });
    const startupDeadline = Date.now() + 60000; let lastHeartbeat = 0, lastStateCheck = 0;
    while (!completed) {
      if (interrupted) throw new Error('Context operation interrupted by ' + interrupted);
      completed = await readExit(); await forward();
      if (!completed) {
        const started = await lstat(startedFile).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (!started && Date.now() > startupDeadline) throw new Error('The owned system LaunchDaemon did not publish its startup identity.');
        if (Date.now() - lastStateCheck >= 5000) {
          const state = registration(); lastStateCheck = Date.now();
          if (!state.registered) throw new Error('The owned system LaunchDaemon disappeared before its exit receipt.');
          if (started && /^\s*state = (?:not running|exited|waiting)\s*$/mu.test(state.state) && !await readExit()) {
            await writeFile(path.join(evidence, 'launchd-missing-exit.txt'), state.state, { flag: 'wx' });
            throw new Error('The owned system LaunchDaemon stopped without a complete child exit receipt.');
          }
        }
        if (Date.now() - lastHeartbeat >= 60000) { process.stdout.write('[macOS network context] ' + operation + ' remains owned by ' + label + '.\n'); lastHeartbeat = Date.now(); }
        await delay(500);
      }
    }
    record.childExit = completed; assert.equal(completed.uid, uid); assert.equal(completed.gid, gid);
    if (!completed.startupFailed) { assert.equal(completed.head, head); assert.equal(completed.nodeSha256, record.nodeSha256); }
  } catch (error) { failure = error; record.error = errorRecord(error); }
  finally {
    const cleanupErrors = [];
    try { await stopAndDrain(); } catch (error) { cleanupErrors.push(error); }
    if (installRequested && !bootstrapped) {
      try { await privileged(['/bin/rm', '-f', systemPlist], { cleanup: true, onSuccess: () => { installed = false; } }); await assert.rejects(lstat(systemPlist), { code: 'ENOENT' }); record.systemPlistRemoved = true; }
      catch (error) { cleanupErrors.push(error); }
    }
    // The private descriptor contains credentials. Delete exact owned files,
    // then the now-empty directory; never recurse or serialize their contents.
    for (const filename of [descriptorPath, privatePlist]) {
      try { await unlink(filename); } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(error); }
    }
    try { assert.deepEqual(await readdir(privateDirectory), []); await rmdir(privateDirectory); await assert.rejects(lstat(privateDirectory), { code: 'ENOENT' }); record.privateEnvironmentRemoved = true; }
    catch (error) { cleanupErrors.push(error); }
    try { await forward(); } catch (error) { cleanupErrors.push(error); }
    for (const [name, filename] of [['stdout', stdoutFile], ['stderr', stderrFile]]) {
      try { const bytes = await readFile(filename); record[name + 'Present'] = true; record[name + 'Bytes'] = bytes.length; record[name + 'Sha256'] = sha(bytes); }
      catch (error) { record[name + 'Present'] = false; record[name + 'Sha256'] = null; if (error.code !== 'ENOENT') cleanupErrors.push(error); }
    }
    record.finishedAt = new Date().toISOString(); record.interrupted = interrupted ?? null;
    record.cleanupErrors = cleanupErrors.map(errorRecord); record.cleanupCompleted = cleanupErrors.length === 0 && !installed && !bootstrapped;
    if (cleanupErrors.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'The owned macOS network context failed cleanup.');
    await publish(); process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
  }
  if (failure) throw failure;
  if (interrupted) throw new Error('The owned macOS network context was interrupted by ' + interrupted);
  process.exitCode = Number.isInteger(completed?.code) ? completed.code : 2;
}
