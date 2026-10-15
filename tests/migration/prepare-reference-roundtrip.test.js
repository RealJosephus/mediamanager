import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tool = path.resolve('tools/database/prepare-reference-roundtrip.js');

test('reference roundtrip tool requires an explicit portable media mount contract', () => {
  const result = spawnSync(process.execPath, [tool, 'source', 'work', 'destination'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, MEDIAMANAGER_TEST_POSTGRES: 'postgresql://unused.invalid/database' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PORTABLE_MOUNT_CONTRACT_JSON/u);
});

test('reference roundtrip uses only the caller-supplied media contract for the pinned instance', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE,
  timeout: 120_000,
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-prepare-reference-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseline = path.join(directory, 'baseline');
  const work = path.join(directory, 'work');
  const restored = path.join(directory, 'restored');
  const contractFilename = path.join(directory, 'mount-contract.json');
  await mkdir(baseline);
  await writeFile(path.join(baseline, 'manifest.json'), JSON.stringify({
    head: 'pinned-test-head',
    contentDigest: 'a'.repeat(64),
  }));
  const contract = {
    mounts: [{
      mountId: 'synthetic-media',
      identityRoot: 'Z:\\SyntheticMedia',
      accessRoot: '/media',
      pathStyle: 'windows',
      caseSensitive: false,
      returnPolicy: 'required',
    }],
  };
  await writeFile(contractFilename, JSON.stringify(contract));

  const result = spawnSync(process.execPath, [tool,
    process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE, work, restored, contractFilename], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 110_000,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      MEDIAMANAGER_VALIDATION_JELLYFIN_ROOT: baseline,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(await readFile(path.join(work, 'report.json'), 'utf8'));
  assert.deepEqual(report.mountIds, ['synthetic-media']);
  const manifest = JSON.parse(await readFile(path.join(work, 'package', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.database.portableMountContract, contract);
  assert.equal(manifest.database.portableMountContract.mounts.some(mount => mount.mountId === 'instance-state'), false);
  assert.equal(manifest.database.pathProjection.auditedPaths > 0, true);
});
