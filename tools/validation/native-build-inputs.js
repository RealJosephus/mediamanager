import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { designatedJellyfinContentDigest, designatedJellyfinHead, designatedJellyfinRepository,
  designatedJellyfinSourceFiles, verifyDesignatedJellyfinSourcePackage } from './designated-jellyfin-source.js';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const restoreArguments = (packages, config) => ['restore', 'Jellyfin.Server/Jellyfin.Server.csproj', '--packages', packages,
  '--configfile', config, '-p:RestoreFallbackFolders=', '-p:RestoreAdditionalProjectFallbackFolders=',
  '--nologo', '--verbosity', 'minimal'];
const buildArguments = output => ['build', 'Jellyfin.Server/Jellyfin.Server.csproj', '--configuration', 'Release',
  '--framework', 'net10.0', '--no-restore', '--output', output, '--nologo', '--verbosity', 'minimal'];
const omittedOfflinePayloads = ['dotnet-sdk-tree', 'nuget-packages-tree'];
const evidenceStatement = 'SDK and NuGet manifests are verified against live same-run roots; manifests without those omitted byte trees are not an offline replay supply.';
const nugetConfigName = 'nuget.config';
const producerContracts = Object.freeze({
  validate: { workflow: 'Cross-platform validation', workflowFile: 'ci.yml' },
  build: { workflow: 'Build native reference runtime', workflowFile: 'native-build.yml' },
});
const runnerByMatrix = Object.freeze({ 'ubuntu-24.04': 'Linux', 'windows-2025': 'Windows', 'macos-15': 'macOS' });
const currentRunnerOs = Object.freeze({ win32: 'Windows', linux: 'Linux', darwin: 'macOS' })[process.platform];
const currentRunnerArchitecture = process.arch === 'arm64' ? 'ARM64' : process.arch === 'x64' ? 'X64' : null;
const instant = value => typeof value === 'string'
  ? Date.parse(value.replace(/(\.\d{3})\d+(?=(?:Z|[+-]\d{2}:\d{2})$)/u, '$1')) : Number.NaN;
const timestamp = value => Number.isFinite(instant(value));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// The native producer verifies receipts before npm dependencies are installed.
// Keep this byte-tree reader on Node built-ins instead of importing inventory.js,
// whose static analyzer intentionally depends on the development acorn package.
async function describeFile(filename) {
  try {
    const info = await lstat(filename);
    if (info.isSymbolicLink()) return { filename, available: false, kind: 'symbolic-link', errorCode: 'UNSUPPORTED_INPUT_LINK' };
    if (info.isDirectory()) {
      const entries = [];
      for (const name of (await readdir(filename)).sort()) {
        const { filename: ignored, ...description } = await describeFile(path.join(filename, name));
        entries.push({ name, ...description });
      }
      return { filename, available: entries.every(entry => entry.available), kind: 'directory', entries,
        entriesSha256: sha256(JSON.stringify(entries)) };
    }
    if (!info.isFile()) return { filename, available: false, kind: 'unsupported-input' };
    const bytes = await readFile(filename);
    return { filename, available: true, kind: 'file', bytes: bytes.length, sha256: sha256(bytes) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { filename, available: false };
  }
}

function validRelativePath(value) {
  return typeof value === 'string' && value && !path.isAbsolute(value) && !/[:\\\r\n\0]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

function sameDescriptor(actual, expected) {
  return actual?.path === expected?.path && actual?.bytes === expected?.bytes && actual?.sha256 === expected?.sha256;
}

function sameBytes(actual, expected) {
  return actual?.bytes === expected?.bytes && actual?.sha256 === expected?.sha256;
}

function validateSourceSnapshot(snapshot, manifest) {
  if (snapshot?.allMatched !== true || !Array.isArray(snapshot.files) || snapshot.files.length !== designatedJellyfinSourceFiles) {
    throw new Error('Native source snapshot is incomplete.');
  }
  for (let index = 0; index < manifest.files.length; index += 1) {
    const actual = snapshot.files[index], expected = manifest.files[index];
    if (actual?.path !== expected.path || actual.bytes !== expected.size || actual.sha256 !== expected.sha256 || actual.matches !== true) {
      throw new Error('Native source snapshot does not match the designated Jellyfin source.');
    }
  }
}

function validateByteTreeManifest(manifest, { root, kind }) {
  if (manifest?.schemaVersion !== 1 || path.resolve(manifest.root ?? '') !== root || manifest.kind !== kind
    || manifest.scope !== 'same-run-byte-identity-only' || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`Native ${kind} byte manifest is incomplete.`);
  }
  const paths = new Set();
  for (const descriptor of manifest.files) {
    if (!validRelativePath(descriptor?.path) || !digest(descriptor.sha256)
      || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0 || paths.has(descriptor.path)) {
      throw new Error(`Native ${kind} byte manifest contains an invalid file.`);
    }
    paths.add(descriptor.path);
  }
}

function descriptorIndex(files, label) {
  if (!Array.isArray(files) || files.length === 0) throw new Error(`Native ${label} byte manifest is empty.`);
  const exact = new Map(), folded = new Set();
  for (const descriptor of files) {
    const key = typeof descriptor?.path === 'string' ? descriptor.path.toLowerCase() : null;
    if (!validRelativePath(descriptor?.path) || !digest(descriptor.sha256)
      || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0
      || exact.has(descriptor.path) || folded.has(key)) {
      throw new Error(`Native ${label} byte manifest contains an invalid or case-folded duplicate file.`);
    }
    exact.set(descriptor.path, descriptor); folded.add(key);
  }
  return exact;
}

function validateProducer(receipt, environment) {
  const contract = producerContracts[receipt.producer?.job];
  if (!contract || receipt.producer.workflow !== contract.workflow || receipt.producer.workflow !== environment.GITHUB_WORKFLOW
    || receipt.producer.workflowRef !== environment.GITHUB_WORKFLOW_REF
    || receipt.producer.workflowSha !== environment.GITHUB_WORKFLOW_SHA
    || receipt.producer.eventName !== environment.GITHUB_EVENT_NAME || receipt.producer.ref !== environment.GITHUB_REF
    || receipt.producer.job !== environment.GITHUB_JOB
    || receipt.producer.eventName !== 'workflow_dispatch' || !/^refs\/(?:heads|tags)\//u.test(receipt.producer.ref)
    || receipt.producer.workflowRef !== `${designatedJellyfinRepository}/.github/workflows/${contract.workflowFile}@${receipt.producer.ref}`
    || !commit(receipt.producer.workflowSha)) {
    throw new Error('Native reference evidence is not from the designated producer workflow, job, event and ref.');
  }
  const runner = receipt.runner;
  const shard = Number(runner?.shard), shards = Number(runner?.shards);
  if (!runner || runner.os !== environment.RUNNER_OS || runner.architecture !== environment.RUNNER_ARCH
    || runner.matrixOs !== environment.MEDIAMANAGER_CI_MATRIX_OS || runner.shard !== environment.MEDIAMANAGER_CI_SHARD
    || runner.shards !== environment.MEDIAMANAGER_CI_SHARDS || runnerByMatrix[runner.matrixOs] !== runner.os
    || runner.os !== currentRunnerOs || runner.architecture !== currentRunnerArchitecture
    || !/^[1-9][0-9]*$/u.test(runner.shard) || !/^[1-9][0-9]*$/u.test(runner.shards)
    || !Number.isSafeInteger(shard) || !Number.isSafeInteger(shards) || shard > shards
    || receipt.producer.job === 'build' && (runner.shard !== '1' || runner.shards !== '1')) {
    throw new Error('Native reference evidence is not from this runner platform and matrix shard.');
  }
  if (!commit(receipt.checkout?.head) || !commit(receipt.checkout?.tree)
    || receipt.checkout.head !== receipt.commit || receipt.checkout.head !== environment.MEDIAMANAGER_CHECKOUT_HEAD
    || receipt.checkout.tree !== environment.MEDIAMANAGER_CHECKOUT_TREE) {
    throw new Error('Native reference evidence is not from this exact checkout HEAD and tree.');
  }
}

/** Collect a same-run native build closure. Omitted SDK and NuGet payloads are not an offline replay bundle. */
export async function nativeBuildInputs(environment = process.env) {
  if (!environment.MEDIAMANAGER_NATIVE_BUILD_ROOT || !environment.MEDIAMANAGER_JELLYFIN_DLL
    || !environment.MEDIAMANAGER_CI_DOTNET_ROOT || !environment.MEDIAMANAGER_DOTNET) {
    throw new Error('Native reference provisioning requires its build root, Jellyfin DLL and isolated .NET root.');
  }
  const root = path.resolve(environment.MEDIAMANAGER_NATIVE_BUILD_ROOT), runtime = path.join(root, 'runtime');
  const receipts = path.join(root, 'receipts'), sourceOfferRoot = path.join(root, 'source-offer');
  const sourceRoot = path.join(root, 'source');
  const nugetRoot = path.join(root, 'nuget-packages'), sdkRoot = path.resolve(environment.MEDIAMANAGER_CI_DOTNET_ROOT);
  const dll = path.join(runtime, 'jellyfin.dll');
  const expectedDotnet = path.join(sdkRoot, environment.RUNNER_OS === 'Windows' ? 'dotnet.exe' : 'dotnet');
  if (path.resolve(environment.MEDIAMANAGER_JELLYFIN_DLL) !== dll
    || environment.MEDIAMANAGER_JELLYFIN_DLL_DIRECTORY && path.resolve(environment.MEDIAMANAGER_JELLYFIN_DLL_DIRECTORY) !== runtime
    || path.resolve(environment.MEDIAMANAGER_DOTNET) !== expectedDotnet) {
    throw new Error('Native reference consumers must use the same-run runtime and isolated .NET executable.');
  }
  const designated = await verifyDesignatedJellyfinSourcePackage();
  const inputs = [];
  const add = (filename, reason, expected = {}) => inputs.push({ filename, reason, ...expected });
  for (const input of designated.inputs) add(input.filename, 'designated-source-package', { bytes: input.bytes, sha256: input.sha256 });
  for (const [directory, reason] of [[runtime, 'runtime'], [receipts, 'receipts'], [sourceOfferRoot, 'source-offer'],
    [sdkRoot, 'same-run-dotnet-sdk'], [nugetRoot, 'same-run-nuget-packages']]) add(directory, reason);
  add(dll, 'entry-assembly');
  const fixedReceiptNames = ['build-receipt.json', 'runtime-manifest.json', 'source-before.json', 'source-after.json',
    'sdk-before.json', 'sdk-after.json', 'nuget-before-build.json', 'nuget-after-build.json'];
  for (const filename of fixedReceiptNames) add(path.join(receipts, filename), 'receipt');
  const read = async filename => {
    try { return JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const bind = (directory, descriptor, reason = 'build-manifest') => {
    if (!descriptor || !validRelativePath(descriptor.path) || !digest(descriptor.sha256)
      || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0) {
      throw new Error('Invalid native build evidence descriptor.');
    }
    const filename = path.join(directory, ...descriptor.path.split('/'));
    add(filename, reason, { sha256: descriptor.sha256, bytes: descriptor.bytes });
    return filename;
  };
  const receiptFiles = new Set(['build-receipt.json']);
  const receipt = await read(path.join(receipts, 'build-receipt.json'));
  let manifest = null, sourceBefore = null, sourceAfter = null;
  let sdkBefore = null, sdkAfter = null, nugetBeforeBuild = null, nugetAfterBuild = null;
  if (receipt) {
    if (receipt.schemaVersion !== 2 || receipt.status !== 'succeeded' || receipt.sdkExpected !== '10.0.401'
      || receipt.sdkActual !== '10.0.401' || receipt.testsExecuted !== false || receipt.oracleRecordingsProduced !== false
      || receipt.historicalBinaryReplacement !== false || receipt.sourceUnchanged !== true || receipt.sdkUnchanged !== true
      || receipt.nugetUnchangedDuringBuild !== true || !timestamp(receipt.started) || !timestamp(receipt.finished)
      || instant(receipt.started) > instant(receipt.finished)
      || receipt.evidenceScope?.sameRunByteVerification !== true || receipt.evidenceScope.offlineReplaySelfContained !== false
      || !same(receipt.evidenceScope.omittedOfflinePayloads, omittedOfflinePayloads)
      || receipt.evidenceScope.statement !== evidenceStatement) {
      throw new Error('The native reference build did not finish with a complete same-run byte closure.');
    }
    for (const [field, variable] of [['repository', 'GITHUB_REPOSITORY'], ['commit', 'GITHUB_SHA'], ['runId', 'GITHUB_RUN_ID'], ['runAttempt', 'GITHUB_RUN_ATTEMPT']]) {
      if (typeof environment[variable] !== 'string' || !environment[variable] || receipt[field] !== environment[variable]) {
        throw new Error(`Native reference evidence is not from this repository candidate and workflow run: ${field}`);
      }
    }
    if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REPOSITORY !== designatedJellyfinRepository) {
      throw new Error('Native reference evidence is not from the designated GitHub repository run.');
    }
    if (!commit(receipt.commit) || !/^[1-9][0-9]*$/u.test(receipt.runId) || !/^[1-9][0-9]*$/u.test(receipt.runAttempt)) {
      throw new Error('Native reference repository candidate or run identity is malformed.');
    }
    validateProducer(receipt, environment);
    if (receipt.source?.head !== designatedJellyfinHead || receipt.source.contentDigest !== designatedJellyfinContentDigest
      || receipt.source.files !== designatedJellyfinSourceFiles
      || !sameDescriptor(receipt.source.archive, designated.attachments.archive.descriptor)
      || !sameDescriptor(receipt.source.manifest, designated.attachments.sourceManifest.descriptor)) {
      throw new Error('Native build receipt does not identify the designated Jellyfin source.');
    }
    const config = designated.manifest.files.find(file => file.path === nugetConfigName);
    if (!config || path.resolve(receipt.restoreIsolation?.packagesRoot ?? '') !== nugetRoot
      || !sameDescriptor(receipt.restoreIsolation?.config,
        { path: nugetConfigName, bytes: config.size, sha256: config.sha256 })
      || receipt.restoreIsolation?.fallbackEnvironmentAbsent !== true
      || receipt.restoreIsolation?.restoreFallbackFolders !== ''
      || receipt.restoreIsolation?.restoreAdditionalProjectFallbackFolders !== ''
      || environment.NUGET_FALLBACK_PACKAGES !== undefined) {
      throw new Error('Native restore isolation does not bind the sealed config, package root and empty fallback inputs.');
    }
    const offerByPath = new Map(designated.sourceOffer.map(descriptor => [descriptor.path, descriptor]));
    if (!Array.isArray(receipt.sourceOffer) || receipt.sourceOffer.length !== offerByPath.size
      || new Set(receipt.sourceOffer.map(descriptor => descriptor?.path)).size !== offerByPath.size) {
      throw new Error('Native build source offer is incomplete.');
    }
    for (const descriptor of receipt.sourceOffer) {
      if (!sameDescriptor(descriptor, offerByPath.get(descriptor.path))) throw new Error('Native build source offer differs from its designated package.');
      bind(sourceOfferRoot, descriptor, 'designated-source-offer');
    }
    const fixedReceipts = [
      [receipt.runtimeManifest, 'runtime-manifest.json'], [receipt.sourceBefore, 'source-before.json'],
      [receipt.sourceAfter, 'source-after.json'], [receipt.sdkBefore, 'sdk-before.json'],
      [receipt.sdkAfter, 'sdk-after.json'], [receipt.nugetBeforeBuild, 'nuget-before-build.json'],
      [receipt.nugetAfterBuild, 'nuget-after-build.json'],
    ];
    for (const [descriptor, expectedPath] of fixedReceipts) {
      if (descriptor?.path !== expectedPath) throw new Error('Native build receipt references an unexpected evidence path.');
      bind(receipts, descriptor); receiptFiles.add(expectedPath);
    }
    if (!sameBytes(receipt.sourceBefore, receipt.sourceAfter)
      || !sameBytes(receipt.sdkBefore, receipt.sdkAfter)
      || !sameBytes(receipt.nugetBeforeBuild, receipt.nugetAfterBuild)) {
      throw new Error('Native build before and after byte-tree evidence differs.');
    }
    [manifest, sourceBefore, sourceAfter, sdkBefore, sdkAfter, nugetBeforeBuild, nugetAfterBuild] =
      await Promise.all(fixedReceipts.map(([descriptor]) => read(path.join(receipts, descriptor.path))));
    if ([manifest, sourceBefore, sourceAfter, sdkBefore, sdkAfter, nugetBeforeBuild, nugetAfterBuild].some(value => !value)) {
      throw new Error('Native build receipt evidence is missing.');
    }
    validateSourceSnapshot(sourceBefore, designated.manifest); validateSourceSnapshot(sourceAfter, designated.manifest);
    if (!same(sourceBefore, sourceAfter)) throw new Error('Native build before and after source snapshots differ.');
    validateByteTreeManifest(sdkBefore, { root: sdkRoot, kind: 'dotnet-sdk' });
    validateByteTreeManifest(sdkAfter, { root: sdkRoot, kind: 'dotnet-sdk' });
    validateByteTreeManifest(nugetBeforeBuild, { root: nugetRoot, kind: 'nuget-packages' });
    validateByteTreeManifest(nugetAfterBuild, { root: nugetRoot, kind: 'nuget-packages' });
    if (!same(sdkBefore, sdkAfter) || !same(nugetBeforeBuild, nugetAfterBuild)) {
      throw new Error('Native SDK or NuGet byte tree changed during the no-restore build.');
    }
    const expectedCommands = [
      { arguments: ['--version'], stdout: 'sdk-version.stdout.txt', stderr: 'sdk-version.stderr.txt' },
      { arguments: ['--info'], stdout: 'sdk-info.stdout.txt', stderr: 'sdk-info.stderr.txt' },
      { arguments: restoreArguments(nugetRoot, path.join(sourceRoot, nugetConfigName)),
        stdout: 'restore.stdout.txt', stderr: 'restore.stderr.txt' },
      { arguments: buildArguments(runtime), stdout: 'build.stdout.txt', stderr: 'build.stderr.txt' },
    ];
    if (!Array.isArray(receipt.commands) || receipt.commands.length !== expectedCommands.length) {
      throw new Error('Native build command evidence is incomplete.');
    }
    let executable = null, sdkVersionOutput = null, lastCommandFinished = instant(receipt.started);
    for (let index = 0; index < expectedCommands.length; index += 1) {
      const commandEvidence = receipt.commands[index], expected = expectedCommands[index];
      if (!commandEvidence || commandEvidence.exitCode !== 0 || commandEvidence.timedOut === true
        || !same(commandEvidence.arguments, expected.arguments) || typeof commandEvidence.executable !== 'string'
        || !path.isAbsolute(commandEvidence.executable) || typeof commandEvidence.cwd !== 'string'
        || path.resolve(commandEvidence.cwd) !== path.join(root, 'source')
        || !timestamp(commandEvidence.started) || !timestamp(commandEvidence.finished)
        || instant(commandEvidence.started) > instant(commandEvidence.finished)
        || instant(commandEvidence.started) < instant(receipt.started) || instant(commandEvidence.finished) > instant(receipt.finished)
        || instant(commandEvidence.started) < lastCommandFinished
        || commandEvidence.stdout?.path !== expected.stdout || commandEvidence.stderr?.path !== expected.stderr) {
        throw new Error('Native build command evidence differs from the designated restore and no-restore build procedure.');
      }
      executable ??= path.resolve(commandEvidence.executable);
      if (path.resolve(commandEvidence.executable) !== executable) throw new Error('Native build commands used different SDK executables.');
      const stdout = bind(receipts, commandEvidence.stdout, 'build-command-output');
      bind(receipts, commandEvidence.stderr, 'build-command-output');
      receiptFiles.add(expected.stdout); receiptFiles.add(expected.stderr);
      if (index === 0) sdkVersionOutput = stdout;
      lastCommandFinished = instant(commandEvidence.finished);
    }
    if (executable !== expectedDotnet) throw new Error('Native build commands did not use the same-run isolated .NET executable.');
    if ((await readFile(sdkVersionOutput, 'utf8')).trim() !== receipt.sdkExpected) {
      throw new Error('Native build SDK version output does not match its receipt.');
    }
  }
  manifest ??= await read(path.join(receipts, 'runtime-manifest.json'));
  if (manifest) {
    const runtimeIndex = descriptorIndex(manifest.files, 'runtime');
    if (!runtimeIndex.has('jellyfin.dll')) throw new Error('Invalid native runtime file manifest.');
    for (const descriptor of runtimeIndex.values()) bind(runtime, descriptor, 'native-runtime-manifest');
  }
  return { root, runtime, dll, receipts, sourceOfferRoot, sourceRoot, sdkRoot, nugetRoot, receipt, manifest, sourceBefore,
    sourceAfter, sdkBefore, sdkAfter, nugetBeforeBuild, nugetAfterBuild, designated, inputs,
    receiptFiles: [...receiptFiles], sourceOfferFiles: receipt?.sourceOffer?.map(file => file.path) ?? [] };
}

function flattenedDescriptors(entry, prefix = '', files = []) {
  if (entry.kind === 'directory') {
    for (const child of entry.entries) flattenedDescriptors(child, prefix ? `${prefix}/${child.name}` : child.name, files);
  } else if (entry.kind === 'file') files.push({ path: prefix, bytes: entry.bytes, sha256: entry.sha256 });
  else throw new Error('Native build contains an unsupported input.');
  return files;
}

function sameFileTree(actual, expected) {
  if (actual.length !== expected.length) return false;
  const byPath = new Map(expected.map(file => [file.path, file]));
  return byPath.size === expected.length && actual.every(file => sameDescriptor(file, byPath.get(file.path)));
}

async function describeDesignatedSource(root, manifest) {
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('root is not a physical directory');
    const files = [];
    for (const expected of manifest.files) {
      let filename = root;
      for (const part of expected.path.split('/')) {
        filename = path.join(filename, part);
        if ((await lstat(filename)).isSymbolicLink()) throw new Error(`path traverses a symbolic link: ${expected.path}`);
      }
      const info = await lstat(filename);
      if (!info.isFile()) throw new Error(`member is not an ordinary file: ${expected.path}`);
      const bytes = await readFile(filename), actual = { path: expected.path, bytes: bytes.length, sha256: sha256(bytes) };
      if (actual.bytes !== expected.size || actual.sha256 !== expected.sha256) {
        throw new Error(`member bytes differ: ${expected.path}`);
      }
      files.push(actual);
    }
    return { filename: root, available: true, kind: 'designated-source-files', files,
      entriesSha256: sha256(JSON.stringify(files)) };
  } catch (error) {
    throw new Error(`Native designated source live byte tree differs from its sealed manifest: ${error.message}`, { cause: error });
  }
}

/** Verify live same-run byte roots before launch. Uploaded manifests still omit the roots required for offline replay. */
export async function verifyNativeBuild(environment = process.env) {
  const build = await nativeBuildInputs(environment);
  if (!build.receipt || !build.manifest) throw new Error('Native build receipt or runtime manifest is missing.');
  const descriptions = new Map();
  for (const input of build.inputs) {
    if (!descriptions.has(input.filename)) descriptions.set(input.filename, await describeFile(input.filename));
    const actual = descriptions.get(input.filename);
    if (!actual.available || (input.sha256 && actual.sha256 !== input.sha256)
      || input.bytes != null && actual.bytes !== input.bytes) throw new Error(`Native build input is missing or changed: ${input.filename}`);
  }
  const membership = (directory, expected, label) => {
    const files = flattenedDescriptors(descriptions.get(directory)).map(file => file.path).sort();
    if (!same(files, [...expected].sort())) throw new Error(`Native ${label} membership differs from its build manifest.`);
  };
  membership(build.runtime, build.manifest.files.map(file => file.path), 'runtime');
  membership(build.receipts, build.receiptFiles, 'receipt');
  membership(build.sourceOfferRoot, build.sourceOfferFiles, 'source offer');
  const currentSdk = flattenedDescriptors(descriptions.get(build.sdkRoot));
  const currentNuget = flattenedDescriptors(descriptions.get(build.nugetRoot));
  if (!sameFileTree(currentSdk, build.sdkAfter.files)) throw new Error('Native .NET SDK live byte tree differs from its same-run manifest.');
  if (!sameFileTree(currentNuget, build.nugetAfterBuild.files)) throw new Error('Native NuGet live byte tree differs from its same-run manifest.');
  const currentSource = await describeDesignatedSource(build.sourceRoot, build.designated.manifest);
  const identityEntries = [...descriptions.values(), currentSource];
  return { ...build, identitySha256: sha256(JSON.stringify(identityEntries)), identityEntries,
    runtimeEntriesSha256: descriptions.get(build.runtime).entriesSha256,
    sourceEntriesSha256: currentSource.entriesSha256,
    sdkEntriesSha256: descriptions.get(build.sdkRoot).entriesSha256,
    nugetEntriesSha256: descriptions.get(build.nugetRoot).entriesSha256 };
}
