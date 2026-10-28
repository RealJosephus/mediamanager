import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { request as httpRequest, createServer } from 'node:http';
import path from 'node:path';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { createPrivateFilterOutput, filterEvidenceJson } from '../../tools/compat/filter-reference-output.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createWebServerFixture } from '../web/web-fixture.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { projectProblemTrace } from '../helpers/http-body-projection.js';

const enabled = process.env.MEDIAMANAGER_TEST_POSTGRES && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE
  && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE && process.env.MEDIAMANAGER_JELLYFIN_DLL;
const authorization = token => `MediaBrowser Client="Network consumer", Device="Isolated", DeviceId="network-consumer", Version="1"${token ? `, Token="${token}"` : ''}`;
const openPort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject).listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port));
  });
});
const portAvailable = port => new Promise(resolve => {
  const server = createServer();
  server.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});

async function observe(origin, route, { token, method = 'GET', localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(route, origin), { method, localAddress,
      headers: { Accept: 'application/json', Authorization: authorization(token) } }, response => {
      const hash = createHash('sha256'), parts = [];
      let bytes = 0;
      response.on('data', chunk => {
        hash.update(chunk); bytes += chunk.length;
        if (bytes <= 8192) parts.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const contentType = response.headers['content-type'] ?? null;
        const result = { route, method, status: response.statusCode, contentType,
          contentLength: response.headers['content-length'] ?? null, bytes, sha256: hash.digest('hex') };
        if (bytes <= 8192 && contentType?.includes('json')) result.body = parseLosslessJson(Buffer.concat(parts).toString('utf8'));
        resolve(result);
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error('Network consumer request timed out.')));
    request.on('error', reject).end();
  });
}

const networkProjection = response => ({ status: response.status, contentType: response.contentType,
  ...(Object.hasOwn(response, 'body') ? { body: projectProblemTrace(response.body, response.status) } : {}) });

test('network response comparison keeps full content type and only aligns actual ProblemDetails traces', () => {
  const response = { status: 400, contentType: 'application/problem+json; charset=utf-8',
    body: parseLosslessJson('{"status":400,"title":"Bad request","traceId":"request-trace","errors":{"traceId":["literal"]},"Unknown":{"MessageId":"literal","ticks":9223372036854775807}}') };
  const expected = networkProjection(response);
  assert.equal(expected.body.traceId, '$trace');
  assert.deepEqual(expected.body.errors, response.body.errors);
  assert.deepEqual(expected.body.Unknown, { MessageId: 'literal', ticks: 9223372036854775807n });
  const absent = structuredClone(response); delete absent.body.traceId;
  assert.notDeepEqual(networkProjection(absent), expected);
  const invalid = structuredClone(response); invalid.body.traceId = false;
  assert.throws(() => networkProjection(invalid), assert.AssertionError);
  assert.notDeepEqual(networkProjection({ ...response, contentType: 'application/problem+json; charset=utf-16' }), expected);
  assert.notDeepEqual(networkProjection({ ...response, contentType: response.contentType + '; profile="CaseSensitive"' }), expected);
  const success = { ...response, status: 200 }, changed = structuredClone(success); changed.body.traceId = 'other-business-value';
  assert.notDeepEqual(networkProjection(success), networkProjection(changed));
});

test('actual native HTTP endpoint classification and bitrate probes match the production entry', { skip: !enabled, timeout: 240000 }, async () => {
  const destination = path.join(validationOutputRoot(), `client-network-${randomUUID()}`);
  const output = await createPrivateFilterOutput(destination);
  output.addSecret(process.env.MEDIAMANAGER_TEST_POSTGRES);
  await mkdir(output.root);
  const root = await realpath(output.root);
  const report = { cases: [], preparation: {}, cleanup: [] };
  let current, native, fixture, failure;
  const port = await openPort(), origin = `http://127.0.0.1:${port}`;
  try {
    current = await currentNativeReference();
    output.addSecret(current.accessToken);
    report.sourceBindings = await current.sourceBindings(['Jellyfin.Api/Controllers/SystemController.cs',
      'Jellyfin.Api/Controllers/MediaInfoController.cs', 'MediaBrowser.Common/Extensions/HttpContextExtensions.cs']);
    report.input = current.preparation;
    const referenceRoot = path.join(root, 'reference');
    await cp(current.sourceRoot, referenceRoot, { recursive: true,
      filter: filename => !path.relative(current.sourceRoot, filename).replaceAll('\\', '/').startsWith('log/') });
    await mkdir(path.join(referenceRoot, 'log'), { recursive: true });
    await current.prepareClone(referenceRoot, port);
    native = current.start({ referenceRoot, outputRoot: root, label: 'reference', origin });
    await native.ready();
    fixture = await createWebServerFixture({ preparation: report.preparation });
    for (const secret of fixture.secrets) output.addSecret(secret);
    const readerName = `Network_${randomUUID().slice(0, 8)}`, password = randomUUID();
    output.addSecret(password);
    const nativeUser = await fetch(`${origin}/Users/New`, { method: 'POST', headers: {
      Authorization: authorization(current.accessToken), 'Content-Type': 'application/json'
    }, body: JSON.stringify({ Name: readerName, Password: password }) });
    assert.equal(nativeUser.status, 200);
    const login = async (server, Username, Pw) => {
      const response = await fetch(`${server}/Users/AuthenticateByName`, { method: 'POST', headers: {
        Authorization: authorization(), 'Content-Type': 'application/json'
      }, body: JSON.stringify({ Username, Pw }) });
      assert.equal(response.status, 200);
      const body = await response.json();
      output.addSecret(body.AccessToken);
      assert.equal(body.User.Policy.IsAdministrator, false);
      return body.AccessToken;
    };
    const tokens = { native: await login(origin, readerName, password),
      node: await login(fixture.origin, fixture.username, fixture.password) };
    const cases = [
      { route: '/System/Endpoint' },
      { route: '/System/Endpoint', authenticated: true },
      { route: '/System/Endpoint', authenticated: true, localAddress: '127.0.0.2' },
      { route: '/Playback/BitrateTest' },
      ...['', '?size=1', '?size=16', '?size=17', '?size=65536', '?size=65537', '?size=100000000',
        '?size=0', '?size=-1', '?size=100000001', '?size=2147483648', '?size=invalid', '?size=',
        '?size=%20', '?SIZE=%2B17', '?size=17&size=1'].map(query => ({ route: '/Playback/BitrateTest' + query, authenticated: true }))
    ];
    report.mismatches = [];
    for (const item of cases) {
      const options = { localAddress: item.localAddress };
      const pair = { input: item,
        native: await observe(origin, item.route, { ...options, token: item.authenticated ? tokens.native : undefined }),
        node: await observe(fixture.origin, item.route, { ...options, token: item.authenticated ? tokens.node : undefined }) };
      report.cases.push(pair);
      try {
        assert.deepEqual(networkProjection(pair.node), networkProjection(pair.native), item.route);
        if (pair.native.status === 200 && item.route.startsWith('/Playback/BitrateTest')) {
          assert.equal(pair.node.contentLength, pair.native.contentLength, item.route);
          assert.equal(pair.node.bytes, pair.native.bytes, item.route);
          assert.notEqual(pair.node.sha256, pair.native.sha256, 'Independent probes must supply fresh random bytes.');
        }
      } catch (error) { report.mismatches.push({ input: item, message: error.message }); }
    }
    assert.equal(report.mismatches.length, 0, report.mismatches.map(entry => entry.message).join('\n'));
    assert.deepEqual(report.cases[1].node.body, { IsLocal: true, IsInNetwork: true });
    assert.deepEqual(report.cases[2].node.body, { IsLocal: false, IsInNetwork: true });
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    if (native) {
      report.nativeProcess = await native.stop(async () => (await fetch(`${origin}/System/Shutdown`, {
        method: 'POST', headers: { Authorization: authorization(current.accessToken) }
      })).status, () => portAvailable(port));
      if (!report.nativeProcess.cleanShutdown || !report.nativeProcess.pidGone || !report.nativeProcess.portAvailable) {
        failure ??= new Error('Native network consumer did not release its process and port.');
      }
    }
    if (current) {
      try { await current.finish(); }
      catch (error) { failure ??= error; report.inputVerificationFailure = error.message; }
    }
    if (fixture) {
      try { await fixture.close(); report.cleanup.push({ name: 'production-entry-and-postgres', closed: true }); }
      catch (error) { failure ??= error; report.cleanup.push({ name: 'production-entry-and-postgres', closed: false, error: error.message }); }
    }
    await writeFile(path.join(root, 'report.json'), filterEvidenceJson(report));
    await output.publishAndClose();
  }
  if (failure) throw output.publicError(failure);
});
