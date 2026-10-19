import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { describeFile, sha256 } from './inventory.js';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value);

/** Collect the same-run build, including missing promised inputs for strict planning. */
export async function nativeBuildInputs(environment = process.env) {
  if (!environment.MEDIAMANAGER_NATIVE_BUILD_ROOT || !environment.MEDIAMANAGER_JELLYFIN_DLL) {
    throw new Error('Native reference provisioning requires its build root and Jellyfin DLL path.');
  }
  const root = path.resolve(environment.MEDIAMANAGER_NATIVE_BUILD_ROOT), runtime = path.join(root, 'runtime');
  const dll = path.join(runtime, 'jellyfin.dll');
  if (path.resolve(environment.MEDIAMANAGER_JELLYFIN_DLL) !== dll
    || environment.MEDIAMANAGER_JELLYFIN_DLL_DIRECTORY && path.resolve(environment.MEDIAMANAGER_JELLYFIN_DLL_DIRECTORY) !== runtime) {
    throw new Error('Native reference consumers must use the same-run build runtime directory.');
  }
  const inputs = [];
  const add = (filename, reason, expected = {}) => inputs.push({ filename, reason, ...expected });
  for (const directory of ['runtime', 'receipts', 'source-offer']) add(path.join(root, directory), directory);
  add(dll, 'entry-assembly');
  for (const filename of ['build-receipt.json', 'runtime-manifest.json', 'source-before.json', 'source-after.json', 'nuget-manifest.json']) {
    add(path.join(root, 'receipts', filename), 'receipt');
  }
  const read = async filename => {
    try { return JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const bind = (directory, descriptor) => {
    if (!descriptor || typeof descriptor.path !== 'string' || /[:\\\r\n\0]/u.test(descriptor.path)
      || descriptor.path.split('/').some(part => !part || part === '.' || part === '..') || !digest(descriptor.sha256)) {
      throw new Error('Invalid native build evidence descriptor.');
    }
    add(path.join(directory, descriptor.path), 'build-manifest', {
      sha256: descriptor.sha256.toLowerCase(), ...(descriptor.bytes == null ? {} : { bytes: descriptor.bytes }),
    });
  };
  const receipt = await read(path.join(root, 'receipts/build-receipt.json'));
  if (receipt) {
    if (receipt.schemaVersion !== 1 || receipt.status !== 'succeeded' || receipt.sdkActual !== '10.0.401'
      || receipt.sourceUnchanged !== true || receipt.sourceBefore?.sha256 !== receipt.sourceAfter?.sha256
      || !Array.isArray(receipt.sourceOffer) || receipt.sourceOffer.length !== 4) {
      throw new Error('The native reference build did not finish with unchanged sealed sources.');
    }
    for (const [field, variable] of [['commit', 'GITHUB_SHA'], ['runId', 'GITHUB_RUN_ID'], ['runAttempt', 'GITHUB_RUN_ATTEMPT']]) {
      if (environment[variable] && receipt[field] !== environment[variable]) throw new Error('Native reference evidence belongs to another candidate or workflow run.');
    }
    for (const descriptor of [receipt.runtimeManifest, receipt.sourceBefore, receipt.sourceAfter, receipt.nugetManifest]) {
      bind(path.join(root, 'receipts'), descriptor);
    }
    for (const descriptor of receipt.sourceOffer) bind(path.join(root, 'source-offer'), descriptor);
  }
  const manifest = await read(path.join(root, 'receipts/runtime-manifest.json'));
  if (manifest) {
    if (!Array.isArray(manifest.files) || !manifest.files.some(file => file.path === 'jellyfin.dll')
      || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw new Error('Invalid native runtime file manifest.');
    for (const descriptor of manifest.files) bind(runtime, descriptor);
  }
  return { root, runtime, dll, receipt, manifest, inputs };
}

/** Verify byte bindings before launching the runtime, without executing any tool. */
export async function verifyNativeBuild(environment = process.env) {
  const build = await nativeBuildInputs(environment), descriptions = new Map();
  for (const input of build.inputs) {
    if (!descriptions.has(input.filename)) descriptions.set(input.filename, await describeFile(input.filename));
    const actual = descriptions.get(input.filename);
    if (!actual.available || input.sha256 && actual.sha256 !== input.sha256
      || input.bytes != null && actual.bytes !== input.bytes) throw new Error(`Native build input is missing or changed: ${input.filename}`);
  }
  const files = [];
  const visit = (entry, prefix = '') => {
    if (entry.kind === 'directory') for (const child of entry.entries) visit(child, prefix ? `${prefix}/${child.name}` : child.name);
    else if (entry.kind === 'file') files.push(prefix);
    else throw new Error('Native runtime contains an unsupported input.');
  };
  visit(descriptions.get(build.runtime));
  if (JSON.stringify(files.sort()) !== JSON.stringify(build.manifest.files.map(file => file.path).sort())) {
    throw new Error('Native runtime membership differs from its build manifest.');
  }
  return { ...build, identitySha256: sha256(JSON.stringify([...descriptions.values()])),
    runtimeEntriesSha256: descriptions.get(build.runtime).entriesSha256 };
}
