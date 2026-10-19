import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createStatePackage, verifyStatePackage, restoreStatePackage } from '../../src/migration/state-package.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { createIsolatedOfflineCopyCaptureSession } from '../../src/migration/capture-session.js';
import { seedAllTables } from '../database/fixtures.js';
import { createInstanceFixture } from './instance-fixture.js';

const reservedRestorePaths = ['mediamanager-state.json', 'mediamanager-state.json.tmp', 'COMMITTED', 'COMMITTED.tmp',
  'manifest.json', 'manifest.json.tmp', 'progress.json', 'progress.json.tmp'];
const conflictingRestorePaths = [
  ...reservedRestorePaths.flatMap(value => [value, `${value.toUpperCase()}/jellyfin.db`]),
  'config/system.xml', 'CONFIG/SYSTEM.XML', 'config', 'config/system.xml/jellyfin.db',
];

async function resignManifest(directory, manifest) {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(directory, 'manifest.json'), text);
  const commit = { generation: manifest.generation,
    manifestSha256: createHash('sha256').update(text).digest('hex') };
  await writeFile(path.join(directory, 'COMMITTED'), `${JSON.stringify(commit, null, 2)}\n`);
}

const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const captureStagingPath = destination => path.join(path.dirname(destination), `.${path.basename(destination)}.mediamanager-package-staging`);

test('state package captures complete instance roots and unknown assets, then detects tampering', async t => {
  const fixture = await createInstanceFixture(t, { baseline: 'fixture-baseline' });
  seedAllTables(fixture.database);
  await mkdir(path.join(fixture.root, 'config/plugins'));
  await writeFile(path.join(fixture.root, 'config/plugins/unknown.bin'), Buffer.from([0, 255, 0, 2]));
  const destination = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination, extensionState: { mount: '/媒体' } }));
  assert.equal(manifest.instanceFiles.some(file => file.path === 'config/plugins/unknown.bin'), true);
  assert.equal(manifest.remoteAssets.length, 0);
  assert.equal(manifest.directories.some(directory => directory.path === 'cache'), true);
  assert.equal(manifest.directories.some(directory => directory.path === 'log'), true);
  assert.equal(manifest.directories.some(directory => directory.path === 'data/metadata'), true);
  await verifyStatePackage(destination);

  const restored = await restoreStatePackage(destination, path.join(fixture.directory, 'restored'));
  assert.equal(restored.mediaAccessVerified, false);
  assert.equal(restored.resumed, false);
  assert.equal(restored.alreadyRestored, false);
  assert.match(await readFile(path.join(restored.destination, 'config/system.xml'), 'utf8'), /UICulture/u);
  assert.equal(await readFile(path.join(restored.destination, 'config/plugins/unknown.bin'), 'hex'), '00ff0002');
  for (const relative of ['cache', 'log', 'data/metadata']) assert.equal((await stat(path.join(restored.destination, relative))).isDirectory(), true);
  const restoredState = JSON.parse(await readFile(path.join(restored.destination, 'mediamanager-state.json'), 'utf8'));
  assert.equal(restoredState.stage, 'complete');
  assert.equal(restoredState.destination, restored.destination);
  assert.match(restoredState.manifestSha256, /^[a-f0-9]{64}$/u);

  await writeFile(path.join(destination, 'files/config/system.xml'), 'tampered');
  await assert.rejects(verifyStatePackage(destination), /checksum/u);
});

test('external metadata and cache restore inside each destination without merging default roots or retaining source paths', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-external-' });
  const metadata = path.join(fixture.directory, 'source metadata & state');
  const cache = path.join(fixture.directory, 'source cache & state');
  await mkdir(metadata); await mkdir(cache);
  await writeFile(path.join(metadata, 'shared.bin'), 'external metadata');
  await writeFile(path.join(cache, 'shared.bin'), 'external cache');
  await writeFile(path.join(fixture.root, 'data/metadata/shared.bin'), 'default metadata');
  await writeFile(path.join(fixture.root, 'cache/shared.bin'), 'default cache');
  await writeFile(path.join(fixture.root, 'config/system.xml'), `<ServerConfiguration><MetadataPath>${xml(metadata)}</MetadataPath><CachePath>${xml(cache)}</CachePath></ServerConfiguration>`);
  const packageDirectory = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination: packageDirectory }));
  assert.deepEqual(manifest.instanceState.pathBindings, {
    metadata: { configured: true, root: 'metadata-external', relativePath: '' },
    cache: { configured: true, root: 'cache-external', relativePath: '' },
  });
  await rm(metadata, { recursive: true }); await rm(cache, { recursive: true });

  for (const name of ['restored-a', 'restored-b']) {
    const destination = path.join(fixture.directory, name);
    await restoreStatePackage(packageDirectory, destination);
    const settings = await readInstanceConfiguration(destination);
    assert.equal(settings.configuration.MetadataPath, path.join(destination, 'metadata-external'));
    assert.equal(settings.configuration.CachePath, path.join(destination, 'cache-external'));
    assert.equal(await readFile(path.join(destination, 'metadata-external/shared.bin'), 'utf8'), 'external metadata');
    assert.equal(await readFile(path.join(destination, 'cache-external/shared.bin'), 'utf8'), 'external cache');
    assert.equal(await readFile(path.join(destination, 'data/metadata/shared.bin'), 'utf8'), 'default metadata');
    assert.equal(await readFile(path.join(destination, 'cache/shared.bin'), 'utf8'), 'default cache');
    const state = await discoverInstanceState({ instanceRoot: destination });
    assert.equal(state.paths.metadata, path.join(destination, 'metadata-external'));
    assert.equal(state.paths.cache, path.join(destination, 'cache-external'));
    assert.deepEqual(Object.keys(state.roots), ['data', 'config', 'cache', 'log', 'metadata-external', 'cache-external']);
  }
});

test('configured paths already inside core roots are rebased to the restored destination', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-rebase-' });
  const metadata = path.join(fixture.root, 'data/metadata/custom');
  const cache = path.join(fixture.root, 'cache/custom');
  await mkdir(metadata, { recursive: true }); await mkdir(cache);
  await writeFile(path.join(metadata, 'metadata.bin'), 'metadata');
  await writeFile(path.join(cache, 'cache.bin'), 'cache');
  await writeFile(path.join(fixture.root, 'config/system.xml'), `<ServerConfiguration><MetadataPath>${xml(metadata)}</MetadataPath><CachePath>${xml(cache)}</CachePath></ServerConfiguration>`);
  const packageDirectory = path.join(fixture.directory, 'package');
  await createStatePackage(await fixture.packageOptions({ destination: packageDirectory }));
  const destination = path.join(fixture.directory, 'restored');
  await restoreStatePackage(packageDirectory, destination);
  const state = await discoverInstanceState({ instanceRoot: destination });
  assert.equal(state.paths.metadata, path.join(destination, 'data/metadata/custom'));
  assert.equal(state.paths.cache, path.join(destination, 'cache/custom'));
  assert.deepEqual(state.pathBindings, {
    metadata: { configured: true, root: 'data', relativePath: 'metadata/custom' },
    cache: { configured: true, root: 'cache', relativePath: 'custom' },
  });
});

test('local restore resumes verified staged files and publishes the destination atomically', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-resume-' });
  await mkdir(path.join(fixture.root, 'config/plugins'));
  await writeFile(path.join(fixture.root, 'config/plugins/unknown.bin'), Buffer.from([0, 1, 2, 255]));
  const packageDirectory = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination: packageDirectory }));
  const destination = path.join(fixture.directory, 'restored');
  const staging = path.join(fixture.directory, `.restored.mediamanager-restore-${manifest.generation}`);
  const controller = new AbortController();
  await assert.rejects(restoreStatePackage(packageDirectory, destination, {
    signal: controller.signal,
    onProgress: ({ completed }) => { if (completed === 1) controller.abort(); },
  }), /abort/iu);
  await assert.rejects(access(destination), { code: 'ENOENT' });
  await access(staging);
  const progress = JSON.parse(await readFile(path.join(staging, 'mediamanager-state.json'), 'utf8'));
  assert.equal(progress.stage, 'restoring');
  assert.equal(progress.generation, manifest.generation);

  const restored = await restoreStatePackage(packageDirectory, destination);
  assert.equal(restored.resumed, true);
  assert.equal(restored.alreadyRestored, false);
  assert.equal(restored.reusedFiles, 1);
  await assert.rejects(access(staging), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(destination, 'config/plugins/unknown.bin'), 'hex'), '000102ff');

  const replay = await restoreStatePackage(packageDirectory, destination);
  assert.equal(replay.resumed, true);
  assert.equal(replay.alreadyRestored, true);
  assert.equal(replay.reusedFiles, manifest.instanceFiles.length + 1);
});

test('local restore refuses unrelated destinations and unexpected staged entries', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-foreign-' });
  const packageDirectory = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination: packageDirectory }));
  const destination = path.join(fixture.directory, 'restored');
  await mkdir(destination); await writeFile(path.join(destination, 'foreign.txt'), 'owned elsewhere');
  await assert.rejects(restoreStatePackage(packageDirectory, destination), /Restore state/u);
  assert.equal(await readFile(path.join(destination, 'foreign.txt'), 'utf8'), 'owned elsewhere');
  await rm(destination, { recursive: true });

  const controller = new AbortController(); controller.abort();
  await assert.rejects(restoreStatePackage(packageDirectory, destination, { signal: controller.signal }), /abort/iu);
  const staging = path.join(fixture.directory, `.restored.mediamanager-restore-${manifest.generation}`);
  await writeFile(path.join(staging, 'foreign.txt'), 'do not publish');
  await assert.rejects(restoreStatePackage(packageDirectory, destination), /Unexpected file/u);
  await assert.rejects(access(destination), { code: 'ENOENT' });
});

test('interrupted packages have no commit and cannot be restored', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-abort-' });
  const destination = path.join(fixture.directory, 'package');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createStatePackage(await fixture.packageOptions({ destination, signal: controller.signal })), /abort/iu);
  await assert.rejects(access(destination), { code: 'ENOENT' });
  const staging = captureStagingPath(destination);
  const progress = JSON.parse(await readFile(path.join(staging, 'progress.json'), 'utf8'));
  assert.equal(progress.stage, 'preflight');
  assert.match(progress.lastError, /abort/iu);
  await assert.rejects(access(path.join(staging, 'COMMITTED')), { code: 'ENOENT' });
  await assert.rejects(verifyStatePackage(staging));
});

test('package capture resumes one bound generation, repairs partial files and publishes only after verification', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-capture-resume-' });
  await mkdir(path.join(fixture.root, 'config/plugins'));
  await writeFile(path.join(fixture.root, 'config/plugins/resume.bin'), 'complete source bytes');
  const destination = path.join(fixture.directory, 'package');
  const base = await fixture.packageOptions({ destination });
  let interruptPost = true;
  const captureSession = createIsolatedOfflineCopyCaptureSession({
    instanceState: base.instanceState,
    ownerId: 'capture resume fixture',
    recordedAt: '2026-10-04T02:03:04.000Z',
    assertHeld: phase => {
      fixture.database.preflight();
      if (phase === 'post' && interruptPost) throw new Error('injected post-capture interruption');
    },
  });
  await assert.rejects(createStatePackage({ ...base, captureSession }), /injected post-capture interruption/u);
  await assert.rejects(access(destination), { code: 'ENOENT' });
  const staging = captureStagingPath(destination);
  const interrupted = JSON.parse(await readFile(path.join(staging, 'progress.json'), 'utf8'));
  assert.equal(interrupted.stage, 'database-captured');
  assert.match(interrupted.lastError, /injected post-capture interruption/u);
  await writeFile(path.join(staging, 'files/config/plugins/resume.bin'), 'partial');
  await writeFile(path.join(staging, 'files/config/plugins/.resume.bin.mediamanager-tmp-00000000-0000-4000-8000-000000000000'), 'interrupted copy');
  const exportFinal = path.join(staging, 'jellyfin.db.tmp');
  const exportStaging = path.join(staging, '.jellyfin.db.tmp.mediamanager-export-staging');
  await writeFile(exportFinal, 'published export bytes');
  await link(exportFinal, exportStaging);
  for (const suffix of ['-journal', '-wal', '-shm']) await writeFile(`${exportStaging}${suffix}`, `interrupted ${suffix}`);

  interruptPost = false;
  const manifest = await createStatePackage({ ...base, captureSession });
  assert.equal(manifest.generation, interrupted.generation);
  assert.equal(await readFile(path.join(destination, 'files/config/plugins/resume.bin'), 'utf8'), 'complete source bytes');
  await assert.rejects(access(staging), { code: 'ENOENT' });
  assert.deepEqual(await createStatePackage({ ...base, captureSession }), manifest);
});

test('state package capture lease rejects a concurrent writer without touching its active staging', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-capture-lease-' });
  const destination = path.join(fixture.directory, 'package');
  const base = await fixture.packageOptions({ destination });
  let reachedPost, releasePost;
  const postReached = new Promise(resolve => { reachedPost = resolve; });
  const postRelease = new Promise(resolve => { releasePost = resolve; });
  const captureSession = createIsolatedOfflineCopyCaptureSession({
    instanceState: base.instanceState,
    ownerId: 'capture lease fixture',
    assertHeld: async phase => {
      fixture.database.preflight();
      if (phase === 'post') { reachedPost(); await postRelease; }
    },
  });
  const first = createStatePackage({ ...base, captureSession });
  await postReached;
  const staging = captureStagingPath(destination);
  try {
    await access(path.join(staging, 'jellyfin.db'));
    await assert.rejects(createStatePackage({ ...base, captureSession }), /State package capture is already active/u);
    await access(path.join(staging, 'jellyfin.db'));
  } finally { releasePost(); }
  const manifest = await first;
  assert.equal(manifest.generation.length, 36);
  await assert.rejects(access(staging), { code: 'ENOENT' });
});

test('state package capture snapshots a mutable destination before awaiting its lease', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-capture-options-' });
  const originalDestination = path.join(fixture.directory, 'package-original');
  const mutatedDestination = path.join(fixture.directory, 'package-mutated');
  const options = await fixture.packageOptions({ destination: originalDestination });
  let reachedPost, releasePost, holdFirstPost = true;
  const postReached = new Promise(resolve => { reachedPost = resolve; });
  const postRelease = new Promise(resolve => { releasePost = resolve; });
  options.captureSession = createIsolatedOfflineCopyCaptureSession({
    instanceState: options.instanceState,
    ownerId: 'mutable destination fixture',
    assertHeld: async phase => {
      fixture.database.preflight();
      if (phase === 'post' && holdFirstPost) {
        holdFirstPost = false;
        reachedPost();
        await postRelease;
      }
    },
  });

  const originalCapture = createStatePackage(options);
  options.destination = mutatedDestination;
  await postReached;
  let mutated;
  try { mutated = await createStatePackage(options); }
  finally { releasePost(); }
  const original = await originalCapture;

  assert.notEqual(original.generation, mutated.generation);
  await verifyStatePackage(originalDestination);
  await verifyStatePackage(mutatedDestination);
  await assert.rejects(access(captureStagingPath(originalDestination)), { code: 'ENOENT' });
  await assert.rejects(access(captureStagingPath(mutatedDestination)), { code: 'ENOENT' });
});

test('state package restore lease rejects a concurrent writer without deleting active output', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-restore-lease-' });
  const packageDirectory = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination: packageDirectory }));
  const destination = path.join(fixture.directory, 'restored');
  let reachedProgress, releaseProgress;
  const progressReached = new Promise(resolve => { reachedProgress = resolve; });
  const progressRelease = new Promise(resolve => { releaseProgress = resolve; });
  let held = false;
  const first = restoreStatePackage(packageDirectory, destination, {
    onProgress: async ({ completed }) => {
      if (completed === 1 && !held) { held = true; reachedProgress(); await progressRelease; }
    },
  });
  await progressReached;
  const staging = path.join(fixture.directory, `.restored.mediamanager-restore-${manifest.generation}`);
  const activeFiles = (await readdir(staging)).sort();
  try {
    await assert.rejects(restoreStatePackage(packageDirectory, destination), /State package restore is already active/u);
    assert.deepEqual((await readdir(staging)).sort(), activeFiles);
  } finally { releaseProgress(); }
  const restored = await first;
  assert.equal(restored.alreadyRestored, false);
  await access(path.join(destination, 'mediamanager-state.json'));
});

test('creation rejects caller-selected roots and database paths', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-api-' });
  const base = await fixture.packageOptions({ destination: path.join(fixture.directory, 'package') });
  for (const unsupported of [
    { roots: { config: path.join(fixture.root, 'config') } },
    { sourceDatabasePaths: [fixture.database.filename] },
    { databaseRestorePath: 'jellyfin.db' },
  ]) await assert.rejects(createStatePackage({ ...base, ...unsupported }), /Invalid state package creation options/u);
  const { instanceState, ...missingState } = base;
  await assert.rejects(createStatePackage(missingState), /discovered Jellyfin instance state/u);
});

test('verification binds SQLite instance-state projection and forbids a media retarget declaration', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-sqlite-retarget-' });
  const destination = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination }));
  const alteredProjection = structuredClone(manifest);
  alteredProjection.database.pathProjection.auditedPaths += 1;
  await resignManifest(destination, alteredProjection);
  await assert.rejects(verifyStatePackage(destination),
    /source database generation differs from its exported database/u);

  const alteredContract = structuredClone(manifest);
  alteredContract.database.portableMountContract = { mounts: [{
    mountId: 'media', identityRoot: 'Z:\\Media', accessRoot: '/media', pathStyle: 'windows',
    caseSensitive: false, returnPolicy: 'required'
  }] };
  await resignManifest(destination, alteredContract);
  await assert.rejects(verifyStatePackage(destination), /cannot declare a portable VFS mount retarget/u);
});

test('verification rejects re-signed database restore path collisions before creating a destination', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-collision-' });
  const destination = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination }));
  for (const [index, restorePath] of conflictingRestorePaths.entries()) {
    const altered = { ...structuredClone(manifest), database: { ...manifest.database, restorePath } };
    await resignManifest(destination, altered);
    await assert.rejects(verifyStatePackage(destination), /database restore path differs|Database restore path collides|directory collides/u, restorePath);
    const restored = path.join(fixture.directory, `restore-${index}`);
    await assert.rejects(restoreStatePackage(destination, restored), /database restore path differs|Database restore path collides|directory collides/u, restorePath);
    await assert.rejects(access(restored), { code: 'ENOENT' });
  }
});

test('verification rejects re-signed missing paths and reserved instance assets', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-reserved-' });
  const missingDestination = path.join(fixture.directory, 'missing-package');
  const missing = await createStatePackage(await fixture.packageOptions({ destination: missingDestination }));
  delete missing.database.restorePath;
  await resignManifest(missingDestination, missing);
  await assert.rejects(verifyStatePackage(missingDestination), /manifest has an invalid schema/u);

  for (const [index, assetPath] of reservedRestorePaths.flatMap(value => [value, `${value.toUpperCase()}/asset.bin`]).entries()) {
    const destination = path.join(fixture.directory, `reserved-package-${index}`);
    const manifest = await createStatePackage(await fixture.packageOptions({ destination }));
    const originalEntry = manifest.instanceFiles.find(file => file.path === 'config/network.xml');
    const original = path.join(destination, 'files', ...originalEntry.path.split('/'));
    const replacement = path.join(destination, 'files', ...assetPath.split('/'));
    await mkdir(path.dirname(replacement), { recursive: true });
    await rename(original, replacement);
    originalEntry.path = assetPath;
    await resignManifest(destination, manifest);
    await assert.rejects(verifyStatePackage(destination), /State asset path collides with reserved state path/u, assetPath);
  }
});
