import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertNativeIdentityLaunchBinding,
  assertNativeIdentityArtifactManifest,
  nativeIdentityArtifactPaths,
} from './native-identity-evidence-contract.js';
import { assertNativeItemFilterArtifactManifest } from './native-item-filter-evidence.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
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

// Historical source/preparation revalidation is preserved as original source in
// fixtures/historical-evidence-checks. These descriptors are synthetic controls,
// not a claim that the native application was launched.
test('identity launch binding rejects changed executable paths and digests in a synthetic envelope', () => {
  const files = ['dotnet', 'jellyfin.dll', 'ffmpeg'].map(name => path.join(tmpdir(), 'synthetic-launch', name));
  const hashes = { dotnetSha256: sha256('dotnet control'), dllSha256: sha256('DLL control'),
    ffmpegSha256: sha256('ffmpeg control') };
  const referencePreparation = {
    bootstrap: { executables: files.map(filename => ({ path: filename })) },
    executables: { dotnet: { sha256: hashes.dotnetSha256 }, jellyfinDll: { sha256: hashes.dllSha256 },
      ffmpeg: { sha256: hashes.ffmpegSha256 } },
  };
  const launch = { command: [files[0], files[1], '--ffmpeg', files[2]], before: { ...hashes }, after: { ...hashes } };
  const verify = (value, preparation = referencePreparation) => assertNativeIdentityLaunchBinding({
    launch: value, referencePreparation: preparation, hashes, label: 'synthetic-negative-control',
  });
  assert.doesNotThrow(() => verify(launch));
  for (const mutate of [
    value => { value.command[0] = path.join(tmpdir(), 'different-dotnet'); },
    value => { value.command[value.command.indexOf('--ffmpeg') + 1] = path.join(tmpdir(), 'different-ffmpeg'); },
    value => { value.before.dotnetSha256 = '0'.repeat(64); },
    value => { value.after.ffmpegSha256 = '0'.repeat(64); },
  ]) {
    const changed = clone(launch); mutate(changed);
    assert.throws(() => verify(changed));
  }
  const changedPreparation = clone(referencePreparation);
  changedPreparation.executables.jellyfinDll.sha256 = '0'.repeat(64);
  assert.throws(() => verify(launch, changedPreparation));
});
