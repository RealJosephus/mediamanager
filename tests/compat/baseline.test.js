import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureBaseline } from '../../tools/compat/capture-baseline.js';
import { verifyBaseline } from '../../tools/compat/verify-baseline.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-baseline-control-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^mediamanager-baseline-control-/u);
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source');
  await mkdir(source);
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { stdio: 'pipe' });
  git('init', '--quiet');
  await writeFile(path.join(source, 'original.txt'), 'original');
  await writeFile(path.join(source, 'deleted.txt'), 'deleted later');
  git('add', '.');
  git('-c', 'user.name=BaselineControl', '-c', 'user.email=baseline@example.invalid', 'commit', '--quiet', '-m', 'Reference fixture');
  await unlink(path.join(source, 'deleted.txt'));
  await writeFile(path.join(source, 'original.txt'), 'local modification');
  await writeFile(path.join(source, 'untracked.txt'), 'untracked source');
  const destination = path.join(root, 'capture');
  const manifest = await captureBaseline(source, destination);
  return { source, git, manifest, manifestPath: path.join(destination, 'manifest.json') };
}

test('baseline verification binds local modifications, untracked source and deleted files', async t => {
  const item = await fixture(t);
  const result = await verifyBaseline(item.manifestPath);
  assert.equal(result.verifiedFiles, 3);
  assert.equal(result.head, item.manifest.head);
  assert.equal(result.contentDigest, item.manifest.contentDigest);
});

test('baseline CLI requires explicit inputs before writing and captures/verifies the supplied checkout', async t => {
  const item = await fixture(t);
  const directory = path.dirname(item.source);
  const captureScript = fileURLToPath(new URL('../../tools/compat/capture-baseline.js', import.meta.url));
  const verifyScript = fileURLToPath(new URL('../../tools/compat/verify-baseline.js', import.meta.url));
  const invoke = (script, ...args) => execFileSync(process.execPath, [script, ...args], {
    cwd: directory, stdio: 'pipe', encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  const before = await readdir(directory);
  for (const [script, args] of [[captureScript, []], [captureScript, [item.source]], [verifyScript, []]]) {
    assert.throws(() => invoke(script, ...args), error => {
      assert.equal(error.status, 1); assert.match(error.stderr, /Usage: node tools\/compat\//u); return true;
    });
  }
  assert.deepEqual(await readdir(directory), before);
  const destination = path.join(directory, 'explicit-capture');
  const captured = JSON.parse(invoke(captureScript, item.source, destination));
  const verified = JSON.parse(invoke(verifyScript, path.join(destination, 'manifest.json')));
  assert.equal(verified.source, item.source);
  assert.equal(verified.head, captured.head);
  assert.equal(verified.contentDigest, captured.contentDigest);
  assert.equal(verified.verifiedFiles, 3);
});

test('baseline verification detects changed bytes even when Git status remains modified', async t => {
  const item = await fixture(t);
  await writeFile(path.join(item.source, 'original.txt'), 'second local modification');
  await assert.rejects(verifyBaseline(item.manifestPath), /Reference file changed/u);
});

test('baseline verification detects HEAD changes with the same dirty working tree', async t => {
  const item = await fixture(t);
  item.git('-c', 'user.name=BaselineControl', '-c', 'user.email=baseline@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'Different HEAD');
  await assert.rejects(verifyBaseline(item.manifestPath), /HEAD changed/u);
});

test('baseline verification rejects deleted file resurrection and newly discovered files', async t => {
  const item = await fixture(t);
  await writeFile(path.join(item.source, 'deleted.txt'), 'resurrected');
  await assert.rejects(verifyBaseline(item.manifestPath), /Git status changed/u);
  await unlink(path.join(item.source, 'deleted.txt'));
  await writeFile(path.join(item.source, 'new.txt'), 'newly discovered');
  await assert.rejects(verifyBaseline(item.manifestPath), /Git status changed/u);
});

test('baseline verification rejects rewritten manifests and missing discovery records', async t => {
  const item = await fixture(t);
  const manifest = JSON.parse(await readFile(item.manifestPath, 'utf8'));
  manifest.files.find(file => !file.deleted).sha256 = '0'.repeat(64);
  await writeFile(item.manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyBaseline(item.manifestPath), /aggregate digest changed/u);
  const omitted = structuredClone(item.manifest);
  omitted.files.pop();
  omitted.contentDigest = createHash('sha256').update(omitted.files.map(file => `${file.path}\t${file.deleted ? 'DELETED' : file.sha256}\n`).join('')).digest('hex');
  await writeFile(item.manifestPath, JSON.stringify(omitted));
  await assert.rejects(verifyBaseline(item.manifestPath), /file discovery changed/u);
});

test('baseline verification rejects unsafe source paths before reading them', async t => {
  const item = await fixture(t);
  item.manifest.files[0].path = '../outside.txt';
  await writeFile(item.manifestPath, JSON.stringify(item.manifest));
  await assert.rejects(verifyBaseline(item.manifestPath), /Invalid reference baseline file path/u);
});

test('baseline capture rejects source descendants whose names merely begin with two dots', async t => {
  const item = await fixture(t);
  const destination = path.join(item.source, '..capture');
  await assert.rejects(captureBaseline(item.source, destination), /outside the reference checkout/u);
});

test('baseline capture resolves an existing junction or symlink ancestor before accepting its destination', async t => {
  const item = await fixture(t);
  const alias = path.join(path.dirname(item.source), 'source-alias');
  await symlink(item.source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(captureBaseline(item.source, path.join(alias, 'capture')), /outside the reference checkout/u);
});

test('baseline capture rejects a HEAD change after its initial source identity was read', async t => {
  const item = await fixture(t);
  const destination = path.join(path.dirname(item.source), 'capture-after-head-change');
  const capture = captureBaseline(item.source, destination);
  item.git('-c', 'user.name=BaselineControl', '-c', 'user.email=baseline@example.invalid',
    'commit', '--allow-empty', '--quiet', '-m', 'Concurrent HEAD change');
  await assert.rejects(capture, /HEAD changed during capture/u);
});
