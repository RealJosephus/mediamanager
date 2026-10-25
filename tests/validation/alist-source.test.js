import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { alistBuildInputs, alistSourceInputs } from '../../tools/validation/alist-inputs.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('AList source offer retains all designated Go bytes and excludes the original Web UI', async () => {
  const { source, inputs } = await alistSourceInputs();
  const get = name => inputs.find(input => input.filename.endsWith(path.sep + name)).filename;
  const manifest = JSON.parse(await readFile(get('source-manifest.json')));
  assert.equal(manifest.files.length, 635);
  assert.equal(manifest.files.filter(file => file.tracked).length, 633);
  assert.deepEqual(manifest.files.filter(file => file.localModification).map(file => file.path).sort(), [
    'drivers/all.go', 'drivers/hf_aggregate/driver.go', 'drivers/hf_aggregate/meta.go',
  ]);
  assert.equal(manifest.originalFrontendExcluded, true);
  const archive = await readFile(get(source.sourceArchive.path));
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50, 'the deterministic source ZIP has an ordinary final directory');
  assert.equal(archive.readUInt16LE(end + 10), 635);
  let cursor = archive.readUInt32LE(end + 16);
  const remaining = new Map(manifest.files.map(file => [`alist-source/${file.path}`, file]));
  for (let index = 0; index < 635; index++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const method = archive.readUInt16LE(cursor + 10), compressed = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28), extraLength = archive.readUInt16LE(cursor + 30), commentLength = archive.readUInt16LE(cursor + 32);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const file = remaining.get(name);
    assert.ok(file, `unique sealed source member: ${name}`);
    assert.ok(!name.startsWith('alist-source/public/dist/'));
    assert.doesNotMatch(name, /(?:^|\/)(?:\.git|node_modules)\/|\.(?:ttf|woff2?)$/u);
    const local = archive.readUInt32LE(cursor + 42);
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    const data = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const packed = archive.subarray(data, data + compressed);
    assert.ok(method === 0 || method === 8);
    const bytes = method === 8 ? inflateRawSync(packed, { maxOutputLength: 8 * 1024 * 1024 }) : packed;
    assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256, name);
    remaining.delete(name);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, end); assert.equal(remaining.size, 0);
  const frontend = await readFile(get('index.html'), 'utf8');
  assert.match(frontend, /Web UI is not included or validated/u);
  assert.doesNotMatch(frontend, /<script|https?:|font-face/iu);
  assert.equal(source.webUiValidated, false); assert.equal(source.originalReleaseReproduced, false);
});

test('AList build provenance is opt-in and an absent promised build fails instead of falling back to an arbitrary binary', async () => {
  assert.deepEqual(await alistBuildInputs({ MEDIAMANAGER_ALIST_EXECUTABLE: '/unverified/alist' }), []);
  await assert.rejects(alistBuildInputs({ MEDIAMANAGER_CI_ALIST_REFERENCE: 'true' }), /requires its build root and executable path/u);
  await assert.rejects(alistBuildInputs({ MEDIAMANAGER_CI_ALIST_REFERENCE: 'true',
    MEDIAMANAGER_ALIST_BUILD_ROOT: 'relative', MEDIAMANAGER_ALIST_EXECUTABLE: 'alist' }), /requires its build root/u);
});

test('AList receipt rejects failure, another Actions run and escaped executable identities before starting a server', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-alist-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'receipts'));
  const { inputs } = await alistSourceInputs();
  const environment = { MEDIAMANAGER_CI_ALIST_REFERENCE: 'true', MEDIAMANAGER_ALIST_BUILD_ROOT: root,
    MEDIAMANAGER_ALIST_EXECUTABLE: path.join(root, 'runtime', 'alist'),
    GITHUB_SHA: 'candidate', GITHUB_RUN_ID: 'current-run', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'owner/repo' };
  const receipt = { kind: 'alist-api-only-test-host', status: 'failed', originalGoSourceUnchanged: true,
    webUiValidated: false, originalReleaseReproduced: false, goExpected: 'go1.23.1', goActual: 'go version go1.23.1 linux/amd64',
    package: { sha256: inputs[0].sha256 }, commit: 'candidate', runId: 'older-run', runAttempt: '1', repository: 'owner/repo' };
  const save = () => writeFile(path.join(root, 'receipts', 'build-receipt.json'), JSON.stringify(receipt));
  await save(); await assert.rejects(alistBuildInputs(environment), /does not prove/u);
  receipt.status = 'succeeded'; await save(); await assert.rejects(alistBuildInputs(environment), /not from this run: runId/u);
  receipt.runId = 'current-run'; receipt.executable = { path: '../outside-alist', sha256: hash('unverified'), bytes: 10 };
  await save(); await assert.rejects(alistBuildInputs(environment), /Invalid AList input member path/u);
});
