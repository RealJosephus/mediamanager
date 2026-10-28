import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { constants, fstatSync, lstatSync } from 'node:fs';
import { lstat, mkdir, open, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getSystemErrorName } from 'node:util';

const darwinDirectory = '/Users/Shared/mediamanager-operation-leases';
const darwinParents = ['/', '/Users', '/Users/Shared'];
const exclusiveNonblocking = 2 | 4, unlock = 8;
let darwinBinding;

function alreadyActive(label, cause) {
  return Object.assign(new Error(label + ' is already active', { cause }), { code: 'OPERATION_LEASE_ACTIVE' });
}

function aggregateFailures(failures, message) {
  const primary = failures[0], error = new AggregateError(failures, message, { cause: primary });
  for (const field of ['code', 'status', 'statusCode']) {
    try {
      const value = primary?.[field];
      if (value !== undefined) error[field] = value;
    } catch { /* Inspecting public fields must not replace the original cause. */ }
  }
  return error;
}

function endpointFor(digest) {
  if (process.platform === 'win32') return { path: '\\\\.\\pipe\\mediamanager-operation-' + digest };
  if (process.platform === 'linux') return { path: '\0mediamanager-operation-' + digest };
  throw new Error('Operation leases are unsupported on ' + process.platform + '.');
}

async function flockBinding() {
  // No native dependency is loaded by imports or pre-install release tooling.
  return darwinBinding ??= (async () => {
    const { default: koffi } = await import('koffi');
    const library = koffi.load('/usr/lib/libSystem.B.dylib');
    return { koffi, flock: library.func('int flock(int fd, int operation)'),
      renameExclusive: library.func('int renamex_np(const char *from, const char *to, unsigned int flags)') };
  })();
}

function nativeFailure(binding, syscall, filename) {
  const number = binding.koffi.errno(), code = getSystemErrorName(-number);
  return Object.assign(new Error(code + ': operation lease ' + syscall + ' failed'), {
    code, errno: -number, syscall, path: filename,
  });
}

function flock(binding, fd, operation, filename, label, acquiring = false) {
  if (binding.flock(fd, operation) === 0) return;
  const cause = nativeFailure(binding, 'flock', filename);
  if (acquiring && [binding.koffi.os.errno.EWOULDBLOCK, binding.koffi.os.errno.EAGAIN].includes(-cause.errno)) {
    throw alreadyActive(label, cause);
  }
  throw cause;
}

function physicalParent(info) {
  if (!info.isDirectory() || info.isSymbolicLink()
    || (info.mode & 0o022n) !== 0n && (info.mode & 0o1000n) === 0n) {
    throw new TypeError('Operation lease parents must be physical directories with protected shared entries.');
  }
}

function sharedDirectory(info) {
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o7777n) !== 0o1777n) {
    throw new TypeError('Operation lease directory must be a physical shared sticky directory (01777).');
  }
}

function sameInode(opened, named) {
  return opened.dev === named.dev && opened.ino === named.ino;
}

function ordinaryCarrier(opened, named, original = opened) {
  if (!opened.isFile() || !named.isFile() || named.isSymbolicLink()
    || opened.nlink !== 1n || named.nlink !== 1n
    || !sameInode(opened, named) || !sameInode(opened, original)
    || (opened.mode & 0o444n) !== 0o444n) {
    throw new TypeError('Operation lease carrier must remain the same ordinary file readable by every user.');
  }
}

async function openReadyCarrier(binding, filename, directory = false) {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0);
  try { return await open(filename, flags); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  // chmod must finish before a canonical name becomes visible, including when
  // another UID or a restrictive umask participates. This is atomic publication,
  // not a second lock namespace: preparing paths never carry an admitted lock.
  // A killed preparer may leave an unpublished item; no acquisition consults it.
  const prepared = filename + '.' + randomUUID() + '.preparing';
  let file, owned, created = false, failure, failed = false;
  try {
    if (directory) {
      await mkdir(prepared, { mode: 0o700 }); created = true;
      owned = await lstat(prepared, { bigint: true });
    }
    file = await open(prepared, flags | (directory ? 0 : constants.O_CREAT | constants.O_EXCL), 0o400);
    created = true;
    const opened = fstatSync(file.fd, { bigint: true });
    if (owned && !sameInode(owned, opened)) throw new Error('Unpublished operation lease directory changed.');
    owned = opened;
    await file.chmod(directory ? 0o1777 : 0o444);
    const info = await file.stat({ bigint: true }), named = await lstat(prepared, { bigint: true });
    if (directory) {
      sharedDirectory(info); sharedDirectory(named);
      if (!sameInode(info, named) || !sameInode(info, owned)) throw new Error('Unpublished operation lease directory changed.');
    } else ordinaryCarrier(info, named, owned);
    // RENAME_EXCL | RENAME_NOFOLLOW_ANY: never replace an existing carrier or
    // follow a substituted parent. There is no unlink of a published identity.
    if (binding.renameExclusive(prepared, filename, 0x4 | 0x10) === 0) return file;
    const cause = nativeFailure(binding, 'renamex_np', filename);
    if (-cause.errno !== binding.koffi.os.errno.EEXIST) throw cause;
  } catch (error) { failed = true; failure = error; }
  const failures = failed ? [failure] : [];
  let closeFailed = false;
  if (file) try { await file.close(); } catch (cleanup) { closeFailed = true; failures.push(cleanup); }
  // A failed close cannot establish that a private FD has drained. Preserve
  // that failure and leave its unpublished item without granting it authority.
  if (created && !closeFailed) try {
    const named = await lstat(prepared, { bigint: true });
    if (!owned || !sameInode(named, owned) || named.isSymbolicLink()
      || (directory ? !named.isDirectory() : !named.isFile())) {
      throw new Error('Unpublished operation lease carrier changed before cleanup.');
    }
    if (directory) await rmdir(prepared); else await unlink(prepared);
  } catch (cleanup) { failures.push(cleanup); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw aggregateFailures(failures, 'Operation lease publication and cleanup failed.');
  // Another publisher won. Open only that same complete canonical identity.
  return open(filename, flags);
}

async function prepareDarwinDirectory(binding) {
  for (const parent of darwinParents) physicalParent(await lstat(parent, { bigint: true }));
  const directory = await openReadyCarrier(binding, darwinDirectory, true);
  let failure, failed = false;
  try {
    const opened = await directory.stat({ bigint: true }), named = await lstat(darwinDirectory, { bigint: true });
    sharedDirectory(opened); sharedDirectory(named);
    if (!sameInode(opened, named)) throw new Error('Operation lease directory changed during admission.');
  } catch (error) { failed = true; failure = error; }
  try { await directory.close(); }
  catch (cleanup) {
    if (failed) throw aggregateFailures([failure, cleanup], 'Operation lease directory preparation and close failed.');
    throw cleanup;
  }
  if (failed) throw failure;
}

async function acquireDarwinLease(identity, digest, label) {
  const binding = await flockBinding();
  await prepareDarwinDirectory(binding);
  const filename = path.join(darwinDirectory, digest + '.lock');
  let file, locked = false, original;
  try {
    file = await openReadyCarrier(binding, filename);
    original = await file.stat({ bigint: true });
    ordinaryCarrier(original, await lstat(filename, { bigint: true }));
    flock(binding, file.fd, exclusiveNonblocking, filename, label, true); locked = true;
    for (const parent of darwinParents) physicalParent(await lstat(parent, { bigint: true }));
    sharedDirectory(await lstat(darwinDirectory, { bigint: true }));
    ordinaryCarrier(await file.stat({ bigint: true }), await lstat(filename, { bigint: true }), original);
  } catch (failure) {
    const failures = [failure];
    if (locked) try { flock(binding, file.fd, unlock, filename, label); } catch (cleanup) { failures.push(cleanup); }
    if (file) try { await file.close(); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw aggregateFailures(failures, 'Operation lease admission and cleanup failed.');
    throw failure;
  }
  // Persistent ordinary files carry kernel locks, not owner records. Never
  // unlink one: a contender may already have opened that exact inode. The
  // shared stable directory avoids temporary-file cleaners and UID namespaces.
  let released = false, lost = false, lostCause, releasePromise;
  return Object.freeze({
    identity,
    assertHeld() {
      if (released || lost) throw new Error(label + ' lease is no longer held', lost ? { cause: lostCause } : undefined);
      try {
        for (const parent of darwinParents) physicalParent(lstatSync(parent, { bigint: true }));
        sharedDirectory(lstatSync(darwinDirectory, { bigint: true }));
        ordinaryCarrier(fstatSync(file.fd, { bigint: true }), lstatSync(filename, { bigint: true }), original);
        flock(binding, file.fd, exclusiveNonblocking, filename, label);
      } catch (cause) {
        lost = true; lostCause = cause;
        throw new Error(label + ' lease is no longer held', { cause });
      }
    },
    release() {
      if (!releasePromise) {
        released = true;
        releasePromise = (async () => {
          const failures = [];
          try { flock(binding, file.fd, unlock, filename, label); } catch (failure) { failures.push(failure); }
          try { await file.close(); } catch (failure) { failures.push(failure); }
          if (failures.length === 1) throw failures[0];
          if (failures.length) throw aggregateFailures(failures, 'Operation lease unlock and close failed.');
        })();
      }
      return releasePromise;
    },
  });
}

/**
 * Acquire an OS-owned exclusive lease. Pipes/abstract sockets or a Darwin BSD
 * flock on a full-SHA carrier are released by the kernel when their owner dies.
 * A persistent carrier's existence or bytes never establish ownership.
 */
export async function acquireOperationLease(identity, { label = 'Operation' } = {}) {
  if (typeof identity !== 'string' || !identity || identity.includes('\0')) {
    throw new TypeError('Operation lease identity must be a nonempty string without NUL characters');
  }
  if (typeof label !== 'string' || !label) throw new TypeError('Operation lease label must be a nonempty string');
  const digest = createHash('sha256').update(identity).digest('hex');
  if (process.platform === 'darwin') return acquireDarwinLease(identity, digest, label);
  const server = createServer({ pauseOnConnect: true }, socket => socket.destroy());
  const endpoint = endpointFor(digest);
  await new Promise((resolve, reject) => {
    const listening = () => { server.off('error', failed); resolve(); };
    const failed = error => {
      server.off('listening', listening);
      if (['EADDRINUSE', 'EACCES'].includes(error.code)) reject(alreadyActive(label, error));
      else reject(error);
    };
    server.once('listening', listening);
    server.once('error', failed);
    server.listen(endpoint);
  });

  // An endpoint runtime error remains fail-closed until release or process exit.
  let runtimeFailure, runtimeFailed = false;
  const runtimeError = error => { runtimeFailed = true; runtimeFailure = error; };
  server.on('error', runtimeError);
  let releasePromise;
  return Object.freeze({
    identity,
    assertHeld() {
      if (runtimeFailed || !server.listening) throw new Error(label + ' lease is no longer held', { cause: runtimeFailure });
    },
    release() {
      if (!releasePromise) releasePromise = new Promise((resolve, reject) => {
        server.off('error', runtimeError);
        server.close(error => error == null ? resolve() : reject(error));
      });
      return releasePromise;
    },
  });
}
