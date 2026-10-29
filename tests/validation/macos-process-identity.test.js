import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessInspector, darwinProcessInspector, sameProcessBirth, sameProcessIdentity } from '../../tools/ci/macos-process-identity.js';

const executableUuid = '00112233445566778899aabbccddeeff';
const record = overrides => ({ pid: 41, parentPid: 7, uid: 501, gid: 20,
  uniqueId: '18446744073709551614', parentUniqueId: '9007199254740995', pidVersion: 29,
  originalParentPidVersion: 17, executableUuid, executable: '/owned/process', comm: 'process', ...overrides });

function nativeFixture(values, hooks = {}) {
  const records = new Map(values.map(value => [value.pid, value]));
  let number = 0;
  const binding = {
    errno(value) { if (value !== undefined) number = value; return number; },
    pidinfo(pid, flavor, argument, buffer, size) {
      assert.equal(argument, 0); assert.equal(size, buffer.length);
      const intercepted = hooks.pidinfo?.({ pid, flavor, buffer, size, binding, records });
      if (intercepted !== undefined) return intercepted;
      const value = records.get(pid);
      if (!value) { number = 3; return 0; }
      if (flavor === 17) {
        assert.equal(size, 56);
        Buffer.from(value.executableUuid, 'hex').copy(buffer);
        buffer.writeBigUInt64LE(BigInt(value.uniqueId), 16);
        buffer.writeBigUInt64LE(BigInt(value.parentUniqueId), 24);
        buffer.writeInt32LE(value.pidVersion, 32); buffer.writeInt32LE(value.originalParentPidVersion, 36);
      } else {
        assert.equal(flavor, 13); assert.equal(size, 64);
        buffer.writeUInt32LE(value.pid, 0); buffer.writeUInt32LE(value.parentPid, 4);
        buffer.write(value.comm, 16, 16, 'utf8');
        buffer.writeUInt32LE(value.uid, 36); buffer.writeUInt32LE(value.gid, 40);
      }
      return size;
    },
    pidpath(pid, buffer, size) {
      assert.equal(size, buffer.length);
      const intercepted = hooks.pidpath?.({ pid, buffer, size, binding, records });
      if (intercepted !== undefined) return intercepted;
      const value = records.get(pid);
      if (!value) { number = 3; return 0; }
      const length = buffer.write(value.executable, 'utf8'); buffer[length] = 0; return length;
    },
    listchildpids(parentPid, buffer, size) {
      const intercepted = hooks.listchildpids?.({ parentPid, buffer, size, binding, records });
      if (intercepted !== undefined) return intercepted;
      const pids = [...records.values()].filter(value => value.parentPid === parentPid).map(value => value.pid);
      const count = Math.min(pids.length, size / 4);
      pids.slice(0, count).forEach((pid, index) => buffer.writeInt32LE(pid, index * 4)); return count;
    },
    listpids(type, uid, buffer, size) {
      assert.equal(type, 4);
      const intercepted = hooks.listpids?.({ uid, buffer, size, binding, records });
      if (intercepted !== undefined) return intercepted;
      const pids = [...records.values()].filter(value => value.uid === uid).map(value => value.pid);
      const count = Math.min(pids.length, size / 4);
      pids.slice(0, count).forEach((pid, index) => buffer.writeInt32LE(pid, index * 4)); return count * 4;
    },
  };
  return { inspector: createProcessInspector(binding), binding, records };
}

test('Darwin process information preserves complete birth identities and separates exec from process replacement', () => {
  const value = record(), { inspector } = nativeFixture([value]), { comm, ...expected } = value;
  assert.deepEqual(inspector.identity(value.pid), expected);
  assert.equal(inspector.identity(99), null);
  assert.equal(sameProcessBirth(expected, { ...expected, parentPid: 1, parentUniqueId: '1' }), true);
  assert.equal(sameProcessIdentity(expected, { ...expected, parentPid: 1, parentUniqueId: '1' }), true);
  for (const change of [{ pidVersion: 30 }, { executableUuid: 'ffeeddccbbaa99887766554433221100' },
    { executable: '/owned/executed-process' }, { uid: 0 }, { gid: 0 }]) {
    assert.equal(sameProcessBirth(expected, { ...expected, ...change }), true);
    assert.equal(sameProcessIdentity(expected, { ...expected, ...change }), false);
  }
  for (const change of [{ pid: 42 }, { uniqueId: '18446744073709551615' }]) {
    assert.equal(sameProcessBirth(expected, { ...expected, ...change }), false);
    assert.equal(sameProcessIdentity(expected, { ...expected, ...change }), false);
  }
  assert.equal(sameProcessBirth(null, expected), false);
  assert.equal(sameProcessIdentity(expected, null), false);
});

test('Darwin process reads distinguish ESRCH from permissions, incomplete records and empty native failures', () => {
  for (const stage of ['unique', 'short', 'path']) for (const number of [3, 1, 0]) {
    const hooks = stage === 'path' ? { pidpath({ binding }) { binding.errno(number); return 0; } }
      : { pidinfo({ flavor, binding }) { if (flavor === (stage === 'unique' ? 17 : 13)) { binding.errno(number); return 0; } } };
    const { inspector } = nativeFixture([record()], hooks);
    if (number === 3) assert.equal(inspector.identity(41), null);
    else assert.throws(() => inspector.identity(41), reason => {
      assert.equal(reason.syscall, stage === 'path' ? 'proc_pidpath' : 'proc_pidinfo');
      // The injected Darwin errno is independent of the host's libuv labels.
      if (number === 1) assert.equal(reason.errno, -1);
      return true;
    });
  }
  for (const flavor of [13, 17]) {
    const { inspector } = nativeFixture([record()], { pidinfo(call) { if (call.flavor === flavor) return call.size - 1; } });
    assert.throws(() => inspector.identity(41));
  }
  for (const result of [-1, 4096]) {
    const { inspector } = nativeFixture([record()], { pidpath() { return result; } });
    assert.throws(() => inspector.identity(41));
  }
});

test('Darwin identity sandwiches reject mixed births, exec versions, executable UUIDs and credentials before recovery', () => {
  for (const field of ['uniqueId', 'pidVersion', 'executableUuid', 'uid', 'parentPid']) {
    let unstable = true, reads = 0;
    const { inspector, records } = nativeFixture([record()], {
      pidinfo({ flavor, records }) {
        if (!unstable || flavor !== (['uid', 'parentPid'].includes(field) ? 13 : 17)) return;
        reads++;
        const value = records.get(41);
        if (field === 'uniqueId') value.uniqueId = String(9007199254740992n + BigInt(reads));
        else if (field === 'executableUuid') value.executableUuid = reads.toString(16).padStart(32, '0');
        else value[field] = reads;
      },
    });
    assert.throws(() => inspector.identity(41));
    unstable = false; records.set(41, record());
    const { comm, ...expected } = record(); assert.deepEqual(inspector.identity(41), expected);
  }
});

test('Darwin child and named-process enumeration grow full native buffers and retain every qualifying identity', () => {
  const root = record(), children = Array.from({ length: 257 }, (_, index) => record({ pid: 1000 + index,
    parentPid: root.pid, uniqueId: String(10000 + index), parentUniqueId: root.uniqueId }));
  const { inspector, binding } = nativeFixture([root, ...children]);
  assert.deepEqual(inspector.descendants(inspector.identity(root.pid)).map(value => value.pid), children.map(value => value.pid));
  binding.errno(1);
  assert.deepEqual(inspector.namedProcesses('process', root.uid).map(value => value.pid), [root.pid, ...children.map(value => value.pid)]);
  const unwanted = record({ pid: 500, uid: root.uid, comm: 'unrelated', uniqueId: '3' });
  const terminals = nativeFixture([record({ comm: 'Terminal' }), unwanted], {
    pidpath({ pid }) { assert.notEqual(pid, unwanted.pid, 'Unrelated executable paths are outside Terminal ownership.'); },
  });
  assert.deepEqual(terminals.inspector.namedProcesses('Terminal', root.uid).map(value => value.pid), [root.pid]);
});

test('Darwin process inventories preserve native errors and reject incomplete counts instead of truncating', () => {
  for (const kind of ['listchildpids', 'listpids']) {
    const hooks = { [kind](call) { call.binding.errno(1); return 0; } };
    const { inspector } = nativeFixture([record()], hooks), root = inspector.identity(41);
    assert.throws(() => kind === 'listchildpids' ? inspector.descendants(root) : inspector.namedProcesses('process', 501),
      reason => reason.errno === -1 && reason.syscall === 'proc_' + kind);
    const empty = nativeFixture([record()], { [kind]() { return 0; } }); empty.binding.errno(1);
    assert.deepEqual(kind === 'listchildpids' ? empty.inspector.descendants(root) : empty.inspector.namedProcesses('process', 501), []);
  }
  const odd = nativeFixture([record()], { listpids() { return 1; } });
  assert.throws(() => odd.inspector.namedProcesses('process', 501));
});

test('Darwin descendants reject reused parent PIDs and retain birth identity after exec or reparenting', () => {
  const root = record(), child = record({ pid: 42, parentPid: root.pid, uniqueId: '42', parentUniqueId: root.uniqueId });
  const unrelated = record({ pid: 43, parentPid: root.pid, uniqueId: '43', parentUniqueId: '9007199254740996' });
  const good = nativeFixture([root, child, unrelated]), before = good.inspector.identity(root.pid);
  assert.deepEqual(good.inspector.descendants(before).map(value => value.pid), [child.pid]);
  const born = good.inspector.identity(child.pid);
  good.records.set(child.pid, { ...child, parentPid: 1, pidVersion: child.pidVersion + 1, executable: '/owned/new-executable' });
  const reparented = good.inspector.identity(child.pid);
  assert.equal(sameProcessBirth(born, reparented), true); assert.equal(sameProcessIdentity(born, reparented), false);
  assert.equal(reparented.parentUniqueId, root.uniqueId);
  assert.deepEqual(good.inspector.descendants(before), []);
  const replaced = nativeFixture([root, child], { listchildpids({ parentPid, records }) {
    if (parentPid === root.pid) records.set(root.pid, { ...root, uniqueId: '77' });
  } });
  assert.deepEqual(replaced.inspector.descendants(replaced.inspector.identity(root.pid)), []);
});

test('actual Darwin inspector binds this same-UID executable to its native process birth', { timeout: 30000 }, async t => {
  if (process.platform !== 'darwin') { t.diagnostic('Raw process contracts ran here; native process inspection runs on Darwin.'); return; }
  const inspector = await darwinProcessInspector(), current = inspector.identity(process.pid);
  assert.equal(current.pid, process.pid); assert.equal(current.parentPid, process.ppid);
  assert.equal(current.uid, process.getuid()); assert.equal(current.gid, process.getgid());
  assert.match(current.uniqueId, /^\d+$/u); assert.match(current.parentUniqueId, /^\d+$/u);
  assert.match(current.executableUuid, /^[a-f0-9]{32}$/u); assert.ok(current.executable.startsWith('/'));
  assert.ok(sameProcessIdentity(inspector.identity(process.pid), current));
  assert.ok(inspector.namedProcesses('node', process.getuid()).some(value => sameProcessIdentity(value, current)));
  t.diagnostic('Actual same-UID process identity: ' + JSON.stringify(current));
});
