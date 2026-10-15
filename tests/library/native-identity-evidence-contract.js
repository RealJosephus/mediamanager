import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function isWithin(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export async function evidenceRootState(evidenceRoot) {
  const root = path.resolve(evidenceRoot instanceof URL ? fileURLToPath(evidenceRoot) : evidenceRoot);
  const [metadata, resolved] = await Promise.all([lstat(root), realpath(root)]);
  assert.equal(metadata.isSymbolicLink(), false, 'Identity evidence root cannot be a link.');
  assert.equal(metadata.isDirectory(), true, 'Identity evidence root must be a directory.');
  return { root, resolved };
}

export async function resolveEvidenceFile(rootState, relative) {
  assert.equal(typeof relative, 'string', 'Identity artifact paths must be strings.');
  assert.equal(relative.includes('\\'), false, `Identity artifact path must use canonical separators: ${relative}`);
  assert.equal(path.posix.normalize(relative), relative, `Identity artifact path must be canonical: ${relative}`);
  assert.equal(path.posix.isAbsolute(relative), false, `Identity artifact path must be relative: ${relative}`);
  const filename = path.resolve(rootState.root, ...relative.split('/'));
  assert.ok(isWithin(rootState.root, filename), `Identity artifact escapes its root: ${relative}`);
  const [metadata, resolved] = await Promise.all([lstat(filename), realpath(filename)]);
  assert.equal(metadata.isSymbolicLink(), false, `Identity artifact cannot be a link: ${relative}`);
  assert.equal(metadata.isFile(), true, `Identity artifact must be a regular file: ${relative}`);
  assert.ok(isWithin(rootState.resolved, resolved), `Identity artifact escapes its real root: ${relative}`);
  return { filename, metadata };
}

export async function jsonEvidenceFile(rootState, relative) {
  const { filename } = await resolveEvidenceFile(rootState, relative);
  return JSON.parse(await readFile(filename, 'utf8'));
}

export function identityRecorderName(evidenceName, mode) {
  if (evidenceName === 'studio-path-race-native-v1') {
    const recorder = {
      race: 'record-native.mjs',
      'race-reverse': 'record-reverse-native.mjs',
      'race-eight': 'record-eight-native.mjs',
      'race-eight-reverse': 'record-eight-reverse-native.mjs',
    }[mode];
    assert.ok(recorder, `Unsupported studio path-race mode: ${mode}`);
    return recorder;
  }
  if (mode === 'concurrency' || mode === 'unicode') return 'record-native.mjs';
  const recorder = {
    race: 'record-path-race-native.mjs',
    'race-reverse': 'record-path-race-reverse-native.mjs',
    'race-eight': 'record-path-race-eight-native.mjs',
    'race-eight-reverse': 'record-path-race-eight-reverse-native.mjs',
  }[mode];
  assert.ok(recorder, `Unsupported identity mode: ${mode}`);
  return recorder;
}

export function nativeIdentityArtifactPaths(evidenceName, runName, mode) {
  return [
    identityRecorderName(evidenceName, mode),
    `${runName}/reference-preparation.json`,
    `${runName}/native-http.json`,
    `${runName}/stages.json`,
    `${runName}/summary.json`,
  ];
}

export async function assertNativeIdentityArtifactManifest({ evidenceRoot, artifacts, expectedPaths }) {
  const rootState = await evidenceRootState(evidenceRoot);
  assert.ok(Array.isArray(artifacts), 'Identity artifact manifest must be an array.');
  assert.deepEqual(artifacts.map(artifact => artifact.path), expectedPaths,
    'Identity artifacts must be the exact canonical list in recording order.');
  for (const artifact of artifacts) {
    assert.deepEqual(Object.keys(artifact).sort(), ['path', 'sha256', 'size'], `${artifact.path}: artifact fields`);
    assert.equal(Number.isSafeInteger(artifact.size) && artifact.size >= 0, true, `${artifact.path}: size`);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/u, `${artifact.path}: sha256`);
    const { filename, metadata } = await resolveEvidenceFile(rootState, artifact.path);
    const bytes = await readFile(filename);
    assert.equal(metadata.size, artifact.size, `${artifact.path}: stat size`);
    assert.equal(bytes.length, artifact.size, `${artifact.path}: read size`);
    assert.equal(sha256(bytes), artifact.sha256, `${artifact.path}: sha256`);
  }
}

export function assertNativeIdentityLaunchBinding({ launch, referencePreparation, hashes, label }) {
  assert.deepEqual(Object.keys(launch ?? {}).sort(), ['after', 'before', 'command'], `${label}: launch fields`);
  assert.deepEqual(launch.before, {
    dotnetSha256: hashes.dotnetSha256,
    dllSha256: hashes.dllSha256,
    ffmpegSha256: hashes.ffmpegSha256,
  }, `${label}: launch-before hashes`);
  assert.deepEqual(launch.after, launch.before, `${label}: launch executable stability`);
  assert.ok(Array.isArray(launch.command), `${label}: launch command`);
  const ffmpegIndex = launch.command.indexOf('--ffmpeg');
  assert.ok(ffmpegIndex > 1 && ffmpegIndex + 1 < launch.command.length, `${label}: launch ffmpeg argument`);
  assert.equal(path.normalize(launch.command[0]),
    path.normalize(referencePreparation.bootstrap.executables[0].path), `${label}: launch dotnet path`);
  assert.equal(path.normalize(launch.command[1]),
    path.normalize(referencePreparation.bootstrap.executables[1].path), `${label}: launch DLL path`);
  assert.equal(path.normalize(launch.command[ffmpegIndex + 1]),
    path.normalize(referencePreparation.bootstrap.executables[2].path), `${label}: launch ffmpeg path`);
  assert.equal(referencePreparation.executables.dotnet.sha256, hashes.dotnetSha256,
    `${label}: current dotnet identity`);
  assert.equal(referencePreparation.executables.jellyfinDll.sha256, hashes.dllSha256,
    `${label}: current DLL identity`);
  assert.equal(referencePreparation.executables.ffmpeg.sha256, hashes.ffmpegSha256,
    `${label}: current ffmpeg identity`);
}
