import { ordinalIgnoreCaseKey } from '../storage/ordinal-comparer.js';
import { nativeContainsSubPath, nativeDirectoryName, nativeSubpathParent } from './native-path.js';
import { matchesCoreResolutionIgnorePattern } from './resolution-ignore.js';

const typeOf = item => String(item?.NativeType ?? item?.Type ?? '').split('.').at(-1);
const defaultTimers = { setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: timer => clearTimeout(timer) };
const identityWindows = (path, configured) => configured ?? (/^[A-Za-z]:[\\/]|^\\\\/u.test(path) ? true
  : path.startsWith('/') ? false : process.platform === 'win32');
const requiredPath = value => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('A nonempty library path is required.');
  return value;
};
const logError = (logger, error, message) => {
  try { logger.error(error, message); } catch { /* Diagnostics cannot strand a directory watch owner. */ }
};

function scheduleDelay(timers, callback, delay) {
  // System.Threading.Timer accepts a larger finite interval than Node's
  // individual timers. Splitting that interval avoids Node's 1 ms overflow.
  let remaining = delay, timer, cancelled = false;
  const arm = () => {
    const interval = Math.min(remaining, 2_147_483_647);
    remaining -= interval;
    timer = timers.setTimeout(() => {
      if (cancelled) return;
      if (remaining > 0) arm();
      else return callback();
    }, interval);
    timer?.unref?.();
  };
  arm();
  return { cancel() { cancelled = true; timers.clearTimeout(timer); } };
}

function samePath(left, right, windows) {
  if (!left?.trim() || !right?.trim()) return false;
  left = nativeSubpathParent(left, { windows });
  right = nativeSubpathParent(right, { windows });
  return windows ? ordinalIgnoreCaseKey(left) === ordinalIgnoreCaseKey(right) : left === right;
}

// LibraryMonitor's initial root selection intentionally has different casing
// and separator rules from ManagedFileSystem's event coalescing comparisons.
function containsWatchParent(paths, value, windows) {
  const separator = windows ? '\\' : '/';
  const trim = path => {
    while (path.endsWith(separator)) path = path.slice(0, -1);
    return ordinalIgnoreCaseKey(path);
  };
  const path = trim(requiredPath(value));
  return paths.some(value => {
    const parent = trim(value);
    return path === parent || path.startsWith(parent) && path[parent.length] === separator;
  });
}

/** FileRefresher's affected-path batch. Database and storage access belong to
 * the host; all lookups precede the first refresh admission. */
export class LibraryFileRefresher {
  #paths = new Set();
  #timer;
  #disposed = false;

  constructor(path, options) {
    const { host, logger = { error() {} }, timers = defaultTimers,
      onCompleted = () => {}, onProcessing = () => {}, runBackground = operation => operation() } = options;
    if (!host || typeof host.resolveAffectedItem !== 'function' || typeof host.changedExternally !== 'function') {
      throw new TypeError('A file refresher requires affected-item lookup and refresh admission.');
    }
    Object.assign(this, { options, host, logger, timers, onCompleted, onProcessing, runBackground });
    this.path = requiredPath(path);
    this.addPath(path);
  }

  get configuration() { const { configuration = {} } = this.options; return configuration; }

  addPath(path) { this.#paths.add(requiredPath(path)); this.restartTimer(); }

  restartTimer() {
    if (this.#disposed) return;
    const delay = (this.configuration.LibraryMonitorDelay ?? 60) * 1000;
    if (!Number.isFinite(delay) || delay < 0 || delay > 4_294_967_294) throw new RangeError('The library monitor delay is outside the supported timer range.');
    this.#timer?.cancel();
    this.#timer = scheduleDelay(this.timers, () => this.#fire(), delay);
  }

  resetPath(path, affectedFile) {
    this.path = requiredPath(path);
    this.#paths.add(path);
    if (affectedFile) this.#paths.add(affectedFile);
    this.restartTimer();
  }

  #fire() {
    if (this.#disposed) return;
    const paths = [...this.#paths];
    this.#clearTimer();
    this.onCompleted(this);
    const processing = Promise.resolve().then(() => this.runBackground(() => this.#process(paths)))
      .catch(error => logError(this.logger, error, 'Error processing directory changes.'));
    this.onProcessing(processing);
    return processing;
  }

  async #process(paths) {
    const owners = [], items = new Map();
    try {
      for (const path of paths) {
        try {
          const owner = await this.host.resolveAffectedItem(path);
          if (!owner) continue;
          owners.push(owner);
          const item = owner.item;
          const key = String(item.Id).replaceAll('-', '').toLowerCase();
          if (!items.has(key)) items.set(key, item);
        } catch (error) { logError(this.logger, error, `Error finding the item affected by changes to ${path}.`); }
      }
      for (const item of items.values()) {
        if (typeOf(item) === 'AggregateFolder') continue;
        try {
          const admission = this.host.changedExternally(item);
          if (admission && typeof admission.then === 'function') await admission;
        }
        catch (error) { logError(this.logger, error, `Error refreshing ${item.Name ?? item.Path}.`); }
      }
    } finally {
      for (const owner of owners) {
        try { await owner.dispose(); }
        catch (error) { logError(this.logger, error, 'Error releasing an affected library item.'); }
      }
    }
  }

  #clearTimer() {
    this.#timer?.cancel();
    this.#timer = undefined;
  }

  dispose() { this.#disposed = true; this.#clearTimer(); }
}

/** Directory events follow the designated LibraryMonitor policy. The storage
 * plugin owns native watchers; this owner owns timers and event admission. */
export class LibraryDirectoryMonitor {
  #disposed = false;
  #started = false;
  #generation = 0;
  #lifetime = new AbortController();
  #watchers = new Map();
  #pending = new Map();
  #refreshers = new Set();
  #ignored = new Map();
  #completionTimers = new Set();
  #operations = new Set();
  #closing;

  constructor(options) {
    const { host, ignoreRule, logger = { error() {} }, timers = defaultTimers,
      windows, runBackground = operation => operation() } = options;
    const methods = ['getWatchPaths', 'getWatchPath', 'watchPath', 'getFileInfo', 'invalidate', 'resolveAffectedItem', 'changedExternally'];
    if (!host || methods.some(method => typeof host[method] !== 'function')) throw new TypeError('A complete library monitor host is required.');
    if (!ignoreRule || typeof ignoreRule.shouldIgnore !== 'function') throw new TypeError('Library monitoring requires the shared ignore rule.');
    Object.assign(this, { options, host, ignoreRule, logger, timers, windows, runBackground });
    this.capabilities = Object.freeze({ watchesLibraryDirectories: true });
    this.onItemAdded = event => {
      if (typeOf(event.Parent) !== 'AggregateFolder') return;
      const generation = this.#generation;
      this.#background(async () => {
        const path = await this.host.getWatchPath(event.Item);
        if (path && this.#started && generation === this.#generation && !this.#disposed) this.#startPath(path, generation);
      }, 'Error watching an added library directory.');
    };
    this.onItemRemoved = event => {
      if (typeOf(event.Parent) !== 'AggregateFolder') return;
      const generation = this.#generation;
      this.#background(() => generation === this.#generation ? this.#stopPath(event.Item.Path) : undefined,
        'Error stopping a removed library directory watcher.');
    };
  }

  get configuration() { const { configuration = {} } = this.options; return configuration; }

  #track(operation) {
    const promise = Promise.resolve(operation);
    this.#operations.add(promise);
    void promise.then(() => this.#operations.delete(promise), () => this.#operations.delete(promise));
    return promise;
  }

  #background(operation, message) {
    return this.#track(Promise.resolve().then(() => this.runBackground(operation)).catch(error => logError(this.logger, error, message)));
  }

  start() { return this.#track(this.#start()); }

  async #start() {
    if (this.#disposed) return;
    const generation = this.#generation;
    if (!this.#started) {
      this.#started = true;
      this.host.events?.on('ItemAdded', this.onItemAdded);
      this.host.events?.on('ItemRemoved', this.onItemRemoved);
    }
    const paths = [];
    for await (const path of await this.host.getWatchPaths()) {
      if (this.#disposed || generation !== this.#generation) return;
      if (!containsWatchParent(paths, path, identityWindows(path, this.windows))) paths.push(path);
    }
    for (const path of paths) this.#startPath(path, generation);
  }

  #startPath(path, generation) {
    const key = ordinalIgnoreCaseKey(requiredPath(path));
    if (this.#watchers.has(key) || this.#pending.get(key)?.generation === generation) return;
    const record = { path, generation, watcher: null, active: true };
    this.#pending.set(key, record);
    this.#background(async () => {
      try {
        const current = () => record.active && !this.#disposed && this.#started && generation === this.#generation;
        if (!current()) return;
        const watcher = await this.host.watchPath(path, { signal: this.#lifetime.signal,
          onChange: event => {
            if (current()) this.#background(() => current() ? this.reportFileSystemChanged(event.path) : undefined,
              `Exception in directory change for ${event.path}.`);
          },
          onError: (error, state) => {
            if (!current()) return;
            if (typeof state?.terminal !== 'boolean') {
              error = new TypeError('A directory watch error must declare its subscription state.');
              state = { terminal: true };
            }
            logError(this.logger, error, `Error in directory watcher for ${path}.`);
            if (state.terminal) {
              record.active = false;
              if (record.watcher) this.#background(() => this.#stopPath(path, record), `Error closing directory watcher for ${path}.`);
            }
          }
        });
        if (!watcher) return;
        if (!current() || this.#watchers.has(key)) await watcher.close();
        else { record.watcher = watcher; this.#watchers.set(key, record); }
      } finally { if (this.#pending.get(key) === record) this.#pending.delete(key); }
    }, `Error watching path: ${path}.`);
  }

  async #stopPath(path, expected) {
    if (typeof path !== 'string' || !path) return;
    const key = ordinalIgnoreCaseKey(path);
    if (expected && this.#watchers.get(key) !== expected) return;
    const pending = this.#pending.get(key);
    if (pending) pending.active = false;
    const record = this.#watchers.get(key);
    if (!record) return;
    record.active = false;
    this.#watchers.delete(key);
    await record.watcher.close();
  }

  reportFileSystemChangeBeginning(path) {
    requiredPath(path);
    if (this.#disposed) return;
    this.#ignored.set(ordinalIgnoreCaseKey(path), path);
  }

  reportFileSystemChangeComplete(path, refreshPath) {
    requiredPath(path);
    if (this.#disposed) return;
    // Native completion is async-void. Callers must not wait forty-five seconds
    // for a save to return, and a later Begin does not renew this expiry.
    const timer = this.timers.setTimeout(() => {
      this.#completionTimers.delete(timer);
      this.#ignored.delete(ordinalIgnoreCaseKey(path));
      if (refreshPath && !this.#disposed) this.#background(() => this.reportFileSystemChanged(path), `Error in directory change for ${path}.`);
    }, 45_000);
    timer?.unref?.();
    this.#completionTimers.add(timer);
  }

  reportFileSystemChanged(path) { return this.#track(this.#reportFileSystemChanged(path)); }

  async #reportFileSystemChanged(path) {
    requiredPath(path);
    if (this.#disposed || matchesCoreResolutionIgnorePattern(path)) return;
    const generation = this.#generation;
    const info = await this.host.getFileInfo(path);
    if (await this.ignoreRule.shouldIgnore(path, { isDirectory: info.isDirectory })) return;
    await this.host.invalidate(path);
    if (this.#disposed || generation !== this.#generation) return;
    const windows = identityWindows(path, this.windows);
    for (const ignored of this.#ignored.values()) {
      if (samePath(ignored, path, windows) || nativeContainsSubPath(path, ignored, { windows })) return;
      const parent = nativeDirectoryName(ignored, { windows });
      if (parent && samePath(parent, path, windows)) return;
    }
    this.#createRefresher(path);
  }

  #createRefresher(path) {
    const windows = identityWindows(path, this.windows);
    const parent = nativeDirectoryName(path, { windows });
    for (const refresher of this.#refreshers) {
      if (samePath(path, refresher.path, windows)) { refresher.restartTimer(); return; }
      if (nativeContainsSubPath(path, refresher.path, { windows })) { refresher.addPath(path); return; }
      if (nativeContainsSubPath(refresher.path, path, { windows })) { refresher.resetPath(path, null); return; }
      if (parent != null && nativeDirectoryName(refresher.path, { windows }) === parent) {
        refresher.resetPath(parent, path); return;
      }
    }
    const options = this.options;
    const refresher = new LibraryFileRefresher(path, { host: this.host, get configuration() { return options.configuration; },
      logger: this.logger, timers: this.timers, runBackground: this.runBackground,
      onCompleted: owner => { owner.dispose(); this.#refreshers.delete(owner); },
      onProcessing: operation => this.#track(operation) });
    this.#refreshers.add(refresher);
  }

  async stop() {
    this.#generation++;
    this.#started = false;
    this.#lifetime.abort();
    this.#lifetime = new AbortController();
    this.host.events?.off('ItemAdded', this.onItemAdded);
    this.host.events?.off('ItemRemoved', this.onItemRemoved);
    for (const record of this.#pending.values()) record.active = false;
    for (const refresher of this.#refreshers) refresher.dispose();
    this.#refreshers.clear();
    const watchers = [...this.#watchers.values()];
    this.#watchers.clear();
    const results = await Promise.allSettled(watchers.map(record => {
      record.active = false;
      return Promise.resolve().then(() => record.watcher.close());
    }));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Library directory watchers failed to stop.');
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#disposed = true;
    this.#closing = (async () => {
      let failure;
      try { await this.stop(); } catch (error) { failure = error; }
      for (const timer of this.#completionTimers) this.timers.clearTimeout(timer);
      this.#completionTimers.clear();
      this.#ignored.clear();
      while (this.#operations.size) await Promise.allSettled([...this.#operations]);
      if (failure) throw failure;
    })();
    return this.#closing;
  }
}
