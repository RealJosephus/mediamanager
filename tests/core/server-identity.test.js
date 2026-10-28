import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ServerIdentity, readServerIdentity, isServerIdentity, decodeServerIdentity } from '../../src/core/server-identity.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { identityObservation, identityFileAccessObservation } from './fixtures/server-identity/current/observations.js';
import { consumeServerIdentityFiles, currentServerIdentity, input } from './server-identity-current.js';
import { holdNativeFile } from './native-file-holder.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const nodeFiles = [];

test('server identity reads and repairs the actual target of its configured linked directory', async t => {
  const root = path.join(validationOutputRoot(), 'identity-linked-directory'); await fs.mkdir(root);
  const target = path.join(root, 'target'), alias = path.join(root, 'alias'); await fs.mkdir(target);
  const filename = path.join(target, 'device.txt'), original = 'E5900000-0000-0000-0000-000000000001';
  await fs.writeFile(filename, original);
  await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const errors = [], owner = new ServerIdentity({ dataPath: alias, onError: error => errors.push(error) });
    assert.equal(await owner.getValue(), original); assert.equal(await readServerIdentity(alias), original);
    assert.equal(await fs.readFile(filename, 'utf8'), original);
    await fs.writeFile(filename, 'invalid linked identity');
    let rejectedInput;
    try { decodeServerIdentity(Buffer.from('invalid linked identity')); } catch (error) { rejectedInput = error; }
    const repairErrors = [], repair = new ServerIdentity({ dataPath: alias, onError: error => repairErrors.push(error) });
    const repaired = await repair.getValue(); assert.equal(isServerIdentity(repaired), true);
    assert.equal(await readServerIdentity(target), repaired); assert.equal(await readServerIdentity(alias), repaired);
    assert.deepEqual(await fs.readFile(path.join(alias, 'device.txt')), await fs.readFile(filename));
    assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
    const failureFields = error => ({ message: error.message, code: error.code, status: error.status, statusCode: error.statusCode,
      ...(error.cause !== undefined && { cause: failureFields(error.cause) }),
      ...(error.errors !== undefined && { errors: Array.from(error.errors, failureFields) }) });
    for (const error of repairErrors) assert.deepEqual(failureFields(error), failureFields(rejectedInput));
    const observation = { original, repaired, filename, alias, initialDiagnostics: errors,
      errors: repairErrors.map(error => ({ ...failureFields(error), stack: error.stack })),
      retainedTarget: (await fs.readFile(filename)).toString('base64') };
    await fs.writeFile(path.join(root, 'linked-observation.json'), JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' });
    t.diagnostic(JSON.stringify(observation));
    await consumeServerIdentityFiles([{ name: 'linked-target-repaired', filename, serverId: repaired }], path.join(root, 'native-cold-read'));
  } finally { await fs.unlink(alias); }
});

test('server identity evidence binds real DeviceId, files, source and independent generated-ID observations', async () => {
  const { native, repeat, report } = await currentServerIdentity();
  assert.equal(report.nativeExecutionRecorded, true);
  assert.deepEqual(native.results.map(identityObservation), repeat.results.map(identityObservation));
  assert.deepEqual(native.results.filter(row => row.accessibleControl).map(row => identityObservation(row.accessibleControl)),
    repeat.results.filter(row => row.accessibleControl).map(row => identityObservation(row.accessibleControl)));
});

for (const sample of input) test('native server identity lifecycle: ' + sample.name, async () => {
  const { native, record } = await currentServerIdentity();
  const root = path.join(path.resolve(validationOutputRoot()), 'identity-' + sample.name); await fs.mkdir(root);
  const filename = path.join(root, 'device.txt'); if (sample.bytes != null) await fs.writeFile(filename, Buffer.from(sample.bytes, 'base64'));
  if (sample.directory) await fs.mkdir(filename); if (sample.readOnly) await fs.chmod(filename, 0o444);
  const errors = [], owner = new ServerIdentity({ dataPath: root, onError: error => errors.push(error.message) });
  let holder, value, cachedValue;
  const lock = sample.lock ? {} : null;
  try {
    if (sample.lock) holder = await holdNativeFile({ record, filename, mode: sample.lock, receipt: lock });
    [value, cachedValue] = await Promise.all([owner.getValue(), owner.getValue()]);
    await holder?.inspect();
  } finally {
    try { await holder?.release(); }
    finally { if (lock) await fs.writeFile(path.join(root, 'lock.json'), JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' }); }
  }
  const afterBytes = await fs.readFile(filename).then(bytes => bytes.toString('base64'), () => null);
  if (sample.readOnly) await fs.chmod(filename, 0o666);
  const reopenedValue = await new ServerIdentity({ dataPath: root }).getValue();
  const reopenedBytes = await fs.readFile(filename).then(bytes => bytes.toString('base64'), () => null);
  const actual = { name: sample.name, value, cachedValue, reopenedValue, beforeBytes: sample.bytes ?? null, afterBytes, reopenedBytes, afterDirectory: (await fs.stat(filename)).isDirectory(), validGuid: isServerIdentity(value) };
  const expected = native.results.find(row => row.name === sample.name);
  let nativeRead;
  if (expected.reopenedBytes != null) {
    const bytes = await fs.readFile(expected.filename);
    assert.equal(bytes.toString('base64'), expected.reopenedBytes);
    nativeRead = { filename: expected.filename, sha256: hash(bytes), value: await readServerIdentity(path.dirname(expected.filename)) };
    assert.equal(nativeRead.value, expected.reopenedValue);
  }
  if (reopenedBytes != null) nodeFiles.push({ name: sample.name, filename, serverId: reopenedValue });
  const admission = lock ? lock.nodeAccess.find(value => value.phase === 'before-operation') : null;
  const proof = { actual, expected, errors, lock, nativeRead, admission };
  try {
    if (admission) {
      proof.functionalAccess = identityFileAccessObservation(actual, admission, expected.accessibleControl, errors);
      const nativeAccess = expected.fileSharing.before;
      proof.nativeFunctionalAccess = identityFileAccessObservation(expected,
        { read: nativeAccess.read, write: nativeAccess.sharedWrite }, expected.accessibleControl);
    } else assert.deepEqual(identityObservation(actual), identityObservation(expected));
  } finally { await fs.writeFile(path.join(root, 'observation.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' }); }
  if (reopenedBytes != null) assert.equal(await readServerIdentity(root), reopenedValue);
});

test('actual Native DeviceId reopens every readable Node identity after generation, repair and lock release', async () => {
  assert.deepEqual(nodeFiles.map(row => row.name), input.filter(row => !row.directory).map(row => row.name));
  await consumeServerIdentityFiles(nodeFiles, path.join(validationOutputRoot(), 'identity-node-files'));
});

