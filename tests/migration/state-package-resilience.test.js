import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { access, link, mkdir, readFile, readdir, realpath, rename, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { Server } from 'node:net';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { databaseDigest } from '../../src/migration/database-transfer.js';
import { createStatePackage, restoreStatePackage, verifyStatePackage } from '../../src/migration/state-package.js';
import { createIsolatedOfflineCopyCaptureSession } from '../../src/migration/capture-session.js';
import { StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { seedAllTables } from '../database/fixtures.js';
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

function captureSession(fixture, instanceState, options = {}) {
  const { recordedAt, postFailure } = options;
  return createIsolatedOfflineCopyCaptureSession({
    instanceState,
    ownerId: 'state-package-resilience-fixture',
    recordedAt,
    assertHeld: phase => {
      fixture.database.preflight();
      if (phase === 'post' && Object.hasOwn(options, 'postFailure')) throw postFailure;
    },
  });
}

function observeLeaseRelease(identity, cleanupFailure) {
  const digest = sha256Value(process.platform === 'win32' ? identity.toLowerCase() : identity);
  const originalOpen = fs.promises.open, originalServerClose = Server.prototype.close;
  const files = [], servers = [];
  let closeFailed = false;
  if (process.platform === 'darwin') {
    fs.promises.open = async (...args) => {
      const file = await originalOpen(...args), filename = String(args[0]);
      if (path.dirname(filename) === '/Users/Shared/mediamanager-operation-leases'
        && path.basename(filename).includes(digest)) {
        const close = file.close.bind(file), stat = file.stat.bind(file);
        files.push({ stat });
        file.close = async () => {
          await close();
          closeFailed = true;
          throw cleanupFailure;
        };
      }
      return file;
    };
    syncBuiltinESMExports();
  } else {
    const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\mediamanager-operation-' + digest
      : '\0mediamanager-operation-' + digest;
    Server.prototype.close = function closeOwnedLease(callback) {
      if (this.address() !== endpoint) return originalServerClose.call(this, callback);
      servers.push(this);
      return originalServerClose.call(this, error => {
        if (error !== null && error !== undefined) return callback(error);
        closeFailed = true;
        callback(cleanupFailure);
      });
    };
  }
  return {
    restore() {
      fs.promises.open = originalOpen; syncBuiltinESMExports();
      Server.prototype.close = originalServerClose;
    },
    async assertClosed() {
      assert.equal(closeFailed, true, 'The controlled failure follows the actual OS resource close.');
      for (const file of files) await assert.rejects(file.stat(), { code: 'EBADF' });
      for (const server of servers) assert.equal(server.listening, false);
    },
  };
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
  for (const [index, thrown] of ['primitive hold failure', false, 0, '', null, undefined].entries()) {
    const session = captureSession(fixture, base.instanceState, {
      recordedAt: `2026-10-04T03:1${index}:00.000Z`,
      postFailure: thrown,
    });
    await assert.rejects(createStatePackage({ ...base, captureSession: session }), error => {
      assert.ok(error instanceof Error);
      assert.equal(Object.hasOwn(error, 'cause'), true);
      assert.equal(error.cause, thrown);
      return true;
    });
    const progress = JSON.parse(await readFile(path.join(staging, 'progress.json'), 'utf8'));
    assert.equal(progress.stage, 'database-captured');
    assert.equal(typeof progress.lastError, 'string');
    assert.ok(progress.lastError.includes(String(thrown)));
    generation ??= progress.generation;
    assert.equal(progress.generation, generation);
  }

  const recovered = await createStatePackage({ ...base, captureSession: captureSession(fixture, base.instanceState, {
    recordedAt: '2026-10-04T03:20:00.000Z',
  }) });
  assert.equal(recovered.generation, generation);
});

test('capture journals hostile diagnostic values without replacing their cause and resumes its generation', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-hostile-error-' });
  const destination = path.join(fixture.directory, 'package');
  const base = await fixture.packageOptions({ destination });
  const diagnosticFailure = new Error('Diagnostic conversion must not become the capture failure');
  const hostileMessage = new Error('Original capture failure', { cause: false });
  Object.defineProperty(hostileMessage, 'message', { get() { throw diagnosticFailure; } });
  const reasons = [Object.create(null), { toString() { throw diagnosticFailure; } }, {
    toString() { return {}; }, valueOf() { throw diagnosticFailure; },
  }, hostileMessage];
  let generation;
  for (const reason of reasons) {
    await assert.rejects(createStatePackage({ ...base,
      captureSession: captureSession(fixture, base.instanceState, { postFailure: reason }),
    }), error => {
      if (reason instanceof Error) assert.equal(error, reason);
      else { assert.ok(error instanceof Error); assert.equal(error.cause, reason); }
      assert.notEqual(error, diagnosticFailure);
      return true;
    });
    const progress = JSON.parse(await readFile(path.join(captureStagingPath(destination), 'progress.json'), 'utf8'));
    assert.equal(progress.stage, 'database-captured');
    assert.equal(typeof progress.lastError, 'string');
    assert.ok(progress.lastError.length > 0);
    assert.notEqual(progress.lastError, diagnosticFailure.message);
    generation ??= progress.generation;
    assert.equal(progress.generation, generation);
  }
  assert.equal(hostileMessage.cause, false);
  const recovered = await createStatePackage(base);
  assert.equal(recovered.generation, generation);
  assert.equal(JSON.parse(await readFile(path.join(destination, 'progress.json'), 'utf8')).lastError, null);
});

test('capture retains a hostile failure from a real SQLite export read and recovers all table values', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-export-error-' });
  seedAllTables(fixture.database);
  const destination = path.join(fixture.directory, 'package');
  const base = await fixture.packageOptions({ destination });
  const beforeBytes = await readFile(fixture.database.filename), before = await databaseDigest(fixture.database);
  const reason = Object.assign(Object.create(null), { code: 'CAPTURE_EXPORT_READ_FAILED', status: 0, statusCode: false });
  const exportStaging = path.join(captureStagingPath(destination), '.jellyfin.db.tmp.mediamanager-export-staging');
  const originalRows = fixture.database.rows;
  let readFailed = false;
  fixture.database.rows = function rowsAfterActualRead(...args) {
    const result = originalRows.apply(this, args);
    // Source identity reads remain real and successful; only the actual export's owned staging arms this failure.
    if (!readFailed && fs.existsSync(exportStaging)) { readFailed = true; throw reason; }
    return result;
  };
  try {
    await assert.rejects(createStatePackage(base), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, reason);
      for (const field of ['code', 'status', 'statusCode']) assert.equal(error[field], reason[field]);
      return true;
    });
  } finally { fixture.database.rows = originalRows; }
  assert.equal(readFailed, true);
  assert.equal(fixture.database.database.isTransaction, false);
  assert.deepEqual(await readFile(fixture.database.filename), beforeBytes);
  assert.deepEqual(await databaseDigest(fixture.database), before);
  const progress = JSON.parse(await readFile(path.join(captureStagingPath(destination), 'progress.json'), 'utf8'));
  assert.equal(progress.stage, 'files-captured');
  assert.equal(typeof progress.lastError, 'string');
  await assert.rejects(access(exportStaging), { code: 'ENOENT' });
  const recovered = await createStatePackage(base);
  assert.equal(recovered.generation, progress.generation);
  const packaged = new SqliteDatabase(path.join(destination, 'jellyfin.db'), { readOnly: true });
  try { assert.deepEqual(await databaseDigest(packaged), before); }
  finally { packaged.close(); }
});

test('restore preserves each raw operation reason when its actual OS lease close also fails', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-release-errors-' });
  const packageDirectory = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination: packageDirectory }));
  const publicFailure = Object.assign(new Error('Controlled restore operation', { cause: null }), {
    code: 0, status: false, statusCode: '', errors: [false, 0, null, undefined],
  });
  const getterFailure = new Error('A public diagnostic getter must not become the failure');
  const hostileFailure = new Error('Controlled restore with hostile public fields', { cause: 0 });
  for (const field of ['code', 'status', 'statusCode']) {
    Object.defineProperty(hostileFailure, field, { get() { throw getterFailure; } });
  }
  for (const [index, reason] of [false, 0, '', null, undefined, publicFailure, hostileFailure].entries()) {
    const destination = path.join(fixture.directory, `restored-${index}`);
    const physicalDestination = path.join(await realpath(fixture.directory), path.basename(destination));
    const cleanupFailure = index === 0 ? 0 : new Error('Actual restore lease closed before reporting cleanup failure');
    const observer = observeLeaseRelease(physicalDestination, cleanupFailure);
    let progressed = false;
    try {
      await assert.rejects(restoreStatePackage(packageDirectory, destination, {
        onProgress() { progressed = true; throw reason; },
      }), error => {
        assert.ok(error instanceof AggregateError);
        assert.equal(Object.hasOwn(error, 'cause'), true);
        assert.equal(error.cause, reason);
        assert.deepEqual(error.errors, [reason, cleanupFailure]);
        if (reason === publicFailure) {
          for (const field of ['code', 'status', 'statusCode']) assert.equal(error[field], reason[field]);
          assert.equal(reason.cause, null);
          assert.deepEqual(reason.errors, [false, 0, null, undefined]);
        }
        return true;
      });
    } finally { observer.restore(); }
    assert.equal(progressed, true);
    await observer.assertClosed();
    const recovered = await restoreStatePackage(packageDirectory, destination);
    assert.equal(recovered.resumed, true);
    assert.deepEqual(recovered.manifest, manifest);
    const restored = new SqliteDatabase(path.join(destination, ...manifest.database.restorePath.split('/')), { readOnly: true });
    try { assert.deepEqual(await databaseDigest(restored), manifest.database.tables); }
    finally { restored.close(); }
  }
});

test('a sole actual state-package lease close failure remains raw after publication and allows a new owner', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-release-only-' });
  const packageDirectory = path.join(fixture.directory, 'package');
  const manifest = await createStatePackage(await fixture.packageOptions({ destination: packageDirectory }));
  const destination = path.join(fixture.directory, 'restored');
  const physicalDestination = path.join(await realpath(fixture.directory), path.basename(destination));
  const observer = observeLeaseRelease(physicalDestination, false);
  try {
    await assert.rejects(restoreStatePackage(packageDirectory, destination), reason => {
      assert.equal(reason, false);
      return true;
    });
  } finally { observer.restore(); }
  await observer.assertClosed();
  const recovered = await restoreStatePackage(packageDirectory, destination);
  assert.equal(recovered.alreadyRestored, true);
  assert.deepEqual(recovered.manifest, manifest);
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

test('restore resumes an interrupted staging tree through an equivalent destination path', async t => {
  const fixture = await createInstanceFixture(t, { prefix: 'mediamanager-state-restore-case-' });
  const packageDirectory = path.join(fixture.directory, 'package');
  await createStatePackage(await fixture.packageOptions({ destination: packageDirectory }));
  const destination = path.join(fixture.directory, 'Restored-Case');
  // Retain the Windows case-alias regression. On POSIX, use its real dot
  // segment equivalence instead of requiring case-insensitive path identity.
  const alias = process.platform === 'win32' ? path.join(fixture.directory, 'RESTORED-CASE')
    : `${fixture.directory}/./Restored-Case`;
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
