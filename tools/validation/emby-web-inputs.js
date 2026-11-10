import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hostedEmbyCatalog, hostedEmbyMember, hostedEmbyOrigin, hostedEmbyVersion } from '../ci/fetch-emby-web.js';
import { describeFile } from './inventory.js';

/** Bind the unmodified hosted resources captured for this exact CI run. */
export async function embyWebInputs(environment = process.env) {
  const output = environment.MEDIAMANAGER_EMBY_WEB_INPUT_ROOT;
  const runtime = environment.MEDIAMANAGER_EMBY_WEB_ROOT;
  if (!path.isAbsolute(output ?? '') || runtime !== path.join(output, 'runtime')) throw new Error('Emby Web requires its same-run input root.');
  const inputs = [];
  const bind = async (filename, expected) => {
    const actual = await describeFile(filename);
    if (!actual.available || actual.kind !== 'file' || expected
      && (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)) throw new Error(`Emby Web input is missing or changed: ${filename}`);
    inputs.push({ filename, bytes: actual.bytes, sha256: actual.sha256 });
    return actual;
  };
  const member = relative => hostedEmbyMember(output, relative);
  const receiptPath = member('receipts/input-receipt.json');
  await bind(receiptPath);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'emby-web' || receipt.status !== 'succeeded'
    || receipt.origin !== hostedEmbyOrigin
    || receipt.entryAndCatalogUnchanged !== true || receipt.clientInteractionValidated !== false) throw new Error('Emby Web capture is incomplete.');
  for (const [field, variable] of [['repository', 'GITHUB_REPOSITORY'], ['commit', 'GITHUB_SHA'], ['runId', 'GITHUB_RUN_ID'], ['runAttempt', 'GITHUB_RUN_ATTEMPT']]) {
    if (!environment[variable] || receipt[field] !== environment[variable]) throw new Error(`Emby Web evidence belongs to another run: ${field}`);
  }
  const producer = fileURLToPath(new URL('../ci/fetch-emby-web.js', import.meta.url));
  if (receipt.builder?.path !== producer) throw new Error('Emby Web producer binding is missing.');
  await bind(producer, receipt.builder);
  if (!Array.isArray(receipt.externalResources) || receipt.externalResources.length !== 2) throw new Error('Emby Web startup dependencies are incomplete.');
  for (const resource of receipt.externalResources) {
    if (new URL(resource.url).hostname !== 'www.gstatic.com' || new URL(resource.resolvedUrl).hostname !== 'www.gstatic.com'
      || !/^external\/[01]\.js$/u.test(resource.path)) throw new Error('Invalid external Emby Web input.');
    await bind(member(resource.path), resource);
  }
  const manifestPath = member(receipt.runtimeManifest?.path);
  await bind(manifestPath, receipt.runtimeManifest);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.files)) throw new Error('Emby Web resource membership is incomplete.');
  const files = new Map(manifest.files.map(file => [file.path, file]));
  if (files.size !== manifest.files.length || !files.has('index.html') || !files.has('serviceworker.js')) {
    throw new Error('Emby Web resource membership is incomplete.');
  }
  const bootstrap = receipt.bootstrapModules;
  if (bootstrap && (!files.has(bootstrap.source) || !Array.isArray(bootstrap.resources)
    || bootstrap.resources.some(relative => !files.has(relative)))) {
    throw new Error('Emby Web startup dependencies are incomplete.');
  }
  const tree = await describeFile(runtime), names = [];
  function visit(entry, relative = '') {
    if (entry.kind === 'directory') for (const child of entry.entries) visit(child, relative ? `${relative}/${child.name}` : child.name);
    else if (entry.kind === 'file') names.push(relative);
    else throw new Error('Emby Web input contains an unsupported member.');
  }
  if (!tree.available || tree.kind !== 'directory') throw new Error('Emby Web runtime is missing.');
  visit(tree);
  if (JSON.stringify(names.sort()) !== JSON.stringify(manifest.files.map(file => file.path).sort())) throw new Error('Emby Web resource membership changed.');
  inputs.push({ filename: runtime, sha256: tree.entriesSha256 });
  for (const file of manifest.files) await bind(hostedEmbyMember(runtime, file.path), file);
  const entry = await readFile(path.join(runtime, 'index.html'));
  if (hostedEmbyVersion(entry) !== receipt.version) throw new Error('The captured Emby Web version differs from the receipt.');
  const catalog = hostedEmbyCatalog(await readFile(path.join(runtime, 'serviceworker.js')));
  if (catalog.length !== receipt.catalogEntries || catalog.some(([relative, md5]) => files.get(relative)?.declaredMd5 !== md5)) {
    throw new Error('The captured Emby Web catalog differs from the manifest.');
  }
  return { root: output, runtime, receipt, inputs };
}
