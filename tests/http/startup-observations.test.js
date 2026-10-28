import test from 'node:test';
import assert from 'node:assert/strict';
import { tableDefinition } from '../../src/database/model.js';
import { projectStartupObservation } from './startup-current-observations.js';

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

test('current startup bodies retain literal nested traces and exact raw JSON outside the verified root Name', async () => {
  const row = observation('runner');
  row.observations[0].body = '{"Name":"runner","traceId":17,"ProviderIds":{"traceId":"literal","ticks":9223372036854775807}}';
  row.observations[0].json = JSON.parse(row.observations[0].body);
  const projected = await projectStartupObservation(row, sample, 'runner'), body = projected.observations[0].body;
  assert.equal(body.Name, '$environment-user'); assert.equal(body.traceId, 17);
  assert.deepEqual(body.ProviderIds, { traceId: 'literal', ticks: 9223372036854775807n });
  const problem = { status: 400, title: 'Bad Request', traceId: 'request trace',
    errors: { traceId: ['literal binding field'] }, Metadata: { traceId: 'literal extension' } };
  const error = structuredClone(row); Object.assign(error.observations[0], { status: 400, json: problem, body: JSON.stringify(problem) });
  const expected = await projectStartupObservation(error, sample, 'runner');
  assert.equal(expected.observations[0].body.traceId, '$trace');
  assert.deepEqual(expected.observations[0].body.errors, problem.errors);
  assert.deepEqual(expected.observations[0].body.Metadata, problem.Metadata);
  const absent = structuredClone(error); delete absent.observations[0].json.traceId;
  absent.observations[0].body = JSON.stringify(absent.observations[0].json);
  assert.notDeepEqual(await projectStartupObservation(absent, sample, 'runner'), expected);
  for (const trace of [null, 42, {}]) {
    const invalid = structuredClone(error); invalid.observations[0].json.traceId = trace;
    invalid.observations[0].body = JSON.stringify(invalid.observations[0].json);
    await assert.rejects(projectStartupObservation(invalid, sample, 'runner'));
  }
});
