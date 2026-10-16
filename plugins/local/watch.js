import { watch } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { StorageError, checkAbort } from '@mediamanager/plugin-sdk/storage/errors';
import { isWithin, joinPath, validateName } from '@mediamanager/plugin-sdk/storage/paths';

// Use one non-recursive OS watcher per directory so recursive watching never
// follows a symlink or junction. Events are invalidations, not a file snapshot.
export async function watchDirectory(root, { signal, onChange, onError, resolve, failure }) {
  if (typeof onChange !== 'function' || typeof onError !== 'function') {
    throw new TypeError('Storage watching requires change and error callbacks.');
  }
  const watchers = new Map();
  const missing = error => ['ENOENT', 'ENOTDIR', 'not-found', 'not-directory'].includes(error.code);
  let closed = false, tail = Promise.resolve();
  const report = error => {
    try { void Promise.resolve(onError(failure(error))).catch(() => {}); }
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
    try { void Promise.resolve(onChange(Object.freeze(event))).catch(report); }
    catch (error) { report(error); }
  };
  const enqueue = operation => {
    tail = tail.then(async () => {
      if (closed) return;
      checkAbort(signal);
      await operation();
    }).catch(error => { if (!closed) { report(error); stop(); } });
  };
  const inspect = async (filename, initial = false) => {
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
      if (initial || !missing(error)) throw error;
      remove(filename); return;
    }
    checkAbort(signal);
    if (closed) return;
    if (info.isSymbolicLink()) {
      throw new StorageError('permission-denied', 'Local storage does not watch symbolic links or junctions.', { reason: 'link' });
    }
    if (!info.isDirectory()) {
      remove(filename);
      if (initial) throw new StorageError('not-directory', 'A storage watch requires a directory.');
      return;
    }
    const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}`;
    if (watchers.has(filename) && watchers.get(filename).identity !== identity) remove(filename);
    if (!watchers.has(filename)) {
      let watcher;
      try { watcher = watch(target, { persistent: false }, (type, name) => enqueue(async () => {
        if (name == null || name.length === 0) {
          await inspect(filename);
          changed({ path: filename, type });
          return;
        }
        // A non-recursive watcher must return exactly one local name.
        const relative = String(name);
        validateName(relative);
        const child = joinPath(filename, relative);
        if (type === 'rename') await inspect(child);
        else {
          try { await resolve(child); }
          catch (error) { if (!missing(error)) throw error; }
        }
        changed({ path: child, type });
      })); }
      catch (error) {
        if (initial || !missing(error)) throw error;
        remove(filename); return;
      }
      watcher.on('error', error => enqueue(async () => {
        // Removing a watched child can report an OS error on its own handle.
        // Its parent still watches the namespace and must remain subscribed.
        if (filename !== root) {
          try { await fs.lstat(await resolve(filename)); }
          catch (statError) {
            if (missing(statError)) {
              remove(filename); changed({ path: filename, type: 'rename' }); return;
            }
          }
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
      if (initial || !missing(error)) throw error;
      remove(filename); return;
    }
    if (closed || signal?.aborted) { await directory.close(); checkAbort(signal); return; }
    for await (const entry of directory) {
      checkAbort(signal);
      if (closed) return;
      if (entry.isSymbolicLink()) {
        throw new StorageError('permission-denied', 'Local storage does not watch symbolic links or junctions.', { reason: 'link' });
      }
      if (entry.isDirectory()) await inspect(joinPath(filename, entry.name));
    }
    // A directory can disappear without an event on its own watcher.
    for (const name of [...watchers.keys()]) if (name !== filename && path.posix.dirname(name) === filename) {
      try { await fs.lstat(await resolve(name)); }
      catch (error) { if (missing(error)) remove(name); else throw error; }
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
