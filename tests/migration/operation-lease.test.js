import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { acquireOperationLease } from '../../src/migration/operation-lease.js';

test('operation leases exclude another process and the kernel releases a killed owner', { timeout: 30000 }, async t => {
  const identity = 'operation-lease-test-' + randomUUID();
  const owner = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireOperationLease } from ${JSON.stringify(new URL('../../src/migration/operation-lease.js', import.meta.url).href)};
    const lease = await acquireOperationLease(process.env.MM_LEASE_TEST_IDENTITY);
    lease.assertHeld();
    process.send('held');
  `], { env: { ...process.env, MM_LEASE_TEST_IDENTITY: identity }, windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = '';
  owner.stderr.on('data', bytes => { diagnostics += bytes; });
  const exited = new Promise(resolve => owner.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (owner.exitCode == null && owner.signalCode == null) owner.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => {
    owner.once('error', reject);
    owner.once('message', message => message === 'held' ? resolve() : reject(new Error('Unexpected lease owner message.')));
    owner.once('exit', () => reject(new Error('Lease owner exited before admission: ' + diagnostics)));
  });
  await assert.rejects(acquireOperationLease(identity), /already active/);
  owner.kill('SIGKILL');
  await exited;
  const lease = await acquireOperationLease(identity);
  t.after(() => lease.release());
  lease.assertHeld();
  const releasing = lease.release();
  assert.equal(lease.release(), releasing);
  await releasing;
  assert.throws(() => lease.assertHeld(), /no longer held/);
});
