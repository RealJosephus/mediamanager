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
export const fixtureRoot = new URL('./', import.meta.url);
export const profile = JSON.parse(await readFile(new URL('current-profile.json', fixtureRoot)));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pending = new Map();

export async function bookInput(kind) {
  return JSON.parse(await readFile(new URL(profile.components[kind].input, fixtureRoot)));
}

const names = (kind, input) => (kind === 'lifecycle' ? [...input.lookups, ...input.merges, ...input.refresh]
  : kind === 'owned' ? input : kind === 'dto' ? input.cases : kind === 'order' ? input.contexts : input.resolvers).map(row => row.name);
const functional = (kind, native) => {
  if (kind === 'dto') return native.results.map(({ name, wire }) => ({ name, wire }));
  if (kind === 'order') return { exports: native.exports.map(row => row.Name),
    observed: native.observed.map(({ name, providers }) => ({ name, providers: providers.map(row => row.Name) })) };
  if (kind === 'lifecycle') return native.results.map(({ exception, ...row }) => ({ ...row, failed: Boolean(exception) }));
  if (kind === 'owned') return native.results.map(row => ({ name: row.name, failed: Boolean(row.exception),
    extras: row.calls.filter(call => call.action === 'refresh' && call.item.extraType != null)
      .map(call => ({ type: call.item.type, name: call.item.name, path: call.item.path, extraType: call.item.extraType })) }));
  return native.results;
};

export function captureBook(kind) {
  assert.ok(Object.hasOwn(profile.components, kind));
  if (!pending.has(kind)) pending.set(kind, capture(kind));
  return pending.get(kind);
}

async function capture(kind) {
  const component = profile.components[kind];
  const inputFile = new URL(component.input, fixtureRoot), inputBytes = await readFile(inputFile), input = JSON.parse(inputBytes);
  const output = path.join(validationOutputRoot(), 'book-' + kind + '-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const report = { schemaVersion: 1, component: kind, scope: component.scope, inputSha256: hash(inputBytes),
    captures: [], sourceBindings: [], componentEvidenceClosed: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const entry of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(entry.filename, fixtureRoot)));
      assert.equal(actual.bytes, entry.bytes, entry.filename); assert.equal(actual.sha256, entry.sha256, entry.filename);
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const sourceOffer = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json')));
    for (const relativePath of component.sourcePaths) {
      const pin = sourceOffer.files.find(entry => entry.path === relativePath);
      assert.ok(pin, 'The designated source offer must include ' + relativePath);
      const source = await describeFile(path.join(build.root, 'source', relativePath));
      assert.equal(source.sha256, pin.sha256, relativePath); report.sourceBindings.push({ relativePath, source });
    }
    let first;
    for (const label of ['native-first', 'native-repeat']) {
      const directory = path.join(output, label);
      const args = [fileURLToPath(inputFile), '{output}/native.json'];
      if (['owned', 'order', 'directory'].includes(kind)) args.push('{output}/state');
      const record = await recordOracle({ project: 'tests/metadata/fixtures/book-current/' + kind + '/Oracle.csproj', output: directory, args });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, hash(bytes));
      assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, hash(inputBytes));
      assert.deepEqual((kind === 'order' ? native.observed : native.results).map(row => row.name), names(kind, input));
      for (const assembly of native.assemblies) {
        const actual = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
        assert.equal(actual.sha256, assembly.sha256, assembly.name);
      }
      for (const library of native.nativeLibraries ?? []) {
        const rid = { win32: 'win', linux: 'linux', darwin: 'osx' }[process.platform] + '-' + process.arch;
        const actual = await describeFile(path.join(build.runtime, 'runtimes', rid, 'native', path.basename(library.path)));
        assert.equal(actual.sha256, library.sha256, library.name);
      }
      if (['owned', 'order', 'directory'].includes(kind)) report.captures.at(-1).state = await describeFile(path.join(directory, 'state'));
      if (first) assert.deepEqual(functional(kind, native), functional(kind, first), 'Independent current Book ' + kind + ' observations');
      else first = native;
    }
    report.independentNativeCapturesAgree = true;
    await mkdir(path.join(output, 'candidate'));
    return { native: first, output, report };
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack }; throw error;
  } finally {
    await writeFile(path.join(output, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
}

export async function recordBookCandidate(kind, name, observation) {
  const { output } = await captureBook(kind);
  await writeFile(path.join(output, 'candidate', encodeURIComponent(name) + '.json'), JSON.stringify({ name, ...observation }, null, 2) + '\n', { flag: 'wx' });
}
