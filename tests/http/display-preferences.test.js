import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createApplication } from '../../src/http/application.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { DisplayPreferencesService } from '../../src/users/display-preferences-service.js';
import { nativeGuid } from '../../src/users/native.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { preferenceTables, projectPreferenceObservation } from './fixtures/display-preferences/observations.js';
import { captureDisplayPreferences, captureDisplayPreferenceSnapshot, currentPreferenceInputsAvailable } from './fixtures/display-preferences-current/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const input = JSON.parse(await fs.readFile(new URL('./fixtures/display-preferences-current/input.json', import.meta.url)));
const enabled = { skip: !postgresTestConnectionString || !currentPreferenceInputsAvailable, timeout: 300000 };

test('display preference fixture binds actual MVC, manager, EF SQLite and independent repeated observations', enabled, async () => {
  const http = await captureDisplayPreferences(), snapshot = await captureDisplayPreferenceSnapshot();
  for (const observation of [http, snapshot]) {
    assert.equal(observation.report.phaseAcceptance, true); assert.equal(observation.report.releaseAcceptance, false);
    assert.equal(observation.report.historicalRecordingReused, false); assert.equal(observation.report.independentRepeatMatched, true);
    assert.equal(observation.report.captures.length, 2);
    assert.ok(Object.values(observation.report.cleanup).every(value => value === true));
    assert.ok(observation.report.captures.every(row => row.inputsStable && row.receipt.passed));
  }
  assert.deepEqual(http.native.observation.results.map(row => row.name), input.map(row => row.name));
  assert.equal(snapshot.native.observation.mutationBeforeItemLookup, true);
});

for (const sample of input) test(`postgres: actual native display preferences HTTP and committed rows: ${sample.name}`, enabled, async t => {
  const { native } = await captureDisplayPreferences();
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
  const expected = native.observation.results.find(row => row.name === sample.name);
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
