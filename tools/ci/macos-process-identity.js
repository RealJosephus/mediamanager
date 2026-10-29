import assert from 'node:assert/strict';
import { getSystemErrorName } from 'node:util';

// Darwin's cross-UID flavors are SHORTBSDINFO (13), UNIQIDENTIFIERINFO
// (17) and PATHINFO (11). TBSDINFO/BSWITHUNIQID require the same UID.
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h
// https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c
const shortSize = 64, uniqueSize = 56, pathSize = 4096;
let nativeInspector;

export const sameProcessBirth = (left, right) => Boolean(left && right && left.pid === right.pid
  && typeof left.uniqueId === 'string' && left.uniqueId === right.uniqueId);
export const sameProcessIdentity = (left, right) => Boolean(sameProcessBirth(left, right)
  && left.pidVersion === right.pidVersion && left.executableUuid === right.executableUuid
  && left.uid === right.uid && left.gid === right.gid && left.executable === right.executable);

export function createProcessInspector(binding) {
  function failure(syscall, pid, number, detail = '') {
    const code = number ? getSystemErrorName(-number) : 'MACOS_PROCESS_INFO_FAILED';
    return Object.assign(new Error(code + ': ' + syscall + ' failed' + (detail ? ' (' + detail + ')' : '')),
      { code, errno: -number, syscall, pid });
  }
  function info(pid, flavor, size) {
    const buffer = Buffer.alloc(size);
    binding.errno(0);
    const bytes = binding.pidinfo(pid, flavor, 0, buffer, size), number = binding.errno();
    if (bytes === size) return buffer;
    if (bytes === 0 && number === 3) return null; // ESRCH alone means absent.
    throw failure('proc_pidinfo', pid, number, 'flavor ' + flavor + ', bytes ' + bytes + '/' + size);
  }
  function unique(pid) {
    const bytes = info(pid, 17, uniqueSize); if (!bytes) return null;
    return { uniqueId: bytes.readBigUInt64LE(16).toString(), parentUniqueId: bytes.readBigUInt64LE(24).toString(),
      pidVersion: bytes.readInt32LE(32), originalParentPidVersion: bytes.readInt32LE(36),
      executableUuid: bytes.subarray(0, 16).toString('hex') };
  }
  function short(pid) {
    const bytes = info(pid, 13, shortSize); if (!bytes) return null;
    assert.equal(bytes.readUInt32LE(0), pid, 'The short process information belongs to a different PID.');
    const end = bytes.indexOf(0, 16), comm = bytes.subarray(16, end < 16 || end > 32 ? 32 : end).toString('utf8');
    return { pid, parentPid: bytes.readUInt32LE(4), uid: bytes.readUInt32LE(36), gid: bytes.readUInt32LE(40), comm };
  }
  function executable(pid) {
    const buffer = Buffer.alloc(pathSize);
    binding.errno(0);
    const bytes = binding.pidpath(pid, buffer, buffer.length), number = binding.errno();
    if (bytes === 0 && number === 3) return null;
    if (bytes <= 0 || bytes >= buffer.length || buffer[bytes] !== 0) {
      throw failure('proc_pidpath', pid, number, 'bytes ' + bytes);
    }
    return buffer.subarray(0, bytes).toString('utf8');
  }
  function identity(pid) {
    assert.ok(Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff, 'A positive process PID is required.');
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = unique(pid); if (!before) return null;
      const first = short(pid); if (!first) return null;
      const filename = executable(pid); if (filename === null) return null;
      const last = short(pid); if (!last) return null;
      const after = unique(pid); if (!after) return null;
      // uniqueId survives exec; pidVersion and the executable UUID do not.
      // Sandwich both credentials/parent and path to reject a mixed observation.
      if (before.uniqueId !== after.uniqueId || before.pidVersion !== after.pidVersion
        || before.executableUuid !== after.executableUuid || before.parentUniqueId !== after.parentUniqueId
        || before.originalParentPidVersion !== after.originalParentPidVersion
        || first.parentPid !== last.parentPid || first.uid !== last.uid || first.gid !== last.gid) continue;
      const { comm, ...details } = last;
      return { ...details, ...after, executable: filename };
    }
    throw Object.assign(new Error('The process changed identity during every bounded observation.'),
      { code: 'MACOS_PROCESS_IDENTITY_CHANGED', pid });
  }
  function listPids(pid, children) {
    // libproc returns a PID count for listchildpids, but bytes for listpids.
    // A full buffer is never accepted as a complete snapshot.
    for (let capacity = 128; capacity <= 4194304; capacity *= 2) {
      const buffer = Buffer.alloc(capacity * 4);
      binding.errno(0);
      const value = children ? binding.listchildpids(pid, buffer, buffer.length)
        : binding.listpids(4, pid, buffer, buffer.length);
      const number = binding.errno(), count = children ? value : value / 4;
      if (number || !Number.isInteger(count) || count < 0 || count > capacity) {
        throw failure(children ? 'proc_listchildpids' : 'proc_listpids', pid, number, 'count ' + count);
      }
      if (count === capacity) continue;
      const result = [];
      for (let index = 0; index < count; index++) {
        const candidate = buffer.readInt32LE(index * 4);
        if (candidate > 0) result.push(candidate);
      }
      return result;
    }
    throw new Error('The process PID inventory exceeded the bounded allocation without a complete snapshot.');
  }
  function descendants(root) {
    const current = root && identity(root.pid);
    if (!sameProcessBirth(current, root)) return [];
    const found = [], parents = [current], seen = new Set([current.uniqueId]);
    for (let index = 0; index < parents.length; index++) {
      const expected = parents[index], before = identity(expected.pid);
      if (!sameProcessBirth(before, expected)) continue;
      const candidates = listPids(before.pid, true).map(identity).filter(Boolean);
      const after = identity(before.pid);
      if (!sameProcessBirth(before, after)) continue;
      for (const child of candidates) {
        // p_puniqueid is the birth parent's identity, including after reparent.
        // Previously bound orphans are retained by birth by the owner itself.
        if (child.parentPid !== after.pid || child.parentUniqueId !== after.uniqueId || seen.has(child.uniqueId)) continue;
        seen.add(child.uniqueId); found.push(child); parents.push(child);
      }
    }
    return found;
  }
  function namedProcesses(name, uid) {
    assert.ok(typeof name === 'string' && name.length > 0 && Number.isInteger(uid) && uid >= 0);
    const result = [];
    for (const pid of listPids(uid, false)) {
      const candidate = short(pid);
      // Unrelated kernel/zombie executables have no role in Terminal ownership.
      if (!candidate || candidate.uid !== uid || candidate.comm !== name) continue;
      const current = identity(pid);
      if (current && current.uid === uid && candidate.comm === name) result.push(current);
    }
    return result;
  }
  return { identity, descendants, namedProcesses };
}

export async function darwinProcessInspector() {
  assert.equal(process.platform, 'darwin');
  return nativeInspector ??= (async () => {
    const { default: koffi } = await import('koffi');
    const library = koffi.load('/usr/lib/libproc.dylib');
    return createProcessInspector({ errno: value => value === undefined ? koffi.errno() : koffi.errno(value),
      pidinfo: library.func('int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)'),
      pidpath: library.func('int proc_pidpath(int pid, void *buffer, uint32_t buffersize)'),
      listchildpids: library.func('int proc_listchildpids(int ppid, void *buffer, int buffersize)'),
      listpids: library.func('int proc_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int buffersize)') });
  })();
}

