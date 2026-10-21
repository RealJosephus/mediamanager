import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../src/plugins/host.js';
import { createConfiguredStorage } from '../../src/storage-bootstrap.js';
import { createXmlTvListingsProvider } from '../../plugins/xmltv/provider.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
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

test('installed and official XMLTV packages use ordinary listings activation and mapped local sources', { timeout: 30000 }, async t => {
  for (const preinstalled of [false, true]) {
    const root = await ownedRoot(t), cachePath = path.join(root, 'cache');
    let official = false;
    if (preinstalled) {
      official = path.join(root, 'official'); await fs.mkdir(official);
      await fs.cp(path.resolve('plugins/xmltv'), path.join(official, 'xmltv'), { recursive: true });
    }
    const host = await PluginHost.open({ directory: path.join(root, 'host'), cachePath, preinstalled: official });
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
      await assert.rejects(provider.validate({ Id: 'unmapped', Path: outside }, true, true), { name: 'FileNotFoundException' });
      await assert.rejects(host.configure('xmltv', { Path: filename }), /each native listings provider configuration/u);
      await host.setEnabled('xmltv', false);
      assert.throws(() => provider.getLineups(info, '', ''), { status: 503 });
      assert.deepEqual(await fs.readdir(path.join(cachePath, 'xmltv')), ['legal-non-guid-id.xml']);
    } finally { try { await host.close(); } finally { await storage?.close(); } }
  }
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
      await assert.rejects(provider.getLineups({ Id, Path: '/mapped.xml' }, '', ''), { name: 'ArgumentException' });
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
    await assert.rejects(second.getLineups(competingInfo, '', ''), { name: 'IOException' });
    assert.deepEqual(await fs.readFile(temporary), xml.subarray(0, 5), 'A rejected owner must retain the admitted writer bytes.');
    release.resolve(); assert.deepEqual(await pending, [{ Id: 'c1', Name: 'English' }]);
    assert.equal(opened, 2); assert.equal(closed, 2);
    assert.deepEqual(await fs.readFile(path.join(cachePath, 'same-id.xml')), xml);
    assert.deepEqual(await fs.readdir(cachePath), ['same-id.xml']);
  } finally { release.resolve(); await Promise.allSettled([pending, first.close(), second.close()]); }
});

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

test('close cancels admitted real file writes, rejects new work and drains the source close owner', { timeout: 30000 }, async t => {
  const root = await ownedRoot(t), cachePath = path.join(root, 'cache');
  const admitted = Promise.withResolvers(), aborted = Promise.withResolvers(), closingSource = Promise.withResolvers(), releaseClose = Promise.withResolvers();
  let sourceClosed = 0, providerClosed = false;
  const provider = createXmlTvListingsProvider({ cachePath, source: { async openRead(_identity, { signal }) {
    const abort = () => aborted.reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    // Attach before the first pull: shutdown may arrive between admission and iteration.
    aborted.promise.catch(() => {});
    return { stream: (async function* () { yield xml.subarray(0, 5); admitted.resolve(); await aborted.promise; })(),
      async close() { closingSource.resolve(); await releaseClose.promise; sourceClosed++; signal.removeEventListener('abort', abort); } };
  } } });
  const pending = provider.getLineups({ Id: 'held', Path: '/mapped.xml' }, '', ''), rejected = assert.rejects(pending, { name: 'AbortError' });
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
