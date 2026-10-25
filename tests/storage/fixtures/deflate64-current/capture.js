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
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const originalRoot = new URL('../deflate64-archives/', root);
const functional = native => native.archives.map(({ filename, archiveError, entries, ...sample }) => ({ ...sample,
  archiveFailed: Boolean(archiveError), entries: entries.map(({ openError, readError, ...entry }) => ({ ...entry,
    openFailed: Boolean(openError), readFailed: Boolean(readError) })) }));

let pending;
export function captureCurrentNative() { return pending ??= capture(); }

async function capture() {
  const output = path.join(validationOutputRoot(), 'deflate64-current-' + randomUUID());
  assertValidationOutputChild(output);
  await mkdir(output);
  const report = { schemaVersion: 1, inputSha256: hash(inputBytes), scope: profile.scope,
    captures: [], sourceBindings: [], componentEvidenceClosed: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const entry of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(entry.filename, root)));
      assert.equal(actual.bytes, entry.bytes, entry.filename); assert.equal(actual.sha256, entry.sha256, entry.filename);
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, sdkEntriesSha256: build.sdkEntriesSha256,
      runtimeEntriesSha256: build.runtimeEntriesSha256, receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
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
      const record = await recordOracle({ project: 'tests/storage/fixtures/deflate64-current/Oracle.csproj', output: directory,
        args: [fileURLToPath(inputFile), '{output}/native.json'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, hash(bytes));
      assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, hash(inputBytes));
      assert.deepEqual(native.archives.map(sample => sample.name), input.archives.map(sample => sample.name));
      for (const [index, sample] of native.archives.entries()) assert.equal(sample.inputSha256, input.archives[index].sha256, sample.name);
      for (const assembly of native.assemblies) {
        const relative = path.relative(build.sdkRoot, assembly.filename).replaceAll('\\', '/');
        assert.ok(relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative));
        const pinned = build.sdkAfter.files.find(entry => entry.path === relative);
        assert.ok(pinned, 'Actual compression assemblies must belong to the supplied SDK');
        const actual = await describeFile(assembly.filename);
        assert.equal(actual.sha256, pinned.sha256); assert.equal(actual.sha256, assembly.sha256);
      }
      if (first) assert.deepEqual(functional(native), functional(first), 'Independent native captures');
      else first = native;
    }
    report.independentNativeCapturesAgree = true;
    await mkdir(path.join(output, 'candidate'));
    return { native: first, output };
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack }; throw error;
  } finally {
    await writeFile(path.join(output, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
}

export async function recordCandidate(name, observation) {
  const { output } = await captureCurrentNative();
  assert.match(name, /^[A-Za-z0-9.-]+$/u);
  await writeFile(path.join(output, 'candidate', name + '.json'), JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' });
}
