import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { startProductionInstance } from '../../src/main.js';
import { transferDatabase } from '../../src/migration/database-transfer.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { runPublishTargetCli } from '../../tools/publish-target.js';
import { currentNativeSqliteInputs } from '../../tools/validation/current-native-sqlite-inputs.js';
import { validationExecutable } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres', 'currentNativeSqlite'];

test('publishing a target rejects a Local mount that startup cannot instantiate', { timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-target-'));
  const instance = path.join(root, 'instance'), sourceFile = path.join(root, 'source.db');
  const current = path.join(root, 'current.json'), proposal = path.join(root, 'proposal.json');
  const good = path.join(root, 'usable.json'), bad = path.join(root, 'read-only.json');
  const media = path.join(root, 'media'), serverId = '4'.repeat(32);
  let source, db, app;
  try {
    for (const name of ['config', 'data/data', 'cache', 'log', 'data/metadata']) await mkdir(path.join(instance, name), { recursive: true });
    await mkdir(media);
    await writeFile(path.join(instance, 'data/data/device.txt'), serverId);
    await writeFile(path.join(instance, 'config/system.xml'), '<ServerConfiguration><IsStartupWizardCompleted>true</IsStartupWizardCompleted></ServerConfiguration>');
    await writeFile(path.join(instance, 'config/network.xml'), '<NetworkConfiguration><InternalHttpPort>0</InternalHttpPort><AutoDiscovery>false</AutoDiscovery></NetworkConfiguration>');
    const native = await currentNativeSqliteInputs();
    await copyFile(native.filename, sourceFile);
    source = new SqliteDatabase(sourceFile, { requireMigrationHistory: true });
    await source.snapshot(path.join(instance, 'data/data/jellyfin.db'));
    const state = await discoverInstanceState({ instanceRoot: instance });
    db = await createPostgresTestDatabase(null, 'target_capability');
    await transferDatabase(source, db, { instanceBinding: { serverId, originIdentityDigest: state.identity.digest }, portableMountContract: { mounts: [] } });
    const environment = { ...process.env, REVIEW_DATABASE: process.env.MEDIAMANAGER_TEST_POSTGRES, JELLYFIN_FFMPEG: validationExecutable('ffmpeg') };
    for (const key of ['MEDIAMANAGER_TARGET', 'MEDIAMANAGER_DATABASE', 'MEDIAMANAGER_POSTGRES', 'MEDIAMANAGER_POSTGRES_SCHEMA', 'MEDIAMANAGER_INSTANCE', 'MEDIAMANAGER_STORAGE']) delete environment[key];
    const configuration = { instances: [{ id: 'local-media', type: 'local', config: { root: media, writable: false } }],
      mounts: [{ path: '/media', instanceId: 'local-media', capabilities: {} }], prefixes: [] };
    await writeFile(good, JSON.stringify(configuration));
    configuration.mounts[0].capabilities.create = true;
    await writeFile(bad, JSON.stringify(configuration));
    const publish = async storageConfigurationPath => {
      await writeFile(proposal, JSON.stringify({ instancePath: instance, postgresSchema: db.schemaName, postgresUrlEnvironment: 'REVIEW_DATABASE', storageConfigurationPath }));
      return runPublishTargetCli(['--source', proposal, '--output', current], { environment, stdout: { write() {} }, stderr: { write() {} } });
    };
    assert.equal(await publish(good), 0);
    const previous = await readFile(current, 'utf8');
    const exit = await publish(bad);
    const selection = await readFile(current, 'utf8');
    let error;
    try { app = await startProductionInstance({ environment: { ...environment, MEDIAMANAGER_TARGET: proposal } }); }
    catch (failure) { error = failure.message; }
    t.diagnostic('AUDIT target-capabilities ' + JSON.stringify({ publishExit: exit, previousSelectionPreserved: selection === previous,
      publishedStorage: path.basename(JSON.parse(selection).storageConfigurationPath), coldStartError: error }));
    assert.match(error ?? '', /capability create cannot exceed/i);
    assert.equal(exit, 1, 'The publisher must reject a storage definition that the same cold runtime rejects');
    assert.equal(selection, previous);
  } finally {
    try { await app?.close(); } finally {
      try { source?.close(); } finally { try { await dropPostgresTestDatabase(db); } finally { await rm(root, { recursive: true, force: true }); } }
    }
  }
});
