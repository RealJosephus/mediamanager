import test from 'node:test';
import assert from 'node:assert/strict';
import { QuickConnectService } from '../../src/users/quick-connect-service.js';

const authorization = { Client: 'TV', Device: 'Living room', DeviceId: 'tv', Version: '1.0' };
const userId = 'ce100000000000000000000000000001';

test('Quick Connect preserves separate inclusive expiry, repeated retrieval and failed authorization prefix', async t => {
  let time = Date.parse('2026-10-14T01:00:00Z'), fail = true, calls = 0;
  const result = { AccessToken: 'token', User: { Id: userId } }, configuration = {};
  const service = new QuickConnectService({ configuration, now: () => new Date(time), authentication: {
    async authenticateDirect(id, auth) { calls++; assert.equal(id, userId); assert.deepEqual(auth, authorization); if (fail) throw new Error('Failed'); return result; }
  } });
  t.after(() => service.close());
  const expired = service.initiate(authorization), first = service.initiate(authorization);
  time += 600_000;
  assert.equal(service.connect(first.Secret).Authenticated, false, 'ten minutes is still valid');
  await assert.rejects(service.authorize(userId, first.Code), /Failed/u);
  assert.equal(Date.parse(service.connect(first.Secret).DateAdded), time + 60_000);
  time++;
  assert.throws(() => service.connect(expired.Secret), { status: 404 });
  fail = false; await service.authorize(userId, first.Code);
  const authorizedAt = time;
  assert.deepEqual(service.authenticate(first.Secret), result);
  assert.deepEqual(service.authenticate(first.Secret), result);
  await assert.rejects(service.authorize(userId, first.Code), { status: 500 });
  assert.equal(calls, 2);
  configuration.QuickConnectAvailable = false;
  assert.throws(() => service.authenticate(first.Secret), { status: 401 });
  configuration.QuickConnectAvailable = true;
  time = authorizedAt + 600_000; assert.deepEqual(service.authenticate(first.Secret), result);
  time++; assert.throws(() => service.authenticate(first.Secret), { status: 404 });
  assert.equal(service.connect(first.Secret).Authenticated, true, 'pending request retains the authorization extension');
  time = authorizedAt + 660_001; assert.throws(() => service.connect(first.Secret), { status: 404 });
});

test('Quick Connect closes admission synchronously and drains admitted direct authentication', async () => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const service = new QuickConnectService({ configuration: {}, authentication: { async authenticateDirect() { started.resolve(); await release.promise; return { AccessToken: 'token' }; } } });
  const first = service.initiate(authorization), operation = service.authorize(userId, first.Code);
  await started.promise;
  let closed = false; const closing = service.close().then(() => { closed = true; });
  assert.throws(() => service.initiate(authorization), { status: 503 });
  assert.throws(() => service.connect(first.Secret), { status: 503 });
  await assert.rejects(service.authorize(userId, first.Code), { status: 503 });
  assert.equal(closed, false); release.resolve(); assert.equal(await operation, true); await closing;
  assert.equal(closed, true); assert.throws(() => service.authenticate(first.Secret), { status: 503 });
});
