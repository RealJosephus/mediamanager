import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, readdir, rm, stat, unlink } from 'node:fs/promises';
import { closeSync, openSync, readSync, createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareRar4Entry, readRar4Directory } from '../../src/storage/rar-entry.js';
import { BookArchiveService } from '../../src/storage/archive-reader.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { createBookComicPlugin } from '../../src/metadata/book-comic-provider.js';
import { StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';
import { captureCurrentRar, input, hash, recordCandidate } from './fixtures/rar-entry-current/capture.js';
export { requiredValidationServices } from './fixtures/rar-entry-current/capture.js';

const failedRead = row => Boolean(row.openError || row.readError);
const entryFields = ({ key, size, isDirectory }) => ({ key, size, isDirectory });
const publicCover = result => result ? { hasImage: true, bytes: result.bytes.length, sha256: hash(result.bytes), mimeType: result.mimeType }
  : { hasImage: false };
const expectedCover = result => result.hasImage ? { hasImage: true, bytes: result.bytes, sha256: result.sha256,
  mimeType: result.format === 'Jpg' ? 'image/jpeg' : 'image/' + result.format.toLowerCase() } : { hasImage: false };

async function selectedReads(archive, catalog) {
  assert.deepEqual(archive.entries.map(entryFields), catalog.entries.map(entryFields));
  const reads = [], lookedUp = new Set();
  for (let ordinal = 0; ordinal < archive.entries.length; ordinal++) {
    const listed = archive.entries[ordinal], expected = catalog.entries[ordinal].read;
    const found = archive.findEntry(listed.key);
    assert.ok(found, 'The first directory occurrence is available by its key');
    assert.deepEqual(entryFields(found), entryFields(archive.entries.find(row => row.key === listed.key)));
    const firstKey = !lookedUp.has(listed.key), entry = firstKey ? found : listed;
    lookedUp.add(listed.key);
    let value, error;
    try { value = await archive.read(entry); } catch (failure) { error = failure; }
    const observation = { ordinal, key: entry.key, firstKeyLookup: firstKey, failed: Boolean(error),
      bytes: value?.length ?? null, sha256: value ? hash(value) : null,
      prefix: value ? value.subarray(0, 32).toString('hex') : null };
    reads.push(observation);
    assert.equal(Boolean(error), failedRead(expected), 'selected raw header ordinal ' + ordinal);
    if (value) {
      assert.deepEqual(value, await readFile(expected.selectedPath));
      assert.equal(value.length, expected.bytes); assert.equal(hash(value), expected.sha256);
      assert.equal(observation.prefix, expected.prefix);
    }
  }
  return reads;
}

const temporary = prefix => mkdtemp(path.join(os.tmpdir(), prefix));
async function removeTemporary(directory, prefix) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith(prefix));
  await rm(directory, { recursive: true });
}

async function fileService(t) {
  const directory = await temporary('mm-rar4-consumer-'), spoolPath = path.join(directory, 'spool');
  await mkdir(spoolPath);
  const identityMap = new IdentityAccessMap(), locations = new Map(), counts = { opened: 0, closed: 0 };
  const vfs = { async openRead(access, { signal } = {}) {
    const stream = createReadStream(locations.get(access), { signal }); let closed = false;
    counts.opened++;
    return { stream, async close() {
      if (closed) return;
      closed = true;
      await new Promise(resolve => {
        if (stream.closed) resolve();
        else { stream.once('close', resolve); stream.destroy(); }
      });
      counts.closed++;
    } };
  } };
  const archives = new BookArchiveService({ vfs, identityMap, spoolPath });
  t.after(async () => {
    try { await archives.close(); assert.equal(counts.opened, counts.closed); assert.deepEqual(await readdir(spoolPath), []); }
    finally { await removeTemporary(directory, 'mm-rar4-consumer-'); }
  });
  const bind = sample => {
    const access = '/' + sample.name; identityMap.bind(sample.name, access); locations.set(access, sample.path);
    return { Id: sample.name, Path: 'Z:\\OriginalComics\\' + sample.name + '.cbr' };
  };
  return { archives, bind, counts, spoolPath };
}

test('current RAR captures retain all 30 directory and 13 selected, cancellation and crypto scenarios', async () => {
  const { native } = await captureCurrentRar();
  assert.equal(native.directoryCases.length, 30);
  assert.equal(input.directoryCases.filter(row => row.name.startsWith('rar4')).length, 19);
  assert.equal(input.directoryCases.filter(row => row.name.startsWith('rar5')).length, 11);
  assert.deepEqual([native.selectedCases.length, native.edgeCases.length, native.cryptoCases.length], [3, 7, 3]);
  const empty = native.edgeCases.find(row => row.name === 'native-explicit-empty').observation;
  const normal = native.edgeCases.find(row => row.name === 'native-default-null').observation;
  assert.equal(failedRead(empty), false); assert.equal(empty.streamDisposed, true);
  assert.equal(empty.sha256, normal.sha256); assert.equal(empty.bytes, normal.bytes);
  const wrong = native.edgeCases.find(row => row.name === 'native-explicit-wrong').observation;
  assert.notEqual(wrong.sha256, empty.sha256, 'An explicit wrong password cannot yield the empty-password selected payload');
  for (const sample of native.edgeCases.filter(row => row.name.includes('cancel'))) {
    assert.equal(sample.observation.cancellationRequested, true); assert.equal(sample.observation.hasImage, false);
  }
  assert.equal(native.assetBindings.find(row => row.name === 'solid').sha256,
    'e7e62f24f22f195d21437be09667c8956837d99ba48d7270090251a8e32babc5');
});

test('RAR4 preparation uses raw header ordinals, preserves source position and refuses spool replacement', async t => {
  const { native } = await captureCurrentRar(), sample = native.selectedCases.find(row => row.name === 'normal');
  const directory = await temporary('mm-rar4-entry-'), original = await readFile(sample.path), fd = openSync(sample.path, 'r');
  t.after(() => removeTemporary(directory, 'mm-rar4-entry-'));
  try {
    const ordinal = sample.catalog.entries.findIndex(row => row.key.endsWith('.jpg')), output = path.join(directory, 'selected.rar');
    const derived = prepareRar4Entry(fd, original.length, ordinal, output);
    assert.equal(derived.filename, output); assert.equal(derived.size, (await stat(output)).size);
    const first = Buffer.alloc(7); readSync(fd, first, 0, first.length, null); assert.deepEqual(first, original.subarray(0, 7));
    const before = await readFile(output);
    await assert.rejects(async () => prepareRar4Entry(fd, original.length, ordinal, output), { code: 'EEXIST' });
    assert.deepEqual(await readFile(output), before);
    assert.equal(hash(await readFile(sample.path)), sample.sourceSha256);
    assert.equal(prepareRar4Entry(fd, original.length, 10000, path.join(directory, 'absent.rar')), null);
    assert.deepEqual(await readdir(directory), ['selected.rar']);
  } finally { closeSync(fd); }
  assert.throws(() => readSync(fd, Buffer.alloc(1), 0, 1, 0), { code: 'EBADF' });
});

test('selected compressed bytes match actual native salted decryption and unsalted passthrough for all three ordinals', async t => {
  const { native } = await captureCurrentRar(), source = native.edgeCases.find(row => row.name === 'no-salt-native-default');
  const directory = await temporary('mm-rar4-crypto-'), original = await readFile(source.path);
  t.after(() => removeTemporary(directory, 'mm-rar4-crypto-'));
  for (const sample of native.cryptoCases) await t.test(sample.name, async () => {
    const filename = path.join(directory, sample.name + '.rar'), fd = openSync(source.path, 'r');
    try {
      const selected = prepareRar4Entry(fd, original.length, sample.ordinal, filename);
      const archive = await readFile(selected.filename), offset = 7 + archive.readUInt16LE(7 + 5);
      const length = archive.readUInt16LE(offset + 5), packed = archive.readUInt32LE(offset + 7);
      const bytes = archive.subarray(offset + length, offset + length + packed);
      const observation = { bytes: bytes.length, sha256: hash(bytes), prefix: bytes.subarray(0, 32).toString('hex') };
      await recordCandidate('crypto', sample.name, observation);
      assert.equal(Boolean(sample.error), false); assert.equal(bytes.length, sample.compressedSize);
      assert.deepEqual(bytes, await readFile(sample.selectedPath));
      assert.deepEqual(observation, { bytes: sample.bytes, sha256: sample.sha256, prefix: sample.prefix });
      const first = Buffer.alloc(7); readSync(fd, first, 0, 7, null); assert.deepEqual(first, original.subarray(0, 7));
    } finally { closeSync(fd); await unlink(filename); }
    assert.equal(hash(await readFile(source.path)), source.sourceSha256);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('real archive worker matches native CRC, solid, salt and cancellation cover outcomes and closes original streams', async t => {
  const { native } = await captureCurrentRar(), { archives, bind, counts, spoolPath } = await fileService(t);
  const samples = [...native.selectedCases.map(row => ({ ...row, expected: row.cover })),
    ...native.edgeCases.filter(row => !row.explicitPassword).map(row => ({ ...row, expected: row.observation }))];
  for (const sample of samples) await t.test(sample.name, async () => {
    let reads;
    if (sample.catalog) {
      const archive = await archives.openArchive(bind(sample));
      try { reads = await selectedReads(archive, sample.catalog); }
      finally { await archive.close(); }
    }
    const logs = [], [, provider] = createBookComicPlugin({ openArchive: archives.openArchive,
      culture: input.culture, logger: { error() { logs.push('Error'); } } }).providers;
    const controller = new AbortController(), mode = input.edgeCases.find(row => row.name === sample.name)?.cancel;
    if (mode === 'pre') controller.abort();
    const timer = mode === 'after-1ms' ? setTimeout(() => controller.abort(), 1) : undefined;
    let image;
    try { image = await provider.getImage(bind(sample), { signal: controller.signal }); }
    finally { clearTimeout(timer); }
    const observation = { ...publicCover(image), logs, reads, sourceSha256: hash(await readFile(sample.path)),
      sourceStreamsClosed: counts.opened === counts.closed, spoolEmpty: (await readdir(spoolPath)).length === 0 };
    await recordCandidate('covers', sample.name, observation);
    assert.deepEqual(publicCover(image), expectedCover(sample.expected));
    assert.deepEqual(logs, sample.expected.logs.map(row => row.level));
    assert.equal(observation.sourceSha256, sample.sourceSha256);
    assert.equal(observation.sourceStreamsClosed, true); assert.equal(observation.spoolEmpty, true);
  });
});

test('bounded RAR4 directory matches all 19 native catalogs, malformed Unicode and source descriptor lifetime', async t => {
  const { native } = await captureCurrentRar();
  for (const sample of native.directoryCases.filter(row => row.name.startsWith('rar4'))) await t.test(sample.name, async () => {
    const fd = openSync(sample.path, 'r');
    try {
      const length = (await stat(sample.path)).size;
      if (sample.catalog.archiveError) assert.throws(() => readRar4Directory(fd, length), { code: 'invalid-archive' });
      else assert.deepEqual(readRar4Directory(fd, length), sample.catalog.entries.map(({ key, size, isDirectory, ordinal }) => ({ key, size, isDirectory, ordinal })));
      const first = Buffer.alloc(7); readSync(fd, first, 0, first.length, null);
      assert.deepEqual(first, Buffer.from('526172211a0700', 'hex'));
    } finally { closeSync(fd); }
    assert.throws(() => readSync(fd, Buffer.alloc(1), 0, 1, 0), { code: 'EBADF' });
  });
  const sample = native.directoryCases.find(row => row.name.startsWith('rar5')), fd = openSync(sample.path, 'r');
  try { assert.equal(readRar4Directory(fd, (await stat(sample.path)).size), null); } finally { closeSync(fd); }
});

test('actual media VFS preserves every key, duplicate ordinal, selected byte and cover fallback for all 30 native RAR cases', async t => {
  const { native } = await captureCurrentRar();
  const storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('media', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/media', instanceId: 'media', capabilities: { create: true, mkdir: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\RarDirectorySource', accessRoot: '/media', style: 'windows', returnAccess: 'actual original RAR bytes' });
  const directory = await temporary('mm-rar-directory-'), counts = { opened: 0, closed: 0 };
  const tracked = { async openRead(...args) {
    const source = await vfs.openRead(...args); counts.opened++; let closed = false;
    return { stream: source.stream, async close() { if (!closed) { closed = true; try { await source.close(); } finally { counts.closed++; } } } };
  } };
  const archives = new BookArchiveService({ vfs: tracked, identityMap, spoolPath: directory });
  t.after(async () => {
    try { await archives.close(); assert.equal(counts.opened, counts.closed); assert.deepEqual(await readdir(directory), []); }
    finally { try { await storage.close(); } finally { await removeTemporary(directory, 'mm-rar-directory-'); } }
  });
  for (const sample of native.directoryCases) await t.test(sample.name, async () => {
    const filename = sample.name + '.cbr', bytes = await readFile(sample.path);
    await vfs.write('/media/' + filename, bytes, { overwrite: false });
    const item = { Id: sample.name, Path: 'Z:\\RarDirectorySource\\' + filename };
    let entries = null, reads = [], archiveFailed = false;
    if (sample.catalog.archiveError) {
      await assert.rejects(archives.openArchive(item), { code: 'invalid-archive' }); archiveFailed = true;
    } else {
      const archive = await archives.openArchive(item);
      try {
        entries = archive.entries;
        reads = await selectedReads(archive, sample.catalog);
      } finally { await archive.close(); }
      if (archive.entries.length) await assert.rejects(archive.read(archive.entries[0]), { code: 'closed' });
    }
    const logs = [], [, provider] = createBookComicPlugin({ openArchive: archives.openArchive,
      culture: input.culture, logger: { error() { logs.push('Error'); } } }).providers;
    const image = await provider.getImage(item, {});
    const observation = { archiveFailed, entries, reads, cover: publicCover(image), logs,
      sourceStreamsClosed: counts.opened === counts.closed, spoolEmpty: (await readdir(directory)).length === 0 };
    await recordCandidate('directories', sample.name, observation);
    assert.deepEqual(publicCover(image), expectedCover(sample.cover));
    assert.deepEqual(logs, sample.cover.logs.map(row => row.level));
    assert.equal(hash(await readFile(sample.path)), sample.sourceSha256);
    const stored = await vfs.openRead('/media/' + filename), chunks = [];
    try { for await (const chunk of stored.stream) chunks.push(Buffer.from(chunk)); } finally { await stored.close(); }
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(observation.sourceStreamsClosed, true); assert.equal(observation.spoolEmpty, true);
  });
});
