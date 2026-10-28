import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';
import { projectResetObservation } from './password-reset-current-observations.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const profileUrl = new URL('./fixtures/password-reset-http-current/current-profile.json', import.meta.url);
export const passwordResetInput = JSON.parse(await readFile(new URL('input.json', profileUrl), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(String(entry)) : entry, 2) + '\n';
let pending;
export const currentPasswordResetHttp = () => pending ??= capture();

async function capture() {
  const profile = JSON.parse(await readFile(profileUrl, 'utf8'));
  const output = path.join(validationOutputRoot(), 'password-reset-http-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const report = { schemaVersion: 1, scope: profile.scope, inputs: [], sourceBindings: [], captures: [],
    nativeExecutionRecorded: false, independentRepeatAgrees: false, actualNativeInstance: false,
    phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, profileUrl)));
      assert.equal(actual.available, true, expected.filename);
      assert.equal(actual.bytes, expected.bytes, expected.filename);
      assert.equal(actual.sha256, expected.sha256, expected.filename);
      report.inputs.push({ role: expected.role, ...actual });
    }
    assert.equal(passwordResetInput.length, profile.cases.total);
    assert.equal(new Set(passwordResetInput.map(sample => sample.name)).size, profile.cases.total);
    assert.equal(passwordResetInput.filter(sample => sample.mode === 'snapshot').length, profile.cases.snapshots);
    assert.equal(passwordResetInput.filter(sample => sample.mode !== 'snapshot').length, profile.cases.http);
    assert.equal(passwordResetInput.filter(sample => sample.mode !== 'snapshot').reduce((count, sample) => count + (sample.steps?.length ?? 1), 0), profile.cases.requests);
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const pinned = manifest.files.find(entry => entry.path === relative); assert.ok(pinned, relative);
      const source = await describeFile(path.join(build.root, 'source', relative));
      assert.equal(source.sha256, pinned.sha256, relative);
      report.sourceBindings.push({ relativePath: relative, source });
    }
    const inputBytes = await readFile(new URL('input.json', profileUrl)), inputFile = path.join(output, 'consumer-input.json');
    await writeFile(inputFile, inputBytes, { flag: 'wx' }); report.consumerInput = await describeFile(inputFile);
    const project = fileURLToPath(new URL(profile.inputs.find(entry => entry.role === 'oracleProject').filename, profileUrl));
    const natives = [], projections = [];
    for (let iteration = 1; iteration <= 2; iteration++) {
      const directory = path.join(output, 'native-' + iteration);
      const record = await recordOracle({ project, output: directory, args: [inputFile, '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      const capture = { iteration, record, observation: await describeFile(filename), sqliteDatabases: [] };
      report.captures.push(capture);
      assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, sha(bytes));
      assert.equal(native.inputSha256, sha(inputBytes));
      for (const field of ['actualExecution', 'actualController', 'actualBinding', 'actualUserManager', 'actualDefaultProvider',
        'actualEfSqlite', 'actualCrypto', 'eventsControlled', 'networkControlled']) assert.equal(native[field], true, field);
      assert.equal(native.actualNativeInstance, false);
      for (const assembly of native.assemblies) {
        const actual = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
        assert.equal(actual.available, true); assert.equal(actual.sha256, assembly.sha256, assembly.name);
      }
      const sqliteNative = await describeFile(path.join(build.runtime, 'runtimes', native.sqliteNative.runtimeIdentifier, 'native', native.sqliteNative.name));
      assert.equal(sqliteNative.available, true); assert.equal(sqliteNative.sha256, native.sqliteNative.sha256);
      assert.deepEqual(native.results.map(value => value.name), passwordResetInput.map(value => value.name));
      const projected = [];
      for (const [index, row] of native.results.entries()) {
        const sample = passwordResetInput[index];
        assert.equal(row.observations.length, sample.mode === 'snapshot' ? 1 : sample.steps?.length ?? 1, sample.name);
        const database = await describeFile(row.DatabaseFile); assert.equal(database.available, true, sample.name);
        capture.sqliteDatabases.push({ name: sample.name, ...database });
        for (const observation of [{ files: row.beforeFiles }, ...row.observations]) for (const file of observation.files) {
          if (file.directory) continue;
          const bytes = Buffer.from(file.bytesBase64, 'base64');
          assert.equal(new TextDecoder().decode(bytes), file.text, sample.name + '/' + file.name);
        }
        projected.push(await projectResetObservation(row));
      }
      natives.push(native); projections.push(projected);
    }
    await writeFile(path.join(output, 'native-comparison.json'), json({ first: projections[0], repeat: projections[1] }), { flag: 'wx' });
    assert.deepEqual(projections[1], projections[0], 'independent current Native observations agree on HTTP, rows, files and commit prefixes');
    report.nativeExecutionRecorded = true; report.independentRepeatAgrees = true;
    const candidates = path.join(output, 'candidate'); await mkdir(candidates);
    const recordCandidate = async row => {
      assert.match(row.name, /^[a-z-]+$/u);
      await writeFile(path.join(candidates, row.name + '.json'), json(row), { flag: 'wx' });
    };
    return { input: passwordResetInput, native: natives[0], repeat: natives[1], projections: projections[0], output, report, recordCandidate };
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}
