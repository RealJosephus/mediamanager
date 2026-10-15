import { captureReferenceInput } from '../../tools/compat/reference-inputs.js';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readNativeQueryBoundFile(descriptor) {
  assert.ok(descriptor && typeof descriptor.filename === 'string' && path.isAbsolute(descriptor.filename),
    'A query input must name an explicit absolute file.');
  assert.match(descriptor.sha256, /^[a-f0-9]{64}$/u);
  const filename = path.resolve(descriptor.filename);
  const [metadata, resolved] = await Promise.all([lstat(filename), realpath(filename)]);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), 'A query input must be a regular file.');
  assert.equal(resolved, filename, 'A query input cannot resolve through links.');
  const bytes = await readFile(filename);
  assert.equal(metadata.size, bytes.length);
  if (descriptor.bytes !== undefined) assert.equal(bytes.length, descriptor.bytes);
  assert.equal(digest(bytes), descriptor.sha256, filename);
  return bytes;
}

function semanticRegions(source) {
  const normalized = source.replaceAll('\r\n', '\n');
  const regions = [
    ['matrix catalog', 'const OFFICIAL_RATING_CASES = ', 'const [scenarioName, outputArgument, portArgument]'],
    ['fixture/case derivation', 'const fixtureBytes = ', 'const json = '],
    ['seed and relationships', 'function ancestorsFor(item)', 'function normalizeSqlValue(value)'],
    ['HTTP route construction', 'function routeFor(endpoint, testCase, userId)', 'function startReference(port)'],
  ];
  return regions.map(([label, start, end]) => {
    assert.equal(normalized.split(start).length, 2, label + ': unique start');
    assert.equal(normalized.split(end).length, 2, label + ': unique end');
    const begin = normalized.indexOf(start), finish = normalized.indexOf(end, begin);
    assert.ok(finish > begin, label);
    return { label, sha256: digest(Buffer.from(normalized.slice(begin, finish))) };
  });
}

export function createNativeQueryInputs(binding) {
  assert.ok(binding?.reference && Array.isArray(binding.reference.preparationInputs));
  assert.equal(binding.reference.preparationInputs.length, 11);
  assert.ok(Array.isArray(binding.preparationInputFiles));
  assert.equal(binding.preparationInputFiles.length, 11);
  assert.ok(Array.isArray(binding.independentNativeAudits));
  const expectedFiles = binding.reference.preparationInputs.map(([, filename]) => path.resolve(repositoryRoot, filename));
  assert.equal(new Set(expectedFiles).size, expectedFiles.length, 'Preparation paths must be unique.');
  assert.deepEqual(binding.preparationInputFiles.map(entry => [entry.kind, path.resolve(entry.filename)]),
    binding.reference.preparationInputs.map(([kind], index) => [kind, expectedFiles[index]]),
    'Every preparation input must have its exact ordered descriptor.');
  assert.ok(path.isAbsolute(binding.reference.sourceDatabase.filename));
  assert.ok(path.isAbsolute(binding.recordedFilterOutputRoot));
  const reference = binding.reference;
  function resolveInput(filename) {
    assert.ok(reference.preparationInputs.some(([, expected]) => expected === filename),
      'Native query inputs resolve only the exact profile allowlist.');
    return path.resolve(repositoryRoot, filename);
  }
  const executables = {
    dotnet: resolveInput(reference.preparationInputs[8][1]),
    jellyfinDll: resolveInput(reference.preparationInputs[9][1]),
    ffmpeg: resolveInput(reference.preparationInputs[10][1]),
  };
  async function readServerId() {
    const filename = resolveInput(reference.preparationInputs[0][1]);
    const descriptor = binding.preparationInputFiles.find(entry => path.resolve(entry.filename) === filename);
    assert.ok(descriptor, 'The native bootstrap must be an explicitly hash-bound input.');
    const ids = JSON.parse(await readNativeQueryBoundFile(descriptor)).observations
      .filter(entry => entry.route === '/Users/AuthenticateByName')
      .map(entry => entry.responseBody?.SessionInfo?.ServerId).filter(Boolean);
    assert.ok(ids.length > 0); assert.match(ids[0], /^[a-f0-9]{32}$/u);
    assert.ok(ids.every(value => value === ids[0]));
    return ids[0];
  }
  async function verifySourceBindings() {
    await readNativeQueryBoundFile(reference.sourceDatabase);
    for (const descriptor of binding.preparationInputFiles) await readNativeQueryBoundFile(descriptor);
    for (const descriptor of binding.independentNativeAudits) {
      const report = JSON.parse(await readNativeQueryBoundFile(descriptor));
      assert.ok(['allRawArtifactsAndCurrentInputsVerified', 'passed'].includes(descriptor.acceptanceField));
      assert.equal(report[descriptor.acceptanceField], true);
    }
    for (const descriptor of [binding.runtimeDirectory, binding.dotnetDirectory].filter(Boolean)) {
      const actual = await captureReferenceInput(descriptor.path);
      assert.equal(actual.entriesSha256, descriptor.entriesSha256, descriptor.path);
    }
    for (const descriptor of binding.executionInputs ?? []) await readNativeQueryBoundFile(descriptor);
    if (binding.sourceBuildReceipt) {
      const receipt = JSON.parse(await readNativeQueryBoundFile(binding.sourceBuildReceipt));
      assert.equal(receipt.passed, true);
      assert.equal(receipt.fullBuildInputClosure, true);
      assert.equal(receipt.buildIdentity.nativeDll.sha256, digest(await readFile(executables.jellyfinDll)));
    }
  }
  async function readRecorderSource() {
    assert.ok(binding.recordedRecorder,
      'This exact profile requires an immutable captured recorder descriptor; current source is not a historical replacement.');
    const relative = path.relative(binding.recordedFilterOutputRoot, binding.recordedRecorder.filename);
    assert.ok(relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
      'The captured recorder must belong to the explicitly recorded output root.');
    assert.equal(path.basename(binding.recordedRecorder.filename), 'record-native.mjs');
    const captured = (await readNativeQueryBoundFile(binding.recordedRecorder)).toString('utf8');
    const current = await readFile(path.join(repositoryRoot, 'tools/compat/record-item-filter-native.mjs'), 'utf8');
    assert.deepEqual(semanticRegions(captured), semanticRegions(current),
      'Native matrix/seed/route semantics changed; affected profiles require new observations.');
    return captured;
  }
  return Object.freeze({ profile: binding, reference, executables, recordedOutputRoot: binding.recordedFilterOutputRoot,
    expectedChangedReferences: binding.expectedChangedReferences,
    resolveInput, readServerId, verifySourceBindings, readRecorderSource });
}

// Existing profiles keep their original source identities. Missing descriptors
// fail when requested; a new profile is never substituted for an old one.
const binding = JSON.parse(await readFile(new URL('./fixtures/native-query-inputs/binding.json', import.meta.url), 'utf8'));
export const nativeQueryInputs = createNativeQueryInputs({ ...binding, expectedChangedReferences: [
  { table: 'ActivityLogs', column: 'UserId', count: 4 },
  { table: 'Devices', column: 'UserId', count: 1 },
  { table: 'Permissions', column: 'UserId', count: 24 },
  { table: 'Preferences', column: 'UserId', count: 13 },
  { table: 'Users', column: 'Id', count: 1 },
] });
export const nativeQueryReference = nativeQueryInputs.reference;
export const nativeItemFilterRecordedOutputRoot = nativeQueryInputs.recordedOutputRoot;
export const nativeQueryExecutables = nativeQueryInputs.executables;
export const readNativeQueryServerId = nativeQueryInputs.readServerId;
export const verifyNativeQuerySourceBindings = nativeQueryInputs.verifySourceBindings;
export const resolveNativeQueryInput = nativeQueryInputs.resolveInput;
export const readNativeQueryRecorderSource = nativeQueryInputs.readRecorderSource;
