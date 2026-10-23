import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../../src/http/application.js';
import { AuthenticationService } from '../../src/users/authentication-service.js';
import { QuickConnectService } from '../../src/users/quick-connect-service.js';
import { currentQuickConnect, quickConnectInput, quickConnectObservation } from './quick-connect-current.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const userId = 'ce100000000000000000000000000001';

test('Quick Connect current Native executes public consumers independently twice', { timeout: 600_000 }, async () => {
  const { report } = await currentQuickConnect();
  assert.equal(report.nativeExecutionRecorded, true); assert.equal(report.independentRepeatAgrees, true);
});

async function observe(t, sample, expiry = false) {
  const started = Date.now(), calls = [], identity = sample.identity ?? 'ordinary';
  const configuration = { IsStartupWizardCompleted: true };
  let time = started, fail = false;
  const authorization = { DeviceId: 'target-device', Device: 'Target', Client: 'Target app', Version: '1.2', ...sample.auth };
  const direct = { async authenticateDirect(id, auth) {
    calls.push({ userId: id, DeviceId: auth.DeviceId, DeviceName: auth.Device, App: auth.Client, AppVersion: auth.Version, RemoteEndPoint: null });
    if (fail) throw Object.assign(new Error('Controlled direct authentication failure'), { status: 401 });
    if (sample.prepare === 'expired-authorized') time = 0;
    if (expiry && sample.authorized) time = started - sample.tokenAgeMs;
    return { AccessToken: 'fixture-token', ServerId: 'fixture-server' };
  } };
  const quickConnect = new QuickConnectService({ configuration, authentication: direct, now: () => new Date(time) });
  t.after(() => quickConnect.close());
  let issued;
  if (expiry) {
    time = started - sample.pendingAgeMs; issued = quickConnect.initiate(authorization);
    if (sample.authorized) {
      time = started - sample.pendingAgeMs - 60_000;
      await quickConnect.authorize(userId, issued.Code);
    }
  } else if (sample.prepare) {
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
  async function send(method, path, body, contentType = 'application/json') {
    const response = await fetch(`http://127.0.0.1:${application.server.address().port}${path}`, {
      method, headers: { Accept: 'application/json', ...(body !== undefined && { 'Content-Type': contentType }) },
      ...(body !== undefined && { body })
    });
    const text = await response.text(); let value = null, hasJson = false;
    try { value = JSON.parse(text); hasJson = true; } catch { }
    return { status: response.status, body: text, hasJson, json: value,
      contentType: response.headers.get('content-type'), allow: response.headers.get('allow') ?? '' };
  }
  let response;
  if (!expiry) {
    response = await send(sample.method, expand(sample.path), sample.body === undefined ? undefined : expand(sample.body), sample.contentType);
    if (sample.path === '/QuickConnect/Initiate' && response.status === 200) issued = response.json;
  }
  const callsBeforeRead = [...calls], followUp = [];
  if (issued) for (const operation of ['poll', 'redeem', 'redeem-again', 'poll-again']) {
    const result = operation.startsWith('poll') ? await send('GET', '/QuickConnect/Connect?secret=' + issued.Secret)
      : await send('POST', '/Users/AuthenticateWithQuickConnect', JSON.stringify({ Secret: issued.Secret }));
    followUp.push({ operation, response: result });
  }
  return { name: sample.name, ...(response && { response }), followUp, started: new Date(started).toISOString(),
    finished: new Date().toISOString(), issued, calls: callsBeforeRead, callsAfterRead: calls,
    ...(expiry && { dateOffsetMs: -sample.pendingAgeMs }) };
}

for (const sample of quickConnectInput.httpCases) test('Quick Connect current Native HTTP differential: ' + sample.name, async t => {
  const current = await currentQuickConnect(), actual = await observe(t, sample);
  const expected = current.native.results.find(value => value.name === sample.name);
  await current.recordComparison({ scope: 'http', name: sample.name, actual, expected });
  assert.deepEqual(quickConnectObservation(actual), quickConnectObservation(expected));
});

for (const sample of quickConnectInput.expiryCases) test('Quick Connect current Native public expiry and repeated reads: ' + sample.name, async t => {
  const current = await currentQuickConnect(), actual = await observe(t, sample, true);
  const expected = current.native.expiryResults.find(value => value.name === sample.name);
  await current.recordComparison({ scope: 'expiry', name: sample.name, actual, expected });
  assert.deepEqual(quickConnectObservation(actual), quickConnectObservation(expected));
});
