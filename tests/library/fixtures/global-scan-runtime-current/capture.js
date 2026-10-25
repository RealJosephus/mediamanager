import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLosslessJson } from '../../../../src/core/json.js';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const root = new URL('./', import.meta.url);
const inputFile = new URL('../global-scan-runtime/input.json', root);
export const globalScanRuntimeInputBytes = await readFile(inputFile);
const inputs = JSON.parse(globalScanRuntimeInputBytes), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
let pending;
export const currentGlobalScanRuntime = () => pending ??= capture();

async function capture() {
  const profile = JSON.parse(await readFile(new URL('current-profile.json', root), 'utf8'));
  const output = assertValidationOutputChild(path.join(validationOutputRoot(), 'global-scan-runtime-current-' + randomUUID()));
  await mkdir(output);
  const report = { identity: profile.kind, inputs: [], sourceBindings: [], nativeExecutionRecorded: false,
    historicalRecordingReused: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    assert.equal(profile.kind, 'same-workflow-current-native-global-scan-runtime');
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, root)));
      assert.equal(actual.available, true, expected.filename); assert.equal(actual.bytes, expected.bytes, expected.filename);
      assert.equal(actual.sha256, expected.sha256, expected.filename); report.inputs.push({ role: expected.role, ...actual });
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relativePath of profile.sourcePaths) {
      const expected = manifest.files.find(entry => entry.path === relativePath); assert.ok(expected, relativePath);
      const source = await describeFile(path.join(build.root, 'source', relativePath));
      assert.equal(source.sha256, expected.sha256, relativePath); report.sourceBindings.push({ relativePath, source });
    }
    const record = await recordOracle({ project: fileURLToPath(new URL('Oracle.csproj', root)),
      output: path.join(output, 'native'), args: [fileURLToPath(inputFile), '{output}'] });
    const filename = path.join(output, 'native/native.json'), bytes = await readFile(filename);
    const native = parseLosslessJson(bytes.toString('utf8'));
    report.capture = { record, observation: await describeFile(filename) };
    assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
    assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, sha(bytes));
    assert.equal(native.identity, profile.kind); assert.equal(native.actualCancellationObservation, true);
    assert.equal(native.actualGlobalScan, true); assert.equal(native.actualBaseItemReader, true);
    assert.equal(native.inputSha256, sha(globalScanRuntimeInputBytes));
    assert.deepEqual(native.results.map(entry => entry.scenario.Name), inputs.map(input => input.Name));
    const required = ['jellyfin', 'Emby.Server.Implementations', 'MediaBrowser.Controller', 'MediaBrowser.Providers', 'Jellyfin.Server.Implementations'];
    for (const name of required) assert.ok(native.assemblies.some(assembly => assembly.name === name), name);
    for (const assembly of native.assemblies) {
      const runtime = build.manifest.files.find(entry => entry.path === assembly.name + '.dll');
      const relative = path.relative(build.sdkRoot, assembly.path).replaceAll('\\', '/');
      const sdk = build.sdkAfter.files.find(entry => entry.path === relative);
      const expected = assembly.name === 'Oracle' ? record.oracleAssembly : runtime ?? sdk;
      assert.ok(expected, assembly.name); assert.equal(assembly.sha256, expected.sha256, assembly.name);
      assert.equal((await describeFile(assembly.path)).sha256, expected.sha256, assembly.name);
    }
    for (const entry of native.results) {
      assert.equal(typeof entry.observation.Cancelled, 'boolean', entry.scenario.Name);
      if (entry.observation.Cancelled) assert.notEqual(entry.observation.Exception, null);
      assertValidationOutputChild(entry.caseRoot);
      const release = JSON.parse(await readFile(path.join(entry.caseRoot, 'release.json'), 'utf8'));
      assert.equal(release.completed, true, entry.scenario.Name);
    }
    const after = await verifyNativeBuild(); assert.equal(after.identitySha256, build.identitySha256);
    report.nativeExecutionRecorded = true;
    const cases = native.results.map(entry => ({ name: entry.scenario.Name, input: entry.scenario,
      nativeCaseRoot: entry.caseRoot, nativeProgramDataPath: entry.programRoot, nativeMediaRoot: entry.mediaRoot,
      window: { start: Date.parse(entry.startedAt), end: Date.parse(entry.completedAt) },
      exception: entry.observation.Exception, cancelled: entry.observation.Cancelled, scanRunning: entry.observation.ScanRunning,
      roots: entry.observation.Roots, columns: entry.observation.Sql.result.BaseItems,
      relations: Object.fromEntries(Object.entries(entry.observation.Sql.result).filter(([table]) => table !== 'BaseItems')),
      trace: entry.observation.Trace, reader: entry.reader }));
    return { native, cases, output };
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}
