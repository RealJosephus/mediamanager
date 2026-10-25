import test from 'node:test';
import assert from 'node:assert/strict';
import { PasswordResetService } from '../../src/users/password-reset-service.js';

test('password reset selects enabled provider identities and saves the captured user only after successful local start', async t => {
  const source = { Id: 'user', PasswordResetProviderId: 'example.reset' }, calls = [];
  const service = new PasswordResetService({ users: {
    async getUserByName(name) { calls.push(['lookup', name]); return source; },
    async saveUserSnapshot(user) { assert.equal(user, source); calls.push(['save']); }
  }, providers: [{ id: 'Example.Reset', name: 'Example', enabled: true,
    async start(user, name, local) { assert.equal(user, source); calls.push(['start', name, local]); return { Action: 'PinCode' }; },
    async redeem() { return { Success: true, UsersReset: ['Example'] }; }
  }] });
  t.after(() => service.close());
  assert.deepEqual(await service.start('Name', true), { Action: 'PinCode' });
  assert.deepEqual(calls, [['lookup', 'Name'], ['start', 'Name', true], ['save']]); calls.length = 0;
  await service.start('Name', false); assert.deepEqual(calls, [['lookup', 'Name'], ['start', 'Name', false]]);
  service.providers[1].start = async () => { throw new Error('Provider failed'); }; calls.length = 0;
  await assert.rejects(service.start('Name', true), /Provider failed/u); assert.deepEqual(calls, [['lookup', 'Name']]);
});

test('redemption retains provider registration order, includes disabled providers and stops on the first provider exception', async t => {
  const calls = [], service = new PasswordResetService({ users: {}, providers: [{ id: 'Example', enabled: false,
    start() {}, async redeem(pin) { calls.push(pin); return { Success: true, UsersReset: ['Example'] }; }
  }] });
  t.after(() => service.close());
  service.defaultProvider.redeem = async () => { throw new Error('Default failed'); };
  await assert.rejects(service.redeem('PIN'), /Default failed/u); assert.deepEqual(calls, []);
  service.defaultProvider.redeem = async () => ({ Success: false });
  assert.deepEqual(await service.redeem('PIN'), { Success: true, UsersReset: ['Example'] }); assert.deepEqual(calls, ['PIN']);
});

test('password reset closure rejects new requests and drains the admitted provider and user save', async () => {
  const started = Promise.withResolvers(), release = Promise.withResolvers(), saving = Promise.withResolvers(), finish = Promise.withResolvers();
  const service = new PasswordResetService({ users: {
    async getUserByName() { return { PasswordResetProviderId: 'Example' }; },
    async saveUserSnapshot() { saving.resolve(); await finish.promise; }
  }, providers: [{ id: 'Example', enabled: true, async start() { started.resolve(); await release.promise; return { Action: 'PinCode' }; }, redeem() {} }] });
  const operation = service.start('Name', true); await started.promise;
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await assert.rejects(service.start('Name', true), { status: 503 }); await assert.rejects(service.redeem('PIN'), { status: 503 });
  assert.equal(closed, false); release.resolve(); await saving.promise; assert.equal(closed, false);
  finish.resolve(); assert.deepEqual(await operation, { Action: 'PinCode' }); await closing; assert.equal(closed, true);
});
