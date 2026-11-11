import test from 'node:test';
import assert from 'node:assert/strict';
import { restorePlatformPackages } from '../../state-package-platform.js';

test('restore packages captured by all three runner platforms', async () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.ok(process.env.MEDIAMANAGER_STATE_PACKAGE_INPUTS);
  assert.ok(process.env.MEDIAMANAGER_STATE_PACKAGE_OUTPUT);
  await restorePlatformPackages(process.env.MEDIAMANAGER_STATE_PACKAGE_INPUTS, process.env.MEDIAMANAGER_STATE_PACKAGE_OUTPUT);
});
