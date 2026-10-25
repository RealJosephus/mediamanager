import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { validationExecutable } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function nodeAccess(filename) {
  let read, write;
  try { read = { succeeded: true, bytes: (await readFile(filename)).toString('base64') }; }
  catch (error) { read = { succeeded: false, error: { code: error.code, message: error.message } }; }
  try { const handle = await open(filename, 'r+'); try { write = { succeeded: true }; } finally { await handle.close(); } }
  catch (error) { write = { succeeded: false, error: { code: error.code, message: error.message } }; }
  return { read, write };
}

export async function holdNativeFile({ record, filename, mode, receipt }) {
  assert.ok(['read', 'none'].includes(mode));
  const executable = validationExecutable('dotnet');
  assert.equal(hash(await readFile(executable)), record.dotnet.sha256);
  assert.equal(hash(await readFile(record.oracleAssembly.filename)), record.oracleAssembly.sha256);
  const args = [record.oracleAssembly.filename, 'hold-file', filename, mode];
  Object.assign(receipt, { executable, args, filename, mode, started: new Date().toISOString(),
    beforeSha256: hash(await readFile(filename)), messages: [], nodeAccess: [] });
  const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  receipt.pid = child.pid;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let pending, failure, completed, stderr = '';
  const queue = [];
  const fail = error => { failure ??= error; pending?.reject(error); pending = undefined; };
  lines.on('line', line => {
    try {
      const message = JSON.parse(line); receipt.messages.push(message);
      if (pending) { pending.resolve(message); pending = undefined; } else queue.push(message);
    } catch (error) { fail(error); }
  });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdin.on('error', fail);
  const completion = new Promise(resolve => {
    child.once('error', error => { completed = { error: error.message }; fail(error); resolve(completed); });
    child.once('close', (code, signal) => {
      completed = { code, signal }; resolve(completed);
      if (pending) fail(new Error('Native file holder exited before acknowledging the request.'));
    });
  });
  async function response(phase) {
    if (failure) throw failure;
    let timer;
    try {
      const message = queue.length ? queue.shift() : await new Promise((resolve, reject) => {
        if (completed) { reject(new Error('Native file holder exited before acknowledging the request.')); return; }
        pending = { resolve, reject };
        timer = setTimeout(() => fail(new Error('Native file holder did not acknowledge ' + phase + '.')), 5000);
        timer.unref();
      });
      assert.equal(message.phase, phase);
      assert.equal(path.resolve(message.filename), path.resolve(filename));
      assert.equal(message.mode, mode);
      assert.equal(message.pid, child.pid);
      return message;
    } finally { clearTimeout(timer); }
  }
  async function stop() {
    if (!completed) child.kill();
    receipt.completion = await completion; receipt.stderr = stderr;
    receipt.completed = new Date().toISOString(); lines.close();
  }
  function assertAlive(message) {
    assert.equal(completed, undefined, message);
    assert.equal(child.exitCode, null, message);
    assert.equal(child.signalCode, null, message);
  }
  try {
    await response('ready');
    assertAlive('Native file holder must remain alive after readiness.');
    receipt.nodeAccess.push({ phase: 'before-operation', ...await nodeAccess(filename) });
  } catch (error) { receipt.error = error.message; await stop(); throw error; }
  let released;
  return {
    async inspect() {
      assertAlive('Native file holder must remain alive throughout the operation.');
      child.stdin.write('inspect\n'); await response('held');
      receipt.nodeAccess.push({ phase: 'after-operation', ...await nodeAccess(filename) });
    },
    release() {
      return released ??= (async () => {
        try {
          assertAlive('Native file holder must remain alive until release.');
          child.stdin.end('release\n'); await response('released');
          receipt.completion = await completion;
          assert.deepEqual(receipt.completion, { code: 0, signal: null });
          receipt.afterSha256 = hash(await readFile(filename));
        } catch (error) { receipt.error = error.message; throw error; }
        finally { await stop(); }
        return receipt;
      })();
    },
  };
}
