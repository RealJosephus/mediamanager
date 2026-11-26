import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pinnedNativeSqliteMigrationHistory } from '../../src/database/native-envelope.js';
import { installNativeEnvelopeSchema } from '../../src/database/native-envelope-sqlite.js';
import { canonicalNativeSqliteSchema } from '../../src/database/sqlite-schema.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { startProductionInstance } from '../../src/main.js';
import { importJellyfinSqlite } from '../database/import-jellyfin.js';

// Run from the relocated, offline-installed delivery on an isolated CI database.
const instance = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'release-health-'));
const serverId = randomUUID().replaceAll('-', ''), schema = 'health_' + serverId;
for (const directory of ['config', 'data/data', 'data/metadata', 'cache', 'log']) await mkdir(path.join(instance, directory), { recursive: true });
await writeFile(path.join(instance, 'data/data/device.txt'), serverId);
await writeFile(path.join(instance, 'config/system.xml'), '<ServerConfiguration><UICulture>en-US</UICulture></ServerConfiguration>');
await writeFile(path.join(instance, 'config/network.xml'), '<NetworkConfiguration><InternalHttpPort>0</InternalHttpPort><AutoDiscovery>false</AutoDiscovery><LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses></NetworkConfiguration>');
const filename = path.join(instance, 'data/data/jellyfin.db');
const sqlite = new DatabaseSync(filename);
try {
  installNativeEnvelopeSchema(sqlite, canonicalNativeSqliteSchema().ddl);
  const insert = sqlite.prepare('INSERT INTO __EFMigrationsHistory VALUES(?,?)');
  for (const row of pinnedNativeSqliteMigrationHistory) insert.run(row.MigrationId, row.ProductVersion);
} finally { sqlite.close(); }
const { identity } = await discoverInstanceState({ instanceRoot: instance });
const binding = path.join(instance, 'binding.json'), mounts = path.join(instance, 'mounts.json');
await writeFile(binding, JSON.stringify({ serverId, originIdentityDigest: identity.digest }));
await writeFile(mounts, '{"mounts":[]}');
await importJellyfinSqlite(['--source', filename, '--instance-binding', binding, '--mount-contract', mounts,
  '--schema', schema, '--postgres-url-env', 'MEDIAMANAGER_TEST_POSTGRES']);
const app = await startProductionInstance({ environment: { ...process.env, MEDIAMANAGER_INSTANCE: instance,
  MEDIAMANAGER_POSTGRES: process.env.MEDIAMANAGER_TEST_POSTGRES, MEDIAMANAGER_POSTGRES_SCHEMA: schema,
  JELLYFIN_FFMPEG: process.env.MEDIAMANAGER_FFMPEG } });
try {
  const { port } = app.networkHost.listeners.find(listener => listener.scheme === 'http');
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(10000) });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.equal(body, 'Healthy');
  const { candidate } = JSON.parse(await readFile(new URL('../../release.json', import.meta.url)));
  assert.equal(candidate.commit, process.env.GITHUB_SHA);
  await writeFile(new URL('../../.test-output/health-receipt.json', import.meta.url),
    JSON.stringify({ candidate, platform: process.platform, status: response.status, body }) + '\n', { flag: 'wx' });
} finally { await app.close(); }
