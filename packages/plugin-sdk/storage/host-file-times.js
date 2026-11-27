import path from 'node:path';
import { getSystemErrorName } from 'node:util';
import koffi from 'koffi';

const second = 1_000_000_000n;
const windowsEpochTicks = 116_444_736_000_000_000n;
const windowsCodes = new Map([[2, 'ENOENT'], [3, 'ENOENT'], [5, 'EACCES'], [32, 'EBUSY'], [87, 'EINVAL']]);
let setTimes;

function nativeFailure(filename, syscall, code, errno) {
  return Object.assign(new Error(`${code}: cannot set times on '${filename}'.`), { code, errno, syscall, path: filename });
}

function bindPosix() {
  const library = koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : null);
  const timespec = koffi.struct({ tv_sec: 'long', tv_nsec: 'long' });
  const futimens = library.func('futimens', 'int', ['int', koffi.pointer(timespec)]);
  const asTimespec = value => {
    const tv_nsec = (value % second + second) % second;
    return { tv_sec: (value - tv_nsec) / second, tv_nsec };
  };
  return (fd, filename, accessed, modified) => new Promise((resolve, reject) => {
    futimens.async(fd, [asTimespec(accessed), asTimespec(modified)], (error, status) => {
      if (error) return reject(error);
      if (status === 0) return resolve();
      const errno = -koffi.errno();
      reject(nativeFailure(filename, 'futimens', errno < 0 ? getSystemErrorName(errno) : 'EIO', errno));
    });
  });
}

function bindWindows() {
  const library = koffi.load('kernel32.dll');
  const createFile = library.func('intptr_t __stdcall CreateFileW(const char16_t *, uint32_t, uint32_t, void *, uint32_t, uint32_t, intptr_t)');
  const fileTime = koffi.struct({ low: 'uint32_t', high: 'uint32_t' });
  const timePointer = koffi.pointer(fileTime);
  const setFileTime = library.func('__stdcall', 'SetFileTime', 'int', ['intptr_t', timePointer, timePointer, timePointer]);
  const closeHandle = library.func('int __stdcall CloseHandle(intptr_t)');
  const lastError = library.func('uint32_t __stdcall GetLastError()');
  const openExisting = 3, shareReadWriteDelete = 7, writeAttributes = 0x100, openReparsePoint = 0x00200000;
  const backupSemantics = 0x02000000; // Permit opening directory handles as well as files.
  const asFileTime = nanoseconds => {
    const ticks = nanoseconds / 100n + windowsEpochTicks;
    if (ticks < 0n || ticks >= (1n << 63n)) throw new RangeError('Local file timestamp is outside the Windows range.');
    return { low: Number(ticks & 0xffffffffn), high: Number(ticks >> 32n) };
  };
  const call = (method, args, filename, failed = result => !result) => new Promise((resolve, reject) => {
    method.async(...args, (error, result) => {
      if (error) return reject(error);
      if (!failed(result)) return resolve(result);
      const errno = lastError();
      reject(nativeFailure(filename, method.name, windowsCodes.get(errno) ?? 'EIO', errno));
    });
  });
  return async (_fd, filename, accessed, modified) => {
    const times = [asFileTime(accessed), asFileTime(modified)];
    const handle = await call(createFile, [path.toNamespacedPath(filename), writeAttributes, shareReadWriteDelete,
      null, openExisting, openReparsePoint | backupSemantics, 0], filename, result => result === -1 || result === -1n);
    let failure;
    try { await call(setFileTime, [handle, null, ...times], filename); }
    catch (error) { failure = error; }
    try { await call(closeHandle, [handle], filename); }
    catch (error) {
      if (failure) throw new AggregateError([failure, error], failure.message, { cause: failure });
      throw error;
    }
    if (failure) throw failure;
  };
}

// The SDK timestamps have 100 ns resolution. A JavaScript Date or a double
// containing absolute Unix seconds can discard part of that value.
export function setHostFileTimes(fd, filename, modified, accessed = BigInt(Date.now()) * 1_000_000n) {
  setTimes ??= process.platform === 'win32' ? bindWindows() : bindPosix();
  return setTimes(fd, filename, accessed, modified);
}
