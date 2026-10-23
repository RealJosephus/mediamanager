import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../../src/http/application.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { UserService } from '../../src/users/user-service.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { StartupService } from '../../src/users/startup-service.js';
import { nativeGuid, wireGuid } from '../../src/users/native.js';
import { ServerConfigurationStore } from '../../src/core/server-configuration-store.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { recordCurrentOracleOnce } from '../helpers/current-oracle.js';
import { projectStartupObservation, startupTables } from './fixtures/startup/observations.js';

const fixture = new URL('./fixtures/startup/', import.meta.url);
const inputBytes = await fs.readFile(new URL('input.json', fixture)), input = JSON.parse(inputBytes);
const enabled = { skip: !postgresTestConnectionString || !process.env.MEDIAMANAGER_JELLYFIN_DLL }, diskInputs = [];
const currentStartup = (label = 'startup-current') => recordCurrentOracleOnce({ owner: import.meta.url, label,
  project: 'tests/http/fixtures/startup/current/Oracle.csproj', input: 'tests/http/fixtures/startup/input.json' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString()) : entry, 2) + '\n';

test('current Startup MVC, user/configuration managers and EF repeat preserve public and persisted behavior', enabled, async () => {
  const { native } = await currentStartup(), { native: repeat } = await currentStartup('startup-current-repeat');
  for (const flag of ['actualController', 'actualBinding', 'actualAuthorizationHandlers', 'actualUserManager', 'actualEfSqlite', 'actualConfigurationManager']) assert.equal(native[flag], true);
  assert.equal(native.inputSha256, hash(inputBytes)); assert.equal(repeat.inputSha256, native.inputSha256);
  assert.deepEqual(native.results.map(row => row.name), input.map(sample => sample.name));
  assert.deepEqual(repeat.results.map(row => row.name), input.map(sample => sample.name));
  for (const sample of input) assert.deepEqual(await projectStartupObservation(repeat.results.find(row => row.name === sample.name), sample, repeat.environmentUserName),
    await projectStartupObservation(native.results.find(row => row.name === sample.name), sample, native.environmentUserName));
});

for (const sample of input) test(`postgres: native startup HTTP, rows, configuration and failure prefix: ${sample.name}`, enabled, async t => {
  const { native } = await currentStartup();
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'startup-http-'));
  const configuration = { ServerName: 'Initial', UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en',
    IsStartupWizardCompleted: Boolean(sample.completed), NetworkConfiguration: { EnableRemoteAccess: true, BaseUrl: '/media' } };
  let database, store, startup, configurationStore, app;
  const cleanup = [], events = [], errors = [];
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    app?.beginClose(); await attempt(() => startup?.close()); await attempt(() => app?.drainRequests());
    await attempt(async () => { if (app?.server.listening) await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); });
    for (const release of cleanup.reverse()) await attempt(release);
    await attempt(() => configurationStore?.close()); await attempt(() => store?.close()); await attempt(() => dropPostgresTestDatabase(database));
    await attempt(async () => {
      for (const name of ['system.xml', 'network.xml']) await fs.chmod(path.join(root, name), 0o666);
      assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('startup-http-'));
      assert.equal(path.relative(path.toNamespacedPath(root), path.toNamespacedPath(await fs.realpath(root))), '');
      await fs.rm(root, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Startup test cleanup failed.');
  });
  await fs.writeFile(path.join(root, 'system.xml'), `<ServerConfiguration><ServerName>Initial</ServerName><UICulture>en-US</UICulture><MetadataCountryCode>US</MetadataCountryCode><PreferredMetadataLanguage>en</PreferredMetadataLanguage><IsStartupWizardCompleted>${Boolean(sample.completed)}</IsStartupWizardCompleted></ServerConfiguration>`);
  await fs.writeFile(path.join(root, 'network.xml'), '<NetworkConfiguration><EnableRemoteAccess>true</EnableRemoteAccess><BaseUrl>/media</BaseUrl></NetworkConfiguration>');
  database = await createPostgresTestDatabase(null, 'startup'); store = new DomainStore(database);
  const expected = native.results.find(row => row.name === sample.name);
  for (const seed of sample.users ?? []) await database.insert('Users', expected.before.tables.Users.find(row => row.Id === nativeGuid(`e5100000-0000-0000-0000-${String(seed.index).padStart(12, '0')}`)));
  for (const table of startupTables.filter(name => name !== 'Users')) for (const row of expected.before.tables[table]) await database.insert(table, row);
  await database.resetSequences();
  const users = new UserService({ store, serverId: 'startup-http', isLocalNetwork: () => !sample.remote });
  for (const name of ['UserCreated', 'UserUpdated', 'UserPasswordChanged']) users.on(name, user => {
    events.push({ name, userId: wireGuid(user.Id), username: user.Username });
    if (sample.fail === 'event-' + name) throw new Error('Controlled event failure');
  });
  if (['save-user', 'rename', 'password'].includes(sample.fail)) {
    const table = sample.fail === 'save-user' ? 'AccessSchedules' : 'Users', event = sample.fail === 'save-user' ? 'DELETE' : 'UPDATE';
    const when = sample.fail === 'save-user' ? '' : ` WHEN (NEW."${sample.fail === 'rename' ? 'Username' : 'Password'}" IS DISTINCT FROM OLD."${sample.fail === 'rename' ? 'Username' : 'Password'}")`;
    await database.client.query(`CREATE FUNCTION "${database.schemaName}".fail_startup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled startup failure'; END $$`);
    cleanup.push(() => database.client.query(`DROP FUNCTION "${database.schemaName}".fail_startup()`));
    await database.client.query(`CREATE TRIGGER controlled_failure BEFORE ${event} ON "${table}" FOR EACH ROW${when} EXECUTE FUNCTION "${database.schemaName}".fail_startup()`);
    cleanup.push(() => database.client.query(`DROP TRIGGER controlled_failure ON "${table}"`));
  }
  if (sample.readOnlySystem) await fs.chmod(path.join(root, 'system.xml'), 0o444);
  if (sample.readOnlyNetwork) await fs.chmod(path.join(root, 'network.xml'), 0o444);
  configurationStore = new ServerConfigurationStore({ configuration, configurationDirectoryPath: root }); startup = new StartupService({ users, configuration, configurationStore });
  const authentication = new AuthenticationService({ store, users, serverId: 'startup-http', isLocalNetwork: () => !sample.remote });
  const authenticated = authentication.authorize.bind(authentication);
  authentication.authenticate = async () => ({ IsAuthenticated: Boolean(sample.identity && sample.identity !== 'anonymous'), IsApiKey: sample.identity === 'api',
    IsAdministrator: ['admin', 'api'].includes(sample.identity), UserId: sample.identity === 'api' ? undefined : wireGuid('e5100000-0000-0000-0000-000000000001'),
    User: ['user', 'admin'].includes(sample.identity) ? await users.getUser('e5100000-0000-0000-0000-000000000001') : null });
  authentication.authorize = (auth, options) => authenticated(auth, options);
  app = await createApplication({ configuration, authentication, startup, onError: error => errors.push({ message: error.message, status: error.status, stack: error.stack }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let position = 0;
  async function snapshot(expectedState) {
    const tables = await store.run(async database => Object.fromEntries(await Promise.all(startupTables.map(async table => [table, await database.rows(table)]))));
    diskInputs.push({ name: sample.name + ':' + position++, system: (await fs.readFile(path.join(root, 'system.xml'))).toString('base64'),
      network: (await fs.readFile(path.join(root, 'network.xml'))).toString('base64'), expected: { disk: expectedState.disk, networkDisk: expectedState.networkDisk } });
    return { tables, live: Object.fromEntries(['ServerName', 'UICulture', 'MetadataCountryCode', 'PreferredMetadataLanguage', 'IsStartupWizardCompleted'].map(name => [name, configuration[name]])), networkLive: { ...configuration.NetworkConfiguration } };
  }
  const actual = { name: sample.name, before: await snapshot(expected.before), observations: [], events };
  for (const [index, step] of (sample.steps ?? [sample]).entries()) {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${step.path}`, { method: step.method ?? 'GET',
      headers: { Accept: 'application/json', ...(step.body !== undefined && { 'Content-Type': step.contentType ?? 'application/json' }) }, ...(step.body !== undefined && { body: step.body }) });
    const body = await response.text(); let json = null; try { json = JSON.parse(body); } catch { }
    actual.observations.push({ status: response.status, body, json, contentType: response.headers.get('content-type'), allow: response.headers.get('allow') ?? '', state: await snapshot(expected.observations[index].state) });
  }
  actual.after = actual.observations.at(-1).state;
  const projected = await projectStartupObservation(actual, sample, os.userInfo().username),
    contract = await projectStartupObservation(expected, sample, native.environmentUserName);
  await fs.writeFile(path.join(output, 'startup-' + sample.name + '.json'), json({ actual, projected, contract, errors }), { flag: 'wx' });
  assert.deepEqual(projected, contract);
});

test('actual native XML reader consumes every candidate startup snapshot and unchanged failure-prefix file', enabled, async () => {
  const root = path.join(path.resolve(validationOutputRoot()), 'startup-config-reader'); await fs.mkdir(root, { recursive: true });
  assert.equal(diskInputs.length, input.length + input.reduce((total, sample) => total + (sample.steps?.length ?? 1), 0));
  const manifest = path.join(root, 'input.json'); await fs.writeFile(manifest, json(diskInputs.map(({ expected, ...row }) => row)), { flag: 'wx' });
  await recordOracle({ project: fileURLToPath(new URL('./fixtures/startup/current/Oracle.csproj', import.meta.url)), output: path.join(root, 'oracle'),
    args: ['read-config', manifest, '{output}/native.json'] });
  const result = JSON.parse(await fs.readFile(path.join(root, 'oracle/native.json')));
  assert.equal(result.actualNativeReader, true); assert.equal(result.manifestSha256, hash(await fs.readFile(manifest)));
  assert.deepEqual(result.rows, diskInputs.map(row => ({ name: row.name, ...row.expected })));
  await fs.writeFile(path.join(root, 'proof.json'), json({ snapshots: diskInputs.length, actualNativeReader: true, equal: true, fullInstanceVerified: false, phaseAcceptance: false }), { flag: 'wx' });
});
