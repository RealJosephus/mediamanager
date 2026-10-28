import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createTestApplication } from '../helpers/application.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { UserService, AuthenticationService, ApiKeyService, PasswordResetService } from '../../src/users/index.js';
import { parsePasswordHash, verifyPasswordHash } from '../../src/core/password.js';
import { md5Guid } from '../../src/core/identity.js';
import { wireGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { normalizeSnapshot, projectResetObservation } from './password-reset-current-observations.js';
import { currentPasswordResetHttp, passwordResetInput } from './password-reset-http-current.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const enabled = { skip: !postgresTestConnectionString };

test('password reset current Native independently repeats actual HTTP, EF SQLite, crypto and PIN-file observations', { timeout: 600_000 }, async () => {
  const { report } = await currentPasswordResetHttp();
  assert.equal(report.nativeExecutionRecorded, true); assert.equal(report.independentRepeatAgrees, true);
});

async function files(root) {
  let names; try { names = await fs.readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return Promise.all(names.map(async entry => {
    if (entry.isDirectory()) return { name: entry.name, directory: true };
    const filename = path.join(root, entry.name), stat = await fs.stat(filename);
    const bytes = await fs.readFile(filename);
    return { name: entry.name, directory: false, text: new TextDecoder().decode(bytes), bytesBase64: bytes.toString('base64'), readOnly: !(stat.mode & 0o200) };
  }));
}

for (const [index, sample] of passwordResetInput.entries()) test(`postgres: current Native password reset ${sample.mode === 'snapshot' ? 'user snapshot' : 'HTTP'}, files, rows and failure prefix: ${sample.name}`, enabled, async t => {
  assert.match(sample.name, /^[a-z-]+$/u);
  const currentNative = await currentPasswordResetHttp(), output = currentNative.output;
  const root = await fs.mkdtemp(path.join(output, 'password-reset-http-')), program = path.join(root, 'program');
  let database, store, passwordResets, apiKeys, app;
  const releases = [], calls = [], events = [], requestedPins = [];
  t.after(async () => {
    const failures = [], attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    app?.beginClose(); await attempt(() => passwordResets?.close()); await attempt(() => app?.drainRequests());
    await attempt(() => apiKeys?.close());
    await attempt(async () => { if (app?.server.listening) await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); });
    for (const release of releases.reverse()) await attempt(release);
    await attempt(() => store?.close()); await attempt(() => dropPostgresTestDatabase(database));
    await attempt(async () => {
      for (const entry of await files(program)) if (!entry.directory) await fs.chmod(path.join(program, entry.name), 0o666);
      assert.equal(path.dirname(root), output); assert.ok(path.basename(root).startsWith('password-reset-http-'));
      assert.equal(path.relative(path.toNamespacedPath(root), path.toNamespacedPath(await fs.realpath(root))), '');
      await fs.rm(root, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Password reset test cleanup failed.');
  });
  const expected = currentNative.native.results[index];
  if (!sample.missingRoot) await fs.mkdir(program);
  database = await createPostgresTestDatabase(null, 'password_reset'); store = new DomainStore(database);
  for (const table of ['Users', 'Permissions', 'Preferences', 'AccessSchedules', 'ImageInfos']) {
    for (const row of expected.before[table]) await database.insert(table, row);
  }
  await database.resetSequences();
  const users = new UserService({ store, serverId: 'password-reset-http' });
  const authentication = new AuthenticationService({ store, users, serverId: 'password-reset-http' });
  apiKeys = new ApiKeyService({ store });
  passwordResets = new PasswordResetService({ users, programDataPath: program });
  const start = passwordResets.start.bind(passwordResets), redeem = passwordResets.redeem.bind(passwordResets);
  passwordResets.start = (...args) => { calls.push('StartForgotPasswordProcess'); return start(...args); };
  passwordResets.redeem = pin => { calls.push('RedeemPasswordResetPin'); requestedPins.push(pin); return redeem(pin); };
  users.on('UserPasswordChanged', user => {
    events.push({ name: 'UserPasswordChanged', userId: wireGuid(user.Id) });
    if (sample.fail === 'password-event') throw new Error('Controlled event failure');
  });
  const snapshots = () => store.run(async database => Object.fromEntries(await Promise.all(
    ['Users', 'Permissions', 'Preferences', 'AccessSchedules', 'ImageInfos'].map(async table => [table, await database.rows(table)]))));
  const before = await snapshots();
  assert.deepEqual(normalizeSnapshot(before), normalizeSnapshot(expected.before), 'the candidate consumes the complete same-run Native initial database state');
  if (sample.fail === 'save-user' || sample.fail === 'change-password' || sample.fail === 'snapshot') {
    const table = sample.fail === 'save-user' ? 'AccessSchedules' : 'Users', event = sample.fail === 'save-user' ? 'DELETE' : sample.fail === 'snapshot' ? 'UPDATE' : 'UPDATE OF "Password"';
    await database.client.query(`CREATE FUNCTION "${database.schemaName}".fail_reset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled reset failure'; END $$`);
    releases.push(() => database.client.query(`DROP FUNCTION "${database.schemaName}".fail_reset()`));
    await database.client.query(`CREATE TRIGGER fail_reset BEFORE ${event} ON "${table}" FOR EACH ROW EXECUTE FUNCTION "${database.schemaName}".fail_reset()`);
    releases.push(() => database.client.query(`DROP TRIGGER fail_reset ON "${table}"`));
  }
  for (const entry of sample.files ?? []) {
    const filename = path.join(program, entry.name);
    if (entry.directory) await fs.mkdir(filename); else {
      await fs.writeFile(filename, entry.text);
      if (entry.readOnly) await fs.chmod(filename, 0o444);
    }
  }
  if (sample.targetDirectory) await fs.mkdir(path.join(program, 'passwordreset' + md5Guid('ALPHA') + '.json'));
  const beforeFiles = await files(program);
  app = await createTestApplication({ configuration: { IsStartupWizardCompleted: true }, users, authentication, passwordResets });
  if (sample.remote) app.server.prependListener('request', request => {
    Object.defineProperty(request.socket, 'remoteAddress', { value: '203.0.113.9', configurable: true });
    if (sample.sameAddress) Object.defineProperty(request.socket, 'localAddress', { value: '203.0.113.9', configurable: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const key = await apiKeys.create('Password reset test');
  const observations = [];
  let directError;
  if (sample.mode === 'snapshot') {
    const started = new Date().toISOString(), source = await users.getUser('ce200000000000000000000000000001');
    if (sample.freshChange) {
      await database.update('Users', { Id: source.Id }, { Username: 'Outside', NormalizedUsername: 'OUTSIDE', RowVersion: 9n });
      const permission = source.Permissions.find(value => value.Kind === 4);
      await database.update('Permissions', { Id: permission.Id }, { Value: false, RowVersion: 5n });
      await database.update('Preferences', { Id: source.Preferences[0].Id }, { Value: 'outside', RowVersion: 7n });
      await database.update('ImageInfos', { Id: source.ProfileImage.Id }, { Path: 'outside-avatar.png' });
    }
    if (sample.sourceFields) {
      Object.assign(source, { Username: 'Renamed', NormalizedUsername: 'RENAMED', EnableAutoLogin: true, LastLoginDate: '2020-02-03 04:05:06.1234567',
        Permissions: [{ Kind: 83, Value: true }, { Kind: 83, Value: false }], Preferences: [{ Kind: 42, Value: 'future-中文' }], ProfileImage: null });
    }
    if (sample.sourceImage) source.ProfileImage = { Path: '%MetadataPath%/new.png', LastModified: '2021-01-01 00:00:00' };
    let status = 200; calls.push('UpdateUserAsync');
    try { await users.saveUserSnapshot(source); } catch (error) { status = 500; directError = { message: error.message, code: error.code }; }
    observations.push({ status, body: status === 200 ? '' : 'Error processing request.', json: null, hasJson: false, contentType: null, allow: '', started,
      finished: new Date().toISOString(), files: await files(program) });
  }
  for (const step of sample.mode === 'snapshot' ? [] : sample.steps ?? [sample]) {
    let body = step.body;
    if (body?.includes('$pin')) {
      const generated = (await files(program)).flatMap(file => { try { return [JSON.parse(file.text).Pin]; } catch { return []; } }).find(pin => typeof pin === 'string');
      assert.match(generated, /^[0-9A-F]{2}(?:-[0-9A-F]{2}){3}$/u);
      body = body.replaceAll('$pinCompact', generated.replaceAll('-', '')).replaceAll('$pin', generated);
    }
    const started = new Date().toISOString();
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${step.path}`, { method: step.method ?? 'POST',
      headers: { Accept: 'application/json', ...(!sample.anonymous && { Authorization: `MediaBrowser Token="${key.AccessToken}"` }),
        ...(body !== undefined && { 'Content-Type': step.contentType ?? 'application/json' }) }, ...(body !== undefined && { body }) });
    const text = await response.text(); let json = null, hasJson = false; try { json = JSON.parse(text); hasJson = true; } catch { }
    observations.push({ status: response.status, body: text, json, hasJson, contentType: response.headers.get('content-type'), allow: response.headers.get('allow') ?? '',
      started, finished: new Date().toISOString(), files: await files(program) });
  }
  const after = await snapshots(), passwordChecks = [];
  for (const user of after.Users) {
    const initial = before.Users.find(row => row.Id === user.Id).Password, changed = user.Password !== initial;
    const hash = parsePasswordHash(user.Password), matches = [];
    for (const pin of new Set(requestedPins)) if (await verifyPasswordHash(hash, pin)) matches.push(pin);
    passwordChecks.push({ id: wireGuid(user.Id), changed, initialMatches: await verifyPasswordHash(hash, 'initial password'), pinMatches: matches });
  }
  const actual = { name: sample.name, ProgramData: program, before, beforeFiles, after, observations, calls, events, passwordChecks, directError,
    catalogs: { authentication: [{ Name: 'Default', Id: 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider' }],
      reset: [{ Name: passwordResets.defaultProvider.name, Id: passwordResets.defaultProvider.id }] } };
  await currentNative.recordCandidate(actual);
  assert.deepEqual(await projectResetObservation(actual), currentNative.projections[index]);
});
