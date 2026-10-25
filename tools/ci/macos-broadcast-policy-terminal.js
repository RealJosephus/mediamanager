import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// The proof keeps the existing actual Terminal/ordinary UID admission boundary.
// It does not add a mode or alter the formal network-context/CI runner.
// https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
export const terminalBundle = '/System/Applications/Utilities/Terminal.app';
export const terminalProgram = terminalBundle + '/Contents/MacOS/Terminal';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const failure = error => ({ name: error.name, message: error.message, code: error.code, status: error.status,
  signal: error.signal, stack: error.stack, errors: error.errors?.map(failure) });
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 15000,
  env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
export async function save(filename, value) {
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export async function maybeJson(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function identity(pid) {
  let text;
  try { text = command('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,uid=,lstart=,comm=']).trim(); }
  catch (error) { if (error.status === 1 && !error.stdout?.toString().trim()) return null; throw error; }
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/u.exec(text);
  assert.ok(match, 'An actual process identity is required.');
  return { pid: Number(match[1]), parentPid: Number(match[2]), uid: Number(match[3]), startedUtc: match[4],
    startedEpochMs: Date.parse(match[4] + ' UTC'), executable: match[5] };
}
export const sameIdentity = (left, right) => Boolean(left && right && left.pid === right.pid && left.uid === right.uid
  && left.startedUtc === right.startedUtc && left.executable === right.executable);
function terminals() {
  try { return command('/usr/bin/pgrep', ['-x', 'Terminal']).trim().split(/\s+/u).filter(Boolean).map(Number); }
  catch (error) { if (error.status === 1 && !error.stdout?.toString().trim()) return []; throw error; }
}
function descendants(root) {
  const links = command('/bin/ps', ['-axo', 'pid=,ppid=']).trim().split('\n').map(text => {
    const match = /^(\d+)\s+(\d+)$/u.exec(text.trim()); assert.ok(match);
    return { pid: Number(match[1]), parentPid: Number(match[2]) };
  });
  const parents = new Set([root.pid]), found = []; let changed = true;
  while (changed) {
    changed = false;
    for (const link of links) if (parents.has(link.parentPid) && !parents.has(link.pid)) {
      const current = identity(link.pid);
      if (current && current.parentPid === link.parentPid) { parents.add(current.pid); found.push(current); changed = true; }
    }
  }
  assert.ok(sameIdentity(identity(root.pid), root), 'The observed tree root changed during inspection.');
  return found;
}
async function waitGone(value, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (sameIdentity(identity(value.pid), value) && Date.now() < deadline) await delay(100);
  return !sameIdentity(identity(value.pid), value);
}
export async function runPolicyTerminal(scope, scopeFile, onAlive, signal) {
  assert.equal(process.getuid(), scope.uid); assert.notEqual(scope.uid, 0);
  assert.deepEqual(terminals(), [], 'An existing Terminal prevents isolated proof ownership.');
  const consoleOwner = command('/usr/bin/stat', ['-f', '%Su:%u', '/dev/console']).trim();
  assert.equal(Number(consoleOwner.split(':').at(-1)), scope.uid);
  command('/bin/launchctl', ['print', 'gui/' + scope.uid]);
  command('/usr/bin/codesign', ['--verify', '--strict', terminalBundle]);
  assert.equal(hash(await readFile(terminalProgram)), scope.terminalSha256);
  const privateRoot = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'mediamanager-policy-terminal-'));
  await chmod(privateRoot, 0o700);
  const executable = path.join(privateRoot, 'proof.command');
  // The shell's wait result is independent of the packet worker's own report.
  // Normal success requires both; no signal handler targets an unbound PID.
  const script = '#!/bin/sh\numask 077\ncd ' + shellQuote(scope.repository) + '\n' + shellQuote(scope.nodeExecutable)
    + ' ' + shellQuote(scope.workerFile) + ' ' + shellQuote(scopeFile)
    + ' >' + shellQuote(scope.stdoutFile) + ' 2>' + shellQuote(scope.stderrFile) + ' &\nchild=$!\nwait "$child"\nstatus=$?\n'
    + '(set -C; printf \'{"kind":"actual-shell-wait","pid":%s,"code":%s,"nonce":"' + scope.nonce + '","head":"' + scope.head
    + '"}\\n\' "$child" "$status" >' + shellQuote(scope.actualCloseFile + '.pending') + ')\n'
    + '/bin/ln ' + shellQuote(scope.actualCloseFile + '.pending') + ' ' + shellQuote(scope.actualCloseFile)
    + ' && /bin/rm ' + shellQuote(scope.actualCloseFile + '.pending') + '\nexit "$status"\n';
  await writeFile(executable, script, { flag: 'wx', mode: 0o700 });
  const record = { context: 'actual-terminal-session', uid: scope.uid, head: scope.head, nonce: scope.nonce,
    wrapperSha256: scope.terminalHelperSha256, commandSha256: hash(Buffer.from(script)), consoleOwner,
    environmentWrittenToArtifact: false, cleanupCompleted: false, cleanupErrors: [], createdAt: new Date().toISOString() };
  let launched = false, terminal, worker, complete, actualClose, problem, phaseAdmitted = false;
  const bindTerminal = () => {
    if (terminal) return;
    const candidates = terminals().map(identity).filter(value => value && value.uid === scope.uid
      && value.startedEpochMs >= scope.launchFloorEpochMs && value.executable === terminalProgram);
    assert.ok(candidates.length <= 1, 'New Terminal ownership is ambiguous.');
    if (candidates.length) record.terminal = terminal = candidates[0];
  };
  try {
    signal?.throwIfAborted();
    command('/usr/bin/open', ['-n', '-a', terminalBundle, executable]); launched = true;
    const deadline = Date.now() + 60000;
    while (!(complete = await maybeJson(scope.exitFile)) || !(actualClose = await maybeJson(scope.actualCloseFile))) {
      signal?.throwIfAborted(); assert.ok(Date.now() < deadline, 'The bounded policy proof did not complete.');
      bindTerminal();
      const started = await maybeJson(scope.startedFile);
      if (started && !worker) {
        assert.equal(started.nonce, scope.nonce); assert.equal(started.head, scope.head); assert.equal(started.uid, scope.uid);
        assert.ok(sameIdentity(terminal, started.terminal));
        assert.equal(hash(await readFile(started.terminal.executable)), scope.terminalSha256);
        assert.ok(sameIdentity(identity(started.identity.pid), started.identity));
        assert.ok(descendants(terminal).some(value => sameIdentity(value, started.identity)));
        record.worker = worker = started.identity; record.startedReceipt = started;
        await save(scope.admissionFile, { nonce: scope.nonce, head: scope.head, worker, terminal });
        record.admittedAt = new Date().toISOString();
      }
      const alive = await maybeJson(scope.aliveFile);
      if (alive && !phaseAdmitted) {
        assert.ok(worker && alive.nonce === scope.nonce && sameIdentity(alive.identity, worker));
        phaseAdmitted = true; await onAlive(alive);
      }
      await delay(100);
    }
    assert.equal(complete.nonce, scope.nonce); assert.equal(complete.head, scope.head);
    assert.ok(sameIdentity(complete.identity, worker));
    assert.equal(actualClose.nonce, scope.nonce); assert.equal(actualClose.head, scope.head);
    assert.equal(actualClose.pid, worker.pid); assert.equal(actualClose.code, 0); record.actualChildWait = actualClose;
    record.workerExitReceipt = complete;
    assert.equal(complete.code, 0); assert.equal(complete.signal, null); assert.equal(complete.allSocketsClosed, true);
  } catch (error) { problem = error; record.error = failure(error); }
  finally {
    const errors = [];
    try {
      if (launched && !terminal) {
        const bindDeadline = Date.now() + 5000;
        while (!terminal && Date.now() < bindDeadline) { bindTerminal(); if (!terminal) await delay(100); }
        assert.ok(terminal, 'The launched Terminal has no bound identity; its cleanup cannot be certified.');
      }
      if (worker && sameIdentity(identity(worker.pid), worker)) {
        if (problem) process.kill(worker.pid, 'SIGTERM');
        if (!(await waitGone(worker, 10000))) {
          process.kill(worker.pid, 'SIGKILL'); await waitGone(worker, 3000);
          throw new Error('The proof worker required forced termination.');
        }
      }
      if (terminal && sameIdentity(identity(terminal.pid), terminal)) {
        const children = descendants(terminal); record.descendantsBeforeClose = children;
        process.kill(terminal.pid, 'SIGTERM');
        if (!(await waitGone(terminal, 5000))) {
          process.kill(terminal.pid, 'SIGKILL'); await waitGone(terminal, 3000);
          throw new Error('The proof Terminal required forced termination.');
        }
        for (const value of children) assert.ok(await waitGone(value, 3000), 'An owned Terminal descendant survived.');
      }
      assert.ok(!launched || terminal || terminals().length === 0, 'The launched Terminal could not be bound.');
      record.workerAfterClose = worker ? identity(worker.pid) : null;
      record.terminalAfterClose = terminal ? identity(terminal.pid) : null;
      assert.ok(!worker || !sameIdentity(record.workerAfterClose, worker));
      assert.ok(!terminal || !sameIdentity(record.terminalAfterClose, terminal));
      await unlink(executable); assert.deepEqual(await readdir(privateRoot), []); await rmdir(privateRoot);
      await assert.rejects(lstat(privateRoot), { code: 'ENOENT' }); record.privateDirectoryRemoved = true;
    } catch (error) { errors.push(error); }
    record.cleanupErrors = errors.map(failure); record.cleanupCompleted = errors.length === 0;
    record.finishedAt = new Date().toISOString();
    await save(scope.terminalRecordFile, record);
    if (errors.length) problem = new AggregateError([...(problem ? [problem] : []), ...errors], 'Policy Terminal cleanup failed.');
  }
  if (problem) throw problem;
  return complete;
}
