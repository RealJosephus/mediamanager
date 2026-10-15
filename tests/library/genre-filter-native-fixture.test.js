import { nativeByNameFilterBinding, verifyNativeByNameFilterRecording, resolveNativeByNameFilterInput } from './native-byname-filter-inputs.js';
import { validationFileUrl } from '../../tools/validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const recordingBinding = await verifyNativeByNameFilterRecording('genre');

const sourceEvidence = '.agent-docs/evidence/byname-filter-inputs/genre-filter-restoration-v1/native-contract.json';
const fixtureInput = 'tests/library/fixtures/genre-filters/input.json';
const trackedFixture = 'tests/library/fixtures/genre-filters/native.json';
const integrityTest = 'tests/library/genre-filter-native-fixture.test.js';
const projector = 'tools/compat/project-genre-filter-fixture.js';
const projectionBinding = 'tests/library/fixtures/genre-filters/projection.json';
const projectionSpec = Object.freeze({
  id: 'genre-filter-native-v1-contract-projection',
  version: 1,
  topLevel: 'Drop only kind and mode; add frozenJellyfin, the exact source path, and its SHA-256; preserve schemaVersion, fixtureInputSha256, endpoints, setup, and cases.',
  cases: 'Preserve every case, response item, JSON field, and array order verbatim. The authoritative contract excludes all runtime-native ids.',
  authority: 'The v1 projection is created only from the pinned main native contract and has no predecessor fixture.',
});

const inputUrl = validationFileUrl('./fixtures/genre-filters/input.json', import.meta.url);
const nativeUrl = validationFileUrl('./fixtures/genre-filters/native.json', import.meta.url);
const sourceContractUrl = validationFileUrl('../../' + sourceEvidence, import.meta.url);
const projectionBindingUrl = validationFileUrl('../../' + projectionBinding, import.meta.url);
const testUrl = validationFileUrl(import.meta.url);
const projectorUrl = validationFileUrl('../../' + projector, import.meta.url);
const recorderUrl = validationFileUrl('../../tools/compat/record-genre-filters.js', import.meta.url);
const evidenceRootUrl = validationFileUrl('../../.agent-docs/evidence/byname-filter-inputs/genre-filter-restoration-v1/', import.meta.url);
const evidenceRoot = fileURLToPath(evidenceRootUrl);
const currentNativeRoot = path.dirname(nativeByNameFilterBinding.reference.sourceDatabase.filename);
const currentSourceDatabase = nativeByNameFilterBinding.reference.sourceDatabase.filename;
const currentRuntimeRoot = nativeByNameFilterBinding.runtimeDirectory.filename;
const sourceConfigEntriesSha256 = recordingBinding.configuration.sourceEntriesSha256;
const preparedConfigEntriesSha256 = recordingBinding.configuration.preparedEntriesSha256;
const finalConfigEntriesSha256 = recordingBinding.configuration.finalEntriesSha256;
const finalEncodingEntry = Object.freeze(recordingBinding.configuration.finalEncodingEntry);
const expectedArtifacts = recordingBinding.artifacts;
const summaryUrl = validationFileUrl('summary.json', evidenceRootUrl);
const databaseStagesUrl = validationFileUrl('database-stages.json', evidenceRootUrl);
const filesystemStagesUrl = validationFileUrl('filesystem-stages.json', evidenceRootUrl);
const setupHttpUrl = validationFileUrl('setup-http.json', evidenceRootUrl);
const nativeHttpUrl = validationFileUrl('native-http.json', evidenceRootUrl);
const nativeSetupUrl = validationFileUrl('native-setup.json', evidenceRootUrl);
const provenanceUrl = validationFileUrl('provenance.json', evidenceRootUrl);
const runtimeManifestUrl = validationFileUrl('reference-runtime-manifest.json', evidenceRootUrl);
const evidenceUrls = [summaryUrl, databaseStagesUrl, filesystemStagesUrl, setupHttpUrl, nativeHttpUrl, nativeSetupUrl,
  provenanceUrl, runtimeManifestUrl];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const idKey = value => String(value).replaceAll('-', '').toLowerCase();

async function loadFixture() {
  const [inputBytes, nativeBytes, sourceContractBytes, projectionBindingBytes, testBytes, projectorBytes,
    recorderBytes, summaryBytes, databaseStagesBytes, filesystemStagesBytes, setupHttpBytes, nativeHttpBytes,
    nativeSetupBytes, provenanceBytes, runtimeManifestBytes] = await Promise.all([
    readFile(inputUrl), readFile(nativeUrl), readFile(sourceContractUrl), readFile(projectionBindingUrl), readFile(testUrl),
    readFile(projectorUrl), readFile(recorderUrl), readFile(summaryUrl), readFile(databaseStagesUrl),
    readFile(filesystemStagesUrl), readFile(setupHttpUrl), readFile(nativeHttpUrl), readFile(nativeSetupUrl),
    readFile(provenanceUrl), readFile(runtimeManifestUrl),
  ]);
  return {
    inputBytes,
    nativeBytes,
    sourceContractBytes,
    projectionBindingBytes,
    testBytes,
    projectorBytes,
    recorderBytes,
    input: JSON.parse(inputBytes),
    native: JSON.parse(nativeBytes),
    sourceContract: JSON.parse(sourceContractBytes),
    projectionBindingValue: JSON.parse(projectionBindingBytes),
    summary: JSON.parse(summaryBytes),
    databaseStages: JSON.parse(databaseStagesBytes),
    filesystemStages: JSON.parse(filesystemStagesBytes),
    setupHttp: JSON.parse(setupHttpBytes),
    nativeHttp: JSON.parse(nativeHttpBytes),
    nativeSetup: JSON.parse(nativeSetupBytes),
    provenance: JSON.parse(provenanceBytes),
    runtimeManifest: JSON.parse(runtimeManifestBytes),
  };
}

async function loadTrackedFixture() {
  const [inputBytes, nativeBytes] = await Promise.all([readFile(inputUrl), readFile(nativeUrl)]);
  return {
    inputBytes,
    nativeBytes,
    input: JSON.parse(inputBytes),
    native: JSON.parse(nativeBytes),
  };
}

function projectNative(sourceContract, sourceContractBytes) {
  const { kind: _kind, mode: _mode, ...contract } = sourceContract;
  return {
    schemaVersion: contract.schemaVersion,
    frozenJellyfin: true,
    sourceEvidence,
    sourceEvidenceSha256: sha256(sourceContractBytes),
    fixtureInputSha256: contract.fixtureInputSha256,
    endpoints: contract.endpoints,
    setup: contract.setup,
    cases: contract.cases,
  };
}

function assertRuntimeEvidence(summary, nativeHttp, provenance) {
  const process = summary.process;
  const { preferredPort, selectedPort } = process;
  assert.equal(Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535, true);
  assert.equal(Number.isInteger(selectedPort) && selectedPort >= 1024 && selectedPort <= 65535, true);
  assert.equal(typeof process.preferredPortInitiallyAvailable, 'boolean');
  if (process.preferredPortInitiallyAvailable) {
    assert.equal(selectedPort, preferredPort);
  } else {
    assert.equal(selectedPort > preferredPort, true);
    assert.equal(selectedPort <= Math.min(65535, preferredPort + 101), true);
  }
  assert.equal(process.portInitiallyAvailable, true);
  assert.equal(process.portFinallyAvailable, true);

  const origin = `http://127.0.0.1:${selectedPort}`;
  assert.equal(summary.mode, 'main');
  assert.equal(summary.origin, origin);
  assert.equal(nativeHttp.mode, summary.mode);
  assert.equal(nativeHttp.origin, origin);
  assert.deepEqual(provenance.result.process, process);

  for (const key of ['preferredPort', 'preferredPortInitiallyAvailable', 'selectedPort',
    'portInitiallyAvailable', 'portFinallyAvailable']) {
    assert.equal(provenance.isolation[key], process[key], key);
  }
  assert.equal(provenance.isolation.loopbackOnly, true);
  assert.equal(provenance.isolation.autoDiscovery, false);
  assert.equal(provenance.isolation.frozenInputsWereNotRunInPlace, true);

  const invocation = provenance.recorderInvocation;
  assert.equal(invocation.length, 5);
  assert.match(invocation[0].replaceAll('\\', '/'), /(?:^|\/)node(?:\.exe)?$/iu);
  assert.equal(invocation[1], 'tools/compat/record-genre-filters.js');
  assert.equal(invocation[2].replaceAll('\\', '/'), recordingBinding.recorderInvocation[2].replaceAll('\\', '/'));
  assert.equal(invocation[3], String(preferredPort));
  assert.equal(invocation[4], summary.mode);
  assert.equal(provenance.recorder.path, invocation[1]);
  assert.equal(provenance.isolation.clonedInstance.replaceAll('\\', '/'), `${invocation[2].replaceAll('\\', '/')}/reference`);
}

function isWithin(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function isSameOrWithin(root, filename) {
  return path.resolve(root) === path.resolve(filename) || isWithin(root, filename);
}

async function resolveContainedRegularFile(root, relative) {
  assert.equal(typeof relative, 'string');
  const absoluteRoot = path.resolve(root);
  const filename = path.resolve(absoluteRoot, relative);
  assert.ok(isWithin(absoluteRoot, filename), `File escapes its logical root: ${relative}`);
  const [resolvedRoot, resolvedFile, metadata] = await Promise.all([
    realpath(absoluteRoot), realpath(filename), lstat(filename),
  ]);
  assert.equal(metadata.isSymbolicLink(), false, `File cannot be a link: ${relative}`);
  assert.equal(metadata.isFile(), true, `Expected a regular file: ${relative}`);
  assert.ok(isWithin(resolvedRoot, resolvedFile), `File escapes its real root: ${relative}`);
  return { filename, metadata };
}

async function resolveContainedDirectory(root, relative) {
  const absoluteRoot = path.resolve(root);
  const filename = path.resolve(absoluteRoot, relative);
  assert.ok(isSameOrWithin(absoluteRoot, filename), `Directory escapes its logical root: ${relative}`);
  const [resolvedRoot, resolvedDirectory, metadata] = await Promise.all([
    realpath(absoluteRoot), realpath(filename), lstat(filename),
  ]);
  assert.equal(metadata.isSymbolicLink(), false, `Directory cannot be a link: ${relative}`);
  assert.equal(metadata.isDirectory(), true, `Expected a directory: ${relative}`);
  assert.ok(isSameOrWithin(resolvedRoot, resolvedDirectory), `Directory escapes its real root: ${relative}`);
  return filename;
}

async function listRegularFiles(root, relative = '') {
  const directory = await resolveContainedDirectory(root, relative);
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    const metadata = await lstat(path.join(root, child));
    assert.equal(metadata.isSymbolicLink(), false, `Directory tree cannot contain links: ${child}`);
    if (metadata.isDirectory()) files.push(...await listRegularFiles(root, child));
    else {
      assert.equal(metadata.isFile(), true, `Directory tree entries must be regular files: ${child}`);
      files.push(child.replaceAll('\\', '/'));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

const bindArtifactSizes = artifacts => artifacts.map((entry, index) => ({
  ...entry,
  size: expectedArtifacts[index]?.size,
}));

async function verifyArtifactManifest(candidate) {
  assert.deepEqual(candidate, expectedArtifacts,
    'Genre evidence artifacts must be the exact canonical path/size/SHA list in recording order.');
  for (const artifact of candidate) {
    const { filename, metadata } = await resolveContainedRegularFile(evidenceRoot, artifact.path);
    const bytes = await readFile(filename);
    assert.equal(metadata.size, artifact.size, `${artifact.path}: stat size`);
    assert.equal(bytes.length, artifact.size, `${artifact.path}: byte size`);
    assert.equal(sha256(bytes), artifact.sha256, `${artifact.path}: sha256`);
  }
}

function sealRuntimeManifest(candidate) {
  candidate.fileCount = candidate.entries.length;
  candidate.dllCount = candidate.entries.filter(entry => entry.path.toLowerCase().endsWith('.dll')).length;
  candidate.depsJsonCount = candidate.entries.filter(entry => entry.path.toLowerCase().endsWith('.deps.json')).length;
  candidate.runtimeConfigCount = candidate.entries
    .filter(entry => entry.path.toLowerCase().endsWith('.runtimeconfig.json')).length;
  candidate.entriesSha256 = sha256(JSON.stringify(candidate.entries));
  return candidate;
}

async function verifyRuntimeManifest(candidate, binding) {
  assert.equal(candidate.root,
    recordingBinding.runtimeManifestRoot);
  assert.ok(Array.isArray(candidate.entries) && candidate.entries.length > 0, 'Runtime manifest cannot be empty.');
  assert.equal(candidate.fileCount, candidate.entries.length);
  assert.equal(candidate.entriesSha256, sha256(JSON.stringify(candidate.entries)));
  assert.deepEqual({
    root: binding.root,
    fileCount: binding.fileCount,
    dllCount: binding.dllCount,
    depsJsonCount: binding.depsJsonCount,
    runtimeConfigCount: binding.runtimeConfigCount,
    entriesSha256: binding.entriesSha256,
  }, {
    root: candidate.root,
    fileCount: candidate.fileCount,
    dllCount: candidate.dllCount,
    depsJsonCount: candidate.depsJsonCount,
    runtimeConfigCount: candidate.runtimeConfigCount,
    entriesSha256: candidate.entriesSha256,
  });
  const paths = candidate.entries.map(entry => entry.path);
  assert.equal(new Set(paths).size, paths.length, 'Runtime manifest paths must be unique.');
  assert.deepEqual(paths, [...paths].sort((left, right) => left.localeCompare(right)),
    'Runtime manifest must remain in canonical order.');
  assert.deepEqual(await listRegularFiles(currentRuntimeRoot), paths,
    'Runtime manifest must be the exact current logical runtime file set.');
  for (const entry of candidate.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['path', 'sha256', 'size']);
    assert.equal(Number.isSafeInteger(entry.size) && entry.size >= 0, true, `${entry.path}: size`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/u, `${entry.path}: sha256`);
    const { filename, metadata } = await resolveContainedRegularFile(currentRuntimeRoot, entry.path);
    const bytes = await readFile(filename);
    assert.equal(metadata.size, entry.size, `${entry.path}: stat size`);
    assert.equal(bytes.length, entry.size, `${entry.path}: byte size`);
    assert.equal(sha256(bytes), entry.sha256, `${entry.path}: sha256`);
  }
}

function resolveBoundInput(filename) {
  return resolveNativeByNameFilterInput('genre', null, filename);
}

function verifyDirectoryManifestShape(candidate, expectedEntriesSha256) {
  assert.deepEqual(Object.keys(candidate).sort(), ['entries', 'entriesSha256', 'exists']);
  assert.equal(candidate.exists, true);
  assert.ok(Array.isArray(candidate.entries) && candidate.entries.length > 0);
  assert.equal(candidate.entriesSha256, sha256(JSON.stringify(candidate.entries)));
  assert.equal(candidate.entriesSha256, expectedEntriesSha256);
  const paths = candidate.entries.map(entry => entry.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(paths, [...paths].sort((left, right) => left.localeCompare(right)));
  for (const entry of candidate.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['path', 'sha256', 'size', 'type']);
    assert.equal(entry.type, 'file');
    assert.equal(Number.isSafeInteger(entry.size) && entry.size >= 0, true, `${entry.path}: size`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/u, `${entry.path}: sha256`);
  }
  return paths;
}

async function verifyDirectoryManifest(candidate, root, expectedEntriesSha256) {
  const paths = verifyDirectoryManifestShape(candidate, expectedEntriesSha256);
  assert.deepEqual(await listRegularFiles(root), paths);
  for (const entry of candidate.entries) {
    const { filename, metadata } = await resolveContainedRegularFile(root, entry.path);
    const bytes = await readFile(filename);
    assert.equal(metadata.size, entry.size, `${entry.path}: size`);
    assert.equal(bytes.length, entry.size, `${entry.path}: byte size`);
    assert.equal(sha256(bytes), entry.sha256, `${entry.path}: sha256`);
  }
}

function changedConfigPaths(before, after) {
  assert.deepEqual(after.entries.map(entry => entry.path), before.entries.map(entry => entry.path));
  return before.entries.flatMap((entry, index) => (
    JSON.stringify(entry) === JSON.stringify(after.entries[index]) ? [] : [entry.path]
  ));
}

function assertConfigTransition(before, after, allowedChanges, message) {
  assert.deepEqual(changedConfigPaths(before, after), allowedChanges, message);
}

function finalConfigManifest(preparedConfig, encodingEntry = finalEncodingEntry) {
  const entries = preparedConfig.entries.map(entry => (
    entry.path === 'encoding.xml' ? { ...encodingEntry } : { ...entry }
  ));
  return { exists: true, entries, entriesSha256: sha256(JSON.stringify(entries)) };
}

async function verifyConfigLifecycle(sourceConfig, preparedConfig) {
  const sourceRoot = path.join(currentNativeRoot, 'config');
  const finalRoot = path.join(evidenceRoot, 'reference/config');
  const sourcePaths = verifyDirectoryManifestShape(sourceConfig, sourceConfigEntriesSha256);
  const preparedPaths = verifyDirectoryManifestShape(preparedConfig, preparedConfigEntriesSha256);
  assert.deepEqual(preparedPaths, sourcePaths);
  assertConfigTransition(sourceConfig, preparedConfig, ['network.xml'],
    'Preparing the clone must rewrite only network.xml.');
  await verifyDirectoryManifest(sourceConfig, sourceRoot, sourceConfigEntriesSha256);

  const finalConfig = finalConfigManifest(preparedConfig);
  assert.equal(finalConfig.entriesSha256, finalConfigEntriesSha256);
  assertConfigTransition(preparedConfig, finalConfig, ['encoding.xml'],
    'Starting Jellyfin must rewrite only encoding.xml.');
  await verifyDirectoryManifest(finalConfig, finalRoot, finalConfigEntriesSha256);

  for (const preparedEntry of preparedConfig.entries) {
    const preparedRoot = preparedEntry.path === 'network.xml' ? finalRoot : sourceRoot;
    const { filename: preparedFilename, metadata } = await resolveContainedRegularFile(preparedRoot,
      preparedEntry.path);
    const preparedBytes = await readFile(preparedFilename);
    assert.equal(metadata.size, preparedEntry.size, `${preparedEntry.path}: prepared size`);
    assert.equal(preparedBytes.length, preparedEntry.size, `${preparedEntry.path}: prepared byte size`);
    assert.equal(sha256(preparedBytes), preparedEntry.sha256, `${preparedEntry.path}: prepared sha256`);

    const { filename: finalFilename } = await resolveContainedRegularFile(finalRoot, preparedEntry.path);
    const finalBytes = await readFile(finalFilename);
    if (preparedEntry.path === 'encoding.xml') {
      assert.notDeepEqual(finalBytes, preparedBytes, 'encoding.xml must contain the recorded lifecycle rewrite.');
    } else {
      assert.deepEqual(finalBytes, preparedBytes,
        `${preparedEntry.path} must remain byte-for-byte identical after startup.`);
    }
  }
  return finalConfig;
}

async function verifyBoundInputs(provenance, runtimeManifest) {
  assert.equal(provenance.nativeSources.length, 23);
  assert.equal(provenance.preparedInputs.length, 38);
  const [sourceConfig, preparedConfig] = await Promise.all([
    readFile(path.join(evidenceRoot, 'source-config-manifest.json'), 'utf8').then(JSON.parse),
    readFile(path.join(evidenceRoot, 'prepared-config-manifest.json'), 'utf8').then(JSON.parse),
  ]);
  await verifyConfigLifecycle(sourceConfig, preparedConfig);
  for (const entry of provenance.nativeSources) {
    const mapped = resolveBoundInput(entry.path);
    const { filename } = await resolveContainedRegularFile(mapped.root, mapped.relative);
    assert.equal(sha256(await readFile(filename)), entry.sha256, entry.path);
  }
  for (const entry of provenance.preparedInputs) {
    if (entry.kind === 'frozenReleaseRuntimeTree') {
      const mapped = resolveBoundInput(entry.path);
      assert.equal(await realpath(path.join(mapped.root, mapped.relative)), await realpath(currentRuntimeRoot));
      assert.equal(entry.fileCount, runtimeManifest.fileCount);
      assert.equal(entry.entriesSha256, runtimeManifest.entriesSha256);
    } else {
      assert.match(entry.sha256, /^[0-9a-f]{64}$/u, entry.path);
      const mapped = resolveBoundInput(entry.path);
      const { filename } = await resolveContainedRegularFile(mapped.root, mapped.relative);
      assert.equal(sha256(await readFile(filename)), entry.sha256, entry.path);
    }
  }
}

test('genre fixture is an exact, hash-bound projection of the pinned native main contract', async () => {
  const fixture = await loadFixture();
  assert.equal(fixture.sourceContract.schemaVersion, 1);
  assert.equal(fixture.sourceContract.kind, 'genre-filters-native-contract');
  assert.equal(fixture.sourceContract.mode, 'main');
  assert.equal(fixture.sourceContract.fixtureInputSha256, sha256(fixture.inputBytes));
  assert.equal(fixture.sourceContract.setup?.dynamicIdsExcluded, true);
  assert.deepEqual(fixture.native, projectNative(fixture.sourceContract, fixture.sourceContractBytes));

  assert.equal(fixture.projectionBindingValue.schemaVersion, 1);
  assert.deepEqual(fixture.projectionBindingValue.projectionLogic.spec, projectionSpec);
  assert.equal(fixture.projectionBindingValue.projectionLogic.sha256, sha256(JSON.stringify(projectionSpec)));
  assert.deepEqual(fixture.projectionBindingValue.authoritativeContract, {
    path: sourceEvidence,
    sha256: sha256(fixture.sourceContractBytes),
  });
  assert.deepEqual(fixture.projectionBindingValue.fixtureInput, {
    path: fixtureInput,
    sha256: sha256(fixture.inputBytes),
  });
  assert.deepEqual(fixture.projectionBindingValue.trackedFixture, {
    path: trackedFixture,
    sha256: sha256(fixture.nativeBytes),
  });
  assert.deepEqual(fixture.projectionBindingValue.integrityTest, {
    path: integrityTest,
    sha256: sha256(fixture.testBytes),
  });
  assert.deepEqual(fixture.projectionBindingValue.projector, {
    path: projector,
    sha256: sha256(fixture.projectorBytes),
  });
});

test('genre fixture covers every input case and freezes stable response identities', async () => {
  const { input, native } = await loadTrackedFixture();
  const inputByName = new Map(input.cases.map(entry => [entry.name, entry]));
  const itemByKey = new Map(input.items.map(item => [item.key, item]));
  const itemKeyById = new Map(input.items.map(item => [idKey(item.id), item.key]));
  assert.equal(input.cases.length, 34);
  assert.equal(input.items.length, 21);
  assert.equal(inputByName.size, input.cases.length);
  assert.equal(new Set(native.cases.map(entry => entry.name)).size, input.cases.length);
  assert.deepEqual(native.cases.map(entry => entry.name), input.cases.map(entry => entry.name));

  const requiredResponseFields = ['contentType', 'items', 'keys', 'orderedKeys', 'problem', 'startIndex', 'status', 'totalRecordCount'];
  const allowedCaseFields = new Set([
    'name', 'query', 'scope', 'parentKey', 'auth', 'endpoints',
    'omitScope', 'omitParentId', 'omitIds', 'recursive', 'omitSortBy', 'assertOrder', 'expectedStatus',
    ...requiredResponseFields,
  ]);
  for (const entry of native.cases) {
    const source = inputByName.get(entry.name);
    assert.ok(source, entry.name);
    assert.equal(entry.query, source.query, entry.name);
    assert.deepEqual(entry.scope, source.scope, entry.name);
    assert.equal(entry.parentKey, source.parentKey ?? null, entry.name);
    assert.equal(entry.auth, source.auth ?? 'user', entry.name);
    assert.deepEqual(entry.endpoints, source.endpoints ?? ['items', 'legacy'], entry.name);
    assert.equal(entry.omitScope, source.omitScope ?? false, entry.name);
    assert.equal(entry.omitParentId, source.omitParentId ?? false, entry.name);
    assert.equal(entry.omitIds, source.omitIds ?? false, entry.name);
    assert.equal(entry.recursive, Object.hasOwn(source, 'recursive') ? source.recursive : true, entry.name);
    assert.equal(entry.omitSortBy, source.omitSortBy ?? false, entry.name);
    assert.equal(entry.assertOrder, source.assertOrder ?? false, entry.name);
    assert.equal(entry.expectedStatus, source.expectedStatus ?? 200, entry.name);
    assert.deepEqual(Object.keys(entry).filter(key => !allowedCaseFields.has(key)), [], entry.name);
    assert.ok(requiredResponseFields.every(field => Object.hasOwn(entry, field)), entry.name);
    assert.equal(Number.isInteger(entry.status), true, entry.name);
    assert.deepEqual(entry.keys, [...entry.orderedKeys].sort(), entry.name);
    assert.deepEqual(entry.orderedKeys, entry.items.map(item => item.key), entry.name);
    if (entry.status < 400) {
      assert.equal(entry.contentType, 'application/json; charset=utf-8', entry.name);
      assert.equal(entry.problem, null, entry.name);
      assert.equal(Number.isInteger(entry.startIndex) && entry.startIndex >= 0, true, entry.name);
      assert.equal(Number.isInteger(entry.totalRecordCount) && entry.totalRecordCount >= 0, true, entry.name);
      assert.ok(entry.totalRecordCount >= entry.items.length, entry.name);
    } else {
      assert.equal(entry.status, 400, entry.name);
      assert.equal(entry.contentType, 'text/plain', entry.name);
      assert.deepEqual(entry.problem, { rawBody: 'Error processing request.' }, entry.name);
      assert.equal(entry.startIndex, null, entry.name);
      assert.equal(entry.totalRecordCount, null, entry.name);
      assert.deepEqual(entry.keys, [], entry.name);
      assert.deepEqual(entry.items, [], entry.name);
    }
    for (const item of entry.items) {
      assert.deepEqual(Object.keys(item).sort(), ['key', 'name', 'parentKey', 'type'], `${entry.name}:${item.key}`);
      const seeded = itemByKey.get(item.key);
      assert.ok(seeded, `${entry.name}:${item.key}`);
      const parentId = seeded.parentId == null ? null : idKey(seeded.parentId);
      const expectedParentKey = parentId == null || /^0+$/u.test(parentId) ? null : itemKeyById.get(parentId);
      assert.equal(item.parentKey, expectedParentKey, `${entry.name}:${item.key}:parentKey`);
    }
  }

  const caseByName = new Map(native.cases.map(entry => [entry.name, entry]));
  assert.deepEqual(caseByName.get('genre-ids-empty-guid-repository').orderedKeys,
    ['rockBoth', 'rockJazzBoth', 'rockMapOnly']);
  assert.equal(caseByName.get('memory-genre-ids-empty-guid-is-bad-request').status, 400);
  assert.deepEqual(caseByName.get('memory-genre-ids-empty-guid-empty-folder-short-circuits').orderedKeys, []);
  assert.deepEqual(caseByName.get('memory-genres-precondition-short-circuits-empty-guid').orderedKeys, []);
  assert.deepEqual(caseByName.get('memory-genres-whitespace-matches-empty-segment').orderedKeys,
    ['rockEmptySegmentsColumnOnly']);
  assert.deepEqual(caseByName.get('memory-genres-repeated-empty-matches-empty-segment').orderedKeys,
    ['rockEmptySegmentsColumnOnly']);
});

test('authoritative genre evidence is complete, read-only, cleanly stopped, and tied to frozen inputs', async () => {
  const {
    input, sourceContract, recorderBytes, summary, databaseStages, filesystemStages, setupHttp, nativeHttp,
    nativeSetup, provenance, runtimeManifest,
  } = await loadFixture();
  const endpointCases = input.cases.reduce((total, entry) => total
    + (entry.endpoints ?? ['items', 'legacy']).length, 0);

  assert.equal(summary.passed, true);
  assert.equal(summary.mode, 'main');
  assert.equal(summary.fixtureItems, input.items.length);
  assert.equal(summary.fixtureCases, input.cases.length);
  assert.equal(summary.contractsRecorded, input.cases.length);
  assert.equal(summary.endpointCases, endpointCases);
  assert.equal(summary.httpRecords, endpointCases + 2);
  assert.equal(summary.databaseUnchangedByReads, true);
  assert.equal(summary.filesystemUnchangedByReads, true);
  assert.equal(summary.databaseUnchangedDuringRequests, true);
  assert.equal(summary.databaseUnchangedAfterShutdown, true);
  assert.equal(summary.filesystemUnchangedDuringRequests, true);
  assert.equal(summary.filesystemUnchangedAfterShutdown, true);
  assert.equal(summary.observedDatabaseMutation, false);
  assert.equal(summary.observedFilesystemMutation, false);
  assert.equal(summary.foreignKeyCheckPassedAllStages, true);
  assert.equal(summary.processClean, true);
  assert.equal(summary.error, null);
  assert.ok(sourceContract.cases.every(entry => !Object.hasOwn(entry, 'discoveryOnly')));

  assert.equal(setupHttp.records.length, summary.setupHttpRecords);
  assert.deepEqual(setupHttp.records.map(record => [record.name, record.response.status]), [
    ['setup-login-admin', 200],
    ['setup-create-virtual-folder', 204],
    ['setup-list-virtual-folders', 200],
    ['setup-reference-authenticated-shutdown', 204],
  ]);
  for (const name of ['beforeProvision', 'afterProvision', 'afterSeed', 'beforeReads', 'afterReads', 'finalAfterShutdown']) {
    assert.deepEqual(databaseStages[name].foreignKeyCheck, [], name);
  }
  assert.deepEqual(databaseStages.afterReads, databaseStages.beforeReads);
  assert.deepEqual(databaseStages.finalAfterShutdown, databaseStages.beforeReads);
  assert.deepEqual(filesystemStages.afterReads, filesystemStages.beforeReads);
  assert.deepEqual(filesystemStages.finalAfterShutdown, filesystemStages.beforeReads);

  assertRuntimeEvidence(summary, nativeHttp, provenance);
  assert.equal(summary.process.portInitiallyAvailable, true);
  assert.equal(summary.process.portFinallyAvailable, true);
  for (const name of ['setup', 'recording']) {
    const stage = summary.process.stages[name];
    assert.equal(Number.isInteger(stage.pid) && stage.pid > 0, true, name);
    assert.equal(stage.code, 0, name);
    assert.equal(stage.signal, null, name);
    assert.notEqual(stage.timedOut, true, name);
    assert.equal(stage.cleanShutdown, true, name);
    assert.equal(stage.portAvailable, true, name);
    assert.equal(stage.pidGone, true, name);
    assert.equal(stage.error, null, name);
  }

  assert.equal(nativeSetup.libraryName, 'Genre Filter Library');
  assert.deepEqual(nativeSetup.graph.invariants, {
    collectionFolderWasCreatedByApi: true,
    collectionParentIsUserRoot: true,
    collectionHasExactlyOnePhysicalFolderId: true,
    physicalParentIsAggregate: true,
    physicalPathMatchesRequestedLocation: true,
  });
  assert.equal(nativeHttp.mode, 'main');
  assert.equal(nativeHttp.records.length, summary.httpRecords);
  assert.equal(nativeHttp.records[0].name, 'recording-login-admin');
  assert.equal(nativeHttp.records.at(-1).name, 'reference-authenticated-shutdown');

  assert.equal(runtimeManifest.fileCount, runtimeManifest.entries.length);
  assert.ok(runtimeManifest.fileCount >= 153);
  assert.ok(runtimeManifest.dllCount > 0);
  assert.ok(runtimeManifest.depsJsonCount > 0);
  assert.ok(runtimeManifest.runtimeConfigCount > 0);
  assert.equal(runtimeManifest.entriesSha256, sha256(JSON.stringify(runtimeManifest.entries)));
  assert.equal(provenance.referenceRuntime.entriesSha256, runtimeManifest.entriesSha256);
  await verifyRuntimeManifest(runtimeManifest, provenance.referenceRuntime);

  assert.equal(provenance.recorder.sha256, sha256(recorderBytes));
  const preparedByKind = new Map(provenance.preparedInputs.map(entry => [entry.kind, entry]));
  for (const kind of ['nativeReferencePreparation', 'referencePreparationVerifier', 'referenceBootstrapScript',
    'nativeReferenceBootstrapLog', 'nativeReferenceBaselineManifest', 'nativeReferenceModel']) {
    assert.ok(preparedByKind.has(kind), kind);
  }
  const mappedPreparation = resolveBoundInput(preparedByKind.get('nativeReferencePreparation').path);
  const preparationFile = await resolveContainedRegularFile(mappedPreparation.root, mappedPreparation.relative);
  const preparation = JSON.parse(await readFile(preparationFile.filename));
  assert.equal(preparation.initializedFromEmpty, true);
  assert.equal(preparation.process.stopped, true);
  assert.equal(preparation.process.exitCode, 0);
  assert.equal(preparation.identityRemapping.createdThroughNativeApi, true);
  assert.equal(idKey(preparation.identityRemapping.fixtureUserId), idKey(input.userId));
  assert.equal(preparation.initialDatabaseSha256, preparedByKind.get('frozenSourceDatabase').sha256);
  assert.deepEqual(preparation.foreignKeyCheck, []);
  assert.ok(preparation.migrationHistory > 0);
  assert.ok(preparation.observations.some(entry => entry.route === '/Users/New' && entry.status === 200
    && idKey(entry.responseBody.Id) === idKey(preparation.identityRemapping.actualUserId)));
  assert.ok(preparation.observations.some(entry => entry.route === '/Users/AuthenticateByName' && entry.status === 200
    && entry.responseBody.User.Policy.IsAdministrator === true
    && idKey(entry.responseBody.User.Id) === idKey(preparation.identityRemapping.actualUserId)));
  assert.equal(preparation.observations.at(-1).route, '/System/Shutdown');
  assert.equal(preparation.observations.at(-1).status, 204);
  assert.equal(preparedByKind.get('fixtureInput').sha256, sourceContract.fixtureInputSha256);
  assert.equal(preparedByKind.get('recorderSource').sha256, sha256(recorderBytes));
  await verifyArtifactManifest(bindArtifactSizes(provenance.artifacts));
  await verifyBoundInputs(provenance, runtimeManifest);
  const preparedNativeSources = provenance.preparedInputs.filter(entry => entry.kind === 'frozenNativeSource')
    .map(({ path, sha256: hash }) => ({ path, sha256: hash }));
  assert.deepEqual(preparedNativeSources, provenance.nativeSources);
  for (const suffix of [
    '/Jellyfin.Api/Controllers/ItemsController.cs',
    '/Jellyfin.Api/ModelBinders/CommaDelimitedCollectionModelBinder.cs',
    '/Jellyfin.Api/ModelBinders/PipeDelimitedCollectionModelBinder.cs',
    '/Jellyfin.Api/Middleware/ExceptionMiddleware.cs',
    '/Jellyfin.Server.Implementations/Item/BaseItemRepository.TranslateQuery.cs',
    '/Jellyfin.Server.Implementations/Item/BaseItemMapper.cs',
    '/MediaBrowser.Controller/Entities/Folder.cs',
    '/MediaBrowser.Controller/Entities/UserViewBuilder.cs',
    '/MediaBrowser.Controller/Entities/Genre.cs',
    '/MediaBrowser.Controller/Entities/Audio/MusicGenre.cs',
    '/Emby.Server.Implementations/Library/LibraryManager.cs',
    '/src/Jellyfin.Database/Jellyfin.Database.Implementations/JellyfinQueryHelperExtensions.cs',
    '/src/Jellyfin.Database/Jellyfin.Database.Implementations/Entities/ItemValueType.cs',
    '/src/Jellyfin.Extensions/StringExtensions.cs',
  ]) assert.ok(provenance.nativeSources.some(entry => entry.path.endsWith(suffix)), suffix);
  assert.ok(provenance.preparedInputs.every(entry => !String(entry.path).endsWith('/native.json')
    && !String(entry.path).endsWith('genre-filter-native-fixture.test.js')));
  assert.equal(provenance.result.passed, true);
  assert.equal(provenance.result.databaseUnchangedByReads, true);
  assert.equal(provenance.result.filesystemUnchangedByReads, true);
  assert.equal(provenance.result.observedDatabaseMutation, false);
  assert.equal(provenance.result.observedFilesystemMutation, false);
  assert.equal(provenance.result.foreignKeyCheckPassedAllStages, true);

  const guidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
  const idsIn = value => new Set((JSON.stringify(value).match(guidPattern) ?? []).map(idKey));
  const fixtureIds = new Set(input.items.map(item => idKey(item.id)));
  const dynamicNativeIds = [...idsIn(nativeSetup.graph.actual)].filter(id => !fixtureIds.has(id));
  const contractIds = idsIn(sourceContract);
  assert.ok(dynamicNativeIds.length > 0);
  for (const id of dynamicNativeIds) assert.equal(contractIds.has(id), false, id);
});

test('genre runtime evidence rejects disconnected port, origin, result, and invocation facts', async () => {
  const { summary, nativeHttp, provenance } = await loadFixture();
  const fallback = structuredClone({ summary, nativeHttp, provenance });
  const fallbackPort = fallback.summary.process.preferredPort + 1;
  for (const process of [fallback.summary.process, fallback.provenance.result.process]) {
    process.preferredPortInitiallyAvailable = false;
    process.selectedPort = fallbackPort;
  }
  fallback.provenance.isolation.preferredPortInitiallyAvailable = false;
  fallback.provenance.isolation.selectedPort = fallbackPort;
  fallback.summary.origin = `http://127.0.0.1:${fallbackPort}`;
  fallback.nativeHttp.origin = fallback.summary.origin;
  assert.doesNotThrow(() => assertRuntimeEvidence(fallback.summary, fallback.nativeHttp, fallback.provenance));

  const cases = [
    ['summary selected port', value => { value.summary.process.selectedPort += 1; }],
    ['native HTTP origin', value => { value.nativeHttp.origin = 'http://127.0.0.1:1'; }],
    ['provenance isolation port', value => { value.provenance.isolation.selectedPort += 1; }],
    ['provenance result process', value => { value.provenance.result.process.selectedPort += 1; }],
    ['recorder invocation port', value => { value.provenance.recorderInvocation[3] = '65535'; }],
  ];
  for (const [name, tamper] of cases) {
    const value = structuredClone({ summary, nativeHttp, provenance });
    tamper(value);
    assert.throws(() => assertRuntimeEvidence(value.summary, value.nativeHttp, value.provenance), {
      code: 'ERR_ASSERTION',
    }, name);
  }

  const invalidFallback = structuredClone(fallback);
  invalidFallback.summary.process.selectedPort = invalidFallback.summary.process.preferredPort;
  invalidFallback.provenance.result.process.selectedPort = invalidFallback.summary.process.selectedPort;
  invalidFallback.provenance.isolation.selectedPort = invalidFallback.summary.process.selectedPort;
  invalidFallback.summary.origin = `http://127.0.0.1:${invalidFallback.summary.process.selectedPort}`;
  invalidFallback.nativeHttp.origin = invalidFallback.summary.origin;
  assert.throws(() => assertRuntimeEvidence(invalidFallback.summary, invalidFallback.nativeHttp,
    invalidFallback.provenance), { code: 'ERR_ASSERTION' });
});

test('genre evidence manifests reject omission, insertion, reorder, tampering, and linked-root escape', async () => {
  const { provenance, runtimeManifest } = await loadFixture();
  const artifactCases = [
    value => value.splice(0),
    value => value.pop(),
    value => value.push({ ...value[0], path: 'extra.json' }),
    value => value.reverse(),
    value => { value[0].sha256 = '0'.repeat(64); },
    value => { value[0].size += 1; },
  ];
  for (const tamper of artifactCases) {
    const candidate = structuredClone(bindArtifactSizes(provenance.artifacts));
    tamper(candidate);
    await assert.rejects(() => verifyArtifactManifest(candidate), assert.AssertionError);
  }

  const runtimeCases = [
    value => value.entries.splice(0),
    value => value.entries.pop(),
    value => value.entries.push({ ...value.entries[0], path: 'unexpected-runtime-file' }),
    value => value.entries.reverse(),
    value => { value.entries[0].sha256 = '0'.repeat(64); },
    value => { value.entries[0].size += 1; },
  ];
  for (const tamper of runtimeCases) {
    const candidate = structuredClone(runtimeManifest);
    tamper(candidate);
    sealRuntimeManifest(candidate);
    const binding = {
      ...provenance.referenceRuntime,
      fileCount: candidate.fileCount,
      dllCount: candidate.dllCount,
      depsJsonCount: candidate.depsJsonCount,
      runtimeConfigCount: candidate.runtimeConfigCount,
      entriesSha256: candidate.entriesSha256,
    };
    await assert.rejects(() => verifyRuntimeManifest(candidate, binding), assert.AssertionError);
  }


  const [sourceConfig, preparedConfig] = await Promise.all([
    readFile(path.join(evidenceRoot, 'source-config-manifest.json'), 'utf8').then(JSON.parse),
    readFile(path.join(evidenceRoot, 'prepared-config-manifest.json'), 'utf8').then(JSON.parse),
  ]);
  const configManifestCases = [
    value => value.entries.splice(0),
    value => value.entries.pop(),
    value => value.entries.push({ ...value.entries[0], path: 'unexpected.xml' }),
    value => value.entries.reverse(),
    value => { value.entries[0].sha256 = '0'.repeat(64); },
    value => { value.entries[0].size += 1; },
  ];
  for (const tamper of configManifestCases) {
    const candidate = structuredClone(preparedConfig);
    tamper(candidate);
    candidate.entriesSha256 = sha256(JSON.stringify(candidate.entries));
    await assert.rejects(() => verifyConfigLifecycle(sourceConfig, candidate), assert.AssertionError);
  }

  const unexpectedSecondRewrite = finalConfigManifest(preparedConfig);
  unexpectedSecondRewrite.entries.find(entry => entry.path === 'database.xml').sha256 = '0'.repeat(64);
  unexpectedSecondRewrite.entriesSha256 = sha256(JSON.stringify(unexpectedSecondRewrite.entries));
  assert.throws(() => assertConfigTransition(preparedConfig, unexpectedSecondRewrite, ['encoding.xml']),
    assert.AssertionError);
  for (const tamper of [
    entry => { entry.sha256 = '0'.repeat(64); },
    entry => { entry.size += 1; },
  ]) {
    const candidate = finalConfigManifest(preparedConfig);
    tamper(candidate.entries.find(entry => entry.path === 'encoding.xml'));
    candidate.entriesSha256 = sha256(JSON.stringify(candidate.entries));
    await assert.rejects(() => verifyDirectoryManifest(candidate, path.join(evidenceRoot, 'reference/config'),
      candidate.entriesSha256), assert.AssertionError);
  }

  await assert.rejects(() => resolveContainedRegularFile(evidenceRoot, '../outside.json'), assert.AssertionError);
  assert.throws(() => resolveBoundInput('../outside.json'), assert.AssertionError);
  const containmentRoot = await mkdtemp(path.join(tmpdir(), 'mediamanager-genre-evidence-root-'));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'mediamanager-genre-evidence-outside-'));
  try {
    await writeFile(path.join(outsideRoot, 'outside.json'), '{}');
    await symlink(outsideRoot, path.join(containmentRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => resolveContainedRegularFile(containmentRoot, 'escape/outside.json'),
      assert.AssertionError);
  } finally {
    await rm(containmentRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test('raw native GET records independently reproduce every stable genre contract and input-derived route', async () => {
  const { input, sourceContract, nativeHttp, nativeSetup } = await loadFixture();
  const itemByKey = new Map(input.items.map(item => [item.key, item]));
  const resolvedIdByFixtureId = new Map(input.items.map(item => [idKey(item.id), item.id]));
  const keyById = new Map(input.items.map(item => [idKey(item.id), item.key]));
  for (const [key, mapping] of Object.entries(nativeSetup.graph.fixtureKeyMapping)) {
    assert.equal(idKey(mapping.fixtureId), idKey(itemByKey.get(key).id), key);
    resolvedIdByFixtureId.set(idKey(mapping.fixtureId), mapping.actualId);
    keyById.set(idKey(mapping.actualId), key);
  }
  const resolvedId = value => resolvedIdByFixtureId.get(idKey(value)) ?? value;
  const routeFor = (endpoint, source) => {
    const parent = source.parentKey == null ? null : itemByKey.get(source.parentKey);
    const parentId = resolvedId(parent?.id ?? input.rootId);
    const scopeIds = source.scope.map(key => resolvedId(itemByKey.get(key).id)).join(',');
    const recursive = Object.hasOwn(source, 'recursive') ? source.recursive : true;
    const parts = [
      ...(!source.omitParentId && !source.omitScope ? [`ParentId=${encodeURIComponent(parentId)}`] : []),
      ...(recursive === null || source.omitScope ? [] : [`Recursive=${recursive}`]),
      ...(!source.omitIds && !source.omitScope ? [`Ids=${encodeURIComponent(scopeIds)}`] : []),
      ...(!source.omitSortBy ? ['SortBy=SortName'] : []),
      'Fields=ParentId',
      'EnableImages=false',
      'EnableUserData=false',
      source.query,
    ];
    const prefix = endpoint === 'items' ? '/Items' : `/Users/${input.userId}/Items`;
    return `${prefix}?${parts.filter(Boolean).join('&')}`;
  };
  const responseProjection = record => {
    const responseItems = Array.isArray(record.response.bodyJson?.Items) ? record.response.bodyJson.Items : [];
    const orderedKeys = responseItems.map(item => {
      const key = keyById.get(idKey(item.Id));
      assert.ok(key, `${record.name}:${item.Id}`);
      return key;
    });
    return {
      status: record.response.status,
      contentType: record.response.headers['content-type'] ?? null,
      startIndex: record.response.bodyJson?.StartIndex ?? null,
      totalRecordCount: record.response.bodyJson?.TotalRecordCount ?? null,
      keys: [...orderedKeys].sort(),
      orderedKeys,
      items: responseItems.map((item, index) => ({
        key: orderedKeys[index],
        name: item.Name,
        type: item.Type,
        parentKey: item.ParentId == null ? null : (keyById.get(idKey(item.ParentId)) ?? null),
      })),
      problem: record.response.status >= 400
        ? record.response.bodyJson && typeof record.response.bodyJson === 'object'
          ? Object.fromEntries(Object.entries(record.response.bodyJson).filter(([key]) => key !== 'traceId'))
          : { rawBody: record.response.bodyText }
        : null,
    };
  };

  const contractByName = new Map(sourceContract.cases.map(entry => [entry.name, entry]));
  const expectedRecordNames = ['recording-login-admin', ...input.cases.flatMap(source =>
    (source.endpoints ?? ['items', 'legacy']).map(endpoint => `${source.name}:${endpoint}`)),
  'reference-authenticated-shutdown'];
  assert.deepEqual(nativeHttp.records.map(record => record.name), expectedRecordNames);
  const recordByName = new Map(nativeHttp.records.map(record => [record.name, record]));
  for (const source of input.cases) {
    const expected = contractByName.get(source.name);
    assert.ok(expected, source.name);
    const stableResponse = Object.fromEntries(['status', 'contentType', 'startIndex', 'totalRecordCount', 'keys', 'orderedKeys', 'items', 'problem']
      .map(field => [field, expected[field]]));
    for (const endpoint of source.endpoints ?? ['items', 'legacy']) {
      const record = recordByName.get(`${source.name}:${endpoint}`);
      assert.ok(record, `${source.name}:${endpoint}`);
      assert.equal(record.request.method, 'GET', `${source.name}:${endpoint}`);
      assert.equal(record.request.route, routeFor(endpoint, source), `${source.name}:${endpoint}`);
      assert.deepEqual(responseProjection(record), stableResponse, `${source.name}:${endpoint}`);
    }
  }
});
