import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../src/plugins/host.js';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { createXmlTvListingsProvider } from '../../plugins/xmltv/provider.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const errorDiagnostic = error => ({ name: error.name, code: error.code, message: error.message, stack: error.stack });
const xml = Buffer.from('<tv><channel id="c1"><display-name lang="en">English</display-name>\n'
  + '<display-name lang="fr">Français</display-name><icon src="https://example.invalid/channel.png"/></channel></tv>');
async function ownedRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xmltv-plugin-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.match(path.basename(resolved), /^xmltv-plugin-/u);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return root;
}

async function interruptedHttpDownload(t, mode) {
  const root = await ownedRoot(t), cachePath = path.join(root, 'cache');
  const admitted = Promise.withResolvers(), bodyClosed = Promise.withResolvers();
  const caller = new AbortController(), reason = Object.assign(new Error('The caller stopped the XMLTV download.'), { code: 'caller-stop' });
  const diagnostics = [];
  let requests = 0, opened = 0, closed = 0, observedSignal, rejectedError, listenerClosed = false, providerClosed = false, serverClosing;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'application/xml' });
    if (requests === 1) { response.once('close', () => bodyClosed.resolve()); response.write(xml.subarray(0, 5)); }
    else response.end(xml);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const closeServer = () => serverClosing ??= new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const provider = createXmlTvListingsProvider({ cachePath, downloadTimeoutMs: mode === 'deadline' ? 1000 : 30000,
    fetch: (url, options) => { observedSignal = options.signal; return fetch(url, options); },
    logger: { error: error => diagnostics.push(errorDiagnostic(error)) },
    fileSystem: { ...fs, async open(...args) {
      const handle = await fs.open(...args); opened++;
      return { async writeFile(bytes) { await handle.writeFile(bytes); admitted.resolve(); },
        async close() { await handle.close(); closed++; } };
    } } });
  const info = { Id: 'download', Path: `http://127.0.0.1:${server.address().port}/feed.xml` };
  const pending = provider.getLineups(info, '', '', { signal: caller.signal });
  const rejected = assert.rejects(pending, error => {
    rejectedError = error;
    if (mode === 'caller') { assert.equal(error.message, reason.message); assert.equal(error.code, reason.code); }
    else assert.equal(error.code, 'ETIMEDOUT');
    return true;
  });
  void rejected.catch(() => {});
  try {
    await Promise.race([admitted.promise, pending.then(() => { throw new Error('The download completed before its held file write.'); })]);
    if (mode === 'caller') caller.abort(reason);
    await rejected; await bodyClosed.promise;
    const interruptedSignal = observedSignal;
    assert.equal(observedSignal.aborted, true);
    assert.equal(caller.signal.aborted, mode === 'caller');
    if (mode === 'caller') { assert.equal(observedSignal.reason.message, reason.message); assert.equal(observedSignal.reason.code, reason.code); }
    assert.equal(opened, 1); assert.equal(closed, opened); assert.deepEqual(await fs.readdir(cachePath), []);
    if (mode === 'deadline') {
      await assert.rejects(provider.getLineups(info, '', ''), { code: 'download-backoff' });
      assert.equal(requests, 1);
      await provider.validate(info, true, true);
    }
    assert.deepEqual(await provider.getLineups(info, '', ''), [{ Id: 'c1', Name: 'English' }]);
    assert.equal(requests, 2); assert.equal(closed, opened);
    assert.deepEqual(await fs.readFile(path.join(cachePath, 'download.xml')), xml);
    assert.deepEqual(await fs.readdir(cachePath), ['download.xml']);
    await provider.close(); providerClosed = true;
    await assert.rejects(provider.getLineups(info, '', ''), { status: 503 });
    await closeServer(); listenerClosed = true;
    t.diagnostic(JSON.stringify({ mode, failure: errorDiagnostic(rejectedError),
      callerCancelled: caller.signal.aborted, downloadSignal: { aborted: interruptedSignal.aborted, reason: errorDiagnostic(interruptedSignal.reason) },
      httpBodyClosed: true, fileOwnersClosed: closed === opened, providerClosed, listenerClosed,
      requests, diagnostics, elapsedNativeFifteenMinuteTimeoutClaimed: false }));
  } finally {
    caller.abort(reason);
    await Promise.allSettled([pending, rejected, provider.close()]);
    if (!listenerClosed) { server.closeAllConnections(); await Promise.allSettled([closeServer()]); }
  }
}

test('caller cancellation removes a real XMLTV HTTP prefix, drains its body and retries without failure backoff', { timeout: 30000 },
  t => interruptedHttpDownload(t, 'caller'));

test('a real XMLTV download deadline drains its body and file before backoff and validation retry', { timeout: 30000 },
  t => interruptedHttpDownload(t, 'deadline'));

test('installed and official XMLTV packages use ordinary listings activation and mapped local sources', { timeout: 30000 }, async t => {
  for (const preinstalled of [false, true]) {
    const root = await ownedRoot(t), cachePath = path.join(root, 'cache');
    let official = false;
    if (preinstalled) {
      official = path.join(root, 'official'); await fs.mkdir(official);
      await fs.cp(path.resolve('plugins/xmltv'), path.join(official, 'xmltv'), { recursive: true });
    }
    let currentCachePath = cachePath, explicitCachePath;
    const host = await PluginHost.open({ directory: path.join(root, 'host'), get cachePath() { return currentCachePath; }, preinstalled: official,
      options: { xmltv: { get cachePath() { return explicitCachePath; } } } });
    let storage;
    try {
      await host.install(path.resolve('plugins/local'));
      if (!preinstalled) await host.install(path.resolve('plugins/xmltv'));
      assert.equal(host.get('xmltv').status, 'active');
      storage = await createConfiguredStorage(undefined, { plugins: host });
      const sourceRoot = path.join(root, 'mapped'); await fs.mkdir(sourceRoot);
      const filename = path.join(sourceRoot, 'guide.xml'), outside = path.join(root, 'unmapped.xml');
      await fs.writeFile(filename, xml); await fs.writeFile(outside, xml);
      await storage.configure({ instances: [{ id: 'source', type: 'local', config: { root: sourceRoot } }],
        mounts: [{ path: '/source', instanceId: 'source', root: '/', capabilities: {} }],
        prefixes: [{ identityRoot: sourceRoot, accessRoot: '/source', style: process.platform === 'win32' ? 'windows' : 'posix',
          caseSensitive: process.platform !== 'win32', purpose: 'metadata', returnAccess: 'The controlled XMLTV input has an explicit metadata storage mapping.' }] });
      const configuration = { PreferredMetadataLanguage: 'fr' };
      await host.connect({ metadataVfs: storage.metadataVfs, metadataIdentityMap: storage.metadataIdentityMap, configuration });
      const [provider] = host.entries('listings');
      assert.equal(provider.type, 'xmltv'); assert.equal(provider.name, 'XmlTV');
      assert.equal(provider.cachePath, path.join(cachePath, 'xmltv'));
      const info = { Id: 'legal-non-guid-id', Path: filename, PreferredLanguage: '　' };
      await provider.validate(info, true, true);
      assert.deepEqual(await provider.getLineups(info, 'ignored', 'ignored'), [{ Id: 'c1', Name: 'Français' }]);
      configuration.PreferredMetadataLanguage = 'en';
      assert.deepEqual(await provider.getLineups(info, '', ''), [{ Id: 'c1', Name: 'English' }]);
      assert.deepEqual(await fs.readFile(path.join(cachePath, 'xmltv/legal-non-guid-id.xml')), xml);
      await assert.rejects(provider.getLineups({ Id: 'unmapped', Path: outside }, '', ''), error => error.code === 'not-found');
      await assert.rejects(provider.validate({ Id: 'unmapped', Path: outside }, true, true), { code: 'ENOENT' });
      await assert.rejects(host.configure('xmltv', { Path: filename }), /each native listings provider configuration/u);
      currentCachePath = path.join(root, 'next-cache');
      assert.equal(provider.cachePath, path.join(currentCachePath, 'xmltv'));
      assert.deepEqual(await provider.getLineups(info, '', ''), [{ Id: 'c1', Name: 'English' }]);
      assert.deepEqual(await fs.readFile(path.join(currentCachePath, 'xmltv', 'legal-non-guid-id.xml')), xml);
      explicitCachePath = path.join(root, 'explicit-xmltv-cache');
      currentCachePath = path.join(root, 'later-server-cache');
      assert.equal(provider.cachePath, explicitCachePath);
      assert.deepEqual(await provider.getLineups(info, '', ''), [{ Id: 'c1', Name: 'English' }]);
      assert.deepEqual(await fs.readFile(path.join(explicitCachePath, 'legal-non-guid-id.xml')), xml);
      await assert.rejects(fs.stat(currentCachePath), { code: 'ENOENT' });
      assert.deepEqual(await fs.readdir(path.join(root, 'host', 'cache', 'xmltv')), []);
      await host.setEnabled('xmltv', false);
      assert.throws(() => provider.getLineups(info, '', ''), { status: 503 });
      assert.deepEqual(await fs.readdir(path.join(cachePath, 'xmltv')), ['legal-non-guid-id.xml']);
    } finally { try { await host.close(); } finally { await storage?.close(); } }
  }
});

test('an admitted XMLTV download keeps its cache target while the next request reads the updated path', { timeout: 30000 }, async t => {
  const root = await ownedRoot(t), initial = path.join(root, 'initial-cache'), next = path.join(root, 'next-cache');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let cachePath = initial, opened = 0, closed = 0;
  const provider = createXmlTvListingsProvider({ get cachePath() { return cachePath; }, source: {
    async openRead() {
      if (++opened === 1) { entered.resolve(); await release.promise; }
      return { stream: [xml], async close() { closed++; } };
    },
  } });
  const info = { Id: 'current', Path: '/mapped/guide.xml' }, pending = provider.getLineups(info, '', '');
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('The source completed before its held admission.'); })]);
    cachePath = next; release.resolve();
    const lineups = [{ Id: 'c1', Name: 'English' }];
    assert.deepEqual(await pending, lineups);
    assert.deepEqual(await fs.readFile(path.join(initial, 'current.xml')), xml);
    await assert.rejects(fs.readFile(path.join(next, 'current.xml')), { code: 'ENOENT' });
    assert.deepEqual(await provider.getLineups(info, '', ''), lineups);
    assert.deepEqual(await fs.readFile(path.join(next, 'current.xml')), xml);
    assert.deepEqual(await fs.readdir(initial), ['current.xml']);
    assert.deepEqual(await fs.readdir(next), ['current.xml']);
    assert.equal(opened, 2); assert.equal(closed, opened);
  } finally { release.resolve(); await Promise.allSettled([pending, provider.close()]); }
});

test('XMLTV can connect with only the plugin host owned temporary cache', { timeout: 30000 }, async t => {
  const root = await ownedRoot(t);
  const host = await PluginHost.open({ directory: path.join(root, 'host'), preinstalled: false });
  try {
    await host.install(path.resolve('plugins/xmltv'));
    await host.connect({});
    assert.equal(host.get('xmltv').status, 'active');
    assert.equal(host.entries('listings')[0].cachePath, path.join(root, 'host', 'cache', 'xmltv', 'xmltv'));
  } finally { await host.close(); }
});

test('unsafe cache identities cannot create files outside the provider cache', { timeout: 30000 }, async t => {
  const root = await ownedRoot(t), cachePath = path.join(root, 'cache');
  let opened = 0;
  const provider = createXmlTvListingsProvider({ cachePath, source: { openRead() { opened++; throw new Error('Unexpected source admission.'); } } });
  try {
    for (const Id of ['../escape', '..\\escape', '/absolute', 'C:\\alternate', 'stream:ads', 'nul\0id']) {
      await assert.rejects(provider.getLineups({ Id, Path: '/mapped.xml' }, '', ''), { code: 'invalid-path' });
    }
    assert.equal(opened, 0); assert.deepEqual(await fs.readdir(root), []);
  } finally { await provider.close(); }
});

test('a competing real cache writer cannot delete another admitted writer temporary file', { timeout: 30000 }, async t => {
  const root = await ownedRoot(t), cachePath = path.join(root, 'cache');
  const admitted = Promise.withResolvers(), release = Promise.withResolvers();
  let opened = 0, closed = 0;
  const source = { async openRead() {
    const owner = ++opened;
    return { stream: (async function* () {
      if (owner === 1) { yield xml.subarray(0, 5); admitted.resolve(); await release.promise; yield xml.subarray(5); }
      else yield xml;
    })(), async close() { closed++; } };
  } };
  const first = createXmlTvListingsProvider({ cachePath, source }), second = createXmlTvListingsProvider({ cachePath, source });
  const info = { Id: 'same-id', Path: '/mapped.xml' }, pending = first.getLineups(info, '', '');
  pending.catch(() => {});
  try {
    await Promise.race([admitted.promise, pending.then(() => { throw new Error('The owner completed before the held write.'); })]);
    const temporary = path.join(cachePath, 'same-id.xml.tmp');
    assert.deepEqual(await fs.readFile(temporary), xml.subarray(0, 5));
    const competingInfo = { ...info, Id: process.platform === 'win32' ? 'SAME-ID' : info.Id };
    await assert.rejects(second.getLineups(competingInfo, '', ''), { code: 'EBUSY' });
    assert.deepEqual(await fs.readFile(temporary), xml.subarray(0, 5), 'A rejected owner must retain the admitted writer bytes.');
    release.resolve(); assert.deepEqual(await pending, [{ Id: 'c1', Name: 'English' }]);
    assert.equal(opened, 2); assert.equal(closed, 2);
    assert.deepEqual(await fs.readFile(path.join(cachePath, 'same-id.xml')), xml);
    assert.deepEqual(await fs.readdir(cachePath), ['same-id.xml']);
  } finally { release.resolve(); await Promise.allSettled([pending, first.close(), second.close()]); }
});

test('separately installed XMLTV packages protect shared cache files and release a failed writer', { timeout: 30000 }, async t => {
  const root = await ownedRoot(t), cachePath = path.join(root, 'cache'), sourceRoot = path.join(root, 'mapped');
  await fs.mkdir(sourceRoot);
  const filename = path.join(sourceRoot, 'guide.xml'); await fs.writeFile(filename, xml);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const failure = Object.assign(new Error('The controlled XMLTV cache write failed.'), { code: 'EIO' });
  let firstHost, secondHost, storage, pending, rejected, held = true, opened = 0, closed = 0;
  try {
    firstHost = await PluginHost.open({ directory: path.join(root, 'first-host'), preinstalled: false,
      options: { xmltv: { cachePath, fileSystem: { ...fs, async open(...args) {
        const file = await fs.open(...args); opened++;
        return { async writeFile(bytes) {
          await file.writeFile(bytes);
          if (held) { held = false; entered.resolve(); await release.promise; throw failure; }
        }, async close() { await file.close(); closed++; } };
      } } } } });
    secondHost = await PluginHost.open({ directory: path.join(root, 'second-host'), preinstalled: false, options: { xmltv: { cachePath } } });
    await firstHost.install(path.resolve('plugins/local'));
    await firstHost.install(path.resolve('plugins/xmltv'));
    await secondHost.install(path.resolve('plugins/xmltv'));
    storage = await createConfiguredStorage(undefined, { plugins: firstHost });
    await storage.configure({ instances: [{ id: 'source', type: 'local', config: { root: sourceRoot } }],
      mounts: [{ path: '/source', instanceId: 'source', root: '/', capabilities: {} }],
      prefixes: [{ identityRoot: sourceRoot, accessRoot: '/source', style: process.platform === 'win32' ? 'windows' : 'posix',
        caseSensitive: process.platform !== 'win32', purpose: 'metadata', returnAccess: 'Both installed XMLTV packages read the same isolated mapped source.' }] });
    const services = { metadataVfs: storage.metadataVfs, metadataIdentityMap: storage.metadataIdentityMap };
    await firstHost.connect(services); await secondHost.connect(services);
    const first = firstHost.entries('listings')[0], second = secondHost.entries('listings')[0];
    const info = { Id: 'shared', Path: filename }, temporary = path.join(cachePath, 'shared.xml.tmp');
    pending = first.getLineups(info, '', '');
    rejected = assert.rejects(pending, error => error.code === failure.code && error.message === failure.message);
    void rejected.catch(() => {});
    await Promise.race([entered.promise, pending.then(() => { throw new Error('The owner completed before its held write.'); })]);
    assert.deepEqual(await fs.readFile(temporary), xml);
    await assert.rejects(second.getLineups(info, '', ''), { code: 'EBUSY' });
    assert.deepEqual(await fs.readFile(temporary), xml);
    release.resolve(); await rejected;
    assert.equal(opened, 1); assert.equal(closed, opened);
    assert.deepEqual(await fs.readdir(cachePath), []);
    assert.deepEqual(await second.getLineups(info, '', ''), [{ Id: 'c1', Name: 'English' }]);
    assert.deepEqual(await fs.readFile(path.join(cachePath, 'shared.xml')), xml);
    assert.deepEqual(await fs.readdir(cachePath), ['shared.xml']);
  } finally {
    release.resolve(); await Promise.allSettled([pending, rejected]);
    try { await secondHost?.close(); } finally { try { await firstHost?.close(); } finally { await storage?.close(); } }
  }
});

async function cacheAliasScenario(t, mode) {
  const root = await ownedRoot(t), cachePath = path.join(root, 'cache'), alias = path.join(root, 'cache-alias');
  const sourceRoot = path.join(root, 'mapped'), filename = path.join(sourceRoot, 'guide.xml');
  const competingFilename = path.join(sourceRoot, 'competing.xml');
  const competingXml = Buffer.from('<tv><channel id="c2"><display-name>Competing ' + 'X'.repeat(1024) + '</display-name></channel></tv>');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const failure = Object.assign(new Error('The controlled XMLTV alias cache write failed.'), { code: 'EIO' });
  const temporary = path.join(cachePath, 'shared.xml.tmp'), target = path.join(cachePath, 'shared.xml');
  const report = { mode, scope: 'Two installed XMLTV packages, one actual cache directory through real and alias paths; no recording or encoding.',
    events: [], diagnostics: [], cleanup: {} };
  const describe = (reason, seen = new Set()) => {
    if (reason === null || typeof reason !== 'object') return { valueType: typeof reason,
      ...(reason === undefined ? {} : { value: typeof reason === 'bigint' || typeof reason === 'symbol' ? String(reason) : reason }) };
    if (seen.has(reason)) return { repeatedCause: true };
    seen.add(reason);
    return { ...errorDiagnostic(reason), ...(Object.hasOwn(reason, 'cause') ? { cause: describe(reason.cause, seen) } : {}),
      ...(Array.isArray(reason.errors) ? { errors: reason.errors.map(value => describe(value, seen)) } : {}) };
  };
  const observe = pending => Promise.resolve(pending).then(value => ({ fulfilled: true, value }), reason => ({ fulfilled: false, reason }));
  const outcome = observed => observed.fulfilled ? observed : { fulfilled: false, reason: describe(observed.reason) };
  const mark = (owner, phase) => report.events.push({ owner, phase, at: new Date().toISOString() });
  const snapshot = async file => {
    try {
      const bytes = await fs.readFile(file);
      return { exists: true, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytesBase64: bytes.toString('base64') };
    } catch (reason) { if (reason.code === 'ENOENT') return { exists: false }; throw reason; }
  };
  const cacheSnapshot = async () => ({ temporary: await snapshot(temporary), target: await snapshot(target),
    names: (await fs.readdir(cachePath)).sort() });
  let firstHost, secondHost, storage, firstPending, competingPending, firstResult, competingResult, retryResult;
  let primary, failed = false, held = true;
  const cleanupErrors = [];
  try {
    await fs.mkdir(cachePath); await fs.mkdir(sourceRoot);
    await fs.symlink(cachePath, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(filename, xml); await fs.writeFile(competingFilename, competingXml);
    report.paths = { cachePath, alias, realCache: await fs.realpath(cachePath), realAlias: await fs.realpath(alias) };
    firstHost = await PluginHost.open({ directory: path.join(root, 'first-host'), preinstalled: false,
      onError: reason => report.diagnostics.push({ owner: 'first-host', error: describe(reason) }),
      options: { xmltv: { cachePath, logger: { error: reason => report.diagnostics.push({ owner: 'first-provider', error: describe(reason) }) },
        fileSystem: { ...fs, async open(...args) {
          const file = await fs.open(...args); mark('first-cache-file', 'opened');
          return { async writeFile(bytes) {
            if (!held) return file.writeFile(bytes);
            held = false;
            await file.writeFile(bytes.subarray(0, 5)); mark('first-cache-file', 'prefix-written'); entered.resolve();
            await release.promise;
            if (mode === 'write-failure') throw failure;
            await file.writeFile(bytes.subarray(5)); mark('first-cache-file', 'body-written');
          }, async close() {
            mark('first-cache-file', 'close-started'); await file.close(); mark('first-cache-file', 'close-settled');
          } };
        } } } } });
    secondHost = await PluginHost.open({ directory: path.join(root, 'second-host'), preinstalled: false,
      onError: reason => report.diagnostics.push({ owner: 'second-host', error: describe(reason) }),
      options: { xmltv: { cachePath: alias,
        logger: { error: reason => report.diagnostics.push({ owner: 'second-provider', error: describe(reason) }) } } } });
    await firstHost.install(path.resolve('plugins/local'));
    await firstHost.install(path.resolve('plugins/xmltv')); await secondHost.install(path.resolve('plugins/xmltv'));
    storage = await createConfiguredStorage(undefined, { plugins: firstHost });
    await storage.configure({ instances: [{ id: 'source', type: 'local', config: { root: sourceRoot } }],
      mounts: [{ path: '/source', instanceId: 'source', root: '/', capabilities: {} }],
      prefixes: [{ identityRoot: sourceRoot, accessRoot: '/source', style: process.platform === 'win32' ? 'windows' : 'posix',
        caseSensitive: process.platform !== 'win32', purpose: 'metadata', returnAccess: 'Both installed XMLTV packages read declared real source files while their cache roots alias one directory.' }] });
    const services = { metadataVfs: storage.metadataVfs, metadataIdentityMap: storage.metadataIdentityMap };
    await firstHost.connect(services); await secondHost.connect(services);
    const first = firstHost.entries('listings')[0], second = secondHost.entries('listings')[0];
    const info = { Id: 'shared', Path: filename }, competingInfo = { Id: 'shared', Path: competingFilename };
    firstPending = observe(first.getLineups(info, '', ''));
    await Promise.race([entered.promise, firstPending.then(value => { throw new Error('The first writer ended before its held prefix.', { cause: value }); })]);
    report.beforeCompetition = await cacheSnapshot();
    report.aliasPrefix = await snapshot(path.join(alias, 'shared.xml.tmp'));
    assert.equal(report.beforeCompetition.temporary.bytesBase64, xml.subarray(0, 5).toString('base64'));
    assert.deepEqual(report.aliasPrefix, report.beforeCompetition.temporary);
    competingPending = observe(second.getLineups(competingInfo, '', ''));
    competingResult = await competingPending; report.competing = outcome(competingResult);
    report.afterCompetition = await cacheSnapshot();
    release.resolve(); firstResult = await firstPending; report.first = outcome(firstResult);
    report.afterFirst = await cacheSnapshot();
    retryResult = await observe(second.getLineups(competingInfo, '', '')); report.retry = outcome(retryResult);
    report.afterRetry = await cacheSnapshot();
  } catch (reason) { primary = reason; failed = true; }
  finally {
    release.resolve(); await Promise.allSettled([firstPending, competingPending]);
    for (const [owner, resource] of [['second-host', secondHost], ['first-host', firstHost], ['storage', storage]]) {
      if (!resource) continue;
      try { mark(owner, 'close-started'); await resource.close(); mark(owner, 'close-settled'); report.cleanup[owner] = true; }
      catch (reason) { cleanupErrors.push(reason); report.cleanup[owner] = { error: describe(reason) }; }
    }
    try {
      report.afterClose = await cacheSnapshot();
      report.sourcesAfterClose = { first: await snapshot(filename), competing: await snapshot(competingFilename) };
    } catch (reason) {
      report.afterCloseFailure = describe(reason);
      if (failed) cleanupErrors.push(reason); else { primary = reason; failed = true; }
    }
    try {
      const output = path.join(validationOutputRoot(), 'xmltv-cache-alias-' + mode + '-' + randomUUID() + '.json');
      assertValidationOutputChild(output); await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      t.diagnostic(JSON.stringify({ mode, report: output }));
    } catch (reason) {
      try { t.diagnostic(JSON.stringify({ mode, report, diagnosticError: describe(reason) })); } catch { /* Keep the original business or close outcome. */ }
    }
  }
  if (cleanupErrors.length) throw new AggregateError(failed ? [primary, ...cleanupErrors] : cleanupErrors,
    primary?.message ?? 'XMLTV alias cache consumers failed to close.', failed ? { cause: primary } : undefined);
  if (failed) throw primary;
  assert.equal(competingResult.fulfilled, false, 'A competing alias must not open or publish through the held writer path.');
  assert.equal(competingResult.reason.code, 'EBUSY');
  assert.deepEqual(report.afterCompetition.temporary, report.beforeCompetition.temporary);
  assert.equal(report.afterCompetition.target.exists, false);
  if (mode === 'publish') {
    assert.equal(firstResult.fulfilled, true); assert.deepEqual(firstResult.value, [{ Id: 'c1', Name: 'English' }]);
    assert.equal(report.afterFirst.target.bytesBase64, xml.toString('base64'));
    assert.equal(retryResult.fulfilled, true); assert.deepEqual(retryResult.value, firstResult.value);
  } else {
    assert.equal(firstResult.fulfilled, false); assert.equal(firstResult.reason.code, failure.code);
    assert.equal(firstResult.reason.message, failure.message);
    assert.deepEqual(report.afterFirst.names, []);
    assert.equal(retryResult.fulfilled, true);
    assert.deepEqual(retryResult.value, [{ Id: 'c2', Name: 'Competing ' + 'X'.repeat(1024) }]);
  }
  assert.equal(report.afterClose.target.bytesBase64, (mode === 'publish' ? xml : competingXml).toString('base64'));
  assert.deepEqual(report.afterClose.names, ['shared.xml']);
  assert.equal(report.sourcesAfterClose.first.bytesBase64, xml.toString('base64'));
  assert.equal(report.sourcesAfterClose.competing.bytesBase64, competingXml.toString('base64'));
}

test('XMLTV directory aliases protect a held real cache writer through publication', { timeout: 30000 },
  t => cacheAliasScenario(t, 'publish'));
test('XMLTV directory aliases protect a held real cache writer through write failure', { timeout: 30000 },
  t => cacheAliasScenario(t, 'write-failure'));

test('a failed source open removes an abandoned temporary file without creating a cache', { timeout: 30000 }, async t => {
  const root = await ownedRoot(t), cachePath = path.join(root, 'cache');
  await fs.mkdir(cachePath); await fs.writeFile(path.join(cachePath, 'abandoned.xml.tmp'), 'abandoned bytes');
  const provider = createXmlTvListingsProvider({ cachePath, source: { async openRead() {
    throw Object.assign(new Error('The controlled mapped source is missing.'), { code: 'ENOENT' });
  } } });
  try {
    await assert.rejects(provider.getLineups({ Id: 'abandoned', Path: '/mapped.xml' }, '', ''), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(cachePath), []);
  } finally { await provider.close(); }
});

test('abandoned temporary-file cleanup excludes a new writer until unlink completes', { timeout: 30000 }, async t => {
  const root = await ownedRoot(t), cachePath = path.join(root, 'cache');
  const temporary = path.join(cachePath, 'same-id.xml.tmp');
  await fs.mkdir(cachePath); await fs.writeFile(temporary, 'abandoned bytes');
  const removing = Promise.withResolvers(), release = Promise.withResolvers();
  let sourceClosed = 0;
  const first = createXmlTvListingsProvider({ cachePath, fileSystem: { ...fs, async unlink(filename) {
    removing.resolve(); await release.promise; return fs.unlink(filename);
  } }, source: { async openRead() {
    throw Object.assign(new Error('The controlled mapped source is missing.'), { code: 'ENOENT' });
  } } });
  const second = createXmlTvListingsProvider({ cachePath, source: { async openRead() {
    return { stream: [xml], async close() { sourceClosed++; } };
  } } });
  const info = { Id: 'same-id', Path: '/mapped.xml' }, pending = first.getLineups(info, '', '');
  const rejected = assert.rejects(pending, error => error.code === 'ENOENT');
  try {
    await Promise.race([removing.promise, pending.then(() => { throw new Error('The owner completed before cleanup admission.'); })]);
    await assert.rejects(second.getLineups(info, '', ''));
    assert.equal(sourceClosed, 1);
    assert.equal(await fs.readFile(temporary, 'utf8'), 'abandoned bytes');
    release.resolve(); await rejected;
    assert.deepEqual(await fs.readdir(cachePath), []);
    assert.deepEqual(await second.getLineups(info, '', ''), [{ Id: 'c1', Name: 'English' }]);
    assert.equal(sourceClosed, 2);
    assert.deepEqual(await fs.readFile(path.join(cachePath, 'same-id.xml')), xml);
    assert.deepEqual(await fs.readdir(cachePath), ['same-id.xml']);
  } finally { release.resolve(); await Promise.allSettled([pending, rejected, first.close(), second.close()]); }
});

test('close cancels admitted real file writes, rejects new work and drains the source close owner', { timeout: 30000 }, async t => {
  const root = await ownedRoot(t), cachePath = path.join(root, 'cache');
  const admitted = Promise.withResolvers(), aborted = Promise.withResolvers(), closingSource = Promise.withResolvers(), releaseClose = Promise.withResolvers();
  let sourceClosed = 0, providerClosed = false, sourceSignal;
  const provider = createXmlTvListingsProvider({ cachePath, source: { async openRead(_identity, { signal }) {
    sourceSignal = signal;
    const abort = () => aborted.reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    // Attach before the first pull: shutdown may arrive between admission and iteration.
    aborted.promise.catch(() => {});
    return { stream: (async function* () { yield xml.subarray(0, 5); admitted.resolve(); await aborted.promise; })(),
      async close() { closingSource.resolve(); await releaseClose.promise; sourceClosed++; signal.removeEventListener('abort', abort); } };
  } } });
  const pending = provider.getLineups({ Id: 'held', Path: '/mapped.xml' }, '', ''), rejected = assert.rejects(pending, error => {
    assert.equal(sourceSignal.aborted, true); assert.equal(error.message, sourceSignal.reason.message);
    assert.equal(error.code, sourceSignal.reason.code); return true;
  });
  let closing;
  try {
    await Promise.race([admitted.promise, pending.then(() => { throw new Error('The owner completed before the held write.'); })]);
    closing = provider.close().then(() => { providerClosed = true; });
    await closingSource.promise; await turn();
    assert.equal(providerClosed, false, 'Provider shutdown must wait for its admitted source owner.');
    await assert.rejects(provider.getChannels({ Id: 'new', Path: '/mapped.xml' }), { status: 503 });
    assert.deepEqual(await fs.readdir(cachePath), []);
    releaseClose.resolve(); await Promise.all([closing, rejected]);
    assert.equal(sourceClosed, 1); assert.equal(providerClosed, true);
  } finally { releaseClose.resolve(); aborted.reject(new DOMException('Test cleanup.', 'AbortError')); await Promise.allSettled([pending, closing, provider.close()]); }
});
