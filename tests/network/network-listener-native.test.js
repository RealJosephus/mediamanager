import test from 'node:test';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import { createSecureContext, createServer as createTlsServer, connect as connectTls } from 'node:tls';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentNetworkListeners, listenerInput } from './network-listener-current.js';
import { configurationJson } from '../core/fixtures/configuration/observations.js';
import { namedError, namedHash } from '../core/named-configuration-current.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL) });

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const settings = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000 };
const nativeCase = (capture, name, repeat = false) => (repeat ? capture.repeat : capture.native).cases.find(row => row.name === name);
const header = (wire, name) => Object.entries(wire.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]?.[0] ?? null;
const state = row => row.steps.at(-1)?.state ?? row.afterInit;

function normalize(row) {
  const ports = new Map(['$http', '$https', '$nextHttp'].map(key => [row.tokens[key], key]));
  for (const address of row.addresses) { const url = new URL(address); if (!ports.has(Number(url.port))) ports.set(Number(url.port), '$bound-' + url.protocol); }
  // Only instance-owned paths are handled recursively. A numeric value in any
  // unrelated DTO field must survive unchanged, even if it equals a real port.
  const paths = value => {
    if (typeof value === 'string') return value.replaceAll(row.root, '@case').replaceAll(row.root.replaceAll('\\', '/'), '@case');
    if (Array.isArray(value)) return value.map(paths);
    return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, paths(entry)])) : value;
  };
  const port = value => ports.get(value) ?? value;
  const url = value => typeof value !== 'string' ? value : paths(value).replace(
    /^(https?:\/\/[^/?#]*?):([0-9]+)(?=[/?#]|$)/iu,
    (original, authority, value) => ports.has(Number(value)) ? authority + ':' + port(Number(value)) : original);
  const network = value => value == null ? value : { ...paths(value), InternalHttpPort: port(value.InternalHttpPort), InternalHttpsPort: port(value.InternalHttpsPort) };
  const current = value => value == null ? null : { captured: { HttpPort: port(value.captured.HttpPort), HttpsPort: port(value.captured.HttpsPort) },
    ListenWithHttps: value.ListenWithHttps, HasPendingRestart: value.HasPendingRestart,
    configuration: network(value.configuration), IsPortAuthorized: value.system.IsPortAuthorized,
    localUrl: { value: url(value.localUrl.value), failed: value.localUrl.error != null },
    networkDisk: { directory: value.networkDisk.directory, value: network(value.networkDisk.value), failed: value.networkDisk.error != null },
    systemDisk: { directory: value.systemDisk.directory, IsPortAuthorized: value.systemDisk.value?.IsPortAuthorized ?? null, failed: value.systemDisk.error != null },
    metadataDisk: { value: paths(value.metadataDisk.value), failed: value.metadataDisk.error != null } };
  const wire = value => value == null ? null : { status: value.status, text: value.json == null ? paths(value.text) : null,
    json: value.json == null ? null : { HasPendingRestart: value.json.HasPendingRestart, WebSocketPortNumber: port(value.json.WebSocketPortNumber), LocalAddress: url(value.json.LocalAddress) },
    contentType: value.contentType, location: url(header(value, 'location')), transportFailed: value.error != null };
  return { name: row.name, accepted: row.accepted, failed: row.error != null, afterInit: current(row.afterInit),
    steps: row.steps.map(step => ({ index: step.index, response: wire(step.response), failed: step.error != null, state: current(step.state) })),
    probes: row.probes.map(probe => ({ label: probe.label, scheme: new URL(probe.address).protocol,
      ping: wire(probe.ping), forwardedHttps: wire(probe.forwardedHttps), info: wire(probe.info),
      HasPendingRestart: probe.HasPendingRestart, ListenWithHttps: probe.ListenWithHttps, currentUrl: url(probe.currentUrl) })),
    unboundProbes: row.unboundProbes.map(probe => ({ index: probe.index, response: wire(probe.response) })),
    close: row.close.ports.map(port => ({ scheme: new URL(port.address).protocol, connectedAfterClose: port.connectedAfterClose, reboundAfterClose: port.reboundAfterClose })) };
}

function assertClosed(row) {
  assert.deepEqual(row.close.errors, [], row.name + ': no actual cleanup failure');
  for (const port of row.close.ports) {
    assert.equal(port.connectedAfterClose, false, row.name + ': old endpoint rejects a fresh connection');
    assert.ok(port.connectError, row.name + ': full failed connection retained');
    assert.equal(port.reboundAfterClose, true, row.name + ': the actual endpoint can be bound again');
    assert.equal(port.rebindError, null);
  }
}
function assertPeer(capture, probe, expected) {
  assert.equal(probe.ping.status, 200); assert.equal(probe.ping.error, null);
  assert.ok(probe.ping.peers.some(peer => peer.trusted && peer.sha256 === capture.preparedCertificates[expected].derSha256));
}
function assertObservedPeers(capture, wire, expected) {
  // Request owns a fresh handler/client; every callback retained on this wire
  // came from its actual TLS exchange. Callback multiplicity/order is raw only.
  for (const peer of wire.peers) {
    assert.equal(new URL(wire.url).protocol, 'https:', 'A certificate observation belongs to an actual HTTPS request');
    assert.equal(namedHash(Buffer.from(peer.derBase64, 'base64')), peer.sha256);
    assert.equal(peer.sha256, capture.preparedCertificates[expected].derSha256, 'Every observed peer belongs to this actual endpoint certificate');
    assert.equal(peer.trusted, true);
  }
}
function assertRecordedPeers(capture, row, expected) {
  for (const probe of row.probes) {
    for (const wire of [probe.ping, probe.forwardedHttps, probe.info]) assertObservedPeers(capture, wire, expected);
    if (new URL(probe.address).protocol === 'https:') assertPeer(capture, probe, expected);
  }
  for (const step of row.steps) if (step.response) assertObservedPeers(capture, step.response, expected);
  for (const probe of row.unboundProbes) assertObservedPeers(capture, probe.response, expected);
}

test('partial Native listener capture starts real HTTP/TLS, preserves certificate failure fallback and releases each endpoint', settings, nativeCallback(async t => {
  const capture = await currentNetworkListeners({ signal: t.signal });
  const report = { scope: capture.report.scope, partialLimitations: capture.report.partialLimitations, nativeCapture: capture.output,
    comparisons: [], phaseAcceptance: false, releaseAcceptance: false, nodeProductionConformance: false };
  try {
    for (const sample of listenerInput.listeners) {
      const row = nativeCase(capture, sample.name), repeat = nativeCase(capture, sample.name, true);
      report.comparisons.push({ sample, row, repeat });
      for (const actual of [row, repeat]) assertRecordedPeers(capture, actual, sample.name === 'https-b' ? 'b' : 'a');
      assert.deepEqual(normalize(repeat), normalize(row), sample.name + ': independent execution with the same original PFX bytes');
      assertClosed(row); assertClosed(repeat);
      if (sample.name.startsWith('invalid-active-')) {
        assert.equal(row.accepted, false); assert.ok(row.error); assert.ok(row.afterInit, 'Init precedes actual Kestrel range rejection');
        continue;
      }
      assert.equal(row.accepted, true, sample.name); assert.equal(row.error, null);
      if (sample.initial.EnableHttps && ['https-a-and-startup-required-redirect', 'https-b'].includes(sample.name))
        assert.ok(row.probes.some(probe => new URL(probe.address).protocol === 'https:'), 'The selected certificate has an actual reachable TLS endpoint');
      const http = row.probes.find(probe => new URL(probe.address).protocol === 'http:'); assert.ok(http, sample.name + ': actual HTTP response');
      assert.equal(http.ping.status, sample.name === 'https-a-and-startup-required-redirect' ? 307 : 200);
      assert.equal(http.ping.error, null); assert.equal(http.forwardedHttps.status, 200);
      if (sample.name === 'https-a-and-startup-required-redirect') {
        const location = new URL(header(http.ping, 'location'));
        assert.equal(location.protocol, 'https:'); assert.equal(Number(location.port), row.afterInit.captured.HttpsPort);
        assert.equal(location.pathname, '/a/System/Ping'); assert.equal(location.search, '?source=listener%2Fraw&x=1');
      } else if (sample.name !== 'https-b') assert.equal(row.afterInit.ListenWithHttps, false, sample.name + ': actual HTTP fallback without a TLS listener');
      if (sample.name === 'equal-zero-ports-captured-fallback') {
        assert.deepEqual(row.afterInit.captured, { HttpPort: 8096, HttpsPort: 8920 });
        assert.equal(row.afterInit.configuration.InternalHttpPort, 0); assert.equal(row.afterInit.configuration.InternalHttpsPort, 0);
      }
      for (const probe of row.probes) {
        const redirected = new URL(probe.address).protocol === 'http:' && sample.initial.RequireHttps && row.afterInit.ListenWithHttps;
        assert.equal(probe.info.status, redirected ? 307 : 200, 'Actual SystemController/SystemManager remains reachable');
        if (!redirected) {
          assert.equal(probe.info.json.WebSocketPortNumber, row.afterInit.captured.HttpPort, 'SystemManager reports captured port, including zero');
          assert.equal(probe.info.json.HasPendingRestart, false);
        }
      }
    }
  } catch (error) { report.failure = namedError(error); throw error; }
  finally { await writeFile(path.join(capture.output, 'native-listener-observations.json'), configurationJson(report), { flag: 'wx' }); }
}));

test('partial Native AppHost updates expose saved authorization/certificate failure prefixes and keep startup TLS/middleware', settings, nativeCallback(async t => {
  const capture = await currentNetworkListeners({ signal: t.signal });
  const report = { scope: capture.report.scope, nativeCapture: capture.output, comparisons: [], phaseAcceptance: false, releaseAcceptance: false,
    eventBoundary: 'Actual synchronous named handler and actual queued system handler; log identities/counts are raw diagnostics only.' };
  try {
    for (const sample of listenerInput.effects) {
      const row = nativeCase(capture, sample.name), repeat = nativeCase(capture, sample.name, true);
      report.comparisons.push({ sample, row, repeat }); assert.equal(row.accepted, true, sample.name); assert.equal(row.error, null);
      for (const actual of [row, repeat]) assertRecordedPeers(capture, actual, 'a');
      if (sample.initial.EnableHttps) assert.ok(row.probes.some(probe => new URL(probe.address).protocol === 'https:'), 'Startup TLS remains an actual endpoint');
      assert.deepEqual(normalize(repeat), normalize(row), sample.name + ': independent current/public/persistent prefix');
      assertClosed(row); assertClosed(repeat);
      const failedWire = sample.name === 'port-and-missing-certificate-retain-saved-prefix' ? 404
        : sample.name === 'nested-system-file-failure-retains-live-authorization-prefix' ? 500 : null;
      for (const step of row.steps) {
        assert.equal(step.error, null, sample.name + ': fixture operation completed'); assert.equal(step.barrierError, null, 'Actual queued operation reached its completion boundary');
        if (step.response) {
          assert.equal(step.response.status, failedWire ?? 204); assert.equal(step.response.error, null);
          assert.equal(step.response.text, failedWire ? 'Error processing request.' : '');
          if (failedWire) assert.ok(row.operationFailures.some(failure => failure.owner.index === step.index && failure.error), 'Full original controller failure retained');
        }
      }
      const last = state(row);
      for (const event of row.events) assert.equal(event.observationError, null, 'Evidence capture must preserve the original operation rather than adding a new failure');
      if (sample.name === 'ports-change-saves-authorization-before-pending') {
        assert.equal(last.HasPendingRestart, true); assert.equal(last.system.IsPortAuthorized, false); assert.equal(last.systemDisk.value.IsPortAuthorized, false);
        assert.equal(last.networkDisk.value.InternalHttpPort, row.tokens.$nextHttp);
      } else if (sample.name === 'port-and-missing-certificate-retain-saved-prefix') {
        assert.equal(last.HasPendingRestart, false); assert.equal(last.system.IsPortAuthorized, false); assert.equal(last.systemDisk.value.IsPortAuthorized, false);
        assert.equal(last.networkDisk.value.CertificatePath, capture.preparedCertificates.missing);
        assert.ok(row.events.some(event => event.phase === 'queued-system-updated' && !event.accepted && event.error), 'Actual queued failure retained after named 404');
      } else if (sample.name === 'nested-system-file-failure-retains-live-authorization-prefix') {
        assert.equal(last.HasPendingRestart, false); assert.equal(last.system.IsPortAuthorized, false);
        assert.equal(last.systemDisk.directory, true); assert.equal(last.systemDisk.bytes, null);
        assert.equal(row.finalFiles.originalSystem.value.IsPortAuthorized, true); assert.equal(last.networkDisk.value.InternalHttpPort, row.tokens.$nextHttp);
      } else if (sample.name === 'existing-invalid-certificate-only-marks-restart') {
        assert.equal(last.HasPendingRestart, true); assert.equal(last.networkDisk.value.CertificatePath, capture.preparedCertificates.bad.filename);
      } else if (sample.name === 'any-named-update-reads-canonical-network') {
        assert.equal(last.HasPendingRestart, true); assert.equal(last.systemDisk.value.IsPortAuthorized, false);
        assert.equal(last.configuration.InternalHttpPort, row.tokens.$nextHttp); assert.equal(last.networkDisk.value.InternalHttpPort, row.tokens.$http);
        assert.equal(last.metadataDisk.value.UseFileCreationTimeForDateAdded, true);
      } else if (sample.name === 'system-update-returns-before-queued-certificate-failure') {
        assert.equal(last.HasPendingRestart, false); assert.equal(last.systemDisk.value.IsPortAuthorized, true);
        assert.ok(row.events.some(event => event.phase === 'queued-system-updated' && !event.accepted && event.error), 'Original queued error does not replace delivered 204');
      } else if (sample.name === 'hot-enable-uses-loaded-certificate-without-new-tls-listener') {
        assert.equal(last.HasPendingRestart, false); assert.equal(last.ListenWithHttps, true);
        assert.equal(new URL(last.localUrl.value).protocol, 'https:');
        assert.ok(row.unboundProbes.some(probe => probe.response.status === null && probe.response.error), 'Actual new TLS connection still fails after hot enable');
      } else assert.equal(last.HasPendingRestart, false);
      for (const probe of row.probes) {
        if (new URL(probe.address).protocol !== 'https:') assert.equal(probe.ping.status, sample.initial.RequireHttps ? 307 : 200, 'Actual startup redirect choice survives hot RequireHttps/EnableHttps changes');
        assert.equal(probe.info.status, new URL(probe.address).protocol === 'http:' && sample.initial.RequireHttps ? 307 : 200);
        if (probe.info.status === 200) assert.equal(probe.info.json.HasPendingRestart, probe.HasPendingRestart);
      }
    }
  } catch (error) { report.failure = namedError(error); throw error; }
  finally { await writeFile(path.join(capture.output, 'native-host-update-observations.json'), configurationJson(report), { flag: 'wx' }); }
}));

async function nodePfxObservation(capture, name, observations, signal) {
  const material = capture.preparedCertificates[name], pfx = await readFile(material.file.filename);
  const observation = { name, input: material.file, expectedPeerDerSha256: material.derSha256,
    context: { accepted: false, error: null }, serverConstruction: null, clientConnection: null, handshake: null, diagnostics: [], close: null };
  observations.push(observation);
  let server, client, port, primary, phase = 'context';
  const endpoints = socket => ({ local: { address: socket.localAddress ?? null, port: socket.localPort ?? null },
    remote: { address: socket.remoteAddress ?? null, port: socket.remotePort ?? null } });
  try {
    signal.throwIfAborted();
    try { createSecureContext({ pfx, passphrase: capture.preparedCertificates.password }); observation.context.accepted = true; }
    catch (error) { observation.context.error = namedError(error); return observation; }
    phase = 'serverConstruction';
    try {
      server = createTlsServer({ pfx, passphrase: capture.preparedCertificates.password }, socket => socket.end('listener-pfx-roundtrip'));
      observation.serverConstruction = { accepted: true, error: null };
    } catch (error) {
      observation.serverConstruction = { accepted: false, error: namedError(error) };
      if (name === 'certificateOnly') return observation;
      throw error;
    }
    // Retain the failing TLS socket's actual endpoints. An unrelated failed
    // client exchange alone cannot authorize a server diagnostic.
    server.on('tlsClientError', (error, socket) => observation.diagnostics.push({ phase, connection: endpoints(socket), error: namedError(error) }));
    phase = 'listen';
    const listening = once(server, 'listening', { signal }); server.listen(0, '127.0.0.1'); await listening; port = server.address().port;
    signal.throwIfAborted();
    phase = 'handshake';
    observation.handshake = await new Promise((resolve, reject) => {
      const chunks = []; let peer, finished = false;
      const finish = value => { if (finished) return; finished = true; signal.removeEventListener('abort', aborted); resolve(value); };
      const aborted = () => {
        if (finished) return; finished = true;
        signal.removeEventListener('abort', aborted);
        observation.handshake = { accepted: false, cancelled: true, error: namedError(signal.reason), peer: peer ?? null, bodyBase64: Buffer.concat(chunks).toString('base64') };
        reject(signal.reason);
      };
      client = connectTls({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false }, () => {
        const certificate = client.getPeerCertificate(); peer = { derBase64: certificate.raw?.toString('base64') ?? null,
          sha256: certificate.raw ? namedHash(certificate.raw) : null, authorized: client.authorized, authorizationError: namedError(client.authorizationError) };
      });
      client.once('connect', () => { observation.clientConnection = endpoints(client); });
      client.on('data', chunk => chunks.push(chunk));
      client.once('error', error => finish({ accepted: false, error: namedError(error), peer: peer ?? null, bodyBase64: Buffer.concat(chunks).toString('base64') }));
      client.once('end', () => finish({ accepted: peer != null, error: null, peer: peer ?? null, bodyBase64: Buffer.concat(chunks).toString('base64') }));
      client.once('close', () => finish({ accepted: false, error: null, closedBeforeCompletion: true, peer: peer ?? null, bodyBase64: Buffer.concat(chunks).toString('base64') }));
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
    if (name !== 'certificateOnly') {
      assert.equal(observation.handshake.accepted, true); assert.equal(observation.handshake.peer.sha256, material.derSha256);
      assert.equal(Buffer.from(observation.handshake.bodyBase64, 'base64').toString(), 'listener-pfx-roundtrip');
    }
    // Cert-only loading/handshake is observed as it actually behaves in Node.
    // Its constructor acceptance is not treated as a private-key predicate.
    if (observation.handshake.accepted) {
      assert.equal(observation.handshake.peer.sha256, material.derSha256);
      assert.equal(Buffer.from(observation.handshake.bodyBase64, 'base64').toString(), 'listener-pfx-roundtrip');
    }
  } catch (error) { primary = error; observation.failure = namedError(error); }
  finally {
    phase = 'close';
    const errors = [];
    if (client) try { const closed = client.closed ? Promise.resolve() : new Promise(resolve => client.once('close', resolve)); client.destroy(); await closed; }
    catch (error) { errors.push(error); }
    if (server) try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } catch (error) { errors.push(error); }
    for (const diagnostic of observation.diagnostics) try {
      assert.equal(diagnostic.phase, 'handshake', 'Listener/close diagnostics cannot be reclassified as a handshake failure');
      const connection = observation.clientConnection;
      assert.ok(connection, 'The client reached this actual TCP connection');
      assert.notEqual(connection.local.address, null); assert.notEqual(connection.local.port, null);
      assert.notEqual(connection.remote.address, null); assert.notEqual(connection.remote.port, null);
      assert.deepEqual(diagnostic.connection.local, connection.remote, 'Diagnostic server endpoint is this client connection remote endpoint');
      assert.deepEqual(diagnostic.connection.remote, connection.local, 'Diagnostic remote endpoint is this client connection local endpoint');
      assert.equal(observation.handshake?.accepted, false);
      assert.ok(observation.handshake.error || observation.handshake.closedBeforeCompletion || observation.handshake.cancelled,
        'Optional server TLS error belongs to this actual failed/cancelled handshake');
    } catch (error) { errors.push(error); }
    if (port) {
      const rebound = createTcpServer();
      try { const listening = once(rebound, 'listening'); rebound.listen(port, '127.0.0.1'); await listening; observation.close = { port, rebound: true }; }
      catch (error) { observation.close = { port, rebound: false, error: namedError(error) }; errors.push(error); }
      finally { if (rebound.listening) try { await new Promise((resolve, reject) => rebound.close(error => error ? reject(error) : resolve())); } catch (error) { errors.push(error); } }
    }
    observation.cleanupErrors = errors.map(namedError);
    if (errors.length) throw new AggregateError(primary ? [primary, ...errors] : errors, 'PFX observation cleanup failed.', { cause: primary ?? errors[0] });
  }
  if (primary) throw primary;
  return observation;
}

test('the sealed Native PFX A/B/cert-only inputs have actual Node TLS context and handshake observations', settings, nativeCallback(async t => {
  const capture = await currentNetworkListeners({ signal: t.signal });
  const report = { scope: 'Actions-only built-in Node TLS observation of the same prepared PFX bytes. This is not a production certificate loader or Native cert-only predicate.',
    nativeCapture: capture.output, observations: [], phaseAcceptance: false, releaseAcceptance: false, nodeProductionConformance: false };
  try {
    for (const name of ['a', 'b', 'certificateOnly']) {
      const observation = await nodePfxObservation(capture, name, report.observations, t.signal);
      if (name !== 'certificateOnly') assert.equal(observation.context.accepted, true, name + ': actual sealed certificate/key loads');
    }
  } catch (error) { report.failure = namedError(error); throw error; }
  finally { await writeFile(path.join(capture.output, 'node-pfx-observations.json'), configurationJson(report), { flag: 'wx' }); }
}));
