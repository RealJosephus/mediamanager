import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createApplication } from '../../src/http/application.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { wireGuid } from '../../src/users/native.js';

const fixture = new URL('./fixtures/collections/', import.meta.url);
const [inputBytes, nativeBytes, proofBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(name => readFile(new URL(name, fixture))));
const input = JSON.parse(inputBytes), native = JSON.parse(nativeBytes), proof = JSON.parse(proofBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = index => `ca1000000000000000000${String(index).padStart(11, '0')}`;
const noTrace = value => Array.isArray(value) ? value.map(noTrace) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId').map(([key, entry]) => [key, noTrace(entry)])) : value;

test('collection HTTP recording binds native controller, binder, permission handlers and controlled seams', async () => {
  assert.equal(hash(inputBytes), proof.inputSha256); assert.equal(hash(nativeBytes), proof.nativeSha256);
  assert.equal(hash(await readFile(proof.rawRecording)), proof.nativeSha256);
  assert.equal(hash(await readFile(proof.repeat.filename)), proof.repeat.sha256);
  assert.equal(proof.repeat.sameInputAndOracleSources, true);
  assert.equal(native.inputSha256, proof.inputSha256);
  for (const key of ['actualController', 'actualBinding', 'actualPermissionHandlers', 'actualManagerErrors', 'principalControlled', 'userNetworkControlled', 'managerDtoControlled']) assert.equal(native[key], true);
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0);
  assert.equal(proof.completeBuildInputClosure, false); assert.equal(proof.phaseAcceptance, false);
  for (const source of proof.sources) {
    assert.equal(hash(await readFile(path.join('D:/jellyfin', source.filename))), source.sha256, source.filename);
    assert.equal(hash(await readFile(path.join(proof.jellyfin.buildSource, source.filename))), source.sha256, source.filename);
  }
  for (const source of proof.oracleSources) assert.equal(hash(await readFile(source.filename === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(source.filename, fixture))), source.sha256, source.filename);
  for (const assembly of proof.assemblies) assert.equal(hash(await readFile(assembly.filename)), assembly.sha256, assembly.name);
  assert.deepEqual(native.results.map(row => row.name), input.cases.map(row => row.name));
});

test('actual manager HTTP errors preserve native exception classification and creation prefix', () => {
  const rows = native.results.filter(row => row.managerState != null);
  assert.equal(rows.length, 8);
  for (const row of rows) {
    assert.equal(row.status, /malformed-member|null-name/.test(row.name) ? 500 : 400, row.name);
    assert.equal(row.body, 'Error processing request.');
    if (row.name.startsWith('actual-create-') && !row.name.endsWith('null-name')) {
      assert.deepEqual(row.managerState.phases, ['begin', 'create-item', 'complete']);
      assert.equal(row.managerState.created, true); assert.deepEqual(row.managerState.links, []);
      assert.equal(row.managerState.directories.some(value => value.endsWith(' [boxset]')), true);
    } else {
      assert.deepEqual(row.managerState.phases, []); assert.equal(row.managerState.created, false);
    }
  }
});

for (const sample of input.cases.filter(row => !row.actualManager)) test('Collection actual MVC/binding/authorization differential: ' + sample.name, async t => {
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
  const application = await createApplication({ configuration: { IsStartupWizardCompleted: true }, authentication,
    collections: { withCreatedItem: async (options, consume) => {
      calls.push({ phase: 'create', ...options });
      if (sample.fail === 'create') throw new Error('Controlled create failure.');
      return consume({ Id: id(1) });
    }, add: mutation('add'), remove: mutation('remove') },
    library: { getItemDto: async (item, options) => {
      assert.equal(options, undefined);
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
  assert.equal(response.status, expected.status);
  assert.equal(response.headers.get('content-type'), expected.contentType);
  assert.equal(response.headers.get('allow') ?? '', expected.allow);
  if (expected.jsonBody !== null) assert.deepEqual(noTrace(JSON.parse(body)), noTrace(expected.jsonBody));
  else assert.equal(body, expected.body);
  assert.deepEqual(calls, expected.calls);
});
