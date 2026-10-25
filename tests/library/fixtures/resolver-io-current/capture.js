import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const root = new URL('./', import.meta.url);
const inputFile = new URL('input.json', root);
const inputBytes = await readFile(inputFile);
export const input = JSON.parse(inputBytes);
const profile = JSON.parse(await readFile(new URL('current-profile.json', root)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const idKey = value => value.replaceAll('-', '').toLowerCase();

function functional(native) {
  return native.results.map(sample => {
    const project = value => typeof value === 'string' ? value.replaceAll(sample.caseRoot, '$CASE')
      .replaceAll(sample.caseRoot.replaceAll('\\', '/'), '$CASE').replaceAll('\\', '/')
      : Array.isArray(value) ? value.map(project) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, project(entry)])) : value;
    return project({ name: sample.Name, parentType: sample.parentType, parentPath: sample.parentPath,
      parentIsPhysicalRoot: sample.parentIsPhysicalRoot, parentIsRoot: sample.parentIsRoot, failed: Boolean(sample.exception),
      items: sample.items.map(({ Id, derivedId, ...item }) => item),
      faults: sample.trace.filter(event => event.action === 'injected-fault').map(event => ({
        kind: event.detail.kind, path: event.detail.path, occurrence: event.detail.occurrence
      })) });
  });
}

let pending;
export function captureCurrentNative() { return pending ??= capture(); }

async function capture() {
  const output = path.join(validationOutputRoot(), 'resolver-io-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const report = { schemaVersion: 1, inputSha256: hash(inputBytes), scope: profile.scope,
    captures: [], sourceBindings: [], componentEvidenceClosed: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const entry of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(entry.filename, root)));
      assert.equal(actual.bytes, entry.bytes, entry.filename); assert.equal(actual.sha256, entry.sha256, entry.filename);
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const sources = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json')));
    for (const relativePath of profile.sourcePaths) {
      const pinned = sources.files.find(entry => entry.path === relativePath);
      assert.ok(pinned, 'The designated source offer must include ' + relativePath);
      const source = await describeFile(path.join(build.root, 'source', relativePath));
      assert.equal(source.sha256, pinned.sha256, relativePath); report.sourceBindings.push({ relativePath, source });
    }
    let first;
    for (const label of ['native-first', 'native-repeat']) {
      const directory = path.join(output, label);
      const record = await recordOracle({ project: 'tests/library/fixtures/resolver-io-current/Oracle.csproj', output: directory,
        args: [fileURLToPath(inputFile), '{output}/native.json', '{output}/cases'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, hash(bytes));
      assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, hash(inputBytes));
      assert.deepEqual(native.results.map(sample => sample.Name), input.map(sample => sample.Name));
      for (const sample of native.results) {
        assert.equal(new Set(sample.items.map(item => idKey(item.Id))).size, sample.items.length);
        for (const item of sample.items) assert.equal(idKey(item.Id), idKey(item.derivedId), item.Path + ': actual native path/type identity');
      }
      for (const assembly of native.assemblies) {
        const runtime = build.manifest.files.find(entry => entry.path === assembly.name + '.dll');
        const relative = path.relative(build.sdkRoot, assembly.path).replaceAll('\\', '/');
        const sdk = build.sdkAfter.files.find(entry => entry.path === relative);
        const expected = assembly.name === 'Oracle' ? record.oracleAssembly : runtime ?? sdk;
        assert.ok(expected, 'The actual loaded assembly is bound to this run: ' + assembly.name);
        assert.equal(assembly.sha256, expected.sha256, assembly.name);
        assert.equal((await describeFile(assembly.path)).sha256, expected.sha256, assembly.name);
      }
      assert.equal(native.sqlite.actualResolverUsed, true);
      const sqlite = build.manifest.files.find(entry => entry.path === 'runtimes/' + native.sqlite.rid + '/native/' + path.basename(native.sqlite.filename));
      assert.ok(sqlite, 'SQLite must belong to the exact supplied platform runtime');
      assert.equal(native.sqlite.sha256, sqlite.sha256);
      if (first) assert.deepEqual(functional(native), functional(first), 'Independent native captures');
      else first = native;
    }
    report.independentNativeCapturesAgree = true; await mkdir(path.join(output, 'candidate'));
    return { native: first, output };
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack }; throw error;
  } finally {
    await writeFile(path.join(output, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
}

export async function recordCandidate(name, observation) {
  const { output } = await captureCurrentNative();
  assert.match(name, /^[a-z-]+$/u);
  await writeFile(path.join(output, 'candidate', name + '.json'), JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' });
}
