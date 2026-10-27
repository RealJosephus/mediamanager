import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { removeOwned } from '../../tools/release/materials.js';
import { streamSourceArchive } from '../../tools/release/source-archive-stream.js';

function header(name, kind, size, target = '') {
  const result = Buffer.alloc(512);
  result.write(name); result.write('0000755\0', 100); result.write('0000000\0', 108); result.write('0000000\0', 116);
  result.write(size.toString(8).padStart(11, '0') + '\0', 124); result.write('00000000000\0', 136);
  result.fill(32, 148, 156); result[156] = kind.charCodeAt(0); result.write(target, 157); result.write('ustar\0', 257);
  result.write(result.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return result;
}

function pax(fields) {
  return Buffer.concat(Object.entries(fields).map(([name, value]) => {
    const tail = Buffer.from(' ' + name + '=' + value + '\n'); let length = tail.length + 1;
    while (String(length).length + tail.length !== length) length = String(length).length + tail.length;
    return Buffer.concat([Buffer.from(String(length)), tail]);
  }));
}

async function fixture(t, { changedBytes = false, changedLink = false, footerBlocks = 2, paxPath, actualPaxPath = paxPath } = {}) {
  const parent = fileURLToPath(new URL('../../.test-output/', import.meta.url)); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'source-stream-')); t.after(() => removeOwned(parent, directory));
  const filename = path.join(directory, 'source.tar.gz'), original = Buffer.from('Original source.\n');
  const content = changedBytes ? Buffer.from('Modified source.\n') : original;
  const members = [{ path: 'source', kind: 'directory', mode: 0o755, bytes: 0 },
    { path: paxPath ?? 'source/file', kind: 'file', mode: 0o755, bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      gitBlob: createHash('sha1').update(`blob ${original.length}\0`).update(original).digest('hex') },
    { path: 'source/link', kind: 'symlink', mode: 0o755, bytes: 0, target: 'file' }];
  const extended = actualPaxPath ? pax({ path: actualPaxPath, mtime: '1788885948.123456789' }) : undefined;
  const extension = extended ? [header('PaxHeaders/file', 'x', extended.length), extended, Buffer.alloc((512 - extended.length % 512) % 512)] : [];
  await writeFile(filename, gzipSync(Buffer.concat([header('source/', '5', 0), ...extension, header('source/file', '0', content.length),
    content, Buffer.alloc(512 - content.length), header('source/link', '2', 0, changedLink ? 'other' : 'file'), Buffer.alloc(512 * footerBlocks)])));
  return { filename, members, original };
}

test('source streaming preserves regular files and symbolic links without filesystem extraction', async t => {
  const state = await fixture(t), result = await streamSourceArchive(state.filename, state.members, ['source/file']);
  assert.deepEqual(result, new Map([['source/file', state.original]]));
});

test('changed source content cannot be hidden by repinning only the member checksum', async t => {
  const state = await fixture(t, { changedBytes: true });
  await assert.rejects(streamSourceArchive(state.filename, state.members), /file differs from its Git blob/u);
});

test('source archive links must retain their actual original target', async t => {
  const state = await fixture(t, { changedLink: true });
  await assert.rejects(streamSourceArchive(state.filename, state.members), /membership or link changed/u);
});

test('complete source streaming rejects a truncated archive footer', async t => {
  const state = await fixture(t, { footerBlocks: 1 });
  await assert.rejects(streamSourceArchive(state.filename, state.members), /archive is incomplete/u);
});

test('a selected source file cannot disappear from a complete original container', async t => {
  const state = await fixture(t);
  await assert.rejects(streamSourceArchive(state.filename, state.members, ['source/missing']), /archive is incomplete/u);
});

test('original Gitiles extended paths and fractional times retain their file identity without leaking to later members', async t => {
  const name = 'source/' + 'long-name-'.repeat(12), state = await fixture(t, { paxPath: name });
  assert.deepEqual(await streamSourceArchive(state.filename, state.members, [name]), new Map([[name, state.original]]));
});

test('an extended TAR path cannot redirect a source into an unbound member', async t => {
  const state = await fixture(t, { paxPath: 'source/expected', actualPaxPath: '../unbound' });
  await assert.rejects(streamSourceArchive(state.filename, state.members), /membership or link changed/u);
});
