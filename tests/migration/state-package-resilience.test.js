import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, link, mkdir, readFile, readdir, rename, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createStatePackage, restoreStatePackage, verifyStatePackage } from '../../src/migration/state-package.js';
import { createIsolatedOfflineCopyCaptureSession } from '../../src/migration/capture-session.js';
import { StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { createInstanceFixture } from './instance-fixture.js';

const sha256Value = value => createHash('sha256').update(value).digest('hex');
const captureStagingPath = destination => path.join(path.dirname(destination), `.${path.basename(destination)}.mediamanager-package-staging`);

function canonicalJson(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError('Test value must be acyclic JSON');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map(entry => canonicalJson(entry, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

function identityPayload(state) {
  const control = state.identity.controlGeneration;
  assert.equal(control.digest, sha256Value(canonicalJson({ inventory: control.inventory, restoredState: control.restoredState })));
  return {
    kind: state.kind,
    instanceRoot: state.instanceRoot,
    serverId: state.identity.serverId,
    criticalFiles: {
      systemConfiguration: state.identity.criticalFiles.systemConfiguration,
      networkConfiguration: state.identity.criticalFiles.networkConfiguration,
      serverIdentity: state.identity.criticalFiles.serverIdentity,
    },
    databaseGeneration: {
      algorithm: state.identity.databaseGeneration.algorithm,
      digest: state.identity.databaseGeneration.digest,
      files: state.identity.databaseGeneration.files.map(file => ({
        role: file.role,
        bytes: file.bytes,
        modifiedAt: file.modifiedAt,
        sha256: file.sha256,
      })),
    },
    controlGeneration: {
      algorithm: control.algorithm,
      digest: control.digest,
      // The identity payload binds the canonical inventory through control.digest.
      restoredState: control.restoredState === null ? null : {
        bytes: control.restoredState.bytes,
        modifiedAt: control.restoredState.modifiedAt,
        sha256: control.restoredState.sha256,
      },
    },
    stateGeneration: {
      algorithm: state.identity.stateGeneration.algorithm,
      digest: state.identity.stateGeneration.digest,
      rootCount: state.identity.stateGeneration.rootCount,
      directoryCount: state.identity.stateGeneration.directoryCount,
      fileCount: state.identity.stateGeneration.fileCount,
      bytes: state.identity.stateGeneration.bytes,
    },
    paths: {
      programData: state.paths.programData,
      configuration: state.paths.configuration,
      defaultMetadata: state.paths.defaultMetadata,
      metadata: state.paths.metadata,
      defaultCache: state.paths.defaultCache,
      cache: state.paths.cache,
      log: state.paths.log,
      sqlite: state.paths.sqlite,
    },
    pathBindings: {
      metadata: {
        configured: state.pathBindings.metadata.configured,
        root: state.pathBindings.metadata.root,
        relativePath: state.pathBindings.metadata.relativePath,
      },
      cache: {
        configured: state.pathBindings.cache.configured,
        root: state.pathBindings.cache.root,
        relativePath: state.pathBindings.cache.relativePath,
      },
    },
    roots: Object.entries(state.roots).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([label, value]) => ({ label, path: value })),
  };
}

async function resignManifest(directory, manifest) {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(directory, 'manifest.json'), text);
  const commit = {
    generation: manifest.generation,
    manifestSha256: sha256Value(text),
  };
  await writeFile(path.join(directory, 'COMMITTED'), `${JSON.stringify(commit, null, 2)}\n`);
}

async function resignCaptureIdentity(directory, manifest) {
  const identityDigest = sha256Value(JSON.stringify(identityPayload(manifest.instanceState)));
  manifest.instanceState.identity.digest = identityDigest;
  manifest.writeBarrier.identityDigest = identityDigest;
  manifest.writeBarrier.isolatedCopy.source.identityDigest = identityDigest;
  manifest.source.instanceIdentityDigest = identityDigest;
  const sourceSha256 = sha256Value(canonicalJson(manifest.source));
  manifest.captureRequestSha256 = sha256Value(canonicalJson({
    sourceSha256,
    baseline: manifest.baseline,
    extensionState: manifest.extensionState,
    mediaAccess: manifest.mediaAccess,
    portableMountContract: manifest.database.portableMountContract,
  }));
  const progressFilename = path.join(directory, 'progress.json');
  const progress = JSON.parse(await readFile(progressFilename, 'utf8'));
  progress.sourceSha256 = sourceSha256;
  progress.requestSha256 = manifest.captureRequestSha256;
  await writeFile(progressFilename, `${JSON.stringify(progress, null, 2)}\n`);
  await resignManifest(directory, manifest);
}

function captureSession(fixture, instanceState, { recordedAt, postFailure } = {}) {
  return createIsolatedOfflineCopyCaptureSession({
    instanceState,
    ownerId: 'state-package-resilience-fixture',
    recordedAt,
    assertHeld: phase => {
      fixture.database.preflight();
      if (phase === 'post' && postFailure !== undefined) throw postFailure;
    },
  });
}

test('capture resumes the same generation after process restart with a new session receipt', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-session-restart-' });
  const destination = path.join(fixture.directory, 'package');
  const base = await fixture.packageOptions({ destination });
  const interruptedSession = captureSession(fixture, base.instanceState, {
    recordedAt: '2026-10-04T03:00:00.000Z',
    postFailure: new Error('simulated process termination after database capture'),
  });
  await assert.rejects(createStatePackage({ ...base, captureSession: interruptedSession }), /simulated process termination/u);
  const staging = captureStagingPath(destination);
  const interrupted = JSON.parse(await readFile(path.join(staging, 'progress.json'), 'utf8'));
  assert.equal(interrupted.stage, 'database-captured');
  await assert.rejects(access(destination), { code: 'ENOENT' });

  const resumedSession = captureSession(fixture, base.instanceState, { recordedAt: '2026-10-04T03:01:00.000Z' });
  const manifest = await createStatePackage({ ...base, captureSession: resumedSession });
  assert.equal(manifest.generation, interrupted.generation);
  assert.equal(manifest.writeBarrier.recordedAt, '2026-10-04T03:01:00.000Z');
  await assert.rejects(access(staging), { code: 'ENOENT' });
});

test('capture recovers residual fixed and exact random control temporaries before publishing', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-commit-tmp-' });
  const destination = path.join(fixture.directory, 'package');
  const base = await fixture.packageOptions({ destination });
  const original = await createStatePackage(base);
  const staging = captureStagingPath(destination);
  await rename(destination, staging);
  await rename(path.join(staging, 'COMMITTED'), path.join(staging, 'COMMITTED.tmp'));
  await writeFile(path.join(staging, '.manifest.json.mediamanager-tmp-00000000-0000-4000-8000-000000000000'), 'interrupted bytes');

  const recovered = await createStatePackage(base);
  assert.equal(recovered.generation, original.generation);
  assert.deepEqual((await readdir(destination)).sort(), ['COMMITTED', 'files', 'jellyfin.db', 'manifest.json', 'progress.json']);
  await assert.rejects(access(path.join(destination, 'COMMITTED.tmp')), { code: 'ENOENT' });
  await assert.rejects(access(staging), { code: 'ENOENT' });
});

test('primitive capture failures always journal string errors and remain resumable', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-primitive-error-' });
  const destination = path.join(fixture.directory, 'package');
  const base = await fixture.packageOptions({ destination });
  const staging = captureStagingPath(destination);
  let generation;
  for (const [index, thrown] of [['string', 'primitive hold failure'], ['null', null]].entries()) {
    const session = captureSession(fixture, base.instanceState, {
      recordedAt: `2026-10-04T03:1${index}:00.000Z`,
      postFailure: thrown,
    });
    await assert.rejects(createStatePackage({ ...base, captureSession: session }), new RegExp(thrown === null ? 'null' : thrown, 'u'));
    const progress = JSON.parse(await readFile(path.join(staging, 'progress.json'), 'utf8'));
    assert.equal(progress.stage, 'database-captured');
    assert.equal(typeof progress.lastError, 'string');
    assert.match(progress.lastError, new RegExp(thrown === null ? 'null' : thrown, 'u'));
    generation ??= progress.generation;
    assert.equal(progress.generation, generation);
  }

  const recovered = await createStatePackage({ ...base, captureSession: captureSession(fixture, base.instanceState, {
    recordedAt: '2026-10-04T03:12:00.000Z',
  }) });
  assert.equal(recovered.generation, generation);
});

test('capture resumes exact remote asset temporaries left before and after atomic publication', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-remote-temp-' });
  const registry = new StorageRegistry();
  registry.registerType('memory', () => new MemoryStorageAdapter());
  const adapter = await registry.createInstance('source', 'memory', {});
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/source', instanceId: 'source', capabilities: {} });
  t.after(() => registry.close());
  const payload = Buffer.from('complete remote state payload');
  await adapter.write('/asset.nfo', payload);

  const destination = path.join(fixture.directory, 'package');
  const base = await fixture.packageOptions({
    destination,
    remoteState: {
      vfs,
      assets: [{ assetId: 'asset', virtualPath: '/source/asset.nfo', restorePath: 'asset.nfo', kind: 'nfo' }],
    },
  });
  let interruptPost = true;
  const captureSession = createIsolatedOfflineCopyCaptureSession({
    instanceState: base.instanceState,
    ownerId: 'remote temporary resume fixture',
    assertHeld: phase => {
      fixture.database.preflight();
      if (phase === 'post' && interruptPost) throw new Error('injected post-capture interruption');
    },
  });
  await assert.rejects(createStatePackage({ ...base, captureSession }), /injected post-capture interruption/u);

  const staging = captureStagingPath(destination);
  const captured = path.join(staging, 'files', 'remote-assets', 'asset.nfo');
  const temporary = path.join(path.dirname(captured), '.asset.nfo.mediamanager-tmp-00000000-0000-4000-8000-000000000000');
  await unlink(captured);
  await writeFile(temporary, 'hard-killed partial bytes');
  await assert.rejects(createStatePackage({ ...base, captureSession }), /injected post-capture interruption/u);
  assert.deepEqual(await readFile(captured), payload);
  await assert.rejects(access(temporary), { code: 'ENOENT' });

  await link(captured, temporary);
  interruptPost = false;
  const manifest = await createStatePackage({ ...base, captureSession });
  assert.equal(manifest.remoteAssets.length, 1);
  assert.deepEqual(await readFile(path.join(destination, 'files', 'remote-assets', 'asset.nfo')), payload);
  await assert.rejects(access(temporary), { code: 'ENOENT' });
});

test('verification rejects a re-signed native schema fingerprint mismatch', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-native-fingerprint-' });
  const destination = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination }));
  manifest.database.nativeSchemaFingerprint = manifest.database.nativeSchemaFingerprint === '0'.repeat(64)
    ? '1'.repeat(64)
    : '0'.repeat(64);
  await resignManifest(destination, manifest);
  await assert.rejects(verifyStatePackage(destination), /native database envelope differs/u);
});

test('verification rejects a re-signed alternate native database restore path', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-database-path-' });
  const destination = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination }));
  manifest.database.restorePath = 'data/data/alternate.db';
  await resignManifest(destination, manifest);
  await assert.rejects(
    verifyStatePackage(destination),
    /database restore path differs from the discovered native database path/u
  );
});

test('verification rejects a fully re-signed path binding that disagrees with system.xml', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-binding-semantics-' });
  const destination = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination }));
  assert.equal(manifest.instanceState.pathBindings.metadata.configured, false);
  manifest.instanceState.pathBindings.metadata.configured = true;
  await resignCaptureIdentity(destination, manifest);
  await assert.rejects(verifyStatePackage(destination), /MetadataPath does not match its discovered path binding/u);
});

test('verification and resume bound every package control JSON before parsing', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-control-limit-' });
  const destination = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination }));
  const controls = [
    ['manifest.json', 64 * 1024 * 1024 + 1],
    ['COMMITTED', 64 * 1024 + 1],
    ['progress.json', 1024 * 1024 + 1],
  ];
  for (const [name, oversized] of controls) {
    const filename = path.join(destination, name), original = await readFile(filename);
    await truncate(filename, oversized);
    await assert.rejects(verifyStatePackage(destination), /exceeds its size limit/u, name);
    await writeFile(filename, original);
  }
  await verifyStatePackage(destination);

  const restoreDestination = path.join(fixture.directory, 'restored');
  const controller = new AbortController();
  await assert.rejects(restoreStatePackage(destination, restoreDestination, {
    signal: controller.signal,
    onProgress: () => controller.abort(),
  }), /abort/iu);
  const staging = path.join(fixture.directory, `.restored.mediamanager-restore-${manifest.generation}`);
  await truncate(path.join(staging, 'mediamanager-state.json'), 4 * 1024 * 1024 + 1);
  await assert.rejects(restoreStatePackage(destination, restoreDestination), /Restore staging state exceeds its size limit/u);
  await assert.rejects(access(restoreDestination), { code: 'ENOENT' });
});

test('a verified package with large extension state restores through a bounded digest marker', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-large-extension-' });
  const packageDirectory = path.join(fixture.directory, 'package');
  const extensionState = { opaque: 'x'.repeat(5 * 1024 * 1024) };
  const manifest = await createStatePackage(await fixture.packageOptions({
    destination: packageDirectory,
    extensionState,
  }));
  await verifyStatePackage(packageDirectory);

  const destination = path.join(fixture.directory, 'restored');
  await restoreStatePackage(packageDirectory, destination);
  const markerBytes = await readFile(path.join(destination, 'mediamanager-state.json'));
  const marker = JSON.parse(markerBytes.toString('utf8'));
  assert.equal(marker.extensionState, undefined);
  assert.equal(marker.mediaAccess, undefined);
  assert.equal(marker.extensionStateSha256, sha256Value(canonicalJson(manifest.extensionState)));
  assert.equal(marker.mediaAccessSha256, sha256Value(canonicalJson(manifest.mediaAccess)));
  assert.equal(markerBytes.length < 4096, true);
});

test('restore removes only exact random temporaries for declared targets before resuming', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-restore-temp-' });
  const packageDirectory = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination: packageDirectory }));
  const destination = path.join(fixture.directory, 'restored');
  const controller = new AbortController();
  await assert.rejects(restoreStatePackage(packageDirectory, destination, {
    signal: controller.signal,
    onProgress: () => controller.abort(),
  }), /abort/iu);
  const staging = path.join(fixture.directory, `.restored.mediamanager-restore-${manifest.generation}`);
  const suffix = 'mediamanager-tmp-00000000-0000-4000-8000-000000000000';
  const foreign = path.join(staging, `.foreign.bin.${suffix}`);
  await writeFile(foreign, 'must not be silently removed');
  await assert.rejects(restoreStatePackage(packageDirectory, destination), /Unexpected file/u);
  assert.equal(await readFile(foreign, 'utf8'), 'must not be silently removed');
  await unlink(foreign);

  const stateTemporary = path.join(staging, `.mediamanager-state.json.${suffix}`);
  const assetTemporary = path.join(staging, 'config', `.system.xml.${suffix}`);
  await writeFile(stateTemporary, 'interrupted state bytes');
  await writeFile(assetTemporary, 'interrupted asset bytes');
  const restored = await restoreStatePackage(packageDirectory, destination);
  assert.equal(restored.resumed, true);
  await assert.rejects(access(path.join(destination, path.basename(stateTemporary))), { code: 'ENOENT' });
  await assert.rejects(access(path.join(destination, 'config', path.basename(assetTemporary))), { code: 'ENOENT' });
  await access(path.join(destination, 'config', 'system.xml'));
});

test('restore rejects a directory swapped to a junction after staging inventory without writing through it', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-parent-race-' });
  await writeFile(path.join(fixture.root, 'log', 'late.log'), 'must remain inside the restore');
  const packageDirectory = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination: packageDirectory }));
  const destination = path.join(fixture.directory, 'restored');
  const staging = path.join(fixture.directory, `.restored.mediamanager-restore-${manifest.generation}`);
  const outside = path.join(fixture.directory, 'outside');
  await mkdir(outside);
  let swapped = false;
  await assert.rejects(restoreStatePackage(packageDirectory, destination, {
    onProgress: async ({ completed }) => {
      if (completed !== 1 || swapped) return;
      swapped = true;
      await rm(path.join(staging, 'log'), { recursive: true });
      await symlink(outside, path.join(staging, 'log'), process.platform === 'win32' ? 'junction' : 'dir');
    },
  }), /physical directory|symbolic link|junction/u);
  assert.equal(swapped, true);
  await assert.rejects(access(path.join(outside, 'late.log')), { code: 'ENOENT' });
  await assert.rejects(access(destination), { code: 'ENOENT' });
});

test('Windows restore resumes an interrupted staging tree through a destination case alias', {
  skip: process.platform !== 'win32',
}, async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-restore-case-' });
  const packageDirectory = path.join(fixture.directory, 'package');
  await createStatePackage(await fixture.packageOptions({ destination: packageDirectory }));
  const destination = path.join(fixture.directory, 'Restored-Case');
  const alias = path.join(fixture.directory, 'RESTORED-CASE');
  const controller = new AbortController();
  await assert.rejects(restoreStatePackage(packageDirectory, destination, {
    signal: controller.signal,
    onProgress: ({ completed }) => { if (completed === 1) controller.abort(); },
  }), /abort/iu);

  const restored = await restoreStatePackage(packageDirectory, alias);
  assert.equal(restored.resumed, true);
  assert.equal(restored.destination, destination);
  await access(path.join(destination, 'config', 'system.xml'));
});
