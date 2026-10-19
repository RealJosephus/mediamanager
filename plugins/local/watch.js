import { watch } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { StorageError, checkAbort } from '@mediamanager/plugin-sdk/storage/errors';
import { isWithin, joinPath, validateName } from '@mediamanager/plugin-sdk/storage/paths';

// Use one non-recursive OS watcher per directory so recursive watching never
// follows a symlink or junction. Events are invalidations, not a file snapshot.
export async function watchDirectory(root, { signal, onChange, onError, resolve, failure,
  watch: nativeWatch = watch, windows = process.platform === 'win32' }) {
  if (typeof onChange !== 'function' || typeof onError !== 'function') {
    throw new TypeError('Storage watching requires change and error callbacks.');
  }
  const watchers = new Map();
  const missing = error => ['ENOENT', 'ENOTDIR', 'not-found', 'not-directory'].includes(error.code);
  const denied = error => ['EACCES', 'EPERM', 'permission-denied'].includes(error.code);
  const callbackFailure = (error, filename, name) => {
    const converted = failure(error), callbackName = name == null ? null : String(name);
    return new StorageError(converted.code,
      `${converted.message} (watchPath=${JSON.stringify(filename)}, callbackName=${JSON.stringify(callbackName)}).`,
      { ...converted.details, watchPath: filename, callbackName });
  };
  const relativeParts = name => {
    const value = windows ? name.replaceAll('\\', '/') : name;
    if (value.startsWith('/') || /^[A-Za-z]:/u.test(value)) {
      throw new StorageError('invalid-path', 'A watch callback must name a relative descendant.');
    }
    return value.split('/').map(validateName);
  };
  const sameNativePath = (left, right) => path.win32.toNamespacedPath(left).toLowerCase()
    === path.win32.toNamespacedPath(right).toLowerCase();
  let closed = false, tail = Promise.resolve();
  const report = (error, terminal) => {
    if (closed && !terminal) return;
    try { void Promise.resolve(onError(failure(error), Object.freeze({ terminal }))).catch(() => {}); }
    catch { /* A diagnostic callback cannot escape an OS watcher. */ }
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', stop);
    for (const { watcher } of watchers.values()) watcher.close();
    watchers.clear();
  };
  const close = async () => { stop(); await tail; };
  const remove = filename => {
    for (const [name, { watcher }] of watchers) if (isWithin(name, filename)) {
      watchers.delete(name); watcher.close();
    }
  };
  const changed = event => {
    if (closed) return;
    try { void Promise.resolve(onChange(Object.freeze(event))).catch(error => report(error, false)); }
    catch (error) { report(error, false); }
  };
  const rejectSubtree = (filename, error) => {
    if (filename === root || !denied(error)) return false;
    remove(filename);
    report(error, false);
    return true;
  };
  const enqueue = operation => {
    tail = tail.then(async () => {
      if (closed) return;
      checkAbort(signal);
      await operation();
    }).catch(error => { if (!closed) { stop(); report(error, true); } });
  };
  const inspect = async (filename, initial = false) => {
    try { await inspectDirectory(filename, initial); return true; }
    catch (error) { if (rejectSubtree(filename, error)) return false; throw error; }
  };
  const inspectDirectory = async (filename, initial) => {
    checkAbort(signal);
    if (closed) return;
    let target, info;
    try {
      target = await resolve(filename);
      checkAbort(signal);
      if (closed) return;
      info = await fs.lstat(target, { bigint: true });
    }
    catch (error) {
      if (initial || filename === root || !missing(error)) throw error;
      remove(filename); return;
    }
    checkAbort(signal);
    if (closed) return;
    if (info.isSymbolicLink()) {
      throw new StorageError('permission-denied', 'Local storage does not watch symbolic links or junctions.', { reason: 'link' });
    }
    if (!info.isDirectory()) {
      remove(filename);
      if (initial || filename === root) throw new StorageError('not-directory', 'A storage watch requires a directory.');
      return;
    }
    const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}`;
    if (watchers.has(filename) && watchers.get(filename).identity !== identity) remove(filename);
    if (!watchers.has(filename)) {
      let watcher;
      try { watcher = nativeWatch(target, { persistent: false, recursive: false }, (type, name) => enqueue(async () => {
        // Closed handles can already have events queued when their path is
        // replaced. They must not remove or reconcile the replacement owner.
        if (watchers.get(filename)?.watcher !== watcher) return;
        try {
          if (name == null || name.length === 0) {
            if (await inspect(filename)) changed({ path: filename, type });
            return;
          }
          const value = String(name);
          // Node 24's Windows libuv reports its absolute watched path when the
          // handle is DeletePending (deps/uv/src/win/fs-event.c). Interpret only
          // that already-owned identity; never resolve an absolute callback.
          if (windows && type === 'rename' && path.win32.isAbsolute(value) && sameNativePath(value, target)) {
            if (filename === root) throw new StorageError('not-found', 'The watched storage directory was deleted.');
            remove(filename); changed({ path: filename, type }); return;
          }
          let parts;
          try { parts = relativeParts(value); }
          catch (error) {
            report(callbackFailure(error, filename, name), false);
            // Unknown native names are invalidations of the held directory,
            // never paths to normalize, follow, or resolve outside that owner.
            if (await inspect(filename)) changed({ path: filename, type });
            return;
          }
          const child = joinPath(filename, parts.join('/'));
          // A descendant notification can arrive before an intermediate
          // directory's own event. Install that subtree before exposing it.
          if (parts.length > 1 && !await inspect(joinPath(filename, parts[0]))) return;
          // A change can restore access to a previously rejected directory.
          if (await inspect(child)) changed({ path: child, type });
        } catch (error) { throw callbackFailure(error, filename, name); }
      })); }
      catch (error) {
        if (initial || filename === root || !missing(error)) throw error;
        remove(filename); return;
      }
      watcher.on('error', error => enqueue(async () => {
        if (watchers.get(filename)?.watcher !== watcher) return;
        // Removing a watched child can report an OS error on its own handle.
        // Its parent still watches the namespace and must remain subscribed.
        if (filename !== root) {
          try { await fs.lstat(await resolve(filename)); }
          catch (statError) {
            if (missing(statError)) {
              remove(filename); changed({ path: filename, type: 'rename' }); return;
            }
            if (rejectSubtree(filename, statError)) return;
          }
          if (rejectSubtree(filename, error)) return;
        }
        throw error;
      }));
      watchers.set(filename, { watcher, identity });
    }
    // Open the watcher before walking: events during enumeration are queued and
    // reconciled once the initial tree is installed, including newly made dirs.
    let directory;
    try { directory = await fs.opendir(target); }
    catch (error) {
      if (initial || filename === root || !missing(error)) throw error;
      remove(filename); return;
    }
    if (closed || signal?.aborted) { await directory.close(); checkAbort(signal); return; }
    for await (const entry of directory) {
      checkAbort(signal);
      if (closed) return;
      if (entry.isSymbolicLink()) {
        rejectSubtree(joinPath(filename, entry.name),
          new StorageError('permission-denied', 'Local storage does not watch symbolic links or junctions.', { reason: 'link' }));
        continue;
      }
      if (entry.isDirectory()) await inspect(joinPath(filename, entry.name));
    }
    // A directory can disappear without an event on its own watcher.
    for (const name of [...watchers.keys()]) if (name !== filename && path.posix.dirname(name) === filename) {
      try { await fs.lstat(await resolve(name)); }
      catch (error) { if (missing(error)) remove(name); else if (!rejectSubtree(name, error)) throw error; }
    }
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    checkAbort(signal);
    // Reserve the serial tail before OS events can enqueue reconciliation.
    tail = inspect(root, true);
    await tail;
    checkAbort(signal);
    return Object.freeze({ close });
  } catch (error) { stop(); await tail.catch(() => {}); throw error; }
}
