import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { readInstanceConfiguration, inspectInstanceConfiguration } from '../../src/configuration.js';
import { createRuntime } from '../../src/runtime.js';
import { readConfigurationDocument } from '../../src/core/configuration-xml.js';
import { writeConfigurationFile } from '../../src/core/configuration-file.js';
import { readServerIdentity } from '../../src/core/server-identity.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { createStatePackage, restoreStatePackage } from '../../src/migration/state-package.js';
import { createInstanceFixture } from '../migration/instance-fixture.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { consumeServerIdentityFiles } from './server-identity-current.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];

const fixtureInput = JSON.parse(await fs.readFile(new URL('./fixtures/server-identity/current/input.json', import.meta.url)));
const serverIdCases = ['n-upper', 'd', 'b-spaces', 'x', 'utf16le', 'utf32be'];

test('postgres: native identity text survives runtime DTOs, exact binding, discovery, restart and complete state restoration', { skip: !postgresTestConnectionString }, async t => {
  const root = path.join(path.resolve(validationOutputRoot()), 'identity-runtime'); await fs.mkdir(root);
  const observations = [];
  for (const name of serverIdCases) await t.test(name, async t => {
    const sample = fixtureInput.find(row => row.name === name), instance = await createInstanceFixture(t, { prefix: 'identity-' + name + '-' });
    const filename = path.join(instance.root, 'data/data/device.txt'), bytes = Buffer.from(sample.bytes, 'base64'); await fs.writeFile(filename, bytes);
    const networkFile = path.join(instance.root, 'config', 'network.xml');
    const network = readConfigurationDocument(await fs.readFile(networkFile), 'network');
    await writeConfigurationFile(networkFile, 'network', { ...network.value,
      InternalHttpPort: 0, LocalNetworkAddresses: ['127.0.0.1'], AutoDiscovery: false, EnablePublishedServerUriByRequest: true }, { source: network.node });
    const settings = await inspectInstanceConfiguration(instance.root), state = await discoverInstanceState({ instanceRoot: instance.root });
    assert.equal(state.identity.serverId, settings.serverId); assert.deepEqual(await fs.readFile(filename), bytes);
    let database = await createPostgresTestDatabase(null, 'identity_runtime'), runtime;
    t.after(async () => { try { await runtime?.close(); } finally { await dropPostgresTestDatabase(database); } });
    const binding = { serverId: settings.serverId, originIdentityDigest: state.identity.digest };
    await database.writeInstanceBinding(binding); assert.deepEqual(await database.readInstanceBinding(), binding);
    runtime = await createRuntime({ database, ...await readInstanceConfiguration(instance.root) });
    await runtime.start();
    const origin = `http://127.0.0.1:${runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port}`;
    assert.equal((await (await fetch(origin + '/System/Info/Public')).json()).Id, settings.serverId);
    const user = await runtime.users.createUser({ Name: 'Identity user' }); assert.equal(runtime.users.getUserDto(await runtime.users.getUser(user.Id)).ServerId, settings.serverId);
    await runtime.close(); database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName });
    await database.validateInstanceBinding(binding);
    runtime = await createRuntime({ database, ...await readInstanceConfiguration(instance.root) });
    await runtime.start();
    assert.equal(runtime.users.getUserDto(await runtime.users.getUser(user.Id)).ServerId, settings.serverId); await runtime.close();
    const packageRoot = path.join(instance.directory, 'package'), restoredRoot = path.join(instance.directory, 'restored');
    const manifest = await createStatePackage(await instance.packageOptions({ destination: packageRoot }));
    assert.equal(manifest.instanceState.identity.serverId, settings.serverId);
    await restoreStatePackage(packageRoot, restoredRoot); assert.equal(await readServerIdentity(path.join(restoredRoot, 'data/data')), settings.serverId);
    assert.deepEqual(await fs.readFile(path.join(restoredRoot, 'data/data/device.txt')), bytes);
    assert.equal((await discoverInstanceState({ instanceRoot: restoredRoot })).identity.serverId, settings.serverId);
    const nativeRoot = path.join(root, name); await fs.mkdir(path.join(nativeRoot, 'data/data'), { recursive: true });
    await fs.writeFile(path.join(nativeRoot, 'data/data/device.txt'), await fs.readFile(path.join(restoredRoot, 'data/data/device.txt')));
    observations.push({ name, root: nativeRoot, filename: path.join(nativeRoot, 'data/data/device.txt'), serverId: settings.serverId,
      identityBytesSha256: createHash('sha256').update(bytes).digest('hex'), binding, restored: true });
  });
  const consumed = await consumeServerIdentityFiles(observations, path.join(root, 'restored-files'));
  await fs.writeFile(path.join(root, 'proof.json'), JSON.stringify({ observations, recording: consumed.recording, actualPostgres: true,
    runtimeRestart: true, completeStateRestored: true, actualNativeRead: true }, null, 2) + '\n', { flag: 'wx' });
});

test('fresh startup identity persists across independent loads while offline inspection never repairs an identity', async () => {
  const root = path.join(path.resolve(validationOutputRoot()), 'identity-fresh'); await fs.mkdir(root); await fs.mkdir(path.join(root, 'config'));
  const first = await readInstanceConfiguration(root), second = await readInstanceConfiguration(root);
  assert.match(first.serverId, /^[a-f0-9]{32}$/u); assert.equal(second.serverId, first.serverId);
  await writeConfigurationFile(path.join(root, 'config', 'network.xml'), 'network', first.networkConfiguration);
  const firstFile = path.join(root, 'first-device.txt'); await fs.copyFile(path.join(root, 'data/data/device.txt'), firstFile);
  const filename = path.join(root, 'data/data/device.txt'); const invalid = Buffer.from('invalid'); await fs.writeFile(filename, invalid);
  await assert.rejects(inspectInstanceConfiguration(root), /identity is invalid/u); assert.deepEqual(await fs.readFile(filename), invalid);
  const repaired = await readInstanceConfiguration(root); assert.notEqual(repaired.serverId, first.serverId); assert.equal((await inspectInstanceConfiguration(root)).serverId, repaired.serverId);
  await consumeServerIdentityFiles([{ name: 'fresh', filename: firstFile, serverId: first.serverId },
    { name: 'repaired', filename, serverId: repaired.serverId }], path.join(root, 'native-consumer'));
});
