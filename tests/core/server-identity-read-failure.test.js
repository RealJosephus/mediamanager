import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { readInstanceConfiguration } from '../../src/configuration.js';
import { ServerIdentity } from '../../src/core/server-identity.js';
import { startProductionInstance } from '../../src/main.js';
import { createPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

export const requiredValidationServices = ['postgres'];

test('a transient read failure preserves the identity bound to the production database', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-bound-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataPath = path.join(root, 'data', 'data'), filename = path.join(dataPath, 'device.txt');
  const serverId = 'E5900000-0000-0000-0000-000000000001', original = Buffer.from('\ufeff' + serverId);
  await fs.mkdir(dataPath, { recursive: true });
  await fs.writeFile(filename, original);
  const database = await createPostgresTestDatabase(t, 'identity_read');
  const binding = { serverId, originIdentityDigest: 'a'.repeat(64) };
  await database.writeInstanceBinding(binding);

  const failure = Object.assign(new Error('Transient device.txt read failure'), { code: 'EIO' });
  const diagnostics = [];
  await new ServerIdentity({ dataPath, fileSystem: { ...fs, readFile: async () => { throw failure; } },
    onError: error => diagnostics.push(error) }).getValue();
  assert.deepEqual(diagnostics, [failure]);
  assert.deepEqual(await fs.readFile(filename), original);

  const originalRead = fs.readFile;
  let unavailable = true;
  const readMock = t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file === filename && unavailable) {
      unavailable = false;
      throw failure;
    }
    return originalRead(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(startProductionInstance({ environment: { MEDIAMANAGER_INSTANCE: root,
      MEDIAMANAGER_POSTGRES: postgresTestConnectionString, MEDIAMANAGER_POSTGRES_SCHEMA: database.schemaName } }),
    error => error === failure);
  } finally {
    readMock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(unavailable, false);
  assert.deepEqual(await fs.readFile(filename), original);
  const settings = await readInstanceConfiguration(root, { requireExistingIdentity: true });
  await database.validateInstanceBinding({ ...binding, serverId: settings.serverId });
});
