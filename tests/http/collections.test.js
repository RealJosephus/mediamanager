import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestApplication } from '../helpers/application.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { wireGuid } from '../../src/users/native.js';
import { actualManagerCase, collectionBindingObservation, currentCollections, id, input, noTrace, recordCandidate } from './collections-current-fixture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];

test('collection HTTP current capture executes designated Native controller, binder, permissions and controlled seams', async () => {
  const { native, report } = await currentCollections();
  assert.equal(report.nativeExecutionRecorded, true); assert.equal(report.independentRepeatMatched, true);
  for (const key of ['actualController', 'actualBinding', 'actualPermissionHandlers', 'actualManagerErrors', 'principalControlled', 'userNetworkControlled', 'managerDtoControlled']) assert.equal(native[key], true);
  assert.deepEqual(native.results.map(row => row.name), input.cases.map(row => row.name));
});

test('actual manager HTTP failures preserve current Native public errors, PostgreSQL prefix and file state', async t => {
  const { native } = await currentCollections();
  const rows = input.cases.filter(row => row.actualManager);
  assert.equal(rows.length, 8);
  for (const sample of rows) await t.test(sample.name, async child => {
    const expected = native.results.find(row => row.name === sample.name);
    const actual = await actualManagerCase(child, sample);
    assert.equal(actual.response.status, expected.status, sample.name);
    assert.equal(actual.response.contentType, expected.contentType);
    assert.equal(actual.response.allow, expected.allow); assert.equal(actual.response.body, expected.body);
    const { diagnosticPhases: _diagnosticPhases, ...state } = expected.managerState;
    assert.deepEqual(actual.managerState, state, sample.name + ': actual manager result, links, events and all collection files');
  });
});

for (const sample of input.cases.filter(row => !row.actualManager)) test('Collection actual MVC/binding/authorization differential: ' + sample.name, async t => {
  const { native } = await currentCollections();
  const calls = [], identity = sample.identity ?? 'collection';
  const user = { Id: id(9), Policy: { IsAdministrator: identity === 'admin', EnableCollectionManagement: identity === 'collection',
    EnableRemoteAccess: sample.remoteDenied !== true }, AccessSchedules: [] };
  const auth = { IsAuthenticated: identity !== 'anonymous', IsApiKey: identity === 'apiKey', IsAdministrator: ['admin', 'apiKey'].includes(identity),
    UserId: ['empty', 'apiKey'].includes(identity) ? '00000000000000000000000000000000' : user.Id,
    User: ['empty', 'apiKey'].includes(identity) ? null : user };
  const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'collection-differential',
    isLocalNetwork: () => sample.remote !== true });
  authentication.authenticate = async () => auth;
  const mutation = action => async (value, ids) => {
    calls.push({ phase: action, id: wireGuid(value), ids });
    if (sample.fail === 'mutation') throw new Error('Controlled mutation failure.');
  };
  const application = await createTestApplication({ configuration: { IsStartupWizardCompleted: true }, authentication,
    collections: { withCreatedItem: async (options, consume) => {
      calls.push({ phase: 'create', ...options });
      if (sample.fail === 'create') throw new Error('Controlled create failure.');
      return consume({ Id: id(1) });
    }, add: mutation('add'), remove: mutation('remove') },
    library: { getItemDto: async (item, options) => {
      calls.push({ phase: 'dto', id: item.Id, allFields: true, userIsNull: true, ownerIsNull: true });
      if (sample.fail === 'dto') throw new Error('Controlled DTO failure.');
      return { Id: id(2) };
    } },
  });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => application.server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${application.server.address().port}${sample.path}`, {
    method: sample.method, headers: { Accept: sample.accept ?? 'application/json', ...(sample.contentType && { 'Content-Type': sample.contentType }) }, body: sample.body,
  });
  const body = await response.text(), expected = native.results.find(row => row.name === sample.name);
  await recordCandidate(sample.name, { response: { status: response.status, contentType: response.headers.get('content-type'),
    allow: response.headers.get('allow') ?? '', body }, calls });
  assert.equal(response.status, expected.status);
  assert.equal(response.headers.get('content-type'), expected.contentType);
  assert.equal(response.headers.get('allow') ?? '', expected.allow);
  if (expected.jsonBody !== null) assert.deepEqual(noTrace(JSON.parse(body)), noTrace(expected.jsonBody));
  else assert.equal(body, expected.body);
  assert.deepEqual(collectionBindingObservation(calls), collectionBindingObservation(expected.calls));
});
