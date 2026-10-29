import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { darwinProcessInspector } from '../../tools/ci/macos-process-identity.js';
import { signalProcess } from '../../tools/ci/macos-process-signal.js';

assert.equal(process.platform, 'darwin');
const inspector = await darwinProcessInspector(), filename = fileURLToPath(import.meta.url);
const children = new Map();
const describeFailure = reason => ({ name: reason?.name, message: reason?.message, code: reason?.code,
  syscall: reason?.syscall, errno: reason?.errno, stack: reason?.stack });

if (process.argv[2] === '--exec-report') {
  process.stdout.write(JSON.stringify({ kind: 'executed', identity: inspector.identity(process.pid) }) + '\n');
  process.stdin.resume();
} else {
  assert.equal(typeof process.send, 'function');
  process.on('message', async request => {
    try {
      let value;
      if (request.kind === 'inspect') value = inspector.identity(request.pid);
      else if (request.kind === 'descendants') value = inspector.descendants(request.identity);
      else if (request.kind === 'signal') value = signalProcess(inspector, request.identity, request.signal);
      else if (request.kind === 'spawn') {
        const child = spawn(process.execPath, [filename], { windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: process.env });
        let stderr = '';
        child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-65536); });
        const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
        children.set(request.name, { child, closed });
        value = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('message', message => message?.kind === 'ready' ? resolve(message.identity)
            : reject(new Error('Unexpected process owner admission.')));
          child.once('exit', () => reject(new Error('The process owner exited before admission: ' + stderr)));
        });
      } else if (request.kind === 'wait') {
        const owned = children.get(request.name); assert.ok(owned, 'The requested process was never owned.');
        value = await owned.closed;
      } else if (request.kind === 'close') {
        const failures = [];
        for (const { child } of children.values()) if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch (reason) { failures.push(reason); }
        }
        await Promise.all([...children.values()].map(owner => owner.closed));
        if (failures.length) throw new AggregateError(failures, 'Process fixture children did not close.');
        process.send({ requestId: request.requestId, value: { closedChildren: children.size } }, () => process.disconnect());
        return;
      } else throw new Error('Unknown process owner operation.');
      process.send({ requestId: request.requestId, value });
    } catch (reason) { process.send({ requestId: request.requestId, error: describeFailure(reason) }); }
  });
  process.on('disconnect', () => {
    for (const { child } of children.values()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  process.send({ kind: 'ready', identity: inspector.identity(process.pid) });
}
