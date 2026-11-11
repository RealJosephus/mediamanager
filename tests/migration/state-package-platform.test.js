import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { capturePlatformPackage, restorePlatformPackages } from './state-package-platform.js';

test('platform package roundtrip checks complete state and literal destination paths', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'state-package-platform-roundtrip-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true }); });
  await capturePlatformPackage(t, path.join(root, 'inputs', process.platform));
  await restorePlatformPackages(path.join(root, 'inputs'), path.join(root, 'restored'), [process.platform]);
});
