import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { validationExecutable } from '../../../../tools/validation/paths.js';
import { describeFile } from '../../../../tools/validation/inventory.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, filename) => {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

async function nodeAccess(filename, mode, deletionProbePath) {
  let read, operation;
  try { read = { succeeded: true, bytes: (await fs.readFile(filename)).toString('base64') }; }
  catch (error) { read = { succeeded: false, error: { code: error.code, message: error.message } }; }
  try {
    if (mode === 'delete') await fs.unlink(deletionProbePath);
    else { const handle = await fs.open(filename, 'r+'); await handle.close(); }
    operation = { succeeded: true };
  } catch (error) { operation = { succeeded: false, error: { code: error.code, message: error.message } }; }
  return { read, operation };
}

/** Real current Native handles; Node measures its own admission before mutation. */
export async function holdMutationFile({ record, filename, mode, receipt }) {
  assert.ok(['write', 'delete'].includes(mode));
  const executable = validationExecutable('dotnet');
  assert.equal(hash(await fs.readFile(executable)), record.dotnet.sha256);
  assert.equal(hash(await fs.readFile(record.oracleAssembly.filename)), record.oracleAssembly.sha256);
  const helperDirectory = path.dirname(record.oracleAssembly.filename), helperBefore = await describeFile(helperDirectory);
  const args = [record.oracleAssembly.filename, 'hold-file', filename, mode];
  Object.assign(receipt, { executable, args, filename, mode, beforeSha256: hash(await fs.readFile(filename)), messages: [], helperBefore });
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
      if (pending) fail(new Error('Native holder ended before acknowledging the request.'));
    });
  });
  async function response(phase) {
    if (failure) throw failure;
    let timer;
    try {
      const message = queue.length ? queue.shift() : await new Promise((resolve, reject) => {
        if (completed) { reject(new Error('Native holder ended before acknowledging the request.')); return; }
        pending = { resolve, reject };
        timer = setTimeout(() => fail(new Error('Native holder did not acknowledge ' + phase + '.')), 5000); timer.unref();
      });
      assert.equal(message.phase, phase); assert.equal(path.resolve(message.filename), path.resolve(filename));
      assert.equal(message.mode, mode); assert.equal(message.pid, child.pid); return message;
    } finally { clearTimeout(timer); }
  }
  function alive() { assert.equal(completed, undefined); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); }
  async function stop() { if (!completed) child.kill(); receipt.completion = await completion; receipt.stderr = stderr; lines.close(); }
  try {
    const ready = await response('ready'); alive();
    if (mode === 'delete') assert.equal(ready.deletionProbePath, filename + '.admission-probe');
    receipt.admission = await nodeAccess(filename, mode, ready.deletionProbePath);
  } catch (error) { receipt.error = error.message; await stop(); throw error; }
  let released;
  return {
    async inspect() { alive(); child.stdin.write('inspect\n'); await response('held'); alive(); },
    release() {
      return released ??= (async () => {
        try {
          alive(); child.stdin.end('release\n'); await response('released');
          receipt.completion = await completion; assert.deepEqual(receipt.completion, { code: 0, signal: null });
          receipt.loadedAssemblies = JSON.parse(stderr.trim());
          const dotnetRoot = path.dirname(executable);
          for (const assembly of receipt.loadedAssemblies) {
            assert.ok(inside(helperDirectory, assembly.filename) || inside(dotnetRoot, assembly.filename), assembly.filename);
            assert.equal((await describeFile(assembly.filename)).sha256, assembly.sha256, assembly.filename);
          }
          assert.equal(hash(await fs.readFile(executable)), record.dotnet.sha256);
          receipt.helperAfter = await describeFile(helperDirectory); assert.deepEqual(receipt.helperAfter, helperBefore);
          receipt.afterFile = await describeFile(filename);
        } catch (error) { receipt.error = error.message; throw error; }
        finally { await stop(); }
        return receipt;
      })();
    },
  };
}
