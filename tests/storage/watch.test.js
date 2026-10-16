import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const writes = Object.freeze({ create: true, replace: true, mkdir: true, delete: true, rename: true,
  conditionalWrite: false, atomicReplace: true });

async function local(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mediamanager-watch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = await LocalAdapter.open({ root, writable: true });
  t.after(() => adapter.close());
  return { root, adapter };
}

function recorder() {
  const events = [], errors = [], waiting = new Set();
  return { events, errors,
    onChange(event) { events.push(event); for (const entry of waiting) if (entry.predicate(event)) { waiting.delete(entry); entry.resolve(event); } },
    onError(error) { errors.push(error); for (const entry of waiting) entry.reject(error); waiting.clear(); },
    next(predicate) {
      const deferred = Promise.withResolvers();
      waiting.add({ predicate, ...deferred });
      return deferred.promise;
    }
  };
}

test('local watches existing and newly created subdirectories and releases subscriptions', { timeout: 10000 }, async t => {
  const { root, adapter } = await local(t);
  await fs.mkdir(path.join(root, 'existing'));
  const recorded = recorder();
  const subscription = await adapter.watch('/', recorded);
  t.after(() => subscription.close());
  let change = recorded.next(event => event.path === '/existing/电影%2F.mkv');
  await fs.writeFile(path.join(root, 'existing', '电影%2F.mkv'), 'one');
  await change;
  change = recorded.next(event => event.path === '/new');
  await fs.mkdir(path.join(root, 'new'));
  await change;
  change = recorded.next(event => event.path === '/new/track.flac');
  await fs.writeFile(path.join(root, 'new', 'track.flac'), 'two');
  await change;
  change = recorded.next(event => event.path === '/new/track.flac' && event.type === 'rename');
  await fs.unlink(path.join(root, 'new', 'track.flac'));
  await change;
  change = recorded.next(event => event.path === '/new');
  await fs.rmdir(path.join(root, 'new'));
  await change;
  change = recorded.next(event => event.path === '/new');
  await fs.mkdir(path.join(root, 'new'));
  await change;
  change = recorded.next(event => event.path === '/new/recreated.flac');
  await fs.writeFile(path.join(root, 'new', 'recreated.flac'), 'three');
  await change;
  await subscription.close();
  const count = recorded.events.length;
  await fs.writeFile(path.join(root, 'after-close.txt'), 'closed');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(recorded.events.length, count);
  assert.deepEqual(recorded.errors, []);
});

test('local watch rejects files and junctions and observes cancellation', { timeout: 10000 }, async t => {
  const { root, adapter } = await local(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'file');
  await assert.rejects(adapter.watch('/file.txt', recorder()), { code: 'not-directory' });
  const controller = new AbortController();
  const recorded = recorder();
  const subscription = await adapter.watch('/', { ...recorded, signal: controller.signal });
  controller.abort();
  await subscription.close();
  await assert.rejects(adapter.watch('/', { ...recorded, signal: controller.signal }), { code: 'cancelled' });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mediamanager-watch-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(adapter.watch('/', recorded), { code: 'permission-denied' });
  assert.deepEqual(recorded.events, []);
});

async function fake(t, options = {}) {
  const registry = new StorageRegistry(), subscriptions = [];
  registry.registerType('watchable', () => {
    const adapter = new MemoryStorageAdapter();
    adapter.capabilities = Object.freeze({ ...adapter.capabilities, watch: true });
    adapter.watch = async (filename, callbacks) => {
      const subscription = { filename, callbacks, closed: false, close() { this.closed = true; } };
      subscriptions.push(subscription);
      await options.open?.(subscription);
      return subscription;
    };
    return adapter;
  });
  await registry.createInstance('parent', 'watchable', {});
  await registry.createInstance('child', 'watchable', {});
  t.after(() => registry.close());
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/media', instanceId: 'parent', root: '/root', capabilities: writes });
  vfs.mount({ path: '/media/special', instanceId: 'child', root: '/other', capabilities: writes });
  return { registry, vfs, subscriptions };
}

test('VFS watches each backend and suppresses paths shadowed by nested mounts', async t => {
  const { vfs, subscriptions } = await fake(t);
  const recorded = recorder(), subscription = await vfs.watch('/media', recorded);
  assert.deepEqual(subscriptions.map(entry => entry.filename), ['/root', '/other']);
  subscriptions[0].callbacks.onChange({ type: 'change', path: '/root/title.mkv' });
  subscriptions[0].callbacks.onChange({ type: 'rename', path: '/root/special/hidden.mkv' });
  subscriptions[1].callbacks.onChange({ type: 'rename', path: '/other/visible.mkv' });
  assert.deepEqual(recorded.events, [{ type: 'change', path: '/media/title.mkv' }, { type: 'rename', path: '/media/special/visible.mkv' }]);
  subscriptions[1].callbacks.onChange({ type: 'change', path: '/elsewhere/leak.mkv' });
  assert.equal(recorded.errors[0].code, 'invalid-response');
  await subscription.close();
  assert.ok(subscriptions.every(entry => entry.closed));
  subscriptions[0].callbacks.onChange({ type: 'change', path: '/root/late.mkv' });
  assert.equal(recorded.events.length, 2);
});

test('VFS closes a late subscription after abort and rolls back a failed multi-mount start', async t => {
  const controller = new AbortController();
  const { vfs, subscriptions } = await fake(t, { open: subscription => {
    if (subscription.filename === '/other') controller.abort();
  } });
  await assert.rejects(vfs.watch('/media', { ...recorder(), signal: controller.signal }), { code: 'cancelled' });
  assert.ok(subscriptions.every(entry => entry.closed));
  const failed = await fake(t, { open: subscription => {
    if (subscription.filename === '/other') throw new Error('Cannot subscribe');
  } });
  await assert.rejects(failed.vfs.watch('/media', recorder()), /Cannot subscribe/u);
  assert.equal(failed.subscriptions[0].closed, true);
});

test('registry rejects watch declarations without watch and VFS requires capability before subscribing', async t => {
  const registry = new StorageRegistry();
  t.after(() => registry.close());
  registry.registerType('invalid', () => {
    const adapter = new MemoryStorageAdapter();
    adapter.capabilities = Object.freeze({ ...adapter.capabilities, watch: true });
    return adapter;
  });
  await assert.rejects(registry.createInstance('invalid', 'invalid', {}), /requires watch/u);
  registry.registerType('plain', () => new MemoryStorageAdapter());
  await registry.createInstance('plain', 'plain', {});
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/', instanceId: 'plain', capabilities: writes });
  await assert.rejects(vfs.watch('/', recorder()), { code: 'not-supported' });
});

test('VFS watches synthetic overlay parents and closes other handles when one throws synchronously', async t => {
  const { vfs, subscriptions } = await fake(t);
  vfs.mount({ path: '/media/missing/overlay', instanceId: 'child', root: '/overlay', capabilities: writes });
  const subscription = await vfs.watch('/media/missing', recorder());
  assert.deepEqual(subscriptions.map(value => value.filename), ['/overlay']);
  await subscription.close();
  const next = await vfs.watch('/media', recorder());
  subscriptions[1].close = () => { throw new Error('Close failed'); };
  await assert.rejects(next.close(), AggregateError);
  assert.equal(subscriptions[2].closed, true);
  assert.equal(subscriptions[3].closed, true);
});
