import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApplication } from '../../src/http/application.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { DisplayPreferencesService } from '../../src/users/display-preferences-service.js';
import { nativeGuid } from '../../src/users/native.js';
import { recordedInputPath, validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { preferenceTables, projectPreferenceObservation } from './fixtures/display-preferences/observations.js';

void JSON.parse(await fs.readFile(new URL('./fixtures/display-preferences/required-inputs.json', import.meta.url)));
const fixture = new URL('./fixtures/display-preferences/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputBytes = await fs.readFile(new URL('input.json', fixture)), nativeBytes = await fs.readFile(new URL('native.json', fixture));
const input = JSON.parse(inputBytes), native = JSON.parse(nativeBytes), proof = JSON.parse(await fs.readFile(new URL('provenance.json', fixture)));
const enabled = { skip: !postgresTestConnectionString };

test('display preference fixture binds actual MVC, manager, EF SQLite and independent repeated observations', async () => {
  assert.equal(hash(inputBytes), proof.inputSha256); assert.equal(hash(nativeBytes), proof.nativeSha256);
  assert.equal(hash(await fs.readFile(recordedInputPath(proof.rawRecording, [proof.nativeSha256]))), proof.nativeSha256); assert.equal(native.inputSha256, proof.inputSha256);
  for (const name of ['actualController', 'actualBinding', 'actualManager', 'actualEfSqlite', 'principalControlled']) assert.equal(native[name], true);
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0); assert.equal(proof.sourcesStable, true);
  assert.equal(proof.completeBuildInputClosure, false); assert.equal(proof.phaseAcceptance, false);
  for (const row of proof.sources) for (const root of ['D:/jellyfin', proof.jellyfin.buildSource]) assert.equal(hash(await fs.readFile(recordedInputPath(path.join(root, row.filename), [row.sha256]))), row.sha256);
  for (const row of [...proof.oracleSources, ...proof.assemblies, ...proof.nativeLibraries]) assert.equal(hash(await fs.readFile(recordedInputPath(row.filename, [row.sha256]))), row.sha256);
  const repeated = JSON.parse(await fs.readFile(recordedInputPath(proof.repeat.filename, [proof.repeat.sha256])));
  assert.equal(hash(await fs.readFile(recordedInputPath(proof.repeat.filename, [proof.repeat.sha256]))), proof.repeat.sha256);
  assert.equal(hash(await fs.readFile(new URL('observations.js', fixture))), proof.repeat.comparisonSha256);
  assert.deepEqual(repeated.results.map(projectPreferenceObservation), native.results.map(projectPreferenceObservation));
  assert.deepEqual(native.results.map(row => row.name), input.map(row => row.name));
  const snapshotProof = JSON.parse(await fs.readFile(new URL('snapshot-provenance.json', fixture)));
  const snapshotBytes = await fs.readFile(new URL('snapshot-native.json', fixture)), snapshot = JSON.parse(snapshotBytes);
  assert.equal(hash(snapshotBytes), snapshotProof.nativeSha256);
  assert.equal(hash(await fs.readFile(recordedInputPath(snapshotProof.rawRecording, [snapshotProof.nativeSha256]))), snapshotProof.nativeSha256);
  for (const name of ['actualController', 'actualManager', 'actualEfSqlite', 'mutationBeforeItemLookup']) assert.equal(snapshot[name], true);
  assert.equal(snapshotProof.build.status, 0); assert.equal(snapshotProof.process.status, 0);
  assert.equal(snapshotProof.completeBuildInputClosure, false); assert.equal(snapshotProof.phaseAcceptance, false);
  for (const row of [...snapshotProof.oracleSources, ...snapshotProof.assemblies, ...snapshotProof.nativeLibraries]) {
    assert.equal(hash(await fs.readFile(recordedInputPath(row.filename, [row.sha256]))), row.sha256);
    if (row.fixtureFilename) assert.equal(hash(await fs.readFile(new URL(row.fixtureFilename, fixture))), row.sha256);
  }
  assert.equal(hash(await fs.readFile(recordedInputPath(snapshotProof.repeat.filename, [snapshotProof.repeat.sha256]))), snapshotProof.repeat.sha256);
  assert.equal(snapshotProof.repeat.sameOracleSources, true);
  assert.deepEqual(JSON.parse(await fs.readFile(recordedInputPath(snapshotProof.repeat.filename, [snapshotProof.repeat.sha256]))).actual, snapshot.actual);
});

for (const sample of input) test(`postgres: actual native display preferences HTTP and committed rows: ${sample.name}`, enabled, async t => {
  let database, store, service, app;
  const cleanup = [], errors = [];
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    app?.beginClose(); await attempt(() => service?.close()); await attempt(() => app?.drainRequests());
    await attempt(async () => { if (app?.server.listening) await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); });
    for (const release of cleanup.reverse()) await attempt(release);
    await attempt(() => store?.close()); await attempt(() => dropPostgresTestDatabase(database));
    if (failures.length) throw new AggregateError(failures, 'Display preference test cleanup failed.');
  });
  database = await createPostgresTestDatabase(null, 'display_prefs'); store = new DomainStore(database);
  for (const index of [1, 2]) await database.insert('Users', postgresTestRow('Users', {
    Id: nativeGuid(`df100000000000000000${String(index).padStart(12, '0')}`), Username: 'User' + index, NormalizedUsername: 'USER' + index,
    AuthenticationProviderId: 'provider', PasswordResetProviderId: 'reset'
  }));
  const expected = native.results.find(row => row.name === sample.name);
  for (const table of preferenceTables) for (const row of expected.before[table]) await database.insert(table, row);
  await database.resetSequences();
  if (sample.fail) {
    const [table, event] = ({ 'custom-insert': ['CustomItemDisplayPreferences', 'INSERT'], 'custom-delete': ['CustomItemDisplayPreferences', 'DELETE'],
      'item-update': ['ItemDisplayPreferences', 'UPDATE'], 'display-update': ['DisplayPreferences', 'UPDATE'], 'home-insert': ['HomeSection', 'INSERT'] })[sample.fail] ?? ['DisplayPreferences', 'INSERT'];
    await database.client.query(`CREATE FUNCTION "${database.schemaName}".fail_preferences() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled database failure'; END $$`);
    cleanup.push(() => database.client.query(`DROP FUNCTION "${database.schemaName}".fail_preferences()`));
    await database.client.query(`CREATE TRIGGER controlled_failure BEFORE ${event} ON "${table}" FOR EACH ROW EXECUTE FUNCTION "${database.schemaName}".fail_preferences()`);
    cleanup.push(() => database.client.query(`DROP TRIGGER controlled_failure ON "${table}"`));
  }
  service = new DisplayPreferencesService({ store, onError: error => errors.push(error) });
  const userId = 'df100000000000000000000000000001';
  const authentication = {
    read: () => ({}), authenticate: async () => ({ IsAuthenticated: !sample.anonymous, IsApiKey: Boolean(sample.apiKey), IsAdministrator: !sample.regular,
      UserId: sample.apiKey ? undefined : userId }),
    authorize: auth => { if (!auth.IsAuthenticated) throw Object.assign(new Error('Unauthorized'), { status: 401 }); }
  };
  app = await createApplication({ configuration: { IsStartupWizardCompleted: true }, authentication, displayPreferences: service, onError: error => errors.push(error) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const snapshot = () => store.run(async database => Object.fromEntries(await Promise.all(preferenceTables.map(async table => [table, await database.rows(table)]))));
  const actual = { name: sample.name, before: await snapshot(), observations: [] };
  for (const step of sample.steps ?? [sample]) {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${step.path}`, { method: step.method ?? 'GET',
      headers: { Accept: 'application/json', ...(step.body !== undefined && { 'Content-Type': step.contentType ?? 'application/json' }) },
      ...(step.body !== undefined && { body: step.body }) });
    const body = await response.text(); let json = null; try { json = JSON.parse(body); } catch { }
    actual.observations.push({ status: response.status, body, json, contentType: response.headers.get('content-type'), allow: response.headers.get('allow') ?? '', state: await snapshot() });
  }
  actual.after = await snapshot();
  const output = path.join(validationOutputRoot(), 'display-preferences'); await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, sample.name + '.json'), JSON.stringify({ ...actual, errors: errors.map(error => ({ message: error.message, code: error.code })) }, null, 2) + '\n');
  assert.deepEqual(projectPreferenceObservation(actual), projectPreferenceObservation(expected));
});
