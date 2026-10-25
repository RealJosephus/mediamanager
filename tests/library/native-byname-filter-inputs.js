import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFile } from '../../tools/validation/inventory.js';
import { assertIsolatedOutput } from '../../tools/validation/paths.js';
import { nativeIdentityBinding, verifyNativeIdentitySourceBindings } from './native-identity-inputs.js';

export const nativeByNameFilterBinding = JSON.parse(await readFile(
  new URL('./fixtures/native-byname-filter-inputs/binding.json', import.meta.url), 'utf8'));
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function nativeByNameFilterRecording(kind, side = null, binding = nativeByNameFilterBinding) {
  const recording = binding.recordings.find(entry => entry.kind === kind && entry.side === side);
  assert.ok(recording, 'The native by-name filter kind/mode must be explicitly bound.');
  return recording;
}

export function resolveNativeByNameFilterInput(kind, side, filename) {
  const recording = nativeByNameFilterRecording(kind, side);
  assert.ok(recording.inputAllowlist.includes(filename), 'Native filter input must match the exact recorded allowlist.');
  const absolute = path.resolve(repositoryRoot, filename);
  return { root: path.dirname(absolute), relative: path.basename(absolute) };
}

async function verifiedJson(descriptor) {
  const filename = path.resolve(descriptor.filename);
  const [metadata, resolved, bytes] = await Promise.all([lstat(filename), realpath(filename), readFile(filename)]);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.isFile(), true);
  assert.equal(filename, resolved);
  assert.equal(bytes.length, metadata.size);
  if (descriptor.size !== undefined) assert.equal(bytes.length, descriptor.size);
  assert.equal(sha256(bytes), descriptor.sha256);
  return JSON.parse(bytes);
}

export async function verifyNativeByNameFilterSourceBindings(binding = nativeByNameFilterBinding) {
  assert.equal(binding.completeBuildInputClosure, false);
  assert.equal(binding.releaseAcceptance, false);
  await verifyNativeIdentitySourceBindings();
  for (const key of ['reference', 'preparationInputFiles', 'runtimeDirectory', 'sdkDirectory']) {
    assert.deepEqual(binding[key], nativeIdentityBinding[key], 'The independently audited native source must be exact.');
  }
  const audit = await verifiedJson(binding.independentNativeAudit);
  assert.equal(audit.passed, true);
  assert.equal(audit.currentExactPreparedInputBindingsVerified, true);
  assert.equal(binding.recordings.length, 8);
  assert.deepEqual(binding.recordings.map(entry => [entry.kind, entry.side, entry.prefix]),
    audit.recordings.map(entry => [entry.kind, entry.side, entry.prefix]));
  for (const [index, recording] of binding.recordings.entries()) {
    const audited = audit.recordings[index];
    assert.equal(audited.rawContractByteEqual, true);
    assert.equal(audited.exactRetainedPayloadEqual, true);
    assert.equal(recording.rawContractSha256, audited.contractSha256);
    assert.equal(recording.cases, audited.cases);
    assert.equal(recording.endpoints, audited.endpoints);
    assert.deepEqual(recording.repetitions, audited.repetitions.map(({ filename, entriesSha256 }) => ({ filename, entriesSha256 })));
    assert.deepEqual(recording.artifacts, audited.repetitions[0].artifacts);
    assert.equal(recording.logicalRoot, '.test-input/evidence/byname-filter-inputs/' + recording.prefix + '-v1');
    const provenance = JSON.parse(await readFile(recording.repetitions[0].filename + '/provenance.json', 'utf8'));
    assert.deepEqual(recording.preparedInputs, provenance.preparedInputs);
    assert.deepEqual(recording.nativeSources, provenance.nativeSources);
    assert.deepEqual(recording.recorderInvocation, provenance.recorderInvocation);
    assert.deepEqual(recording.inputAllowlist, [...new Set([...provenance.nativeSources, ...provenance.preparedInputs]
      .map(entry => entry.path))]);
    const loadArtifact = async name => {
      const descriptors = recording.artifacts.filter(entry => entry.path === name);
      assert.equal(descriptors.length, 1);
      return verifiedJson({ ...descriptors[0], filename: path.join(recording.repetitions[0].filename, name) });
    };
    const runtime = await loadArtifact('reference-runtime-manifest.json');
    assert.equal(recording.runtimeManifestRoot, runtime.root);
    assert.equal(path.resolve(repositoryRoot, runtime.root), path.resolve(binding.runtimeDirectory.filename));
    const sourceConfig = await loadArtifact('source-config-manifest.json');
    const preparedConfig = await loadArtifact('prepared-config-manifest.json');
    assert.equal(recording.configuration.sourceEntriesSha256, sourceConfig.entriesSha256);
    assert.equal(recording.configuration.preparedEntriesSha256, preparedConfig.entriesSha256);
    const finalEntries = [];
    for (const entry of sourceConfig.entries) {
      if (entry.type === 'directory') finalEntries.push(entry);
      else {
        assert.equal(entry.type, 'file');
        const filename = path.join(recording.repetitions[0].filename, 'reference/config', entry.path);
        const bytes = await readFile(filename);
        finalEntries.push({ path: entry.path, type: 'file', size: bytes.length, sha256: sha256(bytes) });
      }
    }
    assert.deepEqual(recording.configuration.finalEntries, finalEntries);
    assert.equal(recording.configuration.finalEntriesSha256, sha256(JSON.stringify(finalEntries)));
    assert.deepEqual(recording.configuration.finalEncodingEntry, finalEntries.find(entry => entry.path === 'encoding.xml'));
  }
}

export async function verifyNativeByNameFilterRecording(kind, side = null, binding = nativeByNameFilterBinding) {
  await verifyNativeByNameFilterSourceBindings(binding);
  const recording = nativeByNameFilterRecording(kind, side, binding);
  for (const descriptor of recording.repetitions) {
    const current = await describeFile(descriptor.filename);
    assert.equal(current.available, true);
    assert.equal(current.kind, 'directory');
    assert.equal(current.entriesSha256, descriptor.entriesSha256);
  }
  return recording;
}

export function assertNativeByNameFilterOutput(filename, environment = process.env) {
  const directories = [nativeByNameFilterBinding.runtimeDirectory.filename, nativeByNameFilterBinding.sdkDirectory.filename,
    path.dirname(nativeByNameFilterBinding.reference.sourceDatabase.filename),
    path.dirname(nativeByNameFilterBinding.independentNativeAudit.filename),
    ...nativeByNameFilterBinding.recordings.flatMap(recording => recording.repetitions.map(entry => entry.filename))];
  for (const directory of new Set(directories)) {
    assertIsolatedOutput(filename, { ...environment, MEDIAMANAGER_BYNAME_FILTER_INPUT_ROOT: directory });
  }
  return filename;
}
