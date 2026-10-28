import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';

const tool = path.resolve('tools/database/prepare-reference-roundtrip.js');

test('reference roundtrip tool requires explicit media contract and baseline manifest before reading inputs', () => {
  for (const args of [['source', 'work', 'destination'], ['source', 'work', 'destination', 'missing-contract.json']]) {
    const result = spawnSync(process.execPath, [tool, ...args], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, MEDIAMANAGER_TEST_POSTGRES: 'postgresql://unused.invalid/database' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PORTABLE_MOUNT_CONTRACT_JSON BASELINE_MANIFEST_JSON/u);
  }
});

test('reference roundtrip preserves the caller-supplied media contract and baseline for the pinned instance', {
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
  const baselineFilename = path.join(baseline, 'manifest.json'), baselineIdentity = {
    head: 'pinned-test-head',
    contentDigest: 'a'.repeat(64),
  };
  const baselineBytes = Buffer.from(JSON.stringify(baselineIdentity, null, 2) + '\n');
  await writeFile(baselineFilename, baselineBytes);
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
    process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE, work, restored, contractFilename, baselineFilename], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 110_000,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(await readFile(path.join(work, 'report.json'), 'utf8'));
  assert.deepEqual(report.mountIds, ['synthetic-media']);
  const manifest = JSON.parse(await readFile(path.join(work, 'package', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.baseline, baselineIdentity);
  assert.deepEqual(await readFile(baselineFilename), baselineBytes, 'The caller-owned baseline bytes remain unchanged.');
  assert.deepEqual(manifest.database.portableMountContract, contract);
  assert.equal(manifest.database.portableMountContract.mounts.some(mount => mount.mountId === 'instance-state'), false);
  assert.equal(manifest.database.pathProjection.auditedPaths > 0, true);
  const state = await discoverInstanceState({ instanceRoot: restored });
  assert.equal(state.identity.digest, report.restoredIdentityDigest);
  const sqlite = new SqliteDatabase(state.paths.sqlite, { readOnly: true, requireMigrationHistory: true });
  try {
    const [activity] = sqlite.rows('ActivityLogs', { where: { Id: report.mutation.id } });
    assert.equal(activity.Name, 'Edited current Node PostgreSQL state');
    assert.equal(activity.ShortOverview, '中文 / current state');
    assert.equal(BigInt(activity.RowVersion), 1n);
  } finally { sqlite.close(); }
});
