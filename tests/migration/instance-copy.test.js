import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { inspectInstanceConfiguration } from '../../src/configuration.js';
import { cloneStoppedInstance } from '../../src/migration/instance-copy.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';

const serverId = '0123456789abcdef0123456789abcdef';
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

async function fixture(t, system = '<ServerConfiguration><UICulture>zh-CN</UICulture></ServerConfiguration>') {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'mediamanager-instance-copy-'));
  t.after(async () => { assert.equal(path.dirname(parent), os.tmpdir()); await rm(parent, { recursive: true, force: true }); });
  const root = path.join(parent, 'source');
  for (const relative of ['data/data', 'data/metadata', 'config', 'cache', 'log']) await mkdir(path.join(root, relative), { recursive: true });
  await writeFile(path.join(root, 'config/system.xml'), system);
  await writeFile(path.join(root, 'config/network.xml'), '<NetworkConfiguration><EnableIPv4>true</EnableIPv4></NetworkConfiguration>');
  await writeFile(path.join(root, 'data/data/device.txt'), serverId);
  await writeFile(path.join(root, 'data/data/jellyfin.db'), 'offline sqlite generation');
  await writeFile(path.join(root, 'data/metadata/default.jpg'), 'default metadata');
  await writeFile(path.join(root, 'cache/default.bin'), 'default cache');
  await writeFile(path.join(root, 'log/server.log'), 'stopped');
  return { parent, root };
}

const isInside = (root, value) => {
  const relative = path.relative(root, value);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};

test('clones a default stopped instance without inventing configured paths', async t => {
  const { parent, root } = await fixture(t), destination = path.join(parent, 'clone');
  const source = await discoverInstanceState({ instanceRoot: root });
  const cloned = await cloneStoppedInstance({ instanceState: source, destination });
  assert.equal(cloned.instanceRoot, destination);
  assert.equal(cloned.identity.serverId, source.identity.serverId);
  assert.deepEqual(cloned.pathBindings, source.pathBindings);
  assert.deepEqual(cloned.roots, {
    data: path.join(destination, 'data'), config: path.join(destination, 'config'),
    cache: path.join(destination, 'cache'), log: path.join(destination, 'log'),
  });
  assert.equal(await readFile(path.join(destination, 'data/metadata/default.jpg'), 'utf8'), 'default metadata');
  const system = await readFile(path.join(destination, 'config/system.xml'), 'utf8');
  assert.doesNotMatch(system, /<MetadataPath>|<CachePath>/u);
  const settings = await inspectInstanceConfiguration(destination);
  assert.equal(settings.configuration.MetadataPath, '');
  assert.equal(settings.configuration.CachePath, null);
  assert.equal(await readFile(path.join(destination, 'config/system.xml'), 'utf8'), system);
  assert.ok(Object.values(cloned.roots).every(value => isInside(destination, value)));
});

test('copies external roots and rebases their configured paths into the clone', async t => {
  const { parent, root } = await fixture(t);
  const metadata = path.join(parent, 'source metadata & people'), cache = path.join(parent, 'source cache');
  await mkdir(metadata); await mkdir(cache);
  await writeFile(path.join(metadata, 'person.jpg'), 'external metadata');
  await writeFile(path.join(cache, 'image.bin'), 'external cache');
  await writeFile(path.join(root, 'config/system.xml'), `<ServerConfiguration><MetadataPath>${xml(metadata)}</MetadataPath><CachePath>${xml(cache)}</CachePath></ServerConfiguration>`);
  const source = await discoverInstanceState({ instanceRoot: root }), destination = path.join(parent, 'clone & final');
  const cloned = await cloneStoppedInstance({ instanceState: source, destination });
  assert.deepEqual(cloned.pathBindings, source.pathBindings);
  assert.deepEqual(cloned.roots, {
    data: path.join(destination, 'data'), config: path.join(destination, 'config'), cache: path.join(destination, 'cache'),
    log: path.join(destination, 'log'), 'metadata-external': path.join(destination, 'metadata-external'),
    'cache-external': path.join(destination, 'cache-external'),
  });
  assert.equal(cloned.paths.metadata, path.join(destination, 'metadata-external'));
  assert.equal(cloned.paths.cache, path.join(destination, 'cache-external'));
  assert.equal(await readFile(path.join(cloned.paths.metadata, 'person.jpg'), 'utf8'), 'external metadata');
  assert.equal(await readFile(path.join(cloned.paths.cache, 'image.bin'), 'utf8'), 'external cache');
  const settings = await inspectInstanceConfiguration(destination);
  assert.equal(settings.configuration.MetadataPath, cloned.paths.metadata);
  assert.equal(settings.configuration.CachePath, cloned.paths.cache);
  assert.ok(Object.values(cloned.roots).every(value => isInside(destination, value)));
});

test('rebases configured absolute paths that stay inside core roots', async t => {
  const { parent, root } = await fixture(t), metadata = path.join(root, 'data/metadata/custom'), cache = path.join(root, 'cache/custom');
  await mkdir(metadata, { recursive: true }); await mkdir(cache);
  await writeFile(path.join(metadata, 'movie.jpg'), 'custom metadata');
  await writeFile(path.join(cache, 'movie.bin'), 'custom cache');
  await writeFile(path.join(root, 'config/system.xml'), `<ServerConfiguration><MetadataPath>${xml(metadata)}</MetadataPath><CachePath>${xml(cache)}</CachePath></ServerConfiguration>`);
  const source = await discoverInstanceState({ instanceRoot: root }), destination = path.join(parent, 'clone');
  const cloned = await cloneStoppedInstance({ instanceState: source, destination });
  assert.deepEqual(Object.keys(cloned.roots), ['data', 'config', 'cache', 'log']);
  assert.deepEqual(cloned.pathBindings, {
    metadata: { configured: true, root: 'data', relativePath: 'metadata/custom' },
    cache: { configured: true, root: 'cache', relativePath: 'custom' },
  });
  assert.equal(cloned.paths.metadata, path.join(destination, 'data/metadata/custom'));
  assert.equal(cloned.paths.cache, path.join(destination, 'cache/custom'));
  assert.equal(await readFile(path.join(cloned.paths.metadata, 'movie.jpg'), 'utf8'), 'custom metadata');
  const settings = await inspectInstanceConfiguration(destination);
  assert.equal(settings.configuration.MetadataPath, cloned.paths.metadata);
  assert.equal(settings.configuration.CachePath, cloned.paths.cache);
});

test('rejects existing, overlapping, aliased and symbolic-link destinations', async t => {
  const { parent, root } = await fixture(t), source = await discoverInstanceState({ instanceRoot: root });
  const existing = path.join(parent, 'existing'); await mkdir(existing);
  await assert.rejects(cloneStoppedInstance({ instanceState: source, destination: existing }), /already exists/u);
  await assert.rejects(cloneStoppedInstance({ instanceState: source, destination: path.join(root, 'nested-clone') }), /overlaps a source root/u);

  const linkTarget = path.join(parent, 'link-target'); await mkdir(linkTarget);
  const linkedDestination = path.join(parent, 'linked-destination');
  await symlink(linkTarget, linkedDestination, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cloneStoppedInstance({ instanceState: source, destination: linkedDestination }), /must not be a symbolic link/u);

  const parentTarget = path.join(parent, 'parent-target'); await mkdir(parentTarget);
  const parentLink = path.join(parent, 'parent-link');
  await symlink(parentTarget, parentLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cloneStoppedInstance({ instanceState: source, destination: path.join(parentLink, 'clone') }), /symbolic link|path alias/u);
});

test('rejects a source that gains a symbolic link after discovery and leaves no clone', async t => {
  const { parent, root } = await fixture(t), source = await discoverInstanceState({ instanceRoot: root });
  const linkTarget = path.join(parent, 'asset-target'); await mkdir(linkTarget); await writeFile(path.join(linkTarget, 'asset.bin'), 'asset');
  await symlink(linkTarget, path.join(root, 'data/metadata/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const destination = path.join(parent, 'clone');
  await assert.rejects(cloneStoppedInstance({ instanceState: source, destination }), /symbolic link/u);
  await assert.rejects(lstat(destination), error => error.code === 'ENOENT');
});

test('requires the exact clone option contract', async t => {
  const { parent, root } = await fixture(t), source = await discoverInstanceState({ instanceRoot: root });
  await assert.rejects(cloneStoppedInstance({ instanceState: source, destination: path.join(parent, 'clone'), legacyCopy: true }), /Invalid stopped Jellyfin instance clone options/u);
});

test('preserves the clone failure when partial-output cleanup also fails', async t => {
  const { parent, root } = await fixture(t), source = await discoverInstanceState({ instanceRoot: root });
  const destination = path.join(parent, 'clone'), operationError = new Error('simulated publish failure');
  const cleanupError = new Error('simulated cleanup failure');
  const originalRename = fs.promises.rename, originalRm = fs.promises.rm;
  fs.promises.rename = async () => { throw operationError; };
  fs.promises.rm = async (target, options) => {
    if (path.basename(target).includes('.mediamanager-clone-')) throw cleanupError;
    return originalRm(target, options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(cloneStoppedInstance({ instanceState: source, destination }), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, operationError);
      assert.deepEqual(error.errors, [operationError, cleanupError]);
      assert.match(error.message, /partial output could not be removed/u);
      return true;
    });
  } finally {
    fs.promises.rename = originalRename;
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
  }
  await assert.rejects(lstat(destination), error => error.code === 'ENOENT');
});
