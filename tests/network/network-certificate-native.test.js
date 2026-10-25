import test from 'node:test';
import { declareNativeHttpTestFile } from '../helpers/native-http-test-file.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createServer as createHttpServer, get as getHttps } from 'node:https';
import { connect as connectTcp, createServer as createTcpServer } from 'node:net';
import { createSecureContext } from 'node:tls';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerCertificate } from '../../src/network/certificate.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { currentNetworkListeners } from './network-listener-current.js';
import { configurationJson } from '../core/fixtures/configuration/observations.js';
import { namedError, namedHash } from '../core/named-configuration-current.js';

const nativeCallback = declareNativeHttpTestFile({ enabled: Boolean(process.env.MEDIAMANAGER_JELLYFIN_DLL) });

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const settings = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000 };
const endpoints = socket => ({ local: { address: socket.localAddress ?? null, port: socket.localPort ?? null },
  remote: { address: socket.remoteAddress ?? null, port: socket.remotePort ?? null } });
const errorPayload = value => value == null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(errorPayload)
  : Object.fromEntries(Object.getOwnPropertyNames(value).filter(name => !(value instanceof Error && ['name', 'stack'].includes(name)))
    .map(name => [name, errorPayload(value[name])]));
const details = name => ({ name, stack: 'Preserved ordinary business stack value.', context: { name: 'certificate-input', stack: 'Preserved nested context stack value.' } });
const controlledReason = () => Object.assign(new Error('Controlled certificate startup cancellation.', {
  cause: Object.assign(new Error('Original shutdown reason.'), { code: 'shutdown-request', details: details('shutdown-cause') }),
}), { code: 'startup-cancelled', status: 499, statusCode: 499,
  details: details('startup-shutdown'), owner: { name: 'certificate-startup', stack: 'Preserved ordinary owner stack value.' },
  errors: [new Error('First original shutdown detail.'), new Error('Second original shutdown detail.')] });

async function recorded(t, label, action) {
  const capture = await currentNetworkListeners({ signal: t.signal });
  const report = { schemaVersion: 1, label, nativeCapture: capture.output,
    scope: 'Production Node createSecureContext certificate loading from the same Actions-prepared Native PFX/DER originals. Actual HTTPS peer/body I/O and endpoint release; the loader itself owns no transport. No private key/type predicate, full Native server or runtime startup conformance claim.',
    sourceInputs: [], loads: [], exchanges: [], endpointRelease: [], immutableInputsAfter: [],
    phaseAcceptance: false, releaseAcceptance: false, cleanup: {} };
  let primary, failed = false;
  const cleanup = [];
  try {
    for (const relative of ['../../src/network/certificate.js', './network-certificate-native.test.js']) {
      report.sourceInputs.push(await describeFile(fileURLToPath(new URL(relative, import.meta.url))));
    }
    await action(capture, report);
  } catch (error) { failed = true; primary = error; report.failure = namedError(error); }
  finally {
    for (const original of capture.report.prepare.material) try {
      const after = await describeFile(original.filename); report.immutableInputsAfter.push(after);
      assert.equal(after.available, true); assert.equal(after.bytes, original.size); assert.equal(after.sha256, original.sha256);
    } catch (error) { cleanup.push(error); }
    report.cleanup.inputFailures = cleanup.map(namedError);
    try { await fs.writeFile(path.join(capture.output, 'production-certificate-' + label + '.json'), configurationJson(report), { flag: 'wx' }); }
    catch (error) { cleanup.push(error); }
  }
  if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup,
    'Certificate fixture operation and cleanup failed.', { cause: failed ? primary : cleanup[0] });
  if (failed) throw primary;
}

async function releasedEndpoint(listener, report) {
  if (!listener) return;
  const result = { listener, connectedAfterClose: false, connectError: null, rebound: false, cleanup: [] };
  report.endpointRelease.push(result);
  let socket, rebound, primary, failed = false;
  const cleanup = [];
  try {
    await new Promise(resolve => {
      socket = connectTcp({ host: listener.address, port: listener.port });
      socket.once('connect', () => { result.connectedAfterClose = true; resolve(); });
      socket.once('error', error => { result.connectError = namedError(error); resolve(); });
    });
    assert.equal(result.connectedAfterClose, false, 'The actual temporary listener rejects a new connection after loading');
    assert.ok(result.connectError, 'Keep the original failed connection payload');
    rebound = createTcpServer();
    const listening = once(rebound, 'listening'); rebound.listen(listener.port, listener.address); await listening;
    result.rebound = true;
  } catch (error) { failed = true; primary = error; result.failure = namedError(error); }
  finally {
    if (socket) try {
      const closed = socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve));
      socket.destroy(); await closed;
    } catch (error) { cleanup.push(error); }
    if (rebound?.listening) try { await new Promise((resolve, reject) => rebound.close(error => error ? reject(error) : resolve())); }
    catch (error) { cleanup.push(error); }
    result.cleanup = cleanup.map(namedError);
  }
  if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup,
    'Certificate endpoint release observation failed.', { cause: failed ? primary : cleanup[0] });
  if (failed) throw primary;
}

function errorObserver(row, expected) {
  return (error, observation) => {
    row.failures.push({ error: namedError(error), observation: namedError(observation),
      comparisonPayload: errorPayload(error), originalComparisonPayload: errorPayload(observation.original) });
    assert.ok(expected, 'A successful, blank, missing or directory input has no failing operation to diagnose.');
    assert.equal(observation.filename, row.filename);
    assert.equal(observation.phase, expected.phase);
    assert.equal(observation.cancelled, expected.cancelled ?? false);
    assert.deepEqual(errorPayload(error), errorPayload(expected.error));
    assert.deepEqual(errorPayload(observation.original), errorPayload(expected.original ?? expected.error));
  };
}

async function load(capture, report, name, filename, password, options = {}) {
  const { diagnostic, ...loaderOptions } = options;
  const row = { name, filename, failures: [], reference: diagnostic == null ? null : {
    phase: diagnostic.phase, cancelled: diagnostic.cancelled ?? false,
    error: namedError(diagnostic.error), original: namedError(diagnostic.original ?? diagnostic.error),
    comparisonPayload: errorPayload(diagnostic.error), originalComparisonPayload: errorPayload(diagnostic.original ?? diagnostic.error),
    input: diagnostic.input, boundary: diagnostic.boundary,
  } }; report.loads.push(row);
  let result, primary, failed = false;
  try {
    result = await loadServerCertificate({ filename, password, ...loaderOptions, onError: errorObserver(row, diagnostic) });
    row.accepted = result !== null;
    if (result) row.pfx = { bytes: result.pfx.length, sha256: namedHash(result.pfx) };
  } catch (error) { failed = true; primary = error; row.thrown = namedError(error); }
  if (failed) throw primary;
  return result;
}

async function publicPfxFailure(filename, passphrase) {
  const pfx = await fs.readFile(filename);
  let failure;
  try { createSecureContext({ pfx, ...(passphrase === undefined ? {} : { passphrase }) }); }
  catch (error) { failure = error; }
  assert.ok(failure, 'This same sealed input must actually fail in the independent public Node TLS call.');
  return { phase: 'parse', error: failure, input: { filename, bytes: pfx.length, sha256: namedHash(pfx), passphraseSupplied: passphrase !== undefined },
    boundary: 'Independent direct public Node createSecureContext on the same exact sealed PFX bytes and explicitly declared password input. This is a Node original-error reference, not a Native exception identity or an independent PKCS12 implementation.' };
}

async function httpsExchange(options, expected, report, signal) {
  const result = { expectedPeerDerSha256: expected.derSha256, peer: null, wire: null, diagnostics: [], cleanup: {} };
  report.exchanges.push(result);
  const body = 'Production certificate HTTPS roundtrip.', sockets = new Set(), closed = [], cleanup = [];
  let server, request, listener, primary, failed = false, closing = false;
  const own = socket => {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    closed.push(socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve)));
    socket.on('error', error => result.diagnostics.push({ phase: 'socket', connection: endpoints(socket), error: namedError(error) }));
    if (closing) socket.destroy();
  };
  try {
    server = createHttpServer(options, (request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(body);
    });
    server.on('connection', own); server.on('secureConnection', own);
    server.on('tlsClientError', (error, socket) => { own(socket); result.diagnostics.push({ phase: 'server-tls', connection: endpoints(socket), error: namedError(error) }); });
    const listening = once(server, 'listening', { signal }); server.listen(0, '127.0.0.1'); await listening;
    listener = server.address(); result.listener = listener;
    await new Promise((resolve, reject) => {
      request = getHttps({ host: '127.0.0.1', port: listener.port, path: '/', servername: 'localhost', agent: false, rejectUnauthorized: false, signal }, response => {
        const chunks = [];
        response.on('data', bytes => chunks.push(bytes)); response.once('error', reject);
        response.once('end', () => {
          const bytes = Buffer.concat(chunks);
          result.wire = { status: response.statusCode, headers: response.headers, bodyBase64: bytes.toString('base64'), bytes: bytes.length, sha256: namedHash(bytes) };
          resolve();
        });
      });
      request.once('error', reject);
      request.once('socket', socket => {
        own(socket);
        socket.once('secureConnect', () => {
          const peer = socket.getPeerCertificate();
          result.peer = { connection: endpoints(socket), derBase64: peer.raw?.toString('base64') ?? null,
            derSha256: peer.raw ? namedHash(peer.raw) : null, authorized: socket.authorized, authorizationError: namedError(socket.authorizationError) };
        });
      });
    });
    assert.equal(result.peer.derSha256, expected.derSha256);
    assert.deepEqual(Buffer.from(result.peer.derBase64, 'base64'), await fs.readFile(expected.certificate.filename));
    assert.equal(result.wire.status, 200); assert.equal(Buffer.from(result.wire.bodyBase64, 'base64').toString(), body);
  } catch (error) { failed = true; primary = error; result.failure = namedError(error); }
  finally {
    closing = true;
    const serverClosed = server ? new Promise(resolve => { server.once('close', resolve); server.close(); }) : null;
    try { request?.destroy(); } catch (error) { cleanup.push(error); }
    for (const socket of sockets) try { socket.destroy(); } catch (error) { cleanup.push(error); }
    if (serverClosed) try { await serverClosed; } catch (error) { cleanup.push(error); }
    await Promise.all(closed);
    result.cleanup = { listenerClosed: server ? !server.listening : true, connectionsClosed: [...sockets].every(socket => socket.closed), errors: cleanup.map(namedError) };
    try { await releasedEndpoint(listener, report); } catch (error) { cleanup.push(error); }
  }
  if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup,
    'Certificate HTTPS exchange and cleanup failed.', { cause: failed ? primary : cleanup[0] });
  if (failed) throw primary;
}

test('production certificate loading serves sealed Native A and B PFX bytes with the exact HTTPS peer DER', settings, nativeCallback(async t => {
  await recorded(t, 'accepted', async (capture, report) => {
    for (const [name, nativeName] of [['a', 'https-a-and-startup-required-redirect'], ['b', 'https-b']]) {
      const native = capture.native.cases.find(row => row.name === nativeName), repeat = capture.repeat.cases.find(row => row.name === nativeName);
      assert.equal(native.accepted, true); assert.equal(repeat.accepted, true);
      assert.equal(native.afterInit.ListenWithHttps, true); assert.equal(repeat.afterInit.ListenWithHttps, true);
      const material = capture.preparedCertificates[name];
      const options = await load(capture, report, name, material.file.filename, capture.preparedCertificates.password, { signal: t.signal });
      assert.ok(options); assert.equal(namedHash(options.pfx), material.file.sha256);
      await httpsExchange(options, material, report, t.signal);
    }
    const disabled = capture.native.cases.find(row => row.name === 'hot-enable-uses-loaded-certificate-without-new-tls-listener');
    assert.equal(disabled.afterInit.configuration.EnableHttps, false);
    assert.equal(disabled.steps.at(-1).state.ListenWithHttps, true);
    report.nativeDisabledHttpsEvidence = { before: disabled.afterInit, after: disabled.steps.at(-1).state,
      boundary: 'The loader takes certificate path/password independently of EnableHttps. NetworkHost startup/hot-switch integration is a separate consumer test.' };
  });
}));

test('production certificate loading returns no TLS options for sealed Native missing, bad, wrong-password and certificate-only inputs', settings, nativeCallback(async t => {
  await recorded(t, 'fallback', async (capture, report) => {
    const prepared = capture.preparedCertificates;
    const cases = [
      ['missing', prepared.missing, prepared.password, 'missing-pfx-http-survives'],
      ['bad', prepared.bad.filename, prepared.password, 'bad-pfx-http-survives'],
      ['wrong-password', prepared.a.file.filename, 'wrong-password', 'wrong-password-http-survives'],
      ['certificate-only', prepared.certificateOnly.file.filename, prepared.password, 'certificate-only-http-survives'],
    ];
    for (const [name, filename, password, nativeName] of cases) {
      for (const native of [capture.native, capture.repeat]) {
        const row = native.cases.find(entry => entry.name === nativeName);
        assert.equal(row.accepted, true); assert.equal(row.afterInit.ListenWithHttps, false);
      }
      const diagnostic = name === 'missing' ? undefined : await publicPfxFailure(filename, password);
      assert.equal(await load(capture, report, name, filename, password, { signal: t.signal, diagnostic }), null);
    }
    for (const filename of [null, undefined, '', ' \t\u0085\u2028', path.dirname(prepared.a.file.filename)]) {
      assert.equal(await load(capture, report, 'blank-or-directory', filename, prepared.password, { signal: t.signal }), null);
    }
    for (const [password, referencePassword] of [[null, undefined], [undefined, undefined], ['', undefined], [' \t\u0085\u2028', undefined],
      [' ' + prepared.password, ' ' + prepared.password], [prepared.password + '\u0085', prepared.password + '\u0085'], ['\ufeff', '\ufeff']]) {
      const diagnostic = await publicPfxFailure(prepared.a.file.filename, referencePassword);
      assert.equal(await load(capture, report, 'password-preserved-or-blank', prepared.a.file.filename, password, { signal: t.signal, diagnostic }), null);
    }
    report.passwordBoundary = 'Whitespace passwords are supplied against this same protected PFX and fail without rewriting it; nonblank surrounding whitespace is retained. No unprotected PFX/password oracle was prepared by this Native fixture.';
  });
}));

test('certificate startup cancellation preserves its full reason and drains an admitted real file read', settings, nativeCallback(async t => {
  await recorded(t, 'cancelled', async (capture, report) => {
    const material = capture.preparedCertificates.a, password = capture.preparedCertificates.password;
    const before = new AbortController(), beforeReason = controlledReason(); before.abort(beforeReason);
    await assert.rejects(load(capture, report, 'already-cancelled', material.file.filename, password, { signal: before.signal,
      diagnostic: { phase: 'stat', cancelled: true, error: beforeReason, boundary: 'Actual original already-aborted startup signal reason; no file operation is admitted.' } }), error => {
      assert.deepEqual(errorPayload(error), errorPayload(beforeReason)); return true;
    });

    const controller = new AbortController(), reason = controlledReason();
    const signal = AbortSignal.any([controller.signal, t.signal]);
    let entered, release;
    const admitted = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const read = { filename: material.file.filename, bytes: null, sha256: null, closedHandleFailure: null }; report.realRead = read;
    const fileSystem = { stat: fs.stat, async readFile(filename, options) {
      const handle = await fs.open(filename, 'r'); let primary, failed = false;
      try {
        const bytes = await handle.readFile(options); read.bytes = bytes.length; read.sha256 = namedHash(bytes); entered();
        const aborted = () => release(); signal.addEventListener('abort', aborted, { once: true });
        try { if (signal.aborted) release(); await gate; } finally { signal.removeEventListener('abort', aborted); }
        return bytes;
      } catch (error) { failed = true; primary = error; throw error; }
      finally {
        try { await handle.close(); } catch (error) { throw new AggregateError(failed ? [primary, error] : [error], 'Controlled certificate file read cleanup failed.', { cause: failed ? primary : error }); }
        try { await handle.stat(); assert.fail('A closed real certificate handle must reject further I/O.'); }
        catch (error) { read.closedHandleFailure = namedError(error); assert.equal(error.code, 'EBADF'); }
      }
    } };
    const operation = load(capture, report, 'admitted-file-read', material.file.filename, password, { fileSystem, signal,
      diagnostic: { phase: 'read', cancelled: true, error: reason, boundary: 'Actual original signal reason after the admitted FileHandle read and complete physical handle close.' } });
    const settled = operation.then(value => ({ value }), error => ({ error }));
    await Promise.race([admitted, settled.then(result => { throw result.error ?? new Error('The certificate operation ended before its real file read.'); })]);
    controller.abort(reason);
    const outcome = await settled;
    assert.deepEqual(errorPayload(outcome.error), errorPayload(reason));
    assert.equal(read.sha256, material.file.sha256); assert.equal(read.closedHandleFailure.code, 'EBADF');

    report.cancellationBoundary = 'Pre-aborted startup and an admitted real file read are cancelled by the original reason, after the actual handle closes. The loader uses public createSecureContext and owns no transport; real HTTPS endpoints are independently exercised and released by the accepted-input test.';
  });
}));

test('certificate fallback and cancellation retain a real file reader failure followed by its post-close failure', settings, nativeCallback(async t => {
  await recorded(t, 'read-cleanup-failure', async (capture, report) => {
    const material = capture.preparedCertificates.a;
    for (const cancelled of [false, true]) {
      const controller = new AbortController(), reason = controlledReason();
      const primary = Object.assign(new Error('Controlled certificate file read failure.', {
        cause: Object.assign(new Error('Original certificate file read cause.'), { code: 'original-read' }),
      }), { code: 'EIO', status: 507, statusCode: 507, details: details('actual-certificate-read'),
        owner: { name: 'real-file-reader', filename: material.file.filename, stack: 'Ordinary reader ownership detail.' }, errors: [new Error('Original read detail.')] });
      const cleanup = Object.assign(new Error('Controlled certificate failure after actual handle close.', {
        cause: Object.assign(new Error('Original certificate close cause.'), { code: 'original-close' }),
      }), { code: 'EIO', status: 503, statusCode: 503, details: details('post-actual-handle-close'),
        owner: { name: 'actual-handle-release', filename: material.file.filename, stack: 'Ordinary close ownership detail.' },
        errors: [new Error('First close detail.'), new Error('Second close detail.')] });
      const source = Object.assign(new AggregateError([primary, cleanup], 'Certificate reader and handle release failed.', { cause: primary }),
        { code: primary.code, status: primary.status, statusCode: primary.statusCode,
          details: details('read-and-release'), owner: { name: 'certificate-file-system', stack: 'Ordinary file-system context.' } });
      const read = { cancelled, originalRead: namedError(primary), postCloseFailure: namedError(cleanup), bytesRead: null, closedHandleFailure: null };
      (report.readFailures ??= []).push(read);
      const fileSystem = { stat: fs.stat, async readFile(filename) {
        const handle = await fs.open(filename, 'r');
        let failure;
        try {
          const actual = await handle.read(Buffer.alloc(64), 0, 64, 0); read.bytesRead = actual.bytesRead;
          if (cancelled) controller.abort(reason);
          throw primary;
        } catch (error) { failure = error; }
        try {
          await handle.close();
          try { await handle.stat(); assert.fail('A closed real certificate handle must reject further I/O.'); }
          catch (error) { read.closedHandleFailure = namedError(error); assert.equal(error.code, 'EBADF'); }
        } catch (error) { throw new AggregateError([failure, error], 'Certificate controlled reader cleanup failed.', { cause: failure }); }
        throw source;
      } };
      const expected = cancelled ? Object.assign(new AggregateError([reason, source], 'Certificate loading was cancelled after a file operation failed.', { cause: reason }),
        { code: reason.code, status: reason.status, statusCode: reason.statusCode }) : source;
      const operation = load(capture, report, cancelled ? 'cancelled-read-and-close' : 'read-and-close', material.file.filename,
        capture.preparedCertificates.password, { fileSystem, signal: AbortSignal.any([controller.signal, t.signal]),
          diagnostic: { phase: 'read', cancelled, error: expected, original: source,
            boundary: 'Controlled original reader error and post-release error after this exact file was really read and its handle really closed. Cancellation retains the actual original reason before that complete source failure.' } });
      if (cancelled) await assert.rejects(operation, error => {
        assert.deepEqual(errorPayload(error), errorPayload(expected));
        return true;
      });
      else assert.equal(await operation, null);
      assert.ok(read.bytesRead > 0); assert.equal(read.closedHandleFailure.code, 'EBADF');
    }
  });
}));
