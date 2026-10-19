import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { LibraryDirectoryMonitor, LibraryFileRefresher } from '../../src/library/library-directory-monitor.js';
import { recordedInputPath } from '../../tools/validation/paths.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const fixtureRoot = new URL('./fixtures/library-directory-monitor/', import.meta.url);
const [input, native] = await Promise.all(['input.json', 'native.json']
  .map(async name => JSON.parse(await readFile(new URL(name, fixtureRoot), 'utf8'))));
const provenanceBytes = await readFile(new URL('./fixtures/library-directory-monitor/provenance.json', import.meta.url));
const provenance = JSON.parse(provenanceBytes);
const required = JSON.parse(await readFile(new URL('./fixtures/library-directory-monitor/required-inputs.json', import.meta.url)));

test('directory monitor fixture binds the designated real monitor and refresher execution', async () => {
  assert.equal(createHash('sha256').update(provenanceBytes).digest('hex'), required.provenanceSha256);
  for (const value of required.requiredInputs) {
    assert.equal(value.required, true);
    const bytes = await readFile(recordedInputPath(value.path, [value.sha256]));
    assert.equal(bytes.length, value.bytes, value.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), value.sha256, value.path);
  }
  for (const value of Object.values(provenance.files)) {
    const bytes = await readFile(new URL(value.path, fixtureRoot));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), value.sha256, value.path);
  }
  assert.equal(native.inputSha256, provenance.files['input.json'].sha256);
  assert.equal(native.actualLibraryMonitor, true); assert.equal(native.actualFileRefresher, true);
  assert.equal(provenance.runtime.passed, true);
  assert.equal(provenance.runtime.jellyfinDll.sha256, '474c7c638fe93cc61f1a588849fb93c81a2927388f6f4cf19953b3a76e9deb26');
  assert.deepEqual(native.results.map(value => value.name), input.map(value => value.name));
});

for (const sample of input) test(`designated native directory monitor: ${sample.name}`, async () => {
  const calls = [], timers = clock(), root = 'C:\\monitor-fixture';
  const expand = path => root + '\\' + path.replaceAll('/', '\\');
  const record = (action, path) => calls.push({ action, path: path.replace(root, '$ROOT') });
  const host = {
    getWatchPaths: () => [], getWatchPath: () => null, watchPath: () => null,
    getFileInfo: path => { record('info', path); return { isDirectory: true }; },
    invalidate: path => record('invalidate', path),
    resolveAffectedItem: path => {
      record('lookup', path);
      if (sample.lookupFailure && path === expand(sample.lookupFailure)) throw new Error('lookup');
      return { item: { Id: sample.sameItemId ? 'same' : path.toUpperCase(), Path: path,
        Type: sample.aggregateItem && path === expand(sample.aggregateItem) ? 'AggregateFolder' : 'Folder' }, dispose() {} };
    },
    changedExternally: item => {
      record('refresh', item.Path);
      if (sample.refreshFailure && item.Path === expand(sample.refreshFailure)) throw new Error('refresh');
    }
  };
  const monitor = new LibraryDirectoryMonitor({ host, timers, windows: true,
    configuration: { LibraryMonitorDelay: 3600 }, logger: { error: error => record('error', error.message) },
    ignoreRule: { shouldIgnore: path => (sample.ignoreDirectories ?? []).some(value => path === expand(value) || path.startsWith(expand(value) + '\\')) } });
  try {
    for (const path of sample.begin ?? []) monitor.reportFileSystemChangeBeginning(expand(path));
    for (const path of sample.changes) await monitor.reportFileSystemChanged(expand(path));
    if (sample.stop) await monitor.stop();
    const eventCalls = calls.splice(0), batches = [];
    for (const [id, timer] of [...timers.scheduled]) {
      timers.scheduled.delete(id); await timer.callback(); batches.push(calls.splice(0));
    }
    const expected = native.results.find(value => value.name === sample.name);
    const independentBatches = values => values.map(value => JSON.stringify(value)).sort();
    assert.deepEqual(eventCalls, expected.eventCalls);
    assert.deepEqual(independentBatches(batches), independentBatches(expected.batches));
  } finally { await monitor.close(); }
});
function clock() {
  const scheduled = new Map();
  let now = 0, serial = 0;
  return {
    scheduled,
    setTimeout(callback, delay) { const id = ++serial; scheduled.set(id, { callback, when: now + delay, delay }); return id; },
    clearTimeout(id) { scheduled.delete(id); },
    async advance(milliseconds) {
      now += milliseconds;
      for (;;) {
        const next = [...scheduled].filter(([, timer]) => timer.when <= now).sort((a, b) => a[1].when - b[1].when || a[0] - b[0])[0];
        if (!next) break;
        scheduled.delete(next[0]);
        await next[1].callback();
      }
      await settle();
    }
  };
}

function fixture(overrides = {}, options = {}) {
  const trace = [], timers = clock(), events = new EventEmitter(), watches = new Map();
  const host = {
    events,
    getWatchPaths: () => ['C:\\media'],
    getWatchPath: item => item.Enabled === false ? null : item.Path,
    watchPath: async (path, handlers) => {
      trace.push(['watch', path]);
      const watcher = { ...handlers, close: async () => { trace.push(['close', path]); watches.delete(path); } };
      watches.set(path, watcher); return watcher;
    },
    getFileInfo: async path => { trace.push(['info', path]); return { isDirectory: false }; },
    invalidate: path => trace.push(['invalidate', path]),
    resolveAffectedItem: async path => {
      trace.push(['lookup', path]);
      return { item: { Id: path, Path: path, Type: 'Folder' }, dispose: async () => trace.push(['release', path]) };
    },
    changedExternally: item => trace.push(['refresh', item.Path]),
    ...overrides
  };
  const monitor = new LibraryDirectoryMonitor({ host, timers, windows: true,
    configuration: { LibraryMonitorDelay: 1 }, ignoreRule: { shouldIgnore: () => false },
    logger: { error: error => trace.push(['error', error.message]) }, ...options });
  return { monitor, host, timers, trace, events, watches };
}

test('monitor selects parent watch paths and maintains one event subscription across starts', async () => {
  const f = fixture({ getWatchPaths: () => ['C:\\Media', 'C:\\Media\\Films', 'C:\\Media2', 'c:\\media'] });
  try {
    await f.monitor.start(); await settle(); await f.monitor.start(); await settle();
    assert.deepEqual(f.trace.filter(row => row[0] === 'watch'), [['watch', 'C:\\Media'], ['watch', 'C:\\Media2']]);
    assert.equal(f.events.listenerCount('ItemAdded'), 1);
    assert.equal(f.monitor.capabilities.watchesLibraryDirectories, true);
    await f.monitor.stop();
    assert.equal(f.events.listenerCount('ItemAdded'), 0);
    assert.equal(f.watches.size, 0);
  } finally { await f.monitor.close(); }
});

test('late watcher creation after stop closes its handle and cannot report changes', async () => {
  const opening = Promise.withResolvers(), opened = Promise.withResolvers();
  let handlers, closed = 0;
  const f = fixture({ watchPath: async (path, value) => { handlers = value; opened.resolve(); await opening.promise; return { close: () => { closed++; } }; } });
  await f.monitor.start(); await opened.promise;
  await f.monitor.stop();
  assert.equal(handlers.signal.aborted, true);
  handlers.onChange({ path: 'C:\\media\\late.mkv' });
  opening.resolve(); await settle();
  assert.equal(closed, 1);
  assert.deepEqual(f.trace, []);
  await f.monitor.close();
});

test('a stopped generation cannot remove the replacement watcher after late creation', async () => {
  const first = Promise.withResolvers(), entered = Promise.withResolvers(); let count = 0;
  const closed = [], f = fixture({ watchPath: async () => {
    const number = ++count;
    if (number === 1) { entered.resolve(); await first.promise; }
    return { close: () => closed.push(number) };
  } });
  await f.monitor.start(); await entered.promise; await f.monitor.stop();
  await f.monitor.start(); await settle(); first.resolve(); await settle();
  assert.deepEqual(closed, [1]);
  await f.monitor.close(); assert.deepEqual(closed, [1, 2]);
});

test('aggregate item events start and stop paths while ordinary parents do not', async () => {
  const f = fixture();
  try {
    await f.monitor.start(); await settle();
    f.events.emit('ItemAdded', { Item: { Path: 'C:\\other' }, Parent: { Type: 'Folder' } });
    f.events.emit('ItemAdded', { Item: { Path: 'C:\\disabled', Enabled: false }, Parent: { Type: 'AggregateFolder' } });
    f.events.emit('ItemAdded', { Item: { Path: 'C:\\added' }, Parent: { Type: 'AggregateFolder' } });
    await settle(); assert.deepEqual([...f.watches.keys()], ['C:\\media', 'C:\\added']);
    f.events.emit('ItemRemoved', { Item: { Path: 'C:\\ADDED' }, Parent: { Type: 'AggregateFolder' } });
    await settle(); assert.deepEqual([...f.watches.keys()], ['C:\\media']);
  } finally { await f.monitor.close(); }
});

test('watch errors follow their explicit lifetime state and a terminal permission failure permits restart', async () => {
  const f = fixture();
  try {
    await f.monitor.start(); await settle(); const watcher = f.watches.get('C:\\media');
    watcher.onError(Object.assign(new Error('permission'), { code: 'permission-denied' }), { terminal: false }); await settle();
    assert.equal(f.watches.size, 1);
    watcher.onError(Object.assign(new Error('permission'), { code: 'permission-denied' }), { terminal: true });
    await settle(); assert.equal(f.watches.size, 0);
    watcher.onChange({ path: 'C:\\media\\late.mkv' }); await settle();
    assert.equal(f.trace.some(row => row[0] === 'info'), false);
    await f.monitor.start(); await settle();
    assert.equal(f.watches.size, 1);
    assert.notEqual(f.watches.get('C:\\media'), watcher);
  } finally { await f.monitor.close(); }
});

test('core and dot-ignore filters run before invalidation, self-write suppression runs after it', async () => {
  const f = fixture({}, { ignoreRule: { shouldIgnore: path => path.endsWith('ignored.mkv') } });
  try {
    await f.monitor.reportFileSystemChanged('C:\\media\\small.jpg');
    await f.monitor.reportFileSystemChanged('C:\\media\\ignored.mkv');
    f.monitor.reportFileSystemChangeBeginning('C:\\media\\Album\\album.nfo');
    for (const path of ['C:\\media\\Album\\album.nfo', 'C:\\media\\Album\\album.nfo\\child', 'C:\\media\\Album']) {
      await f.monitor.reportFileSystemChanged(path);
    }
    assert.equal(f.timers.scheduled.size, 0);
    assert.deepEqual(f.trace, [
      ['info', 'C:\\media\\ignored.mkv'],
      ['info', 'C:\\media\\Album\\album.nfo'], ['invalidate', 'C:\\media\\Album\\album.nfo'],
      ['info', 'C:\\media\\Album\\album.nfo\\child'], ['invalidate', 'C:\\media\\Album\\album.nfo\\child'],
      ['info', 'C:\\media\\Album'], ['invalidate', 'C:\\media\\Album']
    ]);
  } finally { await f.monitor.close(); }
});

test('completion returns immediately and retains the native forty-five-second expiry after a later begin', async () => {
  const f = fixture(), path = 'C:\\media\\film.mkv';
  try {
    f.monitor.reportFileSystemChangeBeginning(path);
    assert.equal(f.monitor.reportFileSystemChangeComplete(path, true), undefined);
    await f.timers.advance(44_000); f.monitor.reportFileSystemChangeBeginning(path);
    await f.monitor.reportFileSystemChanged(path); assert.equal(f.trace.some(row => row[0] === 'lookup'), false);
    await f.timers.advance(1000); await f.timers.advance(1000);
    assert.deepEqual(f.trace.filter(row => row[0] === 'refresh'), [['refresh', path]]);
  } finally { await f.monitor.close(); }
});

test('coalesced siblings retain first path, rebased parent, and later path lookup order', async () => {
  const f = fixture();
  try {
    for (const path of ['C:\\media\\one.mkv', 'C:\\media\\one.mkv', 'C:\\media\\two.mkv', 'C:\\media\\nested\\three.mkv']) {
      await f.monitor.reportFileSystemChanged(path);
    }
    assert.equal(f.timers.scheduled.size, 1); await f.timers.advance(1000);
    const paths = ['C:\\media\\one.mkv', 'C:\\media', 'C:\\media\\two.mkv', 'C:\\media\\nested\\three.mkv'];
    assert.deepEqual(f.trace.filter(row => row[0] === 'lookup').map(row => row[1]), paths);
    assert.deepEqual(f.trace.filter(row => row[0] === 'refresh').map(row => row[1]), paths);
    assert.ok(f.trace.findLastIndex(row => row[0] === 'lookup') < f.trace.findIndex(row => row[0] === 'refresh'));
  } finally { await f.monitor.close(); }
});

test('parent events rebase only their first matching refresher and preserve unrelated refreshers', async () => {
  const f = fixture();
  try {
    for (const path of ['C:\\media\\one\\film.mkv', 'C:\\media\\two\\film.mkv', 'C:\\media']) await f.monitor.reportFileSystemChanged(path);
    assert.equal(f.timers.scheduled.size, 2); await f.timers.advance(1000);
    assert.deepEqual(f.trace.filter(row => row[0] === 'lookup').map(row => row[1]),
      ['C:\\media\\two\\film.mkv', 'C:\\media\\one\\film.mkv', 'C:\\media']);
  } finally { await f.monitor.close(); }
});

test('sibling parent comparison remains ordinal even when path equality is case insensitive', async () => {
  const f = fixture();
  try {
    await f.monitor.reportFileSystemChanged('C:\\Media\\a.mkv');
    await f.monitor.reportFileSystemChanged('C:\\media\\b.mkv');
    assert.equal(f.timers.scheduled.size, 2);
  } finally { await f.monitor.close(); }
});

test('affected lookup failures, duplicate IDs, aggregate roots and refresh failures preserve remaining work', async () => {
  const trace = [], timers = clock();
  const host = {
    resolveAffectedItem: async path => {
      trace.push(['lookup', path]); if (path === 'failure') throw new Error('lookup');
      const item = { Id: path.startsWith('same') ? 'same' : path, Path: path, Type: path === 'root' ? 'AggregateFolder' : 'Folder' };
      return { item, dispose: () => trace.push(['release', path]) };
    },
    changedExternally: item => { trace.push(['refresh', item.Path]); if (item.Path === 'same-1') throw new Error('refresh'); }
  };
  const refresher = new LibraryFileRefresher('failure', { host, timers, configuration: { LibraryMonitorDelay: 1 },
    logger: { error: error => trace.push(['error', error.message]) } });
  for (const path of ['same-1', 'root', 'same-2', 'last']) refresher.addPath(path);
  await timers.advance(1000);
  assert.deepEqual(trace.filter(row => row[0] === 'refresh'), [['refresh', 'same-1'], ['refresh', 'last']]);
  assert.deepEqual(trace.filter(row => row[0] === 'error'), [['error', 'lookup'], ['error', 'refresh']]);
  assert.deepEqual(trace.filter(row => row[0] === 'release').map(row => row[1]), ['same-1', 'root', 'same-2', 'last']);
  refresher.dispose();
});

test('stop drops pending batches while an already started lookup finishes before close returns', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture({ resolveAffectedItem: async path => {
    entered.resolve(); await release.promise; return { item: { Id: path, Path: path, Type: 'Folder' }, dispose() {} };
  } });
  await f.monitor.reportFileSystemChanged('C:\\media\\active.mkv');
  const ticking = f.timers.advance(1000); await entered.promise;
  await f.monitor.reportFileSystemChanged('C:\\other\\pending.mkv');
  let closed = false; const closing = f.monitor.close().then(() => { closed = true; });
  await settle(); assert.equal(closed, false); assert.equal(f.timers.scheduled.size, 0);
  release.resolve(); await ticking; await closing;
  assert.deepEqual(f.trace.filter(row => row[0] === 'refresh'), [['refresh', 'C:\\media\\active.mkv']]);
});

test('stop during asynchronous event filtering cannot resurrect a discarded batch', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture({ getFileInfo: async () => { entered.resolve(); await release.promise; return { isDirectory: false }; } });
  const reporting = f.monitor.reportFileSystemChanged('C:\\media\\old.mkv'); await entered.promise;
  await f.monitor.stop(); release.resolve(); await reporting;
  assert.equal(f.timers.scheduled.size, 0); await f.monitor.close();
});

test('close waits root selection and removes completion timers even when a watcher close fails', async () => {
  const selected = Promise.withResolvers(), release = Promise.withResolvers(); let attempts = 0;
  const f = fixture({
    getWatchPaths: async function* () { yield 'C:\\media'; yield 'C:\\other'; },
    watchPath: async () => ({ close: () => { if (++attempts === 1) throw new Error('close'); } })
  });
  await f.monitor.start(); await settle();
  f.host.getWatchPaths = async function* () { selected.resolve(); await release.promise; yield 'C:\\late'; };
  const starting = f.monitor.start(); await selected.promise;
  f.monitor.reportFileSystemChangeComplete('C:\\media\\owned.nfo', true);
  const closing = f.monitor.close(); const assertion = assert.rejects(closing, /failed to stop/);
  await settle(); assert.equal(attempts, 2); assert.equal(f.timers.scheduled.size, 0);
  release.resolve(); await starting; await assertion;
  assert.equal(f.monitor.close(), closing);
});

test('queued event work from the stopped generation cannot invalidate or close its replacement', async () => {
  const f = fixture();
  try {
    await f.monitor.start(); await settle();
    f.watches.get('C:\\media').onChange({ path: 'C:\\media\\stale.mkv' });
    f.events.emit('ItemRemoved', { Item: { Path: 'C:\\media' }, Parent: { Type: 'AggregateFolder' } });
    const stopping = f.monitor.stop(); await f.monitor.start(); await stopping; await settle();
    assert.equal(f.watches.size, 1);
    assert.equal(f.trace.some(row => row[0] === 'info'), false);
    assert.equal(f.timers.scheduled.size, 0);
  } finally { await f.monitor.close(); }
});

test('independent watcher and refresher callbacks leave the request scope while explicit start retains it', async () => {
  const context = new AsyncLocalStorage(), observations = [];
  const f = fixture({
    getWatchPaths: () => { observations.push(['roots', context.getStore()]); return ['C:\\media']; },
    getFileInfo: () => { observations.push(['info', context.getStore()]); return { isDirectory: false }; },
    resolveAffectedItem: path => {
      observations.push(['lookup', context.getStore()]);
      return { item: { Id: path, Path: path, Type: 'Folder' }, dispose() {} };
    },
    changedExternally: () => observations.push(['refresh', context.getStore()])
  }, { runBackground: operation => context.run('detached', operation) });
  try {
    await context.run('request', () => f.monitor.start()); await settle();
    context.run('request', () => f.watches.get('C:\\media').onChange({ path: 'C:\\media\\film.mkv' }));
    await settle(); await context.run('request', () => f.timers.advance(1000));
    assert.deepEqual(observations, [['roots', 'request'], ['info', 'detached'], ['lookup', 'detached'], ['refresh', 'detached']]);
  } finally { await f.monitor.close(); }
});

test('mapped identities select their own Windows or POSIX path policy on every execution platform', async () => {
  const f = fixture({}, { windows: undefined });
  try {
    await f.monitor.reportFileSystemChanged('C:\\media\\one.mkv');
    await f.monitor.reportFileSystemChanged('C:\\media\\two.mkv');
    await f.monitor.reportFileSystemChanged('/media/one.mkv');
    await f.monitor.reportFileSystemChanged('/media/two.mkv');
    await f.monitor.reportFileSystemChanged('/MEDIA/one.mkv');
    assert.equal(f.timers.scheduled.size, 3);
    await f.timers.advance(1000);
    const lookedUp = f.trace.filter(row => row[0] === 'lookup').map(row => row[1]);
    assert.deepEqual(lookedUp, ['C:\\media\\one.mkv', 'C:\\media', 'C:\\media\\two.mkv',
      '/media/one.mkv', '/media', '/media/two.mkv', '/MEDIA/one.mkv']);
  } finally { await f.monitor.close(); }
});

test('large configured delays do not overflow into immediate refresh and invalid resets retain the existing timer', async () => {
  const timers = clock(), configuration = { LibraryMonitorDelay: 2_147_484 }, calls = [];
  const refresher = new LibraryFileRefresher('/media/film.mkv', { timers, configuration,
    host: { resolveAffectedItem: path => { calls.push(path); return null; }, changedExternally() {} } });
  assert.equal([...timers.scheduled.values()][0].delay, 2_147_483_647);
  configuration.LibraryMonitorDelay = -1;
  assert.throws(() => refresher.restartTimer(), RangeError);
  assert.equal(timers.scheduled.size, 1);
  await timers.advance(2_147_483_647);
  assert.deepEqual(calls, []); assert.equal([...timers.scheduled.values()][0].delay, 353);
  await timers.advance(352); assert.deepEqual(calls, []);
  await timers.advance(1); assert.deepEqual(calls, ['/media/film.mkv']);
  refresher.dispose();
});

test('synchronous refresh admission queues the entire resolved batch without yielding between items', async () => {
  const calls = [], timers = clock();
  const refresher = new LibraryFileRefresher('/one', { timers, configuration: { LibraryMonitorDelay: 1 }, host: {
    resolveAffectedItem: path => ({ item: { Id: path, Path: path, Type: 'Folder' }, dispose() {} }),
    changedExternally: item => { calls.push(item.Path); queueMicrotask(() => calls.push('worker:' + item.Path)); }
  } });
  refresher.addPath('/two');
  await timers.advance(1000);
  assert.deepEqual(calls, ['/one', '/two', 'worker:/one', 'worker:/two']);
  refresher.dispose();
});
