import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setImmediate as immediate } from 'node:timers/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LiveTvCountriesClient } from '../../src/core/live-tv-countries.js';
import { createTestApplication } from '../helpers/application.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { errorObservation } from '../helpers/error-observation.js';

const downloaded = Buffer.concat([Buffer.from([0xff, 0, 0xef, 0xbb, 0xbf]), Buffer.alloc(196731, 0x6d), Buffer.from('\0not JSON\n')]);
const sentinel = Buffer.from('A distinct physical cache sentinel.\0\xff', 'latin1');
const route = '/LiveTv/ListingProviders/SchedulesDirect/Countries';
const structured = message => Object.assign(new Error(message, { cause: { name: 'business-cause', stack: 'business-cause-stack', value: undefined } }),
  { code: 'COUNTRIES_CONTROLLED', status: 503, statusCode: 509, errors: [false, 0, '', null, undefined], optional: undefined });
const reasons = () => [['false', false], ['zero', 0], ['empty-string', ''], ['null', null], ['undefined', undefined],
  ['structured', structured('The country operation failed after actual I/O.')],
  ['business', { message: 'The business transport failed.', name: 'business-name', stack: 'business-stack',
    code: 'BUSINESS_COUNTRIES', status: 502, statusCode: 508, httpStatus: 504, cause: undefined, errors: [null, false, undefined] }]];
const functional = value => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(functional);
  const keys = value instanceof Error ? [...new Set(['message', ...Object.getOwnPropertyNames(value)])]
    .filter(key => !['name', 'stack'].includes(key)) : Object.keys(value);
  return Object.fromEntries(keys.map(key => [key, functional(value[key])]));
};
const sameReason = (actual, expected) => assert.deepEqual(functional(actual), functional(expected));
const outcome = operation => Promise.resolve(operation).then(value => ({ failed: false, value }), error => ({ failed: true, error }));
const observed = value => ({ type: typeof value, value: errorObservation(value) });
const describe = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const closeServer = server => server?.listening ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : undefined;
async function pending(operation, message) {
  let settled = false; operation.then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, message);
}

async function fixture(t, definition = {}) {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'countries-failures-'));
  const files = path.join(root, 'files'), cachePath = path.join(files, 'cache'), evidence = path.join(root, 'evidence');
  const filename = path.join(cachePath, 'sd-countries.json');
  await fs.mkdir(cachePath, { recursive: true }); await fs.mkdir(evidence);
  const clients = [], operations = [], handles = [], requests = [], sockets = new Map(), opened = Promise.withResolvers();
  const fault = { enabled: true, ...definition };
  const report = { scope: 'Actual country HTTP route/upstream, raw physical cache bytes and owned Node file descriptors.',
    definition: { mode: definition.mode, prefixBytes: definition.prefixBytes, primary: observed(definition.primary), cleanup: observed(definition.cleanup) },
    assertions: {}, observations: {}, files: {}, cleanup: {}, phaseAcceptance: false, releaseAcceptance: false,
    serialization: 'Original binary observations are separate files. Error name/stack are diagnostics; plain business fields are retained. JSON omits own undefined object values and renders undefined array entries as null. In-process functional comparisons preserve their types, values and own presence.' };
  let application, countryStats = 0, wireIndex = 0, component;
  const server = createServer((request, response) => {
    const status = fault.enabled ? fault.upstreamStatus ?? 200 : 200;
    requests.push({ method: request.method, target: request.url, status, body: describe(downloaded) });
    response.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Content-Length': downloaded.length }); response.end(downloaded);
  });
  server.on('connection', socket => {
    const closed = Promise.withResolvers(); sockets.set(socket, closed.promise);
    socket.once('close', () => { sockets.delete(socket); closed.resolve(); });
  });
  t.after(async () => {
    const errors = [], attempt = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
    for (const state of handles) state.release.resolve();
    await Promise.allSettled(operations);
    let clientsDrained = true;
    for (const client of clients) try { await client.close(); } catch (error) { clientsDrained = false; errors.push(error); }
    // Emergency fixture disposal never supplies the earlier operation's release evidence.
    for (const state of handles) await attempt(() => state.file.close());
    if (application) {
      await attempt(() => application.beginClose()); await attempt(() => application.drainRequests());
      application.server.closeAllConnections(); await attempt(() => closeServer(application.server));
    }
    const socketClosures = [...sockets.values()]; server.closeAllConnections(); await attempt(() => closeServer(server));
    await Promise.all(socketClosures);
    report.cleanup.httpServersStopped = !server.listening && !application?.server.listening;
    report.cleanup.clientsDrained = clientsDrained; report.cleanup.handles = handles.map(state => ({ fd: state.fd, immediateAfterClose: state.immediateAfterClose }));
    await attempt(async () => {
      assert.equal(path.dirname(files), root); assert.equal(path.dirname(root), output);
      await fs.rm(files, { recursive: true, force: true }); report.cleanup.fixtureFilesRemoved = true;
    });
    report.requests = requests; report.cleanup.errors = errors.map(observed);
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    if (errors.length) throw new AggregateError(errors, 'Country failure fixture cleanup failed.', { cause: errors[0] });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening', { signal: t.signal });
  const url = 'http://127.0.0.1:' + server.address().port + '/countries';
  const retain = async (name, bytes) => {
    await fs.writeFile(path.join(evidence, name), bytes); report.files[name] = describe(bytes); return bytes;
  };
  await retain('expected-download.bin', downloaded);
  const fileSystem = { ...fs,
    async stat(target, ...args) {
      const value = await fs.stat(target, ...args);
      if (target === filename) {
        (report.observations.cacheStats ??= []).push({ ...value });
        if (fault.enabled && fault.mode === 'stat' && ++countryStats === 2) {
          report.observations.statFault = 'Controlled rejection after the second delegated real cache stat.';
          throw fault.primary;
        }
      }
      return value;
    },
    async open(target, ...args) {
      const file = await fs.open(target, ...args);
      if (target !== filename || args[0] !== 'w') return file;
      const selected = fault.enabled ? fault.mode : undefined;
      const state = { file, fd: file.fd, entered: Promise.withResolvers(), release: Promise.withResolvers(), immediateAfterClose: null };
      handles.push(state); opened.resolve(state);
      if (!fault.gated || !fault.enabled) state.release.resolve();
      return {
        async writeFile(bytes) {
          if (selected === 'write' || selected === 'write-close') {
            await file.writeFile(bytes.subarray(0, fault.prefixBytes ?? 65536)); throw fault.primary;
          }
          return file.writeFile(bytes);
        },
        async close() {
          state.entered.resolve(); await state.release.promise;
          await file.close();
          // The same integer may be reused later. Observe EBADF immediately,
          // synchronously, before any subsequent await or filesystem open.
          try { state.immediateAfterClose = { stillOpen: true, size: fstatSync(state.fd).size }; }
          catch (error) { state.immediateAfterClose = errorObservation(error); }
          if (selected === 'write-close') throw fault.cleanup;
          if (selected === 'close') throw fault.primary;
        },
      };
    },
  };
  const open = () => {
    const client = new LiveTvCountriesClient({ cachePath, url, fileSystem, timeoutMs: 10000,
      fetch: async (...args) => {
        const response = await fetch(...args);
        const consume = async () => {
          const bytes = Buffer.from(await response.arrayBuffer());
          await retain('upstream-failure-body.bin', bytes); return bytes;
        };
        if (fault.enabled && fault.mode === 'fetch') { await consume(); throw fault.primary; }
        if (fault.enabled && fault.mode === 'body') return new Proxy(response, { get(target, key) {
          if (key === 'arrayBuffer') return async () => { await consume(); throw fault.primary; };
          const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
        } });
        return response;
      } });
    clients.push(client); return client;
  };
  const client = open();
  const get = (owner = client) => { const operation = owner.getCountries(); operations.push(operation); return operation; };
  const released = async () => {
    for (const state of handles) assert.equal(state.immediateAfterClose?.code, 'EBADF', 'The operation closed its actual cache descriptor before reporting its result.');
    report.assertions.actualDescriptorReleasedBeforeFixtureCleanup = true;
  };
  return { client, report, filename, handles, opened: opened.promise, fault, open, get, retain, requests, released,
    async http() {
      application ??= await createTestApplication({ configuration: { UICulture: 'en-US', IsStartupWizardCompleted: true },
        liveTvSources: { async getCountries() {
          const result = await outcome(get()); component = result;
          if (result.failed) throw result.error; return result.value;
        } },
        authentication: { async authenticate() { return { IsAuthenticated: true, IsApiKey: true, IsAdministrator: true }; }, authorize() {} },
        onError: error => { (report.observations.httpDiagnostics ??= []).push(observed(error)); },
      });
      if (!application.server.listening) { application.server.listen(0, '127.0.0.1'); await once(application.server, 'listening', { signal: t.signal }); }
      const response = await fetch('http://127.0.0.1:' + application.server.address().port + route,
        { signal: AbortSignal.any([t.signal, AbortSignal.timeout(15000)]) });
      const bytes = await retain('http-' + wireIndex++ + '.body.bin', Buffer.from(await response.arrayBuffer()));
      await application.drainRequests();
      const wire = { status: response.status, headers: Object.fromEntries(response.headers), body: describe(bytes) };
      (report.observations.http ??= []).push(wire); return { ...wire, bytes, component };
    },
    async cacheAndRecovery(expected, { originalClosed = false } = {}) {
      assert.deepEqual(await retain('cache-after-failure.bin', await fs.readFile(filename)), expected);
      fault.enabled = false;
      const requestCount = requests.length, fresh = open();
      assert.deepEqual(await get(fresh), expected, 'A fresh partial or empty cache remains valid raw cached data.');
      assert.equal(requests.length, requestCount, 'Reading the fresh failure prefix cannot trigger another download.');
      assert.deepEqual(await retain('cache-after-fresh-read.bin', await fs.readFile(filename)), expected);
      await fs.writeFile(filename, sentinel); await retain('cache-sentinel.bin', await fs.readFile(filename));
      if (!originalClosed) assert.deepEqual(await get(), sentinel, 'A failed write or close did not publish the downloaded bytes to memory.');
      assert.equal(requests.length, requestCount);
      await fs.unlink(filename);
      const recovered = open(); assert.deepEqual(await get(recovered), downloaded);
      assert.equal(requests.length, requestCount + 1, 'The explicitly removed cache is recovered by a real new HTTP download.');
      assert.deepEqual(await retain('cache-recovered.bin', await fs.readFile(filename)), downloaded);
      const recoveredRequests = requests.length;
      await fs.writeFile(filename, sentinel);
      assert.deepEqual(await get(recovered), downloaded, 'A fully written and closed download is retained in memory.');
      assert.equal(requests.length, recoveredRequests);
      report.assertions.freshFailurePrefixReadWithoutDownload = true;
      if (!originalClosed) report.assertions.failureDidNotPublishMemory = true;
      report.assertions.explicitRemovalAndNewClientRecoveredRawBytes = true;
      await released();
    },
  };
}

test('country fetch and body failures retain original reasons through complete real HTTP 500 responses', { timeout: 120000 }, async t => {
  for (const mode of ['fetch', 'body']) for (const [label, primary] of reasons()) await t.test(mode + '/' + label, { timeout: 30000 }, async t => {
    const f = await fixture(t, { mode, primary, upstreamStatus: primary?.httpStatus ?? primary?.status ?? 200 });
    const wire = await f.http();
    assert.equal(wire.status, 500); assert.deepEqual(wire.bytes, Buffer.from('Error processing request.'));
    assert.equal(wire.component.failed, true);
    const error = wire.component.error; assert.equal(error.status, 500); assert.equal(Object.hasOwn(error, 'cause'), true); sameReason(error.cause, primary);
    for (const key of ['code', 'statusCode', 'errors']) if (primary?.[key] !== undefined) sameReason(error[key], primary[key]);
    if (primary?.httpStatus != null || primary?.status != null && primary.status !== 500) assert.equal(error.httpStatus, primary.httpStatus ?? primary.status);
    f.report.observations.failure = observed(error); assert.deepEqual(await fs.readdir(path.dirname(f.filename)), []);
    f.fault.enabled = false;
    const recovered = await f.http(); assert.equal(recovered.status, 200); assert.deepEqual(recovered.bytes, downloaded);
    f.report.assertions.completeHttpFailureAndRecovery = true; await f.released();
  });
  for (const status of [429, 503]) await t.test('actual upstream status ' + status, async t => {
    const f = await fixture(t, { upstreamStatus: status }); const wire = await f.http();
    assert.equal(wire.status, 500); assert.deepEqual(wire.bytes, Buffer.from('Error processing request.'));
    assert.equal(wire.component.error.status, 500); assert.equal(wire.component.error.httpStatus, status);
    assert.equal(wire.component.error.cause.httpStatus, status);
    f.report.observations.failure = observed(wire.component.error); f.fault.enabled = false;
    const recovered = await f.http(); assert.equal(recovered.status, 200); assert.deepEqual(recovered.bytes, downloaded);
    f.report.assertions.actualUpstreamStatusPreserved = true;
  });
});

test('the second real country cache stat retains TOCTOU failures and the original physical cache', { timeout: 60000 }, async t => {
  for (const [label, primary] of reasons()) await t.test(label, { timeout: 30000 }, async t => {
    const f = await fixture(t, { mode: 'stat', primary }); await fs.writeFile(f.filename, sentinel);
    const result = await outcome(f.get()); assert.equal(result.failed, true); sameReason(result.error, primary);
    f.report.observations.failure = observed(result.error); assert.deepEqual(f.requests, []);
    await f.cacheAndRecovery(sentinel); await f.released();
  });
});

function cacheFailure(actual, primary, cleanup, double) {
  if (!double) { sameReason(actual, primary); return; }
  sameReason(actual.errors, [primary, cleanup]); assert.equal(Object.hasOwn(actual, 'cause'), true); sameReason(actual.cause, primary);
  for (const key of ['code', 'status', 'statusCode']) if (primary?.[key] !== undefined) sameReason(actual[key], primary[key]);
}

test('country cache writes and disposal retain exact failures, actual prefixes and memory publication boundaries', { timeout: 120000 }, async t => {
  const cases = ['write', 'write-close', 'close'].flatMap(mode => reasons().map(([label, primary]) => ({ mode, label, primary, prefixBytes: 65536 })));
  cases.push({ mode: 'write', label: 'empty-file', primary: undefined, prefixBytes: 0 });
  for (const definition of cases) await t.test(definition.mode + '/' + definition.label, { timeout: 30000 }, async t => {
    const cleanup = structured('The descriptor closed before its disposal rejected.'), f = await fixture(t, { ...definition, cleanup });
    const result = await outcome(f.get()); assert.equal(result.failed, true);
    cacheFailure(result.error, definition.primary, cleanup, definition.mode === 'write-close');
    f.report.observations.failure = observed(result.error); await f.released();
    await f.cacheAndRecovery(definition.mode === 'close' ? downloaded : downloaded.subarray(0, definition.prefixBytes));
  });
});

test('country operations and client closure wait for the actual gated cache descriptor release', { timeout: 60000 }, async t => {
  for (const mode of ['write', 'write-close', 'close']) await t.test(mode, { timeout: 30000 }, async t => {
    const primary = structured('The admitted cache operation failed.'), cleanup = { message: 'Actual close completed before rejecting.', cause: undefined, name: 'business-name', stack: 'business-stack' };
    const f = await fixture(t, { mode, primary, cleanup, gated: true, prefixBytes: 65536 });
    const operation = f.get(), result = outcome(operation);
    // The real HTTP request and write must finish before close enters its gate.
    const endedBeforeAdmission = operation.then(() => { throw new Error('The country operation completed before its cache close was admitted.'); });
    const state = await Promise.race([f.opened, endedBeforeAdmission]);
    await Promise.race([state.entered.promise, endedBeforeAdmission]);
    const openStat = fstatSync(state.fd); assert.equal(openStat.isFile(), true);
    f.report.observations.gatedOpenDescriptor = { fd: state.fd, stat: { ...openStat } };
    const expected = mode === 'close' ? downloaded : downloaded.subarray(0, 65536);
    assert.deepEqual(await f.retain('cache-during-close.bin', await fs.readFile(f.filename)), expected);
    await pending(operation, 'The getCountries operation still owns its unfinished descriptor close.');
    const closing = f.client.close(), repeated = f.client.close();
    await pending(closing, 'Client close drains the admitted descriptor disposal.');
    await pending(repeated, 'Repeated client close waits for the same actual release.');
    const refused = await outcome(f.get()); assert.equal(refused.failed, true); assert.equal(refused.error.status, 503);
    state.release.resolve(); const settled = await result; assert.equal(settled.failed, true);
    cacheFailure(settled.error, primary, cleanup, mode === 'write-close');
    await closing; await repeated; await f.released();
    f.report.observations.failure = observed(settled.error); f.report.assertions.operationAndCloseWaitedForDescriptor = true;
    await f.cacheAndRecovery(expected, { originalClosed: true });
  });
});
