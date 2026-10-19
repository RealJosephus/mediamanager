import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createApplication } from '../../src/http/application.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { QuickConnectService } from '../../src/users/quick-connect-service.js';
import { recordedInputPath } from '../../tools/validation/paths.js';

void JSON.parse(await readFile(new URL('./fixtures/quick-connect/required-inputs.json', import.meta.url)));
const fixture = new URL('./fixtures/quick-connect/', import.meta.url);
const [inputBytes, nativeBytes, proofBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(name => readFile(new URL(name, fixture))));
const input = JSON.parse(inputBytes), native = JSON.parse(nativeBytes), proof = JSON.parse(proofBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const userId = 'ce100000000000000000000000000001';
const noTrace = value => Array.isArray(value) ? value.map(noTrace) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'traceId').map(([key, entry]) => [key, noTrace(entry)])) : value;

test('Quick Connect recording binds actual manager, MVC and authorization with explicit session seams', async () => {
  assert.equal(hash(inputBytes), proof.inputSha256); assert.equal(hash(nativeBytes), proof.nativeSha256);
  assert.equal(hash(await readFile(recordedInputPath(proof.rawRecording, [proof.nativeSha256]))), proof.nativeSha256);
  assert.equal(hash(await readFile(recordedInputPath(proof.repeat.filename, [proof.repeat.sha256]))), proof.repeat.sha256);
  assert.equal(proof.repeat.sameInputAndOracleSources, true);
  assert.equal(native.inputSha256, proof.inputSha256);
  for (const name of ['actualManager', 'actualControllers', 'actualBinding', 'actualDefaultAuthorization', 'sessionManagerControlled', 'principalControlled']) assert.equal(native[name], true);
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0); assert.equal(proof.sourcesStable, true);
  assert.equal(proof.completeBuildInputClosure, false); assert.equal(proof.phaseAcceptance, false);
  for (const row of proof.sources) {
    for (const root of ['D:/jellyfin', proof.jellyfin.buildSource]) assert.equal(hash(await readFile(recordedInputPath(path.join(root, row.filename), [row.sha256]))), row.sha256, row.filename);
  }
  for (const row of proof.oracleSources) assert.equal(hash(await readFile(row.filename === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(row.filename, fixture))), row.sha256, row.filename);
  for (const row of proof.assemblies) assert.equal(hash(await readFile(recordedInputPath(row.filename, [row.sha256]))), row.sha256, row.name);
  assert.deepEqual(input.map(row => row.name), native.results.map(row => row.name));
  assert.equal(native.directResults.length, 9);
});

function project(value, issued, started, finished) {
  if (value?.Secret && value?.Code && value?.DateAdded) {
    assert.match(value.Secret, /^[0-9A-F]{64}$/u); assert.match(value.Code, /^[1-9][0-9]{5}$/u);
    assert.equal(value.Secret, issued.Secret); assert.equal(value.Code, issued.Code);
    const date = Date.parse(value.DateAdded);
    const advanced = date - started > 30_000;
    assert.ok(date >= started + (advanced ? 60_000 : 0) - 1 && date <= finished + (advanced ? 60_000 : 0) + 1,
      `DateAdded ${value.DateAdded} must bind its creation or authorization window`);
    return { ...value, Secret: '<secret>', Code: '<code>', DateAdded: advanced ? '<advanced>' : '<created>' };
  }
  return noTrace(value);
}

for (const sample of input) test('Quick Connect actual native HTTP differential: ' + sample.name, async t => {
  const started = Date.now(), calls = [], identity = sample.identity ?? 'ordinary';
  const configuration = { IsStartupWizardCompleted: true };
  let time = started, fail = false;
  const authorization = { DeviceId: 'target-device', Device: 'Target', Client: 'Target app', Version: '1.2', ...sample.auth };
  const direct = { async authenticateDirect(id, auth) {
    calls.push({ userId: id, DeviceId: auth.DeviceId, DeviceName: auth.Device, App: auth.Client, AppVersion: auth.Version, RemoteEndPoint: null });
    if (fail) throw Object.assign(new Error('Controlled direct authentication failure'), { status: 401 });
    if (sample.prepare === 'expired-authorized') time = 0;
    return { AccessToken: 'fixture-token', ServerId: 'fixture-server' };
  } };
  const quickConnect = new QuickConnectService({ configuration, authentication: direct, now: () => new Date(time) });
  t.after(() => quickConnect.close());
  let issued;
  if (sample.prepare) {
    if (sample.prepare === 'expired') time = 0;
    if (sample.prepare === 'expired-both') time = -60_000;
    issued = quickConnect.initiate(authorization);
    if (['authorized', 'expired-authorized', 'expired-both'].includes(sample.prepare)) await quickConnect.authorize(userId, issued.Code);
  }
  time = Date.now(); fail = sample.fail === true;
  configuration.QuickConnectAvailable = sample.enabled ?? true;
  const user = { Id: userId, Policy: { IsAdministrator: identity === 'admin', EnableRemoteAccess: true }, AccessSchedules: [] };
  const auth = { ...authorization, IsAuthenticated: identity !== 'anonymous', IsApiKey: identity === 'apiKey',
    IsAdministrator: ['admin', 'apiKey'].includes(identity), User: identity === 'apiKey' ? null : user,
    UserId: identity === 'apiKey' ? '00000000000000000000000000000000' : userId };
  const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'quick-connect-http' });
  authentication.authenticate = async () => auth;
  const application = await createApplication({ configuration, authentication, quickConnect });
  t.after(() => new Promise(resolve => application.server.close(resolve)));
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const expand = text => text.replaceAll('$secretLower', issued?.Secret.toLowerCase() ?? '').replaceAll('$secret', issued?.Secret ?? '').replaceAll('$code', issued?.Code ?? '');
  const response = await fetch(`http://127.0.0.1:${application.server.address().port}${expand(sample.path)}`, {
    method: sample.method, headers: { Accept: 'application/json', ...(sample.body !== undefined && { 'Content-Type': sample.contentType ?? 'application/json' }) },
    ...(sample.body !== undefined && { body: expand(sample.body) })
  });
  const text = await response.text(), finished = Date.now(), expected = native.results.find(row => row.name === sample.name);
  assert.equal(response.status, expected.status);
  assert.equal(response.headers.get('content-type'), expected.contentType);
  assert.equal(response.headers.get('allow') ?? '', expected.allow);
  if (sample.name === 'initiate' || sample.name === 'initiate-whitespace') issued = JSON.parse(text);
  if (expected.json !== null) {
    assert.deepEqual(project(JSON.parse(text), issued, started, finished),
      project(expected.json, expected.issued, Date.parse(expected.started), Date.parse(expected.finished)));
  } else assert.equal(text, expected.body);
  assert.deepEqual(calls, expected.calls);
  if (sample.name.startsWith('authorize-') && ['ordinary', 'admin-other', 'fail'].some(suffix => sample.name === 'authorize-' + suffix)) {
    const request = quickConnect.connect(issued.Secret);
    assert.equal(request.Authenticated, expected.issued.Authenticated);
    assert.equal(project(request, issued, started, finished).DateAdded, '<advanced>');
  }
});
