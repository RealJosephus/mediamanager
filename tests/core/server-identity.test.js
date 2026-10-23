import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ServerIdentity, readServerIdentity, isServerIdentity } from '../../src/core/server-identity.js';
import { validationOutputRoot, validationExecutable } from '../../tools/validation/paths.js';
import { identityObservation } from './fixtures/server-identity/observations.js';
import { currentServerIdentity, input } from './server-identity-current.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('server identity evidence binds real DeviceId, files, source and independent generated-ID observations', async () => {
  const { native, repeat, report } = await currentServerIdentity();
  assert.equal(report.nativeExecutionRecorded, true);
  assert.deepEqual(native.results.map(identityObservation), repeat.results.map(identityObservation));
});

async function lockFile(filename, mode) {
  const { record } = await currentServerIdentity();
  assert.equal(hash(await fs.readFile(record.oracleAssembly.filename)), record.oracleAssembly.sha256);
  const child = spawn(validationExecutable('dotnet'), [record.oracleAssembly.filename, 'hold-file', filename, mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const completion = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', error => resolve({ error: error.message })); });
  let stdout = '', stderr = '', timer;
  child.stderr.on('data', bytes => { stderr += bytes; });
  try { await new Promise((resolve, reject) => {
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.includes('READY')) resolve(); });
    child.once('error', reject); child.once('exit', () => reject(new Error('Identity lock holder exited before readiness.')));
    timer = setTimeout(() => reject(new Error('Identity lock holder did not become ready.')), 5000); timer.unref();
  }); } catch (error) { child.kill(); await completion; throw error; } finally { clearTimeout(timer); }
  return async () => { child.stdin.end('\n'); const outcome = await completion; assert.deepEqual(outcome, { code: 0, signal: null }); return { pid: child.pid, outcome, stderr }; };
}

for (const sample of input) test('native server identity lifecycle: ' + sample.name, async () => {
  const { native } = await currentServerIdentity();
  const root = path.join(path.resolve(validationOutputRoot()), 'identity-' + sample.name); await fs.mkdir(root);
  const filename = path.join(root, 'device.txt'); if (sample.bytes != null) await fs.writeFile(filename, Buffer.from(sample.bytes, 'base64'));
  if (sample.directory) await fs.mkdir(filename); if (sample.readOnly) await fs.chmod(filename, 0o444);
  const errors = [], owner = new ServerIdentity({ dataPath: root, onError: error => errors.push(error.message) });
  let release, lock, value, cachedValue;
  try { if (sample.lock) release = await lockFile(filename, sample.lock); [value, cachedValue] = await Promise.all([owner.getValue(), owner.getValue()]); }
  finally { lock = await release?.(); }
  const afterBytes = await fs.readFile(filename).then(bytes => bytes.toString('base64'), () => null);
  if (sample.readOnly) await fs.chmod(filename, 0o666);
  const reopenedValue = await new ServerIdentity({ dataPath: root }).getValue();
  const actual = { name: sample.name, value, cachedValue, reopenedValue, beforeBytes: sample.bytes ?? null, afterBytes, afterDirectory: (await fs.stat(filename)).isDirectory(), validGuid: isServerIdentity(value) };
  const expected = native.results.find(row => row.name === sample.name);
  await fs.writeFile(path.join(root, 'observation.json'), JSON.stringify({ actual, expected, errors, lock }, null, 2) + '\n', { flag: 'wx' });
  assert.deepEqual(identityObservation(actual), identityObservation(expected));
  if (actual.afterBytes != null && isServerIdentity(Buffer.from(actual.afterBytes, 'base64').toString('utf8').replace(/^\ufeff/u, ''))) assert.equal(await readServerIdentity(root), reopenedValue);
});

test('server identity refuses linked state before reading or generating an external identity', async () => {
  const root = path.join(path.resolve(validationOutputRoot()), 'identity-links'); await fs.mkdir(root);
  const external = path.join(root, 'external'); await fs.mkdir(external); const file = path.join(external, 'device.txt'), original = Buffer.from('e5900000000000000000000000000001'); await fs.writeFile(file, original);
  const link = path.join(root, 'data'); await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(new ServerIdentity({ dataPath: link }).getValue(), { code: 'unsafe-configuration-path' }); await assert.rejects(readServerIdentity(link), { code: 'unsafe-configuration-path' }); }
  finally { await fs.unlink(link); }
  assert.deepEqual(await fs.readFile(file), original);
});
