import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopNativeReference } from '../../tools/compat/native-shutdown.js';

async function ownedProcess(t, { status, exit }) {
  const source = `const http=require('node:http');const server=http.createServer((req,res)=>{
    res.writeHead(${status});res.end();${exit ? 'setTimeout(()=>server.close(()=>process.exit(0)),10);' : ''}
  });server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\\n'));`;
  const child = spawn(process.execPath, ['-e', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } });
  const [bytes] = await once(child.stdout, 'data');
  const origin = 'http://127.0.0.1:' + Number(bytes.toString().trim());
  return { child, request: async () => {
    const response = await fetch(origin + '/System/Shutdown', { method: 'POST', signal: AbortSignal.timeout(1000) });
    await response.body?.cancel(); return response.status;
  } };
}

test('owned process verifies a successful HTTP shutdown and a normal exit', async t => {
  const { child, request } = await ownedProcess(t, { status: 204, exit: true });
  let record;
  await stopNativeReference(child, request, value => { record = value; }, { timeoutMilliseconds: 2000 });
  assert.deepEqual({ status: record.shutdownStatus, forced: record.forced, code: record.exitCode, signal: record.signalCode },
    { status: 204, forced: false, code: 0, signal: null });
});

test('an error HTTP response cannot verify a write barrier even when the process exits normally', async t => {
  const { child, request } = await ownedProcess(t, { status: 500, exit: true });
  let record;
  await assert.rejects(stopNativeReference(child, request, value => { record = value; }, { timeoutMilliseconds: 2000 }), /HTTP 204/u);
  assert.equal(record.shutdownStatus, 500); assert.equal(record.exitCode, 0); assert.equal(record.stopped, true);
});

test('forced shutdown reclaims the process and rejects a successful HTTP response as a write barrier', async t => {
  const { child, request } = await ownedProcess(t, { status: 204, exit: false });
  let record;
  await assert.rejects(stopNativeReference(child, request, value => { record = value; }, { timeoutMilliseconds: 100 }), /HTTP 204/u);
  assert.equal(record.shutdownStatus, 204); assert.equal(record.forced, true); assert.equal(record.stopped, true);
});
