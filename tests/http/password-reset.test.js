import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createApplication } from '../../src/http/application.js';
import { DomainStore } from '../../src/database/domain-store.js';
import { UserService, AuthenticationService, ApiKeyService, PasswordResetService } from '../../src/users/index.js';
import { parsePasswordHash, verifyPasswordHash } from '../../src/core/password.js';
import { md5Guid } from '../../src/core/identity.js';
import { wireGuid } from '../../src/users/native.js';
import { recordedInputPath, validationOutputRoot } from '../../tools/validation/paths.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString } from '../database/postgres-fixture.js';
import { normalizeSnapshot, projectResetObservation } from './fixtures/password-reset/observations.js';

void JSON.parse(await fs.readFile(new URL('./fixtures/password-reset/required-inputs.json', import.meta.url)));
const fixture = new URL('./fixtures/password-reset/', import.meta.url);
const [inputBytes, nativeBytes, proofBytes] = await Promise.all(['input.json', 'native.json', 'provenance.json'].map(name => fs.readFile(new URL(name, fixture))));
const input = JSON.parse(inputBytes), native = JSON.parse(nativeBytes), proof = JSON.parse(proofBytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const enabled = { skip: !postgresTestConnectionString };

test('password reset recording binds actual MVC, UserManager, EF SQLite, crypto and instance files', async () => {
  assert.equal(hash(inputBytes), proof.inputSha256); assert.equal(hash(nativeBytes), proof.nativeSha256);
  assert.equal(hash(await fs.readFile(recordedInputPath(proof.rawRecording, [proof.nativeSha256]))), proof.nativeSha256);
  assert.equal(native.inputSha256, proof.inputSha256);
  for (const name of ['actualController', 'actualBinding', 'actualUserManager', 'actualDefaultProvider', 'actualEfSqlite', 'actualCrypto', 'eventsControlled', 'networkControlled']) assert.equal(native[name], true);
  assert.equal(proof.build.status, 0); assert.equal(proof.process.status, 0); assert.equal(proof.sourcesStable, true);
  assert.equal(proof.completeBuildInputClosure, false); assert.equal(proof.phaseAcceptance, false);
  assert.equal(proof.repeat.sameInputAndOracleSources, true);
  assert.equal(hash(await fs.readFile(recordedInputPath(proof.repeat.filename, [proof.repeat.sha256]))), proof.repeat.sha256);
  assert.equal(hash(await fs.readFile(new URL('observations.js', fixture))), proof.repeat.comparisonSha256);
  for (const row of proof.sources) for (const root of ['D:/jellyfin', proof.jellyfin.buildSource]) assert.equal(hash(await fs.readFile(recordedInputPath(path.join(root, row.filename), [row.sha256]))), row.sha256, row.filename);
  for (const row of proof.oracleSources) assert.equal(hash(await fs.readFile(row.filename === 'Directory.Build.props'
    ? new URL('../Directory.Build.props', import.meta.url) : new URL(row.filename, fixture))), row.sha256, row.filename);
  for (const row of [...proof.assemblies, ...proof.nativeLibraries, proof.sqliteRuntime]) assert.equal(hash(await fs.readFile(recordedInputPath(row.filename, [row.sha256]))), row.sha256, row.filename);
  assert.deepEqual(native.results.map(row => row.name), input.map(row => row.name));
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

for (const sample of input) test(`postgres: actual native password reset ${sample.mode === 'snapshot' ? 'user snapshot' : 'HTTP'}, files, rows and failure prefix: ${sample.name}`, enabled, async t => {
  assert.match(sample.name, /^[a-z-]+$/u);
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
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
  const expected = native.results.find(row => row.name === sample.name);
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
  assert.deepEqual(normalizeSnapshot(before), normalizeSnapshot(expected.before), 'the candidate begins with exactly the recorded database input');
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
  app = await createApplication({ configuration: { IsStartupWizardCompleted: true }, users, authentication, passwordResets });
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
    observations.push({ status, body: status === 200 ? '' : 'Error processing request.', json: null, contentType: null, allow: '', started,
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
    const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch { }
    observations.push({ status: response.status, body: text, json, contentType: response.headers.get('content-type'), allow: response.headers.get('allow') ?? '',
      started, finished: new Date().toISOString(), files: await files(program) });
  }
  const after = await snapshots(), passwordChecks = [];
  for (const user of after.Users) {
    const initial = before.Users.find(row => row.Id === user.Id).Password, changed = user.Password !== initial;
    const hash = parsePasswordHash(user.Password), matches = [];
    for (const pin of new Set(requestedPins)) if (await verifyPasswordHash(hash, pin)) matches.push(pin);
    passwordChecks.push({ id: wireGuid(user.Id), changed, initialMatches: changed ? await verifyPasswordHash(hash, 'initial password') : true, pinMatches: matches });
  }
  const actual = { name: sample.name, ProgramData: program, before, after, observations, calls, events, passwordChecks, directError,
    catalogs: { authentication: [{ Name: 'Default', Id: 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider' }],
      reset: [{ Name: passwordResets.defaultProvider.name, Id: passwordResets.defaultProvider.id }] } };
  const evidence = path.join(output, 'password-reset'); await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(path.join(evidence, sample.name + '.json'), JSON.stringify(actual, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value, 2) + '\n');
  assert.deepEqual(await projectResetObservation(actual), await projectResetObservation(expected));
});
