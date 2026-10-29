import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { darwinProcessInspector, sameProcessIdentity } from './macos-process-identity.js';

const thisFile = fileURLToPath(import.meta.url);

export function signalProcess(inspector, expected, signal) {
  assert.ok(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'].includes(signal));
  assert.ok(expected?.pid > 1, 'Refusing to signal a system process.');
  const current = inspector.identity(expected.pid);
  if (!sameProcessIdentity(current, expected)) return false;
  if (current.uid !== process.getuid() && process.getuid() !== 0) {
    assert.equal(current.uid, 0, 'Only an explicitly bound root descendant may require elevated cleanup.');
    // Recheck inside the elevated process, after sudo has actually admitted it.
    const output = execFileSync('/usr/bin/sudo', ['-n', process.execPath, thisFile, '--signal', JSON.stringify(current), signal],
      { encoding: 'utf8', timeout: 15000, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    const result = JSON.parse(output); assert.equal(typeof result.signalled, 'boolean'); return result.signalled;
  }
  try { process.kill(current.pid, signal); return true; }
  catch (reason) { if (reason?.code === 'ESRCH') return false; throw reason; }
}

if (process.argv[1] === thisFile && process.argv[2] === '--signal') {
  assert.equal(process.argv.length, 5); assert.equal(process.getuid(), 0);
  const expected = JSON.parse(process.argv[3]); assert.equal(expected.uid, 0);
  const inspector = await darwinProcessInspector();
  process.stdout.write(JSON.stringify({ signalled: signalProcess(inspector, expected, process.argv[4]) }) + '\n');
}
