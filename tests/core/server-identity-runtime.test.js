import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { readInstanceConfiguration, inspectInstanceConfiguration } from '../../src/configuration.js';
import { createRuntime } from '../../src/runtime.js';
import { readServerIdentity } from '../../src/core/server-identity.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { createStatePackage, restoreStatePackage } from '../../src/migration/state-package.js';
import { createInstanceFixture } from '../migration/instance-fixture.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { recordOracle } from '../../tools/validation/oracle.js';

const fixtureInput = JSON.parse(await fs.readFile(new URL('./fixtures/server-identity/input.json', import.meta.url)));
const serverIdCases = ['n-upper', 'd', 'b-spaces', 'x', 'utf16le', 'utf32be'];

test('postgres: native identity text survives runtime DTOs, exact binding, discovery, restart and complete state restoration', { skip: !postgresTestConnectionString }, async t => {
  const root = path.join(path.resolve(validationOutputRoot()), 'identity-runtime'); await fs.mkdir(root);
  const observations = [];
  for (const name of serverIdCases) await t.test(name, async t => {
    const sample = fixtureInput.find(row => row.name === name), instance = await createInstanceFixture(t, { prefix: 'identity-' + name + '-' });
    const filename = path.join(instance.root, 'data/data/device.txt'), bytes = Buffer.from(sample.bytes, 'base64'); await fs.writeFile(filename, bytes);
    const settings = await inspectInstanceConfiguration(instance.root), state = await discoverInstanceState({ instanceRoot: instance.root });
    assert.equal(state.identity.serverId, settings.serverId); assert.deepEqual(await fs.readFile(filename), bytes);
    let database = await createPostgresTestDatabase(null, 'identity_runtime'), runtime;
    t.after(async () => { try { await runtime?.close(); } finally { await dropPostgresTestDatabase(database); } });
    const binding = { serverId: settings.serverId, originIdentityDigest: state.identity.digest };
    await database.writeInstanceBinding(binding); assert.deepEqual(await database.readInstanceBinding(), binding);
    runtime = await createRuntime({ database, ...await readInstanceConfiguration(instance.root) });
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    assert.equal((await (await fetch(origin + '/System/Info/Public')).json()).Id, settings.serverId);
    const user = await runtime.users.createUser({ Name: 'Identity user' }); assert.equal(runtime.users.getUserDto(user).ServerId, settings.serverId);
    await runtime.close(); database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema: database.schemaName });
    await database.validateInstanceBinding(binding);
    runtime = await createRuntime({ database, ...await readInstanceConfiguration(instance.root) });
    assert.equal(runtime.users.getUserDto(await runtime.users.getUser(user.Id)).ServerId, settings.serverId); await runtime.close();
    const packageRoot = path.join(instance.directory, 'package'), restoredRoot = path.join(instance.directory, 'restored');
    const manifest = await createStatePackage(await instance.packageOptions({ destination: packageRoot }));
    assert.equal(manifest.instanceState.identity.serverId, settings.serverId);
    await restoreStatePackage(packageRoot, restoredRoot); assert.equal(await readServerIdentity(path.join(restoredRoot, 'data/data')), settings.serverId);
    assert.deepEqual(await fs.readFile(path.join(restoredRoot, 'data/data/device.txt')), bytes);
    assert.equal((await discoverInstanceState({ instanceRoot: restoredRoot })).identity.serverId, settings.serverId);
    const nativeRoot = path.join(root, name); await fs.mkdir(path.join(nativeRoot, 'data/data'), { recursive: true });
    await fs.writeFile(path.join(nativeRoot, 'data/data/device.txt'), await fs.readFile(path.join(restoredRoot, 'data/data/device.txt')));
    observations.push({ name, root: nativeRoot, serverId: settings.serverId, identityBytesSha256: createHash('sha256').update(bytes).digest('hex'), binding, restored: true });
  });
  const input = path.join(root, 'consumer-input.json'); await fs.writeFile(input, JSON.stringify(observations, null, 2) + '\n', { flag: 'wx' });
  const recording = await recordOracle({ project: 'tests/core/fixtures/server-identity/consumer/Oracle.csproj', output: path.join(root, 'native-reader'), args: [input, '{output}/native.json'] });
  const consumed = JSON.parse(await fs.readFile(path.join(root, 'native-reader/native.json')));
  assert.equal(consumed.actualDeviceId, true); assert.equal(consumed.actualFiles, true);
  for (const row of consumed.results) { assert.equal(row.value, observations.find(value => value.name === row.name).serverId); assert.equal(row.cachedValue, row.value); assert.equal(row.beforeBytes, row.afterBytes); }
  await fs.writeFile(path.join(root, 'proof.json'), JSON.stringify({ observations, recording, actualPostgres: true, runtimeRestart: true, completeStateRestored: true, actualNativeRead: true }, null, 2) + '\n', { flag: 'wx' });
});

test('fresh startup identity persists across independent loads while offline inspection never repairs an identity', async () => {
  const root = path.join(path.resolve(validationOutputRoot()), 'identity-fresh'); await fs.mkdir(root); await fs.mkdir(path.join(root, 'config'));
  const first = await readInstanceConfiguration(root), second = await readInstanceConfiguration(root);
  assert.match(first.serverId, /^[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/u); assert.equal(second.serverId, first.serverId);
  const filename = path.join(root, 'data/data/device.txt'); const invalid = Buffer.from('invalid'); await fs.writeFile(filename, invalid);
  await assert.rejects(inspectInstanceConfiguration(root), /identity is invalid/u); assert.deepEqual(await fs.readFile(filename), invalid);
  const repaired = await readInstanceConfiguration(root); assert.notEqual(repaired.serverId, first.serverId); assert.equal((await inspectInstanceConfiguration(root)).serverId, repaired.serverId);
});
