import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createWebServerFixture } from '../web/web-fixture.js';

const enabled = process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE
  && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const authorization = token => `MediaBrowser Client="Configuration consumer", Device="Isolated", DeviceId="configuration-consumer", Version="1"${token ? `, Token="${token}"` : ''}`;
const portAvailable = port => new Promise(resolve => {
  const server = createServer();
  server.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});
const unusedPort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject).listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port));
  });
});

test('public server configuration read matches actual native schema and authorization with real resume settings', { skip: !enabled, timeout: 180000 }, async () => {
  const output = await createPrivateFilterOutput(path.join(validationOutputRoot(), `configuration-read-${randomUUID()}`));
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root), port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const report = { cases: [], preparation: {}, cleanup: [] };
  let current, native, fixture, failure;
  const request = async (server, route, { token, body, method = 'GET' } = {}) => {
    const response = await fetch(`${server}${route}`, { method, headers: { Authorization: authorization(token),
      Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, contentType: response.headers.get('content-type'), body: text ? JSON.parse(text) : null };
  };
  try {
    current = await currentNativeReference();
    output.addSecret(current.accessToken);
    report.input = current.preparation;
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/ConfigurationController.cs',
      'MediaBrowser.Model/Configuration/ServerConfiguration.cs']);
    const referenceRoot = path.join(root, 'reference');
    await cp(current.sourceRoot, referenceRoot, { recursive: true,
      filter: filename => !path.relative(current.sourceRoot, filename).replaceAll('\\', '/').startsWith('log/') });
    await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
    await current.prepareClone(referenceRoot, port);
    native = current.start({ referenceRoot, outputRoot: root, label: 'reference', origin });
    await native.ready();
    const original = await request(origin, '/System/Configuration', { token: current.accessToken });
    assert.equal(original.status, 200);
    const policy = { MinResumePct: 1, MaxResumePct: 90, MinResumeDurationSeconds: 30 };
    assert.equal((await request(origin, '/System/Configuration', { method: 'POST', token: current.accessToken,
      body: { ...original.body, ...policy } })).status, 204);
    fixture = await createWebServerFixture({ resumePlayback: true, preparation: report.preparation });
    for (const secret of fixture.secrets) output.addSecret(secret);
    const name = `Configuration_${randomUUID().slice(0, 8)}`, password = randomUUID();
    output.addSecret(password);
    assert.equal((await request(origin, '/Users/New', { method: 'POST', token: current.accessToken,
      body: { Name: name, Password: password } })).status, 200);
    const login = async (server, Username, Pw) => {
      const result = await request(server, '/Users/AuthenticateByName', { method: 'POST', body: { Username, Pw } });
      assert.equal(result.status, 200);
      assert.equal(result.body.User.Policy.IsAdministrator, false);
      output.addSecret(result.body.AccessToken);
      return result.body.AccessToken;
    };
    const tokens = { native: await login(origin, name, password), node: await login(fixture.origin, fixture.username, fixture.password) };
    for (const mode of ['anonymous', 'invalid', 'ordinary-user']) {
      const token = type => mode === 'ordinary-user' ? tokens[type] : mode === 'invalid' ? 'invalid-configuration-token' : undefined;
      const pair = { mode, native: await request(origin, '/System/Configuration', { token: token('native') }),
        node: await request(fixture.origin, '/System/Configuration', { token: token('node') }) };
      report.cases.push(pair);
      assert.equal(pair.node.status, pair.native.status);
      if (mode === 'ordinary-user') {
        assert.equal(pair.native.status, 200);
        assert.deepEqual(Object.keys(pair.node.body).sort(), Object.keys(pair.native.body).sort(),
          'Expose the complete native configuration DTO without Node runtime helpers.');
        for (const [key, value] of Object.entries(policy)) {
          assert.equal(pair.native.body[key], value); assert.equal(pair.node.body[key], value);
        }
        assert.equal(Object.hasOwn(pair.node.body, 'NetworkConfiguration'), false);
        assert.equal(Object.hasOwn(pair.node.body, 'BaseUrl'), false);
      } else assert.equal(pair.node.status, 401);
    }
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    if (native) {
      report.nativeProcess = await native.stop(async () => (await fetch(`${origin}/System/Shutdown`, {
        method: 'POST', headers: { Authorization: authorization(current.accessToken) }
      })).status, () => portAvailable(port));
      if (!report.nativeProcess.cleanShutdown || !report.nativeProcess.pidGone || !report.nativeProcess.portAvailable) failure ??= new Error('Native configuration process did not stop cleanly.');
    }
    if (current) try { await current.finish(); } catch (error) { failure ??= error; report.inputVerificationFailure = error.message; }
    if (fixture) try { await fixture.close(); report.cleanup.push({ name: 'production-entry-and-postgres', closed: true }); }
    catch (error) { failure ??= error; report.cleanup.push({ name: 'production-entry-and-postgres', closed: false, error: error.message }); }
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report));
    await output.publishAndClose();
  }
  if (failure) throw output.publicError(failure);
});
