import path from 'node:path';
import { getSystemErrorName } from 'node:util';
import koffi from 'koffi';

const windowsCodes = new Map([
  [2, 'ENOENT'], [3, 'ENOENT'], [5, 'EACCES'], [17, 'EXDEV'], [32, 'EBUSY'],
  [80, 'EEXIST'], [145, 'ENOTEMPTY'], [183, 'EEXIST'], [267, 'ENOTDIR'],
]);
let rename;

function bindRename() {
  if (process.platform === 'win32') {
    const library = koffi.load('kernel32.dll');
    const move = library.func('int __stdcall MoveFileExW(const char16_t *from, const char16_t *to, uint32_t flags)');
    const lastError = library.func('uint32_t __stdcall GetLastError()');
    return (source, target, complete) => move.async(path.toNamespacedPath(source), path.toNamespacedPath(target), 0, (error, moved) => {
      if (error || moved) return complete(error);
      const errno = lastError();
      complete(null, windowsCodes.get(errno) ?? 'EIO', errno);
    });
  }
  const result = complete => (error, status) => {
    if (error || status === 0) return complete(error);
    const errno = -koffi.errno();
    complete(null, getSystemErrorName(errno), errno);
  };
  if (process.platform === 'darwin') {
    const move = koffi.load('/usr/lib/libSystem.B.dylib').func('int renamex_np(const char *from, const char *to, unsigned int flags)');
    const renameExcl = 0x4;
    return (source, target, complete) => move.async(source, target, renameExcl, result(complete));
  }
  if (process.platform === 'linux') {
    const move = koffi.load(null).func('int renameat2(int fromDir, const char *from, int toDir, const char *to, unsigned int flags)');
    const currentDirectory = -100, renameNoReplace = 1;
    return (source, target, complete) => move.async(currentDirectory, source, currentDirectory, target, renameNoReplace, result(complete));
  }
  throw new Error('Exclusive file rename is unavailable on this platform.');
}

/** Move a file or directory in one filesystem operation, failing on an existing target. */
export function renameExclusive(source, destination) {
  return new Promise((resolve, reject) => {
    rename ??= bindRename();
    rename(source, destination, (error, code, errno) => {
      if (error) reject(error);
      else if (code) reject(Object.assign(new Error(`${code}: cannot rename '${source}' to '${destination}'.`), {
        code, errno, syscall: 'rename', path: source, dest: destination,
      }));
      else resolve();
    });
  });
}
