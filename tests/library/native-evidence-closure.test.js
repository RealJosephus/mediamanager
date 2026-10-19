import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validationFileUrl } from '../../tools/validation/paths.js';
import { nativeQueryInputs, nativeQueryReference } from './native-query-default-inputs.js';
import {
  assertNativeIdentityLaunchBinding,
  assertNativeIdentityArtifactManifest,
  nativeIdentityArtifactPaths,
} from './native-identity-evidence-contract.js';
import { assertNativeItemFilterArtifactManifest } from './native-item-filter-evidence.js';
import {
  resolveNativeReferencePreparationInput,
  verifyNativeReferencePreparation,
} from './native-reference-preparation.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureUserId = '5c6b5f77-bea9-4a9a-98aa-fae5909892b7';
const clone = value => structuredClone(value);

async function artifact(root, relative) {
  const bytes = await readFile(path.join(root, ...relative.split('/')));
  const metadata = await lstat(path.join(root, ...relative.split('/')));
  return { path: relative, size: metadata.size, sha256: sha256(bytes) };
}

async function createArtifactRoot(paths) {
  const root = await mkdtemp(path.join(tmpdir(), 'mediamanager-native-evidence-'));
  for (const [index, relative] of paths.entries()) {
    const filename = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, `artifact-${index}\n`);
  }
  return { root, artifacts: await Promise.all(paths.map(relative => artifact(root, relative))) };
}

function artifactMutations() {
  return [
    candidate => { candidate.length = 0; },
    candidate => { candidate.pop(); },
    candidate => { candidate.push(clone(candidate[0])); },
    candidate => { [candidate[0], candidate[1]] = [candidate[1], candidate[0]]; },
    candidate => { candidate[0].sha256 = '0'.repeat(64); },
    candidate => { candidate[0].size += 1; },
    candidate => { candidate[0].extra = true; },
  ];
}

test('item-filter artifact manifest rejects list, metadata, traversal, root-link, and junction tampering', async t => {
  const expectedPaths = ['record-native.mjs', 'native-run/reference-preparation.json'];
  const { root, artifacts } = await createArtifactRoot(expectedPaths);
  t.after(() => rm(root, { recursive: true, force: true }));
  await assertNativeItemFilterArtifactManifest({ evidenceRoot: root, artifacts, expectedPaths });
  for (const mutate of artifactMutations()) {
    const candidate = clone(artifacts);
    mutate(candidate);
    await assert.rejects(assertNativeItemFilterArtifactManifest({ evidenceRoot: root,
      artifacts: candidate, expectedPaths }));
  }
  await assert.rejects(assertNativeItemFilterArtifactManifest({ evidenceRoot: root,
    artifacts: [{ ...artifacts[0], path: '../outside' }], expectedPaths: ['../outside'] }), /escapes|canonical/u);

  const outside = await mkdtemp(path.join(tmpdir(), 'mediamanager-native-evidence-outside-'));
  const linkedRoot = `${root}-linked`;
  t.after(() => rm(outside, { recursive: true, force: true }));
  t.after(() => rm(linkedRoot, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'reference-preparation.json'), 'outside\n');
  await symlink(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertNativeItemFilterArtifactManifest({ evidenceRoot: linkedRoot,
    artifacts: [], expectedPaths: [] }), /root cannot be a link/u);

  const junctionRoot = await mkdtemp(path.join(tmpdir(), 'mediamanager-native-evidence-junction-'));
  t.after(() => rm(junctionRoot, { recursive: true, force: true }));
  await writeFile(path.join(junctionRoot, 'record-native.mjs'), 'recorder\n');
  await symlink(outside, path.join(junctionRoot, 'native-run'), process.platform === 'win32' ? 'junction' : 'dir');
  const junctionPaths = ['record-native.mjs', 'native-run/reference-preparation.json'];
  const junctionArtifacts = await Promise.all(junctionPaths.map(relative => artifact(junctionRoot, relative)));
  await assert.rejects(assertNativeItemFilterArtifactManifest({ evidenceRoot: junctionRoot,
    artifacts: junctionArtifacts, expectedPaths: junctionPaths }), /escapes its real root/u);
});

test('identity artifact manifest rejects list, metadata, traversal, root-link, and junction tampering', async t => {
  const expectedPaths = nativeIdentityArtifactPaths('artist-concurrency-native-v1', 'native-run-b', 'race');
  const { root, artifacts } = await createArtifactRoot(expectedPaths);
  t.after(() => rm(root, { recursive: true, force: true }));
  await assertNativeIdentityArtifactManifest({ evidenceRoot: root, artifacts, expectedPaths });
  for (const mutate of artifactMutations()) {
    const candidate = clone(artifacts);
    mutate(candidate);
    await assert.rejects(assertNativeIdentityArtifactManifest({ evidenceRoot: root,
      artifacts: candidate, expectedPaths }));
  }
  await assert.rejects(assertNativeIdentityArtifactManifest({ evidenceRoot: root,
    artifacts: [{ ...artifacts[0], path: '../outside' }], expectedPaths: ['../outside'] }), /escapes|canonical/u);

  const outside = await mkdtemp(path.join(tmpdir(), 'mediamanager-native-identity-outside-'));
  const linkedRoot = `${root}-linked`;
  t.after(() => rm(outside, { recursive: true, force: true }));
  t.after(() => rm(linkedRoot, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'reference-preparation.json'), 'outside\n');
  await symlink(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertNativeIdentityArtifactManifest({ evidenceRoot: linkedRoot,
    artifacts: [], expectedPaths: [] }), /root cannot be a link/u);

  const junctionRoot = await mkdtemp(path.join(tmpdir(), 'mediamanager-native-identity-junction-'));
  t.after(() => rm(junctionRoot, { recursive: true, force: true }));
  for (const relative of expectedPaths.filter(relative => !relative.startsWith('native-run-b/'))) {
    const filename = path.join(junctionRoot, ...relative.split('/'));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, 'recorder\n');
  }
  await mkdir(path.join(outside, 'native-run-b'), { recursive: true });
  for (const relative of expectedPaths.filter(relative => relative.startsWith('native-run-b/'))) {
    await writeFile(path.join(outside, ...relative.split('/')), `${relative}\n`);
  }
  await symlink(path.join(outside, 'native-run-b'), path.join(junctionRoot, 'native-run-b'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const junctionArtifacts = await Promise.all(expectedPaths.map(relative => artifact(junctionRoot, relative)));
  await assert.rejects(assertNativeIdentityArtifactManifest({ evidenceRoot: junctionRoot,
    artifacts: junctionArtifacts, expectedPaths }), /escapes its real root/u);
});

test('reference-preparation gate rejects state, exact-input, hash, and current-input tampering', async t => {
  const preparationUrl = validationFileUrl(
    '../../.agent-docs/evidence/item-filter-inputs/classification-filters-native-v1/native-run/reference-preparation.json',
    import.meta.url);
  const sourceDatabase = nativeQueryReference.sourceDatabase.filename;
  const preparation = JSON.parse(await readFile(preparationUrl, 'utf8'));
  const verify = candidate => verifyNativeReferencePreparation({
    inputs: nativeQueryInputs,
    preparation: candidate,
    profile: 'item-filter',
    sourceDatabase,
    fixtureUserId,
  });
  await verify(preparation);
  const mutations = [
    candidate => { candidate.initializedFromEmpty = false; },
    candidate => { candidate.createdThroughNativeApi = false; },
    candidate => { candidate.stopped = false; },
    candidate => { candidate.extra = true; },
    candidate => { candidate.inputs.pop(); },
    candidate => { candidate.inputs.push(clone(candidate.inputs[0])); },
    candidate => { [candidate.inputs[0], candidate.inputs[1]] = [candidate.inputs[1], candidate.inputs[0]]; },
    candidate => { candidate.inputs[0].kind = 'tampered'; },
    candidate => { candidate.inputs[0].path = '../bootstrap.json'; },
    candidate => { candidate.inputs[0].sha256 = '0'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const candidate = clone(preparation);
    mutate(candidate);
    await assert.rejects(verify(candidate));
  }

  const temporary = await mkdtemp(path.join(tmpdir(), 'mediamanager-reference-input-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const originalBootstrap = resolveNativeReferencePreparationInput('item-filter', preparation.inputs[0].path, nativeQueryInputs);
  const tamperedReport = JSON.parse(await readFile(originalBootstrap, 'utf8'));
  tamperedReport.process.stopped = false;
  const tamperedBytes = Buffer.from(JSON.stringify(tamperedReport));
  const tamperedBootstrap = path.join(temporary, 'bootstrap.json');
  await writeFile(tamperedBootstrap, tamperedBytes);
  const coherent = clone(preparation);
  coherent.inputs[0].sha256 = sha256(tamperedBytes);
  const injectedResolver = (profile, historicalPath) => historicalPath === coherent.inputs[0].path
    ? tamperedBootstrap : resolveNativeReferencePreparationInput(profile, historicalPath, nativeQueryInputs);
  await assert.rejects(verifyNativeReferencePreparation({ preparation: coherent, profile: 'item-filter',
    sourceDatabase, fixtureUserId, resolveInput: injectedResolver, inputs: nativeQueryInputs }), /stopped process/u);
});

test('identity launch binding rejects executable corruption in a synthetic envelope over verified native inputs', async () => {
  const evidenceRoot = validationFileUrl(
    '../../.agent-docs/evidence/user-view-inputs/user-root-visibility-native-v1/', import.meta.url);
  const [provenance, summary, preparation] = await Promise.all([
    readFile(new URL('provenance.json', evidenceRoot), 'utf8').then(JSON.parse),
    readFile(new URL('native-run-v4/summary.json', evidenceRoot), 'utf8').then(JSON.parse),
    readFile(new URL('native-run-v4/reference-preparation.json', evidenceRoot), 'utf8').then(JSON.parse),
  ]);
  const referencePreparation = await verifyNativeReferencePreparation({
    inputs: nativeQueryInputs,
    preparation,
    profile: 'user-view',
    sourceDatabase: new URL('source-initial.db', evidenceRoot),
    fixtureUserId,
  });
  const hashes = summary;
  // UserView records executable digests directly, rather than an identity
  // recorder's before/after envelope. This is a negative-control unit fixture,
  // not a claim that the identity recorder ran or emitted this envelope.
  const digestFields = ['dotnetSha256', 'dllSha256', 'ffmpegSha256'];
  const launch = {
    command: provenance.launch.command,
    before: Object.fromEntries(digestFields.map(key => [key, provenance.launch[key]])),
    after: Object.fromEntries(digestFields.map(key => [key, provenance.launch[key]])),
  };
  const verify = launch => assertNativeIdentityLaunchBinding({
    launch,
    referencePreparation,
    hashes,
    label: 'negative-control',
  });
  assert.doesNotThrow(() => verify(launch));
  const mutations = [
    launch => { launch.command[0] = 'tampered-dotnet'; },
    launch => { launch.command[launch.command.indexOf('--ffmpeg') + 1] = 'tampered-ffmpeg'; },
    launch => { launch.before.dotnetSha256 = '0'.repeat(64); },
    launch => { launch.after.ffmpegSha256 = '0'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const candidate = clone(launch);
    mutate(candidate);
    assert.throws(() => verify(candidate));
  }
});
