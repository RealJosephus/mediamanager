import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compileOracle, recordOracle } from '../../tools/validation/oracle.js';
import { describeFile, sha256 } from '../../tools/validation/inventory.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet'];

test('prepared oracle processes retain independent inputs and state while rejecting changed source, artifacts and receipt', {
  timeout: 180000,
}, async t => {
  const root = await mkdtemp(path.join(validationOutputRoot(), 'prepared-oracle-')); assertValidationOutputChild(root);
  const source = path.join(root, 'source'); await mkdir(source);
  for (const name of ['Oracle.csproj', 'Program.cs']) {
    await copyFile(new URL('./fixtures/prepared-oracle/' + name, import.meta.url), path.join(source, name));
  }
  const project = path.join(source, 'Oracle.csproj'), buildRoot = path.join(root, 'build');
  const secret = 'Unrelated environment credential must stay private';
  const environment = { ...process.env, ORACLE_FIXTURE_VALUE: 'Captured environment', ORACLE_FIXTURE_SECRET: secret };
  const pending = compileOracle({ project, output: buildRoot, environment });
  environment.ORACLE_FIXTURE_VALUE = 'Changed after owner creation';
  const owner = await pending;
  const receiptFile = path.join(buildRoot, 'oracle-build.json'), receipt = await describeFile(receiptFile);
  const recordedBuild = JSON.parse(await readFile(receiptFile, 'utf8'));
  assert.equal(recordedBuild.kind, 'oracle-build'); assert.equal(recordedBuild.passed, true);
  assert.deepEqual(recordedBuild.sourceFiles, owner.buildRecord.sourceFiles);
  assert.equal(JSON.stringify(recordedBuild).includes(secret), false);
  const observations = [];
  for (const [name, bytes] of [['initial', Buffer.from('First input\0東京')], ['repeat', Buffer.from([0xff, 0, 13, 10, 0x7f])]]) {
    const input = path.join(root, name + '.bin'); await writeFile(input, bytes);
    const output = path.join(root, name), record = await owner.record({ output, args: [input, '{output}/native.json'] });
    const nativeBytes = await readFile(path.join(output, 'native.json')), native = JSON.parse(nativeBytes);
    assert.equal(record.executionKind, 'prepared-build'); assert.equal(record.build.executed, false);
    assert.equal(record.build.receipt.sha256, receipt.sha256);
    assert.equal(record.passed, true); assert.equal(record.process.status, 0);
    assert.equal(native.processId, record.process.pid);
    assert.equal(native.inputSha256, sha256(bytes)); assert.equal(native.inputBase64, bytes.toString('base64'));
    assert.equal(native.environmentValue, 'Captured environment'); assert.equal(native.outputRoot, output);
    assert.equal(native.previousState, null); assert.equal(await readFile(path.join(output, 'state.txt'), 'utf8'), sha256(bytes));
    assert.equal(record.outputs.find(value => value.filename === path.join(output, 'native.json')).sha256, sha256(nativeBytes));
    assert.equal(record.verification.before.buildReceipt.sha256, receipt.sha256);
    assert.equal(record.verification.after.buildReceipt.sha256, receipt.sha256);
    assert.equal(record.verification.before.artifactsSha256, record.verification.after.artifactsSha256);
    assert.equal(JSON.stringify(record).includes(secret), false);
    observations.push(native);
  }
  assert.notEqual(observations[0].processId, observations[1].processId, 'Each recording must execute its own real process.');
  const input = path.join(root, 'initial.bin');
  await assert.rejects(owner.record({ output: path.join(root, 'initial'), args: [input, '{output}/native.json'] }), { code: 'EEXIST' });

  const changes = [
    { name: 'source', filename: path.join(source, 'Program.cs'), change: bytes => Buffer.concat([bytes, Buffer.from('\n// Changed source.\n')]) },
    { name: 'assembly', filename: owner.buildRecord.oracleAssembly.filename, change: bytes => {
      const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; return changed;
    } },
    { name: 'receipt', filename: receiptFile, change: bytes => {
      const value = JSON.parse(bytes); value.build.status = 23; return Buffer.from(JSON.stringify(value));
    } },
  ];
  for (const change of changes) {
    const bytes = await readFile(change.filename), timing = await stat(change.filename);
    const output = path.join(root, 'rejected-' + change.name);
    try {
      await writeFile(change.filename, change.change(bytes)); await utimes(change.filename, timing.atime, timing.mtime);
      await assert.rejects(owner.record({ output, args: [input, '{output}/native.json'] }), /Prepared oracle input changed/u);
      assert.deepEqual(await readdir(output), [], 'Rejected input must not execute the fixture or publish process output.');
    } finally { await writeFile(change.filename, bytes); }
  }

  const runtimeConfiguration = path.join(path.dirname(owner.buildRecord.oracleAssembly.filename), 'Oracle.runtimeconfig.json');
  const originalConfiguration = await readFile(runtimeConfiguration), changedOutput = path.join(root, 'changed-during-process');
  try {
    await assert.rejects(owner.record({ output: changedOutput, args: [input, '{output}/native.json', runtimeConfiguration] }), /Prepared oracle input changed/u);
    const changed = JSON.parse(await readFile(path.join(changedOutput, 'record.json'), 'utf8'));
    assert.equal(changed.passed, false); assert.equal(changed.process.status, 0);
    assert.equal((JSON.parse(await readFile(path.join(changedOutput, 'native.json'), 'utf8'))).processId, changed.process.pid);
    assert.match(changed.verification.failure.message, /Oracle\.runtimeconfig\.json/u);
  } finally { await writeFile(runtimeConfiguration, originalConfiguration); }
  const recovered = await owner.record({ output: path.join(root, 'recovered'), args: [input, '{output}/native.json'] });
  assert.equal(recovered.passed, true); assert.equal((await describeFile(receiptFile)).sha256, receipt.sha256);

  const singleRoot = path.join(root, 'single-call');
  const single = await recordOracle({ project, output: singleRoot, args: [input, '{output}/native.json'], environment });
  assert.equal(single.passed, true); assert.equal(single.build.status, 0); assert.equal(single.process.status, 0);
  assert.equal(single.oracleAssembly.filename, path.join(singleRoot, 'bin', 'Release', 'net10.0', 'Oracle.dll'));
  assert.equal((JSON.parse(await readFile(path.join(singleRoot, 'native.json'), 'utf8'))).inputSha256, sha256(await readFile(input)));
  t.diagnostic(JSON.stringify({ output: root, independentProcesses: true, preparedBuildDriftRejected: true }));
});
