import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { platformHelperOutput, platformHelperPath, restorePlatformPackages } from '../../state-package-platform.js';

test('restore packages captured by all three runner platforms', async () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.ok(process.env.MEDIAMANAGER_STATE_PACKAGE_INPUTS);
  assert.ok(process.env.MEDIAMANAGER_STATE_PACKAGE_OUTPUT);
  const output = process.env.MEDIAMANAGER_STATE_PACKAGE_OUTPUT;
  const restored = await restorePlatformPackages(process.env.MEDIAMANAGER_STATE_PACKAGE_INPUTS, output);
  const uid = process.getuid?.() ?? null, executions = [];
  if (process.platform !== 'win32') {
    assert.notEqual(uid, 0);
    for (const result of restored.filter(value => value.source !== 'win32')) {
      const executable = path.join(result.destination, ...platformHelperPath);
      const child = spawnSync(executable, [], { encoding: 'utf8', shell: false, timeout: 5000 });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, platformHelperOutput);
      executions.push({ source: result.source, manifestSha256: result.producer.manifestSha256,
        exitCode: child.status, stdout: child.stdout });
    }
    assert.equal(executions.length, 2);
  }
  await writeFile(path.join(output, 'executable-receipt.json'), JSON.stringify({ head: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, target: process.platform, uid,
    executions }, null, 2) + '\n', { flag: 'wx' });
});
