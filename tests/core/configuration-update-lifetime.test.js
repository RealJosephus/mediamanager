import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ServerConfigurationStore } from '../../src/core/server-configuration-store.js';
import { NamedConfigurationStore } from '../../src/core/named-configuration-store.js';
import { defaultConfiguration, parseConfigurationXml } from '../../src/core/configuration-xml.js';
import { serializeConfiguration } from '../../src/core/configuration-file.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../tools/validation/paths.js';
import { localStateStorage } from '../helpers/local-state-storage.js';

const settings = { timeout: 30000 };
const deferred = () => Promise.withResolvers();
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const configurationJson = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString())
  : typeof entry === 'number' && !Number.isFinite(entry) ? String(entry) : entry, 2) + '\n';
const errorPayload = value => value == null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(errorPayload)
  : Object.fromEntries(Object.getOwnPropertyNames(value).filter(name => !(value instanceof Error && ['name', 'stack'].includes(name)))
    .map(name => [name, errorPayload(value[name])]));
const errorRecord = value => value == null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(errorRecord)
  : Object.fromEntries([...new Set([...Object.getOwnPropertyNames(value), ...(value instanceof Error ? ['name'] : [])])].map(name => [name, errorRecord(value[name])]));

function until(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
async function read(filename, root) { return parseConfigurationXml(await fs.readFile(filename), root); }
async function disk(filename, root) {
  let bytes, value, error;
  try { bytes = await fs.readFile(filename); if (root) value = parseConfigurationXml(bytes, root); }
  catch (failure) { error = errorRecord(failure); }
  return { filename, bytes: bytes?.length ?? null, sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
    base64: bytes?.toString('base64') ?? null, value: value ?? null, error: error ?? null };
}
function closedPayload(kind) {
  return { message: kind === 'named' ? 'Named configuration persistence is closing.' : 'Server configuration persistence is closing.',
    code: 'closed', status: 503 };
}
async function expectClosed(promise, kind, report) {
  await assert.rejects(promise, error => {
    report.admissionFailures.push({ kind, error: errorRecord(error) }); assert.deepEqual(errorPayload(error), closedPayload(kind)); return true;
  });
}

async function fixture(t, options = {}) {
  await fs.mkdir(validationOutputRoot(), { recursive: true });
  const root = await fs.mkdtemp(path.join(validationOutputRoot(), 'configuration-update-lifetime-'));
  assertValidationOutputChild(root);
  const directory = path.join(root, 'config'); await fs.mkdir(directory);
  const system = path.join(directory, 'system.xml'), network = path.join(directory, 'network.xml'), metadata = path.join(directory, 'metadata.xml');
  const configuration = { ...defaultConfiguration('server'), ServerName: 'Initial', IsPortAuthorized: true };
  await fs.writeFile(system, serializeConfiguration('server', configuration));
  await fs.writeFile(network, serializeConfiguration('network', { ...defaultConfiguration('network'), BaseUrl: '/initial' }));
  await fs.writeFile(metadata, serializeConfiguration('metadata', { ...defaultConfiguration('metadata'), UseFileCreationTimeForDateAdded: true }));
  const storage = await localStateStorage(root);
  const report = { scope: 'Actual configuration XML, admitted nested saves and handler lifetime during close. No runtime or full Native listener acceptance.',
    serverErrors: [], namedErrors: [], admissionFailures: [], observations: [], phaseAcceptance: false, releaseAcceptance: false };
  const server = new ServerConfigurationStore({ configuration, configurationDirectoryPath: directory,
    applicationPaths: { programDataPath: path.join(root, 'program'), defaultMetadataPath: path.join(root, 'metadata'), cachePath: path.join(root, 'cache') },
    metadataFileSystem: storage.fileSystem, fileSystem: options.fileSystem ?? fs, async onError(error) {
      report.serverErrors.push(errorRecord(error)); await options.onServerError?.(error, { root, report });
    } });
  const named = new NamedConfigurationStore({ configurationDirectoryPath: directory, fileSystem: options.fileSystem ?? fs,
    async onError(error, context) { report.namedErrors.push({ error: errorRecord(error), context }); await options.onNamedError?.(error, context); } });
  t.after(async () => {
    const errors = [];
    for (const close of [() => named.close(), () => server.close(), () => storage.close()]) try { await close(); } catch (error) { errors.push(error); }
    report.finalFiles = { system: await disk(system, 'server'), network: await disk(network, 'network'), metadata: await disk(metadata, 'metadata') };
    report.cleanupErrors = errors.map(errorRecord);
    try { await fs.writeFile(path.join(root, 'observations.json'), configurationJson(report), { flag: 'wx' }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Configuration lifetime fixture cleanup failed.', { cause: errors[0] });
  });
  await server.initialize();
  return { root, directory, system, network, metadata, server, named, report };
}
async function run(t, options, work) {
  const state = await fixture(t, options);
  try { await work(state); }
  catch (error) { state.report.failure = errorRecord(error); throw error; }
}

test('close drains named async handlers, their pending cold read and nested named/system XML saves', settings, async t => {
  const entered = deferred(), release = deferred(); let hold = true;
  const fileSystem = { ...fs, async open(filename, flags, ...args) {
    const file = await fs.open(filename, flags, ...args);
    if (path.basename(filename) !== 'system.xml' || flags !== 'w') return file;
    return { async write(...values) {
      const result = await file.write(...values);
      if (hold) { hold = false; entered.resolve(); await release.promise; }
      return result;
    }, close: () => file.close() };
  } };
  await run(t, { fileSystem }, async state => {
    const { named, server, system, network, metadata, root, report } = state;
    const receipt = path.join(root, 'ordered-observer.json');
    server.on('updated', async () => {
      if (server.configuration.ServerName === 'Queued current saved') return;
      server.configuration.ServerName = 'Queued current saved'; await server.saveConfiguration();
    });
    named.on('updated', async ({ key }) => {
      if (key !== 'network') return;
      server.configuration.IsPortAuthorized = false; await server.saveConfiguration();
      const value = await named.getConfiguration('METADATA'); value.UseFileCreationTimeForDateAdded = false;
      await named.saveConfiguration('METADATA', value);
    });
    named.on('updated', async ({ key }) => {
      if (key !== 'network') return;
      await fs.writeFile(receipt, configurationJson({ metadata: await read(metadata, 'metadata'), authorized: server.configuration.IsPortAuthorized }));
    });
    const incoming = { ...defaultConfiguration('network'), BaseUrl: '/saved', EnableRemoteAccess: false };
    const saved = observed(named.saveConfiguration('network', incoming)); let cold, closing;
    try {
      await until(entered.promise, t.signal);
      report.blockedSystem = await disk(system, 'server');
      assert.deepEqual(await fs.readFile(system), serializeConfiguration('server', server.configuration).subarray(0, report.blockedSystem.bytes));
      cold = observed(named.getConfiguration('METADATA'));
      closing = observed(Promise.all([named.close(), server.close()]).then(async () => ({
        system: await read(system, 'server'), network: await read(network, 'network'), metadata: await read(metadata, 'metadata'),
        receipt: JSON.parse(await fs.readFile(receipt, 'utf8')),
      })));
      await expectClosed(named.saveConfiguration('metadata', defaultConfiguration('metadata')), 'named', report);
      await expectClosed(named.getConfiguration('network'), 'named', report);
      await expectClosed(server.saveConfiguration(), 'server', report);
      release.resolve();
      const result = await until(closing, t.signal); report.observations.push({ closing: result.error ? { error: errorRecord(result.error) } : result });
      assert.equal(result.error, undefined);
      assert.equal(result.value.system.IsPortAuthorized, false); assert.equal(result.value.system.ServerName, 'Queued current saved');
      assert.equal(result.value.network.BaseUrl, '/saved'); assert.equal(result.value.network.EnableRemoteAccess, false);
      assert.equal(result.value.metadata.UseFileCreationTimeForDateAdded, false);
      assert.equal(result.value.receipt.metadata.UseFileCreationTimeForDateAdded, false); assert.equal(result.value.receipt.authorized, false);
      const admitted = await until(saved, t.signal), loaded = await until(cold, t.signal);
      assert.equal(admitted.error, undefined); assert.equal(loaded.error, undefined); assert.equal(loaded.value.UseFileCreationTimeForDateAdded, false);
      const reopened = new NamedConfigurationStore({ configurationDirectoryPath: state.directory });
      try { assert.equal((await reopened.getConfiguration('network')).BaseUrl, '/saved'); assert.equal((await reopened.getConfiguration('metadata')).UseFileCreationTimeForDateAdded, false); }
      finally { await reopened.close(); }
    } finally { release.resolve(); await Promise.allSettled([saved, cold, closing]); }
  });
});

test('named async updated failure preserves its complete original error and durable prefix while stopping the next handler', settings, async t => {
  await run(t, {}, async ({ named, network, metadata, directory, root, report }) => {
    const primary = Object.assign(new Error('Controlled updated operation failure.'), { code: 'EIO', status: 502, statusCode: 502, cause: new Error('Original observer input failure.'),
      details: { name: 'business operation', stack: 'business context stack', owner: { operation: 'network-updated', extra: 'retain' } } });
    const release = Object.assign(new Error('Controlled observer cleanup failure.'), { code: 'EACCES', status: 503 });
    const original = Object.assign(new AggregateError([primary, release], 'Controlled ordered updated failure.', { cause: primary }), {
      code: 'EIO', status: 502, statusCode: 502, owner: { name: 'configuration observer', stack: 'business owner text' } });
    const receipt = path.join(root, 'forbidden-later-observer');
    named.once('updated', async ({ key, configuration }) => {
      const committed = await read(network, 'network'); assert.equal(key, 'network'); assert.equal(committed.BaseUrl, '/committed');
      configuration.BaseUrl = '/late-current'; throw original;
    });
    named.on('updated', async () => { await fs.writeFile(receipt, 'later handler executed'); });
    const incoming = { ...defaultConfiguration('network'), BaseUrl: '/committed' };
    await assert.rejects(named.saveConfiguration('network', incoming), error => {
      report.observations.push({ rejected: errorRecord(error) }); assert.deepEqual(errorPayload(error), errorPayload(original)); return true;
    });
    assert.equal(named.getCurrentConfiguration('network').BaseUrl, '/late-current'); assert.equal(incoming.BaseUrl, '/late-current');
    assert.equal((await read(network, 'network')).BaseUrl, '/committed');
    await assert.rejects(fs.readFile(receipt), { code: 'ENOENT' });
    assert.equal((await read(metadata, 'metadata')).UseFileCreationTimeForDateAdded, true);
    await named.close(); await expectClosed(named.saveConfiguration('network', incoming), 'named', report);
    const cold = new NamedConfigurationStore({ configurationDirectoryPath: directory });
    try { assert.equal((await cold.getConfiguration('network')).BaseUrl, '/committed'); } finally { await cold.close(); }
  });
});

test('queued system updated can save during close and reports the real ordered write/close failure after the original save completed', settings, async t => {
  const write = Object.assign(new Error('Controlled nested configuration write failure.'), { code: 'ENOSPC', status: 507, statusCode: 507, cause: new Error('Original full volume failure.'),
    details: { name: 'physical write', stack: 'business write context', owner: { filename: 'system.xml', prefixBytes: 37 } } });
  const close = Object.assign(new Error('Controlled nested file-close failure.'), { code: 'EIO', cause: new Error('Original close failure.'),
    owner: { name: 'file cleanup', stack: 'business cleanup context' } });
  let failing = false, written = 0;
  const fileSystem = { ...fs, async open(filename, flags, ...args) {
    const file = await fs.open(filename, flags, ...args);
    if (!failing || path.basename(filename) !== 'system.xml' || flags !== 'w') return file;
    return { async write(buffer, offset, length) {
      if (written >= 37) throw write;
      const value = await file.write(buffer, offset, Math.min(length, 37 - written)); written += value.bytesWritten; return value;
    }, async close() { await file.close(); throw close; } };
  } };
  let reportingStore; const delivered = [];
  await run(t, { fileSystem, async onServerError(error, { root, report }) {
    delivered.push(error); await expectClosed(reportingStore.saveConfiguration(), 'server', report);
    await fs.writeFile(path.join(root, 'system-error.json'), configurationJson(errorRecord(error)));
  } },
    async ({ server, system, root, report }) => {
      reportingStore = server;
      const later = path.join(root, 'forbidden-system-observer');
      server.once('updated', async () => {
        assert.equal((await read(system, 'server')).ServerName, 'Outer committed');
        server.configuration.ServerName = 'Nested current'; failing = true; await server.saveConfiguration();
      });
      server.on('updated', async () => { await fs.writeFile(later, 'later system handler executed'); });
      await server.updateServerValues({ ServerName: 'Outer committed' });
      const closing = server.close();
      await expectClosed(server.saveConfiguration(), 'server', report); await until(closing, t.signal);
      const raw = JSON.parse(await fs.readFile(path.join(root, 'system-error.json'), 'utf8'));
      const expected = Object.assign(new AggregateError([write, close], write.message, { cause: write }), { code: write.code, status: write.status, statusCode: write.statusCode });
      assert.deepEqual(errorPayload(delivered.at(-1)), errorPayload(expected));
      for (const actual of delivered) assert.deepEqual(errorPayload(actual), errorPayload(expected));
      report.observations.push({ reported: raw });
      await assert.rejects(fs.readFile(later), { code: 'ENOENT' });
      assert.equal(server.configuration.ServerName, 'Nested current');
      assert.deepEqual(await fs.readFile(system), serializeConfiguration('server', server.configuration).subarray(0, 37));
    });
});

test('a returned named/system handler cannot lend closing admission to an escaped callback while the next handler holds real IO', settings, async t => {
  for (const kind of ['named', 'server']) await run(t, {}, async state => {
    const { named, server, root, report } = state;
    const store = kind === 'named' ? named : server;
    const entered = deferred(), releaseIO = deferred(), releaseEscape = deferred(), escaped = deferred();
    const receipt = path.join(root, 'held-observer.txt');
    store.once('updated', () => {
      void (async () => {
        await releaseEscape.promise;
        try {
          if (kind === 'named') await named.saveConfiguration('network', { ...defaultConfiguration('network'), BaseUrl: '/escaped' });
          else await server.updateServerValues({ ServerName: 'Escaped server write' });
          escaped.resolve({ accepted: true });
        } catch (error) { escaped.resolve({ accepted: false, error }); }
      })();
    });
    store.once('updated', async () => {
      const file = await fs.open(receipt, 'w');
      try { await file.writeFile('admitted observer bytes'); entered.resolve(); await releaseIO.promise; }
      finally { await file.close(); }
    });
    const saving = observed(kind === 'named' ? named.saveConfiguration('network', { ...defaultConfiguration('network'), BaseUrl: '/admitted' })
      : server.updateServerValues({ ServerName: 'Admitted server write' }));
    let closing;
    try {
      await until(entered.promise, t.signal); const before = await fs.readFile(kind === 'named' ? state.network : state.system);
      closing = observed(store.close().then(() => fs.readFile(receipt, 'utf8')));
      releaseEscape.resolve(); const result = await until(escaped.promise, t.signal); report.observations.push({ kind, escape: errorRecord(result) });
      assert.equal(result.accepted, false); assert.deepEqual(errorPayload(result.error), closedPayload(kind));
      assert.deepEqual(await fs.readFile(kind === 'named' ? state.network : state.system), before);
      releaseIO.resolve(); const closed = await until(closing, t.signal); assert.equal(closed.error, undefined); assert.equal(closed.value, 'admitted observer bytes');
      assert.equal((await until(saving, t.signal)).error, undefined);
    } finally { releaseIO.resolve(); releaseEscape.resolve(); await Promise.allSettled([saving, closing]); }
  });
});

test('close drains an already admitted unawaited nested named/system save to its complete real XML', settings, async t => {
  for (const kind of ['named', 'server']) {
    const entered = deferred(), release = deferred(); let nested = false;
    const fileSystem = { ...fs, async open(filename, flags, ...args) {
      const file = await fs.open(filename, flags, ...args);
      if (!nested || flags !== 'w' || path.basename(filename) !== (kind === 'named' ? 'metadata.xml' : 'system.xml')) return file;
      return { async write(...values) { const result = await file.write(...values); entered.resolve(); await release.promise; return result; }, close: () => file.close() };
    } };
    await run(t, { fileSystem }, async state => {
      const store = kind === 'named' ? state.named : state.server;
      let child;
      store.once('updated', () => {
        nested = true;
        child = observed(kind === 'named' ? state.named.saveConfiguration('metadata', { ...defaultConfiguration('metadata'), UseFileCreationTimeForDateAdded: false })
          : state.server.updateServerValues({ ServerName: 'Admitted child XML' }));
      });
      const parent = observed(kind === 'named' ? state.named.saveConfiguration('network', { ...defaultConfiguration('network'), BaseUrl: '/parent' })
        : state.server.updateServerValues({ ServerName: 'Admitted parent XML' }));
      let closing;
      try {
        await until(entered.promise, t.signal); assert.equal((await until(parent, t.signal)).error, undefined);
        const target = kind === 'named' ? state.metadata : state.system;
        closing = observed(store.close().then(() => read(target, kind === 'named' ? 'metadata' : 'server')));
        await expectClosed(kind === 'named' ? state.named.saveConfiguration('network', defaultConfiguration('network')) : state.server.saveConfiguration(), kind, state.report);
        release.resolve(); const result = await until(closing, t.signal); state.report.observations.push({ kind, closed: result.error ? { error: errorRecord(result.error) } : result });
        assert.equal(result.error, undefined);
        if (kind === 'named') assert.equal(result.value.UseFileCreationTimeForDateAdded, false); else assert.equal(result.value.ServerName, 'Admitted child XML');
        assert.equal((await until(child, t.signal)).error, undefined);
      } finally { release.resolve(); await Promise.allSettled([parent, child, closing]); }
    });
  }
});

test('a queued system handler saves after an already accepted XML writer while close drains both real results', settings, async t => {
  const writerEntered = deferred(), releaseWriter = deferred(), handlerEntered = deferred(), releaseHandler = deferred(), requested = deferred();
  let hold = false;
  const fileSystem = { ...fs, async open(filename, flags, ...args) {
    const file = await fs.open(filename, flags, ...args);
    if (path.basename(filename) !== 'system.xml' || flags !== 'w') return file;
    return { async write(...values) {
      const result = await file.write(...values);
      if (hold) { hold = false; writerEntered.resolve(); await releaseWriter.promise; }
      return result;
    }, close: () => file.close() };
  } };
  await run(t, { fileSystem }, async ({ server, system, report }) => {
    const seed = (await fs.readFile(system, 'utf8')).replace('</ServerConfiguration>', '<Future xmlns="urn:lifetime">before<Child />after</Future></ServerConfiguration>');
    await fs.writeFile(system, seed);
    report.initialSystem = await disk(system, 'server');
    server.once('updated', async () => {
      handlerEntered.resolve(); await releaseHandler.promise;
      server.configuration.ServerName = 'Queued after external writer';
      const saved = server.saveConfiguration(); requested.resolve(); await saved;
    });
    await server.updateServerValues({ ServerName: 'First event source' });
    let external, closing;
    try {
      await until(handlerEntered.promise, t.signal); hold = true;
      external = observed(server.updateServerValues({ ServerName: 'External writer held' }));
      await until(writerEntered.promise, t.signal); report.blockedSystem = await disk(system, 'server');
      releaseHandler.resolve(); await until(requested.promise, t.signal);
      closing = observed(server.close().then(() => read(system, 'server')));
      await expectClosed(server.saveConfiguration(), 'server', report);
      releaseWriter.resolve(); const closed = await until(closing, t.signal);
      report.observations.push({ closed: closed.error ? { error: errorRecord(closed.error) } : closed });
      assert.equal(closed.error, undefined); assert.equal(closed.value.ServerName, 'Queued after external writer');
      assert.equal((await until(external, t.signal)).error, undefined);
      assert.match(await fs.readFile(system, 'utf8'), /<Future xmlns="urn:lifetime">before<Child\s*\/>after<\/Future>/u);
    } finally { releaseHandler.resolve(); releaseWriter.resolve(); await Promise.allSettled([external, closing]); }
  });
});
