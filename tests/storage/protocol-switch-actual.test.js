import { testFileSystem } from './plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getNewItemId } from '../../src/core/identity.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { IdentityAccessMap, ProbeReadBridge, StorageRegistry, VirtualFileSystem, probeRaw } from '../../src/storage/index.js';
import { AListAdapter } from '../../plugins/alist/adapter.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';
import { startActualAList } from './helpers/actual-alist.js';
import { startActualWebDav } from './helpers/actual-webdav.js';

const alistExecutable = process.env.MEDIAMANAGER_ALIST_EXECUTABLE;
const webdavExecutable = process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE;
const connectionString = process.env.MEDIAMANAGER_TEST_POSTGRES;

const identityRoot = 'Z:\\Protocol Switch';
const fileName = '中文 %2F space # sample.wav';
const identityPath = `${identityRoot}\\${fileName}`;
const accessPath = `/media/${fileName}`;
const itemType = 'MediaBrowser.Controller.Entities.Video';
const identityOptions = { programDataPath: 'C:\\Jellyfin\\data' };

function wave() {
  const result = Buffer.alloc(1644);
  result.write('RIFF');
  result.writeUInt32LE(result.length - 8, 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(8000, 24);
  result.writeUInt32LE(16000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36);
  result.writeUInt32LE(1600, 40);
  return result;
}

async function read(handle) {
  try {
    const chunks = [];
    for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

function createIdentityMap(label) {
  const identityMap = new IdentityAccessMap();
  identityMap.addPrefix({
    identityRoot,
    accessRoot: '/media',
    style: 'windows',
    caseSensitive: false,
    returnAccess: `Actual ${label} protocol-switch validation over the shared isolated physical root.`,
  });
  return identityMap;
}

function comparableEntry(entry) {
  return { name: entry.name, kind: entry.kind, size: entry.size };
}

async function observeProtocol({ label, vfs, identityMap, bridge, requests, bytes }) {
  const resolved = identityMap.resolve({ identityPath, style: 'windows' });
  const reverse = identityMap.identityFor(resolved);
  assert.equal(resolved, accessPath, `${label}: identity-to-access mapping`);
  assert.equal(reverse.identityPath, identityPath, `${label}: access-to-identity writeback`);
  assert.equal(reverse.style, 'windows');

  const itemId = getNewItemId(identityPath, itemType, identityOptions);
  const stat = await vfs.stat(accessPath);
  assert.equal(stat.kind, 'file');
  assert.equal(stat.name, fileName);
  assert.equal(stat.size, BigInt(bytes.length));

  const listing = await vfs.list('/media');
  assert.equal(listing.complete, true);
  assert.equal(listing.deletionSafe, false);
  const entries = listing.entries.map(comparableEntry).sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(entries.map(entry => entry.name), [fileName.replace(/\.wav$/u, '.nfo'), fileName].sort((left, right) => left.localeCompare(right)));

  const full = await read(await vfs.openRead(accessPath));
  assert.deepEqual(full, bytes);
  const range = await vfs.openRead(accessPath, { range: { start: 37n, end: 126n } });
  assert.equal(range.rangeHonored, true);
  assert.equal(range.totalSize, BigInt(bytes.length));
  const rangeBytes = await read(range);
  assert.deepEqual(rangeBytes, bytes.subarray(37, 127));

  const plugin = createNfoPlugin({fileSystem: testFileSystem,  vfs });
  const metadata = await plugin.getMetadata({ Type: 'Video', Path: identityPath }, { accessPath });
  assert.equal(metadata.HasMetadata, true);
  assert.equal(metadata.Item.Name, 'Protocol parity 中文 %2F #');

  const probe = await probeRaw(bridge, accessPath, { extractChapters: true });
  assert.equal(probe.exitCode, 0);
  const probeCore = {
    codec: probe.raw.streams?.[0]?.codec_name,
    codecType: probe.raw.streams?.[0]?.codec_type,
    sampleRate: probe.raw.streams?.[0]?.sample_rate,
    channels: probe.raw.streams?.[0]?.channels,
    format: probe.raw.format?.format_name,
    duration: probe.raw.format?.duration,
    size: probe.raw.format?.size,
  };
  assert.deepEqual(probeCore, {
    codec: 'pcm_s16le', codecType: 'audio', sampleRate: '8000', channels: 1,
    format: 'wav', duration: '0.100000', size: String(bytes.length),
  });

  const beforeRejectedWrites = requests.length;
  for (const operation of [
    () => vfs.write('/media/rejected.txt', Buffer.from('must not cross the mount'), { overwrite: false }),
    () => vfs.mkdir('/media/rejected-directory'),
    () => vfs.delete('/media/rejected.txt'),
    () => vfs.rename(accessPath, '/media/rejected.wav'),
  ]) await assert.rejects(operation(), { code: 'not-supported' });
  assert.equal(requests.length, beforeRejectedWrites, `${label}: read-only mount rejects before transport`);

  return {
    itemId,
    reverseIdentityPath: reverse.identityPath,
    stat: comparableEntry(stat),
    entries,
    fullSha256: createHash('sha256').update(full).digest('hex'),
    rangeSha256: createHash('sha256').update(rangeBytes).digest('hex'),
    probeCore,
    nfoName: metadata.Item.Name,
  };
}

test('actual AList and WebDAV preserve one media identity when only the protocol adapter changes', {
  skip: !alistExecutable || !webdavExecutable || !connectionString
    ? 'Actual AList, rclone WebDAV and isolated PostgreSQL are required.' : false,
}, async (t) => {
  const alist = await startActualAList({ connectionString });
  let webdav;
  try { webdav = await startActualWebDav({ sourceRoot: alist.media }); }
  catch (error) { await alist.stop(); throw error; }

  const bytes = wave();
  await mkdir(alist.media, { recursive: true });
  await writeFile(path.join(alist.media, fileName), bytes);
  await writeFile(path.join(alist.media, fileName.replace(/\.wav$/u, '.nfo')),
    '<?xml version="1.0" encoding="utf-8"?>\n<movie><title>Protocol parity 中文 %2F #</title></movie>\n');

  const requests = { alist: [], webdav: [] };
  const registry = new StorageRegistry();
  registry.registerType('alist', config => new AListAdapter(config, {
    resolveCredential: async () => alist.token,
    fetch: async (url, options) => {
      requests.alist.push({ method: options.method, path: new URL(url).pathname });
      return fetch(url, options);
    },
  }));
  registry.registerType('webdav', config => new WebDavAdapter(config, {
    resolveCredential: async () => webdav.authorization,
    fetch: async (url, options) => {
      requests.webdav.push({ method: options.method, path: new URL(url).pathname });
      return fetch(url, options);
    },
  }));
  const writableCapabilities = { create: true, replace: true, mkdir: true, delete: true, rename: true };
  await registry.createInstance('alist', 'alist', {
    baseUrl: alist.baseUrl,
    credentialRef: 'isolated',
    pageSize: 1,
    capabilities: writableCapabilities,
  });
  await registry.createInstance('webdav', 'webdav', {
    baseUrl: webdav.baseUrl,
    credentialRef: 'isolated',
    pageSize: 1,
    capabilities: writableCapabilities,
  });

  const stacks = {};
  for (const [label, instanceId, root] of [['alist', 'alist', '/Synthetic'], ['webdav', 'webdav', '/']]) {
    const vfs = new VirtualFileSystem(registry);
    vfs.mount({ path: '/media', instanceId, root, capabilities: {} });
    stacks[label] = { label, vfs, identityMap: createIdentityMap(label), bridge: new ProbeReadBridge(vfs),
      requests: requests[label], bytes };
  }
  t.after(async () => {
    await Promise.allSettled(Object.values(stacks).map(stack => stack.bridge.close()));
    await registry.close();
    await webdav.stop();
    await alist.stop();
  });

  const alistObservation = await observeProtocol(stacks.alist);
  const webdavObservation = await observeProtocol(stacks.webdav);
  assert.deepEqual(webdavObservation, alistObservation);
  assert.equal(alistObservation.itemId, getNewItemId(identityPath, itemType, identityOptions));
  assert.match(alistObservation.itemId, /^[0-9a-f]{32}$/u);
  assert.ok(requests.alist.some(request => request.method === 'GET'));
  assert.ok(requests.webdav.some(request => request.method === 'GET'));
  assert.ok(requests.webdav.some(request => request.method === 'PROPFIND'));
});
