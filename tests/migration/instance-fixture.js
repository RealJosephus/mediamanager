import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { createIsolatedOfflineCopyCaptureSession } from '../../src/migration/capture-session.js';

const serverId = '0123456789abcdef0123456789abcdef';

export async function createInstanceFixture(t, {
  prefix = 'mediamanager-instance-',
  systemXml = '<ServerConfiguration><UICulture>zh-CN</UICulture></ServerConfiguration>',
  baseline = 'isolated-fixture',
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(directory, 'instance');
  for (const relative of ['data/data', 'data/metadata', 'config', 'cache', 'log']) {
    await mkdir(path.join(root, relative), { recursive: true });
  }
  await writeFile(path.join(root, 'config/system.xml'), systemXml);
  await writeFile(path.join(root, 'config/network.xml'), '<NetworkConfiguration><EnableIPv4>true</EnableIPv4></NetworkConfiguration>');
  await writeFile(path.join(root, 'data/data/device.txt'), serverId);
  const database = new SqliteDatabase(path.join(root, 'data/data/jellyfin.db'), { create: true });
  t.after(async () => {
    database.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    await rm(directory, { recursive: true, force: true });
  });
  const packageOptions = async (extra = {}) => {
    const instanceState = await discoverInstanceState({ instanceRoot: root });
    const captureSession = createIsolatedOfflineCopyCaptureSession({
      instanceState,
      ownerId: `${prefix}${path.basename(directory)}`,
      assertHeld: () => database.preflight(),
    });
    return {
      database,
      instanceState,
      captureSession,
      baseline,
      testOnlyAllowSyntheticEnvelope: true,
      ...extra,
    };
  };
  return { directory, root, database, packageOptions };
}
