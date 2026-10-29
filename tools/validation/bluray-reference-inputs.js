import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import source from '../ci/bluray-reference/sintel.json' with { type: 'json' };
import { describeFile, sha256 } from './inventory.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const originalManifestFile = path.join(repository, 'tools/ci/bluray-reference/first-sintel-ci/complete-files.json');
const order = values => values.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const memberPath = value => typeof value === 'string' && value && !/[\\:\r\n\0]/u.test(value)
  && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');

/** Complete unchanged Sintel media acquired by this actual CI job, never a
 * small receipt or an old Linux extraction presented as another host's input. */
export async function blurayReferenceInputs(environment = process.env) {
  assert.equal(environment.GITHUB_ACTIONS, 'true');
  assert.equal(environment.MEDIAMANAGER_CI_BLURAY_REFERENCE, 'true');
  assert.ok(environment.RUNNER_TEMP && environment.MEDIAMANAGER_TEST_BLURAY_REFERENCE);
  const root = path.join(await realpath(environment.RUNNER_TEMP), 'mediamanager-bluray-reference');
  const evidence = path.join(root, 'evidence'), mediaRoot = path.join(root, 'media'), filename = path.join(evidence, 'receipt.json');
  assert.equal(path.resolve(environment.MEDIAMANAGER_TEST_BLURAY_REFERENCE), filename);
  const inputs = [];
  const bind = async (filename, expected, bytes) => {
    const actual = await describeFile(filename);
    assert.ok(actual.available && actual.kind === 'file' && (expected === undefined || actual.sha256 === expected)
      && (bytes === undefined || actual.bytes === bytes), `Original Blu-ray input is missing or changed: ${filename}`);
    inputs.push({ filename, sha256: actual.sha256 }); return actual;
  };
  await bind(filename);
  const receipt = JSON.parse(await readFile(filename, 'utf8'));
  assert.ok(receipt.schemaVersion === 1 && receipt.complete === true && receipt.sourceId === 'sintel'
    && receipt.sourceArchiveRetained === true && receipt.mediaRoot === mediaRoot && receipt.discRoot === mediaRoot
    && receipt.bdmvRoot === path.join(mediaRoot, 'BDMV'));
  for (const [key, value] of Object.entries(source.iso)) assert.deepEqual(receipt.source[key], value, 'Original Sintel source ' + key);
  assert.deepEqual(receipt.download, { bytes: source.iso.bytes, sha256: source.iso.sha256, md5: source.iso.md5 });
  assert.equal(receipt.originalIso, path.join(root, 'work', source.iso.filename));
  await bind(receipt.originalIso, source.iso.sha256, source.iso.bytes);
  for (const key of ['GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'GITHUB_JOB',
    'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'RUNNER_OS', 'RUNNER_ARCH']) assert.equal(receipt.producer.identity[key], environment[key], 'Same-job Blu-ray ' + key);
  assert.equal(receipt.producer.checkout.head, environment.GITHUB_SHA); assert.match(receipt.producer.checkout.tree, /^[a-f0-9]{40}$/u);
  const producerPaths = ['tools/ci/bluray-reference/provision.js', 'tools/ci/bluray-reference/http-source.js', 'tools/ci/bluray-reference/torrent.js',
    'tools/ci/bluray-reference/sintel.json', 'tools/ci/bluray-reference/first-sintel-ci/complete-files.json', '.github/workflows/ci.yml',
    ...source.metadata.map(member => 'tools/ci/bluray-reference/' + member.path)];
  assert.deepEqual(receipt.producer.files.map(file => file.path), producerPaths);
  for (const file of receipt.producer.files) await bind(path.join(repository, file.path), file.sha256, file.bytes);
  assert.equal(receipt.producer.node.filename, await realpath(process.execPath));
  assert.equal(receipt.producer.node.version, process.version);
  await bind(receipt.producer.node.filename, receipt.producer.node.sha256, receipt.producer.node.bytes);
  assert.equal(receipt.archiveTool.platform, process.platform); assert.equal(receipt.archiveTool.architecture, process.arch);
  await bind(receipt.archiveTool.filename, receipt.archiveTool.sha256, receipt.archiveTool.bytes);
  assert.deepEqual(receipt.archiveTool.dependencies.map(file => file.filename), process.platform === 'win32'
    ? [path.join(path.dirname(receipt.archiveTool.filename), '7z.dll')] : []);
  for (const file of receipt.archiveTool.dependencies) await bind(file.filename, file.sha256, file.bytes);
  await bind(path.join(evidence, 'source.json'), receipt.source.descriptorSha256);
  assert.equal(receipt.source.descriptorSha256, sha256(await readFile(path.join(repository, producerPaths[3]))));
  for (const member of source.metadata) await bind(path.join(evidence, 'original-' + path.basename(member.path)), member.sha256, member.bytes);
  assert.equal(receipt.inventory.filename, 'media-inventory.json');
  const originalBytes = await readFile(originalManifestFile);
  assert.equal(receipt.inventory.sha256, sha256(originalBytes));
  await bind(path.join(evidence, receipt.inventory.filename), receipt.inventory.sha256, receipt.inventory.bytes);
  const manifest = JSON.parse(await readFile(path.join(evidence, receipt.inventory.filename), 'utf8'));
  assert.deepEqual(manifest, JSON.parse(originalBytes)); assert.equal(manifest.length, receipt.inventory.entries);
  for (const member of manifest) assert.ok(memberPath(member.path) && ['file', 'directory'].includes(member.kind)
    && Number.isSafeInteger(member.bytes) && member.bytes >= 0 && (member.kind === 'directory' ? member.bytes === 0 : /^[a-f0-9]{64}$/u.test(member.sha256)));
  const tree = await describeFile(mediaRoot), actual = [];
  assert.ok(tree.available && tree.kind === 'directory', 'The complete original disc tree is required.');
  const visit = (entries, prefix = '') => {
    for (const entry of entries) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      assert.ok(entry.available && memberPath(relative) && ['file', 'directory'].includes(entry.kind));
      actual.push({ path: relative, kind: entry.kind, bytes: entry.kind === 'file' ? entry.bytes : 0,
        ...(entry.kind === 'file' ? { sha256: entry.sha256 } : {}) });
      if (entry.kind === 'directory') visit(entry.entries, relative);
    }
  };
  visit(tree.entries); assert.deepEqual(order(actual), manifest, 'Every complete original disc member and byte must be present.');
  inputs.push({ filename: mediaRoot, sha256: tree.entriesSha256 });
  const bdmv = manifest.filter(member => member.kind === 'file' && member.path.startsWith('BDMV/'));
  assert.equal(bdmv.length, 14); assert.equal(receipt.completeFiles, 14);
  assert.equal(bdmv.reduce((sum, member) => sum + member.bytes, 0), 1592116024); assert.equal(receipt.completeBdmvBytes, 1592116024);
  for (const name of ['acquisition.json', 'original-members.json', 'bdmv-files.json', ...['archive-formats', 'iso-members', 'iso-test', 'iso-extract']
    .flatMap(name => [name + '.stdout.txt', name + '.stderr.txt'])]) await bind(path.join(evidence, name));
  const state = JSON.parse(await readFile(path.join(evidence, 'acquisition.json'), 'utf8'));
  assert.ok(state.passed === true && state.phase === 'complete' && state.sourceComplete === true && state.payloadComplete === true);
  assert.equal(state.processes.length, 4); assert.ok(state.processes.every(process => process.passed === true && process.code === 0));
  return { root, evidence, mediaRoot, discRoot: mediaRoot, filename, receipt, manifest, inputs };
}
