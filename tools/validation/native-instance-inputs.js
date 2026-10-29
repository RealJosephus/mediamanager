import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describeFile } from './inventory.js';
import { verifyNativeRuntime } from './native-build-inputs.js';
import { observeExecutionPhase } from './execution-diagnostics.js';

/** This is a freshly initialized controlled instance, never a historical query database. */
export async function nativeInstanceInputs(environment = process.env) {
  return observeExecutionPhase('native.instance.verify', () => collectNativeInstanceInputs(environment), { environment });
}

async function collectNativeInstanceInputs(environment) {
  if (environment.MEDIAMANAGER_CI_NATIVE_REFERENCE !== 'true') throw new Error('Native instance provisioning requires native reference provisioning.');
  if (!environment.MEDIAMANAGER_NATIVE_INSTANCE_ROOT || !environment.MEDIAMANAGER_TEST_NATIVE_INSTANCE) {
    throw new Error('Native instance provisioning requires its evidence root and seeded instance path.');
  }
  const root = path.resolve(environment.MEDIAMANAGER_NATIVE_INSTANCE_ROOT);
  const empty = path.join(root, 'empty'), seeded = path.join(root, 'seeded');
  if (path.resolve(environment.MEDIAMANAGER_TEST_NATIVE_INSTANCE) !== path.join(seeded, 'instance')) {
    throw new Error('Native instance consumers must use the same-run controlled seeded instance.');
  }
  const build = await verifyNativeRuntime(environment);
  const inputs = [], bind = async (filename, expectedSha256) => {
    const value = await describeFile(filename);
    if (!value.available || expectedSha256 && (value.sha256 ?? value.entriesSha256) !== expectedSha256) {
      throw new Error(`Native instance input is missing or changed: ${filename}`);
    }
    inputs.push({ filename, sha256: value.sha256 ?? value.entriesSha256 });
    return value;
  };
  const initializationFile = path.join(empty, 'initialization.json');
  const seedFile = path.join(seeded, 'synthetic-media-fixture.json');
  await bind(initializationFile); await bind(seedFile);
  const initialization = JSON.parse(await readFile(initializationFile, 'utf8'));
  const seed = JSON.parse(await readFile(seedFile, 'utf8'));
  if (initialization.schemaVersion !== 1 || !initialization.initializedFromEmpty
    || initialization.process?.stopped !== true || initialization.process.exitCode !== 0 || initialization.process.signalCode !== null
    || initialization.root !== path.join(empty, 'instance')
    || !/^[a-f0-9]{64}$/u.test(initialization.build?.identitySha256 ?? '')
    || initialization.build?.runtimeIdentitySha256 !== build.runtimeIdentitySha256
    || seed.schemaVersion !== 1 || seed.source !== initialization.root || seed.destination !== path.join(seeded, 'instance')
    || seed.sourceUnchanged !== true || seed.seededItems !== 2 || seed.nativeMigrationHistoryRetained !== true
    || seed.originalDatabaseSha256 !== initialization.database?.sha256 || seed.initialization?.filename !== initializationFile) {
    throw new Error('Native instance receipts do not describe a clean same-run initialization and controlled seed.');
  }
  for (const value of [initialization.instanceEntriesSha256, seed.instanceEntriesSha256, seed.sourceEntriesSha256, seed.initialization.sha256]) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('Native instance content binding is missing.');
  }
  const executableDescriptor = value => path.isAbsolute(value?.filename ?? '') && /^[a-f0-9]{64}$/u.test(value.sha256 ?? '');
  if (!Array.isArray(initialization.executables) || initialization.executables.length !== 3
    || new Set(initialization.executables.map(value => value.name)).size !== 3
    || initialization.executables.some(value => !['dotnet', 'ffmpeg', 'ffprobe'].includes(value.name)
      || !executableDescriptor(value) || !Array.isArray(value.dispatch) || value.dispatch.some(entry => !executableDescriptor(entry)))) {
    throw new Error('Native instance executable binding is missing.');
  }
  const ffmpeg = initialization.executables.find(value => value.name === 'ffmpeg');
  const ffprobe = initialization.executables.find(value => value.name === 'ffprobe');
  if (ffprobe.requested !== ffmpeg.filename.replace(/[^/\\]+?(\.[^/\\\n.]+)?$/u, 'ffprobe$1')) {
    throw new Error('Native instance ffprobe must be derived from its actual ffmpeg path.');
  }
  const scripts = [
    [initialization.initializer, fileURLToPath(new URL('../compat/initialize-reference.mjs', import.meta.url))],
    [initialization.nativeProcessInputs, fileURLToPath(new URL('../compat/native-process-inputs.js', import.meta.url))],
    [seed.preparation, fileURLToPath(new URL('../compat/prepare-media-reference.mjs', import.meta.url))],
  ];
  for (const [descriptor, filename] of scripts) {
    if (descriptor?.filename !== filename || !descriptor.sha256) throw new Error('Native instance producer binding is missing.');
    await bind(filename, descriptor.sha256);
  }
  await bind(initializationFile, seed.initialization.sha256);
  await bind(empty, seed.sourceEntriesSha256);
  await bind(initialization.root, initialization.instanceEntriesSha256);
  await bind(seed.destination, seed.instanceEntriesSha256);
  for (const descriptor of initialization.executables.flatMap(value => [value, ...value.dispatch])) await bind(descriptor.filename, descriptor.sha256);
  return { root, initialization, seed, inputs, build };
}
