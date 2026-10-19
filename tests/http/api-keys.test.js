import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApplication } from '../../src/http/application.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { AuthenticationService, ApiKeyService } from '../../src/users/index.js';
import { recordedInputPath, validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { normalizeKeyRows, projectKeyObservation } from './fixtures/api-keys/observations.js';

void JSON.parse(await fs.readFile(new URL('./fixtures/api-keys/required-inputs.json', import.meta.url)));
const fixture = new URL('./fixtures/api-keys/', import.meta.url);
const [inputBytes, nativeBytes, proofBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(name => fs.readFile(new URL(name, fixture))));
const input = JSON.parse(inputBytes), native = JSON.parse(nativeBytes), proof = JSON.parse(proofBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const enabled = { skip: !postgresTestConnectionString };
const stringify = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString()) : entry, 2) + '\n';

test('API-key recording binds actual MVC, manager, EF SQLite and independent repeated observations', async () => {
  assert.equal(hash(inputBytes), proof.inputSha256); assert.equal(hash(nativeBytes), proof.nativeSha256);
  assert.equal(hash(await fs.readFile(recordedInputPath(proof.rawRecording, [proof.nativeSha256]))), proof.nativeSha256);
  assert.equal(native.inputSha256, proof.inputSha256);
  for (const name of ['actualController', 'actualBinding', 'actualManager', 'actualEfSqlite', 'principalControlled']) assert.equal(native[name], true);
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0); assert.equal(proof.sourcesStable, true);
  assert.equal(proof.completeBuildInputClosure, false); assert.equal(proof.phaseAcceptance, false);
  for (const row of proof.sources) for (const root of ['D:/jellyfin', proof.jellyfin.buildSource]) assert.equal(hash(await fs.readFile(recordedInputPath(path.join(root, row.filename), [row.sha256]))), row.sha256, row.filename);
  for (const row of proof.oracleSources) assert.equal(hash(await fs.readFile(recordedInputPath(row.filename, [row.sha256]))), row.sha256, row.filename);
  for (const row of [...proof.assemblies, ...proof.nativeLibraries]) assert.equal(hash(await fs.readFile(recordedInputPath(row.filename, [row.sha256]))), row.sha256, row.filename);
  assert.equal(hash(await fs.readFile(recordedInputPath(proof.repeat.filename, [proof.repeat.sha256]))), proof.repeat.sha256);
  assert.equal(hash(await fs.readFile(new URL('observations.js', fixture))), proof.repeat.comparisonSha256);
  const repeated = JSON.parse(await fs.readFile(recordedInputPath(proof.repeat.filename, [proof.repeat.sha256])));
  assert.deepEqual(repeated.results.map(projectKeyObservation), native.results.map(projectKeyObservation));
  assert.deepEqual(native.results.map(row => row.name), input.map(row => row.name));
});

for (const sample of input) test('postgres: native API-key HTTP, state and failure prefix: ' + sample.name, enabled, async t => {
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
  app = await createApplication({ configuration: { IsStartupWizardCompleted: true }, authentication, apiKeys, onError: error => errors.push(error.message) });
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
