import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createTestApplication } from '../helpers/application.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { AuthenticationService, ApiKeyService } from '../../src/users/index.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { normalizeKeyRows, projectKeyObservation } from './api-keys-current-observations.js';
import { currentApiKeys, input } from './api-keys-current.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = { skip: !postgresTestConnectionString };
const stringify = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString()) : entry, 2) + '\n';

test('API-key recording binds actual MVC, manager, EF SQLite and independent repeated observations', async () => {
  const { native, repeat: repeated, report } = await currentApiKeys();
  assert.equal(report.nativeExecutionRecorded, true);
  assert.deepEqual(repeated.results.map(projectKeyObservation), native.results.map(projectKeyObservation));
  assert.deepEqual(native.results.map(row => row.name), input.map(row => row.name));
});

for (const sample of input) test('postgres: native API-key HTTP, state and failure prefix: ' + sample.name, enabled, async t => {
  const { native } = await currentApiKeys();
  let database, store, apiKeys, app;
  const releases = [], calls = [], errors = [];
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    app?.beginClose(); await attempt(() => apiKeys?.close()); await attempt(() => app?.drainRequests());
    await attempt(async () => { if (app?.server.listening) await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); });
    for (const release of releases.reverse()) await attempt(release);
    await attempt(() => store?.close()); await attempt(() => dropPostgresTestDatabase(database));
    if (failures.length) throw new AggregateError(failures, 'API-key HTTP cleanup failed.');
  });
  database = await createPostgresTestDatabase(null, 'api_keys'); store = new DomainStore(database);
  const expected = native.results.find(row => row.name === sample.name);
  for (const row of expected.before) await database.insert('ApiKeys', row);
  await database.resetSequences(); apiKeys = new ApiKeyService({ store });
  for (const [name, method] of [['list', 'GetApiKeys'], ['create', 'CreateApiKey'], ['revoke', 'DeleteApiKey']]) {
    const original = apiKeys[name].bind(apiKeys);
    apiKeys[name] = (...args) => { calls.push({ method, arguments: args }); return original(...args); };
  }
  if (sample.fail) {
    await database.client.query(`CREATE FUNCTION "${database.schemaName}".fail_key() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled database failure'; END $$`);
    releases.push(() => database.client.query(`DROP FUNCTION "${database.schemaName}".fail_key()`));
    await database.client.query(`CREATE TRIGGER controlled_failure BEFORE ${sample.fail === 'delete' ? 'DELETE' : 'INSERT'} ON "ApiKeys" FOR EACH ROW EXECUTE FUNCTION "${database.schemaName}".fail_key()`);
    releases.push(() => database.client.query('DROP TRIGGER controlled_failure ON "ApiKeys"'));
  }
  const authentication = new AuthenticationService({ store, users: {}, serverId: 'api-key-http' });
  authentication.authenticate = async () => ({ IsAuthenticated: sample.identity !== 'anonymous',
    IsAdministrator: !sample.identity || ['admin', 'api'].includes(sample.identity), IsApiKey: sample.identity === 'api' });
  app = await createTestApplication({ configuration: { IsStartupWizardCompleted: true }, authentication, apiKeys, onError: error => errors.push(error.message) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const snapshots = () => store.run(database => database.rows('ApiKeys'));
  const actual = { name: sample.name, before: await snapshots(), observations: [], calls };
  assert.deepEqual(normalizeKeyRows(actual.before), normalizeKeyRows(expected.before));
  for (const step of sample.steps ?? [sample]) {
    let route = step.path;
    if (step.generated !== undefined) {
      let token = (await snapshots())[step.generated].AccessToken;
      if (step.uppercase) token = token.toUpperCase(); route = route.replace('{key}', token);
    }
    const started = new Date().toISOString();
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${route}`, { method: step.method ?? 'GET',
      headers: { Accept: step.accept ?? 'application/json', ...(step.body !== undefined && { 'Content-Type': step.contentType ?? 'application/json' }) },
      ...(step.body !== undefined && { body: step.body }) });
    const body = await response.text(), completed = new Date().toISOString(); let json = null; try { json = JSON.parse(body); } catch { }
    actual.observations.push({ status: response.status, body, json, contentType: response.headers.get('content-type'), allow: response.headers.get('allow') ?? '', state: await snapshots(), started, completed });
  }
  actual.after = actual.observations.at(-1).state;
  const projected = projectKeyObservation(actual), contract = projectKeyObservation(expected);
  await fs.writeFile(path.join(validationOutputRoot(), 'api-key-' + sample.name + '.json'), stringify({ actual, projected, contract, errors }), { flag: 'wx' });
  assert.deepEqual(projected, contract);
});
