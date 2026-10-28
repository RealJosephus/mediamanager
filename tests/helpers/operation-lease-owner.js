import { acquireOperationLease } from '../../src/migration/operation-lease.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

// File descriptors do not keep Node alive. This test process explicitly owns a
// live IPC channel while the parent observes, kills and reacquires its lease.
process.on('message', () => {});
const identity = process.env.MM_LEASE_TEST_IDENTITY;
const describe = kind => ({ kind, pid: process.pid, uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null });
if (process.env.MM_LEASE_TEST_HOLD_PREPARATION === 'true') {
  const prefix = path.join('/Users/Shared/mediamanager-operation-leases', createHash('sha256').update(identity).digest('hex') + '.lock.');
  const originalOpen = fs.promises.open;
  fs.promises.open = async (...args) => {
    const file = await originalOpen(...args);
    if (typeof args[0] === 'string' && args[0].startsWith(prefix) && args[0].endsWith('.preparing')) {
      file.chmod = async () => {
        const metadata = await file.stat({ bigint: true });
        process.send({ ...describe('preparing'), filename: args[0], dev: String(metadata.dev), ino: String(metadata.ino) });
        await new Promise(() => {});
      };
    }
    return file;
  };
  syncBuiltinESMExports();
}
const lease = await acquireOperationLease(identity);
lease.assertHeld();
process.send(describe('held'));
