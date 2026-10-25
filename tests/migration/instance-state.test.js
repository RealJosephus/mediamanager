import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { discoverInstanceState, validateWriteBarrier } from '../../src/migration/instance-state.js';

const serverId = '0123456789abcdef0123456789abcdef';
const recordedAt = '2026-10-04T00:00:00.000Z';
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const restoredStateMarker = (root, generation = '11111111-1111-4111-8111-111111111111') => ({
  generation,
  manifestSha256: 'a'.repeat(64),
  layoutSha256: 'c'.repeat(64),
  systemConfigurationSha256: 'd'.repeat(64),
  destination: root,
  stage: 'complete',
  database: { restorePath: 'data/data/jellyfin.db', sha256: 'b'.repeat(64) },
  extensionStateSha256: 'e'.repeat(64),
  mediaAccessSha256: 'f'.repeat(64),
});

async function withRootScanMutation(root, mutate, operation) {
  const originalReaddir = fs.promises.readdir;
  let mutated = false;
  fs.promises.readdir = async (...args) => {
    const entries = await originalReaddir(...args);
    if (!mutated && typeof args[0] === 'string' && path.resolve(args[0]) === path.join(root, 'data')) {
      mutated = true;
      await mutate();
    }
    return entries;
  };
  syncBuiltinESMExports();
  try { await operation(); }
  finally {
    fs.promises.readdir = originalReaddir;
    syncBuiltinESMExports();
  }
  assert.equal(mutated, true, 'the deterministic mutation must run after the initial top-level capture');
}

async function instance(t, { system = '', device = serverId, database = true } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-instance-state-'));
  t.after(async () => { assert.equal(path.dirname(parent), os.tmpdir()); await rm(parent, { recursive: true, force: true }); });
  const root = path.join(parent, 'instance');
  for (const directory of ['data/data', 'data/metadata', 'config', 'cache', 'log']) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, 'config/system.xml'), `<ServerConfiguration>${system}</ServerConfiguration>`);
  await writeFile(path.join(root, 'config/network.xml'), '<NetworkConfiguration><EnableIPv4>true</EnableIPv4></NetworkConfiguration>');
  await writeFile(path.join(root, 'data/data/device.txt'), device);
  if (database) await writeFile(path.join(root, 'data/data/jellyfin.db'), 'isolated sqlite fixture');
  return { parent, root };
}

const stoppedBarrier = state => ({
  kind: 'stopped-service',
  identityDigest: state.identity.digest,
  recordedAt,
  ownedProcess: { pid: 1234, shutdown: { kind: 'http', statusCode: 204 }, forced: false, exitCode: 0, signalCode: null, stopped: true },
});

const offlineBarrier = (state, sourceIdentityDigest = state.identity.digest) => ({
  kind: 'isolated-offline-copy',
  identityDigest: state.identity.digest,
  recordedAt,
  isolatedCopy: { owner: { kind: 'test-fixture', id: 'instance-state default fixture' },
    source: { identityDigest: sourceIdentityDigest, serverId: state.identity.serverId } },
});

test('discovers a complete default isolated instance and returns state-package inputs', async t => {
  const { root } = await instance(t);
  await writeFile(path.join(root, 'data/metadata/poster.jpg'), 'metadata');
  await writeFile(path.join(root, 'cache/CACHEDIR.TAG'), 'cache');
  await writeFile(path.join(root, 'log/log.txt'), 'log');
  const state = await discoverInstanceState({ instanceRoot: root });
  assert.equal(state.kind, 'jellyfin-instance-state');
  assert.equal(state.identity.serverId, serverId);
  assert.match(state.identity.digest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(state.identity.databaseGeneration.files.map(file => file.role), ['sqlite']);
  assert.match(state.identity.databaseGeneration.digest, /^[a-f0-9]{64}$/u);
  assert.match(state.identity.stateGeneration.digest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(state.identity.controlGeneration.inventory, [
    { name: 'cache', kind: 'state-root', root: 'cache' },
    { name: 'config', kind: 'state-root', root: 'config' },
    { name: 'data', kind: 'state-root', root: 'data' },
    { name: 'log', kind: 'state-root', root: 'log' },
  ]);
  assert.equal(state.identity.stateGeneration.rootCount, 4);
  assert.equal(state.identity.stateGeneration.fileCount, 7);
  assert.deepEqual(state.roots, { data: path.join(root, 'data'), config: path.join(root, 'config'), cache: path.join(root, 'cache'), log: path.join(root, 'log') });
  assert.equal(Object.hasOwn(state, 'sourceDatabasePaths'), false);
  assert.equal(Object.hasOwn(state, 'databaseRestorePath'), false);
  assert.equal(state.paths.metadata, path.join(root, 'data/metadata'));
  assert.equal(state.paths.cache, path.join(root, 'cache'));
  assert.deepEqual(state.pathBindings, {
    metadata: { configured: false, root: 'data', relativePath: 'metadata' },
    cache: { configured: false, root: 'cache', relativePath: '' },
  });
  assert.deepEqual(await validateWriteBarrier(stoppedBarrier(state), state), stoppedBarrier(state));
  assert.deepEqual(await validateWriteBarrier(offlineBarrier(state), state), offlineBarrier(state));
});

test('discovers external metadata and cache while retaining their default local roots', async t => {
  const { parent, root } = await instance(t);
  const metadata = path.join(parent, 'external metadata'), cache = path.join(parent, 'external cache');
  await mkdir(metadata); await mkdir(cache);
  await writeFile(path.join(metadata, 'person.jpg'), 'metadata');
  await writeFile(path.join(cache, 'image.bin'), 'cache');
  await writeFile(path.join(root, 'config/system.xml'), `<ServerConfiguration><MetadataPath>${xml(metadata)}</MetadataPath><CachePath>${xml(cache)}</CachePath></ServerConfiguration>`);
  const state = await discoverInstanceState({ instanceRoot: root });
  assert.equal(state.paths.defaultMetadata, path.join(root, 'data/metadata'));
  assert.equal(state.paths.metadata, metadata);
  assert.equal(state.paths.defaultCache, path.join(root, 'cache'));
  assert.equal(state.paths.cache, cache);
  assert.deepEqual(state.roots, { data: path.join(root, 'data'), config: path.join(root, 'config'), cache: path.join(root, 'cache'),
    log: path.join(root, 'log'), 'metadata-external': metadata, 'cache-external': cache });
  assert.deepEqual(state.pathBindings, {
    metadata: { configured: true, root: 'metadata-external', relativePath: '' },
    cache: { configured: true, root: 'cache-external', relativePath: '' },
  });
});

test('configured metadata and cache already inside captured roots do not create overlapping roots', async t => {
  const { root } = await instance(t);
  const metadata = path.join(root, 'data/metadata/custom'), cache = path.join(root, 'cache/custom');
  await mkdir(metadata, { recursive: true }); await mkdir(cache);
  await writeFile(path.join(root, 'config/system.xml'), `<ServerConfiguration><MetadataPath>${xml(metadata)}</MetadataPath><CachePath>${xml(cache)}</CachePath></ServerConfiguration>`);
  const state = await discoverInstanceState({ instanceRoot: root });
  assert.equal(state.paths.metadata, metadata); assert.equal(state.paths.cache, cache);
  assert.deepEqual(Object.keys(state.roots), ['data', 'config', 'cache', 'log']);
  assert.deepEqual(state.pathBindings, {
    metadata: { configured: true, root: 'data', relativePath: 'metadata/custom' },
    cache: { configured: true, root: 'cache', relativePath: 'custom' },
  });
});

test('rejects external root overlap and configured path escapes', async t => {
  const { parent, root } = await instance(t);
  const external = path.join(parent, 'external'); await mkdir(external);
  for (const [name, metadata, cache, expected] of [
    ['metadata and cache alias', external, external, /state roots overlap/u],
    ['external root contains the instance', parent, '', /state roots overlap/u],
    ['metadata dot-dot alias', `${parent}${path.sep}segment${path.sep}..${path.sep}external`, '', /path alias/u],
    ['relative metadata escape', `..${path.sep}external`, '', /must be an absolute path/u],
  ]) await t.test(name, async () => {
    await writeFile(path.join(root, 'config/system.xml'), `<ServerConfiguration><MetadataPath>${xml(metadata)}</MetadataPath>${cache ? `<CachePath>${xml(cache)}</CachePath>` : ''}</ServerConfiguration>`);
    await assert.rejects(discoverInstanceState({ instanceRoot: root }), expected);
  });
});

test('rejects unmodeled instance top-level state while allowing its own restore marker', async t => {
  const { root } = await instance(t);
  await writeFile(path.join(root, 'mediamanager-state.json'), '{"stage":"complete"}');
  await assert.rejects(discoverInstanceState({ instanceRoot: root }), /Invalid MediaManager restored-state marker/u);
  await writeFile(path.join(root, 'mediamanager-state.json'), JSON.stringify(restoredStateMarker(root)));
  await discoverInstanceState({ instanceRoot: root });
  await writeFile(path.join(root, 'unknown-state.bin'), 'must not be omitted');
  await assert.rejects(discoverInstanceState({ instanceRoot: root }), /Unmodeled Jellyfin instance top-level entry/u);
  await unlink(path.join(root, 'unknown-state.bin')); await mkdir(path.join(root, 'unknown-state'));
  await assert.rejects(discoverInstanceState({ instanceRoot: root }), /Unmodeled Jellyfin instance top-level entry/u);
});

test('rejects top-level inventory and control-marker mutations introduced after the initial capture', async t => {
  await t.test('unknown top-level entry added while state roots are scanned', async t => {
    const { root } = await instance(t), unknown = path.join(root, 'unknown-during-scan.bin');
    await withRootScanMutation(root, () => writeFile(unknown, 'must be modeled'), async () => {
      await assert.rejects(discoverInstanceState({ instanceRoot: root }), /Unmodeled Jellyfin instance top-level entry/u);
    });
  });

  await t.test('restored-state marker changed while state roots are scanned', async t => {
    const { root } = await instance(t), marker = path.join(root, 'mediamanager-state.json');
    await writeFile(marker, JSON.stringify(restoredStateMarker(root)));
    await withRootScanMutation(root, () => writeFile(marker, JSON.stringify(restoredStateMarker(root, '22222222-2222-4222-8222-222222222222'))), async () => {
      await assert.rejects(discoverInstanceState({ instanceRoot: root }), /control generation changed during state discovery/u);
    });
  });
});

test('complete state generation invalidates barriers for noncritical file and empty-directory changes', async t => {
  for (const [name, mutate] of [
    ['same-length content rewrite with restored timestamps', async root => {
      const filename = path.join(root, 'data/metadata/plugin.bin');
      await writeFile(filename, 'first-version');
      const metadata = await stat(filename);
      return async () => { await writeFile(filename, 'other-version'); await utimes(filename, metadata.atime, metadata.mtime); };
    }],
    ['file addition', async root => async () => writeFile(path.join(root, 'cache/new.bin'), 'new')],
    ['file deletion', async root => {
      const filename = path.join(root, 'log/delete.log'); await writeFile(filename, 'delete');
      return async () => unlink(filename);
    }],
    ['empty directory addition', async root => async () => mkdir(path.join(root, 'data/metadata/new-empty'))],
  ]) await t.test(name, async t => {
    const { root } = await instance(t), applyMutation = await mutate(root);
    const state = await discoverInstanceState({ instanceRoot: root }), barrier = stoppedBarrier(state);
    await applyMutation();
    await assert.rejects(validateWriteBarrier(barrier, state), /complete state generation is no longer current/u);
  });
});

test('identity and barriers bind SQLite main, WAL and SHM generation bytes', async t => {
  const { root } = await instance(t), sqlite = path.join(root, 'data/data/jellyfin.db');
  await writeFile(`${sqlite}-wal`, 'wal generation one'); await writeFile(`${sqlite}-shm`, 'shm generation one');
  const first = await discoverInstanceState({ instanceRoot: root }), barrier = stoppedBarrier(first);
  assert.deepEqual(first.identity.databaseGeneration.files.map(file => file.role), ['sqlite', 'wal', 'shm']);
  await writeFile(sqlite, 'isolated sqlite fixture generation two');
  await assert.rejects(validateWriteBarrier(barrier, first), /SQLite generation is no longer current/u);
  const second = await discoverInstanceState({ instanceRoot: root });
  assert.notEqual(second.identity.databaseGeneration.digest, first.identity.databaseGeneration.digest);
  assert.notEqual(second.identity.digest, first.identity.digest);
  await assert.rejects(validateWriteBarrier(barrier, second), /Invalid or unbound write barrier/u);
});

test('stopped instance discovery rejects rollback, statement and super-journal companions', async t => {
  for (const suffix of ['-journal', '-stmtjrnl', '-mj 0123456789ABCDEF']) await t.test(suffix, async t => {
    const { root } = await instance(t);
    const sqlite = path.join(root, 'data/data/jellyfin.db');
    await writeFile(`${sqlite}${suffix}`, 'untrusted SQLite recovery bytes');
    await assert.rejects(discoverInstanceState({ instanceRoot: root }), /unsafe rollback or super-journal companion/u);
  });
});

test('rejects symbolic-link roots and symbolic links anywhere in captured state', async t => {
  const { parent, root } = await instance(t);
  const target = path.join(parent, 'cache-target'); await mkdir(target);
  await rm(path.join(root, 'cache'), { recursive: true });
  await symlink(target, path.join(root, 'cache'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(discoverInstanceState({ instanceRoot: root }), /symbolic link|path alias/u);
  await unlink(path.join(root, 'cache')); await mkdir(path.join(root, 'cache'));
  const asset = path.join(parent, 'asset-directory'); await mkdir(asset); await writeFile(path.join(asset, 'asset.bin'), 'asset');
  await symlink(asset, path.join(root, 'data/metadata/linked-assets'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(discoverInstanceState({ instanceRoot: root }), /state contains a symbolic link/u);
});

test('rejects missing or invalid critical instance identity', async t => {
  await t.test('missing database', async t => {
    const { root } = await instance(t, { database: false });
    await assert.rejects(discoverInstanceState({ instanceRoot: root }), /Missing required Jellyfin SQLite database/u);
  });
  await t.test('missing server identity', async t => {
    const { root } = await instance(t); await unlink(path.join(root, 'data/data/device.txt'));
    await assert.rejects(discoverInstanceState({ instanceRoot: root }), /Missing required Jellyfin server identity/u);
  });
  await t.test('invalid server identity', async t => {
    const { root } = await instance(t, { device: 'not-a-native-server-id' });
    await assert.rejects(discoverInstanceState({ instanceRoot: root }), /server identity is invalid/u);
  });
  await t.test('missing native configuration', async t => {
    const { root } = await instance(t); await unlink(path.join(root, 'config/network.xml'));
    await assert.rejects(discoverInstanceState({ instanceRoot: root }), /Missing required Jellyfin network configuration/u);
  });
  await t.test('missing configured external root', async t => {
    const { parent, root } = await instance(t), missing = path.join(parent, 'missing-metadata');
    await writeFile(path.join(root, 'config/system.xml'), `<ServerConfiguration><MetadataPath>${xml(missing)}</MetadataPath></ServerConfiguration>`);
    await assert.rejects(discoverInstanceState({ instanceRoot: root }), /Missing required Jellyfin metadata directory/u);
  });
});

test('rejects free-text, forged and incomplete write barriers', async t => {
  const { root } = await instance(t), state = await discoverInstanceState({ instanceRoot: root });
  for (const [name, barrier, expected] of [
    ['free text stopped claim', { kind: 'stopped-service', evidence: 'trust me' }, /Invalid or unbound write barrier/u],
    ['wrong identity', { ...stoppedBarrier(state), identityDigest: 'f'.repeat(64) }, /Invalid or unbound write barrier/u],
    ['forced stop', { ...stoppedBarrier(state), ownedProcess: { ...stoppedBarrier(state).ownedProcess, forced: true } }, /clean HTTP 204 shutdown/u],
    ['wrong shutdown response', { ...stoppedBarrier(state), ownedProcess: { ...stoppedBarrier(state).ownedProcess, shutdown: { kind: 'http', statusCode: 200 } } }, /clean HTTP 204 shutdown/u],
    ['signaled process', { ...stoppedBarrier(state), ownedProcess: { ...stoppedBarrier(state).ownedProcess, signalCode: 'SIGKILL' } }, /clean HTTP 204 shutdown/u],
    ['free text copy owner', { ...offlineBarrier(state), isolatedCopy: { ...offlineBarrier(state).isolatedCopy, owner: 'tests' } }, /offline copy owner/u],
    ['non-test copy owner', { ...offlineBarrier(state), isolatedCopy: { ...offlineBarrier(state).isolatedCopy, owner: { kind: 'operator', id: 'person' } } }, /requires test ownership/u],
    ['missing source identity', { ...offlineBarrier(state), isolatedCopy: { owner: offlineBarrier(state).isolatedCopy.owner, source: { identityDigest: 'not-a-digest', serverId } } }, /requires test ownership/u],
  ]) await t.test(name, () => assert.rejects(validateWriteBarrier(barrier, state), expected));
  const changedState = structuredClone(state); changedState.paths.metadata = path.join(root, 'other');
  await assert.rejects(validateWriteBarrier(stoppedBarrier(state), changedState), /path model|identity digest does not match/u);
});
