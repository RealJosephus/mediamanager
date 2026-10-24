import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

const text = bytes => bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).toString('utf8');
function paxAttributes(bytes) {
  const attributes = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset), length = Number(bytes.subarray(offset, space).toString('ascii'));
    assert.ok(space > offset && Number.isSafeInteger(length) && length > 0 && offset + length <= bytes.length);
    const line = bytes.subarray(space + 1, offset + length - 1).toString('utf8'), equals = line.indexOf('=');
    assert.ok(equals > 0);
    attributes[line.slice(0, equals)] = line.slice(equals + 1);
    offset += length;
  }
  return attributes;
}

// Read exact declared source members without extracting names into host paths.
// Only requested regular files and bounded TAR metadata are retained in memory.
export async function readSourceMembers(filename, requirements) {
  const expected = new Map(requirements.map(entry => [entry.member, entry]));
  assert.equal(expected.size, requirements.length, 'Source archive member declarations are unique');
  const found = new Map(), header = Buffer.alloc(512);
  let headerLength = 0, current, localPax = {}, globalPax = {}, longName;
  const source = createReadStream(filename), expanded = source.pipe(createGunzip());
  source.on('error', error => expanded.destroy(error));
  const finish = () => {
    const data = current.keep ? Buffer.concat(current.chunks) : null;
    if (current.type === 'x') localPax = paxAttributes(data);
    else if (current.type === 'g') globalPax = { ...globalPax, ...paxAttributes(data) };
    else if (current.type === 'L') longName = text(data).replace(/\n$/u, '');
    else if (current.expected) {
      assert.ok(['0', '\0', ''].includes(current.type), 'An original source must be a regular member: ' + current.name);
      assert.ok(!found.has(current.name), 'An original source cannot have duplicate member names: ' + current.name);
      assert.equal(data.length, current.expected.bytes, current.name);
      found.set(current.name, data);
    }
    current.finished = true;
  };
  try {
    for await (const chunk of expanded) {
      let offset = 0;
      while (offset < chunk.length) {
        if (!current) {
          const count = Math.min(512 - headerLength, chunk.length - offset);
          chunk.copy(header, headerLength, offset); headerLength += count; offset += count;
          if (headerLength !== 512) continue;
          headerLength = 0;
          if (header.every(value => value === 0)) continue;
          const size = Number.parseInt(text(header.subarray(124, 136)).trim() || '0', 8);
          assert.ok(Number.isSafeInteger(size) && size >= 0, 'TAR source member length');
          const type = String.fromCharCode(header[156]);
          const prefix = text(header.subarray(257, 263)) === 'ustar' ? text(header.subarray(345, 500)) : '';
          const shortName = text(header.subarray(0, 100));
          const name = localPax.path ?? globalPax.path ?? longName ?? (prefix ? prefix + '/' + shortName : shortName);
          const metadata = ['x', 'g', 'L', 'K'].includes(type);
          const entry = metadata ? null : expected.get(name);
          if (metadata) assert.ok(size <= 1024 * 1024, 'TAR source metadata is bounded');
          if (entry) assert.equal(size, entry.bytes, name);
          current = { type, name, expected: entry, remaining: size, padding: (512 - size % 512) % 512,
            keep: Boolean(entry) || ['x', 'g', 'L'].includes(type), chunks: [], finished: false };
          if (!metadata) { localPax = {}; longName = undefined; }
          if (size === 0) finish();
        } else if (current.remaining) {
          const count = Math.min(current.remaining, chunk.length - offset);
          if (current.keep) current.chunks.push(Buffer.from(chunk.subarray(offset, offset + count)));
          current.remaining -= count; offset += count;
          if (!current.remaining) finish();
        } else {
          const count = Math.min(current.padding, chunk.length - offset);
          current.padding -= count; offset += count;
          if (!current.padding) current = undefined;
        }
      }
    }
    assert.equal(headerLength, 0, 'The source archive ends on a complete TAR block');
    assert.ok(!current || current.finished && current.padding === 0, 'The source archive contains no truncated member');
    assert.deepEqual([...found.keys()].sort(), [...expected.keys()].sort(), 'Every declared source is present in its complete archive');
    return found;
  } finally {
    expanded.destroy(); source.destroy();
  }
}
