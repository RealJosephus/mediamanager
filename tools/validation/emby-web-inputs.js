import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
  const member = relative => {
    if (typeof relative !== 'string' || !relative || /[:\\?#%\r\n\0]/u.test(relative)
      || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid Emby Web evidence path.');
    return path.join(output, relative);
  };
  const receiptPath = member('receipts/input-receipt.json');
  await bind(receiptPath);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'emby-web' || receipt.status !== 'succeeded'
    || receipt.version !== '26.0.38' || receipt.origin !== 'https://app.emby.media/' || receipt.catalogEntries !== 865
    || receipt.entryAndCatalogUnchanged !== true || receipt.clientInteractionValidated !== false) throw new Error('Emby Web capture is incomplete.');
  for (const [field, variable] of [['repository', 'GITHUB_REPOSITORY'], ['commit', 'GITHUB_SHA'], ['runId', 'GITHUB_RUN_ID'], ['runAttempt', 'GITHUB_RUN_ATTEMPT']]) {
    if (!environment[variable] || receipt[field] !== environment[variable]) throw new Error(`Emby Web evidence belongs to another run: ${field}`);
  }
  const producer = fileURLToPath(new URL('../ci/fetch-emby-web.js', import.meta.url));
  if (receipt.builder?.path !== producer) throw new Error('Emby Web producer binding is missing.');
  await bind(producer, receipt.builder);
  if (receipt.bootstrapModules?.source !== 'app.js'
    || JSON.stringify(receipt.bootstrapModules.resources) !== JSON.stringify(['modules/ebookplayer/plugin.js', 'modules/pdfplayer/plugin.js'])
    || !Array.isArray(receipt.externalResources) || receipt.externalResources.length !== 2) throw new Error('Emby Web startup dependencies are incomplete.');
  for (const resource of receipt.externalResources) {
    if (new URL(resource.url).hostname !== 'www.gstatic.com' || new URL(resource.resolvedUrl).hostname !== 'www.gstatic.com'
      || !/^external\/[01]\.js$/u.test(resource.path)) throw new Error('Invalid external Emby Web input.');
    await bind(member(resource.path), resource);
  }
  const manifestPath = member(receipt.runtimeManifest?.path);
  await bind(manifestPath, receipt.runtimeManifest);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.files) || manifest.files.length < 865
    || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw new Error('Emby Web resource membership is incomplete.');
  for (const required of ['index.html', 'serviceworker.js', 'apploader.js', 'app.js', 'manifest.json',
    'modules/emby-apiclient/apiclient.js', 'modules/emby-apiclient/connectionmanager.js', ...receipt.bootstrapModules.resources]) {
    if (!manifest.files.some(file => file.path === required)) throw new Error('Emby Web lacks a required client resource.');
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
  for (const file of manifest.files) await bind(member(`runtime/${file.path}`), file);
  return { root: output, runtime, receipt, inputs };
}
