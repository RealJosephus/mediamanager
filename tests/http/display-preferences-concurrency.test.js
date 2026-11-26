import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainStore } from '../../src/database/domain-store.js';
import { UserService } from '../../src/users/user-service.js';
import { DisplayPreferencesService } from '../../src/users/display-preferences-service.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { createTestApplication } from '../helpers/application.js';

export const requiredValidationServices = ['postgres'];

test('two concurrent first HTTP reads return the same stored display preferences', { skip: !postgresTestConnectionString }, async t => {
  const database = await createPostgresTestDatabase(null, 'pref_reads', { max: 4 });
  const store = new DomainStore(database);
  const service = new DisplayPreferencesService({ store });
  const users = new UserService({ store, serverId: '123456781234123412341234567890ab' });
  const query = database.client.query;
  let app;
  t.after(async () => {
    database.client.query = query;
    if (app?.server.listening) await new Promise(resolve => app.server.close(resolve));
    await service.close();
    await store.close();
    await dropPostgresTestDatabase(database);
  });
  const user = await users.createUser({ Name: 'PreferencesReader' });
  app = await createTestApplication({ displayPreferences: service, configuration: { IsStartupWizardCompleted: true },
    authentication: { authenticate: async () => ({ IsAuthenticated: true, UserId: user.Id }), authorize() {} } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));

  const gates = ['DisplayPreferences', 'ItemDisplayPreferences'].map(table => ({
    from: 'FROM "' + table + '"', waiting: Promise.withResolvers(), misses: 0,
  }));
  const timer = setTimeout(() => { for (const gate of gates) gate.waiting.resolve(); }, 5000);
  t.after(() => clearTimeout(timer));
  database.client.query = async (...args) => {
    const response = await query(...args);
    const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
    const gate = gates.find(({ from }) => sql.includes(from));
    if (gate && gate.misses < 2 && response.rows.length === 0) {
      if (++gate.misses === 2) gate.waiting.resolve();
      await gate.waiting.promise;
    }
    return response;
  };
  const url = `http://127.0.0.1:${app.server.address().port}/DisplayPreferences/dashboard?client=web`;
  const replies = await Promise.all([fetch(url), fetch(url)]);
  assert.deepEqual(gates.map(gate => gate.misses), [2, 2]);
  assert.deepEqual(replies.map(reply => reply.status), [200, 200]);
  const [first, second] = await Promise.all(replies.map(reply => reply.json()));
  assert.deepEqual(first, second);
  assert.equal(first.CustomPrefs.skipForwardLength, '30000');
  assert.equal((await database.rows('DisplayPreferences')).length, 1);
  const stored = await database.rows('ItemDisplayPreferences');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].ItemId.toLowerCase(), first.Id);
  assert.deepEqual(await (await fetch(url)).json(), first);
  assert.deepEqual(await database.rows('ItemDisplayPreferences'), stored);
  await assert.rejects(service.get('dashboard', '00000000000000000000000000000001', 'web'), { code: '23503' });
});
