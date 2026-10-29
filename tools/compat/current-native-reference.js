import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rmdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { nativeInstanceInputs } from '../validation/native-instance-inputs.js';
import { describeFile } from '../validation/inventory.js';
import { validationExecutable } from '../validation/paths.js';
import { prepareNativeApplicationData, resolveNativeTools, verifyNativeProcessInputs } from './native-process-inputs.js';
import { stopNativeReference } from './native-shutdown.js';
import { observeExecutionPhase } from '../validation/execution-diagnostics.js';

/** A fresh clone of this workflow's stopped instance; no historical identity fallback. */
export async function currentNativeReference({ fixtureUserId } = {}) {
  // The environment variable also declares the real service to inventory.
  assert.ok(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE);
  const instance = await nativeInstanceInputs(), build = instance.build;
  const tools = await resolveNativeTools();
  const sourceRoot = instance.seed.destination;
  const sourceDatabase = path.join(sourceRoot, 'data', 'data', 'jellyfin.db');
  // Opening a WAL database read-only may still create -wal/-shm files. Query
  // a private byte copy so the provisioned instance remains immutable.
  const sessionRoot = await mkdtemp(path.join(tmpdir(), 'mm-native-session-'));
  const sessionDatabase = path.join(sessionRoot, 'jellyfin.db');
  let database;
  let device;
  try {
    await copyFile(sourceDatabase, sessionDatabase);
    database = new DatabaseSync(sessionDatabase, { readOnly: true });
    device = database.prepare('SELECT "UserId", "AccessToken" FROM "Devices" WHERE "DeviceId" = ?').get('fixture-oracle');
    assert.ok(device?.UserId && device.AccessToken, 'The stopped native initializer must supply its actual authenticated device.');
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM "Users" WHERE "Id" = ?').get(device.UserId).n, 1);
  } finally {
    try { database?.close(); }
    finally {
      for (const suffix of ['', '-wal', '-shm']) await rm(sessionDatabase + suffix, { force: true });
      await rmdir(sessionRoot);
    }
  }
  const sourceManifest = JSON.parse(await readFile(path.join(build.root, 'source-offer', 'jellyfin-source-manifest.json'), 'utf8'));
  const sourceByPath = new Map(sourceManifest.files.map(entry => [entry.path, entry]));
  let applicationData;
  return {
    sourceRoot, sourceDatabase, runtimeRoot: build.runtime, jellyfinDll: build.dll,
    dotnet: tools.dotnet, ffmpeg: tools.ffmpeg, accessToken: device.AccessToken, userId: device.UserId,
    get environment() { return { ...process.env, ...applicationData?.runtimeEnvironment }; },
    preparation: {
      kind: 'current-designated-source-http', initializedFromEmpty: true, stopped: true,
      nativeServerId: instance.initialization.serverId,
      fixtureUserId, actualUserId: device.UserId, buildIdentitySha256: instance.initialization.build.identitySha256,
      buildIdentitySource: 'same-run-initialization-full-build-verification',
      runtimeIdentitySha256: build.runtimeIdentitySha256,
      inputs: instance.inputs, historicalRecordingReused: false, credentialsRecorded: false,
    },
    async sourceBindings(sourcePaths) {
      return await Promise.all(sourcePaths.map(async relative => {
        const pinned = sourceByPath.get(relative);
        assert.ok(pinned, `The designated source manifest must include ${relative}`);
        const description = await describeFile(path.join(build.root, 'source', relative));
        assert.equal(description.sha256, pinned.sha256, `The executing build source changed: ${relative}`);
        return { path: description.filename, sha256: description.sha256 };
      }));
    },
    async prepareClone(referenceRoot, port) {
      return observeExecutionPhase('native.prepare-clone', async () => {
        const rebase = value => value.replaceAll(sourceRoot.replaceAll('\\', '\\\\'), referenceRoot.replaceAll('\\', '\\\\'))
          .replaceAll(sourceRoot.replaceAll('\\', '/'), referenceRoot.replaceAll('\\', '/')).replaceAll(sourceRoot, referenceRoot);
        async function visit(directory) {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(filename);
            else if (/\.(?:xml|json)$/iu.test(entry.name)) {
              let value = rebase(await readFile(filename, 'utf8'));
              if (entry.name.toLowerCase() === 'network.xml') value = value
                .replace(/<(InternalHttpPort|PublicHttpPort)>\d+<\/\1>/gu, (_, name) => `<${name}>${port}</${name}>`)
                .replace(/<AutoDiscovery>true<\/AutoDiscovery>/gu, '<AutoDiscovery>false</AutoDiscovery>');
              await writeFile(filename, value);
            }
          }
        }
        await visit(path.join(referenceRoot, 'config'));
        const clone = new DatabaseSync(path.join(referenceRoot, 'data', 'data', 'jellyfin.db'));
        try {
          // Relocate only existing instance paths; synthetic media identities stay literal.
          for (const item of clone.prepare('SELECT "Id", "Path", "Data" FROM "BaseItems"').all()) {
            const itemPath = item.Path == null ? null : rebase(item.Path);
            const data = item.Data == null ? null : rebase(item.Data);
            if (itemPath !== item.Path || data !== item.Data) clone.prepare('UPDATE "BaseItems" SET "Path" = ?, "Data" = ? WHERE "Id" = ?')
              .run(itemPath, data, item.Id);
          }
        } finally { clone.close(); }
        applicationData = await prepareNativeApplicationData(referenceRoot);
      });
    },
    start({ referenceRoot, outputRoot, label, origin }) {
      assert.ok(applicationData, 'Prepare the isolated clone before starting the reference.');
      assert.match(label, /^[a-z-]+$/u);
      const stdout = openSync(path.join(outputRoot, `${label}-stdout.log`), 'wx');
      let stderr;
      try { stderr = openSync(path.join(outputRoot, `${label}-stderr.log`), 'wx'); }
      catch (error) { closeSync(stdout); throw error; }
      const argumentsList = [build.dll, '--datadir', path.join(referenceRoot, 'data'), '--configdir', path.join(referenceRoot, 'config'),
        '--cachedir', path.join(referenceRoot, 'cache'), '--logdir', path.join(referenceRoot, 'log'), '--nowebclient', '--ffmpeg', tools.ffmpeg];
      const environment = { ...process.env, ...applicationData.runtimeEnvironment, MEDIAMANAGER_DOTNET: tools.dotnet };
      let child;
      try { child = spawn(validationExecutable('dotnet', environment), argumentsList,
        { cwd: referenceRoot, env: environment, windowsHide: true, stdio: ['ignore', stdout, stderr] }); }
      catch (error) { closeSync(stdout); closeSync(stderr); throw error; }
      let spawnError;
      child.once('error', error => { spawnError = error; });
      return { child, arguments: argumentsList, label,
        async ready() {
          let consecutive = 0;
          for (let attempt = 0; attempt < 90; attempt++) {
            if (spawnError) throw spawnError;
            if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited before readiness.`);
            try {
              const response = await fetch(`${origin}/System/Info/Public`, { signal: AbortSignal.timeout(1000) });
              consecutive = response.ok ? consecutive + 1 : 0;
              await response.body?.cancel();
              if (consecutive === 3) return;
            } catch { consecutive = 0; }
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          throw new Error(`${label} did not become ready within 45 seconds.`);
        },
        async stop(requestShutdown, portAvailable) {
          let outcome, error;
          try { await stopNativeReference(child, requestShutdown, value => { outcome = value; }, { timeoutMilliseconds: 20000 }); }
          catch (failure) { error = failure; }
          finally { closeSync(stdout); closeSync(stderr); }
          return { pid: child.pid, code: child.exitCode, signal: child.signalCode,
            cleanShutdown: !error && outcome?.shutdownStatus === 204, lifecycle: outcome ? [outcome] : [],
            pidGone: child.exitCode !== null || child.signalCode !== null,
            portAvailable: await portAvailable(), error: error ? { name: error.name, message: error.message } : null };
        },
      };
    },
    async finish() {
      await verifyNativeProcessInputs({ executables: tools.executables, ...applicationData });
      const after = await nativeInstanceInputs();
      assert.deepEqual(after.inputs, instance.inputs, 'The current stopped input instance is immutable.');
      assert.equal(after.initialization.build.identitySha256, instance.initialization.build.identitySha256);
      assert.equal(after.build.runtimeIdentitySha256, build.runtimeIdentitySha256);
    },
  };
}
