import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import source from '../ci/disc-reference/source.json' with { type: 'json' };
import { describeFile, sha256 } from './inventory.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const safeMember = value => typeof value === 'string' && value && !/[\\:\r\n\0]/u.test(value)
  && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');

/** A fresh complete original DVD supply; a receipt alone is never media. */
export async function dvdReferenceInputs(environment = process.env) {
  assert.equal(environment.GITHUB_ACTIONS, 'true', 'The original DVD service requires a same-run Actions acquisition.');
  assert.equal(environment.MEDIAMANAGER_CI_DVD_REFERENCE, 'true', 'Enable complete original DVD provisioning explicitly.');
  assert.ok(environment.RUNNER_TEMP && environment.MEDIAMANAGER_TEST_DVD_REFERENCE, 'Supply the complete original DVD receipt and payload.');
  const root = path.join(await realpath(environment.RUNNER_TEMP), 'mediamanager-disc-reference');
  const evidence = path.join(root, 'evidence'), media = path.join(root, 'media'), filename = path.join(evidence, 'receipt.json');
  assert.equal(path.resolve(environment.MEDIAMANAGER_TEST_DVD_REFERENCE), filename,
    'The DVD service must use the original image acquired in this job.');
  const inputs = [];
  const bind = async (filename, expected, bytes) => {
    const actual = await describeFile(filename);
    assert.ok(actual.available && actual.kind === 'file' && (expected === undefined || actual.sha256 === expected)
      && (bytes === undefined || actual.bytes === bytes), `Original DVD input is missing or changed: ${filename}`);
    inputs.push({ filename, sha256: actual.sha256 }); return actual;
  };
  await bind(filename);
  const receipt = JSON.parse(await readFile(filename, 'utf8'));
  const original = source.variants[receipt.variant];
  assert.ok(receipt.schemaVersion === 1 && receipt.complete === true && receipt.format === source.format
    && receipt.variant === 'ntsc' && original && receipt.mediaRoot === media && receipt.videoDirectory === source.videoDirectory,
  'The original DVD service requires the complete fixed NTSC input, not a substitute or empty directory.');
  for (const [key, value] of Object.entries(original)) assert.equal(receipt.source?.[key], value, `Original source ${key}`);
  assert.equal(receipt.source.license, source.license); assert.equal(receipt.source.attribution, source.attribution);
  assert.ok(receipt.download?.complete === true && receipt.download.bytes === original.bytes
    && receipt.download.sha1 === original.sha1 && receipt.download.md5 === original.md5 && receipt.download.sha256 === original.sha256);
  assert.ok(receipt.acceptance?.realOriginalDvdAcquired === true && receipt.acceptance.actualProbe === false
    && receipt.acceptance.actualScan === false && receipt.acceptance.databaseExchange === false && receipt.acceptance.releaseAcceptance === false);
  const identity = receipt.producer?.identity;
  for (const name of ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
    'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'GITHUB_JOB', 'RUNNER_OS', 'RUNNER_ARCH']) {
    assert.ok(environment[name]); assert.equal(identity?.[name], environment[name], `DVD acquisition ${name}`);
  }
  assert.equal(receipt.producer.checkout.head, environment.GITHUB_SHA);
  assert.match(receipt.producer.checkout.tree, /^[a-f0-9]{40}$/u);
  const sourceDescriptor = 'tools/ci/disc-reference/source.json';
  const expectedProducer = ['tools/ci/disc-reference/acquire.js', 'tools/ci/disc-reference/http-source.js', sourceDescriptor,
    '.github/workflows/disc-reference.yml', '.github/workflows/ci.yml'];
  assert.deepEqual(receipt.producer.files.map(file => file.path), expectedProducer);
  for (const file of receipt.producer.files) await bind(path.join(repository, file.path), file.sha256, file.bytes);
  await bind(receipt.producer.node.filename, receipt.producer.node.sha256, receipt.producer.node.bytes);
  assert.ok(typeof receipt.producer.node.version === 'string' && receipt.producer.node.version);
  await bind(receipt.archiveTool.filename, receipt.archiveTool.sha256, receipt.archiveTool.bytes);
  await bind(path.join(evidence, 'source.json'), receipt.source.descriptorSha256);
  assert.equal(receipt.source.descriptorSha256, sha256(await readFile(path.join(repository, sourceDescriptor))));
  await bind(path.join(evidence, 'archive-metadata.json'), receipt.metadata.sha256, receipt.metadata.bytes);
  assert.equal(receipt.inventory.filename, 'media-inventory.json');
  assert.equal(receipt.inventory.sha256, original.videoTsInventorySha256);
  assert.equal(receipt.inventory.entries, original.videoTsEntries);
  assert.equal(receipt.members.selectedBytes, original.videoTsBytes);
  await bind(path.join(evidence, receipt.inventory.filename), receipt.inventory.sha256, receipt.inventory.bytes);
  const manifest = JSON.parse(await readFile(path.join(evidence, receipt.inventory.filename), 'utf8'));
  const members = JSON.parse(await readFile(path.join(evidence, 'video-ts-members.json'), 'utf8'));
  assert.ok(Array.isArray(manifest) && manifest.length > 0 && manifest.length === receipt.inventory.entries);
  assert.deepEqual(manifest.map(({ path, type, bytes }) => ({ path, type, bytes })),
    members.map(({ path, type, bytes }) => ({ path, type, bytes: type === 'directory' ? 0 : bytes })));
  assert.equal(manifest.filter(member => member.type === 'file').reduce((sum, member) => sum + member.bytes, 0), receipt.members.selectedBytes);
  assert.ok(receipt.members.selectedBytes > 0 && receipt.members.selectedBytes <= original.bytes);
  const files = new Set(manifest.filter(member => member.type === 'file').map(member => member.path));
  assert.ok(files.has(source.videoDirectory + '/VIDEO_TS.IFO') && files.has(source.videoDirectory + '/VIDEO_TS.BUP')
    && [...files].some(value => /\/VTS_\d{2}_0\.IFO$/u.test(value)) && [...files].some(value => /\.VOB$/u.test(value)));
  const expected = new Map();
  for (const member of manifest) {
    assert.ok(safeMember(member.path) && (member.path === source.videoDirectory || member.path.startsWith(source.videoDirectory + '/'))
      && ['file', 'directory'].includes(member.type) && Number.isSafeInteger(member.bytes) && member.bytes >= 0
      && (member.type === 'directory' ? member.bytes === 0 : digest(member.sha256)));
    assert.ok(!expected.has(member.path.toLowerCase()), 'Original VIDEO_TS members must be unique on every platform.');
    expected.set(member.path.toLowerCase(), member);
  }
  const tree = await describeFile(media);
  assert.ok(tree.available && tree.kind === 'directory', 'The complete original DVD payload is required.');
  const actual = [];
  const visit = (entries, parent = '') => {
    for (const member of entries) {
      const relative = parent ? parent + '/' + member.name : member.name;
      assert.ok(member.available && ['directory', 'file'].includes(member.kind) && safeMember(relative));
      actual.push({ path: relative, type: member.kind, bytes: member.kind === 'file' ? member.bytes : 0,
        ...(member.kind === 'file' ? { sha256: member.sha256 } : {}) });
      if (member.kind === 'directory') visit(member.entries, relative);
    }
  };
  visit(tree.entries);
  const order = values => values.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.deepEqual(order(actual), order(manifest), 'The service must bind every complete original VIDEO_TS file and directory.');
  inputs.push({ filename: media, sha256: tree.entriesSha256 });
  for (const name of ['acquisition.json', 'iso-members.json', 'video-ts-members.json', 'archive-version.stdout.txt',
    'archive-version.stderr.txt', 'iso-members.stdout.txt', 'iso-members.stderr.txt', 'iso-members-detailed.stdout.txt',
    'iso-members-detailed.stderr.txt', 'extract-video-ts.stdout.txt', 'extract-video-ts.stderr.txt']) await bind(path.join(evidence, name));
  const state = JSON.parse(await readFile(path.join(evidence, 'acquisition.json'), 'utf8'));
  assert.ok(state.passed === true && state.phase === 'complete' && state.sourceComplete === true && state.payloadComplete === true);
  assert.ok(state.processes.length === 4 && state.processes.every(process => process.passed === true && process.exitCode === 0));
  return { root, evidence, mediaRoot: media, filename, receipt, manifest, inputs };
}
