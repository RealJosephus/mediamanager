import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { closeSync, openSync, readSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { prepareRar4Entry, readRar4Directory } from '../../src/storage/rar-entry.js';
import { BookArchiveService } from '../../src/storage/archive-reader.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { createBookComicPlugin } from '../../src/metadata/book-comic-provider.js';
import { StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const provenanceFile = new URL('../metadata/fixtures/book-comic/rar4-entry/provenance.json', import.meta.url);
const folder = new URL('./', provenanceFile), proof = JSON.parse(await readFile(provenanceFile));
const native = JSON.parse(await readFile(new URL('native.json', folder)));
const edges = JSON.parse(await readFile(new URL('edges.json', folder)));
const crypto = JSON.parse(await readFile(new URL('crypto.json', folder)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const directoryProvenanceFile = new URL('../metadata/fixtures/book-comic/rar-directory/provenance.json', import.meta.url);
const directoryProof = JSON.parse(await readFile(directoryProvenanceFile));
const directoryNative = JSON.parse(await readFile(new URL('native.json', directoryProvenanceFile)));

test('additional RAR4 selected-entry native cases retain exact input, helper, execution and source provenance', async () => {
  assert.deepEqual(proof.caseCounts, { crcSolid: 3, edges: 7, crypto: 3 });
  for (const descriptor of proof.requiredInputs) {
    const bytes = await readFile(descriptor.path); assert.equal(bytes.length, descriptor.bytes); assert.equal(hash(bytes), descriptor.sha256, descriptor.path);
  }
  const empty = edges.observations.find(row => row.name === 'native-explicit-empty');
  assert.equal(empty.sha256, edges.observations.find(row => row.name === 'native-default-null').sha256);
  const raw = crypto.results.find(row => row.Key.endsWith('.jpg'));
  assert.equal(raw.salt, null); assert.equal(raw.decryptedType, 'SharpCompress.IO.SharpCompressStream');
});

test('RAR4 preparation reads the selected raw header ordinal, preserves its source and refuses spool replacement', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mm-rar4-entry-'));
  t.after(() => rm(directory, { recursive: true }));
  const sample = native.results.find(row => row.name === 'normal'), original = await readFile(sample.path), fd = openSync(sample.path, 'r');
  try {
    const ordinal = sample.entries.findIndex(row => row.Key.endsWith('.jpg')), output = path.join(directory, 'selected.rar');
    const derived = prepareRar4Entry(fd, original.length, ordinal, output);
    assert.equal(derived.filename, output); assert.equal(derived.size, (await stat(output)).size);
    const first = Buffer.alloc(7); readSync(fd, first, 0, first.length, null); assert.deepEqual(first, original.subarray(0, 7));
    await assert.rejects(async () => prepareRar4Entry(fd, original.length, ordinal, output), { code: 'EEXIST' });
    assert.equal(hash(await readFile(sample.path)), sample.sourceSha256);
    assert.equal(prepareRar4Entry(fd, original.length, 10000, path.join(directory, 'absent.rar')), null);
  } finally { closeSync(fd); }
});

test('real archive worker matches native normal, bad CRC, solid, wrong salt and no-salt cover outcomes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mm-rar4-consumer-')), spoolPath = path.join(directory, 'spool');
  const identityMap = new IdentityAccessMap(), locations = new Map();
  const vfs = { async openRead(access) { const stream = createReadStream(locations.get(access)); return { stream, async close() { stream.destroy(); } }; } };
  const archives = new BookArchiveService({ vfs, identityMap, spoolPath });
  const [, provider] = createBookComicPlugin({ openArchive: archives.openArchive }).providers;
  t.after(async () => { await archives.close(); assert.deepEqual(await readdir(spoolPath), []); await rm(directory, { recursive: true }); });
  const samples = [...native.results.map(row => ({ ...row, expected: row.HasImage })),
    ...edges.observations.filter(row => ['wrong-salt-native-default', 'no-salt-native-default', 'native-default-null', 'native-pre-cancelled'].includes(row.name)).map(row => ({ ...row, expected: row.hasImage }))];
  for (const sample of samples) await t.test(sample.name, async () => {
    const id = sample.name, access = '/' + id; identityMap.bind(id, access); locations.set(access, sample.path);
    const result = await provider.getImage({ Id: id, Path: 'Z:\\OriginalComics\\' + id + '.cbr' },
      { signal: sample.name === 'native-pre-cancelled' ? AbortSignal.abort() : undefined });
    assert.equal(Boolean(result), sample.expected);
    if (result) assert.equal(hash(result.bytes), sample.sha256);
    assert.deepEqual(await readdir(spoolPath), []);
  });
});

test('fresh RAR directory recordings bind original input, native helper, decoder source and unchanged raw observations', async () => {
  assert.deepEqual(directoryProof.caseCounts, { total: 30, rar4: 19, rar5: 11 });
  for (const descriptor of directoryProof.requiredInputs) {
    const bytes = await readFile(descriptor.path);
    assert.equal(bytes.length, descriptor.bytes, descriptor.path); assert.equal(hash(bytes), descriptor.sha256, descriptor.path);
  }
});

test('bounded classic RAR directory matches native duplicates, directories and every Unicode filename decoder mode', async t => {
  for (const sample of directoryNative.covers.filter(row => row.name.startsWith('rar4'))) await t.test(sample.name, async () => {
    const fd = openSync(sample.path, 'r');
    try {
      const length = (await stat(sample.path)).size;
      if (sample.archiveError) assert.throws(() => readRar4Directory(fd, length), { code: 'invalid-archive' });
      else assert.deepEqual(readRar4Directory(fd, length), sample.entries.map(({ key, size, isDirectory }, ordinal) => ({ key, size, isDirectory, ordinal })));
      const first = Buffer.alloc(7); readSync(fd, first, 0, first.length, null);
      assert.deepEqual(first, Buffer.from('526172211a0700', 'hex'));
    } finally { closeSync(fd); }
  });
  const sample = directoryNative.covers.find(row => row.name.startsWith('rar5')), fd = openSync(sample.path, 'r');
  try { assert.equal(readRar4Directory(fd, (await stat(sample.path)).size), null); } finally { closeSync(fd); }
});

test('actual media VFS RAR catalogs, selected entry streams and Comic cover fallback match all30 fresh native cases', async t => {
  const storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('media', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/media', instanceId: 'media', capabilities: { create: true, mkdir: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: 'Z:\\RarDirectorySource', accessRoot: '/media', style: 'windows', returnAccess: 'actual original RAR bytes' });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mm-rar-directory-'));
  const archives = new BookArchiveService({ vfs, identityMap, spoolPath: directory });
  t.after(async () => { await archives.close(); assert.deepEqual(await readdir(directory), []); await storage.close(); await rm(directory, { recursive: true }); });
  for (const sample of directoryNative.covers) await t.test(sample.name, async () => {
    const filename = sample.name + '.cbr', bytes = await readFile(sample.path);
    await vfs.write('/media/' + filename, bytes, { overwrite: false });
    const item = { Id: sample.name, Path: 'Z:\\RarDirectorySource\\' + filename };
    if (sample.archiveError) await assert.rejects(archives.openArchive(item), { code: 'invalid-archive' });
    else {
      const archive = await archives.openArchive(item);
      try {
        assert.deepEqual(archive.entries, sample.entries.map(({ key, size, isDirectory }) => ({ key, size, isDirectory })));
        for (let ordinal = 0; ordinal < archive.entries.length; ordinal++) {
          const entry = archive.entries[ordinal], expected = sample.entries[ordinal];
          assert.equal(hash(await archive.read(entry)), expected.entrySha256, 'selected raw header ordinal ' + ordinal);
          assert.equal(archive.findEntry(entry.key), archive.entries.find(row => row.key === entry.key));
        }
      } finally { await archive.close(); }
    }
    const logs = [], [, provider] = createBookComicPlugin({ openArchive: archives.openArchive, culture: sample.culture, logger: { error() { logs.push('Error'); } } }).providers;
    const image = await provider.getImage(item, {});
    assert.equal(Boolean(image), sample.hasImage); assert.deepEqual(logs, sample.logs.map(row => row.level));
    if (image) { assert.equal(image.bytes.length, sample.bytes); assert.equal(hash(image.bytes), sample.sha256); assert.equal(image.mimeType, sample.format === 'Jpg' ? 'image/jpeg' : 'image/png'); }
    assert.deepEqual(await readdir(directory), []);
  });
});
