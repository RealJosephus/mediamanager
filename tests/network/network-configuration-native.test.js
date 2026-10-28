import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { currentNetworkConfiguration, networkInput } from './network-configuration-current.js';
import { candidateNetworkConfiguration, candidateNetworkConsumer, disk } from './fixtures/network-configuration-current/node-cases.js';
import { networkComponentHost } from './fixtures/network-configuration-current/node-host.js';
import { configurationJson } from '../core/fixtures/configuration/observations.js';
import { namedCoreProjection, namedDiskProjection, namedError, namedHttpProjection, namedWire } from '../core/named-configuration-current.js';
import { readPublishedServerStartupOptions } from '../../src/network/startup.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const settings = { skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000 };

test('published startup input uses actual Native option parsing and environment precedence', settings, async () => {
  const capture = await currentNetworkConfiguration(), report = { nativeCapture: capture.output, observations: [] };
  try {
    for (const [index, sample] of networkInput.startup.entries()) {
      const native = capture.native.startup[index], repeat = capture.repeat.startup[index];
      const project = value => ({ accepted: value.accepted, ...(value.accepted && { value: value.value ?? null }) });
      assert.deepEqual(project(repeat), project(native), sample.name + ': independent actual Native parser');
      let actual;
      try { actual = { accepted: true, value: readPublishedServerStartupOptions(sample).publicAddress ?? null }; }
      catch (error) { actual = { accepted: false, error: namedError(error) }; }
      report.observations.push({ sample, native, repeat, actual }); assert.deepEqual(project(actual), project(native), sample.name);
    }
  } catch (error) { report.failure = namedError(error); throw error; }
  finally { await fs.writeFile(path.join(capture.output, 'node-startup-comparison.json'), configurationJson(report), { flag: 'wx' }); }
});

test('actual Native Map registration records cold prefix acceptance independently of configuration loading', settings, async () => {
  const capture = await currentNetworkConfiguration();
  const project = rows => rows.map(({ raw, baseUrl, accepted }) => ({ raw, baseUrl, accepted }));
  const report = { scope: 'Actual framework Map registration and NetworkConfiguration setter. This capture does not certify Node cold startup for a rejected prefix.',
    native: capture.native.mapPrefixes, repeat: capture.repeat.mapPrefixes, nodeColdPrefixConformancePending: true };
  try {
    assert.deepEqual(capture.native.mapPrefixes.map(row => row.raw), networkInput.mapPrefixes);
    assert.deepEqual(project(capture.repeat.mapPrefixes), project(capture.native.mapPrefixes));
  } catch (error) { report.failure = namedError(error); throw error; }
  finally { await fs.writeFile(path.join(capture.output, 'native-map-prefix-boundary.json'), configurationJson(report), { flag: 'wx' }); }
});

test('Network factory/current/XML matches actual full DTO, late BaseUrl setters, raw keys and failed save prefixes', settings, async () => {
  const capture = await currentNetworkConfiguration();
  const report = { scope: capture.report.scope, nativeCapture: capture.output, comparisons: [], phaseAcceptance: false, releaseAcceptance: false };
  try {
    const saved = [];
    for (const [index, sample] of networkInput.core.entries()) {
      const reference = capture.native.core[index], repeat = capture.repeat.core[index];
      assert.deepEqual(namedCoreProjection(repeat), namedCoreProjection(reference), sample.name + ': independent actual Native');
      const actual = await candidateNetworkConfiguration(sample, path.join(capture.output, 'node-core-' + index));
      report.comparisons.push({ sample, actual, reference, repeat });
      assert.deepEqual(namedCoreProjection(actual), namedCoreProjection(reference), sample.name + ': current/retained values, real files and event prefix');
      if (sample.name === 'missing-get-does-not-write') assert.equal(actual.after.disk.bytes, null);
      if (sample.name === 'malformed-original-remains') assert.equal(actual.after.disk.bytes, Buffer.from(sample.xml).toString('base64'));
      if (sample.name === 'complete-model-live-alias-and-cold-values') {
        const bytes = await fs.readFile(actual.filename); report.nodeRetainedXml = { filename: actual.filename, bytesBase64: bytes.toString('base64') };
        assert.match(bytes.toString(), /<Future\b[^>]*xmlns="urn:network:future"[^>]*note="preserve"[^>]*>before<Child\s*\/>after<\/Future>/u);
        assert.doesNotMatch(Buffer.from(reference.after.disk.bytes, 'base64').toString(), /urn:network:future/u);
      }
      if (actual.after.disk.bytes && actual.after.disk.accepted) saved.push({ name: sample.name, filename: actual.filename });
    }
    const consumed = await capture.consume(saved, 'node-files-native-cold'); report.nativeColdRead = consumed;
    for (const row of consumed.native.consumed) {
      const actual = report.comparisons.find(entry => entry.sample.name === row.name).actual;
      assert.deepEqual(namedDiskProjection(row.disk, 'network'), namedDiskProjection(actual.after.disk, 'network'), row.name + ': actual Native cold known fields');
    }
  } catch (error) { report.failure = namedError(error); throw error; }
  finally { await fs.writeFile(path.join(capture.output, 'node-core-comparison.json'), configurationJson(report), { flag: 'wx' }); }
});

test('NetworkManager LAN/remote/current flags and actual ApplicationHost advertised URLs match controlled interfaces', settings, async () => {
  const capture = await currentNetworkConfiguration();
  const report = { scope: capture.report.scope, nativeCapture: capture.output, comparisons: [], phaseAcceptance: false, releaseAcceptance: false };
  const projection = (row, urls) => ({ name: row.name, steps: row.steps.map(({ step, accepted, configuration, addresses, requests, local, localUrls }) => ({
    step, accepted, configuration, ...(urls ? { requests, local } : { addresses: addresses.map(({ access, ...value }) => value), localUrls }),
  })), ...(urls ? {} : { events: row.events }) });
  try {
    for (const group of ['policies', 'urls']) for (const [index, sample] of networkInput[group].entries()) {
      const reference = capture.native[group][index], repeat = capture.repeat[group][index], urls = group === 'urls';
      assert.deepEqual(projection(repeat, urls), projection(reference, urls), sample.name + ': independent actual Native');
      const actual = await candidateNetworkConsumer(sample, networkInput.interfaces, path.join(capture.output, 'node-' + group + '-' + index), urls);
      report.comparisons.push({ group, sample, actual, reference, repeat });
      assert.deepEqual(projection(actual, urls), projection(reference, urls), sample.name + ': actual address policy and public URL values');
    }
  } catch (error) { report.failure = namedError(error); throw error; }
  finally { await fs.writeFile(path.join(capture.output, 'node-consumers-comparison.json'), configurationJson(report), { flag: 'wx' }); }
});

test('Network named MVC/Startup authenticates then filters remote IP before binding, retaining full public failures and save prefix', settings, async () => {
  const capture = await currentNetworkConfiguration();
  const report = { scope: capture.report.scope, nativeCapture: capture.output, comparisons: [], unclassified: [], phaseAcceptance: false, releaseAcceptance: false };
  let host, owner, primary, primaryFailed = false;
  try {
    for (const [index, sample] of networkInput.http.entries()) {
      const reference = capture.native.http[index], repeat = capture.repeat.http[index];
      assert.deepEqual(namedHttpProjection(repeat, 'network'), namedHttpProjection(reference, 'network'), sample.name + ': independent Native complete wire/effects');
      const root = path.join(capture.output, 'node-http-' + index), directory = path.join(root, 'config'); await fs.mkdir(directory, { recursive: true });
      const diagnostics = [], events = [];
      host = await networkComponentHost({ directory, interfaces: networkInput.interfaces,
        initial: { KnownProxies: sample.coldKnownProxies ?? ['127.0.0.1'], EnableRemoteAccess: !sample.disabled, ...sample.initial }, owner: () => owner,
        onError: error => { const entry = { owner: structuredClone(owner), error: namedError(error) }; (owner?.open ? diagnostics : report.unclassified).push(entry); } });
      if (sample.physical === 'target-directory') { await fs.unlink(path.join(directory, 'network.xml')); await fs.mkdir(path.join(directory, 'network.xml')); }
      for (const phase of ['updating', 'updated']) host.store.on(phase, incoming => {
        events.push(structuredClone({ phase, ...incoming }));
        if (sample.observer === phase) throw new Error('Controlled named ' + phase + ' failure.');
      });
      const request = async (method, route, body, phase, identity, forwarded) => {
        owner = { index, sample: sample.name, phase, method, route, open: true };
        const result = await host.request(method, route, body, identity, forwarded); owner.open = false; return result;
      };
      const response = await request(sample.method, sample.route ?? '/System/Configuration/' + sample.key, sample.body, 'response', sample.identity ?? 'admin',
        sample.forwarded ?? (sample.remote ? '203.0.113.9' : undefined));
      const afterRead = await request('GET', '/System/Configuration/' + sample.key, undefined, 'afterRead', 'admin', sample.afterForwarded);
      const actual = { name: sample.name, root, response, afterRead, live: /^network$/iu.test(sample.key) ? structuredClone(host.store.getCurrentConfiguration(sample.key)) : null,
        events, disk: /^network$/iu.test(sample.key) ? disk(path.join(directory, 'network.xml')) : null, diagnostics, operationFailures: host.failures };
      report.comparisons.push({ sample, reference, repeat, actual });
      assert.deepEqual(namedHttpProjection(actual, 'network'), namedHttpProjection(reference, 'network'), sample.name + ': complete public wire and persistence/current effects');
      owner = undefined; const closing = host; host = undefined; await closing.close(); assert.equal(closing.server.listening, false);
    }
  } catch (error) { primaryFailed = true; primary = error; report.failure = namedError(error); }
  finally {
    owner = undefined; const failures = [];
    try { await host?.close(); } catch (error) { failures.push(error); report.unclassified.push(namedError(error)); }
    report.failed = primaryFailed || failures.length > 0;
    try { await fs.writeFile(path.join(capture.output, 'node-http-comparison.json'), configurationJson(report), { flag: 'wx' }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(primaryFailed ? [primary, ...failures] : failures, 'Network MVC component cleanup failed.', { cause: primaryFailed ? primary : failures[0] });
  }
  if (primaryFailed) throw primary;
});

test('Network hot configuration keeps proxy and startup map captured, redirects from current BaseUrl and retains an admitted socket', settings, async () => {
  const capture = await currentNetworkConfiguration(), sample = networkInput.lifecycle;
  const report = { scope: capture.report.scope, nativeCapture: capture.output, unclassified: [], phaseAcceptance: false, releaseAcceptance: false };
  const projection = row => ({ name: row.name, before: row.before, after: row.after, close: row.close, live: row.live,
    ...Object.fromEntries(['updated', 'rejectedHttp', 'rejectedUpgrade', 'oldPath', 'newPath', 'health'].map(phase => [phase, {
      ...namedWire(row[phase], row.root), location: row[phase].headers.location ?? row[phase].headers.Location?.[0] ?? null,
    }])) });
  let host, socket, primary, primaryFailed = false;
  try {
    assert.deepEqual(projection(capture.repeat.lifecycle), projection(capture.native.lifecycle), 'independent actual Native middleware and transport');
    const root = path.join(capture.output, 'node-lifecycle'), directory = path.join(root, 'config'); await fs.mkdir(directory, { recursive: true });
    host = await networkComponentHost({ directory, interfaces: networkInput.interfaces, initial: sample.initial, onError: error => report.unclassified.push(namedError(error)) });
    socket = new WebSocket('ws://127.0.0.1:' + host.server.address().port + '/a/socket', { headers: { 'X-Identity': 'admin', 'X-Forwarded-For': sample.remote } });
    await once(socket, 'open');
    const echo = async value => { const incoming = once(socket, 'message'); socket.send(value); const [bytes, binary] = await incoming; assert.equal(binary, false); return bytes.toString(); };
    const before = await echo(sample.messages[0]);
    const updated = await host.request('POST', '/a/System/Configuration/network', '{"BaseUrl":"/a","EnableRemoteAccess":false,"KnownProxies":[]}');
    const rejectedHttp = await host.request('GET', '/a/System/Configuration/network', undefined, 'admin', sample.remote);
    const rejectedUpgrade = await host.request('GET', '/a/socket', undefined, 'anonymous', sample.remote, true);
    const after = await echo(sample.messages[1]);
    const current = host.store.getCurrentConfiguration('network'); current.BaseUrl = sample.nextBaseUrl; await host.store.saveConfiguration('network', current);
    const oldPath = await host.request('GET', '/a/System/Configuration/network'), newPath = await host.request('GET', '/b/System/Configuration/network');
    const health = await host.request('GET', '/health');
    const closing = once(socket, 'close'); socket.close(1000, 'fixture finished'); const [code, reason] = await closing;
    const actual = { name: sample.name, root, before, updated, rejectedHttp, rejectedUpgrade, after, oldPath, newPath, health,
      close: { code, reason: reason.toString() }, live: structuredClone(current), operationFailures: host.failures };
    report.actual = actual; report.reference = capture.native.lifecycle; report.repeat = capture.repeat.lifecycle;
    assert.deepEqual(projection(actual), projection(capture.native.lifecycle));
    assert.equal(rejectedHttp.status, 503); assert.equal(rejectedHttp.bodyBase64, '');
    assert.equal(rejectedUpgrade.status, 503); assert.equal(rejectedUpgrade.bodyBase64, '');
    assert.deepEqual([before, after], sample.messages); assert.deepEqual(actual.close, { code: 1000, reason: 'fixture finished' });
    const closingHost = host; host = undefined; await closingHost.close(); assert.equal(closingHost.server.listening, false);
  } catch (error) { primaryFailed = true; primary = error; report.failure = namedError(error); }
  finally {
    const failures = [];
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    try { await host?.close(); } catch (error) { failures.push(error); report.unclassified.push(namedError(error)); }
    report.failed = primaryFailed || failures.length > 0;
    try { await fs.writeFile(path.join(capture.output, 'node-lifecycle-comparison.json'), configurationJson(report), { flag: 'wx' }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(primaryFailed ? [primary, ...failures] : failures, 'Network lifecycle component cleanup failed.', { cause: primaryFailed ? primary : failures[0] });
  }
  if (primaryFailed) throw primary;
});
