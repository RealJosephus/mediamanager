import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const pollMilliseconds = 50;
const publicationMilliseconds = 5000;

function leaseError(code, key, directory, message, owner, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code, resource: key, directory, owner: owner ?? null,
  });
}

async function readOwner(key, directory) {
  let info;
  try { info = await lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw leaseError('test-resource-directory-invalid', key, directory, 'A test resource lease must be a physical directory.');
  }
  const filename = path.join(directory, 'owner.json');
  try { info = await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw leaseError('test-resource-owner-invalid', key, directory, 'A test resource owner must be an ordinary file.');
  }
  let owner;
  try { owner = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw leaseError('test-resource-owner-invalid', key, directory, 'The published test resource owner is unreadable.', null, error);
  }
  if (owner?.schemaVersion !== 1 || owner.resource !== key || typeof owner.token !== 'string' || !owner.token
    || !Number.isSafeInteger(owner.pid) || owner.pid < 1) {
    throw leaseError('test-resource-owner-invalid', key, directory, 'The published test resource owner is invalid.');
  }
  return owner;
}

function ownerIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

/** Hold one job-local resource until its owner finishes the protected work. */
export async function acquireTestResource(key, {
  root = process.env.MEDIAMANAGER_TEST_RESOURCE_ROOT, signal, onWait,
} = {}) {
  if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(key)) {
    throw leaseError('test-resource-key-invalid', key, null, 'A test resource requires a single lowercase key.');
  }
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw leaseError('test-resource-root-required', key, null, 'MEDIAMANAGER_TEST_RESOURCE_ROOT must name an absolute job-local output directory.');
  }
  signal?.throwIfAborted();
  await mkdir(root, { recursive: true });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw leaseError('test-resource-root-invalid', key, root, 'The test resource root must be a physical output directory.');
  }
  const directory = path.join(await realpath(root), key);
  let unpublishedSince;
  for (;;) {
    signal?.throwIfAborted();
    let acquired = false;
    try { await mkdir(directory); acquired = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (acquired) {
      const owner = { schemaVersion: 1, resource: key, token: randomUUID(), pid: process.pid,
        processEntry: process.argv[1] ?? null, acquiredAt: new Date().toISOString() };
      const temporary = path.join(directory, 'owner-' + owner.token + '.pending');
      const filename = path.join(directory, 'owner.json');
      // The directory is exclusive before publication. A failed publication
      // remains visible to the job audit; no contender may reclaim it.
      await writeFile(temporary, JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, filename);
      let released = false, releasing;
      const release = async () => {
        if (released) return;
        if (releasing) return releasing;
        releasing = (async () => {
          const current = await readOwner(key, directory);
          if (current?.token !== owner.token || current.pid !== owner.pid) {
            throw leaseError('test-resource-owner-mismatch', key, directory,
              'A test resource may be released only by its owning token and process.', current);
          }
          const entries = await readdir(directory);
          if (entries.length !== 1 || entries[0] !== 'owner.json') {
            throw leaseError('test-resource-not-empty', key, directory,
              'Unexpected files remain in the test resource lease; they were preserved.', current);
          }
          await unlink(filename);
          await rmdir(directory);
          released = true;
        })();
        try { await releasing; } finally { releasing = undefined; }
      };
      // Cancellation during admission cannot leave a newly published owner.
      if (signal?.aborted) { await release(); signal.throwIfAborted(); }
      return { resource: key, directory, owner: { ...owner }, release };
    }
    const owner = await readOwner(key, directory);
    if (owner === undefined) { unpublishedSince = undefined; continue; }
    if (owner === null) {
      unpublishedSince ??= performance.now();
      if (performance.now() - unpublishedSince >= publicationMilliseconds) {
        throw leaseError('test-resource-owner-unpublished', key, directory,
          'A test resource directory has no published owner; the unreleased directory was preserved.');
      }
    } else {
      unpublishedSince = undefined;
      if (!ownerIsAlive(owner.pid)) {
        // A normal owner may release and exit between the read and PID probe.
        // Only a still-published identical receipt establishes abandonment.
        const current = await readOwner(key, directory);
        if (current?.token !== owner.token || current.pid !== owner.pid) continue;
        throw leaseError('test-resource-owner-exited', key, directory,
          'The test resource owner exited without releasing its lease; its receipt was preserved.', owner);
      }
      await onWait?.({ ...owner });
    }
    try { await delay(pollMilliseconds, undefined, { signal }); }
    catch (error) { signal?.throwIfAborted(); throw error; }
  }
}

/** Release a shared resource after the protected operation's normal cleanup. */
export async function withTestResource(key, operation, options) {
  if (typeof operation !== 'function') throw new TypeError('A protected test operation is required.');
  const lease = await acquireTestResource(key, options);
  let failed = false, primary;
  try {
    options?.signal?.throwIfAborted();
    return await operation();
  } catch (error) { failed = true; primary = error; throw error; }
  finally {
    try { await lease.release(); }
    catch (error) {
      if (failed) throw new AggregateError([primary, error], primary?.message, { cause: primary });
      throw error;
    }
  }
}
