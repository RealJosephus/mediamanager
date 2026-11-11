import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePlatformPackage } from '../../state-package-platform.js';

test('capture the actual runner platform state package', async t => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.ok(process.env.MEDIAMANAGER_STATE_PACKAGE_OUTPUT);
  await capturePlatformPackage(t, process.env.MEDIAMANAGER_STATE_PACKAGE_OUTPUT);
});
