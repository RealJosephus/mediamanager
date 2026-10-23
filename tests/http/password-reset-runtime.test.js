import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createRuntime } from '../../src/runtime.js';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { nativeGuid } from '../../src/users/native.js';
import { PasswordResetService } from '../../src/users/password-reset-service.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';

const enabled = { skip: !postgresTestConnectionString };
const password = 'Isolated password reset password';
const clientHeader = (token, device = 'reset-phone') => ({ Authorization: `MediaBrowser Client="Reset test", Device="Phone", DeviceId="${device}", Version="1.0"${token ? `, Token="${token}"` : ''}` });

async function setup(t) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'password-reset-runtime-')), program = path.join(root, 'program');
  const configuration = { IsStartupWizardCompleted: true, BaseUrl: '/media' }, events = [], errors = [], cleanup = [];
  let database, runtime;
  const create = async () => {
    runtime = await createRuntime({ database, configuration, programDataPath: program, configurationDirectoryPath: path.join(root, 'config'),
      serverId: 'password-reset-runtime', onError: error => errors.push(error) });
    runtime.users.on('UserPasswordChanged', user => events.push(user.Username));
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  };
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    for (const release of cleanup.reverse()) await attempt(release);
    await attempt(() => runtime?.close()); await attempt(() => dropPostgresTestDatabase(database));
    await attempt(async () => {
      assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('password-reset-runtime-'));
      assert.equal(path.relative(path.toNamespacedPath(root), path.toNamespacedPath(await fs.realpath(root))), '');
      await fs.rm(root, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Password reset runtime cleanup failed.');
  });
  database = await createPostgresTestDatabase(null, 'password_reset_runtime'); await create();
  async function request(url, { token, method = 'GET', body, device } = {}) {
    const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}/media${url}`, { method,
      headers: { Accept: 'application/json', ...clientHeader(token, device), ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }) });
    const text = await response.text(); let result; try { result = JSON.parse(text); } catch { }
    return { status: response.status, body: result, text, language: response.headers.get('content-language') };
  }
  async function user(name) { return runtime.users.createUser({ Name: name, Password: password }); }
  return { root, program, request, user, errors, events, cleanup,
    get database() { return database; }, get runtime() { return runtime; },
    async reopen() { const schema = database.schemaName; await runtime.close(); database = await PostgresDatabase.open({ connectionString: postgresTestConnectionString, schema }); await create(); }
  };
}

test('postgres: anonymous password reset persists across runtime restart, preserves user state and authenticates the entered PIN', enabled, async t => {
  const state = await setup(t), owner = await state.user('Owner'), other = await state.user('Other'), id = nativeGuid(owner.Id);
  const token = await state.request('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'Owner', Pw: password } });
  assert.equal(token.status, 200);
  await state.database.insert('AccessSchedules', { UserId: id, DayOfWeek: 7, StartHour: 0, EndHour: 24 });
  await state.database.insert('Preferences', { UserId: id, Kind: 42, Value: 'future-中文', RowVersion: 3n });
  await state.database.insert('Permissions', { UserId: id, Kind: 83, Value: false, RowVersion: 4n });
  await state.database.insert('ImageInfos', { UserId: id, Path: '%AppDataPath%/avatar.png', LastModified: '2020-01-01 00:00:00.1234567' });
  state.events.length = 0;
  const before = await state.runtime.users.getUser(owner.Id), otherBefore = await state.runtime.users.getUser(other.Id);
  const reset = await state.request('/Users/ForgotPassword', { method: 'POST', body: { EnteredUsername: 'Owner' } });
  assert.equal(reset.status, 200); assert.equal(reset.language, 'en-US'); assert.equal(reset.body.Action, 'PinCode');
  assert.equal(path.dirname(reset.body.PinFile), state.program);
  const bytes = await fs.readFile(reset.body.PinFile), file = JSON.parse(bytes);
  assert.match(file.Pin, /^[0-9A-F]{2}(?:-[0-9A-F]{2}){3}$/u); assert.equal(file.UserName, 'Owner');
  assert.equal(file.PinFile, reset.body.PinFile); assert.equal(file.ExpirationDate, reset.body.PinExpirationDate);
  assert.ok(Date.parse(file.ExpirationDate) > Date.now() + 1_790_000);
  const started = await state.runtime.users.getUser(owner.Id);
  assert.notEqual(started.AccessSchedules[0].Id, before.AccessSchedules[0].Id);
  for (const key of ['Permissions', 'Preferences', 'ProfileImage', 'Password', 'RowVersion']) assert.deepEqual(started[key], before[key]);
  assert.deepEqual(await state.runtime.users.getUser(other.Id), otherBefore);
  await state.reopen(); assert.deepEqual(await fs.readFile(file.PinFile), bytes);
  const pin = file.Pin.replaceAll('-', '');
  const redeemed = await state.request('/Users/ForgotPassword/Pin', { method: 'POST', body: { Pin: pin } });
  assert.equal(redeemed.status, 200); assert.deepEqual(redeemed.body, { Success: true, UsersReset: ['Owner'] });
  assert.deepEqual(state.events, ['Owner']); await assert.rejects(fs.stat(file.PinFile), { code: 'ENOENT' });
  assert.equal((await state.request('/Users/Me', { token: token.body.AccessToken })).status, 200);
  assert.equal((await state.request('/Users/AuthenticateByName', { method: 'POST', device: 'old-password', body: { Username: 'Owner', Pw: password } })).status, 401);
  assert.equal((await state.request('/Users/AuthenticateByName', { method: 'POST', device: 'pin-password', body: { Username: 'Owner', Pw: pin } })).status, 200);
  assert.equal((await state.request('/Users/AuthenticateByName', { method: 'POST', device: 'hyphen-password', body: { Username: 'Owner', Pw: file.Pin } })).status, 401);
  const current = await state.runtime.users.getUser(owner.Id);
  for (const key of ['Permissions', 'Preferences', 'ProfileImage', 'AccessSchedules']) assert.deepEqual(current[key], started[key]);
  assert.deepEqual(await state.runtime.users.getUser(other.Id), otherBefore);
});

for (const operation of ['start', 'redeem']) test(`postgres: runtime closure drains admitted password reset ${operation} before releasing PostgreSQL`, { ...enabled, timeout: 120_000 }, async t => {
  const state = await setup(t); await state.user('Closing');
  const generated = await state.runtime.passwordResets.start('Closing', true), pin = JSON.parse(await fs.readFile(generated.PinFile)).Pin;
  state.events.length = 0;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const abort = () => { release.resolve(); entered.reject(t.signal.reason); };
  t.signal.addEventListener('abort', abort, { once: true });
  const method = operation === 'start' ? 'saveUserSnapshot' : 'changePassword';
  const original = state.runtime.users[method].bind(state.runtime.users);
  state.runtime.users[method] = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  state.cleanup.push(() => { release.resolve(); t.signal.removeEventListener('abort', abort); });
  const pending = operation === 'start' ? state.runtime.passwordResets.start('Closing', true) : state.runtime.passwordResets.redeem(pin);
  let closed = false, closing;
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Password reset completed before its controlled pause.'); })]);
    closing = state.runtime.close().then(() => { closed = true; });
    await assert.rejects(state.runtime.passwordResets.start('Closing', true), { status: 503 });
    await assert.rejects(state.runtime.passwordResets.redeem(pin), { status: 503 });
    assert.equal(closed, false); release.resolve(); await pending; await closing;
    assert.equal(closed, true); assert.equal(state.runtime.server.listening, false);
    let persistedPin = pin;
    if (operation === 'start') {
      const file = JSON.parse(await fs.readFile(generated.PinFile));
      assert.equal(file.UserName, 'Closing'); persistedPin = file.Pin;
    } else { await assert.rejects(fs.stat(generated.PinFile), { code: 'ENOENT' }); assert.deepEqual(state.events, ['Closing']); }
    await state.reopen();
    if (operation === 'start') {
      const redeemed = await state.request('/Users/ForgotPassword/Pin', { method: 'POST', body: { Pin: persistedPin } });
      assert.equal(redeemed.status, 200); assert.deepEqual(redeemed.body, { Success: true, UsersReset: ['Closing'] });
    }
    const authenticated = await state.request('/Users/AuthenticateByName', { method: 'POST',
      body: { Username: 'Closing', Pw: persistedPin } });
    assert.equal(authenticated.status, 200); assert.equal(authenticated.body.User.Name, 'Closing');
  } finally { release.resolve(); await Promise.allSettled([pending, closing]); }
});

test('postgres: password reset rejects a junction into another state directory without changing its files or users', enabled, async t => {
  const state = await setup(t); const user = await state.user('Linked');
  const outside = path.join(state.root, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'passwordreset-pin.json'), 'outside state');
  const junction = path.join(state.root, 'linked-program'); await fs.symlink(outside, junction, 'junction');
  const service = new PasswordResetService({ users: state.runtime.users, programDataPath: junction });
  state.cleanup.push(() => service.close());
  const before = await state.runtime.users.getUser(user.Id);
  await assert.rejects(service.start('Linked', true), { status: 409 });
  await assert.rejects(service.redeem('PIN'), { status: 409 });
  assert.equal(await fs.readFile(path.join(outside, 'passwordreset-pin.json'), 'utf8'), 'outside state');
  assert.deepEqual(await fs.readdir(outside), ['passwordreset-pin.json']);
  assert.deepEqual(await state.runtime.users.getUser(user.Id), before);
  await fs.unlink(junction);
});
