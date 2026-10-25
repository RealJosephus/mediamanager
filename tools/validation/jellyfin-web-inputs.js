import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describeFile } from './inventory.js';

const head = '4c6d87e61c28e15dcb0cfe431ba6c083bb307a0b';
const lockPin = 'bc9b0aaf153d6f8f1abb9c9ff96dc1c3c53e900bd4a8c107d3a348e7e3bcc218';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** Verify the actual same-run client build before serving it; does not execute tools. */
export async function jellyfinWebInputs(environment = process.env) {
  const output = environment.MEDIAMANAGER_JELLYFIN_WEB_BUILD_ROOT;
  const client = environment.MEDIAMANAGER_JELLYFIN_WEB_ROOT;
  if (typeof output !== 'string' || !path.isAbsolute(output) || typeof client !== 'string'
    || client !== path.join(output, 'runtime')) throw new Error('Jellyfin Web requires an explicit same-run build root and runtime.');
  const inputs = [], observed = new Map();
  const bind = async (filename, expected) => {
    const value = observed.get(filename) ?? await describeFile(filename);
    if (!value.available || value.kind !== 'file' || expected
      && (!digest(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0
        || value.sha256 !== expected.sha256 || value.bytes !== expected.bytes)) {
      throw new Error(`Jellyfin Web input is missing or changed: ${filename}`);
    }
    if (!observed.has(filename)) {
      observed.set(filename, value);
      inputs.push({ filename, bytes: value.bytes, sha256: value.sha256 });
    }
    return value;
  };
  const member = (root, relative) => {
    if (typeof relative !== 'string' || !relative || /[:\\\r\n\0]/u.test(relative)
      || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Invalid Jellyfin Web evidence path.');
    }
    return path.join(root, relative);
  };
  const json = async (filename, expected) => {
    const descriptor = await bind(filename, expected);
    if (descriptor.bytes > 64 * 1024 * 1024) throw new Error('Jellyfin Web evidence exceeds its JSON size limit.');
    return JSON.parse(await readFile(filename, 'utf8'));
  };
  const receipt = await json(path.join(output, 'receipts/build-receipt.json'));
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'jellyfin-web' || receipt.status !== 'succeeded'
    || receipt.sourceHead !== head || receipt.sourceRepository !== 'https://github.com/jellyfin/jellyfin-web.git'
    || receipt.sourceFiles !== 1226 || receipt.lock?.sha256 !== lockPin || receipt.license !== 'GPL-2.0-or-later'
    || receipt.nodeActual !== 'v24.16.0' || !/^11\.\d+\.\d+$/u.test(receipt.npmActual ?? '')
    || receipt.sourceUnchanged !== true || receipt.sourceBefore?.sha256 !== receipt.sourceAfter?.sha256
    || receipt.webInteractionValidated !== false) throw new Error('Jellyfin Web receipt does not prove the designated client build.');
  for (const [field, variable] of [['repository', 'GITHUB_REPOSITORY'], ['commit', 'GITHUB_SHA'], ['runId', 'GITHUB_RUN_ID'], ['runAttempt', 'GITHUB_RUN_ATTEMPT']]) {
    if (!environment[variable] || receipt[field] !== environment[variable]) throw new Error(`Jellyfin Web evidence belongs to another run: ${field}`);
  }
  const builder = fileURLToPath(new URL('../ci/build-jellyfin-web.ps1', import.meta.url));
  if (receipt.builder?.path !== builder) throw new Error('Jellyfin Web producer binding is missing.');
  await bind(builder, receipt.builder);
  const readReceipt = descriptor => json(member(output, descriptor?.path), descriptor);
  const before = await readReceipt(receipt.sourceBefore), after = await readReceipt(receipt.sourceAfter);
  if (before.head !== head || after.head !== head || !Array.isArray(before.files) || before.files.length !== 1226
    || new Set(before.files.map(file => file.path)).size !== 1226
    || before.files.find(file => file.path === 'package-lock.json')?.sha256 !== lockPin) throw new Error('Jellyfin Web source membership is incomplete.');
  for (const file of before.files) await bind(member(path.join(output, 'source'), file.path), file);
  if (!Array.isArray(receipt.sourceOffer) || receipt.sourceOffer.length !== 3
    || new Set(receipt.sourceOffer.map(file => file.path)).size !== 3) throw new Error('Jellyfin Web source offer is incomplete.');
  for (const filename of ['jellyfin-web-source.zip', 'LICENSE', 'source-manifest.json']) {
    const descriptor = receipt.sourceOffer.find(file => file.path === `source-offer/${filename}`);
    await bind(member(output, descriptor?.path), descriptor);
    if (filename === 'source-manifest.json' && descriptor.sha256 !== receipt.sourceBefore.sha256
      || filename === 'LICENSE' && descriptor.sha256 !== before.files.find(file => file.path === 'LICENSE')?.sha256) {
      throw new Error('Jellyfin Web source offer differs from its build inputs.');
    }
  }
  const tree = async (root, manifest) => {
    if (!Array.isArray(manifest.files) || !manifest.files.length
      || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw new Error('Invalid Jellyfin Web file manifest.');
    const actual = await describeFile(root), files = [];
    const visit = (entry, relative = '') => {
      if (entry.kind === 'directory') for (const child of entry.entries) visit(child, relative ? `${relative}/${child.name}` : child.name);
      else if (entry.kind === 'file') files.push(relative);
      else throw new Error('Jellyfin Web input tree contains an unsupported member.');
    };
    if (!actual.available || actual.kind !== 'directory') throw new Error('Jellyfin Web input tree is missing.');
    visit(actual);
    const expected = manifest.files.map(file => file.path).sort();
    if (JSON.stringify(files.sort()) !== JSON.stringify(expected)) throw new Error('Jellyfin Web input membership changed.');
    inputs.push({ filename: root, sha256: actual.entriesSha256 });
    for (const file of manifest.files) await bind(member(root, file.path), file);
  };
  const runtime = await readReceipt(receipt.runtimeManifest);
  if (!runtime.files?.some(file => file.path === 'index.html') || !runtime.files.some(file => file.path === 'config.json')) {
    throw new Error('Jellyfin Web runtime lacks its entry page or configuration.');
  }
  await tree(client, runtime);
  if (!Array.isArray(receipt.tools) || receipt.tools.length !== 3) throw new Error('Jellyfin Web tool identities are missing.');
  for (const tool of receipt.tools) {
    if (!path.isAbsolute(tool.path)) throw new Error('Jellyfin Web tools require actual absolute paths.');
    await bind(tool.path, tool);
  }
  if (typeof receipt.npmToolRoot !== 'string' || !path.isAbsolute(receipt.npmToolRoot)) throw new Error('Jellyfin Web npm implementation is missing.');
  await tree(receipt.npmToolRoot, await readReceipt(receipt.npmToolManifest));
  await tree(path.join(output, 'npm-cache/_cacache/content-v2'), await readReceipt(receipt.npmCacheManifest));
  if (!Array.isArray(receipt.commands) || !receipt.commands.some(command => command.name === 'build')) throw new Error('Jellyfin Web build command is missing.');
  for (const command of receipt.commands) {
    if (command.exitCode !== 0 || command.timedOut) throw new Error('Jellyfin Web command did not complete successfully.');
    await bind(member(output, command.stdout?.path), command.stdout);
    await bind(member(output, command.stderr?.path), command.stderr);
  }
  return { root: output, runtime: client, receipt, inputs };
}
