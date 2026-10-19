import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { watchDirectory } from '../../plugins/local/watch.js';
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
  const events = [], errors = [], errorStates = [], waiting = new Set();
  let terminalError;
  return { events, errors, errorStates,
    onChange(event) { events.push(event); for (const entry of waiting) if (entry.predicate(event)) { waiting.delete(entry); entry.resolve(event); } },
    onError(error, state) {
      errors.push(error); errorStates.push(state);
      if (state?.terminal === false) return;
      terminalError = error;
      for (const entry of waiting) entry.reject(error); waiting.clear();
    },
    next(predicate) {
      const deferred = Promise.withResolvers();
      // An OS error can arrive while the caller is still awaiting its write.
      // Preserve that rejection for next() without an unhandled-rejection race.
      void deferred.promise.catch(() => {});
      if (terminalError) deferred.reject(terminalError);
      else waiting.add({ predicate, ...deferred });
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

test('directory churn during event reconciliation keeps the root watch alive', { timeout: 10000 }, async t => {
  const { root, adapter } = await local(t);
  const recorded = recorder();
  const subscription = await adapter.watch('/', recorded);
  t.after(() => subscription.close());
  for (let index = 0; index < 20; index++) {
    const directory = path.join(root, 'transient-' + index);
    await fs.mkdir(path.join(directory, 'nested'), { recursive: true });
    await fs.rm(directory, { recursive: true, maxRetries: 5, retryDelay: 20 });
  }
  const change = recorded.next(event => event.path === '/surviving.txt');
  await fs.writeFile(path.join(root, 'surviving.txt'), 'still watched');
  await change;
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
  await assert.rejects(adapter.watch('/link', recorded), { code: 'permission-denied' });
  assert.deepEqual(recorded.events, []);
});

test('a rejected link subtree preserves the active local watch and its replacement can be watched again', { timeout: 10000 }, async t => {
  const { root, adapter } = await local(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mediamanager-watch-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const recorded = recorder(), rejected = Promise.withResolvers();
  const subscription = await adapter.watch('/', { ...recorded, onError(error, state) {
    recorded.onError(error, state); rejected.resolve({ error, state });
  } });
  t.after(() => subscription.close());
  await fs.symlink(outside, path.join(root, 'blocked'), process.platform === 'win32' ? 'junction' : 'dir');
  const diagnostic = await rejected.promise;
  assert.equal(diagnostic.error.code, 'permission-denied');
  assert.deepEqual(diagnostic.state, { terminal: false });
  let changed = recorded.next(event => event.path === '/surviving.txt');
  await fs.writeFile(path.join(outside, 'outside.txt'), 'must not be observed');
  await fs.writeFile(path.join(root, 'surviving.txt'), 'still active'); await changed;
  assert.equal(recorded.events.some(event => event.path.startsWith('/blocked/')), false);
  changed = recorded.next(event => event.path === '/blocked');
  await fs.unlink(path.join(root, 'blocked')); await changed;
  changed = recorded.next(event => event.path === '/blocked');
  await fs.mkdir(path.join(root, 'blocked')); await changed;
  changed = recorded.next(event => event.path === '/blocked/restored.txt');
  await fs.writeFile(path.join(root, 'blocked', 'restored.txt'), 'watched'); await changed;
  assert.ok(recorded.errorStates.every(state => state.terminal === false));
});

async function controlledWatch(t) {
  const { root, adapter } = await local(t), handles = [], resolved = [], recorded = recorder();
  const subscription = await watchDirectory('/', { ...recorded, windows: true, failure: error => error,
    resolve: async filename => {
      resolved.push(filename);
      try { await adapter.stat(filename); }
      catch (error) { if (!['not-found', 'not-directory'].includes(error.code)) throw error; }
      return path.join(root, ...filename.split('/'));
    },
    watch: (target, options, callback) => {
      assert.equal(options.recursive, false);
      const handle = Object.assign(new EventEmitter(), { target, closed: false,
        change(type, name) { callback(type, name); }, close() { this.closed = true; } });
      handles.push(handle); return handle;
    }
  });
  t.after(() => subscription.close());
  return { root, handles, resolved, recorded, subscription };
}

test('Windows descendant and DeletePending callbacks retain sibling watches and reject stale owners', { timeout: 10000 }, async t => {
  const f = await controlledWatch(t), rootWatch = f.handles[0];
  await fs.mkdir(path.join(f.root, 'new', 'nested'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'new', 'nested', 'movie%2F.mkv'), 'one');
  let change = f.recorded.next(event => event.path === '/new/nested/movie%2F.mkv');
  rootWatch.change('change', 'new\\nested\\movie%2F.mkv'); await change;
  const previous = f.handles.find(handle => handle.target === path.join(f.root, 'new', 'nested'));
  assert.ok(previous);
  await fs.rm(previous.target, { recursive: true });
  change = f.recorded.next(event => event.path === '/new/nested');
  previous.change('rename', path.win32.toNamespacedPath(previous.target)); await change;
  assert.equal(previous.closed, true); assert.equal(rootWatch.closed, false);
  await fs.mkdir(previous.target);
  change = f.recorded.next(event => event.path === '/new/nested');
  rootWatch.change('rename', 'new/nested'); await change;
  const replacement = f.handles.findLast(handle => handle.target === previous.target);
  assert.notEqual(replacement, previous);
  previous.change('rename', path.win32.toNamespacedPath(previous.target));
  change = f.recorded.next(event => event.path === '/surviving.txt');
  rootWatch.change('change', 'surviving.txt'); await change;
  assert.equal(replacement.closed, false);
  assert.deepEqual(f.recorded.errors, []);
});

test('ambiguous native callback names rescan only the held directory and retain diagnostics', { timeout: 10000 }, async t => {
  const f = await controlledWatch(t), rootWatch = f.handles[0];
  for (const name of ['../escape', 'child\\..\\escape', 'C:\\outside\\file', 'C:outside',
    '\\\\server\\share\\file', '/outside', 'child//file', 'bad\0name']) {
    const after = f.resolved.length, change = f.recorded.next(event => event.path === '/');
    rootWatch.change('rename', name); await change;
    assert.deepEqual(f.resolved.slice(after), ['/']);
    assert.equal(f.recorded.errors.at(-1).details.callbackName, name);
    assert.equal(f.recorded.errors.at(-1).details.watchPath, '/');
    assert.deepEqual(f.recorded.errorStates.at(-1), { terminal: false });
    assert.equal(rootWatch.closed, false);
  }
  const callbackName = path.win32.toNamespacedPath(rootWatch.target);
  await fs.rmdir(f.root);
  const ended = f.recorded.next(() => true);
  rootWatch.change('rename', callbackName);
  await assert.rejects(ended, error => error.code === 'not-found' && error.details.callbackName === callbackName);
  assert.deepEqual(f.recorded.errorStates.at(-1), { terminal: true });
  assert.equal(rootWatch.closed, true);
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

test('VFS retains recoverable subscriptions and closes every backend when one terminates', async t => {
  const { vfs, subscriptions } = await fake(t), recorded = recorder();
  const subscription = await vfs.watch('/media', recorded);
  const failure = Object.assign(new Error('Access changed'), { code: 'permission-denied' });
  subscriptions[0].callbacks.onError(failure, { terminal: false });
  assert.ok(subscriptions.every(entry => !entry.closed));
  subscriptions[0].callbacks.onChange({ type: 'change', path: '/root/continuing.mkv' });
  assert.deepEqual(recorded.events, [{ type: 'change', path: '/media/continuing.mkv' }]);
  subscriptions[1].callbacks.onError(failure, { terminal: true });
  await subscription.close();
  assert.ok(subscriptions.every(entry => entry.closed));
  assert.deepEqual(recorded.errorStates, [{ terminal: false }, { terminal: true }]);
  subscriptions[0].callbacks.onChange({ type: 'change', path: '/root/late.mkv' });
  assert.equal(recorded.events.length, 1);
});

test('VFS rejects a plugin error without lifetime state and releases a terminal late creation', async t => {
  const f = await fake(t), recorded = recorder();
  const subscription = await f.vfs.watch('/media', recorded);
  f.subscriptions[0].callbacks.onError(new Error('Missing error contract'));
  await subscription.close();
  assert.equal(recorded.errors[0].code, 'invalid-response');
  assert.deepEqual(recorded.errorStates, [{ terminal: true }]);
  assert.ok(f.subscriptions.every(entry => entry.closed));
  const late = await fake(t, { open: entry => {
    if (entry.filename === '/other') entry.callbacks.onError(new Error('Terminated during setup'), { terminal: true });
  } });
  await assert.rejects(late.vfs.watch('/media', recorder()), { code: 'closed' });
  assert.ok(late.subscriptions.every(entry => entry.closed));
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
