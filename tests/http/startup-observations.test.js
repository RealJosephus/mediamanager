import test from 'node:test';
import assert from 'node:assert/strict';
import { tableDefinition } from '../../src/database/model.js';
import { projectStartupObservation } from './fixtures/startup/observations.js';

const sample = { method: 'GET', path: '/Startup/User' };
function observation(username) {
  const user = Object.fromEntries(tableDefinition('Users').columns.map(column => [column.name, column.clrType === 'bool' ? false : null]));
  Object.assign(user, { Id: 'e5100000-0000-0000-0000-000000000001', Username: username, NormalizedUsername: username.toUpperCase() });
  const state = users => ({ tables: { Users: users }, live: {}, networkLive: {} });
  return { name: 'initial-user', before: state([]), after: state([user]), events: [],
    observations: [{ status: 200, json: { Name: username }, contentType: 'application/json', allow: '', state: state([user]) }] };
}

test('startup observations bind the verified environment username only for empty-database initialization', async () => {
  const contract = await projectStartupObservation(observation('Joseph'), sample, 'Joseph');
  assert.deepEqual(await projectStartupObservation(observation('runner'), sample, 'runner'), contract);
  assert.deepEqual(await projectStartupObservation(observation('MyJellyfinUser'), sample, 'invalid/user'), contract);
  await assert.rejects(projectStartupObservation(observation('someone-else'), sample, 'runner'));
  const wrongNormalized = observation('runner'); wrongNormalized.after.tables.Users[0].NormalizedUsername = 'someone-else';
  await assert.rejects(projectStartupObservation(wrongNormalized, sample, 'runner'));
  const wrongResponse = observation('runner'); wrongResponse.observations[0].json.Name = 'someone-else';
  await assert.rejects(projectStartupObservation(wrongResponse, sample, 'runner'));
  const failed = observation('runner'); failed.observations[0].status = 500;
  failed.observations[0].json = null; failed.observations[0].body = 'Error processing request.';
  assert.notDeepEqual(await projectStartupObservation(failed, sample, 'runner'), contract);
  const seeded = observation('runner'); seeded.before = structuredClone(seeded.after);
  const projected = await projectStartupObservation(seeded, sample, 'different-environment');
  assert.equal(projected.before.tables.Users[0].Username, 'runner');
  assert.equal(projected.observations[0].body.Name, 'runner');
});
