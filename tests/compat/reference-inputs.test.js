import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertFreshReferenceOutput, captureReferenceInput, verifyReferenceInput } from '../../tools/compat/reference-inputs.js';

test('reference copy rejects overlapping and redirected outputs before any write', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reference-guard-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'reference-guard-outside-'));
  const environment = { MEDIAMANAGER_VALIDATION_OUTPUT_ROOT: root };
  const check = destination => assertFreshReferenceOutput(destination, [source], environment);
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.equal(path.dirname(outside), os.tmpdir());
    await rm(root, { recursive: true }); await rm(outside, { recursive: true });
  });
  const source = path.join(root, 'input'); await mkdir(source);
  await writeFile(path.join(source, 'original'), 'unchanged');
  assert.throws(() => check(path.join(source, 'new')), /overlap/u);
  await symlink(source, path.join(root, 'source-junction'), 'junction');
  assert.throws(() => check(path.join(root, 'source-junction/new')), /overlap/u);
  await symlink(outside, path.join(root, 'outside-junction'), 'junction');
  assert.throws(() => check(path.join(root, 'outside-junction/new')), /cannot escape/u);
  assert.throws(() => assertFreshReferenceOutput(root, [], environment), /child/u);
  assert.throws(() => check(path.join(outside, 'new')), /child/u);
  assert.throws(() => check(source), /overlap/u);
  const existing = path.join(root, 'already-exists'); await mkdir(existing);
  assert.throws(() => check(existing), /already exists/u);
  assert.throws(() => assertFreshReferenceOutput(path.join(root, 'protected/new'), [], {
    ...environment, MEDIAMANAGER_VALIDATION_INPUT_ROOT: path.join(root, 'protected')
  }), /outside reference/u);
  check(path.join(root, 'absent-parent/separate-output'));
  assert.equal(await readFile(path.join(source, 'original'), 'utf8'), 'unchanged');
});

test('reference copy detects content changes despite restored modification time and detects file discovery changes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reference-identity-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true }); });
  const filename = path.join(root, 'input'); await writeFile(filename, 'first');
  const before = await captureReferenceInput(root);
  await verifyReferenceInput(root, before);
  await writeFile(filename, 'other'); await utimes(filename, new Date('2000-01-01Z'), new Date('2000-01-01Z'));
  await assert.rejects(verifyReferenceInput(root, before), /contents/u);
  await writeFile(filename, 'first');
  await verifyReferenceInput(root, before);
  await writeFile(path.join(root, 'new-input'), 'new');
  await assert.rejects(verifyReferenceInput(root, before), /discovery/u);
});
