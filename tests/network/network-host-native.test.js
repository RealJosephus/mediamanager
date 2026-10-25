import test from 'node:test';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createServer as createTcpServer, connect as connectTcp } from 'node:net';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { once } from 'node:events';
import { NetworkHost } from '../../src/network/host.js';
import { NetworkService } from '../../src/network/network-service.js';
import { ServerConfigurationStore } from '../../src/core/server-configuration-store.js';
import { NamedConfigurationStore } from '../../src/core/named-configuration-store.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { readConfigurationFile, writeConfigurationFile } from '../../src/core/configuration-file.js';
import { createApplication } from '../../src/http/application.js';
import { localStateStorage } from '../helpers/local-state-storage.js';
import { currentNetworkListeners } from './network-listener-current.js';
import { configurationJson } from '../core/fixtures/configuration/observations.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { namedError, namedHash } from '../core/named-configuration-current.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { describeFile } from '../../tools/validation/inventory.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL) });

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const settings = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000 };
const payload = value => value == null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(payload)
  : Object.fromEntries(Object.getOwnPropertyNames(value).filter(name => !(value instanceof Error && ['name', 'stack'].includes(name)))
    .map(name => [name, payload(value[name])]));
const bytesValue = bytes => ({ bytes: bytes.length, sha256: namedHash(bytes), base64: bytes.toString('base64') });
const mime = value => value?.split(';')[0].toLowerCase();
const header = (wire, name) => Object.entries(wire.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]?.[0] ?? null;
const snapshotValue = value => parseLosslessJson(configurationJson(value));

async function closeServer(server) {
  if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function ports() {
  const servers = [], errors = [], selected = [];
  try {
    for (let index = 0; index < 3; index++) {
      const server = createTcpServer(); servers.push(server);
      const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
      selected.push(server.address().port);
    }
  } catch (error) { errors.push(error); }
  finally { for (const server of servers) try { await closeServer(server); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, 'Controlled listener input ports could not be prepared.', { cause: errors[0] });
  return selected;
}

async function released(entry, report) {
  const observation = { scheme: entry.scheme, address: entry.address, port: entry.port, connected: false, connectionFailure: null, rebound: false };
  report.release.push(observation);
  let socket, rebound;
  const errors = [];
  try {
    await new Promise(resolve => {
      socket = connectTcp({ host: entry.address, port: entry.port });
      socket.once('connect', () => { observation.connected = true; resolve(); });
      socket.once('error', error => { observation.connectionFailure = namedError(error); resolve(); });
    });
    assert.equal(observation.connected, false); assert.ok(observation.connectionFailure);
    rebound = createTcpServer();
    const listening = once(rebound, 'listening'); rebound.listen(entry.port, entry.address); await listening;
    observation.rebound = true;
  } catch (error) { errors.push(error); }
  finally {
    if (socket) try {
      const closed = socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve)); socket.destroy(); await closed;
    } catch (error) { errors.push(error); }
    try { await closeServer(rebound); } catch (error) { errors.push(error); }
    observation.failures = errors.map(namedError);
  }
  if (errors.length) throw new AggregateError(errors, 'The actual listener endpoint was not completely released.', { cause: errors[0] });
}

async function fixture(t, label, httpPort, httpsPort) {
  const captured = await currentNetworkListeners({ signal: t.signal });
  const root = path.join(captured.output, 'production-host-' + label); await fs.mkdir(root);
  const report = { schemaVersion: 1, scope: 'Partial production Node NetworkService/NetworkHost, real Server/Named stores and Local metadata I/O, createApplication and controlled administrator authorization. Actual HTTP/TLS, XML and resource ownership. No PostgreSQL, full Runtime/FindParts/FFmpeg/UDP, real authentication graph or whole Native server claim.',
    nativeCapture: captured.output, requests: [], states: [], diagnostics: [], diagnosticValidationFailures: [], release: [], cleanup: [],
    phaseAcceptance: false, releaseAcceptance: false };
  const state = { root, captured, report, signal: t.signal };
  const diagnose = source => (error, context = {}) => {
    report.diagnostics.push({ source, error: namedError(error), comparisonPayload: payload(error),
      context: { phase: context.phase, filename: context.filename,
        request: context.request ? { method: context.request.method, url: context.request.url, headers: context.request.headers } : null } });
    try {
      assert.ok(state.expectedDiagnostic, 'Every optional diagnostic must belong to an actual operation in this component.');
      assert.deepEqual(payload(error), payload(state.expectedDiagnostic));
      if (source === 'http') {
        assert.equal(context.phase, 'action'); assert.equal(context.request.method, 'POST');
        assert.equal(context.request.url, '/a/System/Configuration/network');
      } else assert.equal(source, 'server-configuration-event');
    } catch (failure) { report.diagnosticValidationFailures.push(namedError(failure)); }
  };
  t.after(async () => {
    const errors = [];
    const attempt = async (owner, operation) => {
      try { await operation(); report.cleanup.push({ owner, completed: true }); }
      catch (error) { report.cleanup.push({ owner, error: namedError(error) }); errors.push(error); }
    };
    await attempt('application-admission', () => state.application?.beginClose());
    await attempt('application-requests', () => state.application?.drainRequests());
    await attempt('websocket-owner', () => state.application?.webSockets?.close());
    await attempt('named-store', () => state.named?.close());
    await attempt('server-store', () => state.server?.close());
    await attempt('network-host', () => state.host?.close());
    if (state.host) for (const entry of state.host.listeners) {
      if (!entry.bound) continue;
      await attempt('released-' + entry.scheme, () => released(entry, report));
    }
    await attempt('network-service', () => state.network?.close());
    await attempt('local-storage', () => state.storage?.close());
    await attempt('original-native-certificate-bytes', async () => {
      report.originalsAfter = [];
      for (const original of captured.report.prepare.material) {
        const after = await describeFile(original.filename); report.originalsAfter.push(after);
        assert.equal(after.available, true); assert.equal(after.bytes, original.size); assert.equal(after.sha256, original.sha256);
      }
    });
    await attempt('diagnostic-ownership', () => assert.deepEqual(report.diagnosticValidationFailures, []));
    report.cleanupFailures = errors.map(namedError);
    try { await fs.writeFile(path.join(root, 'report.json'), configurationJson(report), { flag: 'wx' }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Network host component cleanup failed.', { cause: errors[0] });
  });
  try {
    const config = path.join(root, 'config'); await fs.mkdir(config);
    const programDataPath = path.join(root, 'data');
    state.paths = { programDataPath, defaultMetadataPath: path.join(programDataPath, 'metadata'),
      metadataPath: path.join(programDataPath, 'metadata'), cachePath: path.join(programDataPath, 'cache') };
    state.storage = await localStateStorage(root);
    const configuration = { ...defaultConfiguration('server'), UICulture: 'en-US', ServerName: 'Network host component',
      IsStartupWizardCompleted: true, IsPortAuthorized: true };
    const networkConfiguration = { ...defaultConfiguration('network'), BaseUrl: '/a', EnableIPv4: true, EnableIPv6: false,
      LocalNetworkAddresses: ['127.0.0.1'], KnownProxies: ['127.0.0.1'], AutoDiscovery: false,
      InternalHttpPort: httpPort, InternalHttpsPort: httpsPort, EnableHttps: true, RequireHttps: true,
      CertificatePath: captured.preparedCertificates.a.file.filename, CertificatePassword: captured.preparedCertificates.password };
    await writeConfigurationFile(path.join(config, 'system.xml'), 'server', configuration);
    await writeConfigurationFile(path.join(config, 'network.xml'), 'network', networkConfiguration);
    state.server = new ServerConfigurationStore({ configuration, configurationDirectoryPath: config,
      applicationPaths: state.paths, metadataFileSystem: state.storage.fileSystem, onError: diagnose('server-configuration-event') });
    await state.server.initialize();
    state.named = new NamedConfigurationStore({ configurationDirectoryPath: config, onError: diagnose('named-store') });
    await state.named.getConfiguration('network');
    const getNetworkConfiguration = () => state.named.getCurrentConfiguration('network');
    state.network = new NetworkService({ getNetworkConfiguration, namedConfiguration: state.named,
      getApplicationHost: () => state.host, getInterfaces: () => [{ address: '127.0.0.1', prefixLength: 8, name: 'lo', index: 1 }],
      logger: { error: diagnose('network-service') } });
    await state.network.initialize();
    state.host = new NetworkHost({ network: state.network, getNetworkConfiguration,
      getSystemConfiguration: () => state.server.configuration, configurationStore: state.server, namedConfiguration: state.named,
      onError: diagnose('network-host') });
    await state.host.initialize();
    state.application = await createApplication({ get configuration() { return state.server.configuration; },
      getNetworkConfiguration, configurationStore: state.server, namedConfiguration: state.named, applicationPaths: state.paths,
      network: state.network, networkHost: state.host, baseUrl: state.host.baseUrl, serverId: 'network-host-component',
      getSmartApiUrl: request => state.network.getSmartApiUrl(request), onError: diagnose('http'),
      authentication: { async authenticate() { return { IsAuthenticated: true, IsAdministrator: true, IsApiKey: true }; }, authorize() {} } });
    state.snapshot = async label => {
      const current = { label, captured: { HttpPort: state.host.httpPort, HttpsPort: state.host.httpsPort },
        ListenWithHttps: state.host.listenWithHttps, HasPendingRestart: state.host.hasPendingRestart,
        configuration: snapshotValue(getNetworkConfiguration()), system: snapshotValue(state.server.configuration),
        localUrl: state.network.getLocalApiUrl('127.0.0.1'),
        files: {} };
      for (const [name, kind] of [['system.xml', 'server'], ['network.xml', 'network']]) {
        const filename = path.join(config, name), bytes = await fs.readFile(filename);
        current.files[name] = { filename, ...bytesValue(bytes), value: snapshotValue(await readConfigurationFile(filename, kind)) };
      }
      report.states.push(current); return current;
    };
    return state;
  } catch (error) { report.failure = namedError(error); throw error; }
}

async function wire(state, entry, route, { body, forwardedHttps = false } = {}) {
  const observation = { scheme: entry.scheme, address: entry.address, port: entry.port, route, method: body === undefined ? 'GET' : 'POST',
    requestBody: body === undefined ? null : configurationJson(body), requestHeaders: { Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(forwardedHttps ? { 'X-Forwarded-Proto': 'https' } : {}) }, peer: null };
  state.report.requests.push(observation);
  try {
    await new Promise((resolve, reject) => {
      const request = (entry.scheme === 'https' ? requestHttps : requestHttp)({ host: entry.address, port: entry.port, path: route,
        method: observation.method, headers: observation.requestHeaders, agent: false, rejectUnauthorized: false, servername: 'localhost', signal: state.signal }, response => {
        const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.once('error', reject);
        response.once('end', () => {
          try {
            const bytes = Buffer.concat(chunks); Object.assign(observation, { status: response.statusCode, headers: response.headers,
              contentType: response.headers['content-type'], ...bytesValue(bytes), text: bytes.toString('utf8') });
            if (mime(observation.contentType) === 'application/json' && bytes.length) observation.json = parseLosslessJson(bytes.toString());
            resolve();
          } catch (error) { reject(error); }
        });
      });
      request.once('error', reject);
      request.once('socket', socket => {
        if (entry.scheme !== 'https') return;
        socket.once('secureConnect', () => {
          const certificate = socket.getPeerCertificate(); observation.peer = { ...bytesValue(certificate.raw),
            authorized: socket.authorized, authorizationError: namedError(socket.authorizationError) };
        });
      });
      if (body !== undefined) request.write(observation.requestBody);
      request.end();
    });
    if (entry.scheme === 'https') {
      assert.equal(observation.peer.sha256, state.captured.preparedCertificates.a.derSha256);
      assert.deepEqual(Buffer.from(observation.peer.base64, 'base64'), await fs.readFile(state.captured.preparedCertificates.a.certificate.filename));
    }
    return observation;
  } catch (error) { observation.error = namedError(error); throw error; }
}

test('production host serves Native certificate A and preserves redirect, captured ports and a failed named-update save prefix', settings, nativeCallback(async t => {
  const [httpPort, httpsPort, nextPort] = await ports();
  const state = await fixture(t, 'wire-and-update', httpPort, httpsPort), { captured, report, host } = state;
  try {
    const nativeInitial = captured.native.cases.find(row => row.name === 'startup-required-redirect-survives-hot-disable');
    const repeatInitial = captured.repeat.cases.find(row => row.name === nativeInitial.name);
    const nativePrefix = captured.native.cases.find(row => row.name === 'port-and-missing-certificate-retain-saved-prefix');
    const repeatPrefix = captured.repeat.cases.find(row => row.name === nativePrefix.name);
    report.nativeReferences = { initial: nativeInitial, repeatInitial, failedPrefix: nativePrefix, repeatPrefix,
      boundary: 'The Node scenario composes the recorded startup-required redirect and fixed-port missing-certificate save-prefix contracts. Native prefix case RequireHttps=false; the Node POST uses TLS, so startup redirect does not alter that action. No unrecorded whole Native combination is claimed.' };
    await host.start(state.application);
    const http = host.listeners.find(entry => entry.scheme === 'http'), https = host.listeners.find(entry => entry.scheme === 'https');
    assert.ok(http?.bound); assert.ok(https?.bound);
    assert.equal(host.httpPort, httpPort); assert.equal(host.httpsPort, httpsPort);
    const build = await verifyNativeBuild(), resourcePath = 'Emby.Server.Implementations/Localization/Core/en-US.json';
    assert.equal(build.identitySha256, captured.report.build.identitySha256);
    const manifest = JSON.parse(await fs.readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json')));
    const resource = await describeFile(path.join(build.root, 'source', resourcePath));
    assert.equal(resource.sha256, manifest.files.find(entry => entry.path === resourcePath).sha256);
    const loading = JSON.parse(await fs.readFile(resource.filename)).StartupEmbyServerIsLoading;
    report.startupResource = { relative: resourcePath, original: resource, value: loading, boundary: 'Actual sealed Native en-US resource; Native listener fixture omits the startup-message gate.' };
    const blocked = await wire(state, https, '/a/System/Info');
    assert.equal(blocked.status, 503); assert.equal(mime(blocked.contentType), 'text/html'); assert.equal(blocked.text, loading);
    assert.equal((await wire(state, https, '/a/System/Ping')).status, 200);
    host.completeStartup();
    const rawPath = '/a/System/Ping?source=listener%2Fraw&x=1';
    const redirect = await wire(state, http, rawPath);
    assert.equal(redirect.status, 307); assert.equal(redirect.headers.location, 'https://127.0.0.1:' + httpsPort + rawPath);
    for (const row of [nativeInitial, repeatInitial]) {
      const original = row.probes.find(probe => probe.label === 'initial' && probe.address.startsWith('http:'));
      assert.equal(redirect.status, original.ping.status);
      assert.equal(new URL(header(original.ping, 'location')).pathname + new URL(header(original.ping, 'location')).search, rawPath);
      assert.equal((await wire(state, http, '/a/System/Ping?forwarded=true', { forwardedHttps: true })).status, original.forwardedHttps.status);
    }
    const info = await wire(state, https, '/a/System/Info');
    assert.equal(info.status, 200); assert.equal(info.json.WebSocketPortNumber, httpPort); assert.equal(info.json.HasPendingRestart, false);
    for (const row of [nativeInitial, repeatInitial]) {
      const original = row.probes.find(probe => probe.label === 'initial' && probe.address.startsWith('https:'));
      assert.equal(info.status, original.info.status); assert.equal(mime(info.contentType), mime(original.info.contentType));
      assert.equal(original.info.json.WebSocketPortNumber, row.afterInit.captured.HttpPort);
      assert.equal(info.json.HasPendingRestart, original.info.json.HasPendingRestart);
    }
    const before = await state.snapshot('before-named-update');
    const missing = path.join(state.root, 'missing.pfx'); let missingCause;
    try { await fs.stat(missing); assert.fail('The controlled next certificate must actually be absent.'); } catch (error) { assert.equal(error.code, 'ENOENT'); missingCause = error; }
    state.expectedDiagnostic = Object.assign(new Error(`Certificate file '${missing}' does not exist.`, { cause: missingCause }), { code: 'ENOENT', status: 404 });
    const next = { ...before.configuration, InternalHttpPort: nextPort, CertificatePath: missing };
    const saved = await wire(state, https, '/a/System/Configuration/network', { body: next });
    const after = await state.snapshot('failed-named-update-prefix');
    for (const row of [nativePrefix, repeatPrefix]) {
      assert.equal(saved.status, row.steps[0].response.status); assert.equal(mime(saved.contentType), mime(row.steps[0].response.contentType));
      assert.equal(after.system.IsPortAuthorized, row.steps[0].state.system.IsPortAuthorized);
      assert.equal(after.HasPendingRestart, row.steps[0].state.HasPendingRestart);
      assert.equal(row.steps[0].state.configuration.InternalHttpPort, row.tokens.$nextHttp);
    }
    assert.equal(saved.status, 404); assert.equal(after.system.IsPortAuthorized, false); assert.equal(after.HasPendingRestart, false);
    assert.equal(after.files['system.xml'].value.IsPortAuthorized, false);
    assert.equal(after.configuration.InternalHttpPort, nextPort); assert.equal(after.configuration.CertificatePath, missing);
    assert.equal(after.files['network.xml'].value.InternalHttpPort, nextPort); assert.equal(after.files['network.xml'].value.CertificatePath, missing);
    assert.equal(host.httpPort, httpPort); assert.equal(host.httpsPort, httpsPort); assert.equal(host.listenWithHttps, true);
    assert.equal((await wire(state, https, '/a/System/Ping')).status, 200);
    const oldInfo = await wire(state, https, '/a/System/Info'); assert.equal(oldInfo.json.WebSocketPortNumber, httpPort);
    assert.equal((await wire(state, http, rawPath)).headers.location, redirect.headers.location);
  } catch (error) { report.failure = namedError(error); throw error; }
}));

test('a second TLS bind failure keeps the original EADDRINUSE and releases the first real HTTP listener', settings, nativeCallback(async t => {
  const blocker = createTcpServer();
  t.after(() => closeServer(blocker));
  const listening = once(blocker, 'listening'); blocker.listen(0, '127.0.0.1'); await listening;
  const occupied = blocker.address(), state = await fixture(t, 'second-bind-failure', 0, occupied.port);
  state.report.occupiedInput = occupied;
  try {
    await assert.rejects(state.host.start(state.application), error => {
      state.report.startupFailure = namedError(error);
      assert.equal(error.code, 'EADDRINUSE'); assert.equal(error.syscall, 'listen'); assert.equal(error.port, occupied.port); return true;
    });
    const first = state.host.listeners.find(entry => entry.scheme === 'http');
    assert.ok(first?.bound); assert.ok(first.port > 0); assert.equal(first.server.listening, false);
    state.report.failedListeners = state.host.listeners.map(entry => ({ scheme: entry.scheme, address: entry.address, port: entry.port, bound: entry.bound, listening: entry.server.listening }));
    await released(first, state.report);
    assert.equal(blocker.listening, true, 'The foreign listener used to cause the bind failure retains its own lifecycle.');
    state.report.failureBoundary = 'Actual Node second-listener EADDRINUSE and first-listener rollback. No Native occupied-port capture or full Runtime startup is inferred.';
  } catch (error) { state.report.failure = namedError(error); throw error; }
}));
